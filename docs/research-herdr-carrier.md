# herdr as an execution carrier for pi subagent runs

> **Archived:** the `hc` carrier line (herdr-core, #51/#52) superseded this as our carrier choice. This note
> covers the herdr v0.9.5 TUI workspace manager only; kept for reference.

All URLs accessed **2026-11-11 (UTC)**. Everything below marked *verified* was read from a primary
source: the installed herdr binary (v0.9.5, this machine), herdr's own docs shipped at herdr.dev /
`raw.githubusercontent.com/herdrdev/herdr@v0.9.5/docs/...`, the GitHub API for the repo, or the
cloned source of the two pi extensions. Search-engine snippets are labelled as such and are not
used as the basis of any conclusion.

---

## Verdict (read this first)

**herdr can host a delegated run, but it is not a subagent runtime — so it can replace
`node:child_process` as the *terminal* carrier, not the *subagent contract*.**

- herdr is a **terminal workspace manager**: a background Rust server that owns PTYs
  (workspaces → tabs → panes), plus a detection layer that classifies whatever coding-agent CLI is
  drawing in a pane as `idle | working | blocked | done | unknown`. It is not an agent SDK, not an
  MCP server, and it has no notion of models, thinking levels, tokens, or cost.
  *(herdr.dev docs index, /tui/docs/agents/, /tui/docs/agent-automation/; `herdr --help` v0.9.5)*
- It exposes a very usable embedding surface: a JSON-returning CLI plus a newline-delimited-JSON
  unix-socket API, with the full JSON Schema printable from the binary
  (`herdr api schema --json`, `"protocol": 22`). *(verified locally)*
- What it does **not** give you, and what the current `pi --mode json -p` subprocess carrier already
  has: a structured per-turn event stream, an exit code for the delegated run, a
  completed/aborted/killed distinction, token/cost accounting, a transcript file path, or model /
  thinking selection at the carrier boundary.
- Consequence: swapping carriers means running **pi's interactive TUI inside a pane and reading the
  screen**, i.e. throwing away the JSON-lines protocol that `src/lib.ts:1604` relies on. Both
  surveyed extensions do exactly that, and both needed extra machinery (a `subagent-done` pi
  extension, a per-run session file, metadata reporting) to rebuild what `--mode json -p` gives for
  free.
- Where herdr genuinely wins: attach/inspect a live subagent from any terminal or over SSH,
  survive parent restarts (the run keeps going after the parent dies), per-agent Git worktrees,
  roll-up state and notifications, multi-machine, event subscriptions, and a UI the human can watch.

Applicability per capability is in §3; the concrete gap list is in §5.

---

## 1. What herdr is

| Fact | Value | Source |
|---|---|---|
| Site | https://herdr.dev/ | verified (fetched) |
| Repo | https://github.com/herdrdev/herdr | GitHub API |
| Tagline | "the runtime your coding agents live on" | repo `description` via GitHub API; site copy |
| License | **Apache-2.0** (`spdx_id: Apache-2.0`) | GitHub API `/repos/herdrdev/herdr`, verified |
| Latest release | **v0.9.5, published 2026-10-14T16:07:28Z** (prior: v0.9.4 2026-10-13) | GitHub API `/releases` |
| Last activity | repo `pushed_at` 2026-11-07T12:32:55Z; created 2026-03-27 | GitHub API |
| Traction | 50,023 stars (context only) | GitHub API |
| Installed on this box | `herdr 0.9.5` (`herdr --version`), `~/.config/herdr/{config.toml,herdr.sock,session.json}` | verified locally |

One paragraph, from its own docs: herdr is *"a background server that owns your coding agents'
terminals: every pane exposes a state (idle, working, blocked, done), and the CLI and socket let the
agent itself drive the herd."* Concretely: one Rust binary, no Electron; you start it, it keeps a
persistent session of workspaces/tabs/panes; each pane is a real PTY running whatever you like
(Claude Code, Codex, pi, a shell, a test runner); closing the client or losing SSH does not kill the
panes. For a recognised agent it walks the pane's process tree and reads the **bottom of the pane**
(screen scraping), or — if the agent reports for itself — uses the agent's own state reports.
*(verified: https://herdr.dev/tui/docs/agents/, which states "Herdr finds the agent's process in each
pane and reads the live bottom of the pane … Rules in a detection manifest decide whether that screen
means idle, working, or blocked. When an integration also reports state, Herdr uses those reports
instead of reading the screen.")*

Two claims I could **not** verify from primary sources and am therefore not asserting:
"backed by Y Combinator" and the "Apache 2.0 + Rust" summary paragraph — both appeared only in a
third-party blog (postcursors.dev, via search). License and the Rust/single-binary claim are verified
independently (GitHub API; site).

**Is it "the agent orchestrator at herdr.dev"?** Yes — herdr.dev, the GitHub repo `herdrdev/herdr`,
and the installed binary are the same project (repo `homepage` = `https://herdr.dev`; the binary
prints `Home: https://herdr.dev`). Nothing else named "herdr" was needed to explain the two
extensions in §4: both call this CLI and both document it as herdr.dev.

---

## 2. Interface surfaces exposed to an embedding program

### 2.1 CLI (verified from `herdr --help`, v0.9.5)

```
herdr [options]                      # launch/attach TUI
herdr status [server|client]
herdr server                         # headless server;  server stop | reload-config
herdr api <subcommand>               # schema, snapshot, …
herdr workspace|worktree|tab|notification|agent|pane|session|integration|config|channel|machine <subcommand>
herdr --skill                        # prints bundled agent skill
herdr --version | --default-config
```

`herdr --help` closes with: *"Control Herdr panes, agents, or workspaces … run: `herdr --skill`"*, and
`--help` documents `--session <name>`, `--machine <label-or-id>`, `--remote <ssh-target>`,
`HERDR_CONFIG_PATH`, config at `~/.config/herdr/config.toml`.

Key subcommands for a carrier (each returns JSON; `cli.mdx:8` — "Most commands print JSON responses
for deterministic automation in scripts"):

- `herdr agent start <name> --kind <KIND> --pane <ID> [--timeout MS] [-- <agent-args...>]`
  — `cli.mdx:348`, `cli.mdx:355`: "`agent start` activates an existing available shell pane … The kind
  selects Herdr's canonical interactive executable, while arguments after `--` are passed to that
  executable." Supported kinds include `pi` (full list in `herdr agent start --help`).
- `herdr agent prompt <target> <text> [--wait] [--until STATUS]... [--timeout MS]` — `cli.mdx:359`.
- `herdr agent wait <target> [--until STATUS]... [--timeout MS]` — `cli.mdx:346`, `cli.mdx:326`.
- `herdr agent read <target> --source visible|recent|recent-unwrapped|detection --lines N --format text|ansi`
  — verified from `herdr agent read --help`.
- `herdr pane split|run|read|send-keys|send-text|wait-output|process-info|report-agent|report-metadata|close`
  — `cli.mdx:212,258,413`.
- `herdr worktree create|open|list|remove` — creates a Git checkout as a workspace.

### 2.2 Unix socket API (the real embedding surface)

https://herdr.dev/tui/docs/socket-api/ — *"Herdr uses newline-delimited JSON over a local socket. On
Unix, that socket is a Unix domain socket. On Windows, it is a named pipe. Send one request per line:
`{"id":"req_1","method":"ping","params":{}}`."* Transport is 1 request/response per line plus
long-lived `events.subscribe` connections.

Namespaces documented there: `session.*`, `workspace.*`, `worktree.*`, `tab.*`, `pane.*`, `agent.*`,
`events.*`, `integration.*`, `plugin.*`, `notification.*`, `client.*`, `server.*`.
Agent-relevant methods: `agent.list|get|read|explain|send_keys|prompt|wait|rename|focus|start|view.*`.

**Schema is in the binary** — no client library needed and none officially exists:

```
$ herdr api schema --json | head
{ "$schema": "https://json-schema.org/draft/2020-12/schema", "protocol": 22, "schema_version": 1, … }
```

(272,578 bytes here; `schemas/{request,success_response,event,subscription_event,error_response}`.)

### 2.3 SDK / client packages

**None found.** No npm/PyPI/Go client is shipped or referenced by the docs; the documented layers are
"Agent skill", "CLI wrappers", "Raw socket API" (`/tui/docs/socket-api/`, "Choose an integration
layer"). Both pi extensions in §4 therefore shell out to the CLI (or speak the socket directly).

### 2.4 MCP

**No MCP server** is documented in `/tui/docs/*` (index, socket-api, agent-automation, agents,
add-herdr-support, cli-reference) nor listed in the `llms.txt` doc index, and `herdr --help` has no
MCP subcommand. Not supported.

### 2.5 Config file

`~/.config/herdr/config.toml` (override: `HERDR_CONFIG_PATH`); canonical key reference is published
as `docs/next/website/src/data/config-reference.json` in the repo. Agent detection manifests can be
overridden per agent at `~/.config/herdr/agent-detection/<agent>.toml` (`/tui/docs/agents/`).

### 2.6 Plugins (a fourth surface, with caveats)

`herdr-plugin.toml` manifests declare `[[actions]]`, `[[events]]` hooks, `[[panes]]`, `[[link_handlers]]`;
`plugin.action.invoke`, `plugin.log.list`. Quoted limitation from `/tui/docs/socket-api/`:
*"Actions and panes are manifest-only; runtime action registration and runtime argv pane creation are
not part of v1."* This matters for §3(f): plugin action logs are the only place herdr records an exit
code, and you cannot define an ad-hoc action per subagent run.

---

## 3. Capability matrix for "run a delegated task"

Legend: **S** supported · **P** partial / available only through the hosted agent CLI · **N** not
supported · **?** unknown.

| # | Capability | Status | Evidence |
|---|---|---|---|
| a | Isolated context/session per run | **S (OS-level only)** | A pane is its own PTY + process tree; env is injected per launched process (`HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_SOCKET_PATH`, `HERDR_BIN_PATH` — `/tui/docs/add-herdr-support/`, env table; `/tui/docs/socket-api/` "Process-launching methods accept an `env` object … Herdr also injects …"). Agent-level conversation isolation is *not* herdr's: it comes from the agent's own `--session` flag (see pi-herdr-agents, §4.1). |
| b | Selectable model | **P (pass-through only)** | herdr has no model concept; `agent start … -- --model X` forwards argv verbatim (`cli.mdx:355`, `/tui/docs/agent-automation/`: "Arguments after `--` are passed unchanged to that executable"). |
| c | Selectable thinking/reasoning level | **P (pass-through only)** | Same mechanism (`--thinking` after `--`); no herdr-side field anywhere in the schema. |
| d | Streaming output | **P (screen snapshots, not a token stream)** | `pane read --source visible|recent|recent-unwrapped|detection`; `pane wait-output` for text/regex (`cli.mdx:413`); `events.subscribe` with `pane_output_changed`, `pane_agent_status_changed` (event enum in `herdr api schema --json`). Event history is not durable: `/tui/docs/socket-api/` — "Event history is not durable. If a subscriber falls behind the retained history … an overrun is reported". |
| e | Cancellation/kill with terminal status (aborted vs completed) | **P** | Kill: `pane.close` / `terminal.kill` (Core) / `agent send-keys ctrl+c` (a keystroke, not a signal). Status vocabulary is **only** `idle | working | blocked | done | unknown` (`AgentStatus` enum in the schema; `cli.mdx:326`) — there is **no aborted/killed/failed state**. `agent wait` also does not track turns: "It does not track individual turns. If the agent is already working, completion of that active turn may satisfy the wait." (`cli.mdx:359`) |
| f | Exit code / structured result envelope | **N for the run; S for CLI calls** | Every herdr *command* returns a JSON envelope and "A timeout or server error is emitted as JSON on stderr with exit status 1. CLI usage errors exit with status 2." (`cli.mdx:419`). But the delegated *process's* exit code is not captured: the `pane_exited` event carries only `{type, pane_id, workspace_id}` (schema `event.EventData`), and `pane.process-info` exposes pids/argv only. `exit_code` exists in the schema **only** in `PluginCommandLogInfo` (with `stdout`, `stderr`, `status: running|succeeded|failed`) — i.e. plugin action commands, not agents. |
| g | Token usage and cost | **N** | No `usage`/`cost`/`tokens_used` anywhere in the 272 KB schema. `tokens` on `pane report-metadata` / `AgentInfo` is **display metadata**: "arbitrary key/value strings", `maxProperties: 16` (pane) / `32` (agent), rendered as `$name` in sidebar rows (`cli.mdx:320-332`). Both extensions compute usage themselves from pi's session data. |
| h | Per-run log or transcript path | **P** | No herdr-owned transcript file. Options: `pane read` scrollback (in-memory; `layout.apply` "does not preserve live PTYs, scrollback, or running processes" — `/tui/docs/socket-api/`), or the agent-reported `agent_session_path` / `agent_session_id` (`PaneReportAgentParams` in the schema) which is the *agent's* own session file — for pi that is the `--session <file>` the extension passed. herdr's own logs are `~/.config/herdr/herdr{,-client,-server}.log` (from `herdr --help`), not per-run. |

Extra caveats that matter for a carrier:

- **Detection is heuristic.** Blocked detection is "deliberately strict"; when no rule matches, herdr
  falls back to `idle` and labels it `default_known_agent_idle_fallback`; "Unusual new agent prompts
  may initially show as `idle` … idle status is not authorization to approve an action."
  (`/tui/docs/agents/`)
- **`done` ≠ success**: "`idle` and `done` both mean the agent is ready for input … `done` is idle but
  not yet marked seen"; `unknown` "does not prove successful completion" (`/tui/docs/agent-automation/`).
- **`agent prompt` rejects blocked agents**: returns `agent_blocked` without sending input, and returns
  `agent_prompt_stalled` if no `working|blocked` is observed within 5 s (`cli.mdx:359`).
- **herdr's own pi integration is a pi extension**: `herdr integration install pi` writes
  `~/.pi/agent/extensions/herdr-agent-state.ts` (or `$PI_CODING_AGENT_DIR/extensions/…`)
  — `docs/next/website/src/content/docs/integrations.mdx:70-84` @ v0.9.5. So the coupling
  pi↔herdr is officially supported *in the reporting direction*.

---

## 4. The two pi extensions

Both repos were cloned and read (not just READMEs). Both are substantive, actively maintained
projects — neither is a stub or a demo.

### 4.1 https://github.com/giuseppecrj/pi-herdr-agents

| Fact | Value |
|---|---|
| Repo | https://github.com/giuseppecrj/pi-herdr-agents |
| Version / license | `pi-herdr-agents` **3.9.0**, **MIT** (`package.json`, `LICENSE`) |
| Last commit | `95a636e` **2026-11-10 18:52Z** "chore: release v3.9.0" (clone `--depth 50`) |
| Size / maturity | 298 tracked files, ADRs `docs/adr/0001…0013`, integration harness (`test/integration/*` with a `herdr-lab.ts`, `herdr-core-lab.ts`), oxlint custom rules. Mature. |
| pi API hooked | `pi.on("session_start", …)` `pi-extension/subagents/index.ts:416`; `pi.on("session_shutdown", …)` `:468`. (No `registerTool` in the top-level entry — tools come from the packages' tool module; the extension's manifest is `package.json` → `pi.extensions: ["./pi-extension/subagents/index.ts"]`.) |
| Delegates to herdr | Pane topology (split/rename/read/close), worktree create/remove, agent wait/read, sidebar markers. |
| **How it runs herdr** | **Subprocess**: `spawn("herdr", args, {stdio:["ignore","pipe","pipe"], detached: …})` — `maestro/surfaces/herdr/herdr-cli.ts:100`; `execFileSync("herdr", args, …)` — `:55`. **Plus** a second, socket-based backend ("Herdr Core"): `createConnection` speaking `terminal.run|get|list|keys|kill|rm|read` — `maestro/surfaces/herdr/herdr-core-protocol.ts:5-14`. Never in-process. |
| herdr invocation to quote | Dispatch: `["pane", "run", surface, command]` — `maestro/surfaces/herdr/herdr.ts:1108` (via `sendHerdrCommand`, `maestro/surfaces/herdr/terminal.ts:116`). |
| Child process it starts | A real pi CLI built at `maestro/adapters/pi/launch.ts:813` `buildPiCommand()`: `pi --session <file> -e <…/child/subagent-done.ts> --model <plan.model> --thinking <plan.thinking> [--models …] [--system-prompt|--append-system-prompt <file>] [--tools …] <task>` (`launch.ts:818-830`), plus env markers `PI_SUBAGENT_NAME`, `PI_SUBAGENT_AUTO_EXIT`, `PI_LAUNCH_SESSION_ENV`, `PI_CODING_AGENT_DIR`. |

Notable design facts: ADR-0008 (`docs/adr/0008-adopt-pi-only-subagent-execution.md`, 2026-08-10) removed
the external-CLI adapters and made **every** run pi-backed — herdr is only the terminal host. The repo
now explicitly calls its classic backend "legacy Herdr" and treats "Herdr Core" (socket `terminal.*`
API, `HC_TERMINAL_ID`) as the newer path; README states Core support "currently covers ordinary child
execution, not managed worktrees".

### 4.2 https://github.com/boadij/pi-herdsman

| Fact | Value |
|---|---|
| Repo | https://github.com/boadij/pi-herdsman |
| Version / license | `pi-herdsman` **0.44.0**, **Apache-2.0** (`package.json`, `LICENSE`) |
| Last commit | `0199e31` **2026-11-11 01:23Z** "chore(main): release 0.44.0" |
| Size / maturity | 213 tracked files, release-please, ~35 ADRs, peer-federation, Docker/SSH image, smoke + fault-seam tests (`bin/peer-bridge-*.test-support.mjs`). Very mature. |
| pi API hooked | `pi.registerTool({…})` (many, `extension/index.ts:1931,1951,1978,2005,2033,2061,2095,2122,2163,2211…`, plus `:2510`); `pi.registerCommand("herdsman"/"agents"/"lead"/"manager"/"chief")` (`:756,757,1659,1670,1844,2211`); events `session_start` (`:621`), `before_agent_start` (`:631`), `tool_call` (`:632`). |
| Delegates to herdr | Everything topology- and state-related: `pane split`, `pane run`, `pane report-metadata`, `agent start`, `agent get`, `agent focus`, `agent list`, `worktree *`, `api snapshot`, `status --json`. |
| **How it runs herdr** | **Subprocess through pi's own helper**: `pi.exec("herdr", args, {cwd, signal, timeout: 30_000})` — `extension/herdr.ts:495` (`runHerdr`), result parsed as JSON with envelope checks `extension/herdr.ts:522+`. Never in-process, no direct socket use for control (the unix socket is only used by `bin/peer-bridge.ts` for peer message flow). |
| herdr invocation to quote | Launch: `["agent","start", attempt.herdrAgent, "--kind","pi","--pane", paneId, "--timeout", String(…), "--", "--extension", …, "--extension", HERDR_AGENT_STATE_EXTENSION, ...agentArgs]` — `extension/herdr.ts:1776-1790`. Env/metadata: `["pane","report-metadata", paneId, …["--token","model=…"], …]` — `extension/managed-agent-runtime.ts:998-1008` (`metadataArgs` at `:1190-1219` sets `pi_herdsman_ask`, `pi_herdsman_name`, `pi_herdsman_herd_run_started_at`, `pi_herdsman_context_percent`). Topology: `pane split` at `extension/herdr.ts:1668-1682`; shell-prompt readiness poll `waitForShellMarker` at `:2229`. |

Two details worth stealing if you go this route:

- it **preflights herdr**: requires `herdr >= 0.9.1` with a running, compatible server
  (`validateHerdrStatus`, `extension/herdr.ts:41-69`), so version/envelope breakage fails loudly;
- it carries a **workaround for a herdr bug**: `// ponytail: temporary Herdr #3208 workaround. Remove
  once the supported Herdr minimum waits through fresh-shell prompt children.` followed by a retry loop
  on `herdrCode === "agent_pane_busy"` — `extension/herdr.ts:1761-1804`. Launch is therefore
  multi-step and racy by nature: split pane → wait for shell prompt → `agent start` (retry on busy).

**Neither extension runs herdr in-process.** Both shell out to the `herdr` binary; pi-herdr-agents
additionally has a socket-based "Core" backend. If your question was "do they embed a herdr runtime
library?", the answer is no — there is no such library (§2.3).

---

## 5. Applicability: herdr vs the current `pi --mode json -p` subprocess carrier

Current carrier in this repo (verified): `src/lib.ts:1604` builds
`["--mode","json","-p","--no-session", …]`, `src/blocking-protocol.ts:151` documents the abort path
("`send()` fires SIGTERM and arms a SIGKILL backstop"), plus env marker injection and per-run
stdout/stderr accumulation.

**Where herdr is a plausible stand-in.** The run is launched as a child of the herdr *server*, not of
the pi process, and lives in a PTY. So a pi extension can:

1. split a pane (`pane split --no-focus`), or create a workspace/tab;
2. `agent start <alias> --kind pi --pane <id> -- <pi args>` — herdr's own integration kind `pi`;
3. `agent prompt --wait --until done|idle|blocked --timeout N`;
4. `agent read --source recent-unwrapped --lines N` for output, `pane report-metadata` for live badges;
5. `pane close` to cancel, `worktree create` for isolation.

That is exactly what both extensions do, and it works well enough to ship (pi-herdr-agents has a
490-line integration harness and ADRs; pi-herdsman is at 0.44.0 with release automation).

**Gaps that must be solved before herdr can replace the subprocess carrier:**

1. **No structured stream.** You lose `--mode json` JSON-lines events entirely: herdr only gives screen
   snapshots (`pane read`) and coalesced `pane_output_changed` events. Every consumer of the current
   protocol (token deltas, tool-call boundaries, usage events) has to be re-implemented as
   screen/ANSI parsing, or pi must run its TUI and you accept a lossy channel.
   (pi-herdr-agents dodges this by having the child carry `-e subagent-done.ts` and writing a bounded
   result back through its own sidecar file — `launch.ts:822`.)
2. **No exit code and no terminal-status ladder.** `pane_exited` carries no status; `AgentStatus` has no
   `aborted`/`killed`/`failed`. A "killed vs completed" distinction has to be reconstructed from the
   extension's own bookkeeping (pi-herdsman keeps durable per-agent state for exactly this reason).
3. **Completion is a heuristic**, and `done` means only "idle, not yet seen". Waits don't track turns
   and can be satisfied by an unrelated idle transition; screen detection falls back to `idle` on
   unrecognised prompts (with an explicit warning in the docs that this is unsafe for automation).
4. **Two-phase launch + races.** `agent start` requires a pane already at its interactive shell prompt,
   fails with `agent_not_ready`/`agent_pane_busy`, and both extensions needed retry/poll loops and
   version preflight (herdr ≥ 0.9.1). Cancellation is a PTY close or a synthesised `ctrl+c` keystroke,
   not a signal; the current SIGTERM→SIGKILL escalation has no direct equivalent (you'd close the
   pane, losing the ability to distinguish "ignored SIGTERM" from "died").
5. **No token/cost, no transcript path.** Both must be carried by the hosted pi process (session file,
   metadata tokens) and re-derived by the extension. Today they come out of the JSON-lines stream for
   free.
6. **Hard dependency on the environment.** Requires a herdr binary + a *running, version-compatible*
   server, `HERDR_ENV=1` inside a managed pane, `herdr integration install pi`, and (in
   pi-herdr-agents) refuses Windows for worktrees/Core. A subagent carrier that only works inside
   herdr cannot be the default path for a general pi extension.
7. **Extra process/IO overhead per call.** Every control operation is a `herdr` process spawn with a
   JSON envelope (pi-herdr-agents uses 10 s/30 s/120 s deadlines; pi-herdsman wraps `pi.exec` with a
   30 s default) — cheap next to an agent turn, but it is a second RPC layer to keep consistent.

**Capabilities herdr adds that the subprocess carrier lacks:**

- A human can attach to a running subagent from any terminal/SSH (`herdr agent attach`), watch it, and
  type into it, without the parent pi process being involved.
- The run survives the parent: panes live in the server, so closing/losing the pi session (or SSH)
  does not kill children — the inverse of `child_process` semantics, where orphans are the failure mode.
- Workspace/tab/pane topology, per-agent Git worktrees, roll-up state (`working/blocked/done`) in the
  sidebar, desktop/terminal notifications (`notification.show`), and multi-machine attach.
- A documented, schema'd event subscription API (`events.subscribe`, `pane_agent_status_changed`) and a
  stable JSON contract per command, versioned via `protocol: 22`.

**Bottom line.** herdr is a legitimate *host* for a pi subagent run and two mature extensions prove the
pattern, but it is not a drop-in replacement for `pi --mode json -p`: it replaces the process
supervision layer while *removing* the machine-readable result layer. If the goal is a subjective
"carrier" (载体) that a pi extension spawns per subagent run, the honest framing is: **herdr carries the
terminal, pi still carries the agent contract.** Choosing herdr means paying for a screen-scraping
integration plus a re-built result/usage/abort model in exchange for attachability, durability, and
human visibility.

---

### Source list (all accessed 2026-11-11)

- https://herdr.dev/ , https://herdr.dev/guide/ , https://herdr.dev/llms.txt (doc index)
- https://herdr.dev/tui/docs/socket-api/ , /tui/docs/agents/ , /tui/docs/add-herdr-support/ ,
  /tui/docs/agent-automation/
- https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/docs/next/website/src/content/docs/{integrations,cli-reference,socket-api,agent-automation}.mdx
- `herdr --help`, `herdr agent start --help`, `herdr agent wait --help`, `herdr agent read --help`,
  `herdr agent prompt --help`, `herdr integration --help`, `herdr api schema --json` (herdr 0.9.5,
  local)
- GitHub API: `repos/herdrdev/herdr`, `repos/herdrdev/herdr/releases`
- Clones: `github.com/giuseppecrj/pi-herdr-agents` @ `95a636e` (v3.9.0),
  `github.com/boadij/pi-herdsman` @ `0199e31` (v0.44.0)
- Local repo: `src/lib.ts:1604`, `src/blocking-protocol.ts:151`

Unreachable / not verified: `https://herdr.dev/tui/docs/agents/` failed once (transient fetch error),
then succeeded; no other URL failed. The "Y Combinator" and "Rust + Apache 2.0" phrasing seen in
search snippets from postcursors.dev was **not** used as evidence (license and binary language
verified independently).
