<div align="center">
  <h1 id="pi-matt-subagent">pi-matt-subagent</h1>
  
  简体中文: [README.zh-CN.md](README.zh-CN.md)
  
  <img src="docs/banner.webp" alt="pi-matt-subagent: from Matt Pocock skills to blocking/background subagents" width="800">
</div>

A [pi](https://github.com/earendil-works/pi) plugin that turns the subagent instructions in [Matt Pocock's skills](https://github.com/mattpocock) into real tool calls. When a skill says *"spawn sub-agents in parallel"* or *"fire the research subagents"*, this plugin is the execution layer — it starts real pi subagents (separate subprocesses, or an in-process session for background work), waits for them, and hands you their results.

> [!WARNING]
> This plugin registers a tool named `subagent`; similar subagents extensions do too. Don't run them side by side — install one or the other, never both.

## Features

- **Two tools, two semantics** — `subagent` (blocking) and `research` (background), matching exactly what the upstream skills ask for.
- **Blocking subagents** — single, parallel, or chained agents run in separate subprocesses; results come back in one tool result, with a `{previous}` placeholder for chain handoffs.
- **Background research** — an in-process second session writes cited findings to a file while you keep working; the completion state (`succeeded` / `failed` / `terminated` / `aborted`) is pushed into your context — no polling.
- **Six bundled roles** — `standards-reviewer`, `spec-reviewer`, `design-explorer`, `architecture-scout`, `researcher`, `fact-finder` — the same jobs the skills describe.
- **Four slash commands** — `/code-review <ref>`, `/design-it-twice <candidate>`, `/research <question>`, and `/subagents` for run management.
- **Per-run overrides** — pick a different model or thinking level for one run via the hidden `input` field.
- **Live run management** — a footer counter (`⧗ N subagents running`); `/subagents` to follow, stop, or inspect runs.

## Install

```sh
pi install npm:pi-matt-subagent
```

Or from a local checkout:

```sh
pi install <path-to-this-repo>
```

Both install the extension and the prompt templates (`/code-review`, `/design-it-twice`, `/research`; `/subagents` ships with the extension). Verify with `pi list`; the prompts appear in the TUI's `/` completion.

## Quick start

Everything here is model-facing — you describe the job, the main agent makes the call.

- **Review your last commit** — `/code-review HEAD~1` runs the Standards and Spec axes as two parallel blocking subagents and reports them side by side.
- **Research while you keep working** — `/research "verify the claim that …"` returns immediately; the findings path is pushed to you when the run finishes.
- **Call the tools directly** — say "run a `subagent` review of `src/lib.ts` with `standards-reviewer`", or "start a `research` on ADR 0013 and write findings to `docs/research-0013.md`".

## The two tools

| Tool | Semantics | What it does |
| --- | --- | --- |
| `subagent` | **blocking** | Runs single / parallel / chain subagents. Does not return until every subagent finishes; full results come back in one tool result. `chain` supports a `{previous}` placeholder that passes one step's output into the next. |
| `research` | **background** | Runs an in-process second session that writes cited findings to a file, returns immediately, and pushes the completion into your context — no polling. |

Both accept an optional `input` field: a JSON object string carrying advanced parameters the public schema hides.

- `subagent` accepts `model` and `thinkingOverride` (per-run model and thinking level).
- `research` accepts `model` and `maxWallClockMs` (a wall-clock cap that may only tighten the 60-minute default).

Direct fields override same-name JSON keys; invalid JSON raises a clear model-visible error, and the merged parameters are validated against the full contract before dispatch.

```json
{
  "task": "review the diff since HEAD~1 for standards compliance",
  "agent": "standards-reviewer",
  "input": "{\"model\": \"sensenova/deepseek-v4-pro\", \"thinkingOverride\": \"high\"}"
}
```

Model names resolve against your `~/.pi/agent/models.json` registry as `provider/id`; an unresolvable name fails loudly and the run never starts.

## The four slash commands

- **`/code-review <ref>`** — two-axis review (Standards + Spec) of the diff since `<ref>`, run as two parallel blocking subagents.
- **`/design-it-twice <candidate>`** — generate 3–4 radically different interface designs for one deepening candidate as parallel blocking subagents, then compare by depth, locality, and seam placement.
- **`/research <question>`** — start a background researcher against primary sources and keep working; the completion is pushed to you with the findings path.
- **`/subagents`** — overview and management of every run: follow progress, stop a runaway researcher, clear finished records, read a run's log (`kill`, `tail`, `prune`, `snapshot`).

## Roles and dispatch

Six bundled roles come with the plugin. User agents from `~/.pi/agent/agents/` and project agents from `.pi/agents/` override bundled roles by name (project agents sit behind a trust confirmation).

Dispatch precedence: per-call override > role declaration > config default > main-session inheritance.

## Configuration

Behavioral knobs live in a lazily-created file at `~/.pi/agent/extensions/matt-subagent.json`. Loading never writes it — the file appears only when you `set` or `reset` — and deleting it restores all defaults. Values apply to the next run without `/reload`.

| Key | Default | Effect |
| --- | --- | --- |
| `maxTasksPerCall` | 8 | Caps tasks per call — parallel tasks **and** chain steps; over the cap the call is refused |
| `maxConcurrency` | 4 | Max in-flight subagent processes in parallel mode |
| `perTaskOutputCap` | 50 KiB | Byte cap for one task's summary output in parallel aggregation |
| `researchWallClockMs` | 60 min | Default background-research wall-clock cap, and the hard ceiling for `input.maxWallClockMs` |
| `logTailBytes` | 4096 | Byte cap for `/subagents tail` log reads |
| `dispatchDefaultModel` | (inherit) | Default `provider/id` when neither the call nor the role specifies one |
| `dispatchDefaultThinkingLevel` | (inherit) | Default thinking level when neither the call nor the role specifies one |

Drive it from `/subagents config`:

```
/subagents config set maxConcurrency 6
/subagents config set dispatchDefaultThinkingLevel low
/subagents config reset maxConcurrency
/subagents config reset
```

`set` writes the effective value to the file; `reset` removes one key (back to that knob's default) or the whole file. Invalid entries degrade that key to its default and are flagged `[degraded]` in the config view.

## Project layout

```
extensions/subagent.ts         pi extension: registers the two tools, the run-registry UI,
                               and the in-process research child-session factory
src/lib.ts                     pure logic — roles, tool schemas (single source of truth),
                               input merge/validation, tool-name resolution, the research
                               runner, run-registry bookkeeping; zero pi-runtime imports
src/blocking-protocol.ts       pure blocking-child protocol: JSON-lines stdout accumulation,
                               usage tracking, escalating-kill abort path
src/blocking-runner.ts         pure blocking orchestration — single / parallel / chain plans
src/*.test.ts                  unit tests (node --test, no pi runtime)
scripts/                       token benchmark + e2e scripts (dev-only)
prompts/                       the three slash-command templates
docs/adr/                      19 recorded decisions (dual channel, research redesign,
                               config surface, usage line, …)
GLOSSARY.md                    domain glossary (subagent, role, blocking, background, push, …)
```

## Development

```sh
npm test          # unit tests, no pi runtime needed
npm run typecheck # extension + lib + scripts typecheck
```

The extension is a thin consumer of `src/lib.ts`; the pure functions there (dispatch-arg assembly, tool resolution, `input` merge/validation, the surface contract) are what the tests cover. Real-pi e2e scripts (`scripts/push-e2e.ts`, `scripts/blocking-e2e.ts`) cover the process wiring that unit tests can't reach; `node scripts/benchmark-tools.ts` measures the tool surface's token contribution (~557 / ~448 tokens for `subagent` / `research`), guarded by a regression test in the suite. `node scripts/apply-skill-patch.ts` re-applies the ADR 0013 patch texts to the installed skills after a mattpocock upstream sync.
