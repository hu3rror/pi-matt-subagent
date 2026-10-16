# Bundle a seventh role: comment-sicko, a report-only comment audit (pstack-derived)

> [ZH] 新增第 7 个内置 role `comment-sicko`：只报告、不改码的注释审计——默认删；只有封闭的五条例外（法律/许可头、外部依赖/平台/厂商/协议强制的非显然行为、`prettier-ignore`、定义公共 API 契约的 doc comment、解释代码无法表达约束的 issue/RFC 链接）能让注释留下；我们代码自身的「惊喜」删掉并给具体符号标 `MUST KILL` 重塑标记；lint/TS 抑制按规则单审；`IMPORTANT` / `do not remove` / 长理由等未证实断言一律当肉，只有「今天仍在活路径上成立的、我们无法改变的约束」才能保命。工具集 `read, grep, find, ls, bash`（bash 只读），预设 `medium`（可经 `roleDefaults` 覆盖），随包发布、可按名被 user/project agent 覆盖。prompt 在本仓按「规则对规则」重写而非实质复制，故不携带第三方声明；MIT 来源（cursor/plugins → pstack，作者 Lauren Tan）与刻意丢弃的三处（写死开场白、`/how`//`/why` 调用、戏剧腔）记录于此。charter 措辞（README 首段）随之从「Matt Pocock 的 skills」扩为「需要 subagent 的 skills」，package description 与扩展头注释补上 `no-comments` 与 pstack 来源。不加 preset、不改工具 schema、不让 role description 变成模型可见。ADR 0019 事实表中「Bundled roles … unchanged (verbatim)」一行由此过期（已在该 ADR 顶部补 note），token 基线按其决定重测更新。

The plugin's bundled roles mirrored the jobs Matt Pocock's skills describe, and the package charter said so. pstack's `no-comments` workflow covers a job the six roles did not: adversarial comment deletion, with the reviewer deliberately separated from the fixer. That workflow only runs on Cursor's Task tool; issue #42 asked for its reviewer half as a bundled role, so a pi port of the skill has something to spawn and the role is usable standalone.

## Decision

- **A seventh embedded role, `comment-sicko`**, in the same discovery path as the other six: available by default in the user scope, overridable by a same-named user or project agent, no config change.
- **Report-only**: the role edits nothing and asks no questions; its caller judges the findings and performs the smallest root-cause fix. Its tools are the built-ins `read`, `grep`, `find`, `ls`, `bash`, with the shell restricted to read-only commands by the prompt — the role never depends on an optional extension.
- **Delete-by-default with a closed keep list**: the five exceptions are the only leash; when an exception's applicability is unsure, the comment dies. Surprises in our own code are killed and the exact symbol flagged `MUST KILL` for the rename, extract, type, or rearchitecture that makes the behavior obvious without prose.
- **Claims are verified in code**: `IMPORTANT`, `do not remove`, `too risky`, `fine for now`, and long justifications are scent, not conviction; a keep survives only when its constraint is proven true on a live path today and is something we cannot change. Lint/TypeScript suppressions are audited by rule: correctness- or safety-protecting suppressions die with their guilty symbol flagged; faulty, pedantic, or style-only ones survive.
- **Report shape** stays skill-consumable: audited files, deletion count, one line per `MUST KILL`, and the skips with their saving exception; no hedging, padding, or invented findings.
- **Preset `medium`** (the review roles' tier), still overridable through the existing dispatch hierarchy (`roleDefaults` and above).
- **Provenance and licensing**: pstack is MIT (Lauren Tan); the prompt is authored here as a rule-for-rule adaptation, so no third-party notice ships. Deliberately dropped from upstream: the scripted opening line, the `/how`//`/why` invocation (those skills do not exist here; the equivalent is reading the code the comment names), and the theatrical register. The aggression lives in the rules, because a rule is auditable and a register is not.
- **Surface and docs move with the role**: the `subagent` tool description's role list (the only model-visible role list) and the preserved help-text constant (with its anti-rot literal); both READMEs (including the README charter sentence, which broadens from Matt Pocock's skills to the skills that require subagents); the package description and the extension header comment, which gain the `no-comments` skill and the pstack-derived provenance note. ADR 0019 gets a note that its fact-table row is superseded.
- **Not done**: a `/no-comments` workflow preset (the skill owns orchestration, and hidden presets exist to avoid duplicating an installed skill), any change to tool schemas or hidden parameters, making role descriptions model-visible, and a GLOSSARY entry.

## Considered options

- **Copy the upstream agent text verbatim** — rejected: it references Cursor's runtime (`Task`, `/how`, `/why`, a hardcoded `main`) and would then require carrying pstack's MIT notice in a published package; the rules are what matter, not the expression.
- **Ship the role as a user-local agent instead of bundling it** — rejected: the package's job is to be the execution layer for skills, and a local agent is invisible to everyone else while breaking name compatibility for a future skill port.
- **A report-and-fix role** — rejected: the workflow's quality comes from judging someone else's independent findings; a role that edits judges its own work.
- **Keep upstream's scripted opening line and first-person theatrics** — rejected: pi's blocking children return their whole output as one tool result, so a scripted greeting carries no signal; the aggressive stance is preserved as rules.

## Consequences

- The model-facing surface grows by one role name in the `subagent` description; the token benchmark is re-measured (pi 1.3.0, 2026-10-16: `subagent` 482 → 486, `research` 398, `set-thinking-level` 104) and the baseline constant and README numbers are updated from that measurement (ADR 0019).
- The help-text anti-rot literal and the embedded-role tests grow from six to seven, and a new anti-rot test pins the prompt's decision-bearing clauses. The register itself is not testable.
- The charter wording in the READMEs, the package description, and the extension header comment now covers non-Matt skills; the role set has two provenances.
- Whether the aggressive register actually reduces leniency is unverified; the spec and this ADR deliberately place the requirement in auditable rules instead of claiming a behavioral effect.
- A future pi port of the `no-comments` skill needs no role-side change; the role is also usable standalone.
