// Seam C — end-to-end background semantics with a REAL detached spawn.
// Proves the ADR 0001 contract without invoking the pi CLI or a model:
//   the caller returns immediately (does not wait for the subprocess), and
//   the subprocess runs to completion in the background and writes findings.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { runBackgroundResearch, RESEARCH_BUDGETS, type AgentConfig } from "./lib.ts";

test("background research writes findings without blocking the caller (real detached spawn)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2-e2e-"));
  const findingsPath = path.join(dir, "findings.md");
  const script = [
    "const fs = require('node:fs');",
    "const fp = process.argv[1];",
    "setTimeout(() => fs.writeFileSync(fp, 'E2E OK', 'utf8'), 1000);",
  ].join(" ");
  const agents: AgentConfig[] = [{ name: "researcher", description: "", source: "embedded", systemPrompt: "SP" }];

  const start = Date.now();
  const handle = runBackgroundResearch(
    { cwd: dir, task: "T", findingsPath, agents },
    // swap the (unused) pi invocation for a plain node script that writes findings
    (_cmd, _args, opts) => spawn(process.execPath, ["-e", script, findingsPath], opts),
  );
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(handle.logPath), { recursive: true, force: true }); // the pi-research-* tmp dir
  });
  const returnedMs = Date.now() - start;
  assert.ok(returnedMs < 800, `caller blocked for ${returnedMs}ms while the subprocess sleeps 1000ms`);

  // poll for the findings file; the detached subprocess must write it eventually
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(findingsPath)) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.equal(fs.readFileSync(findingsPath, "utf8"), "E2E OK");
  assert.ok(fs.existsSync(handle.logPath), "research log should exist on disk");
  assert.equal(handle.findingsPath, findingsPath);
});

// Seam C — D4. A runaway researcher is a detached child that floods the log
// beyond maxLogBytes; the watcher (with DEFAULT deps: real setInterval/stat)
// must kill it and append the termination marker.
test("a runaway researcher hitting the log cap is killed and marked (real detached spawn)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d4-e2e-"));
  const findingsPath = path.join(dir, "findings.md");
  // loop forever, writing ~64 KiB to stdout every 100ms: the redirected stdout
  // becomes the research log, which grows past maxLogBytes quickly
  const script = [
    "let buf='x'.repeat(65536);",
    "process.stdout.write(buf);",
    "setInterval(() => process.stdout.write(buf), 100);",
  ].join(" ");
  const agents: AgentConfig[] = [{ name: "researcher", description: "", source: "embedded", systemPrompt: "SP" }];
  const budget = { ...RESEARCH_BUDGETS.standard, maxLogBytes: 128 * 1024, maxWallClockMs: 60_000 };

  const handle = runBackgroundResearch(
    { cwd: dir, task: "T", findingsPath, agents, budget },
    // swap the pi invocation for a plain node process that floods its stdout
    (_cmd, _args, opts) => spawn(process.execPath, ["-e", script, findingsPath], opts),
  );
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(handle.logPath), { recursive: true, force: true });
  });

  // the child never writes findings; the watcher must create the file with the
  // termination marker within the watch interval
  const deadline = Date.now() + 15_000;
  let text = "";
  while (Date.now() < deadline) {
    if (fs.existsSync(findingsPath)) {
      text = fs.readFileSync(findingsPath, "utf8");
      if (text.includes("research-terminated")) break;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(text.includes("research-terminated"), "findings must carry the termination marker");
  assert.ok(text.includes("reason: log_bytes_exceeded"), "reason must say which cap was exceeded");
  assert.ok(text.includes("partial: true"));
  assert.ok(text.includes("limit: 128 KiB"));
  // observed is whatever the flood reached before the kill; require the shape
  assert.match(text, /observed: \d+(\.\d+)? (KiB|MiB)/);
  // the log tail carries the human-readable kill reason (ADR 0003)
  const logText = fs.readFileSync(handle.logPath, "utf8");
  assert.ok(logText.includes("[research-budget] killed: log exceeded"), "kill reason must be in the log tail");
});

// Seam C — D4. A researcher that neither writes findings nor exits is killed
// by the wall-clock cap alone.
test("a sleeping researcher is killed by the wall-clock cap and marked (real detached spawn)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d4-e2e-"));
  const findingsPath = path.join(dir, "findings.md");
  // run forever without writing anything
  const script = "setInterval(() => {}, 1000);";
  const agents: AgentConfig[] = [{ name: "researcher", description: "", source: "embedded", systemPrompt: "SP" }];
  const budget = { ...RESEARCH_BUDGETS.standard, maxLogBytes: 64 * 1024 * 1024, maxWallClockMs: 2000 };

  const handle = runBackgroundResearch(
    { cwd: dir, task: "T", findingsPath, agents, budget, graceMs: 1000 },
    (_cmd, _args, opts) => spawn(process.execPath, ["-e", script], opts),
  );
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(handle.logPath), { recursive: true, force: true });
  });

  // the watcher ticks every 2s: at ~2s it issues the final notice (100%), and
  // kills at the grace deadline (~4s with graceMs 1000)
  const deadline = Date.now() + 15_000;
  let text = "";
  while (Date.now() < deadline) {
    if (fs.existsSync(findingsPath)) {
      text = fs.readFileSync(findingsPath, "utf8");
      if (text.includes("research-terminated")) break;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(text.includes("research-terminated"), "findings must carry the termination marker");
  assert.ok(text.includes("reason: wall_clock_exceeded"), "reason must say which cap was exceeded");
  assert.ok(text.includes("partial: true"));
  assert.match(text, /limit: 2 s/);
  assert.match(text, /observed: \d+(\.\d+)? s/);
  const logText = fs.readFileSync(handle.logPath, "utf8");
  assert.ok(logText.includes("[research-budget] killed: wall clock exceeded"), "kill reason must be in the log tail");
});

// Seam C — D3. The watcher's onExit callback fires for a real detached child
// that exits on its own (natural path) AND for one killed by a hard cap
// (kill path, marker already on disk). Earlier unit tests cover the wiring;
// this proves it end-to-end with a real spawn.
test("background watcher reports onExit for a naturally-exiting child (real detached spawn)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d3-e2e-"));
  const findingsPath = path.join(dir, "findings.md");
  const script = "const fs=require('node:fs');setTimeout(()=>fs.writeFileSync(process.argv[1],'E2E OK','utf8'),200);";
  const agents: AgentConfig[] = [{ name: "researcher", description: "", source: "embedded", systemPrompt: "SP" }];

  let exitInfo: { killed: boolean; exitCode: number | null } | undefined;
  const handle = runBackgroundResearch(
    {
      cwd: dir,
      task: "T",
      findingsPath,
      agents,
      budget: { ...RESEARCH_BUDGETS.standard, maxLogBytes: 64 * 1024 * 1024, maxWallClockMs: 60_000 },
      onExit: (info) => {
        exitInfo = info;
      },
    },
    (_cmd, _args, opts) => spawn(process.execPath, ["-e", script, findingsPath], opts),
  );
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(handle.logPath), { recursive: true, force: true });
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !exitInfo) {
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(exitInfo, "onExit must fire when the detached child exits");
  assert.equal(exitInfo!.killed, false);
  assert.equal(exitInfo!.exitCode, 0);
  assert.equal(fs.readFileSync(findingsPath, "utf8"), "E2E OK");
});

test("background watcher reports onExit with killed:true after a hard-cap kill (real detached spawn)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d3-e2e-"));
  const findingsPath = path.join(dir, "findings.md");
  const script = "setInterval(()=>process.stdout.write('x'.repeat(65536)),100);";
  const agents: AgentConfig[] = [{ name: "researcher", description: "", source: "embedded", systemPrompt: "SP" }];
  const budget = { ...RESEARCH_BUDGETS.standard, maxLogBytes: 128 * 1024, maxWallClockMs: 60_000 };

  let exitInfo: { killed: boolean; exitCode: number | null } | undefined;
  let markerSeenAtCallback = false;
  const handle = runBackgroundResearch(
    {
      cwd: dir,
      task: "T",
      findingsPath,
      agents,
      budget,
      onExit: (info) => {
        exitInfo = info;
        if (fs.existsSync(findingsPath)) {
          markerSeenAtCallback = fs.readFileSync(findingsPath, "utf8").includes("research-terminated");
        }
      },
    },
    (_cmd, _args, opts) => spawn(process.execPath, ["-e", script], opts),
  );
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(handle.logPath), { recursive: true, force: true });
  });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !exitInfo) {
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(exitInfo, "onExit must fire when the watcher kills the child");
  assert.equal(exitInfo!.killed, true);
  assert.ok(markerSeenAtCallback, "termination marker must be on disk before onExit fires");
  const text = fs.readFileSync(findingsPath, "utf8");
  assert.ok(text.includes("research-terminated"));
});