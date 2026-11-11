import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fakeHcClient } from "./test-helpers.ts";
import { findSh, runInTerminal, shellQuote, toShellScript } from "./terminal-run.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-run-test-"));
const outPath = path.join(tmp, "stdout.jsonl");
const errPath = path.join(tmp, "stderr.log");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const request = {
  invocation: { command: "/bin/echo", args: ["it's", "a 'quoted' arg"] },
  sh: "/bin/sh",
  cwd: tmp,
  name: "sa-run-1",
  labels: { run: "run-1", kind: "blocking", role: "general" },
  outPath,
  errPath,
};

const ended = (exitCode: number) => ({ ok: true as const, result: { terminal: "t7", ended: true, reason: "exit", exit_code: exitCode } });
const checkedIn = { ok: true as const, result: { terminal: "t7", ended: false, reason: "timeout" } };

test("shellQuote survives single quotes, spaces, and metacharacters", () => {
  assert.equal(shellQuote("plain"), "'plain'");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote("a b; $(rm -rf /)"), "'a b; $(rm -rf /)'");
});

test("toShellScript redirects both streams into files and forwards the exit code", () => {
  const script = toShellScript(
    { command: "/usr/bin/node", args: ["--version", "a b"] },
    "/tmp/out.jsonl",
    "/tmp/err.log",
  );
  assert.equal(script, `'/usr/bin/node' '--version' 'a b' > '/tmp/out.jsonl' 2> '/tmp/err.log'; exit $?`);
});

test("findSh resolves sh from PATH even when earlier entries have none", () => {
  const env = { PATH: ["/nope", "/bin"].join(path.delimiter) };
  assert.equal(
    findSh(env, (file) => file === path.join("/bin", "sh")),
    path.join("/bin", "sh"),
  );
  assert.equal(findSh({ PATH: "/nope" }, () => false), undefined);
  assert.equal(findSh({}, () => true), undefined);
});

test("findSh looks for sh.exe first on win32", () => {
  const dir = path.join(os.tmpdir(), "win-tools");
  assert.equal(
    findSh({ PATH: dir }, () => true, "win32"),
    path.join(dir, "sh.exe"),
  );
});

test("runInTerminal starts the terminal with the shell script and reads the files back", async () => {
  fs.writeFileSync(outPath, '{"type":"message_end"}\n');
  fs.writeFileSync(errPath, "warned\n");
  const client = fakeHcClient({
    onCall: ({ method }) => {
      if (method === "terminal.run") return { ok: true, result: { address: "t7" } };
      if (method === "terminal.wait") return ended(7);
      return { ok: true, result: undefined };
    },
  });

  const outcome = await runInTerminal(request, { client });
  assert.deepEqual(outcome, {
    ok: true,
    terminal: "t7",
    exitCode: 7,
    stdout: '{"type":"message_end"}\n',
    stderr: "warned\n",
  });

  const run = client.calls[0];
  assert.equal(run.method, "terminal.run");
  const params = run.params as { argv: string[]; cwd: string; name: string; labels: Record<string, string> };
  assert.deepEqual(params.argv, [
    "/bin/sh",
    "-c",
    `'/bin/echo' 'it'\\''s' 'a '\\''quoted'\\'' arg' > '${outPath}' 2> '${errPath}'; exit $?`,
  ]);
  assert.equal(params.cwd, tmp);
  assert.equal(params.name, "sa-run-1");
  assert.deepEqual(params.labels, { run: "run-1", kind: "blocking", role: "general" });
});

test("runInTerminal treats ended:false as a check-in and keeps waiting", async () => {
  let waits = 0;
  const client = fakeHcClient({
    onCall: ({ method }) => {
      if (method === "terminal.run") return { ok: true, result: { address: "t7" } };
      if (method === "terminal.wait") return waits++ < 2 ? checkedIn : ended(0);
      return { ok: true, result: undefined };
    },
  });

  const outcome = await runInTerminal(request, { client, checkInSeconds: 5 });
  assert.equal(outcome.ok, true);
  const waitsSent = client.calls.filter((call) => call.method === "terminal.wait");
  assert.equal(waitsSent.length, 3);
  assert.deepEqual(waitsSent[0].params, { terminal: "t7", timeout: 5 });
});

test("runInTerminal omits the timeout so the core's own default applies", async () => {
  const client = fakeHcClient({
    onCall: ({ method }) =>
      method === "terminal.run" ? { ok: true, result: { address: "t7" } } : ended(0),
  });
  await runInTerminal(request, { client });
  const wait = client.calls.find((call) => call.method === "terminal.wait");
  assert.deepEqual(wait?.params, { terminal: "t7" });
});

test("runInTerminal reads a missing output file as empty", async () => {
  fs.rmSync(outPath, { force: true });
  fs.rmSync(errPath, { force: true });
  const client = fakeHcClient({
    onCall: ({ method }) =>
      method === "terminal.run" ? { ok: true, result: { address: "t7" } } : ended(0),
  });
  const outcome = await runInTerminal(request, { client });
  assert.deepEqual(outcome, { ok: true, terminal: "t7", exitCode: 0, stdout: "", stderr: "" });
});

test("runInTerminal reports a failing terminal.run as startup (nothing ran)", async () => {
  const client = fakeHcClient({
    onCall: () => ({ ok: false, failure: "unavailable", message: "core unreachable" }),
  });
  const outcome = await runInTerminal(request, { client });
  assert.deepEqual(outcome, { ok: false, kind: "startup", message: "core unreachable" });
  assert.equal(
    client.calls.some((call) => call.method === "terminal.kill"),
    false,
  );
});

test("runInTerminal reports a terminal.run reply with no address as lost, never as a startup it could retry", async () => {
  const client = fakeHcClient({ onCall: () => ({ ok: true, result: {} }) });
  const outcome = await runInTerminal(request, { client });
  assert.deepEqual(outcome, {
    ok: false,
    kind: "lost",
    message: "terminal.run answered without a terminal address, so the run may have started",
  });
});

test("runInTerminal loses the run when the core stops answering after the start", async () => {
  const client = fakeHcClient({
    onCall: ({ method }) =>
      method === "terminal.run"
        ? { ok: true, result: { address: "t7" } }
        : { ok: false, failure: "unavailable", message: "connection dropped" },
  });
  const outcome = await runInTerminal(request, { client });
  assert.deepEqual(outcome, { ok: false, kind: "lost", message: "unavailable: connection dropped", terminal: "t7" });
});

test("runInTerminal kills the terminal when the caller aborts mid-run", async () => {
  const controller = new AbortController();
  const client = fakeHcClient({
    onCall: ({ method }) => {
      if (method === "terminal.run") return { ok: true, result: { address: "t7" } };
      if (method === "terminal.wait") {
        controller.abort();
        return { ok: false, failure: "killed", message: "aborted" };
      }
      return { ok: true, result: { address: "t7" } };
    },
  });

  const outcome = await runInTerminal(request, { client, signal: controller.signal });
  assert.deepEqual(outcome, { ok: false, kind: "aborted", message: "aborted by the caller", killed: true, terminal: "t7" });
  assert.deepEqual(
    client.calls.filter((call) => call.method === "terminal.kill").map((call) => call.params),
    [{ terminal: "t7" }],
  );
});

test("runInTerminal does not start a terminal when the signal already fired", async () => {
  const controller = new AbortController();
  controller.abort();
  const client = fakeHcClient({
    onCall: () => ({ ok: false, failure: "killed", message: "aborted before send" }),
  });
  const outcome = await runInTerminal(request, { client, signal: controller.signal });
  assert.deepEqual(outcome, {
    ok: false,
    kind: "aborted",
    message: "aborted before the terminal started",
    killed: true,
  });
  assert.equal(
    client.calls.some((call) => call.method === "terminal.kill"),
    false,
  );
});

test("runInTerminal reports a killed connection as lost when the caller did not abort", async () => {
  const client = fakeHcClient({
    onCall: ({ method }) =>
      method === "terminal.run"
        ? { ok: true, result: { address: "t7" } }
        : { ok: false, failure: "killed", message: "hc connect exited" },
  });
  const outcome = await runInTerminal(request, { client });
  assert.deepEqual(outcome, { ok: false, kind: "lost", message: "killed: hc connect exited", terminal: "t7" });
  assert.equal(
    client.calls.some((call) => call.method === "terminal.kill"),
    false,
  );
});

test("runInTerminal says the terminal may still run when the kill fails", async () => {
  const controller = new AbortController();
  const client = fakeHcClient({
    onCall: ({ method }) => {
      if (method === "terminal.run") return { ok: true, result: { address: "t7" } };
      if (method === "terminal.wait") {
        controller.abort();
        return { ok: false, failure: "killed", message: "aborted" };
      }
      return { ok: false, failure: "unavailable", message: "connection dropped" };
    },
  });

  const outcome = await runInTerminal(request, { client, signal: controller.signal });
  assert.deepEqual(outcome, {
    ok: false,
    kind: "aborted",
    message: "aborted by the caller, but terminal t7 could not be killed (unavailable: connection dropped)",
    killed: false,
    terminal: "t7",
  });
});
