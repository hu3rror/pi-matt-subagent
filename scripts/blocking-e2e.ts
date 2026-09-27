/**
 * DEV-ONLY — real-pi blocking spawn e2e for the aaa20e4 re-wiring.
 *
 * Not part of `npm test` (Path-1 stance: the blocking orchestration and the
 * escalateKill semantics are covered by `node --test` with fake runners and
 * fake timers; real-process wiring regressions are caught here instead of a
 * fake-pi harness).
 *
 * Loaded as a pi extension alongside the plugin, it exercises the blocking
 * adapter wiring (the exact seams runSingleAgent uses) against a REAL spawned
 * pi child:
 *
 *   1. spawn + protocol — a child pi (`--mode json -p`) completes a task; the
 *      accumulator parses its JSON-lines protocol, counts usage > 0, and the
 *      adapter patches exitCode 0. This is the "blocking spawn re-wiring":
 *      getPiInvocation → spawn → accumulator → result.
 *   2. dispose-on-close — a long-running child is SIGTERMed mid-flight via
 *      escalateKill (the abort path); it must close within the grace window
 *      (i.e. NOT by the SIGKILL backstop), and the adapter's close→dispose
 *      cancels the backstop. Same wiring as the Esc-abort path, minus the TUI.
 *
 * Run (a working model / API key is required):
 *   pi -p --no-session --no-extensions -e extensions/subagent.ts -e scripts/blocking-e2e.ts "Count slowly from 1 to 25, one number per line, then say done"
 *
 * Results are appended to `blocking-e2e.log` in the OS temp dir; a fresh log
 * is written per run. Look for `BLOCKING-E2E OK` per gate.
 *
 * Windows caveat: SIGTERM cannot be trapped by a process (TerminateProcess),
 * so "the backstop fires on a SIGTERM-ignoring process" is not reproducible
 * here — the unit tests (fake timers) pin that semantics. Gate 2 still proves
 * the dispose-on-close path on a real process with real signals and real
 * timers.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildDispatchArgs, getPiInvocation } from "../src/lib.ts";
import { createResultAccumulator, escalateKill, type SingleResult } from "../src/blocking-protocol.ts";

export default function (pi: ExtensionAPI) {
  const logPath = path.join(os.tmpdir(), "blocking-e2e.log");
  fs.writeFileSync(logPath, "", { encoding: "utf-8" });
  const log = (msg: string) => fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`);

  let started = false;

  /** Spawn a real pi child exactly like runSingleAgent, return the handle + accumulator wiring. */
  function spawnBlockingChild(task: string, model: string) {
    const args = buildDispatchArgs({ model, thinking: "off", task });
    const invocation = getPiInvocation(args);
    const proc = spawn(invocation.command, invocation.args, {
      cwd: process.cwd(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const acc = createResultAccumulator({ agent: "e2e", agentSource: "embedded", task, model });
    proc.stdout.on("data", (d) => acc.onStdout(d.toString()));
    proc.stderr.on("data", (d) => acc.onStderr(d.toString()));
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      proc.on("close", (code, signal) => resolve({ code, signal })),
    );
    return { proc, acc, closed, finish: () => acc.finish() };
  }

  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup" || started) return;
    started = true;
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    log(`session_start cwd=${ctx.cwd} model=${model ?? "(none)"}`);
    if (!model) {
      log("BLOCKING-E2E SKIP: no model — needs a working model/API key");
      return;
    }

    void (async () => {
      // Gate 1 — spawn + protocol + usage on a real pi child.
      const c1 = spawnBlockingChild('Reply with exactly the single word: pong', model);
      const { code: code1, signal: sig1 } = await c1.closed;
      const r1: SingleResult = c1.finish();
      const last = r1.messages.filter((m) => m.role === "assistant").map((m) => m.content?.[0]).find((c) => c?.type === "text");
      log(`(1) exitCode=${r1.exitCode} rawClose=${code1}/${sig1} messages=${r1.messages.length} turns=${r1.usage.turns} input=${r1.usage.input} output=${r1.usage.output} last=${(last as { text?: string } | undefined)?.text}`);
      if (r1.exitCode === 0 && r1.messages.length >= 1 && r1.usage.turns === 1 && r1.usage.input > 0 && (last as { text?: string } | undefined)?.text?.includes("pong")) {
        log("BLOCKING-E2E OK: gate 1 (spawn + protocol + usage)");
      } else {
        log("BLOCKING-E2E FAIL: gate 1");
      }

      // Gate 2 — dispose-on-close: SIGTERM a long-running real pi child
      // mid-flight (the abort path), assert it dies within grace (not by the
      // SIGKILL backstop), then close→dispose.
      const c2 = spawnBlockingChild(
        'Use the bash tool to run: node -e "setTimeout(() => {}, 20000)". Then reply: done',
        model,
      );
      const GRACE = 2000;
      const esc = escalateKill(c2.proc, { graceMs: GRACE });
      // Give the child time to start the model call / tool call, then abort.
      await new Promise((r) => setTimeout(r, 3000));
      const t0 = Date.now();
      esc.send(); // the adapter's onAbort
      const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("child did not close within 15s")), 15000));
      let closed2: { code: number | null; signal: NodeJS.Signals | null };
      try {
        closed2 = await Promise.race([c2.closed, timeout]);
      } catch (err) {
        log(`(2) ${(err as Error).message}`);
        log("BLOCKING-E2E FAIL: gate 2");
        return;
      }
      esc.dispose(); // the adapter's close→dispose (idempotent)
      const elapsed = Date.now() - t0;
      c2.finish();
      log(`(2) closed signal=${closed2.signal} code=${closed2.code} send→close=${elapsed}ms grace=${GRACE}ms`);
      if (closed2.signal === "SIGTERM" && elapsed < GRACE) {
        log("BLOCKING-E2E OK: gate 2 (dispose-on-close — died by SIGTERM within grace, backstop cancelled on close)");
      } else {
        log("BLOCKING-E2E FAIL: gate 2");
      }
    })().catch((err) => {
      log(`blocking-e2e async body errored: ${(err as Error).stack ?? (err as Error).message}`);
    });
  });
}
