import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { HcClient, HcResult } from "./hc-client.ts";
import {
  runBackgroundResearch,
  type CreateChildSession,
  type ResearchChildSession,
  type ResearchExitInfo,
} from "./lib.ts";
import { embeddedResearcher, fakeChild, fakeHcClient } from "./test-helpers.ts";
import { createHcResearchChildSession, createResearchChildFactory } from "./research-carrier.ts";

interface RecordedCall {
  readonly method: string;
  readonly params: unknown;
}

/**
 * Runs the argv `terminal.run` hands it, so the redirection script the stream
 * tails is the real thing, and answers `ended: false` while the child lives.
 */
function runningCore(): HcClient & { readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const terminals = new Map<string, { child: ReturnType<typeof spawn>; done: Promise<number> }>();
  let seq = 0;
  return {
    calls,
    call: async (method: string, params: unknown): Promise<HcResult> => {
      calls.push({ method, params });
      if (method === "terminal.run") {
        const run = params as { argv: string[]; cwd: string };
        const address = `t${++seq}`;
        const child = spawn(run.argv[0], run.argv.slice(1), { cwd: run.cwd, stdio: ["ignore", "pipe", "pipe"] });
        child.stdout?.resume();
        child.stderr?.resume();
        const done = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 0)));
        terminals.set(address, { child, done });
        return { ok: true, result: { address } };
      }
      if (method === "terminal.wait") {
        const { terminal } = params as { terminal: string };
        const record = terminals.get(terminal);
        if (!record) return { ok: false, failure: "protocol", message: "no such terminal" };
        const ended = record.done.then((exitCode) => ({ ended: true, exit_code: exitCode }));
        const tick = new Promise<{ ended: false }>((resolve) => setTimeout(() => resolve({ ended: false }), 5));
        return { ok: true, result: await Promise.race([ended, tick]) };
      }
      if (method === "terminal.kill") {
        const { terminal } = params as { terminal: string };
        terminals.get(terminal)?.child.kill("SIGKILL");
        return { ok: true, result: {} };
      }
      return { ok: true, result: undefined };
    },
    capabilities: () => undefined,
    dispose: async () => {},
  };
}

function researchDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-research-hc-"));
}

function childOpts(logPath: string): Parameters<CreateChildSession>[0] {
  return {
    cwd: process.cwd(),
    extensions: [],
    tools: ["read", "grep"],
    systemPrompt: "You are a researcher.",
    task: "dig into the carrier",
    findingsPath: path.join(logPath, "..", "findings.md"),
    logPath,
    runId: "run-1234abcd",
  };
}

function scriptInvocation(script: string): () => { command: string; args: string[] } {
  return () => ({ command: process.execPath, args: ["-e", script] });
}

async function drain(session: ResearchChildSession): Promise<string> {
  let text = "";
  for await (const chunk of session.output) text += chunk;
  return text;
}

test("runs the research child in a labelled terminal and streams its file output", async (t) => {
  const dir = researchDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logPath = path.join(dir, "research.log");
  const core = runningCore();
  const seenArgs: string[] = [];
  const session = createHcResearchChildSession(childOpts(logPath), {
    client: core,
    invocation: (args) => {
      seenArgs.push(...args);
      return {
        command: process.execPath,
        args: ["-e", 'process.stdout.write("first\\n"); setTimeout(() => process.exit(0), 20);'],
      };
    },
    sh: "/bin/sh",
  });

  const [output, exited] = await Promise.all([drain(session), session.done]);

  assert.equal(exited, undefined, "a zero exit resolves done");
  assert.equal(output, "first\n", "the stream carries what the terminal wrote to the file");

  const run = core.calls.find((c) => c.method === "terminal.run")?.params as {
    name: string;
    labels: Record<string, string>;
    argv: string[];
  };
  assert.equal(run.name, "sa-run-1234", "the terminal carries the run's identity");
  assert.deepEqual(run.labels, { run: "run-1234abcd", kind: "research", role: "researcher" });
  assert.equal(run.argv[0], "/bin/sh");
  assert.deepEqual(seenArgs, [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-extensions",
    "--tools",
    "read,grep",
    "--append-system-prompt",
    path.join(dir, "system-prompt.md"),
    "Task: dig into the carrier",
  ]);
  assert.equal(
    fs.readFileSync(path.join(dir, "system-prompt.md"), "utf8"),
    "You are a researcher.",
    "the prompt file sits beside the run log",
  );
});

test("audits tool calls from the child's event stream and passes the extension loadout", async (t) => {
  const dir = researchDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const seenArgs: string[] = [];
  const calls: unknown[] = [];
  const session = createHcResearchChildSession(
    {
      ...childOpts(path.join(dir, "research.log")),
      extensions: ["@scope/pkg"],
      onToolCall: (call) => calls.push(call),
    },
    {
      client: runningCore(),
      sh: "/bin/sh",
      invocation: (args) => {
        seenArgs.push(...args);
        return {
          command: process.execPath,
          args: [
            "-e",
            'process.stdout.write(JSON.stringify({type:"tool_execution_start",toolCallId:"c1",toolName:"read",args:{path:"x"}})+"\\n");',
          ],
        };
      },
    },
  );

  await Promise.all([drain(session), session.done]);

  assert.deepEqual(calls, [{ toolCallId: "c1", toolName: "read", args: { path: "x" } }], "the audit sees every tool start");
  assert.deepEqual(seenArgs.slice(4, 6), ["--extension", "@scope/pkg"], "the knob's packages load into the child");
});

test("rejects done on a non-zero exit after flushing the trailing output", async (t) => {
  const dir = researchDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const session = createHcResearchChildSession(childOpts(path.join(dir, "research.log")), {
    client: runningCore(),
    invocation: scriptInvocation('process.stdout.write("half a run\\n"); process.exit(3);'),
    sh: "/bin/sh",
  });

  const [output, failure] = await Promise.all([drain(session), session.done.then(() => undefined, (err: Error) => err)]);

  assert.equal(output, "half a run\n", "every byte lands in the stream before it ends");
  assert.match(String(failure), /exited with code 3/);
});

test("abort kills the terminal and ends the stream", async (t) => {
  const dir = researchDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const core = runningCore();
  const session = createHcResearchChildSession(childOpts(path.join(dir, "research.log")), {
    client: core,
    invocation: scriptInvocation('process.stdout.write("working\\n"); setTimeout(() => process.exit(0), 5000);'),
    sh: "/bin/sh",
  });

  const drained = drain(session);
  const outFile = path.join(dir, "research.log.terminal.out");
  while (!fs.existsSync(outFile) || fs.statSync(outFile).size === 0) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 20));
  session.abort();

  const [output, exited] = await Promise.all([drained, session.done]);
  assert.equal(exited, undefined, "a killed run settles without rejecting");
  assert.match(output, /working/, "output produced before the kill still reaches the stream");
  const killed = core.calls.filter((c) => c.method === "terminal.kill");
  assert.equal(killed.length, 1, "the terminal is killed exactly once");
  assert.equal((killed[0]?.params as { terminal: string }).terminal, "t1");
});

test("a terminal that never started rejects done with the core's reason", async (t) => {
  const dir = researchDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = fakeHcClient({ result: { ok: false, failure: "unavailable", message: "no core" } });
  const session = createHcResearchChildSession(childOpts(path.join(dir, "research.log")), {
    client,
    invocation: scriptInvocation(""),
    sh: "/bin/sh",
  });

  const [output, failure] = await Promise.all([drain(session), session.done.then(() => undefined, (err: Error) => err)]);

  assert.equal(output, "");
  assert.match(String(failure), /could not start \(unavailable: no core\)/);
});

test("the session teardown learns the terminal address as soon as the child starts", async (t) => {
  const dir = researchDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tracked: string[] = [];
  const session = createHcResearchChildSession(childOpts(path.join(dir, "research.log")), {
    client: runningCore(),
    invocation: scriptInvocation('process.stdout.write("working\\n"); setTimeout(() => process.exit(0), 5000);'),
    sh: "/bin/sh",
    onStarted: (terminal) => tracked.push(terminal),
  });

  const drained = drain(session);
  const outFile = path.join(dir, "research.log.terminal.out");
  while (!fs.existsSync(outFile) || fs.statSync(outFile).size === 0) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(tracked, ["t1"], "the address is recorded before the child has to be waited on");

  session.abort();
  await drained;
});

test("the carrier factory hands each hc terminal to the session teardown", async (t) => {
  const dir = researchDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tracked: string[] = [];
  const core: HcClient = {
    call: async (method) => {
      if (method === "terminal.run") return { ok: true, result: { address: "t9" } };
      if (method === "terminal.wait") return { ok: true, result: { ended: true, exit_code: 0 } };
      if (method === "terminal.kill") return { ok: true, result: { address: "t9" } };
      return { ok: true, result: undefined };
    },
    capabilities: () => undefined,
    dispose: async () => {},
  };
  const factory = createResearchChildFactory({
    carrier: "hc",
    client: () => core,
    inProcess: () => fakeChild(),
    findShell: () => "/bin/sh",
    onStarted: (terminal) => tracked.push(terminal),
  });

  const session = factory(childOpts(path.join(dir, "research.log")));
  await drain(session);
  await session.done;

  assert.deepEqual(tracked, ["t9"]);
});

test("the carrier factory falls back to the in-process child when no POSIX shell exists", (t) => {
  const dir = researchDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = fakeHcClient();
  const seen: string[] = [];
  const inProcess: CreateChildSession = () => {
    seen.push("in-process");
    return fakeChild();
  };

  const factory = createResearchChildFactory({
    carrier: "hc",
    client: () => client,
    inProcess,
    findShell: () => undefined,
    onWarn: (message) => seen.push(message),
  });
  const session = factory(childOpts(path.join(dir, "research.log")));

  assert.equal(session.done instanceof Promise, true);
  assert.deepEqual(seen, [
    "carrier hc: no sh on PATH, so a research terminal cannot start; falling back to the in-process child for this run.",
    "in-process",
  ]);
});

test("the carrier factory keeps the in-process child for the spawn carrier", (t) => {
  const dir = researchDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = fakeHcClient();
  let calls = 0;
  const factory = createResearchChildFactory({
    carrier: "spawn",
    client: () => client,
    inProcess: () => {
      calls += 1;
      return fakeChild();
    },
    findShell: () => "/bin/sh",
  });

  factory(childOpts(path.join(dir, "research.log")));

  assert.equal(calls, 1);
  assert.equal(client.calls.length, 0, "the spawn carrier never reaches for the core");
});

test("done settles without waiting for the consumer, keeping every byte", async (t) => {
  const dir = researchDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const session = createHcResearchChildSession(childOpts(path.join(dir, "research.log")), {
    client: runningCore(),
    invocation: scriptInvocation('process.stdout.write("kept\\n");'),
    sh: "/bin/sh",
  });

  await session.done;
  assert.equal(await drain(session), "kept\n", "the stream still carries everything after done settled");
});

test("an aborted hc research run settles aborted, never succeeded", async (t) => {
  const dir = researchDir();
  const abort = new AbortController();
  const core = runningCore();
  let logPath = "";
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (logPath) fs.rmSync(path.dirname(logPath), { recursive: true, force: true });
  });

  const exited = new Promise<ResearchExitInfo>((resolve) => {
    const handle = runBackgroundResearch(
      {
        cwd: dir,
        findingsPath: path.join(dir, "findings.md"),
        task: "dig into the carrier",
        agents: [embeddedResearcher()],
        runId: "run-abcd1234",
        abortSignal: abort.signal,
        onExit: resolve,
      },
      (opts) =>
        createHcResearchChildSession(opts, {
          client: core,
          sh: "/bin/sh",
          invocation: scriptInvocation('process.stdout.write("working\\n"); setTimeout(() => process.exit(0), 5000);'),
        }),
    );
    // The handle allocates the log path synchronously; onExit fires much later.
    logPath = handle.logPath;
  });

  while (!core.calls.some((c) => c.method === "terminal.wait")) await new Promise((r) => setTimeout(r, 5));
  abort.abort();

  const info = await exited;
  assert.equal(info.status, "aborted");
  assert.equal(
    fs.existsSync(path.join(dir, "findings.md")),
    false,
    "an aborted run writes nothing that could pass for findings",
  );
});
