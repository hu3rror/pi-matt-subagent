# Expose the per-run `model` override as a public field (reversing half of ADR 0011)

> **Supersedes** the hidden-`model` half of ADR 0011. The per-run `model` override is now a public field on both `subagent` and `research`; the `input` channel keeps only `thinkingOverride` (`subagent`) and `maxWallClockMs` (`research`). The merge/validation contract (ADR 0011) is untouched, and `input`-based `model` callers keep working (merged and validated as before — just no longer hidden).

> [ZH] 事故驱动反转：会话里口头要求"用指定模型 + 指定思考强度跑 subagent"被主模型漏掉——隐藏通道（`input` 里的 `model`）对主模型不可靠：sensenova-6.8-flash-lite 主会话 4 次 subagent 调用 0 次使用该通道，明确要求的 model 覆盖静默回退到 config 默认（`matt-subagent.json` 的 `dispatchDefaultModel`），且"max think"被降成 xhigh 落地。`model` 改为两个工具的公开字段（+16 token/工具，Seam E 实测 573/464，距 ×1.2 守卫上限 688/557 仍远）；`input` 仅剩 `thinkingOverride` / `maxWallClockMs`；`input` 里旧式 `model` 经 `{...parsed, ...direct}` 合并仍通过校验（向后兼容，只是不再 hidden）。

## Why the reversal

ADR 0011 hid `model` behind the `input` escape hatch to keep the model-facing surface slim (the lightweight-subagents-facade lesson: every schema field is a per-call recurring token cost). The premise was that per-run model overrides are low-frequency and can afford the indirection.

That premise failed in practice. In a real session the user asked the main agent to run a review with a specific model and thinking level; the main agent reasoned about the request correctly, then emitted a `subagent` call whose arguments carried **no model at all** (and a downgraded thinking level). The override silently fell back to the configured `dispatchDefaultModel`, so the run went out on the wrong model with no error and no warning. Audit of the session logs quantified the pattern:

- The failing main model (`sensenova/sensenova-6.8-flash-lite`) used the `input` channel **0 of 4** subagent calls across its sessions.
- Across all recorded sessions, 230 subagent calls used `input` only 7 times total — a channel most main models simply do not construct, even when the tool description advertises it.

A hidden channel that models demonstrably drop is worse than no override at all: the failure mode is silent (falls back to the default), which is exactly what an override feature must never do. Reliability wins over footprint.

## Decision

- `SubagentPublicFields` and `ResearchPublicFields` each gain `model: Type.Optional(Type.String({ description: "Model override for this run (provider/id)." }))`.
- The `input` descriptions no longer advertise `model`; `SUBAGENT_INPUT_KEYS` becomes `["thinkingOverride"]`, `RESEARCH_INPUT_KEYS` becomes `["maxWallClockMs"]`.
- The full dispatch schemas keep `model` (now via the public-field spread, not a duplicated declaration); `additionalProperties: false` validation and the `{...parsed, ...direct}` merge are unchanged, so a legacy `input` payload carrying `model` still validates and dispatches (backward compatible).
- Dispatch precedence is unchanged: `merged.model` (direct field or `input` JSON) > `dispatchDefaultModel` > inherited session model.

## Measured cost

Seam E (pi 1.0.2, `node scripts/benchmark-tools.ts`, ceil(chars/4)):

| Tool | Before (pi 1.0.2) | After | Δ |
| --- | --- | --- | --- |
| `subagent` | 557 | 573 | +16 |
| `research` | 448 | 464 | +16 |

Guard ceilings rise to 688 / 557 — the ×1.2 regression guard is far from tripped. `TOKEN_BASELINE`, the README numbers, and the surface contract tests are updated with the re-measured values.

## Considered options

- **Keep `model` hidden** — the silent-fallback failure recurs every time a main model drops the channel; rejected.
- **Expose `model` only** — adopted. +16 tokens/tool buys a channel models see as a first-class schema field, alongside the already-public `thinkingLevel`.
- **Expose `thinkingOverride` too** — rejected: +82 tokens total (ADR 0019's entire slim gain), and the public `thinkingLevel` already covers call-level thinking; `thinkingOverride`'s only remaining value is the canonical-field edge (`input` callers) and task-level precedence (ADR 0020), neither needing public exposure.
- **Prompt-level instruction instead** ("tell the model about `input` harder") — rejected: the failure was adherence, not discoverability; a longer description is the same unreliable channel with more tokens.

## Consequences

- Model-facing surface: `subagent` 557 → 573, `research` 448 → 464 (measured 2026-10-05).
- The run row / usage line now shows the per-run `model` exactly as the caller passed it — the audit surface (ADR 0015) already exists; the fix is that the caller is likelier to pass it.
- `input` remains for `thinkingOverride` / `maxWallClockMs`; ADR 0011's merge/validation contract and ADR 0016's loud-throw exception are untouched.
- GLOSSARY `input-JSON`, ADR 0011 (partially superseded note), and the READMEs are updated to the new contract.
