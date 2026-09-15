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
import { runBackgroundResearch, type AgentConfig } from "./lib.ts";

test("background research writes findings without blocking the caller (real detached spawn)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2-e2e-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
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

  fs.rmSync(dir, { recursive: true, force: true });
});