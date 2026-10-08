# Subagent thinking levels default to a role-declared tier, overridable per call

> **Extended by** ADR-0020: a per-task/per-step `thinkingLevel` (an undocumented field pi passes through untouched) now sits above the per-call override, so the priority is per-task/per-step > per-call override > role-declared tier > config default (ADR 0018) > inherited default.

> **Updated by issue #39 (deterministic thinking levels).** The decision-source priority becomes per-task/per-step > per-call override (`input.thinkingOverride`) > `roleDefaults` per-role tier > config default > role preset > **inherited-minus-one** (the main-session level, strictly one tier down in `THINKING_LEVELS`; `off` stays `off`). The public call-level `thinkingLevel` parameter is removed from both tools — the randomness source — and the `set-thinking-level` tool becomes the only model-visible channel for changing effort. `dispatchDefaultThinkingLevel` moved above the role-preset layer, so it is no longer dead for the six embedded roles. The capability-layer clamp (upstream `clampThinkingLevel`, upward-first) is unchanged and applies to whatever the decision layers produce; requested/effective dual recording stays. The `hasModel` short-circuit skips **only** the inherited-minus-one layer. See ADR 0011/0018/0020/0022 notes.

Subagents used to blindly inherit the main session's default `thinking=high`: complex tool-driven tasks (e.g. "run git yourself") under `deepseek-v4-flash` spun at the top level and never converged within the budget. Every subagent run now resolves its thinking level explicitly via `resolveThinkingLevel` with priority **per-task/per-step level > per-call override > role-declared tier > config default > inherited default** (the config layer is ADR-0018, the per-task layer ADR-0020), and embedded roles declare differentiated defaults: `standard`/`spec`/`architecture`/`design`/`researcher` → `medium`, `fact-finder` → `low`. A role may declare its default in frontmatter (`thinkingLevel: <level>`), and the `subagent`/`research` tools accept a per-call `thinkingLevel` escape hatch so a caller can override without editing the role. `THINKING_LEVELS` in lib.ts is the single source for the enum, validated at runtime by a TypeBox Union (illegal values fail loudly, not silently).

Model-pinned roles are handled defensively: `deepseek-v4-flash`'s map is `{off:none, minimal:low, low:low, medium:medium, high:high}` — it has no `xhigh`/`max` tiers. When a role pins a model whose map lacks the resolved level, `undefined` is passed and no `--thinking` flag is emitted at all, rather than sending an unsupported value.

## Considered options

- **Inherit high everywhere (status quo)** — simplest, but expensive and non-convergent: one complex call can burn the whole budget spinning at the top tier on a model whose top tier is already `high`.
- **Fixed level for all subagents** — one size fits all, but fact-finding doesn't need the same depth as architecture design, and callers lose control per task.
- **Role-declared tier + per-call override (chosen)** — embedded roles pick a sensible per-skill default, callers can adjust per task, and custom roles opt in via frontmatter; the resolve rule is a pure function in lib.ts (TDD'd with the extension as a pass-through).

## Consequences

- The resolved level must travel from the tool call down to the child spawn (`buildDispatchArgs`/`buildResearchArgs`), so a wrong level is caught at one pure-function seam.
- Model-pinned roles that don't support the resolved level silently run without a `--thinking` flag rather than with an invalid value — safe, but the caller doesn't see that the intent was dropped.
- Takes effect only after an extension reload in a live session (the running session keeps the old code); verified once, not a permanent caveat.
