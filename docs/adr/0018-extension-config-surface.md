# Extension config surface: seven tunable knobs, lazily-created JSON, and a dispatch-default layer

The subagents extension's behavioral knobs (blocking limits, the research wall-clock cap, the `/subagents tail` byte limit, and the model / thinking level a run falls back to) were hard-coded constants. We add a user-level, on-disk extension config (`~/.pi/agent/extensions/matt-subagent.json`) with seven knobs, surfaced through `/subagents config` plus a menu entry, so a user can retune without editing or forking source.

## Decision

- **Seven knobs**, each with a built-in default the code owns: `maxTasksPerCall` (8, caps **both** parallel tasks and chain steps — chain previously uncapped), `maxConcurrency` (4), `perTaskOutputCap` (50 KiB), `researchWallClockMs` (60 min), `logTailBytes` (4096), `dispatchDefaultModel`, `dispatchDefaultThinkingLevel`.
- **Lazy creation**: loading the extension never writes the file; only a user `set`/`reset` creates it. The two optional dispatch knobs are **omitted** (never `null`) when left to inherit the main session — absent means inherit, so the file only records actual overrides. Deleting the file is a clean reset; reading falls back to code defaults.
- **Validation / degrade**: reading is per-key structural validation (not one strict TypeBox object) — unknown keys are ignored, and a structurally-invalid known key (wrong type, ≤0 where a positive bound applies, unknown thinking enum, empty model string) falls back to that key's default and is flagged `degraded` in the config view. "Valid but extreme" values are user intent, not errors.
- **Dispatch precedence extended (ADR 0005)** to: per-call `model` / `thinkingOverride` > role declaration > **config default** > main-session inheritance. The `config` (dispatch) default layer is genuinely usable only if it sits *above* the always-present main-session value; placing it below (as first discussed) would make it dead. The `hasModel` short-circuit — never force `--thinking` on a role that pins its own model — is preserved, so the config default does not apply to a model-pinned role either.
- **Wall-clock ceiling tracks the config**: the `input.maxWallClockMs` schema `maximum` is built per dispatch from the effective `researchWallClockMs` (the exported schema constant stays at the code default for the contract/token tests), so raising the config raises the allowance immediately and a per-call `maxWallClockMs` may only tighten.
- **Config defaults apply to both tools** (`subagent` and `research`), and are read once per tool `execute` (no cross-call cache), so a change applies to the next run without `/reload`. The dispatch model `provider/id` string is not validated for existence at write time; an unresolvable one fails loudly at spawn/resolution (existing path).
- Unknown model/thinking precedence and per-key validation (empty string, `inherit` to clear) are intentionally simple: `set` for a dispatch knob accepts a value or `inherit`/empty to clear the override.

## Why per-key decode instead of one strict TypeBox object

A single strict object (`additionalProperties: false`) would reject unknown keys and could not record which specific key degraded; the requirement is tolerate unknown keys, degrade only the offending one, and report it. The pure decode/validate/degrade pipeline is the one testable seam (no fake pi), matching the existing runtime-free lib suites.

## Consequences

- The run registry and run-management surface are unchanged; config lives only at dispatch time and via the `/subagents config` command + menu "Settings…" entry.
- `maxTasksPerCall` now also caps chain steps — a behavior change from "parallel-only".
- The extension reads the config file on every tool run; the cost is a tiny per-call JSON decode, deliberately unbounded.