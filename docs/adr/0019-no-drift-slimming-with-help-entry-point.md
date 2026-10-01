# No-drift model-facing slimming, with a structural help-on-demand entry point (Variant A)

> [ZH] 模型可见面瘦身（Variant A）：description 改为"精简但全保留"、schema 只删字段描述冗词，合计 token 从 1147 降到实测 959（pi 0.99.2，Seam E）；完整教学文本以 `SUBAGENT_HELP_TEXT` / `RESEARCH_HELP_TEXT` 常量原样保留并配防腐化测试，作为 ADR 0012 挂起的 help-on-demand 的结构性入口（不接任何模型可见路径、description 无悬空 help 指引）；B（help 机制本身）与 C（deferred/tool_search）再次挂起并记录理由。基线常量与 README 数字由 `scripts/benchmark-tools.ts` 重测更新，×1.2 回归守卫与 surface contract tests 形状不变。

ADR 0011 deferred help-on-demand schema slimming until a measured token baseline existed; ADR 0012 recorded that stance. The baseline has existed since 2026-09-22 (subagent 630 / research 517). This ADR re-opens the question with measured numbers, adopts the no-drift slimming path (Variant A), and keeps a structural entry point so the deferred option can be wired later without re-authoring — and so a future maintainer never mistakes that entry point for dead code.

## Decision

- **Slim the two tool descriptions to terse-but-complete form.** Every load-bearing fact survives, reworded shorter. The fact-by-fact mapping is in the table below; nothing is silently dropped.
- **Trim only schema *description* strings.** Field names, enum members (`agentScope`, `thinkingLevel`), `required` sets, the `input` transport, and the full-schema hidden parameters (`model` / `thinkingOverride` / `maxWallClockMs`) are untouched. The full (hidden) dispatch schemas are not part of the model-facing surface and are not trimmed.
- **Preserve the pre-slim teaching text verbatim** as exported constants `SUBAGENT_HELP_TEXT` / `RESEARCH_HELP_TEXT`, consumed today only by an anti-rot test that pins the load-bearing facts. This is the **structural entry point** for help-on-demand (ADR 0012): a future `help` path serves these constants without re-authoring.
- **No dangling help pointer**: the slimmed descriptions do not tell the model to "call help". The entry point is structural, not behavioral.
- **Re-measure the baseline** with `node scripts/benchmark-tools.ts` (Seam E, real pi process, `before_agent_start`, ceil(chars/4)) and update `TOKEN_BASELINE` plus the README numbers from the measurement — no hand-edited numbers. The ×1.2 regression guard keeps its shape.

## Fact-by-fact mapping (pre-slim → slimmed)

**`subagent` description**

| Fact | Slimmed wording |
| --- | --- |
| Delegate to specialized subagents, isolated context windows, separate pi process | `Delegate tasks to specialized subagents (isolated context windows, each a separate pi process).` |
| BLOCKING primitive: returns only after every subagent finishes, one combined result; never spawn via bash / poll files | `BLOCKING: returns only after every subagent finishes, all results in one result. Never spawn subagents via bash or poll files.` |
| Mode mapping: parallel = `tasks` array (when a skill says "spawn sub-agents in parallel"), sequential = `chain` with the `{previous}` placeholder, single = `agent` + `task` | `Modes: single = agent+task; parallel = tasks array; sequential = chain ({previous} placeholder available).` |
| Bundled roles: standards-reviewer, spec-reviewer, design-explorer, architecture-scout, researcher, fact-finder | unchanged (verbatim) |
| Agent scope: `user` default (user agents + bundled roles); `both`/`project` add project agents from `.pi/agents` | `agentScope: user by default (user agents from ~/.pi/agent/agents plus the bundled roles); both/project add project agents from .pi/agents.` |

**`research` description**

| Fact | Slimmed wording |
| --- | --- |
| Background research subagent, in-process second session, writes cited findings to a file, returns immediately | unchanged in substance |
| Use when the research or wayfinder skill asks for a background agent; completion (succeeded/failed/terminated/aborted) is pushed with the findings path — no polling, no "read later" | `Use when the research or wayfinder skill asks for a background agent; completion (succeeded/failed/terminated/aborted) is pushed with the findings path — no polling, no read-later.` ("call this tool, keep working" dropped — the non-blocking property is carried by "returns immediately") |
| NOT for code review or design exploration — those block and must use `subagent` | `Not for blocking work: code review and design exploration must use the subagent tool.` |
| Agent scope incl. project-local `researcher` override with a trust confirmation for untrusted projects | kept with the confirmation parenthetical |
| Wall-clock cap (default 60 minutes), findings checkpointed before each search round | `Wall-clock capped (default 60 min); findings checkpointed before each search round, so a cap kill or crash loses at most one round.` |

## Why not B (help-on-demand now)

Moving the modes/roles/scope teaching behind a `help` op would cost the model a round-trip on every advanced call and has one silent-drift point (the wall-clock guarantee would be unreachable without a `help` call). For a high-frequency tool the indirection taxes every use. The entry point makes B cheap later; the indirection is not worth it now.

## Why not C (deferred exposure + `tool_search`)

`deferred` exposure with pi's built-in `tool_search` would take the standing cost to near zero, but it fights this plugin's usage profile: the bundled skills fire `subagent`/`research` constantly, so every activation adds a discovery round-trip and invalidates the cached prompt prefix (the active-tool set changes). Revisit only if the profile becomes "installed but rarely used".

## Consequences

- Standing model-facing surface: 1,147 → **979** tokens (measured pi 0.99.2, 2026-10-01; `subagent` 630→531, `research` 517→448). Guard ceilings: `subagent` 638, `research` 538.
- Surface contract tests unchanged in shape (tool names, field sets, required, hidden keys, description prefixes); two new tests pin the no-drift facts and the help-text anti-rot guarantee.
- Adopting B later = wire a `help` path that returns the constants, plus a schema contract-test update for the new operation. No re-authoring.
- The README benchmark sentence and GLOSSARY `help-on-demand` entry are updated to the new stance.
