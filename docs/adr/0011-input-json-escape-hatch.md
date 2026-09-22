# The `input`-JSON escape hatch: hidden advanced parameters with a full-contract check

> [ZH] 两个工具各新增可选 `input` 字段（JSON 对象字符串），携带公开 schema 未暴露但运行时已支持的参数（`subagent`: `model`/`thinkingOverride`；`research`: `model`/`maxWallClockMs`，后者由 ADR 0013 引入、仅收紧）。合并语义沿用轻量 subagents 门面的通用做法：直接字段覆盖 JSON 同名键（`{...parsed, ...direct}`），缺失/空 `input` 直通，非法 JSON 或非对象抛模型可见错误（ADR 0010 throw 契约）。合并后按完整契约（公开 + 隐藏）校验，错误按字段路径报出；公开 schema 不变（help-on-demand 瘦身推迟，见 ADR 0012）。

The plugin's two tools carry rich runtime semantics — budgets, a run registry, tool-name resolution, trust confirmation — but their model-facing schemas only exposed the fields the prompts needed. The runtime dispatch layer already supports parameters (`model`, `thinkingOverride` for `subagent`; `model` and `maxWallClockMs` for `research`) that no schema exposed, so tuning an individual run meant either schema churn or editing agent definitions. A design review of a lightweight subagents facade — a wrapper that slims a full subagents runtime's model-facing footprint from thousands of tokens to a few hundred at startup — surfaced a portable technique: an optional `input` string field carrying a JSON object of advanced parameters. This ADR freezes the contract.

## Decision

Each tool gains one optional `input` field: a JSON object string carrying parameters the runtime supports but the public schema hides. The public schema of each tool is otherwise unchanged; no public parameter moves behind `input`. Merge semantics follow the pattern used by lightweight subagents facades:

- **Merge**: `{ ...parsed, ...direct }` — direct fields override same-name JSON keys, so the precedence rule is single, predictable, and never silently ambiguous.
- **Passthrough**: absent or empty (whitespace-only) `input` returns the direct params untouched; existing calls behave exactly as before.
- **Loud failure**: an unparseable value raises `input must be a JSON object string: <parse error>`; a non-object value raises `input must decode to a JSON object, got <kind>`. Both are thrown as model-visible tool errors per the ADR 0010 throw contract.
- **Full-contract validation**: the merged object is validated against the complete parameter contract (public + hidden, `additionalProperties: false`) before dispatch; a violation throws `Invalid input parameters: <path>: <message>` (union alternatives collapse to `must be one of: ...`, unknown keys become `<path>: unknown parameter`). The field path comes from the schema's `instancePath` — including nested paths — so the error names exactly what to correct.
- **Hidden parameters are only pre-existing runtime capability**: `subagent` carries `model` and `thinkingOverride`; `research` carries `model` and `maxWallClockMs` (the tighten-only wall-clock cap introduced by ADR 0013 — it may only lower the 60-minute default). No new runtime capability is added through `input` beyond these. When both the public `thinkingLevel` and the hidden `thinkingOverride` are present, `thinkingOverride` (the canonical dispatch field) wins.
- **Single source of truth**: both tools' schemas (public and full) and descriptions live in the runtime-free `src/lib.ts` module (`SUBAGENT_TOOL_PARAMS`, `SUBAGENT_FULL_PARAMS`, `RESEARCH_TOOL_PARAMS`, `RESEARCH_FULL_PARAMS`, `SUBAGENT_INPUT_KEYS`, `RESEARCH_INPUT_KEYS`, `SUBAGENT_TOOL_DESCRIPTION`, `RESEARCH_TOOL_DESCRIPTION`); the extension imports them for registration and the contract tests assert against them, so the two cannot drift apart.

## Why not slim the public schema (help-on-demand)

Lightweight subagents facades go further: they collapse the whole model-facing surface into one tiny tool and disclose advanced parameters through a `help` operation. That is deliberately **not** adopted here — yet. Slimming the public schema without a measured baseline would be slimming blindly, and the two tools' schemas are already modest. The decision is deferred until the token-benchmark baseline exists (ADR 0012 records the stance): the numbers from Seam E will tell us whether help-on-demand is worth the indirection it adds to every call.

## Considered options

- **Expose `model`/`thinkingOverride` as public fields** — rejected: it changes the visible schema (the thing the model is trained against), and the spec's goal is an escape hatch that does not expand the surface.
- **Environment variables / per-agent model pins** — rejected: not per-run, and agent pins already exist; `input` is for tuning individual runs without touching agent definitions.
- **Silently ignore bad `input` (the facade's lenient fallback)** — rejected: some facades fall back to the direct params on parse failure; a mistyped value then silently does nothing. The spec wants loud failure so the model can fix the call immediately.
- **Validate only the hidden keys** — rejected: the merged object must satisfy the complete contract (public + hidden) so a bad value never reaches the child process, whether it came through `input` or collided with a direct field.

## Consequences

- The model-facing surface grows by exactly one optional `input` field per tool; the call shape is otherwise unchanged.
- The footprint is now measured and guarded: a token benchmark (Seam E, `scripts/benchmark-tools.ts`) feeds the README table, and a test asserts the serialized surface stays within baseline × 1.2.
- Parameter schemas move into the runtime-free lib module; the extension's inline TypeBox definitions are gone. `typebox` becomes a devDependency (it was already a peerDependency) so the lib module and its tests resolve under `node --test`.
- Merge/validation logic is pure and unit-tested under `node --test` (Seam A); the surface contract is asserted at the lib seam (Seam D, Path 1 — no fake pi).
- One behavioral note: because the full contract rejects unknown keys, `input` cannot smuggle arbitrary keys past validation — the loud-failure guarantee cuts both ways.
