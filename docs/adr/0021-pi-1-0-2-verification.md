# Pi 1.0.2 verification: devDeps bump with a clean seam pass

> [ZH] 把四个 pi devDeps 从 `^0.99.1` 升到 `^1.0.2`（宿主机 mise 安装已运行 1.0.2，`pi --version` 实测）：逐一重验内部 seam 后**无任何代码改动需要**——类型面全部逐字节相同或仅增量（`registerToolRenderer`、`SamplingParams`、`QuietStartup`、`ToolRendererResolver`），clamp 表（`pi-ai/models.js`）逐字节相同，`AgentToolResult`/`sendMessage`/`MessageRenderer`/UI 上下文原样；仅有的落地改动是修正一处**过期守卫基线**（`TOKEN_BASELINE` 停在 ADR 0019 的 531，而 ADR 0020 落地时实测已 557——本次 Seam E 在 pi 1.0.2 重测确认 557/448，据实更新）与新增本 ADR。依赖策略侧：pi 1.0.1 起发布包移除 `npm-shrinkwrap.json`、`brace-expansion` 5.0.12 改直连 pin（GHSA-q2hr-2g5m-vwhr 等），本仓 `npm audit` 0 漏洞、无嵌套旧副本残留。

## Decision

- **Bump the dev-time compile seam (ADR 0016's "compile seam") from pi 0.99.1 to 1.0.2** — four pi packages in `devDependencies` move `^0.99.1` → `^1.0.2` (`pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`). The runtime peerDependencies stay `*`, resolved against the installed pi. The host already runs 1.0.2 (mise), so dev and runtime now agree.
- **Re-verify every internal seam against the 1.0.2 dist before touching code** — the outcome determines whether any code change is needed. This ADR records the per-seam checklist as the repeatable procedure for the next bump:
  - **Type surface**: `pi-coding-agent/dist/index.d.ts` diff is additive-only (`ToolRendererResolver`/`ToolRenderers`/`QuietStartup`); `ExtensionAPI` gains `registerToolRenderer` and loses only a doc comment; `ThemeColor`, `CONFIG_DIR_NAME`, `getAgentDir`, `parseFrontmatter`, `DefaultResourceLoader`, `AgentSession`, `sendMessage` (+ `deliverAs: "followUp"`/`triggerTurn`), `MessageRenderer`/`registerMessageRenderer`, `modelRegistry`, and the UI-context methods (`setStatus`/`notify`/`confirm`/`select`/`input`/`isProjectTrusted`) are byte-identical declarations.
  - **Runtime JS**: `pi-ai/models.js` (the `clampThinkingLevel` capability table the extension pre-clamps against, GLOSSARY `clamp`) is byte-identical; `agent-session-runtime.js`, `session-manager.js`, `file-mutation-queue.js` byte-identical; `sdk.js` differs only by an added `usesDefaultTools` field the extension never reads.
  - **Tool-result contract** (ADR 0016/0017 premise): `AgentToolResult` (`isError`, `structuredContent`) is byte-identical — the returned-error and structured-receipt contracts hold on 1.0.2.
  - **pi-tui**: `Box`/`Text` declarations and components byte-identical; `pi-ai` `Message`/`Model`/`ModelThinkingLevel` unchanged (only additive `SamplingParams`/`SamplingParamsByThinkingLevel` for the 1.0.2 sampling feature).
  - **Seam E re-measure**: `node scripts/benchmark-tools.ts` on pi 1.0.2 → `subagent` 557 / `research` 448, identical to the ADR 0020 record. The surface did not drift with the pi bump.
- **Correct the stale guard baseline**: `TOKEN_BASELINE` in `src/lib.test.ts` still read `{ subagent: 531, research: 448 }` — the pre-ADR-0020 numbers. ADR 0020 recorded the call-level description's +26 tokens (531 → 557), but the constant was never updated; the guard passed only because 557 < 531 × 1.2. The re-measurement confirms 557/448, so the baseline constant is updated to the true current surface (ceilings 669/538) — the ADR 0019 seam obligation ("基线常量与 README 数字由 benchmark 重测更新") executed now. README already carried the correct ~557/~448 numbers.
- **No behavior changes adopted**: nothing in the 1.0.0–1.0.2 release notes touches this extension's surface (tool-result semantics, renderer/sendMessage APIs, session factory). Fullscreen-default TUI, leaner codemode, and provider-level retry fixes (0.99.2 `Retry-After` backoff, 1.0.2 capacity-retry) are outside the extension's seams. The 1.0.1 `npm-shrinkwrap.json` removal changes the *published package* install strategy, not this repo's dev tree (it keeps its own `package-lock.json`).
- **Dependency audit clean**: `npm audit` → 0 vulnerabilities. The `brace-expansion` GHSA (q2hr-2g5m-vwhr, qhr7-859c-m2p7, 6j4f-fj2g-mc7p) that 1.0.1 fixed by pinning `brace-expansion` 5.0.12 as a direct dependency is resolved in the dev tree with no nested pre-fix copy (`npm ls brace-expansion` → single 5.0.12).

## Why per-seam diffing instead of trusting the changelog

The changelog between 0.99.1 and 1.0.2 names no extension-API breaking changes, and the diff pass agreed — but the seam that would silently break is the one a changelog cannot describe: a mirror table or runtime behavior (prototype → class field, a moved export) that keeps compiling while changing meaning. Byte-diffing the compiled `dist` of exactly the files the extension imports closes that gap cheaply; a changelog read alone would not have ruled out, for example, a shifted `clampThinkingLevel` capability table.

## Considered options

- **Leave `TOKEN_BASELINE` at 531** — rejected: the guard is the token-surface regression fence; a baseline that understates the measured surface by 26 tokens silently tolerates a 4.9% re-bloat before it fires. The number exists to be kept honest by the documented re-measure loop, and the loop was due anyway with a pi bump.
- **Run the dev-only real-pi e2e scripts (`blocking-e2e.ts`, `push-e2e.ts`) as part of this verification** — deferred: they require a working model/API key and are live-provider smoke tests; nothing in this bump changes the wiring they cover (byte-identical seams). Recorded here as the manual-verification step to run at release time.
- **Extend devDeps to `^1.x`-style caret ranges** — unchanged: the existing `^1.0.2` caret already permits patch updates within 1.0.x; the previous `^0.99.1` caret could not reach 1.0.2 (npm caret semantics treat 0.x specially), which is exactly why a hard version line existed.

## Consequences

- The dev-time compile seam now enforces the 1.0.2 contract; `typecheck` (tsc --noEmit) is clean and the full suite (208 tests) is green on 1.0.2.
- `TOKEN_BASELINE` = `{ subagent: 557, research: 448 }`; guard ceilings 669 / 538 (× 1.2). The next Seam E re-measurement compares against the true current surface.
- The next pi bump re-runs this ADR's checklist (index/type diffs, `models.js` clamp table, `AgentToolResult`, Seam E) before any code change is considered.
- Release-time manual verification (not this change): the two dev-only real-pi e2e scripts, marked `[NEEDS MANUAL VERIFICATION]`.
