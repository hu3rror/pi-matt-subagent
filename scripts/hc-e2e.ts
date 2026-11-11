/**
 * DEV-ONLY — real-core e2e for the hc carrier.
 *
 * Not part of `npm test` or CI: the `hc` binary is external and its protocol is
 * preview, so this path is checked by hand. It drives a real pi session whose
 * `subagent` tool runs a child in a herdr-core terminal, then asserts what that
 * run left behind:
 *
 *   1. prerequisites — `hc` on PATH and a reachable core; a missing piece fails
 *      with a message that names it;
 *   2. terminal — an `sa-*` terminal carrying this run's token appears on the
 *      core while the child runs. An unusable core warns and silently falls
 *      back to `spawn`, so this is what proves the hc carrier actually ran;
 *   3. read-back — the tool result in the run log carries the child's exit code
 *      and its output. A blocking run keeps no per-run log of its own: the
 *      carrier drains `pi-hc-run-<id>/stdout.jsonl` and deletes that dir when
 *      the run ends, so the driving session's JSON event stream is the durable
 *      record;
 *   4. teardown — the run's terminal is gone from `hc ls --all` once the
 *      session ends.
 *
 * Run (a working model / API key is required):
 *   node scripts/hc-e2e.ts
 *
 * Exit code 0 = every gate passed; 1 = a gate failed, a prerequisite is
 * missing, or the run itself broke. The message names which, and a failed run
 * keeps its run directory so the core side can be inspected.
 */
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const expectedAnswer = "PONG";
const token = `hc-e2e-${process.pid}-${Date.now().toString(36)}`;
const piTimeoutMs = 240_000;
const pollMs = 150;
const teardownWaitMs = 15_000;
const inheritedConfigFiles = ["settings.json", "auth.json", "models.json", "models-store.json"];

interface TerminalRow {
  address: string;
}

interface TerminalDetail {
  address: string;
  name?: string | null;
  argv?: string[];
  labels?: Record<string, string>;
}

interface ChildResult {
  exitCode?: number | null;
  stderr?: string;
}

interface ToolResult {
  content?: { type: string; text?: string }[];
  details?: { results?: ChildResult[] };
}

interface SessionEvent {
  type?: string;
  toolName?: string;
  isError?: boolean;
  result?: ToolResult;
}

function hcSync(args: string[]) {
  return spawnSync("hc", args, { encoding: "utf8" });
}

function hc(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("hc", args, { encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(new Error(`\`hc ${args.join(" ")}\` failed: ${(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
  });
}

async function hcJson<T>(args: string[]): Promise<T> {
  return JSON.parse(await hc(args)) as T;
}

async function listTerminals(): Promise<TerminalRow[]> {
  return (await hcJson<{ terminals?: TerminalRow[] }>(["ls", "--all", "--json"])).terminals ?? [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimmedTail(text: string): string {
  return text.trim().slice(-2000) || "(empty)";
}

function requireCore(): void {
  const version = hcSync(["--version"]);
  if (version.error) {
    throw new Error("missing prerequisite: the `hc` binary is not on PATH — install herdr-core, then rerun");
  }
  const list = hcSync(["ls", "--all", "--json"]);
  if (list.status !== 0) {
    const reason = (list.stderr || list.stdout || "").trim();
    throw new Error(
      `missing prerequisite: no herdr-core is reachable (\`hc ls --all --json\` failed: ${reason}) — start one with \`hc server start\`, then rerun`,
    );
  }
}

function prepareAgentDir(workDir: string): string {
  const source = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  const agentDir = fs.mkdtempSync(path.join(workDir, "agent-"));
  for (const name of inheritedConfigFiles) {
    const inherited = path.join(source, name);
    if (fs.existsSync(inherited)) fs.symlinkSync(inherited, path.join(agentDir, name));
  }
  if (!fs.existsSync(path.join(agentDir, "settings.json"))) {
    throw new Error(
      `missing prerequisite: ${path.join(source, "settings.json")} — the driving pi session needs the model and provider config it inherits`,
    );
  }
  fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "extensions", "matt-subagent.json"), `${JSON.stringify({ carrier: "hc" })}\n`);
  return agentDir;
}

function parseEvents(runLogPath: string, runLog: string): SessionEvent[] {
  const events: SessionEvent[] = [];
  const lines = runLog.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as SessionEvent);
    } catch (err) {
      throw new Error(`the run log ${runLogPath} line ${index + 1} is not JSON: ${(err as Error).message}`);
    }
  }
  return events;
}

function resultText(result: ToolResult | undefined): string {
  return (result?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

async function main(): Promise<void> {
  console.log("hc-e2e: manual dev gate for the hc carrier (never runs in CI)");
  requireCore();

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "hc-e2e-"));
  const runLogPath = path.join(workDir, "pi-run.jsonl");
  let passed = false;
  let agentDir: string | null = null;
  let pi: ChildProcess | null = null;
  let runTerminal: TerminalDetail | null = null;
  let teardownGateFailed = false;
  try {
    agentDir = prepareAgentDir(workDir);
    const knownAddresses = new Set((await listTerminals()).map((terminal) => terminal.address));
    const probedAddresses = new Set<string>();
    let terminalReadError = "";
    const prompt =
      `Call the subagent tool now, exactly once. Use agent = "fact-finder" and task = ` +
      `"${token} Reply with exactly the single word ${expectedAnswer} and nothing else. Do not read files and do not run commands." ` +
      `After the subagent tool returns, reply with exactly: done.`;

    let stdout = "";
    let stderr = "";
    const piProcess = spawn(
      "pi",
      ["--mode", "json", "-p", "--no-session", "--no-extensions", "-e", "extensions/subagent.ts", prompt],
      { cwd: repoRoot, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdio: ["ignore", "pipe", "pipe"] },
    );
    pi = piProcess;
    piProcess.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    piProcess.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-8000)));
    const exited = new Promise<number | null>((resolve, reject) => {
      piProcess.on("error", (err: NodeJS.ErrnoException) => {
        const missing = err.code === "ENOENT";
        reject(
          new Error(
            missing
              ? "missing prerequisite: the `pi` binary is not on PATH — install pi, then rerun"
              : `could not run pi (${err.message})`,
          ),
        );
      });
      piProcess.on("close", (code) => resolve(code));
    });

    const deadline = Date.now() + piTimeoutMs;
    let piExit: number | null | undefined;
    while (piExit === undefined) {
      piExit = await Promise.race([exited, sleep(pollMs).then(() => undefined)]);
      if (piExit !== undefined) break;
      if (Date.now() > deadline) {
        piProcess.kill("SIGKILL");
        throw new Error(`the driving pi session did not end within ${piTimeoutMs}ms; stderr tail: ${trimmedTail(stderr)}`);
      }
      for (const terminal of await listTerminals()) {
        if (knownAddresses.has(terminal.address) || probedAddresses.has(terminal.address)) continue;
        const detail = await hcJson<TerminalDetail>(["get", terminal.address, "--json"]).catch((err: Error) => {
          terminalReadError = err.message;
          return null;
        });
        if (!detail) continue;
        probedAddresses.add(terminal.address);
        if (!(detail.argv ?? []).some((arg) => arg.includes(token))) continue;
        runTerminal = detail;
      }
    }

    fs.writeFileSync(runLogPath, stdout);
    console.log(`pi exit=${piExit} run log=${runLogPath}`);
    if (piExit !== 0) {
      throw new Error(`the driving pi session exited ${piExit}; stderr tail: ${trimmedTail(stderr)}`);
    }

    if (!runTerminal) {
      const readError = terminalReadError ? `; last terminal read failed: ${terminalReadError}` : "";
      throw new Error(
        `no terminal on the core carried this run's token — the run fell back to the spawn carrier; stderr tail: ${trimmedTail(stderr)}${readError}`,
      );
    }
    const terminalName = runTerminal.name ?? "";
    const terminalLabels = runTerminal.labels ?? {};
    if (!/^sa-/.test(terminalName)) {
      throw new Error(`the run's terminal is named ${JSON.stringify(runTerminal.name)}; expected the sa-* name the carrier assigns`);
    }
    if (terminalLabels.kind !== "blocking") {
      throw new Error(`the run's terminal carries kind=${terminalLabels.kind ?? "(unlabelled)"}; expected kind=blocking`);
    }
    console.log(`HC-E2E OK: the run executed in terminal ${runTerminal.address} (${terminalName}, kind=blocking)`);

    const event = parseEvents(runLogPath, stdout)
      .filter((candidate) => candidate.type === "tool_execution_end" && candidate.toolName === "subagent")
      .at(-1);
    if (!event) throw new Error(`the run log carries no subagent tool result: ${runLogPath}`);
    if (event.isError) {
      throw new Error(`the subagent tool returned an error: ${JSON.stringify(resultText(event.result).slice(0, 500))}`);
    }
    const child = event.result?.details?.results?.[0];
    if (!child) throw new Error(`the subagent tool result carries no child result: ${JSON.stringify(event.result?.details)}`);
    if (child.exitCode !== 0) {
      throw new Error(
        `the child exit code read back from the run log is ${child.exitCode}; expected 0. Child stderr: ${trimmedTail(child.stderr ?? "")}`,
      );
    }
    const text = resultText(event.result);
    if (!text.includes(expectedAnswer)) {
      throw new Error(`the child output read back from the run log lacks ${expectedAnswer}: ${JSON.stringify(text.slice(0, 500))}`);
    }
    console.log(`HC-E2E OK: the run log carries child exit code 0 and the child output (${expectedAnswer})`);

    const teardownDeadline = Date.now() + teardownWaitMs;
    for (;;) {
      const listed = (await listTerminals()).some((terminal) => terminal.address === runTerminal?.address);
      if (!listed) break;
      if (Date.now() > teardownDeadline) {
        teardownGateFailed = true;
        throw new Error(
          `terminal ${runTerminal.address} (${terminalName}) is still listed by \`hc ls --all\` ${teardownWaitMs}ms after the session ended — the session-shutdown teardown did not remove it`,
        );
      }
      await sleep(pollMs);
    }
    console.log(`HC-E2E OK: the session-shutdown teardown removed terminal ${runTerminal.address} (${terminalName})`);
    passed = true;
  } finally {
    if (pi && pi.exitCode === null && pi.signalCode === null) pi.kill("SIGKILL");
    if (!passed && runTerminal && !teardownGateFailed) {
      hcSync(["kill", runTerminal.address]);
      const removal = hcSync(["rm", runTerminal.address]);
      const reason = (removal.stderr || removal.stdout || "").trim();
      console.log(
        removal.status === 0
          ? `removed leftover terminal ${runTerminal.address}`
          : `leftover terminal ${runTerminal.address} could not be removed: ${reason}`,
      );
    }
    if (agentDir) fs.rmSync(agentDir, { recursive: true, force: true });
    if (passed) fs.rmSync(workDir, { recursive: true, force: true });
    else if (fs.existsSync(runLogPath)) console.log(`run log kept at ${runLogPath}`);
  }
}

await main().then(
  () => console.log("HC-E2E PASSED"),
  (err: Error) => {
    console.error(`HC-E2E FAIL: ${err.message}`);
    process.exitCode = 1;
  },
);
