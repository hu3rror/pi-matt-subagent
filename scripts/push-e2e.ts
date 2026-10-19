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
 * Later gates extend the same seam: 5/5b pin the research-child loadout
 * (issue #37/#44), 6 pins built-in shadowing (issue #43), and 7, 8, 9b pin the
 * in-process lifecycle contract (issues #46/#47/#48): emission ordering
 * against a live child, abort-before-start silence, and binding's effect on
 * the child's output and loadout reporting.
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
import {
  EMBEDDED_ROLES,
  SUBAGENT_CHILD_BOUND,
  SUBAGENT_CHILD_DISPOSED,
  SUBAGENT_CHILD_SESSION_CREATED,
  researchChildAllowlist,
  resolveTools,
} from "../src/lib.ts";

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

      const declared = EMBEDDED_ROLES.researcher.tools ?? [];
      for (const q of ["web_access", "query-docs", "resolve-library-id"]) {
        if (declared.includes(q)) throw new Error(`default researcher role still declares ${q} — activation-follows-load expects built-in names only`);
      }

      // Gates 7-9b — issue #48: the in-process lifecycle contract
      // (#46/#47) observed against a live research child. This is the only
      // seam that sees the factory's emission timing: a child wired like
      // production (onLifecycle -> pi.events.emit) announces session-created
      // synchronously after session creation and before bindExtensions, bound
      // after binding resolves on the success path only, disposed in the
      // run's finally.
      const subscribeLifecycle = () => {
        const events: Array<{ channel: string; payload: Record<string, unknown> }> = [];
        const unsubs = [
          pi.events.on(SUBAGENT_CHILD_SESSION_CREATED, (payload) =>
            events.push({ channel: SUBAGENT_CHILD_SESSION_CREATED, payload: payload as Record<string, unknown> }),
          ),
          pi.events.on(SUBAGENT_CHILD_BOUND, (payload) =>
            events.push({ channel: SUBAGENT_CHILD_BOUND, payload: payload as Record<string, unknown> }),
          ),
          pi.events.on(SUBAGENT_CHILD_DISPOSED, (payload) =>
            events.push({ channel: SUBAGENT_CHILD_DISPOSED, payload: payload as Record<string, unknown> }),
          ),
        ];
        return { events, unsubscribe: () => unsubs.forEach((u) => u()) };
      };
      const wireLikeProduction: NonNullable<Parameters<typeof createResearchChildSession>[0]["onLifecycle"]> = (
        announcement,
      ) => {
        pi.events.emit(announcement.channel, announcement.payload);
      };

      // One shared child-run helper for every gate that only needs the child's
      // output: create (with the session's captured cwd/model), track, tee to
      // a string, await done. Gates 5/5b/6/9/9b all assert on this same
      // output, so a factory-shape change cannot drift them apart (the
      // loadout gates' own comment promises exactly this).
      const runChildSession = async (opts: {
        extensions: string[];
        tools: string[];
        systemPrompt: string;
        task: string;
        findingsPath: string;
        parentSessionId?: string;
        onLifecycle?: NonNullable<Parameters<typeof createResearchChildSession>[0]["onLifecycle"]>;
      }): Promise<string> => {
        const child = createResearchChildSession({
          cwd: sessionCwd,
          model: sessionModel,
          thinkingLevel: "off",
          extensions: opts.extensions,
          tools: opts.tools,
          systemPrompt: opts.systemPrompt,
          task: opts.task,
          findingsPath: opts.findingsPath,
          parentSessionId: opts.parentSessionId,
          onLifecycle: opts.onLifecycle,
        });
        children.push(child);
        let out = "";
        void (async () => {
          for await (const chunk of child.output) out += chunk;
        })().catch(() => {});
        await child.done;
        return out;
      };

      // Gate 7 — a real research child run emits the three events in the
      // convention's order (created before bind, bound after, disposed in the
      // finally), one stable sessionId across all three, and the parent id on
      // created/bound only (the disposed payload omits the key).
      {
        const { events, unsubscribe } = subscribeLifecycle();
        try {
          const child = createResearchChildSession({
            cwd: sessionCwd,
            model: sessionModel,
            thinkingLevel: "off",
            tools: ["read", "grep"],
            extensions: [],
            systemPrompt: "You are a lifecycle check. Reply with exactly: pong",
            task: "Reply with exactly: pong",
            findingsPath: path.join(os.tmpdir(), "push-e2e-lifecycle-findings.md"),
            parentSessionId: "e2e-parent",
            onLifecycle: wireLikeProduction,
          });
          children.push(child);
          await child.done;
          const ids = events.map((e) => String(e.payload.sessionId));
          const ok =
            events.length === 3 &&
            events[0].channel === SUBAGENT_CHILD_SESSION_CREATED &&
            events[1].channel === SUBAGENT_CHILD_BOUND &&
            events[2].channel === SUBAGENT_CHILD_DISPOSED &&
            ids.every((id) => id.length > 0) &&
            new Set(ids).size === 1 &&
            events[0].payload.parentSessionId === "e2e-parent" &&
            events[1].payload.parentSessionId === "e2e-parent" &&
            !("parentSessionId" in events[2].payload);
          log(
            ok
              ? `PUSH-E2E OK: gate 7 (emission order created → bound → disposed, stable sessionId ${ids[0]}, parent id on created/bound only)`
              : `PUSH-E2E FAIL: gate 7 (channels=${events.map((e) => e.channel).join(",")}, sessionIds=${ids.join(",")})`,
          );
        } catch (err) {
          log(`(7) lifecycle child FAILED: ${(err as Error).message}`);
          log("PUSH-E2E FAIL: gate 7");
        } finally {
          unsubscribe();
        }
      }

      // Gate 8 — an abort-before-start child (killed between session creation
      // and binding) emits nothing on any lifecycle channel: the registry must
      // never see a child that never ran. The synchronous abort() lands inside
      // the async creation window, so the factory's post-creation abort check
      // fires before any emission.
      {
        const { events, unsubscribe } = subscribeLifecycle();
        try {
          const doomed = createResearchChildSession({
            cwd: sessionCwd,
            model: sessionModel,
            thinkingLevel: "off",
            tools: ["read"],
            extensions: [],
            systemPrompt: "You are a lifecycle check.",
            task: "reply with one word",
            findingsPath: path.join(os.tmpdir(), "push-e2e-abort-before-start-findings.md"),
          });
          children.push(doomed);
          doomed.abort();
          let settle: "resolved" | "aborted" | "other" = "other";
          try {
            await doomed.done;
            settle = "resolved";
          } catch (err) {
            settle = String((err as Error).message).includes("research child aborted before start")
              ? "aborted"
              : "other";
          }
          const ok = settle === "aborted" && events.length === 0;
          log(
            ok
              ? "PUSH-E2E OK: gate 8 (abort-before-start child emits no lifecycle events)"
              : `PUSH-E2E FAIL: gate 8 (settle=${settle}, events=${events.length})`,
          );
        } catch (err) {
          log(`(8) abort-before-start child errored unexpectedly: ${(err as Error).message}`);
          log("PUSH-E2E FAIL: gate 8");
        } finally {
          unsubscribe();
        }
      }

      // Gate 9 / 9b — binding does not disturb the child's output or loadout
      // reporting (parent issue #45's known-risk check). A real child binds
      // (session_start fires, the loadout report is computed post-binding, the
      // prompt starts) and must still speak the loadout line first, then the
      // created/prompt stage lines in order, then its exact reply — nothing
      // injected before the loadout line. The exact "pong" reply is a
      // supporting behavioral check (the child followed the override's
      // instruction exactly); the re-assembly verdict comes from the
      // loadout-specific comments below.
      {
        const run = async (opts: {
          label: string;
          extensions: string[];
          tools: string[];
          firstLineCheck: (firstLine: string) => boolean;
          okMessage: string;
        }) => {
          try {
            const out = await runChildSession({
              extensions: opts.extensions,
              tools: opts.tools,
              systemPrompt: "You are a loadout check. Reply with exactly: pong",
              task: "Reply with exactly: pong",
              findingsPath: path.join(os.tmpdir(), `push-e2e-bind-${opts.label}-findings.md`),
              onLifecycle: wireLikeProduction,
            });
            const lines = out.split("\n").filter((l) => l.length > 0);
            const firstLine = lines[0] ?? "";
            const lastLine = lines[lines.length - 1] ?? "";
            const createdIdx = lines.findIndex((l) => l.includes("[run] ") && l.includes("session created"));
            const promptIdx = lines.findIndex((l) => l.includes("[run] ") && l.includes("prompt started"));
            log(`(9${opts.label}) bound child output (${lines.length} lines):`);
            lines.forEach((l) => log(`  ${JSON.stringify(l)}`));
            const ok =
              opts.firstLineCheck(firstLine) &&
              lastLine === "pong" &&
              createdIdx >= 1 &&
              promptIdx > createdIdx &&
              !lines.some((l) => l.includes("[child-loadout] allowlist missing"));
            log(
              ok
                ? `PUSH-E2E OK: gate 9${opts.label} (${opts.okMessage})`
                : `PUSH-E2E FAIL: gate 9${opts.label} (firstLine=${JSON.stringify(firstLine)}, lastLine=${JSON.stringify(lastLine)}, createdIdx=${createdIdx}, promptIdx=${promptIdx})`,
            );
          } catch (err) {
            log(`(9${opts.label}) bound child FAILED: ${(err as Error).message}`);
            log(`PUSH-E2E FAIL: gate 9${opts.label}`);
          }
        };

        // The quiet default (empty knob): the loader keeps zero extensions,
        // so the child's runner has no resources_discover handlers and
        // extendResourcesFromExtensions returns before any rebuild — system
        // prompt re-assembly is structurally impossible for this loadout.
        // Observed live: the bound child speaks exactly the loadout line, the
        // two stage lines, and the exact reply, with nothing injected — the
        // re-assembly finding is closed (structurally absent, behaviorally
        // unchanged).
        await run({
          label: "",
          extensions: [],
          tools: declared,
          firstLineCheck: (firstLine) =>
            firstLine.includes("[loadout] info · no query packages configured") && firstLine.includes("built-in tools only"),
          okMessage: "loadout line first, stage lines intact, reply unchanged by binding",
        });

        // The loaded-package case is the only place re-assembly could fire: a
        // knob package's resources_discover handlers would extend the child's
        // resources and rebuild the system prompt. No knob package is
        // installed here, so the case is unverifiable and fails loudly —
        // matching gate 5b's stance — instead of claiming confirmation it did
        // not make. When a package IS installed, the run below pins that the
        // loadout line and the output stay unchanged.
        try {
          const knob = ["npm:@ssk_dev/pi-web-access-lean"];
          const probe = probeChildToolNames(pi, knob);
          if (probe.packageToolNames.length === 0) {
            throw new Error("web-access-lean not installed — gate 9b cannot verify binding side effects with a loaded package");
          }
          const allowlist = researchChildAllowlist({
            declared,
            availableToolNames: probe.names,
            platform: process.platform,
            packageTools: probe.packageToolNames,
            explicit: false,
          }).tools;
          await run({
            label: "b",
            extensions: knob,
            tools: allowlist,
            firstLineCheck: (firstLine) => firstLine.includes("[loadout] ok · loaded") && firstLine.includes("web_access"),
            okMessage: "loaded package's loadout line first, stage lines intact, reply unchanged by binding",
          });
        } catch (err) {
          log(`(9b) loaded-package binding gate FAILED: ${(err as Error).message}`);
          log("PUSH-E2E FAIL: gate 9b");
        }
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
          const out = await runChildSession({
            extensions: opts.extensions,
            tools: opts.tools,
            systemPrompt: "You are a loadout check. Reply with exactly: pong",
            task: "Reply with exactly: pong",
            findingsPath: path.join(os.tmpdir(), `push-e2e-knob-${opts.label}-findings.md`),
          });
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
        const out = await runChildSession({
          extensions: [],
          tools: shadowAllowlist,
          systemPrompt: "You are a loadout check. Reply with exactly: pong",
          task: "Reply with exactly: pong",
          findingsPath: path.join(os.tmpdir(), "push-e2e-shadow-findings.md"),
        });
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
