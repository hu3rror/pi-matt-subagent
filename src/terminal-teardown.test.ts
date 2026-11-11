import { test } from "node:test";
import assert from "node:assert/strict";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createCarrierRunner, createHcTransport } from "./blocking-carrier.ts";
import { createResultAccumulator } from "./blocking-protocol.ts";
import type { HcResult } from "./hc-client.ts";
import { createHcResearchChildSession } from "./research-carrier.ts";
import { createSessionTerminals } from "./terminal-teardown.ts";
import { fakeHcClient, type FakeHcCall } from "./test-helpers.ts";

type TerminalState = "live" | "finished";

function fakeCore(initial: Record<string, TerminalState>) {
  const listing = new Map<string, TerminalState>(Object.entries(initial));
  const client = fakeHcClient({
    onCall: (call: FakeHcCall): HcResult | undefined => {
      const { terminal } = call.params as { terminal?: string };
      if ((call.method !== "terminal.kill" && call.method !== "terminal.rm") || !terminal) return undefined;
      const state = listing.get(terminal);
      if (!state) return { ok: false, failure: "protocol", message: "not_found" };
      if (call.method === "terminal.kill") {
        listing.set(terminal, "finished");
        return { ok: true, result: { address: terminal, state: "finished" } };
      }
      if (state === "live") return { ok: false, failure: "protocol", message: "live" };
      listing.delete(terminal);
      return { ok: true, result: {} };
    },
  });
  return { client, listing, calls: client.calls };
}

test("teardown kills every terminal the session created and removes the finished ones", async () => {
  const core = fakeCore({ t1: "live", t2: "live" });
  const terminals = createSessionTerminals({ client: () => core.client });
  terminals.track("t1");
  terminals.track("t2");

  await terminals.teardown();

  assert.deepEqual(
    core.calls.map((call) => [call.method, (call.params as { terminal: string }).terminal]),
    [
      ["terminal.kill", "t1"],
      ["terminal.rm", "t1"],
      ["terminal.kill", "t2"],
      ["terminal.rm", "t2"],
    ],
  );
  assert.deepEqual([...core.listing.keys()], [], "no dead terminal is left in the listing");
});

test("a terminal a finished run left behind is removed, not reported as a failure", async () => {
  const core = fakeCore({ t7: "finished" });
  const warnings: string[] = [];
  const terminals = createSessionTerminals({ client: () => core.client });
  terminals.track("t7");

  await terminals.teardown((message) => warnings.push(message));

  assert.deepEqual([...core.listing.keys()], []);
  assert.deepEqual(warnings, [], "a finished run's terminal is cleanup, not a degradation");
});

test("a kill that fails warns and leaves the terminal behind without throwing", async () => {
  const warnings: string[] = [];
  const core = fakeHcClient({ result: { ok: false, failure: "unavailable", message: "hc connect exited" } });
  const terminals = createSessionTerminals({ client: () => core });
  terminals.track("t5");

  await terminals.teardown((message) => warnings.push(message));

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /t5/);
  assert.match(warnings[0], /could not be killed/);
  assert.ok(!core.calls.some((call) => call.method === "terminal.rm"), "a live terminal is never removed");
});

test("a kill that leaves the terminal live keeps it in the listing and says so", async () => {
  const warnings: string[] = [];
  const core = fakeHcClient({
    onCall: (call) => (call.method === "terminal.kill" ? { ok: true, result: { address: "t6", state: "live" } } : undefined),
  });
  const terminals = createSessionTerminals({ client: () => core });
  terminals.track("t6");

  await terminals.teardown((message) => warnings.push(message));

  assert.deepEqual(
    core.calls.map((call) => call.method),
    ["terminal.kill"],
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /t6/);
});

test("a kill that answers without a state is not trusted as finished", async () => {
  const warnings: string[] = [];
  const core = fakeHcClient({
    onCall: (call) => (call.method === "terminal.kill" ? { ok: true, result: { address: "t7" } } : undefined),
  });
  const terminals = createSessionTerminals({ client: () => core });
  terminals.track("t7");

  await terminals.teardown((message) => warnings.push(message));

  assert.deepEqual(
    core.calls.map((call) => call.method),
    ["terminal.kill"],
  );
  assert.match(warnings[0] ?? "", /t7.*without a state/);
});

test("a core connection that cannot open warns instead of throwing", async () => {
  const warnings: string[] = [];
  const terminals = createSessionTerminals({
    client: () => {
      throw new Error("hc not installed");
    },
  });
  terminals.track("t8");

  await terminals.teardown((message) => warnings.push(message));

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /hc not installed/);
});

test("a second teardown has nothing left to do", async () => {
  const core = fakeCore({ t1: "live" });
  const terminals = createSessionTerminals({ client: () => core.client });
  terminals.track("t1");

  await terminals.teardown();
  const calls = core.calls.length;
  await terminals.teardown();

  assert.equal(core.calls.length, calls);
});

test("a session that created no terminal tears down without a call", async () => {
  const core = fakeCore({});

  await createSessionTerminals({ client: () => core.client }).teardown();

  assert.equal(core.calls.length, 0);
});

test("both carriers report their terminals to the same session teardown", async (t) => {
  const listing = new Map<string, TerminalState>();
  let seq = 0;
  const core = fakeHcClient({
    onCall: (call): HcResult | undefined => {
      const { terminal } = call.params as { terminal?: string };
      if (call.method === "terminal.run") {
        const address = `t${++seq}`;
        listing.set(address, "live");
        return { ok: true, result: { address } };
      }
      if (!terminal) return undefined;
      if (call.method === "terminal.wait") return { ok: true, result: { ended: true, exit_code: 0 } };
      if (call.method === "terminal.kill") {
        listing.set(terminal, "finished");
        return { ok: true, result: { address: terminal, state: "finished" } };
      }
      if (call.method === "terminal.rm") {
        listing.delete(terminal);
        return { ok: true, result: {} };
      }
      return undefined;
    },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teardown-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const terminals = createSessionTerminals({ client: () => core });

  const blocking = createCarrierRunner({
    transport: createHcTransport({
      client: core,
      findShell: () => "/bin/sh",
      makeRunDir: () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-teardown-run-")),
      onStarted: (terminal) => terminals.track(terminal),
    }),
    prepare: () => ({
      kind: "ready",
      prepared: {
        spec: {
          invocation: { command: "true", args: [] },
          cwd: dir,
          env: process.env,
          accumulator: createResultAccumulator({ agent: "general", agentSource: "embedded", task: "x" }),
          runId: "run-blocking",
          role: "general",
        },
        cleanup: () => {},
      },
    }),
  });
  await blocking.runTask({ agentName: "general", task: "x" }, { onProgress: () => {}, runId: "run-blocking" });

  const research = createHcResearchChildSession(
    {
      cwd: dir,
      extensions: [],
      tools: [],
      systemPrompt: "SP",
      task: "dig",
      findingsPath: path.join(dir, "findings.md"),
      logPath: path.join(dir, "research.log"),
      runId: "run-research",
    },
    {
      client: core,
      sh: "/bin/sh",
      invocation: () => ({ command: "true", args: [] }),
      onStarted: (terminal) => terminals.track(terminal),
    },
  );
  await research.done;

  assert.deepEqual([...listing.values()], ["live", "live"], "both carriers started a live terminal");

  await terminals.teardown();

  assert.deepEqual([...listing.keys()], [], "one teardown path cleans up either carrier's terminals");
});
