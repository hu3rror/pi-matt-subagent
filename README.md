# pi-matt-subagent

> 简体中文: [README.zh-CN.md](README.zh-CN.md)

<p align="center">
  <img src="docs/banner.png" alt="pi-matt-subagent: from Matt Pocock skills to blocking/background sub-agents" width="800">
</p>

A pi plugin that makes the sub-agent instructions in [Matt Pocock's skills](https://github.com/mattpocock) actually run. When a skill says *"spawn sub-agents in parallel"* or *"fire the research subagents"*, this plugin is the execution layer: it starts real pi subprocesses, waits for them (or not, in the background case), and hands you their results.

Built as a dogfooding case study: the plugin exists because the upstream skills demanded it, and its two tools map one-to-one onto the sub-agent patterns those skills describe.

## Why it exists

Matt Pocock's skills call for sub-agents all over the place, but don't say how. Read the skills and you'll find the same request repeated:

- **`code-review`** — run the Standards and Spec axes as *parallel sub-agents* so they don't pollute each other's context.
- **`codebase-design`** (`DESIGN-IT-TWICE.md`) — spawn 3+ sub-agents, each producing a *radically different* interface for the same module.
- **`improve-codebase-architecture`** — a sub-agent walks the codebase and reports architectural friction; the final step is the design-it-twice pattern above.
- **`research`** / **`wayfinder`** — spin up a *background* agent that reads primary sources and writes findings to a file while the main session keeps working.

This plugin turns those sentences into tool calls. The roles it bundles are the same jobs the skills describe (standards-reviewer, spec-reviewer, design-explorer, architecture-scout, researcher, fact-finder), so the vocabulary carries over unchanged.

## What you get

Two tools, matching the two semantics the upstream skills need:

| Tool | Semantics | What it does |
|---|---|---|
| `subagent` | **blocking** | Runs single / parallel / chain sub-agents. Does not return until every sub-agent finishes; full results come back in one tool result. `chain` supports a `{previous}` placeholder that passes one step's output into the next. |
| `research` | **background** | Spawns a detached researcher that writes cited findings to a file, returns immediately with a handle, and lets the main agent read the file later. |

Six bundled roles: `standards-reviewer`, `spec-reviewer`, `design-explorer`, `architecture-scout`, `researcher`, `fact-finder`. User agents from `~/.pi/agent/agents/` and project agents from `.pi/agents/` override bundled roles by name; project agents sit behind a trust confirmation.

Both tools accept an optional `input` field: a JSON object string carrying advanced parameters the public schema hides — `subagent` accepts `model` (per-run model override) and `thinkingOverride` (per-run thinking level), `research` accepts `model`. Direct fields override same-name JSON keys; invalid JSON or a non-object value raises a clear model-visible error, and the merged parameters are validated against the full contract before dispatch (ADR 0011).

> **Coexistence**: this plugin registers a tool named `subagent`; similar subagents extensions do too. Avoid running this plugin alongside other subagents extensions — same tool names collide, so install one or the other, never both (ADR 0012).

Every run shows in a footer counter (`⧗ N subagents running`), including blocking runs. `/subagents` lists the full snapshot and manages runs: with no args it opens a menu (view runs / stop run / clear finished / show log); with args it runs `kill <id>`, `tail <id>`, `prune`, or `snapshot` directly. Stopping a run kills the whole research process tree (platform-split) and records the run as `aborted`, never `failed` or `terminated`. Each `research` run carries a budget (`standard` / `tight`, per-call overrides allowed). At 100% of a hard cap the researcher gets a final notice and 60 seconds to checkpoint its findings and wind down; a run that ignores the notice is killed and recorded `terminated`. Blocking runs can only be interrupted with Esc, which aborts the whole call; commands queue until it finishes.

Four slash commands — the first three are direct entries into one upstream pattern each:

- **`/code-review <ref>`** — two-axis review (Standards + Spec) of the diff since `<ref>`, run as two parallel blocking sub-agents. Use it to review a commit, branch, or merge-base. Maps to the `code-review` skill.
- **`/design-it-twice <candidate>`** — generate 3-4 radically different interface designs for one deepening candidate as parallel blocking sub-agents, then compare by depth, locality, and seam placement. Maps to `codebase-design`'s DESIGN-IT-TWICE pattern (the final step of `improve-codebase-architecture`).
- **`/research <question>`** — start a background researcher against primary sources and keep working; the findings file is read later. Maps to the `research` skill (and `wayfinder`'s research tickets).
- **`/subagents`** — overview and management of every run: follow progress, stop a runaway researcher, clear finished records, read a background run's log.

## Install

From npm:

```sh
pi install npm:pi-matt-subagent
```

Or from a local checkout:

```sh
pi install <path-to-this-repo>
```

Both install the extension (the two tools) and the prompts (the three slash commands). Verify with `pi list`; the prompts appear in the TUI's `/` completion.

## Project layout

```
extensions/subagent.ts   pi extension: registers the subagent + research tools
src/lib.ts               pure logic — role definitions, tool schemas (single source of truth),
                         input merge/validation, tool-name resolution, dispatch args, background
                         spawn; zero pi-runtime imports, tested with node --test
src/lib.test.ts          unit tests (141 passing)
scripts/                 token benchmark (Seam E) + measurement extension (dev-only)
prompts/                 the four slash-command templates
docs/adr/                decisions: dual channel, tool-name resolution, research budgets, run registry +
                         management, input escape hatch, coexistence stance
CONTEXT.md               domain glossary (subagent, role, blocking, background, input-JSON, ...)
```

Two decisions worth knowing about:

- **Tool-name resolution** (`docs/adr/0002`): a role's declared tools are resolved against the current environment's registry before dispatch. Names the environment lacks fall back to built-ins (`ffgrep` → `grep`), and unresolvable names are dropped instead of silently breaking the child process. Handles fff mode changes without coupling to fff itself.
- **Dual channel** (`docs/adr/0001`): blocking is the default mental model; only `research`/`wayfinder` use the background channel.
- **`input` escape hatch** (`docs/adr/0011`): advanced per-run parameters (`model`, `thinkingOverride`) go through the `input` JSON field — direct fields win over JSON keys, invalid input fails loudly, and the merged object is validated against the full contract before dispatch. The parameter schemas live in `src/lib.ts` as the single source of truth.

## Token benchmark

With only this extension enabled, its recurring model-facing initialization contribution is:

| Tool | Contribution | Tokens |
| --- | --- | ---: |
| `subagent` | description + parameter schema | **630** |
| `research` | description + parameter schema | **735** |

Measured with pi 0.86.1 on 2026-09-21 in a separate temporary process with an empty working directory and configuration (no other extensions, skills, context files, or slash commands; `before_agent_start` surface). Tokens are a fixed character-proxy estimate (`ceil(chars / 4)`), not a provider tokenizer billing. Reproduce with `node scripts/benchmark-tools.ts`; `npm test` asserts the serialized surface stays within baseline × 1.2 (token regression guard), so footprint creep is caught by the suite.

## Development

```sh
npm test   # 141 tests, no pi runtime needed — src/lib.ts stays runtime-free
```

The extension is a thin consumer of `src/lib.ts`; the pure functions there (dispatch-arg assembly, tool resolution, background spawn with injectable seams, `input` merge/validation, the surface contract) are what the tests cover. `node scripts/benchmark-tools.ts` refreshes the token-benchmark numbers and the guard baseline when the registered surface changes.
