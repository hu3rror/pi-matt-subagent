# Tool error signaling: failed subagent calls return `isError: true` with the failed run's terminal info

> **Supersedes** ADR-0010 (the throw-only tool-error contract). The parallel aggregate semantics and the input-JSON loud-throw contract (ADR 0011) survive as the rule's explicit exceptions. Survey adoption on pi 0.99.1: the harness now honors `isError` on returned tool results (`AgentToolResult`, pi ≥ 0.99.1), which is the version premise ADR-0010's "returned field is dead code" argument was built on — that premise is void, so the contract flips.

ADR-0010 chose **throw** as the carrier because in pi ≤ 0.86 returned tool results had no live `isError` member: the harness derived error status only from throws, and a returned `isError` field was dead code. On pi 0.99.1 that premise is void — a tool may return an error result (`{ ..., isError: true }`) and the harness, the transcript, and the model all treat it as a failed call. We adopt the returned-error contract and fold the failure signal into the tool result itself, where the run's terminal info can ride along.

## Decision

One coverage rule for the `subagent` tool (and, on adoption, the `research` tool):

> **A tool call that completed returns a success-marked result; a call that did not complete returns `isError: true` with content unchanged.**

Two explicit exceptions, unchanged:

- **Parallel aggregate**: partial failure is part of the deliverable — parallel still returns one success-marked result aggregating per-task statuses (even when every task fails).
- **Input-JSON parse errors**: transport-level failures stay loud throws (ADR 0011).

### Conversion point (Q1=A)

The conversion happens at the **tool boundary**, not in the orchestrator: `subagent.execute` records the run-registry snapshot length before delegating, wraps the blocking orchestrator in try/catch, and converts any throw into a returned error result whose `content` carries the thrown message **byte-identical** to the former throw text. The orchestrator (`runBlockingPlan`), the `formatBlockingToolError` message builder, and the abort path are untouched and keep throwing internally — their tests stay green, and the tool-level conversion is the only new behavior.

### Error details payload (Q2=b)

An error result's `details` carries the failed run's terminal info, so the transcript row explains the failure without opening `/subagents` (the direct motivation: a failed blocking run previously rendered as a bare error text with no agent, usage, model, or thinking level):

```ts
details.error?: {
  status: "failed" | "aborted";
  agent: string;
  agentSource: string;
  usage?: UsageStats;
  model?: string;
  thinkingLevel?: string;
}
```

The payload is shaped by a pure helper (`toolErrorDetails(snapshot, sinceIndex)`, lib.ts, `node --test`-covered) from the run registry: only runs **this call** registered (the delta after the base snapshot index) are considered, and the first one that ended `failed`/`aborted` is the failure the thrown error reported. A throw that is not a run failure (an internal bug) yields no payload — the same `details: undefined`-equivalent the harness's throw path produced. The success-path `details` shape (`SubagentDetails`) is unchanged; `error` is an optional member present only on the error-marked path. The error row renders icon + agent (source) + message text + usage/model/thinking line (`aborted` keeps the registry's `⊘` iconography).

### Coverage (Q3=3b)

Branches that now return `isError: true` instead of a success-marked result:

- single / chain-step failure and blocking abort (previously thrown; aborted is a failure, as before);
- subagent invalid-parameters (no/conflicting mode) — success-marked text previously; the recovery text ("Available agents: …") is kept byte-identical;
- subagent project-agent refusal ("Canceled: …") — success-marked text previously.

Research's not-completed branches (project-agent refusal, unresolvable `model` override, runner-startup failure) migrate with the structured-receipt adoption (ADR 0017); until then they keep their current signaling.

## Considered options

- **Keep throwing (ADR-0010 unchanged)** — rejected: on pi 0.99.1 the returned-error contract is first-class, and a throw forfeits the ability to carry the failed run's terminal info in `details` (the harness's throw-derived error result is `details: undefined`).
- **Convert in the orchestrator instead of the boundary** — rejected: the orchestrator is a pure, `node --test`-covered seam pinning the throw contract; converting there would either duplicate the message text into returns or break the pure/testable split (ADR 0004). The boundary conversion keeps one behavior change at one place and leaves the orchestration tests untouched.
- **Return `{ content, details: { error } }` without `isError`** — rejected: that is exactly ADR-0010's dead-field trap again; the error marking is the point, the details are the enrichment.

## Consequences

- Failed/aborted subagent calls are now **returned** error results (`isError: true`): the harness marks the call failed, the transcript renders the rich error row via the existing `renderResult` (new `error` branch), and the model sees the same message text as before the adoption.
- The dev-time compile seam moves to pi 0.99.1 (four pi packages in `devDependencies` at `^0.99.1`): `isError` on tool results does not exist in the 0.86.1 types the gate previously compiled against, so the gate could not see the contract drift; it now enforces the adopted contract for real.
- Coverage is uniform and documented: completed → success, not-completed → `isError: true`, with the parallel and input-JSON exceptions carved out in the ADR and the glossary.
- Persistent run info: the failed run's registry entry was already terminal before the throw ever escaped (frozen-update-first invariant), so `toolErrorDetails` reads a settled snapshot; the error payload is a detached usage copy.
- `[NEEDS MANUAL VERIFICATION]` — the live transcript rendering of the error row (icon, message, usage line) under a real pi session via the existing real-pi e2e script.