# Research redesign: in-process session, push delivery, one wall-clock cap

> **Supersedes** the background half of ADR-0001 (the file-mediated "read the findings path later" consequence) and the background half of ADR-0006 (tmp-file prompt assembly). **Retires** ADR-0003 and ADR-0008. The dual-channel decision of ADR-0001, the blocking half of ADR-0006 (argv-leak rationale), and the blocking `subagent` tool are untouched. Locked in the wayfinder map "Wayfinder map: Redesign the research feature (background + push delivery)" — charting record, Claude Code semantics research, and an in-process feasibility prototype.

The research feature is redesigned end-to-end: the background researcher moves from a detached `pi` subprocess to an **in-process second session** (`createAgentSession` + `SessionManager.inMemory()`), every terminal state is **pushed** into the main context via `pi.sendMessage` (`deliverAs: "followUp"` + `triggerTurn: true`) instead of being left for the main agent to poll, and the budget machinery shrinks to a **single wall-clock hard cap (default 60 minutes)** plus **checkpointed findings**. The cited Markdown findings file stays the canonical deliverable; the push carries a summary + path.

## Why the change

ADR-0001's background channel returned a handle and told the main agent to "read the findings path later" — a file-mediated polling model. The failure was not backgroundness itself but invisible completion: the main agent had to remember to poll, and a run cut mid-work left no signal. ADR-0003/0008 grew five budget dimensions and two enforcement layers to compensate for that blind spot. The redesign keeps background + push: the main agent keeps working, and the extension pushes the outcome in when the run reaches a terminal state. Claude Code's background-Task semantics (completion arrives as a notification in a later turn, no mid-turn interruption) is the model; pi maps it via `followUp` delivery (queued while the main agent is mid-turn, delivered when it has no more tool calls) + `triggerTurn` (idle → start a turn immediately).

## Execution base: in-process session

The researcher runs as an in-process second session: `createAgentSession({ sessionManager: SessionManager.inMemory(), ... })`. The child is built with `noExtensions: true` + `systemPromptOverride` (the researcher role prompt moves out of ADR-0006's 0600 tmp file into the override, so no role content touches argv), `model` inherited from the main session, thinking level passed through, and only built-in tools (no recursive extension re-entry). A throwing/failing child is isolated by try/catch + `.catch()` on the async body; children are disposed on `session_shutdown`. Startup cost ~170 ms. All four feasibility gates passed in the prototype: spawn from `session_start`, push via `sendMessage`, crash isolation, shutdown cleanup.

Consequence: research lifetime is **session-scoped**. A session that ends kills its in-process researchers. Checkpointed findings (written before each search round) bound the loss to the last checkpoint, and wayfinder's charting flow keeps findings on a throwaway branch so a later session resumes from them.

## Push delivery

On **every terminal state** — `succeeded`, `failed`, `terminated` (wall-clock kill), `aborted` (manual kill) — the extension pushes into the main context: `pi.sendMessage({ customType: "research-status", content, display, details }, { deliverAs: "followUp", triggerTurn: true })`. `content` is worded as an instruction to read the findings file (the pushed content becomes the triggered turn's prompt — verified in the prototype); `details` carries status, findings path, and on failure/termination the log location and last output, so partial work is preserved and reachable. A message renderer (`pi.registerMessageRenderer`) renders the push as a readable transcript card. `aborted` is pushed too: the main agent is told the research was stopped so it can decide next steps (re-run, continue from partial findings, abandon). The research tool's return text no longer says "read later"; it says the completion will be pushed.

## Budget: one wall-clock cap

The five budget/control dimensions (three soft + two hard) collapse to one hard dimension: **wall clock, default 60 minutes**, written as a single line into the researcher's prompt so the model self-manages. The log-size dimension is dropped entirely — no byte cap, no log measurement for enforcement; the per-run log survives only as the tee'd child-output file serving `/subagents tail` and post-mortem. `budget`/`budgetOverrides` are deleted from the research tool's public schema; a hidden input-JSON `maxWallClockMs` override (tighten-only, per ADR-0011) remains for callers who want a shorter cap. Findings are checkpoint-written before each search round, so any kill/crash loses at most the last checkpoint's delta. On a wall-clock kill the runner appends a slim `research-terminated` marker (`reason: wall_clock_exceeded`, `at`) to the findings file, so a standalone reader — a later session, or the file shipped as the deliverable — can tell truncation from completion without the push's context. No final notice, no grace period, no budget-status file: the checkpoints make the hard cut cheap, and the push tells the main agent the outcome.

## Run registry

The session-scoped registry, footer counter, and `/subagents` surface survive. `terminated` keeps its marker-grounded meaning, now with exactly one cause (wall clock). Manual kill moves from pid/OS-signal (ADR-0009) to aborting the in-process child session, still resolving `aborted` — and, per the push rule above, now also notifies the main agent. `prune` and `tail` are unchanged.

## Considered options

- **Detached subprocess (status quo)** — keeps cross-session survival and OS-level kill, but carries the JSON-mode protocol, log-file watcher, prompt-file assembly, and the polling blind spot the redesign exists to fix. Rejected after the in-process prototype passed all four gates on the locked criteria (stability > simplicity > startup cost).
- **File-mediated polling with better signaling** — incremental, but keeps the "main agent must remember to read" failure and a second marker-signaling channel that the push replaces for free.
- **Keeping the log-size backstop** — dropped by maintainer decision: one dimension (wall clock) suffices to stop runaways, and the 60-minute default reflects research-scale runs; the cost is up to 60 minutes of runaway log on disk, accepted.
- **Final notice + grace period (ADR-0008)** — deleted: continuous checkpoints bound a hard cut to one search round, so the 60s grace and budget-status-file polling no longer pay for their machinery.
- **Direct overwrite of the fork skills** — rejected for the redesign's skill rewrites: the skills track mattpocock upstream, and a local overwrite conflicts with that sync. Rewritten skill texts land as reviewed deliverables with the design (`docs/design/research-redesign/`); at implementation time they are applied as a patch after each upstream sync — an upstream PR is not viable.

## Consequences

- The `research` tool's public schema loses `budget`/`budgetOverrides`; its description, the `/research` prompt template, and the `research` skill are rewritten for push semantics. The token-benchmark baseline must refresh once that lands (implementation).
- The rewritten skill texts (the `research` skill replacement and the wayfinder step-5 edit) ship in `docs/design/research-redesign/` as design deliverables; applying them to the installed skills is implementation-time, as a patch after each mattpocock upstream sync.
- ADR-0003/0008's intent — every research run is guarded — carries on in the single wall-clock cap; their tier tables, wind-down, final notice, grace, and budget-status file are gone.
- Research runs are session-scoped: an ended session kills its researchers; checkpointing + branch persistence bound the loss. Wayfinder charting fires research and stops — findings may be partial if the session ends early; later sessions resume from the branch.
- `terminated` has exactly one cause (wall clock); `aborted` (manual kill) is pushed like every other terminal state.
- In-process isolation covers throwing/failing children; a hard process-level fault (OOM/segfault) can take the child and, being in-process, risks the main session — the accepted residual risk of the execution-base choice, recorded here rather than silently borne.
