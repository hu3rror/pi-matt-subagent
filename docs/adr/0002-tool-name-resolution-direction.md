# Tool-name resolution degrades enhanced names to built-ins, never the reverse

When a role declares tools for a subagent process, the declared names are resolved against the current environment's tool registry (probed via `pi.getAllTools()`): a name the environment lacks falls back to its built-in alias, and is dropped when no alias exists either. The alias direction is always enhanced-name → built-in (`ffgrep`→`grep`, `ffind`→`find`), never the reverse, because pi-fff's built-in `grep`/`find` exist in every fff mode (override mode keeps those names with fff implementations; tools/tools-and-ui mode registers the extra `ffgrep`/`ffind` alongside them) and are always enabled by the subagent's `--tools` allowlist — so a role declaring `grep`/`find` always works, while a role declaring `ffgrep`/`ffind` breaks in override mode or without fff installed. Degrading to built-ins guarantees the declared tool exists; upgrading to fff names would trade guaranteed availability for a search enhancement subagents don't need.

## Considered options

- **Upgrade `grep`/`find` → `ffgrep`/`ffind` when fff is installed** — the original D2 task's proposal. Gives subagents fff's frecency-ranked search, but breaks in override mode (fff registers only `grep`/`find` there) and silently loses the tool — the agent only discovers it on first call. Rejected.
- **Detect fff's `override` mode and map conditionally** — the task also suggested this; it solves a failure mode that doesn't exist (override mode keeps the built-in names working) and couples the plugin to reading fff's config.
- **Registry-probe with degrade-and-drop (chosen)** — no fff coupling: the extension probes `pi.getAllTools()` and `resolveTools(tools, availableToolNames)` degrades unknown-but-aliasable names and drops unresolvable ones; without a registry the list passes through unchanged (legacy behavior).

## Consequences

- Roles declaring fff names get built-in search tools in environments without fff (or in override mode); environments with fff in tools/tools-and-ui mode keep the fff tools as declared.
- An unresolvable declared name (typo, or a tool that exists nowhere) is dropped from the `--tools` allowlist, so the child process never references a tool that doesn't exist.
- The registry probe is a main-session assumption: the child starts from the same settings/extensions, so the main registry is a superset of the child's allowlist-intersected registry (verified by e2e in both fff modes).
