import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHcClient, type HcFailure, type HcClient, type HcResult } from "./hc-client.ts";
import { fakeHcClient } from "./test-helpers.ts";

const FIXTURE_SOURCE = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const log = process.env.HC_FIXTURE_LOG;
const counter = process.env.HC_FIXTURE_COUNTER;
const methods = (process.env.HC_FIXTURE_METHODS ?? "hello").split(",").filter(Boolean);
const features = (process.env.HC_FIXTURE_FEATURES ?? "").split(",").filter(Boolean);
let phantom = methods.includes("phantom");

function reported() {
  return methods.filter((name) => name !== "phantom" || phantom);
}

if (process.env.HC_FIXTURE_EXIT_EARLY) {
  process.stderr.write("core unreachable\\n");
  process.exit(3);
}

function generation() {
  const current = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 1;
  writeFileSync(counter, String(current + 1));
  return current;
}

function send(frame) {
  process.stdout.write(JSON.stringify(frame) + "\\n");
}

function errorFrame(id, code, kind, message) {
  return { id, jsonrpc: "2.0", error: { code, message, data: { kind } } };
}

function handle(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send(errorFrame(null, -32700, "parse_error", "invalid json"));
    return;
  }
  const id = request.id;
  const method = request.method;
  if (method === "hello") {
    if (process.env.HC_FIXTURE_BAD_HELLO) {
      send({ id, jsonrpc: "2.0", result: { generation: "one" } });
      return;
    }
    send({
      id,
      jsonrpc: "2.0",
      result: {
        core: { id: "fixture", name: "fixture" },
        features,
        framed: false,
        generation: generation(),
        methods: reported(),
        version: "fixture-0.1",
      },
    });
    return;
  }
  if (method === "garbage") {
    process.stdout.write("not json\\n");
    return;
  }
  if (method === "bad-frame") {
    send({ id, jsonrpc: "2.0" });
    return;
  }
  if (method === "die") process.exit(7);
  if (method === "hold") return;
  if (method === "phantom" || !reported().includes(method)) {
    phantom = false;
    send(errorFrame(id, -32601, "unknown_method", 'unknown method "' + method + '"'));
    return;
  }
  if (method === "boom") {
    send(errorFrame(id, -32000, "not_found", 'no terminal "x"'));
    return;
  }
  send({ id, jsonrpc: "2.0", result: { method, params: request.params } });
}

let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  let index;
  while ((index = buffered.indexOf("\\n")) >= 0) {
    const line = buffered.slice(0, index);
    buffered = buffered.slice(index + 1);
    if (log) appendFileSync(log, line + "\\n");
    handle(line);
  }
});
process.stdin.on("end", () => process.exit(0));
`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-client-"));
const fixture = path.join(root, "fixture.mjs");
fs.writeFileSync(fixture, FIXTURE_SOURCE);
after(() => fs.rmSync(root, { recursive: true, force: true }));

function failure(result: HcResult): string {
  assert.equal(result.ok, false, "expected a failed result");
  return result.ok ? "" : result.failure;
}

function message(result: HcResult): string {
  assert.equal(result.ok, false, "expected a failed result");
  return result.ok ? "" : result.message;
}

function caseDir(name: string): string {
  return fs.mkdtempSync(path.join(root, `${name}-`));
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition was not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function fixtureEnv(dir: string, methods: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HC_FIXTURE_LOG: path.join(dir, "requests.log"),
    HC_FIXTURE_COUNTER: path.join(dir, "generation"),
    HC_FIXTURE_METHODS: methods,
    HC_FIXTURE_FEATURES: "events,status",
  };
}

function fixtureClient(dir: string, methods: string): HcClient {
  return createHcClient({ command: process.execPath, args: [fixture], env: fixtureEnv(dir, methods) });
}

function recordedFrames(dir: string): Array<Record<string, unknown>> {
  return recordedLines(dir).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function recordedLines(dir: string): string[] {
  const logPath = path.join(dir, "requests.log");
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
}

test("the port probes hello on first use and frames one JSON object per request line", async (t) => {
  const dir = caseDir("probe");
  const client = fixtureClient(dir, "hello,echo,terminal.list");
  t.after(() => client.dispose());

  assert.equal(client.capabilities(), undefined);
  const listed = await client.call("terminal.list", { all: true });
  assert.deepEqual(listed, { ok: true, result: { method: "terminal.list", params: { all: true } } });
  assert.deepEqual(client.capabilities(), {
    generation: 1,
    version: "fixture-0.1",
    methods: ["hello", "echo", "terminal.list"],
    features: ["events", "status"],
  });
  const echoed = await client.call("echo", { n: 2 });
  assert.deepEqual(echoed, { ok: true, result: { method: "echo", params: { n: 2 } } });

  const lines = recordedLines(dir);
  assert.equal(lines.length, 3, "one request per call plus the first-use probe");
  for (const line of lines) assert.equal(JSON.stringify(JSON.parse(line)), line, "compact single-line framing");
  const [probe, ...calls] = recordedFrames(dir);
  assert.deepEqual(Object.keys(probe), ["id", "jsonrpc", "method", "params"]);
  assert.equal(probe.jsonrpc, "2.0");
  assert.equal(probe.method, "hello");
  assert.deepEqual(probe.params, {});
  assert.equal(typeof probe.id, "number");
  assert.deepEqual([probe.id, ...calls.map((frame) => frame.id)], [1, 2, 3]);
  assert.deepEqual(calls.map((frame) => frame.method), ["terminal.list", "echo"]);
  assert.deepEqual(calls[0].params, { all: true });
  assert.deepEqual(calls[1].params, { n: 2 });
  assert.notEqual(calls[0].id, probe.id);
  assert.notEqual(calls[0].id, calls[1].id);
});

test("concurrent first calls share one handshake and one spawn", async (t) => {
  const dir = caseDir("concurrent");
  const client = fixtureClient(dir, "hello,echo");
  t.after(() => client.dispose());

  const results = await Promise.all([
    client.call("echo", { n: 1 }),
    client.call("echo", { n: 2 }),
    client.call("echo", { n: 3 }),
  ]);
  assert.deepEqual(results, [
    { ok: true, result: { method: "echo", params: { n: 1 } } },
    { ok: true, result: { method: "echo", params: { n: 2 } } },
    { ok: true, result: { method: "echo", params: { n: 3 } } },
  ]);
  assert.deepEqual(
    recordedFrames(dir).map((frame) => frame.method),
    ["hello", "echo", "echo", "echo"],
  );
  assert.equal(fs.readFileSync(path.join(dir, "generation"), "utf8"), "2", "one child served every call");
});

test("a method outside the reported surface fails method-missing without being sent", async (t) => {
  const dir = caseDir("surface");
  const client = fixtureClient(dir, "hello,echo");
  t.after(() => client.dispose());

  const result = await client.call("terminal.spawn", {});
  assert.equal(result.ok, false);
  assert.equal(failure(result), "method-missing");
  assert.match(message(result), /terminal\.spawn/);
  assert.deepEqual(
    recordedFrames(dir).map((frame) => frame.method),
    ["hello"],
    "an absent method is refused locally",
  );

  const echoed = await client.call("echo", {});
  assert.deepEqual(echoed, { ok: true, result: { method: "echo", params: {} } });
});

test("unknown_method for a reported method re-probes once, then fails method-missing", async (t) => {
  const dir = caseDir("reprobe");
  const client = fixtureClient(dir, "hello,echo,phantom");
  t.after(() => client.dispose());

  const result = await client.call("phantom", { n: 1 });
  assert.equal(failure(result), "method-missing");
  assert.deepEqual(
    recordedFrames(dir).map((frame) => frame.method),
    ["hello", "phantom", "hello"],
  );
  assert.equal(client.capabilities()?.generation, 2, "the re-probe kept the newer generation");

  const again = await client.call("phantom", { n: 2 });
  assert.equal(failure(again), "method-missing");
  assert.deepEqual(
    recordedFrames(dir).map((frame) => frame.method),
    ["hello", "phantom", "hello"],
    "the re-probed surface refuses it without another probe",
  );

  const echoed = await client.call("echo", {});
  assert.deepEqual(echoed, { ok: true, result: { method: "echo", params: {} } }, "the connection survives");
});

test("a status error fails protocol and keeps the connection", async (t) => {
  const dir = caseDir("status");
  const client = fixtureClient(dir, "hello,echo,boom");
  t.after(() => client.dispose());

  const result = await client.call("boom", { id: "x" });
  assert.equal(failure(result), "protocol");
  assert.match(message(result), /no terminal "x"/);
  assert.equal(client.capabilities()?.generation, 1);

  const echoed = await client.call("echo", {});
  assert.deepEqual(echoed, { ok: true, result: { method: "echo", params: {} } });
  assert.deepEqual(
    recordedFrames(dir).map((frame) => frame.method),
    ["hello", "boom", "echo"],
    "no re-probe after a status error",
  );
});

test("a core that cannot be started fails unavailable and retries on the next call", async (t) => {
  const dir = caseDir("missing");
  const client = createHcClient({ command: path.join(dir, "missing-hc"), env: fixtureEnv(dir, "hello") });
  t.after(() => client.dispose());

  const result = await client.call("echo", {});
  assert.equal(failure(result), "unavailable");
  assert.match(message(result), /^hc connect/);
  assert.equal(client.capabilities(), undefined);

  const retry = await client.call("echo", {});
  assert.equal(failure(retry), "unavailable", "a failed start is retried");
});

test("a core that dies in flight fails the call unavailable and reconnects on the next one", async (t) => {
  const dir = caseDir("death");
  const client = fixtureClient(dir, "hello,echo,die");
  t.after(() => client.dispose());

  const result = await client.call("die", {});
  assert.equal(failure(result), "unavailable");
  assert.match(message(result), /exited \(7\)/);
  assert.equal(client.capabilities(), undefined);

  const echoed = await client.call("echo", {});
  assert.deepEqual(echoed, { ok: true, result: { method: "echo", params: {} } });
  assert.deepEqual(
    recordedFrames(dir).map((frame) => frame.method),
    ["hello", "die", "hello", "echo"],
    "a fresh connection re-probes",
  );
});

test("a line that is not JSON fails protocol, retires the child, and reconnects later", async (t) => {
  const dir = caseDir("garbage");
  const client = fixtureClient(dir, "hello,echo,garbage");
  t.after(() => client.dispose());

  const result = await client.call("garbage", {});
  assert.equal(failure(result), "protocol");
  assert.match(message(result), /not JSON/);
  assert.equal(client.capabilities(), undefined);

  const echoed = await client.call("echo", {});
  assert.deepEqual(echoed, { ok: true, result: { method: "echo", params: {} } });
  assert.deepEqual(
    recordedFrames(dir).map((frame) => frame.method),
    ["hello", "garbage", "hello", "echo"],
  );
});

test("a response with neither result nor error fails protocol", async (t) => {
  const dir = caseDir("bad-frame");
  const client = fixtureClient(dir, "hello,bad-frame");
  t.after(() => client.dispose());

  const result = await client.call("bad-frame", {});
  assert.equal(failure(result), "protocol");
  assert.match(message(result), /neither result nor error/);
  assert.equal(client.capabilities(), undefined);
});

test("a hello without capabilities fails protocol on every connection", async (t) => {
  const dir = caseDir("bad-hello");
  const client = createHcClient({
    command: process.execPath,
    args: [fixture],
    env: { ...fixtureEnv(dir, "hello"), HC_FIXTURE_BAD_HELLO: "1" },
  });
  t.after(() => client.dispose());

  const result = await client.call("echo", {});
  assert.equal(failure(result), "protocol");
  assert.match(message(result), /did not report/);
  assert.equal(client.capabilities(), undefined);

  const again = await client.call("echo", {});
  assert.equal(failure(again), "protocol", "re-probing cannot rescue an unusable hello");
  assert.equal(
    recordedFrames(dir).filter((frame) => frame.method === "hello").length,
    2,
    "the child did not answer hello twice",
  );
});

test("an aborted signal fails the call killed and leaves the connection usable", async (t) => {
  const dir = caseDir("abort");
  const client = fixtureClient(dir, "hello,echo,hold");
  t.after(() => client.dispose());

  await client.call("echo", { n: 0 });
  const controller = new AbortController();
  const held = client.call("hold", {}, controller.signal);
  await waitFor(() => recordedLines(dir).length === 3);
  controller.abort();

  const result = await held;
  assert.equal(failure(result), "killed");
  const echoed = await client.call("echo", { n: 1 });
  assert.deepEqual(echoed, { ok: true, result: { method: "echo", params: { n: 1 } } });
  assert.deepEqual(
    recordedFrames(dir).map((frame) => frame.method),
    ["hello", "echo", "hold", "echo"],
  );
});

test("an already aborted signal fails killed before anything is sent", async (t) => {
  const dir = caseDir("pre-aborted");
  const client = fixtureClient(dir, "hello,echo");
  t.after(() => client.dispose());

  const controller = new AbortController();
  controller.abort();
  const result = await client.call("echo", {}, controller.signal);
  assert.equal(failure(result), "killed");
  assert.deepEqual(recordedLines(dir), [], "no child, no handshake, no request");
  assert.equal(client.capabilities(), undefined);
});

test("dispose settles calls in flight and the client sends nothing after it", async (t) => {
  const dir = caseDir("dispose");
  const client = fixtureClient(dir, "hello,echo,hold");
  await client.call("echo", {});
  const held = client.call("hold", {});
  await waitFor(() => recordedLines(dir).length === 3);

  await client.dispose();
  const result = await held;
  assert.equal(failure(result), "unavailable");
  assert.match(message(result), /disposed/);
  assert.equal(client.capabilities(), undefined);

  const after = await client.call("echo", {});
  assert.equal(failure(after), "unavailable");
  assert.deepEqual(
    recordedFrames(dir).map((frame) => frame.method),
    ["hello", "echo", "hold"],
    "a disposed client sent nothing more",
  );
  await client.dispose();
});

test("the fake hc client records calls and reports the configured outcome", async () => {
  const capabilities = { generation: 1, version: "fake", methods: ["echo"], features: [] };
  const controller = new AbortController();
  const client = fakeHcClient({ capabilities, result: { ok: false, failure: "unavailable", message: "down" } });

  const held = client.call("echo", { n: 1 }, controller.signal);
  controller.abort();
  const result = await held;
  assert.deepEqual(result, { ok: false, failure: "unavailable", message: "down" });
  assert.deepEqual(client.calls, [{ method: "echo", params: { n: 1 }, signal: controller.signal }]);
  assert.equal(client.calls[0]?.signal?.aborted, true, "the caller's signal reaches the fake");
  assert.deepEqual(client.capabilities(), capabilities);
  await client.dispose();
});

test("the fake hc client can answer every failure kind", async () => {
  const kinds: HcFailure[] = ["unavailable", "method-missing", "protocol", "killed"];
  for (const kind of kinds) {
    const answer: HcResult = { ok: false, failure: kind, message: `fake ${kind}` };
    const client = fakeHcClient({ onCall: () => answer });
    assert.deepEqual(await client.call("echo", {}), answer);
    await client.dispose();
  }
});
