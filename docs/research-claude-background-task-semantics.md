# Research: Claude Code background task result-delivery semantics

**Context**: GitHub issue #20 (part of wayfinder map #18) — the reference model for redesigning this repo's `research` feature's push-message design (shape, content, delivery timing). Supersedes the earlier checkpoint of this file.

**Status**: COMPLETE (all prior TODOs resolved).

**Sources** (fetched 2026-05 from `code.claude.com/docs/en/*.md` and `github.com/mattpocock/skills`):
- Claude Code docs: `sub-agents` (https://code.claude.com/docs/en/sub-agents), `tools-reference` (https://code.claude.com/docs/en/tools-reference), `agent-view` (https://code.claude.com/docs/en/agent-view), `interactive-mode` (https://code.claude.com/docs/en/interactive-mode)
- mattpocock/skills: `skills/engineering/research/SKILL.md`, `skills/engineering/wayfinder/SKILL.md`
- pi 0.86.1 extension API: `docs/extensions.md` § `pi.sendMessage` (local package)

---

## 1. How a background subagent (background Task) reports completion

Source: https://code.claude.com/docs/en/sub-agents, "Run subagents in foreground or background"

- **Push, not poll.** "A background subagent's results reach Claude as a **completion notification in a later turn**. Claude waits for that notification before reporting the subagent's results, and if you ask about progress first, it reports that the subagent is still running." (Before v2.1.211, Claude sometimes reported results for a background subagent that hadn't finished.)
- **Timing / interruption**: the docs only describe arrival "in a later turn"; nothing anywhere documents the notification interrupting Claude mid-turn. Forks state the same push shape: "When it finishes, its result arrives **as a message** in your main conversation" (sub-agents, "Fork the current conversation"). The documented model is: the main turn runs to completion; the completion notification is consumed at a turn boundary. [TODO from checkpoint resolved: no evidence of mid-turn interruption; "later turn" + "waits for that notification" is all the docs commit to.]
- **UI side-effects** (success): the completed subagent's row is removed from the subagent panel immediately; the footer shows `/tasks to see subagents` for 30 seconds; the completed subagent stays listed in `/tasks`, marked done and sorted below running work, for the same 30 seconds, with its detail view staying open. (Before v2.1.232, the row was kept 30s with no footer hint.)
- **UI side-effects** (failure/stop): the row stays 30 seconds; failed/stopped subagents leave `/tasks` immediately.
- **Failure path** (v2.1.199+): "**Background**: the subagent is marked failed, and the message Claude receives when it ends names the API error and includes the subagent's last output, so partial work isn't lost." (sub-agents, "API errors in subagents") — partial work is preserved in the completion message, not dropped.
- **Permission prompts from background subagents** surface in the main session (v2.1.186+), naming the subagent; Esc denies that one tool call without stopping the subagent. (Before v2.1.186 they were auto-denied.)

## 2. What the main agent receives

Source: https://code.claude.com/docs/en/tools-reference, "Agent tool behavior"

- **The full final report text, not a summary-plus-reference.** "The subagent works through its task autonomously, then returns its result to the parent conversation. The parent doesn't see the subagent's intermediate tool calls or outputs, **only that final result**."
- The "summary" nature is a **convention**, not a mechanism: subagents are told to return a concise final report, so the full-but-short final message is what arrives. (sub-agents, "Common patterns": "only the relevant summary returns to your main conversation" — an instruction to the subagent, not a truncation.)
- **Context cost is real**: "When subagents complete, their results return to your main conversation. Running many subagents that each return detailed results can consume significant context." (sub-agents, "Run parallel research") — the deliverable is text in the main context, not a pointer.
- **Partial results**: on `maxTurns` exhaustion the returned output is marked as **partial** and, when the subagent returns an agent ID, the result notes Claude can message the subagent to continue. (v2.1.246+ for the partial marking.)
- **Resume / continue**: "When a subagent completes, Claude receives its agent ID." Claude resumes a completed subagent with the `SendMessage` tool (`to` = agent ID or name); the subagent resumes in the background without a new Agent invocation. Name-mismatch safety: v2.1.199+ refuses a send when a newer agent reused the name.
- **Output scanning** (v2.1.210+): every subagent final report is scanned for instruction-shaped text (backslash insertion + optional `[harness: ...]` marker line) **before Claude reads it** — the parent never receives a raw report.
- Contrast — where Claude Code *does* use "summary + reference" shapes, it's separate surfaces, not the subagent completion path:
  - `SendMessage`'s optional `summary` input (typically 5–10 words) shows as a one-line preview (tools-reference, `SendMessage` row; cross-session messaging).
  - Agent view (background *sessions*, a different feature from background *subagents*) shows a Haiku-generated one-line summary per session row, with the transcript a peek away (agent-view, "Row summaries").
  - Background **Bash** commands: the result of a command moved to background reports the task ID + the path of the file the output is being written to — a genuine file-mediated "reference" pattern (tools-reference, "Background commands"; interactive-mode, "How backgrounding works": "Output is written to a file and Claude can retrieve it using the Read tool").

## 3. Retrieving a background task's output: polling vs push

Source: https://code.claude.com/docs/en/tools-reference (tools table; "Task tool availability")

- `TaskOutput` — "Retrieves output from a background task. **Deprecated in favor of `Read` on the task's output file path.** When no task matches the ID, the error lists the running background agents by ID and description." [TODO resolved: no blocking/polling semantics are documented anywhere in tools-reference or interactive-mode — retrieval is pull-via-Read on a file path, and the push side is the completion notification in §1.]
- `TaskStop` — stops a running background task by ID; also accepts an agent-team teammate or a named background agent by ID or name (v2.1.198+).
- Background subagents **never get `TaskOutput`** (removed by the first tool filter; sub-agents, "Available tools").
- Don't confuse the two tool families: `TaskCreate`/`TaskGet`/`TaskUpdate`/`TaskList`/`TodoWrite` manage the session's **to-do checklist**, not background tasks; they're gated by model (default only on Claude 3.x / Opus 4–4.7 / Sonnet 4–4.6 / Haiku 4.5, opt-in elsewhere). `TaskOutput`/`TaskStop` are the background-task tools.

## 4. What mattpocock/skills assumes

### research skill (`skills/engineering/research/SKILL.md`, full file, 794 bytes)

> "Spin up a **background agent** to do the research, so you keep working while it reads."
> Its job: (1) investigate against primary sources, follow every claim back to the source that owns it; (2) write findings to a single Markdown file, citing each claim's source; (3) save it where the repo keeps such notes, match existing convention.

Assumptions: background execution; main agent keeps working; **the deliverable is a file on disk** — the completion signal only needs to carry a path/reference, not the findings themselves. The skill says nothing about message shape or delivery timing; it treats the file as canonical and the notification as a "whenever it lands, read it later" event.

### wayfinder skill, "Fire the research subagents" (charting, step 5)

> "For each `research` ticket you just created, spin up a subagent that calls the Skill tool with 'research' to resolve it **in parallel**, capturing its findings on a throwaway `research/<name>` branch with a context pointer from the ticket."

The launch is a **subagent** (per Claude Code, an Agent-tool subagent; in pi terms, a `research` background process) that itself invokes the research skill; the ticket's findings land on a named branch and the ticket carries a pointer to them. In "work through the map" resolution mode, the same file-on-disk deliverable is posted as a resolution comment, the issue closes, and the map's Decisions-so-far gets a one-line context pointer.

### Implications for pi's redesign

The skills' contract is: **file is canonical, notification is a lightweight "done + where" signal**. The push message does not need to carry the findings — carrying a summary + path matches both the skills' assumption and Claude Code's own background-Bash pattern (§2, "summary + reference" file-mediated shape). Claude Code's subagent path itself delivers the full report text, which is *heavier* than what the skills need; the redesign is not obliged to mirror that weight.

## 5. Concurrency and env knobs (numbers locked)

Source: https://code.claude.com/docs/en/sub-agents, "Concurrent subagent limit" + "Run subagents in foreground or background"

- **Concurrent limit: 20 by default.** "when 20 subagents are running in a session, spawning another with the Agent tool fails with `Concurrent subagent limit reached`" (v2.1.217+; error tells Claude not to retry). Adjust with `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (any positive whole number). Sessions with ultracode active are exempt.
- Resuming a subagent that already finished takes a fresh slot **without checking the limit**, so resumes can push the count past it.
- `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` forces foreground everywhere.
- Fork mode (on by default in interactive sessions, v2.1.232+): all Agent-spawned subagents run in the background; Claude can't request foreground. Off in non-interactive `-p` / Agent SDK unless turned on.
- Background subagents get a reduced built-in tool set (sub-agents, "Available tools"): Read, Grep, Glob, Bash, PowerShell, Edit, Write, NotebookEdit, WebFetch, WebSearch, TodoWrite, Skill, ToolSearch, EnterWorktree, ExitWorktree, Monitor, TaskStop, SendMessage, Artifact, plus `SubagentHandback` when applicable. Never `TaskOutput`, `AskUserQuestion`, `ExitPlanMode` (unless permissionMode plan), `EndConversation`, `ScheduleWakeup`, `WaitForMcpServers`, `Workflow`, `Agent` (at depth limit).
- Nesting: default max 3 layers below the main conversation (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`; v2.1.219+). Interactive launcher waits for its nested background subagents before finishing; non-interactive/SDK launchers don't wait — a nested background subagent that outlives its launcher reports to the main conversation instead.
- Session search limit: 200 WebSearch calls per session across the main conversation and every subagent (v2.1.212+).

## 6. Mapping to pi's push-message design (the point of this research)

Source: pi 0.86.1 `docs/extensions.md` § `pi.sendMessage`

```typescript
pi.sendMessage({ customType, content, display, details }, {
  triggerTurn: true,
  deliverAs: "followUp",
});
```

- `deliverAs: "steer"` (default) — queued while streaming; delivered after the current assistant turn finishes executing its tool calls, before the next LLM call.
- `deliverAs: "followUp"` — waits for the agent to finish; delivered only when the agent has no more tool calls.
- `deliverAs: "nextTurn"` — queued for the next user prompt; interrupts/triggers nothing.
- `triggerTurn: true` — if the agent is idle, trigger an LLM response immediately; only applies to `"steer"`/`"followUp"`.

Correspondence with Claude Code's model (issue #21 already locked `followUp` + `triggerTurn`):

| Claude Code (background subagent) | pi `sendMessage` |
|---|---|
| Results reach Claude "in a later turn"; Claude waits for the notification before reporting | `followUp` — delivered only when the agent has no more tool calls |
| Notification prompts Claude to report the result (idle main agent gets a turn) | `triggerTurn: true` — if idle, trigger an LLM response immediately |
| No documented mid-turn interruption of the main turn | `steer` exists but is not the chosen mode; `followUp` guarantees no mid-turn injection |
| Completion message carries the full final report | The locked design carries **summary + path** — deliberately lighter, matching the skills' file-canonical contract (§4) and Claude Code's own background-Bash reference pattern, not the subagent-report weight |
| Partial work preserved on failure (last output included) | Design implication: the push on failure should carry the log/findings path so partial work isn't lost — Claude Code's failure message "includes the subagent's last output" is the precedent |

**Deliberately not documented in Claude Code** (flagged for #19's ADR): what happens when the main agent is *mid-turn* when the completion lands (docs only say "in a later turn"); and any explicit guarantee about notification delivery when the main session is busy vs idle. The pi side chooses `followUp` precisely to define this: delivery happens only at a safe boundary.

## 7. Behaviors worth mirroring or avoiding (distilled)

- **Mirror**: push-notify with a path, not the payload (skills' contract); preserve partial work on failure by naming where the partial output lives; deliver at a safe boundary (no mid-turn injection); per-session concurrency guard with a documented limit.
- **Avoid**: making the main agent's context pay for full findings (Claude Code's own context warning); any "read the file later" handshake that requires the main agent to remember to poll (Claude Code's model is push, and the skills say "keep working while it reads").
- The `research/<name>` branch + context-pointer convention from wayfinder step 5 is the skill-layer pattern this repo's findings files already follow (`docs/research-*.md`), and #19 will need the findings-file location convention sharpened (map #18, "Not yet specified").
