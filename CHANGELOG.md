# Changelog

One section per release, newest first. After an update, pi shows the entries newer than
the version you last ran, at your next fresh launch (it reads this file through
`pi.changelogPath` / `CHANGELOG.md`). v0.1.0, v0.1.1 and v0.3.0 have no notes.

## [0.14.3] - 2026-11-04

### Highlights

Estimated costs are now marked as estimates. The usage line prefixes a catalog figure with `~` and prints provider-billed totals bare, so a real bill and a computed guess no longer look alike. The package also ships `CHANGELOG.md`, so pi can show what changed after an update, and dependencies move to pi 1.5.0.

### Features

- **Estimate marker in the usage line.** `UsageStats` carries `costFromProvider`, aggregated by pi's rule: a sum is provider-reported only when every part is. `formatUsageLine` writes a catalog estimate as `~$0.0012` and a billed total as `$0.0012`; a run with no usage part seen stays unmarked. Tool results, error lines and `/subagents` rows all render the marker.
- **This changelog ships with the package** (`files` in `package.json`). pi reads it through `pi.changelogPath` / `CHANGELOG.md` and shows the entries newer than your last version at the next fresh launch; `AGENTS.md` keeps the file in sync at release time.

### Fixes

- **`comment-sicko` keep-list parity.** The embedded prompt again matches the canonical rule file: the `prettier-ignore` exception keeps its "and similar" tail, and commented-out code keeps the `(dead code)` qualifier. Rule content only; the persona register is unchanged.

### Docs & Chore

- pi packages synced to 1.5.0 (`pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`). Import surface, typecheck and tests unchanged.
- GLOSSARY gains the `cost provenance` entry.

### Full Changelog

https://github.com/hu3rror/pi-matt-subagent/compare/v0.14.2...v0.14.3

## [0.14.2] - 2026-10-23

### Highlights

Two internal refactors, no user-visible change. Tools, commands and the config schema are untouched.

### Docs & Chore

- The `roleDefaults` edit path now types each edit as a `field` + `value` pair (`RoleDefaultEdit`). The type system enforces the pairing an unchecked cast used to assert; accepted values, error messages and the clearing/pruning rules stay the same.
- Redundant comments removed across `src/`: suite banners, restated invariants, narration the code or the tests already carry. What stayed: constraint docs, ADR and issue links, API contract docs.

### Full Changelog

https://github.com/hu3rror/pi-matt-subagent/compare/v0.14.1...v0.14.2

## [0.14.1] - 2026-10-23

### Highlights

A research run cut short by session end or reload now settles as `aborted`. Before, it could be recorded as `succeeded` with no work done and no push. Live-session push delivery is unchanged.

### Fixes

- **Teardown:** when the main session ended or reloaded while a research child was still running or finishing, the child was disposed and the run recorded as `succeeded`, with zero tool calls and no findings file, while the completion push vanished. Teardown now settles that run as `aborted` through the same per-run abort controller that backs `/subagents kill`. The run log's `terminal · aborted` line is honest, and a disposed child that did no work is never reported as a success. The every-terminal-state-pushed rule (ADR 0013) holds for live sessions.
- **Test hygiene:** the research e2e tests no longer leave `pi-research-*` temp directories behind, so a full `npm test` returns the system temp dir as it found it.

### Docs & Chore

- ADR 0027 records the teardown rule; ADR 0013 carries a revision note; the `push` and `run status` glossary terms match the new behavior.
- New dev-only real-pi gate `scripts/research-teardown-e2e.ts` for the honesty invariant, plus a runner-side pin of the teardown race in `src/research-e2e.test.ts`.
- pi devDependencies bumped to 1.4.0.

### Full Changelog

https://github.com/hu3rror/pi-matt-subagent/compare/v0.14.0...v0.14.1

## [0.14.0] - 2026-10-19

### Highlights

The research child now behaves like a bound in-process subagent. It announces its lifecycle on the parent session's `pi.events` bus and binds its loaded extensions before prompting. With the gatekeeper (`@gotgenes/pi-permission-system`) installed, a research child gets registered, its permission instance activates, and an `ask` raised inside it reaches the parent session's UI instead of failing closed. Without the permission system nothing changes: every announcement is a silent no-op.

### Features

- **Lifecycle announcements:** The child emits `subagents:child:session-created`, `subagents:child:bound` and `subagents:child:disposed`, character-identical to the permission system's subscriber constants. With the permission system loaded through `researchChildExtensions`, the gatekeeper registers the child at creation and unregisters it when the run ends, success and failure alike, and it reports a child that bound with no permission node instead of running ungated. Channel names and payload shapes are pinned by tests.
- **Extensions bound before prompting:** `session.bindExtensions({ mode: "print", onError })` runs first, so packages loaded into the research knob receive `session_start` and the permission system's child-side service activates; extension errors go to stderr instead of disappearing. Children aborted before start emit no lifecycle events, and the blocking subagent path is untouched.

### Docs & Chore

- ADR 0026 records the reversal of ADR 0014's frozen non-emission decision, whose "no consumer" premise no longer holds. ADR 0014 carries a revision note, and the `subagent marker` glossary term matches the code.
- CODING_STANDARDS.md aligned with baseline v2; glossary gains a publish-flow entry.

### Full Changelog

https://github.com/hu3rror/pi-matt-subagent/compare/v0.13.0...v0.14.0

## [0.13.0] - 2026-10-19

### Highlights

Background research children start with pi's built-in tools only; npm packages are now a one-step choice. Tool-replacing extensions can no longer strip built-in tool names, such as `read` and `grep`, from a research child.

### Features

- **Empty loadout by default (issue #44):** A research child loads no network tools and no extension packages unless you configure `researchChildExtensions`. The quiet default prints no warnings, and the run log notes `[loadout] info · no query packages configured`.
- **Activation follows load:** Put a package in `researchChildExtensions` and every tool it provides joins the research child automatically. One step, no role-file edit.
- **An explicit `tools` list stays authoritative:** Callers can still dispatch a deliberately narrower researcher; package tools are not added on top of an explicit list.
- **The config view describes the knob as it stands:** `config reset researchChildExtensions` returns to the quiet default.

### Fixes

- **Built-in tool names survive shadowing (issue #43):** When an extension replaces a built-in name in the main session, say a hashline-based `read` or `grep`, a research child still receives pi's built-in implementation under that name instead of losing the tool. The built-in name set is derived from the installed pi at runtime, so a pi upgrade cannot reintroduce the misclassification.

### Breaking Changes

1. **Research children lose web and library-docs access on upgrade:** 0.12.0 and earlier loaded two npm packages by default; 0.13.0 ships no default loadout. To restore them in one step:

   ```
   /subagents config set researchChildExtensions npm:@ssk_dev/pi-web-access-lean,npm:@upstash/context7-pi
   ```

   - `npm:@ssk_dev/pi-web-access-lean` provides `web_access` (web search, page fetch).
   - `npm:@upstash/context7-pi` provides `query-docs` and `resolve-library-id` (library docs).

   Their tools then join research children automatically, with no role edit and no second step. Want nothing? Leave the knob empty; that is the quiet default.
2. **`inherit` is gone for non-optional knobs:** `config set <key> inherit`, or an empty value, is rejected for knobs that have nothing to inherit from, including `researchChildExtensions`, `maxConcurrency` and `hideWorkflowPresets`. Set a concrete value, or run `config reset <key>`.
3. **Stale config degrades safely:** If `~/.pi/agent/extensions/matt-subagent.json` still holds `inherit` or `null` for a non-optional knob, the extension falls back to the default and the config view marks the key `degraded`. Run `/subagents config` to check, then `config reset <key>` to clean it up.

### Docs & Chore

- README (English and 中文) covers the quiet default, the opt-in procedure, the trust criterion and the error shapes.
- ADR 0025 records the reversal of the earlier default-on decision; ADRs 0013 and 0018 annotated.
- GLOSSARY tool-name resolution entry aligned with the implementation.

### Full Changelog

https://github.com/hu3rror/pi-matt-subagent/compare/v0.12.0...v0.13.0

## [0.12.0] - 2026-10-17

### Highlights

`pi-matt-subagent` now ships a seventh bundled role, `comment-sicko`: an adversarial, report-only comment audit that deletes by default and keeps a small closed list of exceptions. It adapts pstack's `no-comments` workflow, so a future pi port of that skill has a reviewer to spawn, and it works standalone today. Embedded subagent roles now run at `high` thinking by default.

### Features

- **New bundled role `comment-sicko`:** Spawn it through `subagent` in the user scope, or override it with a same-named user or project agent. It audits comments and reports; it edits nothing and asks no questions. A comment is deleted unless it matches one of five closed exceptions: legal or license headers; behavior forced by an external, platform, vendor or protocol constraint; `prettier-ignore`; doc comments defining a public API contract; issue or RFC links explaining a constraint the code cannot express. Surprises in our own code are killed and the exact symbol flagged `MUST KILL` for the refactor that makes the behavior obvious. `IMPORTANT`, `do not remove` and long justifications count as scent, not conviction; a keep survives only when its constraint is provably true on a live path today. Output is skill-consumable: audited files, a deletion count, one line per `MUST KILL`, and the skips with their saving exception. Default thinking is `medium`, overridable through the dispatch hierarchy. The role is MIT-derived from pstack (Lauren Tan); the prompt is authored here rule for rule, so no third-party notice ships.
- **Embedded roles default to `high` thinking:** The bundled review, research and fact-finder roles reason at `high` by default, overridable via `roleDefaults` and the dispatch chain above it.

### Docs & Chore

- ADR 0024 records the new role. ADR 0019 notes that its bundled-roles fact table is superseded, and the token baseline is re-measured on pi 1.3.0.
- README (EN + zh-CN) and the package description broaden the charter from "Matt Pocock's skills" to "skills that require subagents", and document the role and its provenance.
- CODING_STANDARDS.md aligned with baseline v1.
- npm publishing switched to the direct flow: a `v*` tag push publishes immediately through Trusted Publisher / OIDC (zero token, provenance), with no human gate.
- 139 comment blocks dropped, as flagged by the new role's audit.

### Full Changelog

https://github.com/hu3rror/pi-matt-subagent/compare/v0.11.0...v0.12.0

## [0.11.0] - 2026-10-08

### Highlights

The three built-in workflow presets, `/code-review`, `/design-it-twice` and `/research`, can now be hidden behind one config knob. If you have the matching Matt Pocock skills installed (`code-review`, `research`, `codebase-design`'s design-it-twice pattern), they already describe the same workflows: set `hideWorkflowPresets` to `true`, run `/reload`, and the presets drop out of `/` completion. The `subagent`, `research` and `set-thinking-level` tools and `/subagents` run management are never affected. Behavior is otherwise unchanged; the presets now register as extension commands with byte-identical argument expansion.

### Features

- **`hideWorkflowPresets` knob:** `subagents config set hideWorkflowPresets true` plus `/reload` removes the three presets from `/` completion; `false`, the default, keeps them. The knob is read at extension load, so a change needs `/reload`; `config reset hideWorkflowPresets` restores the default. It never gates the three tools or `/subagents`. While hidden, typing a preset name behaves like any unknown `/` command.
- **Presets ship as extension commands:** The three moved from manifest prompt templates to extension-registered commands. Argument parsing and substitution are byte-equivalent to pi's template expansion, so defaults (`HEAD~1` for `/code-review`), quoted arguments and completion descriptions behave as before.

### Docs & Chore

- ADR 0023 records the gating mechanism; README (EN + zh-CN) and GLOSSARY document the knob.
- Repo policy: release tags are always signed (AGENTS.md).

### Full Changelog

https://github.com/hu3rror/pi-matt-subagent/compare/v0.10.0...v0.11.0

## [0.10.0] - 2026-10-08

### Highlights

Subagent thinking effort is now deterministic and controllable from conversation. A fixed hierarchy replaces the old "the model fills whatever it feels like": per-task level, then per-call override, then a level declared in conversation, then per-role `roleDefaults`, then the config default, then the role preset, then the inherited session level as-is. The new `set-thinking-level` tool is the only model-visible way to change effort. A level declared in conversation now outranks the config default and per-role pins; `roleDefaults` gives every role an explicit model and level pair; and `dispatchDefaultThinkingLevel` finally reaches the six embedded roles instead of sitting below every tier as dead config.

### Features

- **Deterministic hierarchy:** Per-task or per-step level, then per-call override (`input.thinkingOverride`), then session-declared level, then `roleDefaults`, then `dispatchDefaultThinkingLevel`, then role preset, then inherited session level, plain and as-is. Whatever the hierarchy resolves is clamped to the target model's capability, and both levels are recorded: `high (req: xhigh)`.
- **`set-thinking-level` tool:** The only model-visible channel for changing effort. Session-scoped and never persisted; a fresh session starts from your normal config.
- **A declared level beats config and role pins:** While active, a level declared in conversation dispatches subagents above `dispatchDefaultThinkingLevel` and `roleDefaults`. It is sticky across model switches and session continuation, derived from the session transcript, and session-scoped: nothing is persisted.
- **`roleDefaults` per-role customization:** Pin a model and/or thinking level per role with `config set roleDefaults.<role>.<field> …`; the tier sits between the call-level override and the config default.
- **Config default is live for embedded roles:** `dispatchDefaultThinkingLevel` moved above the role-preset layer, where it used to be dead config; absent, the inherited session level applies as-is.
- **Model-pinned roles skip only the inherited layer:** Frontmatter or embedded pins and `roleDefaults.<role>.model` both keep the explicit tiers above them and skip only the inherited level.

### Fixes

- **Effort was effectively random:** The orchestrating model filled a public `thinkingLevel` parameter per call, so identical code-review runs dispatched `low` and `high` minutes apart. The parameter is gone; effort resolves from the hierarchy above, deterministically.

### Breaking Changes

- **`thinkingLevel` removed from `subagent` and `research`:** Legacy calls that still pass it fail loudly with an unknown-parameter error. Use `set-thinking-level` for a session-wide level, or `input.thinkingOverride` (hidden field) or a per-task or per-step `thinkingLevel` field for single runs.
- **Blocking model precedence flipped:** Blocking subagents now resolve the model per call first, matching research: per-call override, then role-pinned model, then `roleDefaults` model, then config default, then inherited session model. Previously the role pin beat the per-call override, so a role-pinned model no longer overrides a per-call `model`.
- **Inheritance is plain:** Preset-less roles inherit the main session's thinking level as-is; once they inherited one tier down. A declared depth such as `xhigh` now reaches preset-less roles at full strength; cap cost with the explicit layers (config default, `roleDefaults`, presets).

### Docs & Chore

- CI now runs typecheck and tests on push and PR; release tags in this repo are SSH-signed from here on.

### Full Changelog

https://github.com/hu3rror/pi-matt-subagent/compare/v0.9.0...v0.10.0

## [0.9.0] - 2026-10-05

### Highlights

The per-run model override moves from the hidden `input` JSON channel to a public `model` field on both `subagent` and `research` (ADR 0022). Asking for a different model used to fail silently: when the main model dropped the hidden channel, the run fell back to the configured default with no warning. Now you pass `model: "provider/id"` directly and the parameter is not dropped.

### Features

- **Public `model` override:** Both tools accept `model` in `"provider/id"` form to pin one run's model, on par with the existing `thinkingLevel`. Legacy `input: '{"model": ...}'` calls still merge and dispatch unchanged.
- **Surface cost +16 tokens per tool** (`subagent` 573, `research` 464, Seam E re-measure). The ×1.2 regression guard keeps the surface locked against drift.

### Fixes

- **Research loadout self-report:** The report now reflects what the loader actually kept rather than the allowlist, and it gains run-stage lines. A loadout regression, whether a package did not load or a tool was renamed or retired, no longer reads as a "NO knob packages registered" false negative.

### Docs & Chore

- ADR 0019 gains a supersede pointer; `repository.url` normalized to the `git+https` form (npm pkg fix).

### Full Changelog

https://github.com/hu3rror/pi-matt-subagent/compare/v0.8.0...v0.9.0

## [0.8.0] - 2026-10-04

### Highlights

Background research subagents now get the same tool surface as the main session: web and library-docs access out of the box, `bash` resolving to a real Git Bash on Windows machines that have one, and a research prompt that names the child's actual tools. Loadout drift now shows up at run start instead of half an hour of the model guessing at tool names that do not exist.

### Features

- **Query tools by default:** The child loads `npm:@ssk_dev/pi-web-access-lean` (web search, page fetch) and `npm:@upstash/context7-pi` (library docs), and the researcher role declares `web_access`, `query-docs` and `resolve-library-id`. Primary-source research works with zero configuration.
- **New `researchChildExtensions` config** (`~/.pi/agent/extensions/matt-subagent.json`). Extend the child's loaded packages by name, or set an empty array to disable child extensions entirely, fully offline. The README adds a "trust surface" section with the two-step (load + declare) procedure and the eligibility criterion.
- **Real `bash` on Windows:** Tool-name resolution is registry-driven: with a `shellPath` configured, a role-declared `bash` resolves to the real bash instead of being rewritten to `powershell`. Powershell remains the fallback only when the environment genuinely has no bash.

### Fixes

- **The research name-guessing loop, treated at the root:** One background run burned 36 minutes on 90+ calls to non-existent tool names: child loadout mismatched with the parent, no web tools, unhelpful unknown-tool errors. Probe and child loadout now share one predicate, the prompt lists the real tool names, and both the returned text and the per-run log report declared-but-not-loaded tools (`[research-drift]`) and the child's actual loadout (`[child-loadout]`). The problem is visible at start, not wasted mid-run.
- **Runaways are cut off sooner:** The default research wall-clock cap tightens from 60 to 45 minutes; `researchWallClockMs` stays adjustable.

### Docs & Chore

- README (EN + zh-CN) gains a "Research child extensions (trust surface)" section: the default package list and criterion, per-machine maintenance, the two-step new-tool procedure, and error shapes with remedies.
- ADR 0013 records the curated-loadout revision and the 45-minute default; ADR 0018 records the eighth knob.
- push-e2e gains gate 5, a live loadout regression guard.

### Full Changelog

https://github.com/hu3rror/pi-matt-subagent/compare/v0.7.0...v0.8.0

## [0.7.0] - 2026-10-02

### Highlights

A per-task or per-step `thinkingLevel` on the `subagent` tool is now honored instead of falling back to the role's default, so a requested `high` review runs at high. No new required parameters and no model-facing schema change.

### Features

- **Per-run thinking levels on `subagent`:** `tasks[]` and `chain[]` items accept a `thinkingLevel`, resolved as per-task, call-level override, role default, config default, inherited session level. One call can run a fact-finder at `low` and a standards reviewer at `high`.
- **Call-level guidance:** The `thinkingLevel` parameter documents that it applies to the whole call, all tasks and steps.

### Fixes

- **Silent thinking-level drop:** A `thinkingLevel` placed on a task item rather than the call level was validated and passed through by pi but never read, so the run fell back to the role default, `medium` for reviewers, instead of the requested level. Invalid level values now fail loudly and name the offending item.

### Docs & Chore

- New ADR 0020 records the per-task resolution and the pi argument pass-through it relies on; ADR 0005's priority chain is updated to match.
- READMEs rewritten (centered hero, natural Chinese, tool-surface token numbers ~557 / ~448); the banner re-encoded from a 4.8 MB PNG to a 118 KB WebP.

### Full Changelog

https://github.com/hu3rror/pi-matt-subagent/compare/v0.6.1...v0.7.0

## [0.6.1] - 2026-10-01

### Highlights

The model-facing surface is about 15% leaner: the two tools' standing context cost drops from 1,147 to 979 tokens (char/4 proxy, measured in a real pi process), with every teaching fact preserved (ADR 0019). No contract change: tool names, parameter fields, required sets, hidden `input` keys and the `input` transport are identical, so existing callers and skill flows work unchanged.

### Features

- **Leaner tool definitions (#35):** The `subagent` and `research` descriptions are terse but complete, and the parameter schemas lose only redundant wording. Standing context per conversation drops from 1,147 to 979 tokens, measured on pi 0.99.2. The pre-slim teaching text is preserved verbatim as the structural entry point for a future help-on-demand surface and pinned by anti-rot tests; the ×1.2 token regression guard now runs against the new baseline.

### Docs & Chore

- ADR 0019 records the Variant-A slimming decision, the rejected alternatives (help-on-demand now, deferred exposure plus `tool_search`) and the preserved entry point.
- GLOSSARY gains a full subagent-concepts glossary, and the `help-on-demand` entry is updated.
- CONTEXT.md references renamed to GLOSSARY.md.
- README (en + zh) updated with the new benchmark numbers.

### Full Changelog

https://github.com/hu3rror/pi-matt-subagent/compare/v0.6.0...v0.6.1

## [0.6.0] - 2026-10-01

### Highlights

0.6.0 adds a user-configurable surface, `/subagents config`, with seven tunable knobs in a lazily created file and a per-key reset. Thinking-level dispatch becomes transparent: runs record both the requested and the model-clamped effective level, and the usage line shows the difference (`high (req: xhigh)`). Tool failure contracts also settle: blocking failures and rejected research runs return explicit error-marked results with run details instead of relying on thrown errors (ADR 0016 / 0017).

### Features

- **`/subagents config`, seven knobs (ADR 0018):** `maxTasksPerCall` caps parallel tasks and chain steps; `maxConcurrency`, `perTaskOutputCap`, `researchWallClockMs` (also the hard ceiling for `input.maxWallClockMs`), `logTailBytes`, and the dispatch defaults `dispatchDefaultModel` and `dispatchDefaultThinkingLevel`. Config lives in a lazily created file (`~/.pi/agent/extensions/matt-subagent.json`). Optional dispatch knobs are omitted, never `null`, when left to inherit the main session; invalid entries degrade per key and are flagged `[degraded]` in the view.
- **Per-key reset:** `/subagents config reset <key>` drops one knob back to its default or `(inherit)`; `config reset` rebuilds the whole file. Both are in the Settings menu.
- **Autocomplete and model picker:** `/subagents` completes verbs, config sub-verbs, keys, thinking levels and run ids. Picking a dispatch model lists only models whose provider has working credentials, in the command line and the menu.
- **Clamp transparency (#34):** The requested level is pre-clamped to the target model's capability in the parent, the same pi-ai clamp the child applies, and each run records both the requested and the effective level. The usage line annotates the difference (`high (req: xhigh)`) in snapshots and blocking results alike, and background research rows show the dispatched model and level.
- **Explicit levels win over a pinned model (#34):** A role that declares its own `model` no longer drops the role or config thinking level: the short-circuit skips only the inherited layer, so an explicit role or `dispatchDefaultThinkingLevel` applies, still clamped to the model's capability.
- **Tool error signals:** Blocking subagent failures return an `isError` result carrying the failed run's details (ADR 0016); refused or failed background research calls return error-marked results with a structured receipt, verified to survive a torn-down session context (ADR 0017).

### Fixes

- A written config key whose value equals its built-in default now labels `[default]` instead of `[customized]`.
- Argument completion no longer filters suggestions away after a completed verb (`config `, `config set `, `config reset `) and restores the five top-level verbs on an empty prefix.
- Research completion pushes survive `session_shutdown` teardown with their terminal state intact.

### Docs & Chore

- New CODING_STANDARDS.md; ADRs 0016–0018; CONTEXT.md and README (zh + en) updated for the config surface, the clamp glossary entry and the narrowed short-circuit; dev-time typecheck pinned to pi 0.99.1.

### Full Changelog

https://github.com/hu3rror/pi-matt-subagent/compare/v0.5.6...v0.6.0

## [0.5.6] - 2026-09-30

### Highlights

0.5.6 shows what a finished run did with its thinking budget. Every blocking run's usage line, inline in a `subagent` tool result and as the `usage:` line in `/subagents`, now ends with the dispatched model and its thinking tier in pi's footer style: `7 turns ↑23k ↓3.5k R84k ctx:21k (sensenova) deepseek-flash • high`. Before, the line stopped at the model, so you could not tell whether the run had been asked to think at `low`, `medium`, `high`, or not at all. The shown tier is the resolved dispatch intent (per-call override, role-declared tier, inherited main-session level). A run that never pinned a tier, such as a role that pins its own model, is labelled `default`, never an invented level. The `/subagents` snapshot gains the dispatched model per run.

### Features

- The usage line shows model and thinking tier together in pi's footer style, `(sensenova) deepseek-flash • high`, with `off` rendered as `thinking off` and a never-pinned tier as `default` (ADR 0015).
- `/subagents` snapshot rows show the dispatched model and tier per blocking run, so finished runs can be audited without opening the tool result.
- Display only. Tool parameters, schemas, descriptions and the model-visible surface are unchanged, so the token benchmark baseline still holds.

### Docs & Chore

- ADR 0015 records the decision and its one surprising constraint: the shown tier is the dispatch intent, not the child's effective tier, because a spawned child reports only a level change, never its initial level.
- CONTEXT.md gains the `dispatch thinking level` glossary term; the run registry and subagent overview field lists are updated.
- README and README.zh-CN updated (usage line, ADR index).

### Full Changelog

https://github.com/hu3rror/pi-matt-subagent/compare/v0.5.5...v0.5.6

## [0.5.5] - 2026-09-27

### Highlights

0.5.5 deepens the blocking channel while keeping the observable surface frozen: tool names, schemas, descriptions and error texts are unchanged (issue #28 contract freeze). Three near-identical run-bookkeeping flows (single, parallel, chain) collapse into one orchestration module behind a Runner seam. The JSON-lines child protocol gains a pure, unit-tested parser, and result semantics consolidate into one tested cluster, so accumulation bugs surface in `node --test` instead of a live session. Three abort and teardown fixes land alongside.

### Fixes

- **SIGKILL backstop fires:** Aborting a blocking child that ignored SIGTERM never escalated, so a stuck child could outlive the grace window; it is now killed for real.
- **Late progress after a parallel abort:** A progress event arriving after the abort sweep no longer raises a frozen-update error out of the child's stdout handler. The abort sweep's terminal status wins, and the race stays contained at the channel boundary.
- **Teardown footer refresh:** Session teardown no longer refreshes the footer through a cached UI handle that may already be tearing down, so a stray throw there cannot skip child-session cleanup.

### Docs & Chore

- Blocking orchestration extracted into `src/blocking-runner.ts`, the child protocol into a pure tested parser in `src/blocking-protocol.ts`, and result semantics consolidated in `src/lib.ts`. All internal, zero contract change.
- New dev-only real-pi e2e script `scripts/blocking-e2e.ts` pins the spawn wiring the unit tests cannot reach; documented in the README.
- The dispatch-args test is now platform-agnostic. It previously passed only on win32 by accident; `npm test` is green on the Linux CI runner.

### Full Changelog

https://github.com/hu3rror/pi-matt-subagent/compare/v0.5.4...v0.5.5

## [0.5.4] - 2026-09-27

### Highlights

The three slash commands this plugin ships, `/code-review`, `/design-it-twice` and `/research`, now state what they need. TUI completion shows the required argument, and invoking one without arguments no longer leaves the agent to improvise.

### Features

- Completion shows the required argument for `/code-review <ref>`, `/design-it-twice <candidate>` and `/research <question>`.
- `/code-review` with no ref defaults to the last commit (`HEAD~1`) and opens by stating the resolved ref, so you can correct it in one reply.
- `/design-it-twice` and `/research` invoked without a candidate or question now ask you before proceeding instead of inventing one.

### Fixes

- `/code-review` with no argument used to expand to a broken instruction, "Review the changes since …", whose git commands referenced an empty ref. It now falls back to a defined default.

### Full Changelog

https://github.com/hu3rror/pi-matt-subagent/compare/v0.5.3...v0.5.4

## [0.5.3] - 2026-09-24

### Highlights

Two additive seams for the subagent ecosystem (issue #24), zero behavior change, plus one resource-safety fix and docs.

### Features

- **Subagent marker:** Blocking subagents (single, parallel, chain) now start with `PI_SUBAGENT_PARENT_SESSION=<parent session id>` in their process environment, following the current gotgenes out-of-process convention. Each nested subagent names its immediate parent; top-level manual runs carry no marker. The marker is announcement only: this package never reads it back. If you run a permission system, notification guard or identity check, you can detect spawned children by this variable instead of ppid or argv heuristics, and permission asks raised inside a child can forward to the interactive session that spawned it.
- **Research tool-call audit:** Every research run records each executed tool call as one JSON line, `{"ts": <epoch ms>, "toolCallId", "toolName", "args"}`, start events only, arguments untruncated, in `toolcalls.jsonl` beside `research.log` in the run's tmp directory. A run with no tool calls leaves an empty file; a write failure is swallowed so the artifact can never kill a run. When debugging or auditing a run, the exact commands it executed, such as full `bash` calls, are now inspectable; previously only output text was captured.

### Fixes

- **Research audit fd lifecycle:** If opening the `toolcalls.jsonl` fd fails, the `research.log` fd is closed before rethrowing, so a run cannot leak a descriptor mid-open.

### Docs & Chore

- ADR 0014 records both seams (marker choice, pure-announcement stance, audit shape) and the deliberate non-emissions: no legacy `PI_SUBAGENT_CHILD` or `PI_SUBAGENT_NAME`, no role hint, no in-process lifecycle events for the research child.
- `CONTEXT.md` gains the `subagent marker` glossary term.
- CI installs dependencies with `npm ci`.

### Full Changelog

https://github.com/hu3rror/pi-matt-subagent/compare/v0.5.2...v0.5.3

## [0.5.2] - 2026-09-23

### Highlights

Maintenance release. It repairs latent type-layer defects that accumulated since the ADR 0013 research redesign and adds a `npm run typecheck` gate so they cannot return. No runtime behavior change: the `subagent` and `research` tools work exactly as in v0.5.1.

### Fixes

- **Type-layer repairs, no behavior change:** The in-process research child session now types against the real `AgentSession`; the hand-rolled structural type omitted `prompt`. The research status card's color map is typed against `ThemeColor` instead of plain `string`. `ToolContract` parameter schemas are narrowed from `TSchema` to `TObject`, matching the `Type.Object` schemas they always held. All were latent errors the missing typecheck gate never surfaced.
- **`scripts/push-e2e.ts` cleanup:** The `session_shutdown` handler called `dispose()` on a child-session wrapper that deliberately exposes no `dispose`, and the `TypeError` was swallowed by an empty `catch`, so cleanup did nothing. The handler now tracks and aborts children. `scripts/` is not shipped in the npm package.

### Docs & Chore

- New typecheck gate: `tsconfig.json` and `npm run typecheck`, with a `typescript` devDependency. READMEs (EN + zh-CN) document the command under Development.

### Full Changelog

https://github.com/hu3rror/pi-matt-subagent/compare/v0.5.1...v0.5.2

## [0.5.1] - 2026-09-22

### Highlights

A skill-patch reapply script, plus review hardening. Dev tooling and docs only; `scripts/` is not in the package's `files`.

### Features

- **`scripts/apply-skill-patch.ts`:** Re-applies the ADR 0013 skill patches after a mattpocock upstream sync overwrites the installed `research/SKILL.md` or `wayfinder/SKILL.md`. It is idempotent, reads the patch texts straight from `docs/design/research-redesign/` as the single source of truth, and supports `--skills-dir` and `--dry-run`. Aimed at source and `pi install <path>` users; npm consumers only see the README documentation.

### Fixes

- The idempotency compare is EOL-normalized, so a sync that wrote the installed file with CRLF reads as already patched instead of being rewritten every run.
- Argument errors (unknown flag, valueless `--skills-dir`) report a clean `[error]`, a usage hint and exit 1, not an uncaught stack trace.
- Missing targets are all-or-nothing: any missing target fails the run without touching a file, so a half-patched install cannot be produced.

### Docs & Chore

- READMEs (EN + zh-CN) gain a "Re-applying the skill patches after an upstream sync" section under Development.

### Full Changelog

https://github.com/hu3rror/pi-matt-subagent/compare/v0.5.0...v0.5.1

## [0.5.0] - 2026-09-22

### Highlights

`research` delivers completions by push instead of polling, and both tools accept a per-run model override.

### Features

- **`research` redesign (ADR 0013):** The background researcher runs as an in-process second session. Every terminal state (`succeeded`, `failed`, `terminated`, `aborted`) is pushed into your context with the findings path, so there is no "read the findings file later" polling.
- **One wall-clock cap instead of budget tiers:** Every run is bounded by a single 60-minute cap, tightened per call through the hidden `maxWallClockMs`. Findings are checkpointed before each search round, and a wall-clock kill appends a slim `research-terminated` marker to the findings file, so a later session can tell truncation from completion.
- **`input` escape hatch (ADR 0011):** Per-run advanced parameters through the hidden `input` field: `subagent` accepts `model` and `thinkingOverride`, `research` accepts `model` and `maxWallClockMs`. Direct fields beat same-name JSON keys; invalid input fails loudly.
- **Contract tests and a token guard:** The two tools' descriptions and schemas are frozen as contracts and asserted to stay within baseline × 1.2.

### Fixes

- Research pushes arrive even when the child's output stream stalls, via a bounded drain on the kill paths.
- The child stream is flushed on end and the per-run log is drained before `onExit`, so the push is not lost.
- The extension's own tools are excluded from the research child's allowlist, preventing recursive re-entry.

### Docs & Chore

- ADR 0013 decision record; glossary sync (push-delivery contract, child-session definition).
- READMEs gain a Quick start section with a per-run model-override guide (EN + zh-CN).
- `prompts/research.md` and the research and wayfinder skill texts updated for push semantics.

### Breaking Changes

- `research`'s public schema no longer accepts `budget` or `budgetOverrides` (added in v0.4.0); passing either now raises an error. Drop any budget-parameter references.
- `research` delivery changed from "read the findings file later" to a four-state push, and main agents no longer poll. The pushed wording instructs reading the findings file; partial findings after a stop are judged by content.

### Full Changelog

https://github.com/hu3rror/pi-matt-subagent/compare/v0.4.1...v0.5.0

## [0.4.1] - 2026-09-20

### Highlights

Failed blocking subagent runs now report as real tool errors. When a single run or a chain step fails, aborted included, the `subagent` tool throws: the harness marks the result as an error, the error text stays byte-identical, and the transcript and TUI show the call as failed instead of a success-marked result with an ignored `isError`.

### Fixes

- **Failed blocking subagents surface as tool errors:** The failure text used to ride along in a success-marked tool result: the `isError` field was dead code the harness never reads, and pi derives error status only from throws. Aborted runs are errors too. Parallel aggregation and the research tool are unchanged (ADR 0010).
- **pi 0.86.0 sync, type-only:** Run-registry `register` status is now optional to match its runtime default; `ResearchChild.kill` widened to match node's `ChildProcess`; stale `agentScope` casts removed; kill-path pid narrowing.

### Docs & Chore

- ADR 0010 records the tool-error throw contract; the CONTEXT.md glossary gains "tool error（工具错误信号）".
- README and glossary sync carried from the v0.4.0 train, landing after that tag and shipping in this tarball.

### Full Changelog

https://github.com/hu3rror/pi-matt-subagent/compare/v0.4.0...v0.4.1

## [0.4.0] - 2026-09-18

### Highlights

`/subagents` grows from a read-only overview into a management surface, and research truncation is reworked so a hard cap never wipes your findings.

### Features

- **Manage runs from `/subagents`:** With no args it opens an interactive menu (view runs, stop run, clear finished, show log); with args it acts directly: `/subagents kill <id>`, `tail <id>`, `prune`.
  - **Stop a runaway researcher immediately:** The kill is hard and platform-split (POSIX process-group SIGKILL, Windows `taskkill /T /F`), so the whole process tree is reaped. The run resolves to `aborted`, never misreported as `failed` or `terminated`.
  - **Clear finished run records** with one confirmation; findings and log files stay on disk.
  - **Tail a background run's log** (last 4096 B) without opening files yourself.
  - Missing or dead run ids, missing args and unknown actions get clear errors instead of silent failure.
- **Research truncation reworked (D5):** A researcher checkpoints its findings before each search round, so a hard-cap kill loses at most one round. Hard caps now send a final notice (budget-status file) with a 60s grace window: wind down and exit naturally for `succeeded`, or get killed at the deadline and marked `terminated`. The log-dimension 110% line stays as an immediate runaway backstop. Budget tiers are recalibrated (tight: 10 min / 6 MiB / 400 findings lines; standard log cap 10 MiB), and the research templates and tool description steer tier choice by task scale. `/subagents` shows the real duration of finished runs instead of elapsed-since-snapshot time.

### Docs & Chore

- Open items moved out of TODO.md into the issue tracker; ADR 0009 records the run-management decisions.
- `/subagents` menu copy softened, no emoji, after UI review; the command verbs (`kill`, `tail`, `prune`) are unchanged.

### Full Changelog

https://github.com/hu3rror/pi-matt-subagent/compare/v0.3.0...v0.4.0
