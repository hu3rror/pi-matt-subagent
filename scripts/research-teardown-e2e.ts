/**
 * DEV-ONLY — real-pi gate for the research teardown terminal status.
 *
 * Why a real-pi gate instead of a unit test: the false-`succeeded` defect lives
 * in pi's runtime semantics — `AgentSession.dispose()` resolves the in-flight
 * `session.prompt()` — plus the extension's `session_shutdown` wiring. Neither
 * is observable through the runner's fake-child seam (`src/research-e2e.test.ts`),
 * and the extension's per-run abort controllers are closure-internal. This gate
 * runs a one-shot pi session that starts a research run and then exits, and
 * asserts the run log's terminal status is honest: a disposed child that did no
 * work (no findings written) must never settle a false `succeeded`.
 *
 * Run (a working model / API key is required):
 *   node scripts/research-teardown-e2e.ts
 *
 * Exit code 0 = gate passed; 1 = the gate failed (an infrastructure error, or a
 * dishonest teardown terminal status). The session dir, the findings file, and
 * every research tmpdir this run created are removed afterwards on all paths.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmpDir = os.tmpdir();
const findingsPath = path.join(tmpDir, "research-teardown-e2e-findings.md");
const sessionDir = fs.mkdtempSync(path.join(tmpDir, "research-teardown-e2e-session-"));
const prompt =
  "Call the research tool now. Use exactly: task = 'Write the single word OK to the " +
  `${findingsPath}', findingsPath = '${findingsPath}'. After the research tool returns, reply with exactly: started.`;

const researchDirsBefore = new Set(fs.readdirSync(tmpDir).filter((n) => n.startsWith("pi-research-")));
const createdRunDirs = () =>
  fs
    .readdirSync(tmpDir)
    .filter((n) => n.startsWith("pi-research-") && !researchDirsBefore.has(n))
    .map((n) => path.join(tmpDir, n));

try {
  fs.rmSync(findingsPath, { force: true });
  const run = spawnSync(
    "pi",
    ["-p", "--session-dir", sessionDir, "--no-extensions", "-e", "extensions/subagent.ts", prompt],
    { cwd: repoRoot, encoding: "utf8", timeout: 240_000 },
  );
  if (run.error) {
    throw new Error(`could not run pi (${run.error.message}); partial output: ${JSON.stringify((run.stdout ?? "").slice(-500))}`);
  }

  const runDirs = createdRunDirs();
  if (runDirs.length !== 1) {
    throw new Error(`expected one research run tmpdir, found ${runDirs.length}: ${runDirs.join(", ") || "(none)"}`);
  }
  const runDir = runDirs[0];
  const logPath = path.join(runDir, "research.log");
  const log = fs.readFileSync(logPath, "utf8");
  const terminal = log
    .split("\n")
    .map((line) => /^\[run\] \d{2}:\d{2}:\d{2} terminal · (.+)$/.exec(line)?.[1])
    .filter((status): status is string => status !== undefined);

  const toolCalls = fs.existsSync(path.join(runDir, "toolcalls.jsonl"))
    ? fs.statSync(path.join(runDir, "toolcalls.jsonl")).size
    : -1;
  const findings = fs.existsSync(findingsPath);

  console.log(`pi exit=${run.status} signal=${run.signal ?? "(none)"}`);
  console.log(`research log: ${logPath}`);
  console.log(`terminal lines: ${terminal.length ? terminal.join(", ") : "(none)"}`);
  console.log(`toolcalls.jsonl bytes: ${toolCalls}; findings written: ${findings}`);

  if (terminal.length !== 1) throw new Error(`expected exactly one terminal line, got ${terminal.length}`);
  // The honesty invariant: a teardown-disposed child that did no work (no
  // findings written) must never resolve `succeeded`. A child that genuinely
  // finished before the session ended may settle succeeded — findings on disk
  // are the evidence of real completion.
  if (terminal[0] === "succeeded" && !findings) {
    throw new Error(`teardown settled the run "succeeded" with no findings file — a disposed child that did no work must not resolve succeeded`);
  }
  console.log(`TEARDOWN-E2E OK: teardown terminal status is honest (${terminal[0]})`);
} catch (err) {
  console.error(`TEARDOWN-E2E FAIL: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(sessionDir, { recursive: true, force: true });
  fs.rmSync(findingsPath, { force: true });
  for (const dir of createdRunDirs()) fs.rmSync(dir, { recursive: true, force: true });
}
