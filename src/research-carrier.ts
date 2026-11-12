import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";

import { blockingTerminalName } from "./blocking-carrier.ts";
import type { HcClient } from "./hc-client.ts";
import {
  buildDispatchArgs,
  getPiInvocation,
  partitionExtensionSpecs,
  type Carrier,
  type CreateChildSession,
  type ResearchChildSession,
  type ToolCallEvent,
} from "./lib.ts";
import { findSh, terminalAddress, toShellScript, type TerminalInvocation } from "./terminal-run.ts";

/**
 * Paces the terminal check-in and, with it, the run log poll: the child's bytes
 * are read between waits instead of on a timer of their own. Provisional — no
 * measurement backs the value yet.
 */
export const RESEARCH_TERMINAL_CHECK_IN_SECONDS = 1;

/** The `kind` label a research terminal carries, beside `run` and `role`. */
export const RESEARCH_TERMINAL_KIND = "research";

const READ_CHUNK_BYTES = 64 * 1024;

/** The options a carrier-based research factory receives from the run. */
export type ResearchChildOptions = Parameters<CreateChildSession>[0];

/**
 * Runs the research child in a herdr-core terminal: a plain `pi` invocation
 * whose stdout/stderr land in files beside the run log (the runner's tee stays
 * the log's only writer), streamed by polling those files, with `done`
 * settling on the terminal's exit code.
 */
export function createHcResearchChildSession(
  opts: ResearchChildOptions,
  deps: HcResearchChildDeps,
): ResearchChildSession {
  const resolveInvocation = deps.invocation ?? getPiInvocation;
  const dir = path.dirname(opts.logPath);
  const promptPath = path.join(dir, "system-prompt.md");
  fs.writeFileSync(promptPath, opts.systemPrompt, { encoding: "utf8", mode: 0o600 });
  const outPath = `${opts.logPath}.terminal.out`;
  const errPath = `${opts.logPath}.terminal.err`;
  const { launch, redundant: redundantExtensions, collapsed: collapsedExtensions } =
    partitionExtensionSpecs(opts.extensions, opts.settingsPackageRefs ?? []);
  // A fully skipped knob omits the flags: an empty list would reach pi as
  // `--no-extensions` (issue #53) and drop the packages the settings load.
  const launchExtensions = launch.length === 0 && opts.extensions.length > 0 ? undefined : launch;
  const args = buildDispatchArgs({
    model: modelRef(opts.model),
    thinking: opts.thinkingLevel,
    tools: opts.tools,
    extensions: launchExtensions,
    promptPath,
    task: opts.task,
  });

  // A suspended consumer must be released by the stream ending too, or the
  // runner's tee never terminates.
  const chunks: string[] = [];
  const waiters: Array<() => void> = [];
  let ended = false;
  let aborted = false;
  let terminal: string | undefined;
  const release = () => {
    while (waiters.length > 0 && (chunks.length > 0 || ended)) waiters.shift()!();
  };
  const push = (text: string) => {
    if (text === "") return;
    chunks.push(text);
    release();
  };
  const endStream = () => {
    ended = true;
    release();
  };
  if (redundantExtensions.length > 0) {
    push(`[loadout] info · the session's settings already load ${redundantExtensions.join(", ")}, so the launch leaves it out\n`);
  }
  if (collapsedExtensions.length > 0) {
    push(`[loadout] info · the knob names ${collapsedExtensions.join(", ")} twice, so the launch leaves the repeat out\n`);
  }

  const output = (async function* () {
    while (true) {
      while (chunks.length > 0) yield chunks.shift()!;
      if (ended) return;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  })();

  // A decoder per file: one character may straddle two reads, and `toString`
  // per chunk would corrupt it.
  const decoders = { out: new StringDecoder("utf8"), err: new StringDecoder("utf8") };
  const offsets = { out: 0, err: 0 };
  // The child's stdout is its JSON event stream (pi --mode json), so the same
  // bytes that feed the log also carry the tool audit the in-process child
  // reports through `opts.onToolCall`.
  let pendingLine = "";
  const audit = (text: string) => {
    if (!opts.onToolCall) return;
    pendingLine += text;
    const lines = pendingLine.split("\n");
    pendingLine = lines.pop() ?? "";
    for (const line of lines) reportToolCall(line, opts.onToolCall);
  };
  const pump = () => {
    for (const key of ["out", "err"] as const) {
      const file = key === "out" ? outPath : errPath;
      const read = readAppended(file, offsets[key]);
      offsets[key] = read.offset;
      if (read.bytes.length === 0) continue;
      const text = decoders[key].write(read.bytes);
      if (key === "out") audit(text);
      push(text);
    }
  };

  let killed = false;
  const kill = async () => {
    if (killed || !terminal) return;
    killed = true;
    const result = await deps.client.call("terminal.kill", { terminal });
    if (!result.ok) {
      deps.onWarn?.(`carrier hc: research terminal ${terminal} could not be killed (${result.failure}: ${result.message})`);
    }
  };

  const done = (async () => {
    try {
      const started = await deps.client.call("terminal.run", {
        argv: [deps.sh, "-c", toShellScript(resolveInvocation(args), outPath, errPath)],
        cwd: opts.cwd,
        env: Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        ),
        name: blockingTerminalName(opts.runId),
        labels: { run: opts.runId, kind: RESEARCH_TERMINAL_KIND, role: "researcher" },
      });
      if (!started.ok) {
        throw new Error(`carrier hc: the research terminal could not start (${started.failure}: ${started.message})`);
      }
      const address = terminalAddress(started.result);
      if (!address) {
        throw new Error(
          "carrier hc: terminal.run answered without a terminal address, so the research child may have started",
        );
      }
      terminal = address;
      deps.onStarted?.(address);
      for (;;) {
        pump();
        if (aborted) {
          await kill();
          return;
        }
        const waited = await deps.client.call("terminal.wait", {
          terminal: address,
          timeout: deps.checkInSeconds ?? RESEARCH_TERMINAL_CHECK_IN_SECONDS,
        });
        if (!waited.ok) {
          throw new Error(
            `carrier hc: herdr-core lost the research terminal ${terminal} (${waited.failure}: ${waited.message})`,
          );
        }
        const result = waited.result as { ended?: boolean; exit_code?: number | null } | null;
        if (result?.ended !== true) continue;
        pump();
        const exitCode = result.exit_code ?? 1;
        if (exitCode !== 0) {
          const complaint = stderrTail(errPath);
          throw new Error(
            complaint === ""
              ? `research child exited with code ${exitCode}`
              : `research child exited with code ${exitCode}: ${complaint}`,
          );
        }
        return;
      }
    } finally {
      endStream();
    }
  })();

  return {
    output,
    done,
    abort: () => {
      if (aborted) return;
      aborted = true;
      endStream();
      void kill();
    },
  };
}

export interface HcResearchChildDeps {
  client: HcClient;
  /** The POSIX shell the terminal runs the child under (see `findSh`). */
  sh: string;
  /** Resolves the child's launch command; defaults to this pi entry point. */
  invocation?: (args: string[]) => TerminalInvocation;
  /** Seconds per `terminal.wait` check-in; defaults to RESEARCH_TERMINAL_CHECK_IN_SECONDS. */
  checkInSeconds?: number;
  /** Surfaces a kill that could not stop the terminal. */
  onWarn?: (message: string) => void;
  /** Fires once with the address as soon as the terminal exists, before it is waited on. */
  onStarted?: (terminal: string) => void;
}

export interface ResearchChildFactoryInput {
  /** The carrier knob in effect for this dispatch. */
  carrier: Carrier;
  /** The core connection, resolved lazily so a `spawn` dispatch never connects. */
  client: () => HcClient;
  /** The in-process child factory, used for `spawn` and as the `hc` fallback. */
  inProcess: CreateChildSession;
  /** Resolves the POSIX shell the terminal needs; defaults to `findSh`. */
  findShell?: () => string | undefined;
  /** Surfaces a per-run degradation (the `hc` carrier falling back to in-process, a kill that missed). */
  onWarn?: (message: string) => void;
  /** Fires once with each terminal address the run starts. */
  onStarted?: (terminal: string) => void;
}

/**
 * Picks the research child carrier per run (issue #53): `hc` runs the child in
 * a herdr-core terminal, `spawn` keeps the in-process child, and a host without
 * a POSIX shell warns and falls back to in-process for that run.
 */
export function createResearchChildFactory(input: ResearchChildFactoryInput): CreateChildSession {
  return (opts) => {
    if (input.carrier !== "hc") return input.inProcess(opts);
    const shell = (input.findShell ?? findSh)();
    if (!shell) {
      input.onWarn?.(
        "carrier hc: no sh on PATH, so a research terminal cannot start; falling back to the in-process child for this run.",
      );
      return input.inProcess(opts);
    }
    return createHcResearchChildSession(opts, {
      client: input.client(),
      sh: shell,
      onWarn: input.onWarn,
      onStarted: input.onStarted,
    });
  };
}

function modelRef(model: unknown): string | undefined {
  const ref = model as { provider?: unknown; id?: unknown } | undefined;
  return typeof ref?.provider === "string" && typeof ref.id === "string" ? `${ref.provider}/${ref.id}` : undefined;
}

const FAILURE_TAIL_LINES = 20;

function stderrTail(file: string): string {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const tail = lines.slice(-FAILURE_TAIL_LINES);
  return lines.length > tail.length ? `…\n${tail.join("\n")}` : tail.join("\n");
}

function readAppended(file: string, offset: number): { bytes: Buffer; offset: number } {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch (err) {
    // The shell has not created the file yet; anything else is a real read error.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { bytes: Buffer.alloc(0), offset };
    throw err;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return { bytes: Buffer.alloc(0), offset };
    const length = Math.min(size - offset, READ_CHUNK_BYTES);
    const bytes = Buffer.allocUnsafe(length);
    const read = fs.readSync(fd, bytes, 0, length, offset);
    return { bytes: bytes.subarray(0, read), offset: offset + read };
  } finally {
    fs.closeSync(fd);
  }
}

function reportToolCall(line: string, onToolCall: (call: ToolCallEvent) => void): void {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  const started = event as { type?: unknown; toolCallId?: unknown; toolName?: unknown; args?: unknown };
  if (started.type !== "tool_execution_start") return;
  if (typeof started.toolCallId !== "string" || typeof started.toolName !== "string") return;
  onToolCall({ toolCallId: started.toolCallId, toolName: started.toolName, args: started.args });
}
