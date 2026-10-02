// Seam: the orchestration module — single / parallel / chain flows driven
// against the REAL run registry with a FAKE runner, so the registry
// bookkeeping (register → status flips → terminal patch → abort sweep) and
// the failure exits are pinned without spawning a real pi process.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "@earendil-works/pi-ai";
import { createRunRegistry, isActiveRunStatus, type AgentConfig } from "./lib.ts";
import { runBlockingPlan, firstInvalidPlanThinkingLevel, truncateParallelOutput, type RunnerSeam, type SingleResult } from "./blocking-runner.ts";

const noAgents: AgentConfig[] = [];

function assistantMsg(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] } as unknown as Message;
}

function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 };
}

function okResult(agent: string, text: string): SingleResult {
  return {
    agent,
    agentSource: "embedded",
    task: "t",
    exitCode: 0,
    messages: [assistantMsg(text)],
    stderr: "",
    usage: zeroUsage(),
  };
}

function failedResult(agent: string, stderr = "boom", stopReason = "error"): SingleResult {
  return {
    agent,
    agentSource: "embedded",
    task: "t",
    exitCode: 1,
    messages: [],
    stderr,
    usage: zeroUsage(),
    stopReason,
  };
}

// ---------------------------------------------------------------------------
// Single
// ---------------------------------------------------------------------------

test("single mode runs one task, settles the run succeeded, and returns the final output", async () => {
  const registry = createRunRegistry();
  const runner: RunnerSeam = {
    async runTask(_t, opts) {
      opts.onProgress(okResult("r1", "progress"));
      return okResult("r1", "hello");
    },
  };
  const out = await runBlockingPlan({ plan: { mode: "single", agent: "r1", task: "t" }, runner, registry, agents: noAgents });
  assert.equal(out.text, "hello");
  assert.equal(out.details.mode, "single");
  assert.equal(out.details.results.length, 1);
  const [run] = registry.snapshot();
  assert.equal(run.role, "r1");
  assert.equal(run.channel, "blocking");
  assert.equal(run.status, "succeeded");
  assert.equal(run.lastOutput, "hello", "the terminal patch overwrites lastOutput with the final output");
});

test("single mode reports progress through onToolUpdate without a trailing final event", async () => {
  const updates: string[] = [];
  const registry = createRunRegistry();
  const runner: RunnerSeam = {
    async runTask(_t, opts) {
      opts.onProgress(okResult("r1", "progress"));
      return okResult("r1", "final");
    },
  };
  await runBlockingPlan({
    plan: { mode: "single", agent: "r1", task: "t" },
    runner,
    registry,
    agents: noAgents,
    onToolUpdate: (text) => updates.push(text),
  });
  assert.deepEqual(updates, ["progress"], "progress events only, like today's emitUpdate");
});

test("single mode throws the tool error on a failed run and settles the run failed", async () => {
  const registry = createRunRegistry();
  const runner: RunnerSeam = { async runTask() { return failedResult("r1", "boom"); } };
  await assert.rejects(
    runBlockingPlan({ plan: { mode: "single", agent: "r1", task: "t" }, runner, registry, agents: noAgents }),
    /Agent error: boom/,
  );
  const [run] = registry.snapshot();
  assert.equal(run.status, "failed");
});

test("single mode marks the run aborted and rethrows when the runner aborts", async () => {
  const registry = createRunRegistry();
  const runner: RunnerSeam = { async runTask() { throw new Error("Subagent was aborted"); } };
  await assert.rejects(
    runBlockingPlan({ plan: { mode: "single", agent: "r1", task: "t" }, runner, registry, agents: noAgents }),
    /Subagent was aborted/,
  );
  const [run] = registry.snapshot();
  assert.equal(run.status, "aborted");
});

test("an unknown agent resolves to the unknown source and fails through the normal path", async () => {
  const registry = createRunRegistry();
  const runner: RunnerSeam = {
    async runTask(t) {
      return {
        agent: t.agentName,
        agentSource: "unknown",
        task: t.task,
        exitCode: 1,
        messages: [],
        stderr: `Unknown agent: "${t.agentName}". Available agents: none.`,
        usage: zeroUsage(),
      };
    },
  };
  await assert.rejects(
    runBlockingPlan({ plan: { mode: "single", agent: "ghost", task: "t" }, runner, registry, agents: noAgents }),
    /Agent failed: Unknown agent: "ghost"/,
  );
  const [run] = registry.snapshot();
  assert.equal(run.source, "unknown");
  assert.equal(run.status, "failed");
});

// ---------------------------------------------------------------------------
// Chain
// ---------------------------------------------------------------------------

test("chain mode substitutes {previous} and registers one run per step", async () => {
  const registry = createRunRegistry();
  const seen: string[] = [];
  const runner: RunnerSeam = {
    async runTask(t) {
      seen.push(t.task);
      return okResult(t.agentName, t.task);
    },
  };
  const out = await runBlockingPlan({
    plan: {
      mode: "chain",
      steps: [
        { agent: "a", task: "first" },
        { agent: "b", task: "second {previous}" },
        { agent: "c", task: "third {previous}" },
      ],
    },
    runner,
    registry,
    agents: noAgents,
  });
  assert.deepEqual(seen, ["first", "second first", "third second first"]);
  const runs = registry.snapshot();
  assert.equal(runs.length, 3, "each chain step is its own run (chain step)");
  assert.ok(runs.every((r) => r.status === "succeeded"));
  assert.equal(out.text, "third second first");
  assert.equal(out.details.mode, "chain");
});

test("chain mode reports progress including the completed prior steps", async () => {
  const registry = createRunRegistry();
  const detailsSeen: Array<{ mode: string; resultsLength: number }> = [];
  const runner: RunnerSeam = {
    async runTask(t, opts) {
      opts.onProgress(okResult(t.agentName, `p-${t.agentName}`));
      return okResult(t.agentName, `done-${t.agentName}`);
    },
  };
  await runBlockingPlan({
    plan: { mode: "chain", steps: [{ agent: "a", task: "1" }, { agent: "b", task: "2" }] },
    runner,
    registry,
    agents: noAgents,
    onToolUpdate: (_text, details) => detailsSeen.push({ mode: details.mode, resultsLength: details.results.length }),
  });
  assert.equal(detailsSeen.length, 2);
  assert.deepEqual(
    detailsSeen.map((d) => d.resultsLength),
    [1, 2],
    "step 2's progress carries the completed step-1 result plus the partial step-2 result",
  );
});

test("chain mode throws the step tool error and stops at the failed step", async () => {
  const registry = createRunRegistry();
  const runner: RunnerSeam = {
    async runTask(t) {
      if (t.agentName === "b") return failedResult("b", "nope");
      return okResult(t.agentName, `ok-${t.agentName}`);
    },
  };
  await assert.rejects(
    runBlockingPlan({
      plan: { mode: "chain", steps: [{ agent: "a", task: "1" }, { agent: "b", task: "2" }, { agent: "c", task: "3" }] },
      runner,
      registry,
      agents: noAgents,
    }),
    /Chain stopped at step 2 \(b\): nope/,
  );
  const runs = registry.snapshot();
  assert.deepEqual(
    runs.map((r) => r.status),
    ["succeeded", "failed"],
    "step 3 never registers once the chain stops",
  );
});

// ---------------------------------------------------------------------------
// Parallel
// ---------------------------------------------------------------------------

test("parallel mode runs all tasks and aggregates a summary", async () => {
  const registry = createRunRegistry();
  const runner: RunnerSeam = { async runTask(t) { return okResult(t.agentName, `out-${t.agentName}`); } };
  const out = await runBlockingPlan({
    plan: { mode: "parallel", tasks: [{ agent: "a", task: "1" }, { agent: "b", task: "2" }] },
    runner,
    registry,
    agents: noAgents,
  });
  assert.match(out.text, /^Parallel: 2\/2 succeeded/);
  assert.match(out.text, /### \[a\] completed/);
  assert.match(out.text, /### \[b\] completed/);
  assert.equal(out.details.mode, "parallel");
  const runs = registry.snapshot();
  assert.equal(runs.length, 2);
  assert.ok(runs.every((r) => r.status === "succeeded"));
});

test("parallel mode reports failed tasks in the summary and settles them failed", async () => {
  const registry = createRunRegistry();
  const runner: RunnerSeam = {
    async runTask(t) {
      return t.agentName === "b" ? failedResult("b", "kaboom") : okResult(t.agentName, `out-${t.agentName}`);
    },
  };
  const out = await runBlockingPlan({
    plan: { mode: "parallel", tasks: [{ agent: "a", task: "1" }, { agent: "b", task: "2" }] },
    runner,
    registry,
    agents: noAgents,
  });
  assert.match(out.text, /^Parallel: 1\/2 succeeded/);
  assert.match(out.text, /### \[b\] failed \(error\)/);
  const runs = registry.snapshot();
  assert.deepEqual(
    runs.map((r) => r.status).sort(),
    ["failed", "succeeded"],
  );
});

test("parallel mode marks every still-active run aborted when the runner aborts", async () => {
  const registry = createRunRegistry();
  const runner: RunnerSeam = { async runTask() { throw new Error("Subagent was aborted"); } };
  await assert.rejects(
    runBlockingPlan({
      plan: { mode: "parallel", tasks: [{ agent: "a", task: "1" }, { agent: "b", task: "2" }, { agent: "c", task: "3" }] },
      runner,
      registry,
      agents: noAgents,
    }),
    /Subagent was aborted/,
  );
  const runs = registry.snapshot();
  assert.equal(runs.length, 3);
  assert.ok(runs.every((r) => r.status === "aborted"), "no zombie queued or running entries survive the abort");
});

test("a worker resolving after an abort sweep keeps the run aborted (no frozen-update throw)", async () => {
  const registry = createRunRegistry();
  let first = true;
  const runner: RunnerSeam = {
    async runTask(t) {
      if (first) {
        first = false;
        throw new Error("Subagent was aborted");
      }
      // Resolve after the sweep has already terminalized this run's entry.
      await new Promise((r) => setTimeout(r, 10));
      return okResult(t.agentName, "late");
    },
  };
  await assert.rejects(
    runBlockingPlan({
      plan: { mode: "parallel", tasks: [{ agent: "a", task: "1" }, { agent: "b", task: "2" }] },
      runner,
      registry,
      agents: noAgents,
    }),
    /Subagent was aborted/,
  );
  await new Promise((r) => setTimeout(r, 30));
  const runs = registry.snapshot();
  assert.equal(runs.length, 2);
  assert.ok(runs.every((r) => r.status === "aborted"), "the sweep's aborted status wins over a late success");
});

test("parallel mode rejects more than 8 tasks without registering or running", async () => {
  const registry = createRunRegistry();
  let called = 0;
  const runner: RunnerSeam = { async runTask() { called++; return okResult("a", "x"); } };
  const out = await runBlockingPlan({
    plan: { mode: "parallel", tasks: Array.from({ length: 9 }, () => ({ agent: "a", task: "t" })) },
    runner,
    registry,
    agents: noAgents,
  });
  assert.equal(out.text, "Too many parallel tasks (9). Max is 8.");
  assert.equal(out.details.results.length, 0);
  assert.equal(registry.snapshot().length, 0);
  assert.equal(called, 0);
});

test("parallel mode honors a configured maxTasksPerCall cap", async () => {
  const registry = createRunRegistry();
  let called = 0;
  const runner: RunnerSeam = { async runTask() { called++; return okResult("a", "x"); } };
  const out = await runBlockingPlan({
    plan: { mode: "parallel", tasks: Array.from({ length: 4 }, () => ({ agent: "a", task: "t" })) },
    runner,
    registry,
    agents: noAgents,
    limits: { maxTasksPerCall: 2 },
  });
  assert.equal(out.text, "Too many parallel tasks (4). Max is 2.");
  assert.equal(called, 0);
  assert.equal(registry.snapshot().length, 0);
});

test("chain mode rejects more than the default 8 steps without running", async () => {
  const registry = createRunRegistry();
  let called = 0;
  const runner: RunnerSeam = { async runTask() { called++; return okResult("a", "x"); } };
  const out = await runBlockingPlan({
    plan: { mode: "chain", steps: Array.from({ length: 9 }, () => ({ agent: "a", task: "t" })) },
    runner,
    registry,
    agents: noAgents,
  });
  assert.equal(out.text, "Too many chain steps (9). Max is 8.");
  assert.equal(called, 0);
  assert.equal(registry.snapshot().length, 0);
});

test("chain mode honors a configured maxTasksPerCall cap", async () => {
  const registry = createRunRegistry();
  let called = 0;
  const runner: RunnerSeam = { async runTask() { called++; return okResult("a", "x"); } };
  const out = await runBlockingPlan({
    plan: { mode: "chain", steps: Array.from({ length: 4 }, () => ({ agent: "a", task: "t" })) },
    runner,
    registry,
    agents: noAgents,
    limits: { maxTasksPerCall: 3 },
  });
  assert.equal(out.text, "Too many chain steps (4). Max is 3.");
  assert.equal(called, 0);
  assert.equal(registry.snapshot().length, 0);
});

test("parallel mode honors the concurrency limit", async () => {
  const registry = createRunRegistry();
  let active = 0;
  let maxActive = 0;
  const runner: RunnerSeam = {
    async runTask() {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return okResult("a", "x");
    },
  };
  await runBlockingPlan({
    plan: { mode: "parallel", tasks: Array.from({ length: 4 }, () => ({ agent: "a", task: "t" })) },
    runner,
    registry,
    agents: noAgents,
    limits: { maxConcurrency: 2 },
  });
  assert.equal(maxActive, 2);
});

// ---------------------------------------------------------------------------
// Registry change hook (footer convergence by construction)
// ---------------------------------------------------------------------------

test("a late progress event after an abort sweep is dropped, not a frozen-update throw (race contained at the blocking boundary)", async () => {
  const registry = createRunRegistry();
  let first = true;
  let progressThrow: string | null = null;
  const runner: RunnerSeam = {
    async runTask(t, opts) {
      if (first) {
        first = false;
        throw new Error("Subagent was aborted");
      }
      // The real runner emits progress from a child-process stdout data
      // handler, where a throw would escape into the event loop. The abort
      // sweep terminalizes this run's entry before this late event arrives.
      await new Promise((r) => setTimeout(r, 10));
      try {
        opts.onProgress(okResult("b", "late progress"));
      } catch (err) {
        progressThrow = (err as Error).message;
      }
      return okResult("b", "late");
    },
  };
  await assert.rejects(
    runBlockingPlan({
      plan: { mode: "parallel", tasks: [{ agent: "a", task: "1" }, { agent: "b", task: "2" }] },
      runner,
      registry,
      agents: noAgents,
    }),
    /Subagent was aborted/,
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(
    progressThrow,
    null,
    "a progress event for an already-aborted run must not raise a frozen-update error",
  );
  const runs = registry.snapshot();
  assert.ok(runs.every((r) => r.status === "aborted"), "the sweep's aborted status wins over a late progress event");
});

test("registry onChange fires after each successful mutation and not on a frozen update", () => {
  let count = 0;
  const reg = createRunRegistry(Date.now, () => count++);
  const id = reg.register({ role: "r", source: "embedded", channel: "blocking", status: "running", startedAt: 0 });
  reg.update(id, { status: "succeeded" });
  reg.remove(id);
  assert.equal(count, 3);
  const id2 = reg.register({ role: "r", source: "embedded", channel: "blocking", status: "running", startedAt: 0 });
  reg.update(id2, { status: "succeeded" });
  assert.throws(() => reg.update(id2, { status: "failed" }), "frozen terminal updates still fail loudly");
  assert.equal(count, 5, "the failed update mutates nothing and notifies nothing");
});

test("an active-count subscriber converges to zero without callers remembering to sync", async () => {
  const activeCounts: number[] = [];
  const registry = createRunRegistry(Date.now, () => {
    activeCounts.push(registry.snapshot().filter((r) => isActiveRunStatus(r.status)).length);
  });
  const runner: RunnerSeam = { async runTask() { return okResult("a", "x"); } };
  await runBlockingPlan({ plan: { mode: "single", agent: "a", task: "t" }, runner, registry, agents: noAgents });
  assert.equal(activeCounts.at(-1), 0, "the subscriber sees the run finish without any explicit sync call");
});

test("runStep patches the dispatched model and thinking level into the registry (live and terminal)", async () => {
  const registry = createRunRegistry();
  let live: { model?: string; thinkingLevel?: string } | undefined;
  const runner: RunnerSeam = {
    async runTask(_t, opts) {
      const partial = { ...okResult("r1", "progress"), model: "sensenova/deepseek-flash", thinkingLevel: "medium" };
      opts.onProgress(partial);
      const run = registry.snapshot()[0];
      live = run ? { model: run.model, thinkingLevel: run.thinkingLevel } : undefined;
      return { ...okResult("r1", "hello"), model: "sensenova/deepseek-flash", thinkingLevel: "medium" };
    },
  };
  await runBlockingPlan({ plan: { mode: "single", agent: "r1", task: "t" }, runner, registry, agents: noAgents });
  const run = registry.snapshot()[0];
  assert.equal(run.model, "sensenova/deepseek-flash", "the terminal patch records the dispatched model");
  assert.equal(run.thinkingLevel, "medium", "the terminal patch records the resolved thinking level");
  assert.deepEqual(
    live,
    { model: "sensenova/deepseek-flash", thinkingLevel: "medium" },
    "the progress patch lands model + level while the run is still active",
  );
});

// ---------------------------------------------------------------------------
// Parallel summary truncation
// ---------------------------------------------------------------------------

test("truncateParallelOutput byte-caps a task's summary output and notes the omission", () => {
  const out = truncateParallelOutput("x".repeat(10_000), 100);
  const [head, note] = out.split("\n\n");
  assert.equal(head, "x".repeat(100));
  assert.equal(Buffer.byteLength(head, "utf8"), 100);
  assert.match(note, /^\[Output truncated: \d+ bytes omitted\. Full output preserved in tool details\.\]$/);
});

test("truncateParallelOutput drops the tail of a partial multibyte char", () => {
  const out = truncateParallelOutput("汉".repeat(5000), 100);
  const head = out.split("\n\n")[0];
  assert.ok(Buffer.byteLength(head, "utf8") <= 100, "never exceeds the byte cap");
  assert.equal(head.length * 3, Buffer.byteLength(head, "utf8"), "no broken UTF-8: whole chars only");
});

test("truncateParallelOutput returns output unchanged under the cap", () => {
  assert.equal(truncateParallelOutput("short", 100), "short");
});

// ---------------------------------------------------------------------------
// Per-task thinking level (ADR 0020)
// ---------------------------------------------------------------------------

test("firstInvalidPlanThinkingLevel passes unset and valid per-task levels", () => {
  assert.equal(
    firstInvalidPlanThinkingLevel({ mode: "parallel", tasks: [{ agent: "a", task: "1" }] }),
    undefined,
  );
  assert.equal(
    firstInvalidPlanThinkingLevel({
      mode: "parallel",
      tasks: [{ agent: "a", task: "1", thinkingLevel: "high" }, { agent: "b", task: "2", thinkingLevel: "off" }],
    }),
    undefined,
  );
  assert.equal(
    firstInvalidPlanThinkingLevel({ mode: "chain", steps: [{ agent: "a", task: "1", thinkingLevel: "xhigh" }] }),
    undefined,
  );
  // single mode has no per-task field — never flagged
  assert.equal(firstInvalidPlanThinkingLevel({ mode: "single", agent: "a", task: "1" }), undefined);
});

test("firstInvalidPlanThinkingLevel reports the first bad level with its index and value", () => {
  assert.deepEqual(
    firstInvalidPlanThinkingLevel({
      mode: "parallel",
      tasks: [{ agent: "a", task: "1", thinkingLevel: "turbo" }, { agent: "b", task: "2", thinkingLevel: "high" }],
    }),
    { index: 0, value: "turbo" },
  );
  assert.deepEqual(
    firstInvalidPlanThinkingLevel({
      mode: "chain",
      steps: [{ agent: "a", task: "1" }, { agent: "b", task: "2", thinkingLevel: 7 as unknown as string }],
    }),
    { index: 1, value: 7 },
    "a non-string value is flagged too",
  );
});

test("parallel mode forwards each task's thinkingLevel to the runner", async () => {
  const registry = createRunRegistry();
  const seen: Array<{ agentName: string; thinkingLevel?: string }> = [];
  const runner: RunnerSeam = {
    async runTask(t) {
      seen.push({ agentName: t.agentName, thinkingLevel: t.thinkingLevel });
      return okResult(t.agentName, `out-${t.agentName}`);
    },
  };
  const out = await runBlockingPlan({
    plan: {
      mode: "parallel",
      tasks: [{ agent: "a", task: "1", thinkingLevel: "high" }, { agent: "b", task: "2" }],
    },
    runner,
    registry,
    agents: noAgents,
  });
  assert.equal(out.details.mode, "parallel");
  assert.deepEqual(seen, [
    { agentName: "a", thinkingLevel: "high" },
    { agentName: "b", thinkingLevel: undefined },
  ]);
});

test("chain mode forwards each step's thinkingLevel to the runner", async () => {
  const registry = createRunRegistry();
  const seen: Array<{ agentName: string; thinkingLevel?: string }> = [];
  const runner: RunnerSeam = {
    async runTask(t) {
      seen.push({ agentName: t.agentName, thinkingLevel: t.thinkingLevel });
      return okResult(t.agentName, `out-${t.agentName}`);
    },
  };
  const out = await runBlockingPlan({
    plan: {
      mode: "chain",
      steps: [{ agent: "a", task: "1", thinkingLevel: "xhigh" }, { agent: "b", task: "2" }],
    },
    runner,
    registry,
    agents: noAgents,
  });
  assert.equal(out.details.mode, "chain");
  assert.deepEqual(seen, [
    { agentName: "a", thinkingLevel: "xhigh" },
    { agentName: "b", thinkingLevel: undefined },
  ]);
});
