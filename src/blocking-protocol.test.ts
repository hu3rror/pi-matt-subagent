// Seam: pure protocol layer — the JSON-lines blocking child protocol
// (message_end / tool_result_end dispatch, usage accumulation) and the
// escalating-kill abort path, pinned under `node --test` with no pi runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createResultAccumulator, escalateKill, type SingleResult } from "./blocking-protocol.ts";

/** A message_end event like the child protocol emits, cast to the protocol's message type. */
function assistantEvent(text: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      ...overrides,
    },
  };
}

function usageEvent(text: string, usage: Record<string, unknown>) {
  return assistantEvent(text, { usage });
}

// ---------------------------------------------------------------------------
// Protocol accumulator
// ---------------------------------------------------------------------------

test("accumulator buffers a JSON line split across stdout chunks", () => {
  const acc = createResultAccumulator({ agent: "a", agentSource: "embedded", task: "t" });
  const line = JSON.stringify(assistantEvent("hello"));
  acc.onStdout(line.slice(0, 12));
  acc.onStdout(line.slice(12));
  const r = acc.finish();
  assert.equal(r.messages.length, 1);
  const first = r.messages[0] as unknown as { content: Array<{ text: string }> };
  assert.equal(first.content[0].text, "hello");
});

test("accumulator handles multiple lines in one chunk and across chunks", () => {
  const acc = createResultAccumulator({ agent: "a", agentSource: "embedded", task: "t" });
  const l1 = JSON.stringify(assistantEvent("one"));
  const l2 = JSON.stringify(assistantEvent("two"));
  acc.onStdout(`${l1}\n`);
  acc.onStdout(`${l2}\n`);
  const r = acc.finish();
  assert.equal(r.messages.length, 2);
});

test("accumulator accumulates usage across assistant message_ends (add fields, last-wins contextTokens)", () => {
  const acc = createResultAccumulator({ agent: "a", agentSource: "embedded", task: "t" });
  acc.onStdout(
    JSON.stringify(
      usageEvent("a", { input: 10, output: 20, cacheRead: 1, cacheWrite: 2, cost: { total: 0.5 }, totalTokens: 100 }),
    ) + "\n",
  );
  acc.onStdout(
    JSON.stringify(
      usageEvent("b", { input: 30, output: 40, cacheRead: 3, cacheWrite: 4, cost: { total: 0.7 }, totalTokens: 300 }),
    ) + "\n",
  );
  const r = acc.finish();
  assert.equal(r.usage.turns, 2);
  assert.equal(r.usage.input, 40);
  assert.equal(r.usage.output, 60);
  assert.equal(r.usage.cacheRead, 4);
  assert.equal(r.usage.cacheWrite, 6);
  assert.equal(r.usage.cost, 1.2);
  assert.equal(r.usage.contextTokens, 300, "contextTokens is last-wins, not accumulated");
});

test("accumulator tolerates assistant messages without usage (no crash, no accounting)", () => {
  const acc = createResultAccumulator({ agent: "a", agentSource: "embedded", task: "t" });
  acc.onStdout(JSON.stringify(assistantEvent("plain")));
  const r = acc.finish();
  assert.equal(r.usage.turns, 1);
  assert.equal(r.usage.input, 0);
});

test("accumulator captures model, stopReason, and errorMessage from assistant messages", () => {
  const acc = createResultAccumulator({ agent: "a", agentSource: "embedded", task: "t" });
  acc.onStdout(JSON.stringify(assistantEvent("m1", { model: "prov/m1", stopReason: "stop" })) + "\n");
  acc.onStdout(JSON.stringify(assistantEvent("m2", { model: "prov/m2", stopReason: "error", errorMessage: "boom" })) + "\n");
  const r = acc.finish();
  assert.equal(r.model, "prov/m1", "first model wins");
  assert.equal(r.stopReason, "error", "stopReason is last-wins");
  assert.equal(r.errorMessage, "boom");
});

test("accumulator appends tool_result_end messages to the transcript", () => {
  const acc = createResultAccumulator({ agent: "a", agentSource: "embedded", task: "t" });
  acc.onStdout(JSON.stringify(assistantEvent("ask")) + "\n");
  acc.onStdout(JSON.stringify({ type: "tool_result_end", message: { role: "tool", content: [{ type: "text", text: "42" }] } }) + "\n");
  const r = acc.finish();
  assert.equal(r.messages.length, 2);
  const tool = r.messages[1] as unknown as { role: string };
  assert.equal(tool.role, "tool");
});

test("accumulator collects stderr chunks into the result's stderr", () => {
  const acc = createResultAccumulator({ agent: "a", agentSource: "embedded", task: "t" });
  acc.onStderr("warn one\n");
  acc.onStderr("warn two");
  assert.equal(acc.finish().stderr, "warn one\nwarn two");
});

test("finish processes a trailing pending line without a newline", () => {
  const acc = createResultAccumulator({ agent: "a", agentSource: "embedded", task: "t" });
  const full = JSON.stringify(assistantEvent("x"));
  acc.onStdout(`${full}\n`);
  // A complete line delivered without a trailing newline stays pending until finish.
  acc.onStdout(JSON.stringify(assistantEvent("y")));
  const r = acc.finish();
  assert.equal(r.messages.length, 2);
});

test("accumulator ignores non-JSON stdout lines", () => {
  const acc = createResultAccumulator({ agent: "a", agentSource: "embedded", task: "t" });
  acc.onStdout("not json at all\n");
  acc.onStdout("[brackets]\n");
  const r = acc.finish();
  assert.equal(r.messages.length, 0);
});

test("onProgress fires once per dispatched event with the partial result", () => {
  const seen: SingleResult[] = [];
  const acc = createResultAccumulator({
    agent: "a",
    agentSource: "embedded",
    task: "t",
    onProgress: (partial) => seen.push(partial),
  });
  acc.onStdout(`${JSON.stringify(assistantEvent("a"))}\n${JSON.stringify({ type: "tool_result_end", message: { role: "tool", content: [] } })}\n`);
  assert.equal(seen.length, 2);
  // Progress carries the live accumulating result (same reference as today's
  // emitUpdate), not a per-event snapshot.
  assert.equal(seen[0].messages.length, 2);
  assert.equal(seen[0].usage.turns, 1, "only the one assistant message counted");
  assert.equal(seen[1].messages.length, 2);
});

test("finish returns the assembled result with identity fields and a default exitCode", () => {
  const acc = createResultAccumulator({ agent: "r1", agentSource: "project", task: "the task", step: 3 });
  const r = acc.finish();
  assert.equal(r.agent, "r1");
  assert.equal(r.agentSource, "project");
  assert.equal(r.task, "the task");
  assert.equal(r.step, 3);
  assert.equal(r.exitCode, 0, "exitCode is patched by the caller after close");
});

// ---------------------------------------------------------------------------
// Escalating kill (SIGTERM → SIGKILL after grace)
// ---------------------------------------------------------------------------

interface FakeTimer {
  fired?: () => void;
}

function fakeTimerDeps(): { setTimer: (fn: () => void) => { unref: () => void }; timer: FakeTimer } {
  const timer: FakeTimer = {};
  const setTimer = (fn: () => void) => {
    timer.fired = fn;
    return { unref: () => {} };
  };
  return { setTimer, timer };
}

test("escalateKill sends SIGTERM on invocation, then SIGKILL after grace when the target survives", () => {
  const calls: string[] = [];
  const target = { killed: false, kill: (s: string) => (calls.push(s), true) };
  const { setTimer, timer } = fakeTimerDeps();
  const kill = escalateKill(target, { graceMs: 50, setTimeout: setTimer });
  assert.deepEqual(calls, [], "creation does not kill");
  kill();
  assert.deepEqual(calls, ["SIGTERM"]);
  timer.fired?.();
  assert.deepEqual(calls, ["SIGTERM", "SIGKILL"]);
});

test("escalateKill skips SIGKILL when the target is already dead at grace time", () => {
  const calls: string[] = [];
  const target = { killed: true, kill: (s: string) => (calls.push(s), true) };
  const { setTimer, timer } = fakeTimerDeps();
  const kill = escalateKill(target, { graceMs: 50, setTimeout: setTimer });
  kill();
  timer.fired?.();
  assert.deepEqual(calls, ["SIGTERM"]);
});

test("escalateKill defaults to a 5000ms grace window with the real timer", () => {
  const calls: string[] = [];
  const target = { killed: false, kill: (s: string) => (calls.push(s), true) };
  const kill = escalateKill(target);
  kill();
  assert.deepEqual(calls, ["SIGTERM"], "real-timer path fires SIGTERM immediately");
});
