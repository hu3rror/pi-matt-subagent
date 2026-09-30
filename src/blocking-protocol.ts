/**
 * Pure blocking-child protocol: the JSON-lines protocol the spawned pi child
 * emits on stdout (message_end / tool_result_end events), the usage
 * accumulation rules, and the escalating-kill abort path. Zero pi-runtime
 * imports — testable with `node --test` (type-only imports from pi packages
 * are erased before resolution).
 *
 * The spawn adapter (extension) owns process lifecycle — spawn, stdio wiring,
 * the abort signal, exitCode patching — and feeds this module's accumulator
 * through the same seam the research runner uses for its child sessions.
 */

import type { Message } from "@earendil-works/pi-ai";
import { emptyUsage, type AgentSource, type UsageStats } from "./lib.ts";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** One blocking subagent run's accumulated outcome (single / chain step / parallel task). */
export interface SingleResult {
  agent: string;
  agentSource: AgentSource;
  task: string;
  exitCode: number;
  running?: boolean;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  /** Resolved dispatch thinking level the spawn adapter pre-set; undefined when never pinned. */
  thinkingLevel?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

// ---------------------------------------------------------------------------
// Protocol accumulator
// ---------------------------------------------------------------------------

/**
 * The protocol-side accumulation surface: feed stdout chunks (buffered into
 * lines, JSON-parsed, dispatched) and stderr chunks; `finish()` flushes any
 * pending partial line and returns the assembled result. The caller patches
 * `exitCode` after the process closes.
 */
export interface BlockingResultAccumulator {
  onStdout(chunk: string): void;
  onStderr(chunk: string): void;
  finish(): SingleResult;
}

export function createResultAccumulator(opts: {
  agent: string;
  agentSource: AgentSource;
  task: string;
  step?: number;
  /** Pre-set model (agent pin or dispatch default); the first message model only fills an empty slot. */
  model?: string;
  /**
   * Pre-set dispatch thinking level (agent role tier or dispatch default). The
   * child stream never reports its effective level, so this is the only source
   * (ADR 0015); undefined means the run never pinned one and displays as
   * `default`.
   */
  thinkingLevel?: string;
  /** Fired once per dispatched event (message_end / tool_result_end) with the partial result. */
  onProgress?: (partial: SingleResult) => void;
}): BlockingResultAccumulator {
  const result: SingleResult = {
    agent: opts.agent,
    agentSource: opts.agentSource,
    task: opts.task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    model: opts.model,
    thinkingLevel: opts.thinkingLevel,
    step: opts.step,
  };

  let buffer = "";

  const processLine = (line: string) => {
    if (!line.trim()) return;
    let event: { type?: string; message?: unknown };
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === "message_end" && event.message) {
      const msg = event.message as Message;
      result.messages.push(msg);
      if (msg.role === "assistant") {
        result.usage.turns++;
        const usage = msg.usage;
        if (usage) {
          result.usage.input += usage.input || 0;
          result.usage.output += usage.output || 0;
          result.usage.cacheRead += usage.cacheRead || 0;
          result.usage.cacheWrite += usage.cacheWrite || 0;
          result.usage.cost += usage.cost?.total || 0;
          result.usage.contextTokens = usage.totalTokens || 0;
        }
        if (!result.model && msg.model) result.model = msg.model;
        if (msg.stopReason) result.stopReason = msg.stopReason;
        if (msg.errorMessage) result.errorMessage = msg.errorMessage;
      }
      opts.onProgress?.(result);
    }
    if (event.type === "tool_result_end" && event.message) {
      result.messages.push(event.message as Message);
      opts.onProgress?.(result);
    }
  };

  return {
    onStdout(chunk: string) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    },
    onStderr(chunk: string) {
      result.stderr += chunk;
    },
    finish() {
      if (buffer.trim()) processLine(buffer);
      // Idempotent: the adapter may call finish twice (spawn error then close),
      // and a pending line must never be dispatched twice.
      buffer = "";
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Escalating kill
// ---------------------------------------------------------------------------

/** The minimal process surface the kill path needs (structural; real spawn passes a ChildProcess). */
export interface KillTarget {
  kill(signal: NodeJS.Signals): boolean;
}

export interface EscalateKillDeps {
  setTimeout?: (fn: () => void, ms?: number) => { unref?: () => void };
  clearTimeout?: (id: unknown) => void;
  graceMs?: number;
}

/**
 * The abort path for a spawned blocking child: `send()` fires SIGTERM and
 * arms a SIGKILL backstop; `dispose()` cancels the backstop (the adapter calls
 * it on the child's `close`). The backstop is keyed off disposal, never off
 * `ChildProcess.killed` — that flag only means kill() was called, so a live
 * child that ignores SIGTERM must still be SIGKILLed after grace.
 */
export interface EscalationHandle {
  send(): void;
  dispose(): void;
}

export function escalateKill(target: KillTarget, deps?: EscalateKillDeps): EscalationHandle {
  const setTimer = deps?.setTimeout ?? ((fn: () => void, ms?: number) => setTimeout(fn, ms));
  const clearTimer = deps?.clearTimeout ?? ((id?: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const graceMs = deps?.graceMs ?? 5000;
  let timer: { unref?: () => void } | undefined;
  let sent = false;
  return {
    send() {
      if (sent) return;
      sent = true;
      target.kill("SIGTERM");
      timer = setTimer(() => {
        target.kill("SIGKILL");
      }, graceMs);
      (timer as { unref?: () => void } | undefined)?.unref?.();
    },
    dispose() {
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
    },
  };
}
