import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createResultAccumulator, type SingleResult } from "./blocking-protocol.ts";
import { emptyUsage, isToolError } from "./lib.ts";
import type { RunnerTask } from "./blocking-runner.ts";
import type { HcClient, HcResult } from "./hc-client.ts";
import {
  blockingTerminalLabels,
  blockingTerminalName,
  createCarrierRunner,
  createHcTransport,
  spawnTransport,
  type ChildSpec,
  type ChildTransport,
  type PrepareOutcome,
} from "./blocking-carrier.ts";

const CHILD_SCRIPT = `
const line = {
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25, totalFromProvider: true }, totalTokens: 15 },
  },
};
process.stdout.write(JSON.stringify(line) + "\\n");
process.stderr.write("a warning\\n");
process.exit(3);
`;

const invocation = { command: process.execPath, args: ["-e", CHILD_SCRIPT] };

const runDirs: string[] = [];
function trackedRunDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hc-run-test-"));
  runDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of runDirs) fs.rmSync(dir, { recursive: true, force: true });
});
const task: RunnerTask = { agentName: "general", task: "say hello" };

function readySpec(runId: string): ChildSpec {
  return {
    invocation,
    cwd: process.cwd(),
    env: process.env,
    accumulator: createResultAccumulator({ agent: "general", agentSource: "embedded", task: "say hello" }),
    runId,
    role: "general",
  };
}

function ready(runId: string, onCleanup: () => void = () => {}): PrepareOutcome {
  return { kind: "ready", prepared: { spec: readySpec(runId), cleanup: onCleanup } };
}

function runningCore(): HcClient {
  const terminals = new Map<string, { child: ReturnType<typeof spawn>; done: Promise<number> }>();
  let seq = 0;
  return {
    call: async (method, params): Promise<HcResult> => {
      if (method === "terminal.run") {
        const run = params as { argv: string[]; cwd: string; env: Record<string, string> };
        const address = `t${++seq}`;
        const child = spawn(run.argv[0], run.argv.slice(1), {
          cwd: run.cwd,
          env: { ...process.env, ...run.env },
          stdio: ["ignore", "pipe", "pipe"],
        });
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
        return { ok: true, result: { terminal, ended: true, reason: "exit", exit_code: await record.done } };
      }
      if (method === "terminal.kill") {
        const { terminal } = params as { terminal: string };
        terminals.get(terminal)?.child.kill("SIGKILL");
        return { ok: true, result: { address: terminal } };
      }
      return { ok: true, result: undefined };
    },
    capabilities: () => undefined,
    dispose: async () => {},
  };
}

function coreStaysLiveUntilChildExit(onEnded: () => void): HcClient {
  const terminals = new Map<string, { child: ReturnType<typeof spawn> }>();
  let seq = 0;
  return {
    call: async (method, params): Promise<HcResult> => {
      if (method === "terminal.run") {
        const run = params as { argv: string[]; cwd: string; env: Record<string, string> };
        const address = `t${++seq}`;
        const child = spawn(run.argv[0], run.argv.slice(1), {
          cwd: run.cwd,
          env: { ...process.env, ...run.env },
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout?.resume();
        child.stderr?.resume();
        terminals.set(address, { child });
        return { ok: true, result: { address } };
      }
      if (method === "terminal.wait") {
        const { terminal } = params as { terminal: string };
        const record = terminals.get(terminal);
        if (!record) return { ok: false, failure: "protocol", message: "no such terminal" };
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (record.child.exitCode === null) return { ok: true, result: { terminal, ended: false, reason: "timeout" } };
        onEnded();
        return { ok: true, result: { terminal, ended: true, reason: "exit", exit_code: record.child.exitCode } };
      }
      if (method === "terminal.kill") {
        const { terminal } = params as { terminal: string };
        terminals.get(terminal)?.child.kill("SIGKILL");
        return { ok: true, result: { address: terminal } };
      }
      return { ok: true, result: undefined };
    },
    capabilities: () => undefined,
    dispose: async () => {},
  };
}

test("a run's terminal is named and labelled for its run id", () => {
  assert.equal(blockingTerminalName("run-abcdef123456"), "sa-run-abcd");
  assert.equal(blockingTerminalName("!!weird!!"), "sa---weird-");
  assert.deepEqual(blockingTerminalLabels("run-7", "general"), { run: "run-7", kind: "blocking", role: "general" });
});

test("the carrier seam assembles the same result over spawn and hc (parity)", async () => {
  const overSpawn = createCarrierRunner({ transport: spawnTransport, prepare: () => ready("run-parity") });
  const overHc = createCarrierRunner({
    transport: createHcTransport({ client: runningCore(), findShell: () => "/bin/sh", makeRunDir: trackedRunDir }),
    prepare: () => ready("run-parity"),
  });

  const spawned = await overSpawn.runTask(task, { onProgress: () => {}, runId: "run-parity" });
  const carried = await overHc.runTask(task, { onProgress: () => {}, runId: "run-parity" });

  const { runDir: keptDir, ...carriedRest } = carried;
  assert.equal(typeof keptDir, "string", "the failed run names the directory it kept");
  assert.deepEqual(carriedRest, spawned);
  assert.equal(carried.exitCode, 3);
  assert.equal((carried.messages[0] as unknown as { content: Array<{ text: string }> }).content[0].text, "hello");
  assert.equal(carried.usage.turns, 1);
  assert.equal(carried.stderr, "a warning\n");
  assert.equal(isToolError(carried), true);
  assert.equal(isToolError(spawned), true);
});

test("progress events reach the accumulator over the hc carrier", async () => {
  const reader = (spec: ChildSpec): string[] => {
    const seen: string[] = [];
    const inner = spec.accumulator;
    spec.accumulator = {
      onStdout: (chunk) => {
        seen.push(chunk);
        inner.onStdout(chunk);
      },
      onStderr: (chunk) => inner.onStderr(chunk),
      finish: () => inner.finish(),
    };
    return seen;
  };
  let seen: string[] = [];
  const transport = createHcTransport({ client: runningCore(), findShell: () => "/bin/sh", makeRunDir: trackedRunDir });
  const runner = createCarrierRunner({
    transport,
    prepare: () => {
      const prepared = ready("run-progress");
      if (prepared.kind === "ready") seen = reader(prepared.prepared.spec);
      return prepared;
    },
  });

  await runner.runTask(task, { onProgress: () => {}, runId: "run-progress" });
  const fed = seen.join("").split("\n").filter((line) => line !== "");
  assert.equal(fed.length, 1);
  assert.equal(JSON.parse(fed[0]).type, "message_end");
});

const LIVE_CHILD_SCRIPT = `
const line = (text) => JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25, totalFromProvider: true }, totalTokens: 15 },
  },
}) + "\\n";
process.stdout.write(line("one"));
setTimeout(() => { process.stdout.write(line("two")); process.exit(0); }, 400);
`;

test("an hc run reports usage while it is live and counts each event once", async () => {
  let ended = false;
  const live: number[] = [];
  const runner = createCarrierRunner({
    transport: createHcTransport({ client: coreStaysLiveUntilChildExit(() => (ended = true)), findShell: () => "/bin/sh", makeRunDir: trackedRunDir }),
    prepare: (): PrepareOutcome => ({
      kind: "ready",
      prepared: {
        spec: {
          ...readySpec("run-live"),
          invocation: { command: process.execPath, args: ["-e", LIVE_CHILD_SCRIPT] },
          accumulator: createResultAccumulator({
            agent: "general",
            agentSource: "embedded",
            task: "say hello",
            onProgress: (partial) => {
              if (!ended) live.push(partial.usage.turns);
            },
          }),
        },
        cleanup: () => {},
      },
    }),
  });

  const result = await runner.runTask(task, { runId: "run-live", onProgress: () => {} });

  assert.equal(live[0], 1);
  assert.equal(result.usage.turns, 2);
  assert.equal(result.usage.input, 20);
});

test("a prepare failure returns its result without running a transport", async () => {
  const failed: SingleResult = {
    agent: "nope",
    agentSource: "unknown",
    task: "t",
    exitCode: 1,
    messages: [],
    stderr: "Unknown agent",
    usage: emptyUsage(),
  };
  let called = false;
  const runner = createCarrierRunner({
    transport: async () => {
      called = true;
      return { exitCode: 0, aborted: false };
    },
    prepare: () => ({ kind: "failed", result: failed }),
  });
  assert.deepEqual(await runner.runTask(task, { onProgress: () => {}, runId: "run-x" }), failed);
  assert.equal(called, false);
});

test("prepared cleanup runs even when the transport fails", async () => {
  let cleaned = 0;
  const runner = createCarrierRunner({
    transport: async () => {
      throw new Error("boom");
    },
    prepare: () => ready("run-clean", () => cleaned++),
  });
  await assert.rejects(runner.runTask(task, { onProgress: () => {}, runId: "run-clean" }), /boom/);
  assert.equal(cleaned, 1);
});

test("an aborted run throws the same abort error as the spawn adapter", async () => {
  const runner = createCarrierRunner({
    transport: async () => ({ exitCode: 1, aborted: true }),
    prepare: () => ready("run-abort"),
  });
  await assert.rejects(runner.runTask(task, { onProgress: () => {}, runId: "run-abort" }), /Subagent was aborted/);
});

test("the hc carrier falls back to spawn (with a warning) when no sh is on PATH", async () => {
  const warnings: string[] = [];
  const fallback: ChildTransport = async () => ({ exitCode: 0, aborted: false });
  const runner = createCarrierRunner({
    transport: createHcTransport({ client: runningCore(), findShell: () => undefined, fallback }),
    prepare: () => ready("run-nosh"),
    onWarn: (message) => warnings.push(message),
  });

  const result = await runner.runTask(task, { onProgress: () => {}, runId: "run-nosh" });
  assert.equal(result.exitCode, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no sh on PATH/);
  assert.match(warnings[0], /falling back to spawn/);
});

test("the hc carrier falls back to spawn (with a warning) when the core cannot start a terminal", async () => {
  const warnings: string[] = [];
  let fallbackRuns = 0;
  const deadCore: HcClient = {
    call: async () => ({ ok: false, failure: "unavailable", message: "hc connect could not start" }),
    capabilities: () => undefined,
    dispose: async () => {},
  };
  const runner = createCarrierRunner({
    transport: createHcTransport({
      client: deadCore,
      findShell: () => "/bin/sh",
      fallback: async () => {
        fallbackRuns++;
        return { exitCode: 5, aborted: false };
      },
    }),
    prepare: () => ready("run-dead"),
    onWarn: (message) => warnings.push(message),
  });

  const result = await runner.runTask(task, { onProgress: () => {}, runId: "run-dead" });
  assert.equal(fallbackRuns, 1);
  assert.equal(result.exitCode, 5);
  assert.match(warnings[0], /hc connect could not start/);
});

test("a core lost mid-run fails the run, naming the terminal and the run id", async () => {
  let waits = 0;
  const flakyCore: HcClient = {
    call: async (method) => {
      if (method === "terminal.run") return { ok: true, result: { address: "t9" } };
      if (method === "terminal.wait") {
        waits++;
        return { ok: false, failure: "unavailable", message: "connection dropped" };
      }
      return { ok: true, result: undefined };
    },
    capabilities: () => undefined,
    dispose: async () => {},
  };
  let dir = "";
  const runner = createCarrierRunner({
    transport: createHcTransport({
      client: flakyCore,
      findShell: () => "/bin/sh",
      makeRunDir: () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "carrier-lost-"));
        return dir;
      },
      fallback: async () => {
        throw new Error("the fallback must not run after the core took the terminal");
      },
    }),
    prepare: () => ready("run-abcdef123456"),
  });

  await assert.rejects(runner.runTask(task, { onProgress: () => {}, runId: "run-abcdef123456" }), (error: Error) => {
    assert.match(error.message, /sa-run-abcd/);
    assert.match(error.message, /run-abcdef123456/);
    return true;
  });
  assert.equal(waits, 1);
  assert.equal(fs.existsSync(dir), true, "the lost run's temp dir is kept for post-mortem");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an hc run that fails keeps its directory and names it on the result", async () => {
  let dir = "";
  const transport = createHcTransport({
    client: runningCore(),
    findShell: () => "/bin/sh",
    makeRunDir: () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "carrier-keep-"))),
  });

  const outcome = await transport(readySpec("run-keep-fail"), {});
  assert.equal(outcome.exitCode, 3);
  assert.equal(outcome.runDir, dir);
  assert.equal(fs.existsSync(path.join(dir, "stdout.jsonl")), true, "the transcript survives the failed run");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an hc run that succeeds removes its directory and reports nothing", async () => {
  let dir = "";
  const removed: string[] = [];
  const transport = createHcTransport({
    client: runningCore(),
    findShell: () => "/bin/sh",
    makeRunDir: () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "carrier-drop-"))),
    removeRunDir: (target) => {
      removed.push(target);
      fs.rmSync(target, { recursive: true, force: true });
    },
  });
  const spec = {
    ...readySpec("run-keep-ok"),
    invocation: { command: process.execPath, args: ["-e", 'process.stdout.write("{}+\\n");'] },
  };

  const outcome = await transport(spec, {});
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.runDir, undefined);
  assert.deepEqual(removed, [dir]);
});

test("an aborted hc run keeps its directory and names it in the warn line", async () => {
  const controller = new AbortController();
  let dir = "";
  const warnings: string[] = [];
  const transport = createHcTransport({
    client: {
      call: async (method) => {
        if (method === "terminal.run") return { ok: true, result: { address: "t7" } };
        if (method === "terminal.wait") {
          controller.abort();
          return { ok: false, failure: "killed", message: "aborted" };
        }
        return { ok: true, result: undefined };
      },
      capabilities: () => undefined,
      dispose: async () => {},
    },
    findShell: () => "/bin/sh",
    findTee: () => "/usr/bin/tee",
    makeRunDir: () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "carrier-abort-"))),
  });

  const outcome = await transport(readySpec("run-abort-keep"), {
    onWarn: (message) => warnings.push(message),
    signal: controller.signal,
  });
  assert.deepEqual(outcome, { exitCode: 1, aborted: true });
  assert.equal(fs.existsSync(dir), true, "the aborted run's transcript survives");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /transcript kept at /);
  assert.match(warnings[0] ?? "", new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the carrier runner puts a failed run's directory on the result", async () => {
  const runner = createCarrierRunner({
    transport: async () => ({ exitCode: 1, aborted: false, runDir: "/tmp/pi-hc-run-example" }),
    prepare: () => ready("run-dir-1"),
  });

  const result = await runner.runTask(task, { onProgress: () => {}, runId: "run-dir-1" });
  assert.equal(result.runDir, "/tmp/pi-hc-run-example");
});

test("a host without tee falls back to spawn before a terminal is started", async () => {
  const calls: string[] = [];
  const warnings: string[] = [];
  let dirs = 0;
  let removed: string[] = [];
  const transport = createHcTransport({
    client: {
      call: async (method) => {
        calls.push(method);
        return { ok: true, result: undefined };
      },
      capabilities: () => undefined,
      dispose: async () => {},
    },
    findShell: () => "/bin/sh",
    findTee: () => undefined,
    makeRunDir: () => {
      dirs++;
      return "/tmp/pi-hc-run-unused";
    },
    removeRunDir: (target) => {
      removed.push(target);
    },
    fallback: async () => ({ exitCode: 0, aborted: false }),
  });

  const outcome = await transport(readySpec("run-no-tee"), { onWarn: (message) => warnings.push(message) });
  assert.deepEqual(outcome, { exitCode: 0, aborted: false });
  assert.deepEqual(calls, []);
  assert.match(warnings[0] ?? "", /no tee/);
  assert.equal(dirs, 0, "no run directory is created when the host cannot mirror output");
  assert.deepEqual(removed, []);
});

test("the hc carrier kills the terminal when the run is aborted", async () => {
  const controller = new AbortController();
  const killed: string[] = [];
  const core: HcClient = {
    call: async (method, params) => {
      if (method === "terminal.run") return { ok: true, result: { address: "t3" } };
      if (method === "terminal.wait") {
        controller.abort();
        return { ok: false, failure: "killed", message: "aborted" };
      }
      if (method === "terminal.kill") {
        killed.push((params as { terminal: string }).terminal);
        return { ok: true, result: { address: "t3" } };
      }
      return { ok: true, result: undefined };
    },
    capabilities: () => undefined,
    dispose: async () => {},
  };
  const runner = createCarrierRunner({
    transport: createHcTransport({ client: core, findShell: () => "/bin/sh", makeRunDir: trackedRunDir }),
    prepare: () => ready("run-kill"),
  });

  await assert.rejects(
    runner.runTask(task, { onProgress: () => {}, runId: "run-kill", signal: controller.signal }),
    /Subagent was aborted/,
  );
  assert.deepEqual(killed, ["t3"]);
});

test("the hc carrier reports each started terminal to the session teardown", async () => {
  const controller = new AbortController();
  const tracked: string[] = [];
  const core: HcClient = {
    call: async (method) => {
      if (method === "terminal.run") return { ok: true, result: { address: "t3" } };
      if (method === "terminal.wait") {
        controller.abort();
        return { ok: false, failure: "killed", message: "aborted" };
      }
      return { ok: true, result: undefined };
    },
    capabilities: () => undefined,
    dispose: async () => {},
  };
  const runner = createCarrierRunner({
    transport: createHcTransport({
      client: core,
      findShell: () => "/bin/sh",
      makeRunDir: trackedRunDir,
      onStarted: (terminal) => tracked.push(terminal),
    }),
    prepare: () => ready("run-track"),
  });

  await assert.rejects(
    runner.runTask(task, { onProgress: () => {}, runId: "run-track", signal: controller.signal }),
    /Subagent was aborted/,
  );
  assert.deepEqual(tracked, ["t3"]);
});

test("the hc carrier warns when an aborted run's terminal cannot be killed", async () => {
  const controller = new AbortController();
  const warnings: string[] = [];
  const core: HcClient = {
    call: async (method) => {
      if (method === "terminal.run") return { ok: true, result: { address: "t4" } };
      if (method === "terminal.wait") {
        controller.abort();
        return { ok: false, failure: "killed", message: "aborted" };
      }
      return { ok: false, failure: "unavailable", message: "connection dropped" };
    },
    capabilities: () => undefined,
    dispose: async () => {},
  };
  const runner = createCarrierRunner({
    transport: createHcTransport({ client: core, findShell: () => "/bin/sh", makeRunDir: trackedRunDir }),
    prepare: () => ready("run-orphan"),
    onWarn: (message) => warnings.push(message),
  });

  await assert.rejects(
    runner.runTask(task, { onProgress: () => {}, runId: "run-orphan", signal: controller.signal }),
    /Subagent was aborted/,
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not be killed/);
  assert.match(warnings[0], /t4/);
});
