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
import { runBackgroundResearch, researchChildToolNames, type CreateChildSession, type ResearchExitInfo } from "./lib.ts";
import { embeddedResearcher, fakeChild } from "./test-helpers.ts";

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

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && exits.length === 0) {
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.deepEqual(exits, [{ status: "succeeded" }]);
  assert.equal(fs.readFileSync(findingsPath, "utf8"), "E2E OK");
  assert.ok(fs.existsSync(handle.logPath), "research log should exist on disk");
  assert.equal(handle.findingsPath, findingsPath);
});

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

test("the allowlist handed to the research child keeps built-in names shadowed in the parent registry (issue #43)", async (t) => {
  // The fixed probe's output for a main-session registry where read/grep
  // come from a shadowing package and an empty knob: built-ins ∪ nothing, so
  // the shadowed names stay available to the child, which does not load the
  // shadowing extension.
  const available = researchChildToolNames({
    builtinNames: new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]),
    registryTools: [
      { name: "read", sourcePath: "/n/node_modules/hashline-tools/read.ts" },
      { name: "grep", sourcePath: "/n/node_modules/hashline-tools/grep.ts" },
    ],
    knob: [],
    platform: process.platform,
  }).names;
  assert.ok(available.has("read"));
  assert.ok(available.has("grep"));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2-e2e-"));
  const findingsPath = path.join(dir, "findings.md");
  let childOpts: Parameters<CreateChildSession>[0] | undefined;
  const done = new Promise<void>((resolve) => setTimeout(resolve, 400));
  const exits: ResearchExitInfo[] = [];
  const handle = runBackgroundResearch(
    {
      cwd: dir,
      task: "T",
      findingsPath,
      agents: [embeddedResearcher()],
      tools: ["read", "grep", "find", "ls", "bash", "write"],
      availableToolNames: available,
      onExit: (info) => exits.push(info),
    },
    (opts) => {
      childOpts = opts;
      return fakeChild({ done });
    },
  );
  t.after(async () => {
    await done;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(handle.logPath), { recursive: true, force: true });
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && exits.length === 0) {
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.deepEqual(exits, [{ status: "succeeded" }]);

  assert.ok(childOpts, "the child was created with the resolved allowlist");
  assert.ok(childOpts!.tools!.includes("read"), "the child's allowlist keeps the shadowed built-in read");
  assert.ok(childOpts!.tools!.includes("grep"), "the child's allowlist keeps the shadowed built-in grep");
  assert.ok(
    childOpts!.systemPrompt.includes("Available tools (the only tools you can call): read, grep, find, ls, bash, write"),
    "the prompt's tool line lists the shadowed built-ins",
  );
  const logText = fs.readFileSync(handle.logPath, "utf8");
  assert.ok(!logText.includes("[research-drift]"), "no drift line when the shadowed built-ins resolve");
});

// Issue #44 — activation follows load. The allowlist the runner hands the
// child is the resolved declared tools UNIONED with the loaded knob packages'
// tools, unless the caller passed an explicit list (then that list is exactly
// the allowlist). These four cases pin the exact childOpts.tools.
const BUILT_INS = new Set(["read", "grep", "find", "ls", "bash", "write"]);

async function runWithCapture(
  opts: Omit<Parameters<typeof runBackgroundResearch>[0], "cwd" | "findingsPath">,
): Promise<{ childOpts: Parameters<CreateChildSession>[0]; logText: string; tmpDir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "allowlist-e2e-"));
  const findingsPath = path.join(dir, "findings.md");
  const done = new Promise<void>((resolve) => setTimeout(resolve, 100));
  let childOpts: Parameters<CreateChildSession>[0] | undefined;
  const handle = runBackgroundResearch(
    { cwd: dir, findingsPath, ...opts },
    (o) => {
      childOpts = o;
      return fakeChild({ done });
    },
  );
  await done;
  return { childOpts: childOpts!, logText: fs.readFileSync(handle.logPath, "utf8"), tmpDir: dir };
}

test("case 1: role tools only reach the child when nothing is configured or activated", async (t) => {
  const { childOpts, logText, tmpDir } = await runWithCapture({
    task: "T",
    agents: [embeddedResearcher()],
    availableToolNames: BUILT_INS,
  });
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  assert.deepEqual(childOpts.tools, ["read", "grep", "find", "ls", "bash", "write"]);
  assert.ok(
    childOpts.systemPrompt.includes("Available tools (the only tools you can call): read, grep, find, ls, bash, write"),
    "the prompt lists exactly the child's tools",
  );
  assert.ok(!logText.includes("[research-drift]"), "nothing declared dropped");
});

test("case 2: the loaded knob packages' tools join the allowlist without a role declaration", async (t) => {
  const { childOpts, logText, tmpDir } = await runWithCapture({
    task: "T",
    agents: [embeddedResearcher()],
    availableToolNames: new Set([...BUILT_INS, "web_access", "query-docs"]),
    packageTools: ["web_access", "query-docs"],
  });
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  assert.deepEqual(childOpts.tools, ["read", "grep", "find", "ls", "bash", "write", "web_access", "query-docs"]);
  assert.ok(
    childOpts.systemPrompt.includes("read, grep, find, ls, bash, write, web_access, query-docs"),
    "the prompt lists the activated package tools too",
  );
  assert.ok(!logText.includes("[research-drift]"));
});

test("case 3: an explicit tools list is authoritative — no package tools are added", async (t) => {
  const { childOpts, logText, tmpDir } = await runWithCapture({
    task: "T",
    agents: [embeddedResearcher()],
    tools: ["read", "grep"],
    availableToolNames: new Set([...BUILT_INS, "web_access"]),
    packageTools: ["web_access"],
  });
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  assert.deepEqual(childOpts.tools, ["read", "grep"], "the caller's list means exactly that list");
  assert.ok(
    childOpts.systemPrompt.includes("Available tools (the only tools you can call): read, grep"),
    "the prompt lists only the authoritative list",
  );
  assert.ok(!logText.includes("[research-drift]"));
});

test("case 4: an empty knob hands the child built-ins only, with no drift", async (t) => {
  const { childOpts, logText, tmpDir } = await runWithCapture({
    task: "T",
    agents: [embeddedResearcher()],
    extensions: [],
    packageTools: [],
    availableToolNames: BUILT_INS,
  });
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  assert.deepEqual(childOpts.tools, ["read", "grep", "find", "ls", "bash", "write"]);
  assert.ok(!logText.includes("[research-drift]"), "the quiet default carries no drift");
});
