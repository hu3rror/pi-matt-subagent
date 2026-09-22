# Tool error signaling: failed blocking subagent runs throw

A failed blocking subagent run (a chain step or a single run) used to return a successful tool result whose `isError: true` field was dead code: `AgentToolResult` has no `isError` member in either pi 0.85.1 or 0.86.0, and the harness derives error status only from throws — `executeToolCall` wraps `tool.execute` in a try/catch and converts a throw into an error result (`createErrorToolResult(message)` with `isError: true`, `details: undefined`). The model only ever saw the failure as text embedded in a success-marked result; the transcript likewise never marked the call as failed. We make the failure signal explicit: **the `subagent` tool throws for a failed blocking run**, with the thrown message carrying the exact text the failure branch previously put into `content`, so the model-visible copy stays byte-identical while the harness now marks the result as an error.

Scope of the change, deliberately narrow:

- **Chain step failure** throws `Chain stopped at step N (agent): <output>`;
- **Single run failure** throws `Agent <stopReason|failed>: <output>` (`stopReason` includes `aborted` — an aborted run is a failure and now surfaces as one, consistent with the existing throw from `runSingleAgent` on abort);
- Both messages are built by one pure function, `formatBlockingToolError(mode, { agent, step, stopReason, output })` in `src/lib.ts`, tested under `node --test` with known-good literals;
- Registry/footer updates run before the throw — the run record's terminal status is set and visible before the error escapes;
- **Parallel mode is unchanged**: it aggregates per-task status into one success result by design (partial failure is part of the deliverable, not a failed call); the **research tool is unchanged** (it returns a handle or a text error message — canceled/budget-error, or an unresolvable `model` override — never a "failed run" result). Parameter and resolution errors on the research path stay return-text by design, matching the blocking path's "Unknown agent" text; the ADR 0011 loud-failure contract covers `input` parsing/validation only.

## Considered options

- **Keep returning `{ content, details, isError: true }`** — rejected: the field is dead in both installed pi versions, so the branch pretended to signal failure without doing so; keeping it would preserve a misleading contract.
- **Return `{ content, details: { error } }` on failure** — rejected: the `subagent` tool's `details` is a live UI contract (`SubagentDetails` consumed by `renderResult`); swapping in an error shape on some paths would split the details type for one branch. Throwing lets the harness build the error result (`details: undefined`, which `renderResult` already tolerates) and matches the pi `AgentTool` guidance ("throw on failure instead of encoding errors in content").
- **Inline the message literals at the throw sites** — rejected: the message format is the behavior under test (red → green); building it in the pure, `node --test`-covered layer keeps the extension thin, consistent with ADR 0004's pure-layer split.

## Consequences

- Failed/aborted blocking runs are now harness-marked tool errors: `isError: true` derived from the throw, error text identical to the former content, and the TUI renders the call as an error.
- `renderResult` for an error result falls back to the message text (`details` is `undefined`), so error rows stay readable.
- The success-path `details` contract (`SubagentDetails`) is untouched; no transcript/UI shape change outside the error marking.
- The dead `isError` field is gone from the extension; `tsc --noEmit` against pi 0.86.0 is clean and the suite (124 tests) is green.
- `[NEEDS MANUAL VERIFICATION]` — live-session rendering of a failed subagent error result (error state row, message visibility) was not exercised against a running pi instance.