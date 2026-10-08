# Gate the built-in workflow presets behind a config knob (manifest templates → config-gated commands)

> [ZH] 三个内置 workflow preset（`/code-review`、`/design-it-twice`、`/research`）从包 manifest 的 prompt 模板改为扩展内按 `hideWorkflowPresets` 配置注册的斜杠命令（布尔，默认 `false`＝显示）：装了对口 skills（`code-review`、`research`、`codebase-design` 的 design-it-twice 模式）后这些 preset 与 skill 描述同一套工作流，是重复指令源且已出现内容漂移（如 `/research` 的 findings 路径约定），用户需要一个开关隐藏它们。pi 没有运行时卸载 prompt 模板的 API（manifest 加载是静态的，扩展 API 与 settings 只能加路径），字面隐藏的唯一可靠机制是移出 manifest + 按配置注册命令；参数展开复刻 pi 模板语义、逐字节等价。开关在加载时读取，需 `/reload` 生效（与其他「下次运行生效」的 knob 不同的明文例外）；三个工具与 `/subagents` 永不受门控。

The plugin ships three workflow presets as prompt templates loaded from the package manifest (`pi.prompts`). The plugin's purpose is to be the execution layer for Matt Pocock's skills; with those skills installed, each preset is a second instruction source for the same workflow, and the two sources already drift (the `/research` preset prefers an absolute findings path; the `research` skill requires a repo-relative path that resolves inside the repo). The user asked for a settings toggle to hide the built-in presets, and the work is tracked as issue #41.

Pi offers no way to unload a manifest-loaded prompt template at runtime: the extension API has `registerCommand` only, `resources_discover` and settings `prompts` add paths but never filter, and template loading from the manifest is static. True hiding (gone from `/` completion) therefore requires the presets to leave the manifest and become commands the extension registers conditionally.

## Decision

- New boolean config knob `hideWorkflowPresets` (default `false`, non-optional) through the existing per-key config pipeline (ADR 0018): decode, validate/degrade, set-value parsing (`true`/`false` only), config view label, menu, and autocomplete are picked up generically.
- The three presets leave `package.json`'s `pi.prompts` manifest entry. The markdown files stay shipped in the package and are read by the extension at load; their frontmatter `description` becomes the command's completion description.
- When the knob is `false`, the extension registers three commands (`code-review`, `design-it-twice`, `research`). Each handler parses the raw argument string with shell-like quoting and substitutes arguments (`$@` / `$ARGUMENTS` / `${@:-default}` / `${@:N[:L]}` / `$N`) byte-equivalently to pi's prompt-template expansion, then injects the expanded text as a user message via `pi.sendUserMessage` (`deliverAs: "steer"`, matching template behavior while streaming). When the knob is `true`, the commands are not registered — they disappear from `/` completion.
- The knob is read at extension load, so a change takes effect on `/reload` — a documented exception to the other knobs' "applies to the next run without `/reload`" behavior.
- Hidden-state behavior is pi's normal unknown-command fallthrough (the typed text goes to the agent unchanged); the README documents it.
- The preset texts are preserved byte-for-byte. No rewording and no drift-fixing in this change (a separate follow-up).
- The three tools (`subagent`, `research`, `set-thinking-level`) and the `/subagents` run-management command are never gated — the plugin stays the execution layer for the skills.

## Considered options

- **Keep the templates and register same-name shadow commands when hidden** — rejected: the command menu merges extension commands, templates, and skills without deduplication, so the template would still appear in completion (not hidden); it still requires the same argument-expansion reimplementation.
- **Copy/delete template files in the user prompts directory at runtime** — rejected: writes user-owned files from the extension, couples package state to runtime side effects, and fights the lazy config file.
- **Auto-detect installed skills** — rejected: fragile name matching and magic behavior; a manual opt-out knob is deterministic.

## Consequences

- Model-facing tool surface is unchanged; the token benchmarks and surface contract tests stay valid.
- The config view / menu / autocomplete pick the knob up through the generic per-key pipeline; the GLOSSARY `config knob` list grows from nine to ten.
- Visible-state behavior is identical to before (same text, same expansion); preset text edits still need `/reload`, as pi templates always did.
- READMEs (EN + zh-CN) and GLOSSARY updated; the README config intro documents the `/reload` exception.
