/**
 * DEV-ONLY — real-pi push-e2e for the ADR 0013 research wiring.
 *
 * Not part of `npm test` (Path-1 stance: the runner contract is covered by
 * `node --test` with fake child sessions; real-pi wiring regressions are
 * caught by this script instead of a fake-pi harness).
 *
 * Loaded as a pi extension alongside the plugin, it exercises the four gates
 * the prototype proved for the in-process execution base, now against the
 * REAL child-session factory (`createResearchChildSession`, named export of
 * extensions/subagent.ts):
 *
 *   1. spawn — a research child session is created from session_start-time
 *      code and completes a real prompt;
 *   2. push — the completion pushes a `research-status` message into the main
 *      context via pi.sendMessage (deliverAs: "followUp", triggerTurn: true);
 *   3. crash isolation — a child built with a deliberately bogus model throws
 *      without taking the main session down;
 *   4. cleanup — session_shutdown aborts the tracked in-process children (the
 *      wrapper exposes no `dispose` by design — the child self-disposes in
 *      `done`'s finally; `abort` is the wrapper's live-run termination path,
 *      shared with the manual kill).
 *
 * Run (a working model / API key is required):
 *   pi -p --no-session --no-extensions -e extensions/subagent.ts -e scripts/push-e2e.ts "Count slowly from 1 to 25, one number per line, then say done"
 *
 * Observations are appended to `push-e2e.log` in the OS temp dir; a fresh log
 * is written per run. Look for `PUSH-E2E OK` per gate; a missing gate means
 * that gate's wiring regressed.
 *
 * Print-mode caveat: one-shot `-p` starts the first turn a few ms after
 * `session_start`, so the script must push mid-stream (~1.5s in, after the
 * countdown prompt keeps the turn busy) — an immediate triggerTurn push when
 * the agent is not streaming would start a competing turn. Keep the prompt
 * long enough that the push lands while the first turn is still running.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createResearchChildSession, probeChildToolNames, RESEARCH_STATUS_CUSTOM_TYPE } from "../extensions/subagent.ts";
import { EMBEDDED_ROLES, researchChildAllowlist, resolveTools } from "../src/lib.ts";

export default function (pi: ExtensionAPI) {
  const logPath = path.join(os.tmpdir(), "push-e2e.log");
  fs.writeFileSync(logPath, "", { encoding: "utf-8" });
  const log = (msg: string) => fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`);
  const shadowError = (what: string, err: unknown) => ({
    content: [{ type: "text" as const, text: `${what} failed: ${(err as Error).message}` }],
    details: {},
    isError: true,
  });

  // Gate 6 — issue #43: shadow the built-in read/grep in the MAIN registry the
  // way a tool-replacing extension does (extension tools carry
  // `source: "extension"`, overwriting pi's built-in entries). The research
  // child does NOT load this extension, so it must still get pi's built-in
  // implementations; the probe recognizes a built-in by NAME (derived from
  // pi's public tool factories), not by which extension owns it in the main
  // session. The shadows stay callable so the main turn keeps working.
  pi.registerTool({
    name: "read",
    label: "Read (push-e2e shadow)",
    description: "Read a file (shadow of the built-in read for the issue #43 gate).",
    parameters: Type.Object({
      path: Type.String({ description: "File to read." }),
      offset: Type.Optional(Type.Integer({ description: "1-based starting line." })),
      limit: Type.Optional(Type.Integer({ description: "Maximum number of lines to return." })),
    }),
    async execute(_toolCallId, params) {
      try {
        const lines = fs.readFileSync(params.path, "utf8").split("\n");
        const start = Math.max(0, (params.offset ?? 1) - 1);
        const slice = params.limit ? lines.slice(start, start + params.limit) : lines.slice(start);
        const text = slice.map((l, i) => `${start + i + 1}│${l}`).join("\n");
        return { content: [{ type: "text", text: text || "(empty)" }], details: {} };
      } catch (err) {
        return shadowError("read", err);
      }
    },
  });
  pi.registerTool({
    name: "grep",
    label: "Grep (push-e2e shadow)",
    description: "Search a file for a pattern (shadow of the built-in grep for the issue #43 gate).",
    parameters: Type.Object({
      pattern: Type.String({ description: "Substring to search for." }),
      path: Type.String({ description: "File to search." }),
    }),
    async execute(_toolCallId, params) {
      try {
        const hits = fs
          .readFileSync(params.path, "utf8")
          .split("\n")
          .map((l, i) => ({ i, l }))
          .filter(({ l }) => l.includes(params.pattern))
          .map(({ i, l }) => `${i + 1}:${l}`);
        return { content: [{ type: "text", text: hits.length > 0 ? hits.join("\n") : "no matches" }], details: {} };
      } catch (err) {
        return shadowError("grep", err);
      }
    },
  });

  const children: Array<{ abort(): void }> = [];
  let started = false;

  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup" || started) return;
    started = true;
    log(`session_start reason=${event.reason} cwd=${ctx.cwd} hasUI=${ctx.hasUI} model=${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)"}`);
    // Capture the cwd/model once: gates 5/5b can outlive the session
    // (session_shutdown fires gate 4 before they finish), and a captured ctx
    // would then be stale.
    const sessionCwd = ctx.cwd;
    const sessionModel = ctx.model;

    void (async () => {
      const findingsPath = path.join(os.tmpdir(), "push-e2e-findings.md");
      const teeLog = path.join(os.tmpdir(), "push-e2e-child-output.log");
      const child = createResearchChildSession({
        cwd: ctx.cwd,
        model: ctx.model,
        thinkingLevel: "off",
        tools: ["read", "grep", "find", "ls", "bash", "write"],
        extensions: [],
        systemPrompt:
          "You are a minimal research subagent for a wiring check. Be terse. Write findings to the findings path you are given.",
        task: `Write "PUSH-E2E OK" to ${findingsPath}. Reply with exactly the single word: pong`,
        findingsPath,
      });
      children.push(child);
      // consume the child's output stream the way the runner's tee does
      const tee = (async () => {
        const fd = fs.openSync(teeLog, "a");
        try {
          for await (const chunk of child.output) fs.writeSync(fd, chunk);
        } finally {
          fs.closeSync(fd);
        }
      })();
      void tee.catch(() => {});

      // Gate 2 — push delivery with the production content wording. In one-shot
      // print mode the first turn starts a few ms after session_start, so an
      // immediate triggerTurn push would race it (a push when the agent is not
      // streaming starts a competing turn). Waiting ~1.5s puts the push
      // mid-stream: deliverAs "followUp" queues it and the agent loop drains it
      // as a follow-up turn once the current turn ends.
      await new Promise((r) => setTimeout(r, 1500));

      try {
        pi.sendMessage(
          {
            customType: RESEARCH_STATUS_CUSTOM_TYPE,
            content:
              "The background research you started has completed. Read the findings file at " +
              `${findingsPath} to collect the results.`,
            display: true,
            details: { status: "succeeded", findingsPath, logPath: teeLog },
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
        log("(2) pi.sendMessage (research-status, followUp, triggerTurn) — no throw");
        log("PUSH-E2E OK: gate 2 (push sent; arrival shows as a follow-up turn in the transcript)");
      } catch (err) {
        log(`(2) pi.sendMessage THREW: ${(err as Error).message}`);
        log("PUSH-E2E FAIL: gate 2");
      }

      try {
        const doomed = createResearchChildSession({
          cwd: ctx.cwd,
          model: { provider: "x-nonexistent", id: "x-nonexistent" } as never,
          thinkingLevel: "off",
          tools: ["read"],
          extensions: [],
          systemPrompt: "You are a research subagent.",
          task: "reply with one word",
          findingsPath: path.join(os.tmpdir(), "push-e2e-never.md"),
        });
        children.push(doomed);
        await doomed.done;
        log("(3) UNEXPECTED: doomed child did not fail");
        log("PUSH-E2E FAIL: gate 3");
      } catch (err) {
        log(`(3) failing child threw and was caught: ${(err as Error).message}`);
        log("(3) main session still alive after child failure (this line proves isolation)");
        log("PUSH-E2E OK: gate 3 (crash isolation)");
      }

      // Gate 1 finish — the child completion is independent of gates 2-3.
      try {
        await child.done;
        log("(1) child session completed its prompt");
        log(`(1) findings written: ${fs.existsSync(findingsPath) ? "yes" : "NO"}`);
        log(`(1) teed output landed in the per-run log: ${fs.statSync(teeLog).size > 0 ? "yes" : "NO"}`);
        if (!fs.existsSync(findingsPath)) throw new Error("gate 1: findings file missing");
        log("PUSH-E2E OK: gate 1 (spawn + completion)");
      } catch (err) {
        log(`(1) child session FAILED: ${(err as Error).message}`);
        log("PUSH-E2E FAIL: gate 1");
      }

      // Gates 5 / 5b — issue #37/#44: the research-child loadout. A child
      // built with the knob's packages must self-report the loader truth
      // (not the caller's allowlist-filtered session tools) as its first
      // output line, with no drift and no warn. Gate 5 pins the quiet
      // default: no packages configured => built-in tools only, one `info`
      // loadout line, nothing missing. Gate 5b pins activation-follows-load:
      // a child built with a loaded query package gets the package's tools on
      // the allowlist without any role declaration (the union the runner
      // computes), and the loadout reports them loaded. One shared helper
      // keeps the two gates from drifting apart.
      const runLoadoutGate = async (opts: {
        label: string;
        extensions: string[];
        tools: string[];
        firstLineCheck: (firstLine: string) => boolean;
        assertStageLines?: boolean;
        okMessage: string;
        failMessage: string;
      }) => {
        try {
          const child = createResearchChildSession({
            cwd: sessionCwd,
            model: sessionModel,
            thinkingLevel: "off",
            extensions: opts.extensions,
            tools: opts.tools,
            systemPrompt: "You are a loadout check. Reply with exactly: pong",
            task: "Reply with exactly: pong",
            findingsPath: path.join(os.tmpdir(), `push-e2e-knob-${opts.label}-findings.md`),
          });
          children.push(child);
          let out = "";
          void (async () => {
            for await (const chunk of child.output) out += chunk;
          })().catch(() => {});
          await child.done;
          const firstLine = out.split("\n")[0] ?? "";
          log(`(${opts.label}) knob child first line: ${JSON.stringify(firstLine)}`);
          const ok =
            opts.firstLineCheck(firstLine) &&
            !out.includes("[child-loadout] allowlist missing from loadout:") &&
            !out.includes("[loadout] warn") &&
            // Stage lines: the log must show created/prompt so a loadout line
            // never sits alone; the terminal stage is written by the research
            // tool's onExit and is out of scope here (direct child, no runner).
            (!opts.assertStageLines ||
              (out.includes("[run] ") && out.includes("session created") && out.includes("prompt started")));
          log(ok ? `PUSH-E2E OK: gate ${opts.label} (${opts.okMessage})` : `PUSH-E2E FAIL: gate ${opts.label} (${opts.failMessage})`);
        } catch (err) {
          log(`(${opts.label}) knob loadout child FAILED: ${(err as Error).message}`);
          log(`PUSH-E2E FAIL: gate ${opts.label}`);
        }
      };

      const declared = EMBEDDED_ROLES.researcher.tools ?? [];
      for (const q of ["web_access", "query-docs", "resolve-library-id"]) {
        if (declared.includes(q)) throw new Error(`default researcher role still declares ${q} — activation-follows-load expects built-in names only`);
      }

      // Gate 5 — the quiet default: an empty knob loads no packages, the
      // child carries built-in tools only, and the loadout speaks one `info`
      // line instead of warning.
      await runLoadoutGate({
        label: "5",
        extensions: [],
        tools: declared,
        firstLineCheck: (firstLine) =>
          firstLine.includes("[loadout] info · no query packages configured") && firstLine.includes("built-in tools only"),
        assertStageLines: true,
        okMessage: "quiet default loadout is built-in tools only, info line present, no drift; stage lines present",
        failMessage: "child-loadout line above shows the regression",
      });

      // Gate 5b — activation follows load: probe the loaded query package
      // (web_access), build the allowlist the runner would hand the child
      // (declared built-ins ∪ package tools — the role declares no web tool),
      // and require the loadout to report the package's tool loaded with no
      // drift. Uses `bash`-free allowlist math so the gate is platform-stable.
      try {
        const knob = ["npm:@ssk_dev/pi-web-access-lean"];
        const probe = probeChildToolNames(pi, knob);
        if (probe.packageToolNames.length === 0) {
          throw new Error("web-access-lean not installed — gate 5b cannot verify auto-activation");
        }
        log(`(5b) probe package tools: ${probe.packageToolNames.join(", ")}`);
        const allowlist = researchChildAllowlist({
          declared,
          availableToolNames: probe.names,
          platform: process.platform,
          packageTools: probe.packageToolNames,
          explicit: false,
        }).tools;
        log(`(5b) auto-activated allowlist: ${allowlist.join(", ")}`);
        await runLoadoutGate({
          label: "5b",
          extensions: knob,
          tools: allowlist,
          firstLineCheck: (firstLine) =>
            firstLine.includes("[loadout] ok · loaded") && firstLine.includes("web_access"),
          assertStageLines: true,
          okMessage: "loaded package's tool joins the allowlist without a role declaration; loadout ok, no drift",
          failMessage: "child-loadout line above shows which tool/package drifted",
        });
      } catch (err) {
        log(`(5b) auto-activation gate FAILED: ${(err as Error).message}`);
        log("PUSH-E2E FAIL: gate 5b");
      }

      // Gate 6 — issue #43: the main-session registry's read/grep now come
      // from THIS extension (the shadows registered at load), not from pi.
      // The probe must still hand the built-in names to a research child,
      // which does not load the shadowing extension and gets pi's built-in
      // implementations. Probe with an empty knob (network off → built-ins
      // only), resolve the declared researcher tools against it, build a real
      // child with that allowlist, and require the child-loadout self-report
      // to show no allowlist-missing line.
      try {
        const shadowProbe = probeChildToolNames(pi, []);
        const shadowAllowlist = resolveTools(declared, shadowProbe.names) ?? [];
        const child = createResearchChildSession({
          cwd: sessionCwd,
          model: sessionModel,
          thinkingLevel: "off",
          extensions: [],
          tools: shadowAllowlist,
          systemPrompt: "You are a loadout check. Reply with exactly: pong",
          task: "Reply with exactly: pong",
          findingsPath: path.join(os.tmpdir(), "push-e2e-shadow-findings.md"),
        });
        children.push(child);
        let out = "";
        void (async () => {
          for await (const chunk of child.output) out += chunk;
        })().catch(() => {});
        await child.done;
        log(`(6) shadow probe names: ${[...shadowProbe.names].sort().join(", ")}`);
        log(`(6) resolved allowlist: ${shadowAllowlist.join(", ")}`);
        const ok =
          shadowProbe.names.has("read") &&
          shadowProbe.names.has("grep") &&
          shadowAllowlist.includes("read") &&
          shadowAllowlist.includes("grep") &&
          !out.includes("[child-loadout] allowlist missing from loadout:");
        log(ok ? "PUSH-E2E OK: gate 6 (shadowed built-ins stay available to the research child)" : "PUSH-E2E FAIL: gate 6");
      } catch (err) {
        log(`(6) shadow child FAILED: ${(err as Error).message}`);
        log("PUSH-E2E FAIL: gate 6");
      }
    })().catch((err) => {
      log(`push-e2e async body errored: ${(err as Error).stack ?? (err as Error).message}`);
    });
  });

  pi.on("session_shutdown", (event) => {
    log(`session_shutdown reason=${event.reason}; aborting ${children.length} tracked child session(s)`);
    for (const c of children) {
      try {
        c.abort();
      } catch {
        /* ignore */
      }
    }
    children.length = 0;
    log("PUSH-E2E OK: gate 4 (shutdown cleanup)");
  });
}
