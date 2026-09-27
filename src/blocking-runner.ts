/**
 * Pure blocking orchestration: single / parallel / chain plans driven over a
 * Runner seam against the real run registry. Zero pi-runtime imports — the
 * registry bookkeeping (register → status flips → terminal patch → abort
 * sweep), the failure exits (tool error throws per ADR 0010), and the
 * tool-result content assembly all live here, so every mode's observable
 * behavior is pinned under `node --test` with a fake runner.
 */

import {
  blockingRunStatus,
  emptyUsage,
  formatBlockingToolError,
  getResultOutput,
  isActiveRunStatus,
  isToolError,
  lastAssistantText,
  lastOutputLine,
  resolveRole,
  type AgentConfig,
  type AgentSource,
  type RunRegistry,
} from "./lib.ts";
import type { SingleResult } from "./blocking-protocol.ts";

export type { SingleResult } from "./blocking-protocol.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  results: SingleResult[];
}

export type BlockingPlan =
  | { mode: "single"; agent: string; task: string; cwd?: string }
  | { mode: "parallel"; tasks: Array<{ agent: string; task: string; cwd?: string }> }
  | { mode: "chain"; steps: Array<{ agent: string; task: string; cwd?: string }> };

export interface RunnerTask {
  agentName: string;
  task: string;
  cwd?: string;
  step?: number;
}

/** The execution seam the orchestrator runs over: pure execution plus typed progress events. */
export interface RunnerSeam {
  runTask(
    task: RunnerTask,
    opts: { signal?: AbortSignal; onProgress: (partial: SingleResult) => void },
  ): Promise<SingleResult>;
}

export interface BlockingPlanLimits {
  maxTasksPerCall?: number;
  maxConcurrency?: number;
  perTaskOutputCap?: number;
}

export interface BlockingPlanResult {
  text: string;
  details: SubagentDetails;
}

const DEFAULT_LIMITS: Required<BlockingPlanLimits> = {
  maxTasksPerCall: 8,
  maxConcurrency: 4,
  perTaskOutputCap: 50 * 1024,
};

// ---------------------------------------------------------------------------
// Result semantics helpers
//   The failure/status/output-semantics cluster lives in lib.ts (isToolError,
//   blockingRunStatus, getResultOutput, lastAssistantText, lastOutputLine);
//   the orchestrator consumes it. truncateParallelOutput stays here because it
//   is parallel-summary display, not shared semantics.
// ---------------------------------------------------------------------------

/** Byte-cap one task's summary output, dropping the tail of a partial multibyte char. */
export function truncateParallelOutput(output: string, cap = DEFAULT_LIMITS.perTaskOutputCap): string {
  const byteLength = Buffer.byteLength(output, "utf8");
  if (byteLength <= cap) return output;
  let truncated = output.slice(0, cap);
  while (Buffer.byteLength(truncated, "utf8") > cap) truncated = truncated.slice(0, -1);
  return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

/** Runs fn over items with at most `concurrency` in flight, preserving order. */
export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Runs one validated blocking plan over the runner seam, owning the registry
 * flow (register → live progress → terminal patch → abort sweep) and the
 * failure exits. Observable behavior matches the previous inline extension
 * code: single/chain failures throw the tool error (ADR 0010), parallel
 * aggregates failed tasks into the summary, and an abort marks the affected
 * runs aborted before rethrowing. `onToolUpdate` mirrors the tool's live
 * onUpdate events; the registry's onChange hook drives the footer.
 */
export async function runBlockingPlan(opts: {
  plan: BlockingPlan;
  runner: RunnerSeam;
  registry: RunRegistry;
  agents: AgentConfig[];
  limits?: BlockingPlanLimits;
  signal?: AbortSignal;
  now?: () => number;
  onToolUpdate?: (text: string, details: SubagentDetails) => void;
}): Promise<BlockingPlanResult> {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const now = opts.now ?? Date.now;
  const { plan, runner, registry, agents, signal } = opts;

  const sourceOf = (name: string): AgentSource => resolveRole(agents, name)?.source ?? "unknown";
  const makeDetails = (results: SingleResult[]): SubagentDetails => ({ mode: plan.mode, results });

  if (plan.mode === "single") {
    const runId = registry.register({
      role: plan.agent,
      source: sourceOf(plan.agent),
      channel: "blocking",
      status: "running",
      startedAt: now(),
    });
    let result: SingleResult;
    try {
      result = await runner.runTask({ agentName: plan.agent, task: plan.task, cwd: plan.cwd }, {
        signal,
        onProgress: (partial) => {
          const out = lastAssistantText(partial.messages);
          if (out) registry.update(runId, { lastOutput: lastOutputLine(out), usage: partial.usage });
          opts.onToolUpdate?.(out || "(running...)", makeDetails([partial]));
        },
      });
    } catch (err) {
      registry.update(runId, { status: "aborted" });
      throw err;
    }
    registry.update(runId, {
      status: blockingRunStatus({ exitCode: result.exitCode, stopReason: result.stopReason }),
      lastOutput: lastOutputLine(lastAssistantText(result.messages)),
      usage: result.usage,
    });
    if (isToolError(result)) {
      throw new Error(
        formatBlockingToolError("single", { stopReason: result.stopReason, output: getResultOutput(result) }),
      );
    }
    return { text: lastAssistantText(result.messages) || "(no output)", details: makeDetails([result]) };
  }

  if (plan.mode === "chain") {
    const results: SingleResult[] = [];
    let previousOutput = "";
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
      const runId = registry.register({
        role: step.agent,
        source: sourceOf(step.agent),
        channel: "blocking",
        status: "running",
        startedAt: now(),
      });
      let result: SingleResult;
      try {
        result = await runner.runTask({ agentName: step.agent, task: taskWithContext, cwd: step.cwd, step: i + 1 }, {
          signal,
          onProgress: (partial) => {
            const out = lastAssistantText(partial.messages);
            if (out) registry.update(runId, { lastOutput: lastOutputLine(out), usage: partial.usage });
            opts.onToolUpdate?.(out || "(running...)", makeDetails([...results, partial]));
          },
        });
      } catch (err) {
        registry.update(runId, { status: "aborted" });
        throw err;
      }
      results.push(result);
      registry.update(runId, {
        status: blockingRunStatus({ exitCode: result.exitCode, stopReason: result.stopReason }),
        lastOutput: lastOutputLine(lastAssistantText(result.messages)),
        usage: result.usage,
      });
      if (isToolError(result)) {
        throw new Error(
          formatBlockingToolError("chain", { agent: step.agent, step: i + 1, output: getResultOutput(result) }),
        );
      }
      previousOutput = lastAssistantText(result.messages);
    }
    return {
      text: lastAssistantText(results[results.length - 1].messages) || "(no output)",
      details: makeDetails(results),
    };
  }

  // parallel
  if (plan.tasks.length > limits.maxTasksPerCall) {
    return {
      text: `Too many parallel tasks (${plan.tasks.length}). Max is ${limits.maxTasksPerCall}.`,
      details: makeDetails([]),
    };
  }
  const allResults: SingleResult[] = new Array(plan.tasks.length);
  const runIds: string[] = plan.tasks.map((t) =>
    registry.register({
      role: t.agent,
      source: sourceOf(t.agent),
      channel: "blocking",
      status: "queued",
      startedAt: now(),
    }),
  );
  for (let i = 0; i < plan.tasks.length; i++) {
    allResults[i] = {
      agent: plan.tasks[i].agent,
      agentSource: "unknown",
      task: plan.tasks[i].task,
      exitCode: 0,
      running: true,
      messages: [],
      stderr: "",
      usage: emptyUsage(),
    };
  }
  const emitParallelUpdate = () => {
    const running = allResults.filter((r) => r.running).length;
    const done = allResults.filter((r) => !r.running).length;
    opts.onToolUpdate?.(`Parallel: ${done}/${allResults.length} done, ${running} running...`, makeDetails([...allResults]));
  };
  let results: SingleResult[];
  try {
    results = await mapWithConcurrencyLimit(plan.tasks, limits.maxConcurrency, async (t, index) => {
      registry.update(runIds[index], { status: "running" });
      let result: SingleResult;
      try {
        result = await runner.runTask({ agentName: t.agent, task: t.task, cwd: t.cwd }, {
          signal,
          onProgress: (partial) => {
            allResults[index] = partial;
            const out = lastAssistantText(partial.messages);
            if (out) registry.update(runIds[index], { lastOutput: lastOutputLine(out), usage: partial.usage });
            emitParallelUpdate();
          },
        });
      } catch (err) {
        registry.update(runIds[index], { status: "aborted" });
        throw err;
      }
      allResults[index] = result;
      registry.update(runIds[index], {
        status: blockingRunStatus({ exitCode: result.exitCode, stopReason: result.stopReason }),
        lastOutput: lastOutputLine(lastAssistantText(result.messages)),
        usage: result.usage,
      });
      emitParallelUpdate();
      return result;
    });
  } catch (err) {
    // Abort surfaces here (user Esc). Leftover workers never started: their
    // runs sit in queued (active). Mark every still-active run aborted so the
    // overview shows the truth instead of zombie queued entries.
    for (const id of runIds) {
      const r = registry.get(id);
      if (r && isActiveRunStatus(r.status)) registry.update(id, { status: "aborted" });
    }
    throw err;
  }

  const successCount = results.filter((r) => !isToolError(r)).length;
  const summaries = results.map((r) => {
    const output = truncateParallelOutput(getResultOutput(r), limits.perTaskOutputCap);
    const status = isToolError(r)
      ? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
      : "completed";
    return `### [${r.agent}] ${status}\n\n${output}`;
  });
  return {
    text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
    details: makeDetails(results),
  };
}
