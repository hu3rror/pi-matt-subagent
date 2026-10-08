# Per-task thinking levels ride pi's argument pass-through, honored without a schema declaration

> **Extends** ADR-0005 (thinking-level resolution priority): the per-task/per-step `thinkingLevel` field is honored even though no model-facing schema declares it.

> **Updated by issue #39**: the call-level public `thinkingLevel` parameter is removed from both tools (the randomness source); the per-task/per-step pass-through and `input.thinkingOverride` keep working as the deliberate escape hatches. The priority the per-task layer feeds becomes per-task/per-step > per-call override > `roleDefaults` > config default > role preset > inherited-minus-one.

A code-review re-run asked for high thinking; the model placed `thinkingLevel: "high"` inside each `tasks[]` item instead of at the call top level. The schema declares no such per-task field, so the call validated and ran, but the field never reached dispatch: both review subagents silently ran at their role-declared default (`medium`), and the requested `high` was lost. Investigation established why pi tolerated the field: pi validates tool-call arguments with a **check-only** contract (`Value.Convert` + `Validator.Check` — reject on mismatch, never strip), so unknown properties inside array items without `additionalProperties: false` pass validation **untouched** and reach the extension's `execute` verbatim. Confirmed two ways: reading the bundled pi source (`validateToolArguments` in the v1.0.0 bundle) and a throwaway real-pi probe (a lenient probe tool echoed the unknown nested key back byte-for-byte; a strict twin with `additionalProperties: false` had the whole call rejected with a field-path error). Because the field reaches the tool intact, the extension can honor it without declaring it in the model-facing schema.

## Decision

- **Read the per-task/per-step `thinkingLevel` at runtime** from the raw task/step objects pi passes through, threading it through the blocking plan → `RunnerTask` → per-run dispatch (`resolveDispatchThinking` in lib.ts gains a task-level parameter). No `TaskItem`/`ChainItem` schema change.
- **Resolution priority becomes**: per-task/per-step level > per-call override (public `thinkingLevel` param and hidden `input.thinkingOverride` share the same slot) > role-declared tier > config default > inherited main-session level.
- **Guidance over declaration**: the call-level `thinkingLevel` field gains a description ("Thinking level for the whole call (single, parallel, or chain); applies to every run"), so the common case lands in one place; per-task stays a robust fallback that honors whatever the model emits either way.
- **Invalid per-task values fail loudly**: the field is undocumented, so pi's union validation cannot cover it; the extension validates it against `THINKING_LEVELS` before any agent-confirm prompt or run registers, and returns the standard invalid-parameters error branch naming the offending item and the allowed list. A bad value must never reach `--thinking`.

## Considered options

- **Declare the field in the schema (rejected)**: contract-visible and future-proof against pi changing its pass-through, but two inline copies of the 7-level union cost ≈ +137 tokens and blow the ×1.2 token regression guard (subagent 531 → 668 > 638), forcing either a guard re-baseline or an asymmetric tasks-only/chain-gap. The pass-through is structural (pi never strips unknown keys; validation is check-only), so the runtime read is safe today and the budget is better spent on the description.
- **Reject unknown per-task keys loudly — `additionalProperties: false` (rejected as the mechanism)**: makes misplacement a visible error the model can retry from, but it would reject the very field we honor, so it is incompatible with the runtime read. It was verified (real-pi probe) to produce a readable field-path error; its only residual role would be policing future unknown keys, not this decision.
- **Descriptions only (no runtime read, rejected)**: cheapest, but keeps the silent-drop failure mode whenever the model misplaces the field — the exact bug being fixed.

## Consequences

- The observed failure mode is gone: the same model output that dropped `high` now runs the review at the intended level, with zero extra model turns.
- The model-facing surface grows only by the call-level description — measured +26 tokens (subagent 531 → 557), comfortably under the 638 guard; `research` unchanged (448).
- Runtime behavior depends on pi's check-only validation passing unknown nested keys through — verified empirically (real-pi probe, 2026-10-02, pi 1.0.0) and stable by construction. A future pi that strips unknown keys would silently re-open the drop; the S8c schema-acceptance test pins the data path and this ADR names the dependency.
- `single` mode has no per-task concept — its call-level `thinkingLevel` covers the run, and the per-task validator never fires for it.
