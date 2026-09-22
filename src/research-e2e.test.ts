// Seam C — end-to-end background semantics (ADR 0013) with FAKE child
// sessions against the REAL wall-clock watcher and REAL file writes.
// Proves the runner's contract without invoking the pi CLI, a model, or the
// in-process createAgentSession wiring:
//   the caller returns immediately (does not wait for the child session),
//   and a terminal state fires onExit exactly once with the resolved status,
//   the teed log lands on disk, and a wall-clock kill appends the slim
//   `research-terminated` marker.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runBackgroundResearch, type ResearchExitInfo } from "./lib.ts";
import { embeddedResearcher, fakeChild } from "./test-helpers.ts";

// Seam C — ADR 0013. A delayed findings write: the child session writes the
// findings file after 1000ms and then settles; the caller must have returned
// long before that, and onExit must resolve succeeded with the file on disk.
test("background research writes findings without blocking the caller (fake child)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2-e2e-"));
  const findingsPath = path.join(dir, "findings.md");
  let doneResolve: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    doneResolve = resolve;
  });
  const writeAndFinish = (async () => {
    await new Promise((r) => setTimeout(r, 1000));
    fs.writeFileSync(findingsPath, "E2E OK", "utf8");
    doneResolve?.();
  })();
  const exits: ResearchExitInfo[] = [];
  const handle = runBackgroundResearch(
    { cwd: dir, task: "T", findingsPath, agents: [embeddedResearcher()], onExit: (info) => exits.push(info) },
    () => fakeChild({ done }),
  );
  t.after(async () => {
    await writeAndFinish;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(handle.logPath), { recursive: true, force: true });
  });

  // The caller returned immediately: the handle is available synchronously
  // while the child still sleeps, and onExit has not fired yet.
  assert.equal(typeof handle.researchId, "string");
  assert.deepEqual(exits, [], "onExit must not have fired while the child sleeps");

  // wait for the terminal state (real timers, real file writes)
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && exits.length === 0) {
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.deepEqual(exits, [{ status: "succeeded" }]);
  assert.equal(fs.readFileSync(findingsPath, "utf8"), "E2E OK");
  assert.ok(fs.existsSync(handle.logPath), "research log should exist on disk");
  assert.equal(handle.findingsPath, findingsPath);
});

// Seam C — ADR 0013. A runaway researcher floods its output forever; the real
// wall-clock watcher must abort it at the cap, append the slim marker, and
// resolve terminated.
test("a runaway researcher is killed by the wall-clock cap and marked (real timers)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d4-e2e-"));
  const findingsPath = path.join(dir, "findings.md");
  let aborted = false;
  const output = (async function* () {
    while (!aborted) {
      yield "x".repeat(4096);
      await new Promise((r) => setTimeout(r, 50));
    }
  })();
  const exits: ResearchExitInfo[] = [];
  const handle = runBackgroundResearch(
    {
      cwd: dir,
      task: "T",
      findingsPath,
      agents: [embeddedResearcher()],
      maxWallClockMs: 500,
      onExit: (info) => exits.push(info),
    },
    () => fakeChild({ output, abort: () => (aborted = true) }),
  );
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(handle.logPath), { recursive: true, force: true });
  });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && exits.length === 0) {
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.deepEqual(exits, [{ status: "terminated" }]);
  assert.ok(aborted, "the child must have been aborted at the cap");
  const text = fs.readFileSync(findingsPath, "utf8");
  assert.ok(text.includes("research-terminated"), "findings must carry the termination marker");
  assert.ok(text.includes("reason: wall_clock_exceeded"), "reason must be the wall clock");
  assert.match(text, /at: \d{4}-\d{2}-\d{2}T/, "the marker carries a real timestamp");
  // the teed log grew: the flood was written to the per-run log before the kill
  assert.ok(fs.statSync(handle.logPath).size > 0, "the per-run log must carry the teed output");
});

// Seam C — ADR 0013. A throwing child session resolves failed; any partial
// work already written stays on disk.
test("a throwing researcher resolves failed and preserves partial work (real timers)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d4-e2e-"));
  const findingsPath = path.join(dir, "findings.md");
  const done = (async () => {
    await new Promise((r) => setTimeout(r, 400));
    fs.writeFileSync(findingsPath, "# Partial\n\nhalf-gathered\n", "utf8");
    throw new Error("model API rejected the request");
  })();
  const exits: ResearchExitInfo[] = [];
  const handle = runBackgroundResearch(
    { cwd: dir, task: "T", findingsPath, agents: [embeddedResearcher()], onExit: (info) => exits.push(info) },
    () => fakeChild({ done }),
  );
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(handle.logPath), { recursive: true, force: true });
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && exits.length === 0) {
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.deepEqual(exits, [{ status: "failed", errorMessage: "model API rejected the request" }]);
  assert.equal(fs.readFileSync(findingsPath, "utf8"), "# Partial\n\nhalf-gathered\n", "partial work stays on disk");
  assert.ok(!fs.readFileSync(findingsPath, "utf8").includes("research-terminated"), "a failure is not a wall-clock cut");
});

// Seam C — ADR 0013. A manual abort signal resolves aborted with real timers
// and no termination marker (kill is not a cap cut).
test("a manual kill resolves aborted with no marker (real timers)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d4-e2e-"));
  const findingsPath = path.join(dir, "findings.md");
  let aborted = false;
  const exits: ResearchExitInfo[] = [];
  const controller = new AbortController();
  const handle = runBackgroundResearch(
    {
      cwd: dir,
      task: "T",
      findingsPath,
      agents: [embeddedResearcher()],
      abortSignal: controller.signal,
      onExit: (info) => exits.push(info),
    },
    () => fakeChild({ abort: () => (aborted = true) }),
  );
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(handle.logPath), { recursive: true, force: true });
  });

  // the child hangs forever; the manual kill settles it
  setTimeout(() => controller.abort(), 300);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && exits.length === 0) {
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.deepEqual(exits, [{ status: "aborted" }]);
  assert.ok(aborted, "the child must be aborted on a manual kill");
  assert.ok(!fs.existsSync(findingsPath), "no termination marker on a manual kill");
});
