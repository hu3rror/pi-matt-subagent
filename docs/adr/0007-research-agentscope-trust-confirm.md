# The research tool exposes agentScope; project-agent trust is confirmed per call, never persisted

`research` used to hardcode `user` scope, so a project-level `researcher` override never applied to background runs. `ResearchParams.agentScope` (default `user`, validated at runtime by a TypeBox Union so illegal values fail loudly) now replaces the hardcoded scope in the tool's execute path. Trust confirmation is shared with the `subagent` tool via one `confirmProjectAgents` helper: when the resolved scope admits project agents (`project`/`both`, decided by the `scopeAllowsProject` predicate) and the session has a UI and the project is not already trusted, a request that resolves to a project-source role triggers `ctx.ui.confirm`; a refusal returns `Canceled: project-local agents not approved.` and the run never starts. Headless sessions (`hasUI=false`) bypass the confirm and execute directly — a documented safety tradeoff, not a silent one.

One verified semantic worth recording: `ctx.ui.confirm` is a **per-call authorization** — it does NOT write `trust.json`, so every call re-prompts. Writing `trust.json` is pi's built-in first-entry project trust flow, not this plugin's. (This corrects an earlier assumption recorded in TODO A3.)

## Considered options

- **Keep `user`-only for background (status quo)** — simplest, but project `researcher` roles silently never ran in background, and the `agentScope` on the blocking `subagent` tool couldn't be mirrored.
- **Persist approval (write trust.json on confirm)** — would suppress future prompts but steps on pi's own trust flow and changes semantics the user didn't ask for. Rejected.
- **Per-call confirm via a shared helper (chosen)** — identical behavior to the blocking `subagent` tool, one code path for both channels, no persistence surprises.

## Consequences

- `scopeAllowsProject` centralizes the enum knowledge (which scopes admit project agents) instead of duplicating the check across tools.
- Background runs of project researchers prompt exactly like blocking ones; a refusal fails the run with a stable, machine-checkable message.
- Headless callers (CI, unattended sessions) get project agents without confirmation; the bypass is deliberate and documented rather than accidentally guarded.
