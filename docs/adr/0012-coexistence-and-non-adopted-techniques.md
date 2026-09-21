# Coexistence stance with similar subagents extensions, and the techniques we reviewed and rejected

> [ZH] 本插件注册名为 `subagent` 的工具，其他类似的 subagents 扩展也会注册同名工具，不能共存于同一环境。README（中英）声明此立场，提醒避免同时使用类似的 subagents 扩展；不做任何运行时共存支持。设计评审中审阅过的其余技术（capturePi 代理、renderCall 委托、版本化 symbol 显示服务、维护 agent 三件套）逐一记录不采纳的理由，防止将来被无意识地重新引入。

A design review of a lightweight subagents facade — a wrapper that slims a full subagents runtime's model-facing footprint — informed four portable techniques that issue #17 adopts (the `input` escape hatch, the token benchmark + guard, the surface contract tests, and this coexistence stance — see ADR 0011). The same review also surfaced techniques that were deliberately **not** adopted. This ADR records the coexistence stance and the non-adopted techniques, so the "why not" does not get re-litigated.

## Decision: coexistence stance with similar subagents extensions

This plugin registers a tool named `subagent`; similar subagents extensions register the same tool name. Two extensions registering the same tool name in one pi environment collide, so **avoid running this plugin alongside similar subagents extensions**: install one or the other, never both. The README (en + zh) carries a coexistence warning.

- No runtime coexistence work is planned: no name-mangling, no merging of the two surfaces, no detection of the other package. The stance is documented, not engineered.
- The warning lives in both READMEs (English and 简体中文) so a package-installing user sees it before installing both.

## Non-adopted techniques from the review

- **Facade proxy (capturePi)** — the reviewed facade wraps the upstream extension in a `Proxy` on `pi.registerTool` to capture the upstream tools and re-route rendering. Not adopted: this plugin wraps no upstream extension, so there is nothing to capture; the technique exists to build a facade over a third-party surface, which we do not have.
- **renderCall / renderResult delegation** — the facade delegates rendering of a facade call to the captured upstream tool's renderer. Not adopted for the same reason: there is no upstream tool to delegate to. Our renderers stay bespoke UI glue covered by the parse guard (rendering-path tests remain out of scope).
- **Versioned symbol display service** (`Symbol.for("...display-service.v1")`) — the facade registers/consumes a global symbol so a UI extension can collapse the facade's display. Not adopted now. It would only make sense if a collapsed-display consumer existed in this plugin's environment; if one appears, revisit with a `version: 1` contract in the same shape. Until then the global-symbol indirection is unearned complexity.
- **Maintenance-agent trio** — the facade ships helper agent definitions (and the review found referenced skills that are empty stubs upstream). Not adopted: this plugin's roles are already bundled and tested in `src/lib.ts`; shipping maintenance agents would add discovery surface without a consumer.

## Consequences

- Users who install this plugin alongside a similar subagents extension see the warning in the READMEs; no code prevents the collision (the README warning is the mitigation).
- Future maintainers reading this ADR know why the facade techniques beyond the four adopted ones were rejected, and under which condition the display service would be revisited.
- The token-benchmark baseline (Seam E, ADR 0011) exists as the precondition for the help-on-demand decision — schema slimming stays deferred until the numbers are measured, so we never slim blindly.
