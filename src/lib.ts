/**
 * Pure subagent logic: role definitions, agent discovery, tool resolution,
 * usage defaults, role resolution, and background-research prompt assembly.
 *
 * Zero pi-runtime imports so this module is testable with `node --test`.
 * `agentDir` and the frontmatter parser are injected so callers (the pi
 * extension) supply the runtime-specific values and tests supply stubs.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type, type TObject, type TSchema } from "typebox";
import { Value } from "typebox/value";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoleDef {
  description: string;
  tools?: string[];
  thinkingLevel?: ThinkingLevel;
  systemPrompt: string;
}

export type AgentSource = "embedded" | "user" | "project" | "unknown";

/** The pi agent-scope set, single source of truth for schema enums. */
export const AGENT_SCOPES = ["user", "project", "both"] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

/** The pi thinking-level set, single source of truth for schema enums. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

export function scopeAllowsProject(scope: AgentScope): boolean {
  return scope === "project" || scope === "both";
}

// ---------------------------------------------------------------------------
// Research wall-clock cap (ADR 0013)
//   One hard control dimension replaces the retired five-budget machinery
//   (ADR 0003/0008): a wall-clock cap, default 45 minutes, written into the
//   researcher's prompt as a single line. Findings are checkpointed before
//   each search round, so a kill or crash loses at most one round of work;
//   the runner enforces the cap by aborting the in-process child and
//   appending the slim `research-terminated` marker.
// ---------------------------------------------------------------------------

export const DEFAULT_RESEARCH_WALL_CLOCK_MS = 45 * 60 * 1000;

/**
 * Bounded window the abort paths (wall-clock kill, manual kill) give the tee
 * to drain the child's final output into the per-run log before onExit fires
 * anyway. The real child factory flushes on end, so the normal case drains
 * well within it; the bound only ever fires when abort() cannot end the
 * stream (a model call that ignores the abort) — the terminated/aborted push
 * must still arrive (ADR 0013: every terminal state is pushed).
 */
const TEE_DRAIN_BOUND_MS = 500;

// ---------------------------------------------------------------------------
// Extension config surface (ADR 0018)
//   A user-level, lazily-created JSON (`~/.pi/agent/extensions/` +
//   `CONFIG_FILE_NAME`) exposing seven tunable knobs; the decode/validate/
//   degrade and the optional-dispatch-knob handling live here (runtime-free)
//   so the whole surface is pinned with node --test and the extension stays a
//   thin wiring shell. Design rationale (per-key decode vs one strict object,
//   the dispatch precedence layer, wall-clock ceiling) is in docs/adr/0018.
// ---------------------------------------------------------------------------

export const CONFIG_FILE_NAME = "matt-subagent.json";

/**
 * One knob's static contract: `kind` drives validation/UI/autocomplete,
 * `optional` means absent/null/inherit is a valid state (the run then
 * inherits the main session). Single source for the key order, the types,
 * and every per-key branch.
 */
const CONFIG_KEY_SPECS = [
  { key: "maxTasksPerCall", kind: "number" as const, optional: false as const },
  { key: "maxConcurrency", kind: "number" as const, optional: false as const },
  { key: "perTaskOutputCap", kind: "number" as const, optional: false as const },
  { key: "researchWallClockMs", kind: "number" as const, optional: false as const },
  { key: "researchChildExtensions", kind: "extensions" as const, optional: true as const },
  { key: "logTailBytes", kind: "number" as const, optional: false as const },
  { key: "dispatchDefaultModel", kind: "model" as const, optional: true as const },
  { key: "dispatchDefaultThinkingLevel", kind: "level" as const, optional: true as const },
] as const;
type ConfigKind = (typeof CONFIG_KEY_SPECS)[number]["kind"];
interface ConfigKeySpec {
  key: ConfigKey;
  kind: ConfigKind;
  optional: boolean;
}
const CONFIG_KEY_SPEC_BY_KEY = Object.fromEntries(CONFIG_KEY_SPECS.map((s) => [s.key, s])) as Readonly<
  Record<ConfigKey, ConfigKeySpec>
>;
export const CONFIG_KEYS: readonly ConfigKey[] = CONFIG_KEY_SPECS.map((s) => s.key);
export type ConfigKey = (typeof CONFIG_KEY_SPECS)[number]["key"];

/** The per-key contract; the extension's menu and autocomplete drive on it too. */
export function configKeySpec(key: ConfigKey): ConfigKeySpec | undefined {
  return CONFIG_KEY_SPEC_BY_KEY[key];
}

export interface EffectiveConfig {
  maxTasksPerCall: number;
  maxConcurrency: number;
  perTaskOutputCap: number;
  researchWallClockMs: number;
  logTailBytes: number;
  /** provider/id; undefined => inherit the main session model. */
  dispatchDefaultModel?: string;
  /** thinking level; undefined => inherit the main session level. */
  dispatchDefaultThinkingLevel?: ThinkingLevel;
  /**
   * The extension packages loaded into a research child; undefined => the
   * curated defaults (DEFAULT_RESEARCH_CHILD_EXTENSIONS); explicit [] => no
   * extensions (network fully off).
   */
  researchChildExtensions?: string[];
}

/** Built-in defaults — the single source for the blocking limits too. */
export function defaultConfig(): EffectiveConfig {
  return {
    maxTasksPerCall: 8,
    maxConcurrency: 4,
    perTaskOutputCap: 50 * 1024,
    researchWallClockMs: DEFAULT_RESEARCH_WALL_CLOCK_MS,
    logTailBytes: 4096,
    dispatchDefaultModel: undefined,
    dispatchDefaultThinkingLevel: undefined,
    researchChildExtensions: undefined,
  };
}

/**
 * The curated default research-child extension packages (the trust surface;
 * issue #37): web/page retrieval and library-docs queries. A package is
 * eligible for this default list when it is read-only, has no external write
 * side effects, has low and explicit external cost, and serves primary-source
 * retrieval — anything else goes through the per-machine knob. See the
 * README's maintenance section.
 */
export const DEFAULT_RESEARCH_CHILD_EXTENSIONS = [
  "npm:@ssk_dev/pi-web-access-lean",
  "npm:@upstash/context7-pi",
] as const;

/**
 * The effective research-child extension list for a run: the knob when the
 * user set it (an explicit empty array fully disables extensions / network),
 * otherwise the curated defaults. Package-level (not tool-level) by design:
 * loading and activation stay separate concerns, mirroring blocking subagents
 * and pi's own `--tools` mental model (issue #37, Decision 4).
 */
export function effectiveResearchChildExtensions(cfg: EffectiveConfig): string[] {
  return cfg.researchChildExtensions ?? [...DEFAULT_RESEARCH_CHILD_EXTENSIONS];
}

export interface ConfigStatus {
  effective: EffectiveConfig;
  /** keys the user wrote and that validated (marked "customized"). */
  present: ReadonlySet<ConfigKey>;
  /** keys the user wrote but that were invalid and fell back to default. */
  degraded: ReadonlySet<ConfigKey>;
  /** the file existed but its JSON did not parse (all values default). */
  parseError: boolean;
}

/**
 * Decodes one raw config JSON value into a valid one. Numeric keys need a
 * positive integer; the optional dispatch kinds accept an explicit `null`
 * (the "inherit" marker, value undefined) and otherwise their string value
 * (non-empty model / known thinking level). valid:false degrades (caller).
 */
function decodeConfigValue(
  key: ConfigKey,
  value: unknown,
): { valid: true; value: ConfigValue } | { valid: false } {
  const spec = configKeySpec(key);
  if (!spec) return { valid: false };
  if (spec.kind === "number") {
    return typeof value === "number" && Number.isInteger(value) && value >= 1
      ? { valid: true, value }
      : { valid: false };
  }
  if (value === null) {
    return spec.optional ? { valid: true, value: undefined } : { valid: false };
  }
  // The extensions knob: a JSON array of non-empty package specifiers. An
  // explicit empty array is the "load nothing" state, so it validates too.
  if (spec.kind === "extensions") {
    if (!Array.isArray(value)) return { valid: false };
    const cleaned: string[] = [];
    for (const item of value) {
      if (typeof item !== "string") return { valid: false };
      const trimmed = item.trim();
      if (trimmed === "") return { valid: false };
      cleaned.push(trimmed);
    }
    return { valid: true, value: cleaned };
  }
  if (spec.kind === "model") {
    return typeof value === "string" && value.trim().length > 0 ? { valid: true, value } : { valid: false };
  }
  return typeof value === "string" && isThinkingLevel(value) ? { valid: true, value } : { valid: false };
}

/**
 * Parses the config file text into a validated status. `raw` is undefined/
 * null/blank when there is no file (all defaults, nothing present/degraded);
 * unparseable JSON is a parse error with all defaults.
 */
export function parseConfigFile(raw: string | undefined | null): ConfigStatus {
  const present = new Set<ConfigKey>();
  const degraded = new Set<ConfigKey>();
  const noFileStatus: ConfigStatus = { effective: defaultConfig(), present, degraded, parseError: false };
  if (raw === undefined || raw === null || raw.trim() === "") return noFileStatus;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { effective: defaultConfig(), present, degraded, parseError: true };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { effective: defaultConfig(), present, degraded, parseError: true };
  }
  const obj = parsed as Record<string, unknown>;
  let effective = defaultConfig();
  for (const key of CONFIG_KEYS) {
    if (!(key in obj)) continue;
    // decodeConfigValue already returns valid for an optional key's explicit
    // null (the inherit marker) and for any structurally-valid value; only
    // genuinely invalid values land here to degrade.
    const decoded = decodeConfigValue(key, obj[key]);
    if (decoded.valid) {
      effective = setConfigValue(effective, key, decoded.value);
      present.add(key);
    } else {
      degraded.add(key);
    }
  }
  return { effective, present, degraded, parseError: false };
}

/**
 * Parses one raw CLI/set value for a config key. Numeric keys take a
 * positive integer; the dispatch knobs take their value and accept
 * `inherit`/empty to clear the override (fall back to the main session).
 */
export function parseConfigSetValue(
  key: ConfigKey,
  rawValue: string,
): { ok: true; value: ConfigValue } | { ok: false; reason: string } {
  const spec = configKeySpec(key);
  if (!spec) return { ok: false, reason: `unknown config key "${key}"` };
  if (spec.kind === "number") {
    const n = Number(rawValue);
    if (!Number.isInteger(n) || n < 1) {
      return { ok: false, reason: `${key} must be a positive integer, got "${rawValue}"` };
    }
    return { ok: true, value: n };
  }
  // Optional knobs: inherit/empty clears the override.
  const trimmed = rawValue.trim();
  if (trimmed === "" || trimmed === "inherit") return { ok: true, value: undefined };
  // The extensions knob takes a comma-separated package list.
  if (spec.kind === "extensions") {
    const items = trimmed.split(",").map((s) => s.trim()).filter((s) => s !== "");
    return items.length > 0
      ? { ok: true, value: items }
      : { ok: false, reason: `${key} needs at least one package name, got "${rawValue}"` };
  }
  if (spec.kind === "model") return { ok: true, value: trimmed };
  if (isThinkingLevel(trimmed)) return { ok: true, value: trimmed };
  return { ok: false, reason: `dispatchDefaultThinkingLevel must be one of ${THINKING_LEVELS.join(", ")} (or inherit), got "${trimmed}"` };
}

/** Serializes an effective config to the file: required keys always, the
 * optional knobs only when set (absent = inherit the main session / curated
 * default, so `null` never appears in the file). */
export function serializeConfig(cfg: EffectiveConfig): string {
  const out: Record<string, unknown> = {};
  for (const spec of CONFIG_KEY_SPECS) {
    const value = getConfigValue(cfg, spec.key);
    if (!spec.optional || value !== undefined) out[spec.key] = value;
  }
  return JSON.stringify(out, null, 2);
}

/**
 * Removes one key from existing config file text, canonicalized, preserving
 * unknown keys (they may belong to a newer version). Returns undefined when
 * the text does not parse as an object — the caller then leaves the file
 * untouched; a broken file is rebuilt by a full `config reset`.
 */
export function omitConfigKey(raw: string, key: ConfigKey): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  delete obj[key];
  return JSON.stringify(obj, null, 2);
}

/** The three blocking knobs as a named shape (part of the config surface). */
export interface ConfigBlockingLimits {
  maxTasksPerCall: number;
  maxConcurrency: number;
  perTaskOutputCap: number;
}

type ConfigValue = number | string | string[] | ThinkingLevel | undefined;

/** Returns one knob's effective value off a config without indexing casts. */
export function getConfigValue(cfg: EffectiveConfig, key: ConfigKey): ConfigValue {
  return (cfg as unknown as Record<string, unknown>)[key] as ConfigValue;
}

/** Returns a NEW effective config with one knob replaced (call sites stay cast-free and immutable). */
export function setConfigValue(cfg: EffectiveConfig, key: ConfigKey, value: ConfigValue): EffectiveConfig {
  const out: EffectiveConfig = { ...cfg };
  (out as unknown as Record<string, unknown>)[key] = value;
  return out;
}

/** Maps the three effective blocking knobs onto the orchestration limits. */
export function configToLimits(cfg: EffectiveConfig): ConfigBlockingLimits {
  return {
    maxTasksPerCall: cfg.maxTasksPerCall,
    maxConcurrency: cfg.maxConcurrency,
    perTaskOutputCap: cfg.perTaskOutputCap,
  };
}

/** One config knob's `key = value [status]` line, shared by the overview and the menu. */
export function configKeyLabel(key: ConfigKey, status: ConfigStatus): string {
  // A key the user wrote is only "customized" when its value actually differs
  // from the built-in default; a written-but-default value (e.g. `set`ting the
  // default back, or an explicit-null inherit marker) labels as [default].
  const customized =
    status.present.has(key) && getConfigValue(status.effective, key) !== getConfigValue(defaultConfig(), key);
  const marker = status.degraded.has(key) ? "degraded" : customized ? "customized" : "default";
  const spec = configKeySpec(key);
  if (spec?.kind === "extensions") {
    // Show the effective package list (the defaults when unset) so the view
    // reflects what a research child will actually load, not just an
    // "(inherit)" marker.
    return `${key} = ${effectiveResearchChildExtensions(status.effective).join(", ")} [${marker}]`;
  }
  const value = spec?.optional
    ? (getConfigValue(status.effective, key) ?? "(inherit)")
    : String(getConfigValue(status.effective, key));
  return `${key} = ${value} [${marker}]`;
}

/** The `/subagents config` show view (pure text; the command notifies it). */
export function formatConfigOverview(status: ConfigStatus, configPath: string, exists: boolean): string {
  const lines: string[] = [
    `Config file: ${configPath}${exists ? "" : " (not created — all defaults)"}`,
  ];
  if (status.parseError) lines.push("⚠ config JSON is unparseable — using all defaults. Fix or delete the file.");
  for (const key of CONFIG_KEYS) {
    lines.push(`  ${configKeyLabel(key, status)}`);
  }
  return lines.join("\n");
}


// ---------------------------------------------------------------------------
// Tool parameter schemas and the `input` escape hatch (ADR 0011)
//   Single source of truth for both tools' model-facing parameter schemas,
//   shared by the extension (registration + dispatch validation) and the
//   contract tests (Seam D). The public schemas are the frozen surface plus
//   one optional `input` field; the full schemas add the hidden parameters
//   (`model` / `thinkingOverride`) the runtime dispatch layer already
//   supports but the public schema hides. Merge semantics follow the
//   lightweight-subagents-facade pattern: direct fields override same-name
//   JSON keys (`{ ...parsed, ...direct }`), absent/empty `input` is a
//   passthrough, and a non-object or unparseable value raises a
//   model-visible tool error. After merging, the object is validated against
//   the full contract; failures are summarized with field paths.
// ---------------------------------------------------------------------------

const AgentScopeSchema = Type.Union(AGENT_SCOPES.map((s) => Type.Literal(s)));
const ThinkingLevelSchema = Type.Union(THINKING_LEVELS.map((l) => Type.Literal(l)));

const TaskItem = Type.Object({
  agent: Type.String({ description: "Agent name" }),
  task: Type.String({ description: "Task for the agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory" })),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Agent name" }),
  task: Type.String({ description: "Task; {previous} = prior step's output" }),
  cwd: Type.Optional(Type.String({ description: "Working directory" })),
});

const SubagentPublicFields = {
  agent: Type.Optional(Type.String({ description: "Agent name (single mode)" })),
  task: Type.Optional(Type.String({ description: "Task for the agent (single mode)" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel tasks: {agent, task}[]" })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "Sequential chain: {agent, task}[]" })),
  agentScope: Type.Optional(AgentScopeSchema),
  thinkingLevel: Type.Optional(
    Type.Union(THINKING_LEVELS.map((l) => Type.Literal(l)), {
      description: "Thinking level for the whole call (single, parallel, or chain); applies to every run.",
    }),
  ),
  // ADR 0022 — the per-run model override moved from the hidden `input` set
  // into the public schema: a hidden channel no other main model reliably
  // discovers (the channel's whole point was to slim the surface, but a
  // dropped override silently falls back to the config default, which is the
  // failure this field exists to prevent). Direct field or `input` JSON both
  // merge the same way ({...parsed, ...direct}), so `input`-based callers
  // keep working.
  model: Type.Optional(Type.String({ description: "Model override for this run (provider/id)." })),
  cwd: Type.Optional(Type.String({ description: "Working directory (single mode)" })),
};

const ResearchPublicFields = {
  task: Type.String({ description: "The research question to investigate" }),
  findingsPath: Type.String({
    description: "Absolute or repo-relative path where the researcher must write findings (Markdown).",
  }),
  cwd: Type.Optional(Type.String({ description: "Working directory" })),
  tools: Type.Optional(Type.Array(Type.String({ description: "Tool names to enable" }))),
  agentScope: Type.Optional(AgentScopeSchema),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  // ADR 0022 — same move as `subagent`'s model override: public field now.
  model: Type.Optional(Type.String({ description: "Model override for this run (provider/id)." })),
};

const SUBAGENT_INPUT_DESCRIPTION =
  "JSON string of hidden params; direct fields override same-name keys. Hidden: thinkingOverride (thinking level).";

const RESEARCH_INPUT_DESCRIPTION =
  "JSON string of hidden params; direct fields override same-name keys. Hidden: maxWallClockMs (cap in ms; may only tighten the 45-min default).";

/** `subagent`'s registered (public) parameter schema — what the model sees. */
export const SUBAGENT_TOOL_PARAMS = Type.Object({
  ...SubagentPublicFields,
  input: Type.Optional(Type.String({ description: SUBAGENT_INPUT_DESCRIPTION })),
});

/** `research`'s registered (public) parameter schema — what the model sees. */
export const RESEARCH_TOOL_PARAMS = Type.Object({
  ...ResearchPublicFields,
  input: Type.Optional(Type.String({ description: RESEARCH_INPUT_DESCRIPTION })),
});

/** Hidden parameters `subagent` accepts through `input` (runtime-supported, schema-hidden). */
export const SUBAGENT_INPUT_KEYS = ["thinkingOverride"] as const;

/** Hidden parameters `research` accepts through `input` (runtime-supported, schema-hidden). */
export const RESEARCH_INPUT_KEYS = ["maxWallClockMs"] as const;

/**
 * The full `subagent` dispatch contract: the public fields (now including the
 * per-run `model` override, ADR 0022) plus the remaining hidden parameter
 * `thinkingOverride`. The merged params object is validated against this
 * before dispatch; it is never registered as the model-facing schema.
 * Unknown keys are rejected here so a mistyped `input` fails loudly.
 */
export const SUBAGENT_FULL_PARAMS = Type.Object(
  {
    ...SubagentPublicFields,
    thinkingOverride: Type.Optional(ThinkingLevelSchema),
  },
  { additionalProperties: false },
);

/**
 * Builds the full `research` dispatch contract with the given wall-clock
 * ceiling as the `maxWallClockMs` maximum. The exported base constant uses
 * the code default (so the surface-contract tests pin that bound); the
 * extension builds one per dispatch from the effective config ceiling so
 * raising it is honored without /reload, and a per-call `maxWallClockMs` may
 * only tighten (≤ the configured ceiling). The per-run `model` override is a
 * public field (ADR 0022), carried in by the `ResearchPublicFields` spread.
 */
export function buildResearchFullParams(maxCeilingMs: number): TObject {
  return Type.Object(
    {
      ...ResearchPublicFields,
      maxWallClockMs: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: maxCeilingMs,
          description: "Hidden: wall-clock hard cap in ms; may only tighten the configured ceiling.",
        }),
      ),
    },
    { additionalProperties: false },
  );
}

/** The code-default research full contract (used unless a config ceiling raises it). */
export const RESEARCH_FULL_PARAMS = buildResearchFullParams(DEFAULT_RESEARCH_WALL_CLOCK_MS);

/** `subagent`'s registered description — part of the model-facing surface (ADR 0019 slimmed). */
export const SUBAGENT_TOOL_DESCRIPTION = [
  "Delegate tasks to specialized subagents (isolated context windows, each a separate pi process).",
  "BLOCKING: returns only after every subagent finishes, all results in one result. Never spawn subagents via bash or poll files.",
  "Modes: single = agent+task; parallel = tasks array — what a skill means by 'spawn sub-agents in parallel'; sequential = chain ({previous} placeholder available).",
  "Bundled roles: standards-reviewer, spec-reviewer, design-explorer, architecture-scout, researcher, fact-finder.",
  "agentScope: user by default (user agents from ~/.pi/agent/agents plus the bundled roles); both/project add project agents from .pi/agents.",
].join(" ");

/**
 * The pre-slim `subagent` teaching text, preserved verbatim as the structural
 * entry point for the deferred help-on-demand option (ADR 0012/0019). Not
 * wired to any model-visible path today; the anti-rot test keeps the facts
 * alive — an export that looks dead is deliberate (see ADR 0019).
 */
export const SUBAGENT_HELP_TEXT = [
  "Delegate tasks to specialized subagents with isolated context windows (each runs in a separate pi process).",
  "This is the BLOCKING subagent primitive: the call does not return until every subagent finishes, and the full results are returned in one result. Do NOT spawn subagents via bash and poll files.",
  "When a skill says 'spawn sub-agents in parallel', use the `tasks` array (parallel mode); for a sequential handoff use `chain` (with the {previous} placeholder); for one task use `agent` + `task`.",
  "Bundled roles: standards-reviewer, spec-reviewer, design-explorer, architecture-scout, researcher, fact-finder.",
  'Agent scope is "user" by default (user agents from ~/.pi/agent/agents plus the bundled roles); use "both" or "project" to add project agents from .pi/agents.',
].join(" ");

/** `research`'s registered description — part of the model-facing surface (ADR 0019 slimmed). */
export const RESEARCH_TOOL_DESCRIPTION = [
  "Run a background research subagent (an in-process second session) that writes cited findings to a file and returns immediately.",
  "Use when the research or wayfinder skill asks for a background agent; completion (succeeded/failed/terminated/aborted) is pushed with the findings path — no polling, no read-later.",
  "Not for blocking work: code review and design exploration must use the subagent tool.",
  "agentScope: user by default (user agents plus the bundled researcher role); both/project allow a project-local researcher from .pi/agents to override the bundled role (untrusted projects get a confirmation first).",
  "Wall-clock capped (default 45 min); findings checkpointed before each search round, so a cap kill or crash loses at most one round.",
].join(" ");

/**
 * The pre-slim `research` teaching text, preserved verbatim as the structural
 * entry point for the deferred help-on-demand option (ADR 0012/0019). Not
 * wired to any model-visible path today; the anti-rot test keeps the facts
 * alive — an export that looks dead is deliberate (see ADR 0019).
 */
export const RESEARCH_HELP_TEXT = [
  "Run a background research subagent (an in-process second session) that writes cited findings to a file, then return immediately.",
  "Use when the research or wayfinder skill asks for a background agent: call this tool, keep working, and the completion (succeeded / failed / terminated / aborted) is pushed to you with the findings path — no polling, no \"read later\".",
  "This is NOT for code review or design exploration — those must block for their results, so use the `subagent` tool instead.",
  'Agent scope is "user" by default (user agents plus the bundled researcher role); use "both" or "project" so a project-local `researcher` from .pi/agents overrides the bundled role (untrusted projects get a confirmation first).',
  "Every run is bounded by a single wall-clock cap (default 45 minutes); findings are checkpointed before each search round, so a cap kill or crash loses at most one round of work.",
].join(" ");

/** One tool's frozen model-facing surface, shared by the extension and the contract tests. */
export interface ToolContract {
  name: string;
  description: string;
  /** The registered (public) parameter schema — what the model sees. */
  parameters: TObject;
  /** The full dispatch contract (public + hidden), used to validate merged params. */
  fullParameters: TObject;
  /** The hidden parameter names accepted through `input`. */
  hiddenKeys: readonly string[];
}

export const TOOL_CONTRACTS: readonly ToolContract[] = [
  {
    name: "subagent",
    description: SUBAGENT_TOOL_DESCRIPTION,
    parameters: SUBAGENT_TOOL_PARAMS,
    fullParameters: SUBAGENT_FULL_PARAMS,
    hiddenKeys: SUBAGENT_INPUT_KEYS,
  },
  {
    name: "research",
    description: RESEARCH_TOOL_DESCRIPTION,
    parameters: RESEARCH_TOOL_PARAMS,
    fullParameters: RESEARCH_FULL_PARAMS,
    hiddenKeys: RESEARCH_INPUT_KEYS,
  },
];

/**
 * Seam E / D — the char/4 token proxy for one tool's model-facing surface:
 * `JSON.stringify({ description, parameters })`. The benchmark measures this
 * in a real pi process (before_agent_start) and the regression guard
 * recomputes it from the same source objects, so both stay in lockstep.
 */
export function estimateToolSurfaceTokens(opts: { description: string; parameters: TSchema }): number {
  const chars = JSON.stringify({ description: opts.description, parameters: opts.parameters }).length;
  return Math.ceil(chars / 4);
}

/** The regression-guard ceiling factor: recomputed surface ≤ baseline × this. */
export const TOKEN_GUARD_MULTIPLIER = 1.2;

/**
 * Merges the direct tool-call params with the `input` escape hatch and
 * validates the result against the full parameter contract (public + hidden).
 * Returns the merged params (the direct type plus the hidden keys declared by
 * `THidden`) with `input` consumed. Throws a model-visible tool error (ADR
 * 0011 loud contract) when `input` is present but not a JSON object string, or
 * when the merged object violates the full schema — the message names the
 * offending field paths. Absent/empty `input` is a passthrough that returns
 * the direct params untouched.
 */
export function mergeToolParams<
  TParams extends Record<string, unknown>,
  THidden extends Record<string, unknown> = Record<string, unknown>,
>(opts: {
  direct: TParams;
  input?: string;
  fullSchema: TSchema;
}): TParams & THidden {
  const { direct, input, fullSchema } = opts;
  if (input === undefined || input.trim() === "") return direct as TParams & THidden;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (err) {
    throw new Error(`input must be a JSON object string: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`input must decode to a JSON object, got ${jsonValueKind(parsed)}`);
  }
  const merged = { ...(parsed as Record<string, unknown>), ...direct };
  const errors = Array.from(Value.Errors(fullSchema, merged));
  if (errors.length > 0) {
    throw new Error(`Invalid input parameters: ${summarizeValidationErrors(errors)}`);
  }
  // The full-schema validation above is the proof the cast is safe: the merged
  // object satisfies the contract the caller declared via THidden.
  return merged as TParams & THidden;
}

function jsonValueKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

interface ValidationErrorLike {
  keyword?: string;
  instancePath?: string;
  message?: string;
  params?: Record<string, unknown>;
}

/**
 * Collapses a TypeBox error stream into one field-path-keyed summary: unknown
 * keys become `<path>: unknown parameter`, union alternatives collapse to
 * `must be one of: ...`, and a type mismatch keeps its own message.
 */
function summarizeValidationErrors(errors: Iterable<ValidationErrorLike>): string {
  const byPath = new Map<string, { allowed: string[]; message?: string }>();
  for (const e of errors) {
    // TypeBox signals an unknown key as a boolean/additionalProperties pair;
    // the boolean "schema is false" entry is noise — the additionalProperties
    // entry names the offending keys.
    if (e.keyword === "boolean") continue;
    if (e.keyword === "additionalProperties") {
      // Nested unknown keys keep their parent path: the error's instancePath
      // is the containing object ("" at the root), the params name the keys.
      const base = e.instancePath || "";
      const keys = Array.isArray(e.params?.additionalProperties) ? e.params.additionalProperties : [];
      for (const key of keys) byPath.set(`${base}/${String(key)}`, { allowed: [], message: "unknown parameter" });
      continue;
    }
    const path = e.instancePath || "/";
    const current = byPath.get(path) ?? { allowed: [], message: undefined };
    if (e.keyword === "const" && e.params?.allowedValue !== undefined) {
      const literal = JSON.stringify(e.params.allowedValue);
      if (!current.allowed.includes(literal)) current.allowed.push(literal);
    } else if (e.message && (current.message === undefined || e.keyword === "type")) {
      current.message = e.message;
    }
    byPath.set(path, current);
  }
  const parts: string[] = [];
  for (const [path, issue] of byPath) {
    parts.push(
      issue.allowed.length > 0
        ? `${path}: must be one of: ${issue.allowed.join(", ")}`
        : `${path}: ${issue.message ?? "invalid"}`,
    );
  }
  return parts.join("; ");
}

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  thinkingLevel?: string;
  systemPrompt: string;
  source: AgentSource;
}

export type AgentFrontmatter = {
  name?: unknown;
  description?: unknown;
  tools?: unknown;
  model?: unknown;
  thinkingLevel?: unknown;
};

export type FrontmatterParser = (content: string) => { frontmatter: AgentFrontmatter; body: string };

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

// ---------------------------------------------------------------------------
// Embedded roles
// ---------------------------------------------------------------------------

export const EMBEDDED_ROLES: Record<string, RoleDef> = {
  "standards-reviewer": {
    description:
      "Standards axis of a two-axis review: does the diff conform to the repo's documented standards (and the smell baseline)?",
    tools: ["read", "grep", "find", "ls", "bash"],
    thinkingLevel: "medium",
    systemPrompt: `You are the Standards axis of a two-axis code review. You receive a diff command and commit list, the standards-source files, and the full smell baseline, and you report violations.

Report, per file/hunk where relevant:
(a) every place the diff violates a documented repo standard — cite the standard (file + rule);
(b) any baseline smell you spot — name it and quote the hunk.

Distinguish hard violations from judgement calls: documented-standard breaches can be hard; baseline smells are always judgement calls; a documented repo standard overrides the baseline. Skip anything tooling already enforces. Keep the report under 400 words.

The shell tool (bash on macOS/Linux, powershell on Windows) is for read-only commands only: git diff, git log, git show. Never modify files or run builds.`,
  },

  "spec-reviewer": {
    description:
      "Spec axis of a two-axis review: does the diff faithfully implement the originating issue / spec?",
    tools: ["read", "grep", "find", "ls", "bash"],
    thinkingLevel: "medium",
    systemPrompt: `You are the Spec axis of a two-axis code review. You receive a diff command and commit list, and the originating spec (path or fetched contents), and you report fidelity.

Report:
(a) requirements the spec asked for that are missing or partial;
(b) behaviour in the diff that wasn't asked for (scope creep);
(c) requirements that look implemented but where the implementation looks wrong.

Quote the spec line for each finding. Keep the report under 400 words. If no spec is available, report exactly: "no spec available".

The shell tool (bash on macOS/Linux, powershell on Windows) is for read-only commands only: git diff, git log, git show. Never modify files or run builds.`,
  },

  "design-explorer": {
    description:
      "Produces one radically different interface design for a deepened module, under a given design constraint.",
    tools: ["read", "grep", "find", "ls"],
    thinkingLevel: "medium",
    systemPrompt: `You are a design explorer. Produce ONE radically different interface design for a deepened module, given a technical brief and a single design constraint. Do NOT make changes; read and design only.

Output:
1. Interface — types, methods, params, plus invariants, ordering, error modes.
2. Usage example — how callers use it.
3. What the implementation hides behind the seam.
4. Dependency strategy and adapters.
5. Trade-offs — where leverage is high, where it is thin.

Name concepts using the brief's architecture vocabulary and the project's GLOSSARY.md domain vocabulary.`,
  },

  "architecture-scout": {
    description:
      "Walks a codebase organically and reports architectural friction (shallow modules, poor locality, leaking seams).",
    tools: ["read", "grep", "find", "ls", "bash"],
    thinkingLevel: "medium",
    systemPrompt: `You are an architecture scout. Walk the codebase organically and note where you experience friction. Do NOT make changes.

Look for:
- where understanding one concept requires bouncing between many small modules;
- shallow modules (interface nearly as complex as the implementation);
- pure functions extracted only for testability while the real bugs hide in how they are called (no locality);
- tightly-coupled modules leaking across their seams;
- parts that are untested, or hard to test through their current interface.

Apply the deletion test to anything you suspect is shallow: would deleting it concentrate complexity, or just move it? A "yes, concentrates" is the signal you want.

Report findings with exact file paths and line ranges, grouped by severity, and for each say which signal it is.`,
  },

  researcher: {
    description:
      "Investigates a question against primary sources and writes cited findings to a Markdown file.",
    tools: ["read", "grep", "find", "ls", "bash", "write", "web_access", "query-docs", "resolve-library-id"],
    thinkingLevel: "medium",
    systemPrompt: `You are a researcher. Investigate a question against primary sources available locally (official docs, source code, specs, first-party APIs — repo files and installed docs). Follow every claim back to the source that owns it.

Write your findings to a single Markdown file at the findings path given in your task, citing each claim's source. The file is the deliverable; do not answer in chat.`,
  },

  "fact-finder": {
    description:
      "Answers a precise factual question using the environment (filesystem, tools), citing sources.",
    tools: ["read", "grep", "find", "ls", "bash"],
    thinkingLevel: "low",
    systemPrompt: `You are a fact-finder. Answer a precise factual question using the environment (filesystem, tools). Report only what you can verify, with the source (file path + line, or command output). Do not speculate; if a fact is unverifiable, say so explicitly.`,
  },
};

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function parseToolList(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const tools = raw
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

function loadAgentsFromDir(
  dir: string,
  source: "user" | "project",
  parseFrontmatter: FrontmatterParser,
): AgentConfig[] {
  const agents: AgentConfig[] = [];
  if (!fs.existsSync(dir)) return agents;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter(content);
    if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: parseToolList(frontmatter.tools),
      model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
      thinkingLevel: isThinkingLevel(frontmatter.thinkingLevel) ? frontmatter.thinkingLevel : undefined,
      systemPrompt: body,
      source,
    });
  }

  return agents;
}

function findNearestProjectAgentsDir(cwd: string, configDirName: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, configDirName, "agents");
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* not a directory */
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

export function discoverAgents(
  cwd: string,
  agentDir: string,
  configDirName: string,
  scope: AgentScope,
  parseFrontmatter: FrontmatterParser,
): { agents: AgentConfig[]; projectAgentsDir: string | null } {
  const map = new Map<string, AgentConfig>();

  for (const [name, role] of Object.entries(EMBEDDED_ROLES)) {
    map.set(name, {
      name,
      description: role.description,
      tools: role.tools,
      thinkingLevel: role.thinkingLevel,
      systemPrompt: role.systemPrompt,
      source: "embedded",
    });
  }

  if (scope !== "project") {
    for (const a of loadAgentsFromDir(path.join(agentDir, "agents"), "user", parseFrontmatter)) map.set(a.name, a);
  }

  const projectAgentsDir = findNearestProjectAgentsDir(cwd, configDirName);
  if (scopeAllowsProject(scope)) {
    if (projectAgentsDir) {
      for (const a of loadAgentsFromDir(projectAgentsDir, "project", parseFrontmatter)) map.set(a.name, a);
    }
  }

  return { agents: Array.from(map.values()), projectAgentsDir };
}

// ---------------------------------------------------------------------------
// Tool resolution and usage
// ---------------------------------------------------------------------------

/**
 * Tool-name aliases for third-party enhanced search tools (e.g. fff's
 * `ffgrep`/`ffind`). Keys are the enhanced names, values are the built-in
 * names they replace. This is declarative data about fff's naming convention
 * only — nothing here imports or configures fff itself.
 *
 * Verified behavior (pi-fff source + headless child probes): fff registers
 * `ffgrep`/`ffind` in tools/tools-and-ui mode and `grep`/`find` (same names,
 * fff implementations) in override mode; the built-in `grep`/`find` exist in
 * every mode and are always enabled by the subagent's `--tools` allowlist.
 * So a role declaring `grep`/`find` always works, while a role declaring
 * `ffgrep`/`ffind` breaks in override mode or without fff installed. The
 * alias below degrades those declarations to the built-in names instead of
 * the other way around.
 */
export const TOOL_ALIASES: Record<string, string> = {
  ffgrep: "grep",
  ffind: "find",
};

/**
 * The package-name portion of a spec (drops a `npm:` prefix, keeps scoped
 * names whole): `npm:@ssk_dev/pi-web-access-lean` → `@ssk_dev/pi-web-access-lean`.
 * A bare path is returned unchanged.
 */
export function packageNameOfSpec(spec: string): string {
  return spec.startsWith("npm:") ? spec.slice(4) : spec;
}

/**
 * True when a file/extension path lives under `node_modules/<pkg>` (scoped
 * names keep their inner slash). Shared by the research child's loader
 * filter and the tool probe, so both sides of the loadout can never drift.
 * The path comparison normalizes separators so it is platform-independent,
 * and requires the package segment to end at a boundary (`/` or end of
 * string) so a shorter prefix never matches a longer package name.
 */
export function pathIsInsidePackage(filePath: string, pkgName: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/");
  const needle = `node_modules/${norm(pkgName)}`;
  const idx = norm(filePath).indexOf(needle);
  if (idx < 0) return false;
  const rest = norm(filePath).slice(idx + needle.length);
  return rest === "" || rest.startsWith("/");
}

/**
 * The research child's loadout self-report lines (issue #37), computed from
 * the LOADOUT TRUTH — the tools registered by the knob-package extensions the
 * loader filter actually kept — plus the allowlist-side drift check. The
 * child session's own `getAllTools()` is allowlist-filtered (pi's
 * `createAgentSession` drops non-allowlisted tools from the session registry),
 * so reporting on it misreads a caller-restricted `tools` list as a package
 * load failure (observed: `NO knob packages registered` while the packages
 * were installed and the loader kept them). `keptExtensionTools` must come
 * from the loader's kept extensions, never from the session.
 */
export function childLoadoutReport(input: {
  /** The knob package specs in effect for the run. */
  knob: string[];
  /** Tool names registered by knob-package extensions the loader kept. */
  keptExtensionTools: string[];
  /** The child session's actual tool names (allowlist-filtered). */
  sessionToolNames: string[];
  /** The `--tools` allowlist the caller requested. */
  allowlist: string[];
}): string[] {
  const lines: string[] = [];
  if (input.knob.length > 0) {
    const knobTools = [...new Set(input.keptExtensionTools)];
    // Both branches word themselves as a LOADOUT status and explicitly
    // decouple from run status: a loadout line must never read as a run
    // failure (the researcher still runs, and the research-status push is the
    // authoritative outcome).
    lines.push(
      knobTools.length > 0
        ? `[loadout] ok · loaded ${knobTools.length} knob tools: ${knobTools.join(", ")} — run continues; final status via the research-status push\n`
        : `[loadout] warn · no tools loaded from knob packages (${input.knob.join(
            ", ",
          )}) — check they are installed and named correctly — run continues; final status via the research-status push\n`,
    );
  }
  const childAll = new Set(input.sessionToolNames);
  const missing = input.allowlist.filter((t) => !childAll.has(t));
  if (missing.length > 0) {
    lines.push(`[child-loadout] allowlist missing from loadout: ${missing.join(", ")}\n`);
  }
  return lines;
}

/**
 * One timestamped run-stage line for the research run log (shared by the
 * child-session factory and the runner's terminal push, so the log's progress
 * lines can never drift in format between the two writers). Stage lines give
 * `/subagents tail` a live "what is it doing now" signal and anchor any
 * loadout line in a run context, instead of leaving a single line to be
 * misread as the run's outcome.
 */
export function runStageLine(stage: string, detail?: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const hh = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `[run] ${hh} ${stage}${detail ? ` · ${detail}` : ""}\n`;
}

/**
 * Resolves role tool names for a subagent's `--tools` allowlist (issue #37,
 * registry-driven shell mapping). With a tool registry (`availableToolNames`,
 * probed via `pi.getAllTools()` by the extension), the shell and platform
 * special cases are resolved against reality instead of hardcoded:
 *
 * - A declared `bash` resolves to the real `bash` when the registry has it
 *   (Git Bash / `shellPath` honored on win32); to `powershell` only when the
 *   registry has powershell but no bash; and is DROPPED when neither exists.
 * - `powershell` is *registered but not callable* off-win32 (pi's tool
 *   implementation throws "only available on Windows"), so off-win32 it is
 *   never treated as a usable shell and an explicit declaration is dropped —
 *   mirroring the same rule pi enforces at call time. (PowerShell 7 itself is
 *   cross-platform; the constraint is pi's implementation, and if upstream
 *   lifts it, the registry-driven mapping above applies with no change.)
 * - Any other declared tool falls back to its built-in alias (TOOL_ALIASES)
 *   when that alias IS in the registry, and is DROPPED when neither the
 *   declared name nor its alias exists — passing an unknown name to the
 *   child's allowlist would silently leave the agent without the tool until
 *   the first call.
 *
 * Without a registry the list passes through with the legacy win32
 * `bash`→`powershell` rewrite (pi itself only surfaces a powershell tool
 * there). `resolveToolsInternal` additionally reports the dropped names so
 * the research runner can surface declared-but-unloaded tools at start time.
 */
function resolveToolsInternal(
  tools: string[] | undefined,
  availableToolNames: ReadonlySet<string> | undefined,
  platform: NodeJS.Platform,
): { resolved: string[]; dropped: string[] } {
  if (!tools || tools.length === 0) return { resolved: [], dropped: [] };
  const resolved: string[] = [];
  const dropped: string[] = [];
  for (const t of tools) {
    if (!availableToolNames) {
      resolved.push(platform === "win32" && t === "bash" ? "powershell" : t);
      continue;
    }
    if (t === "bash") {
      if (availableToolNames.has("bash")) {
        resolved.push("bash");
      } else if (platform === "win32" && availableToolNames.has("powershell")) {
        resolved.push("powershell");
      } else {
        dropped.push(t);
      }
      continue;
    }
    if (t === "powershell" && platform !== "win32") {
      dropped.push(t);
      continue;
    }
    if (availableToolNames.has(t)) {
      resolved.push(t);
      continue;
    }
    const alias = TOOL_ALIASES[t];
    if (alias && availableToolNames.has(alias)) {
      resolved.push(alias);
      continue;
    }
    dropped.push(t);
  }
  return { resolved, dropped };
}

export function resolveTools(
  tools: string[] | undefined,
  availableToolNames?: ReadonlySet<string>,
  platform: NodeJS.Platform = process.platform,
): string[] | undefined {
  if (!tools || tools.length === 0) return tools;
  return resolveToolsInternal(tools, availableToolNames, platform).resolved;
}

export function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

// ---------------------------------------------------------------------------
// Background research
// ---------------------------------------------------------------------------

export const DEFAULT_RESEARCH_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "write",
  "web_access",
  "query-docs",
  "resolve-library-id",
];

/** This extension's own tool names — never handed to a research child (ADR 0013: no recursive extension re-entry). */
const EXTENSION_TOOL_NAMES = new Set(TOOL_CONTRACTS.map((c) => c.name));

export interface ResearchRunOptions {
  task: string;
  findingsPath: string;
  cwd: string;
  agents: AgentConfig[];
  /** Opaque model reference handed through to the child factory (pi Model in the real wiring). */
  model?: unknown;
  thinkingLevel?: string;
  tools?: string[];
  availableToolNames?: ReadonlySet<string>;
  /** Wall-clock hard cap in ms; defaults to DEFAULT_RESEARCH_WALL_CLOCK_MS (may only tighten). */
  maxWallClockMs?: number;
  /** The extension packages the research child loads (the knob's value); undefined keeps the legacy no-extension child. */
  extensions?: string[];
  /** Injectable timer deps for the wall-clock watcher (tests). */
  watcherDeps?: ResearchWatcherDeps;
  /** Manual-kill signal (/subagents kill): aborts the child and resolves the run `aborted`. */
  abortSignal?: AbortSignal;
  /** Fired exactly once when the run reaches a terminal state. */
  onExit?: (info: ResearchExitInfo) => void;
}

/** The research run's terminal outcome, resolved by the runner. */
export interface ResearchExitInfo {
  /**
   * The runner's terminal outcomes — derived from the frozen
   * TERMINAL_RUN_STATUSES (lib.ts) so the two cannot drift: the runner
   * resolves exactly these four, and a manual kill never produces
   * `terminated`.
   */
  status: (typeof TERMINAL_RUN_STATUSES)[number];
  errorMessage?: string;
}

export interface ResearchWatcherDeps {
  setTimeout?: (fn: () => void, ms?: number) => unknown;
  clearTimeout?: (id?: unknown) => void;
  now?: () => number;
}

/**
 * Assembles a pi invocation for a blocking subagent process: fixed flags
 * first, then optional --model / --thinking / --tools, then the role prompt
 * via --append-system-prompt (file path, keeping prompt text out of argv),
 * then the task positionally.
 */
export function buildDispatchArgs(opts: {
  model?: string;
  thinking?: string;
  tools?: string[];
  availableToolNames?: ReadonlySet<string>;
  promptPath?: string;
  task: string;
}): string[] {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.thinking) args.push("--thinking", opts.thinking);
  const tools = resolveTools(opts.tools, opts.availableToolNames);
  if (tools && tools.length > 0) args.push("--tools", tools.join(","));
  if (opts.promptPath) args.push("--append-system-prompt", opts.promptPath);
  args.push(`Task: ${opts.task}`);
  return args;
}

/**
 * The gotgenes out-of-process subagent marker (pure announcement): names the
 * immediate parent session id in every blocking child's environment. This
 * package never reads it; consumers (permission ask-forwarding, identity
 * guards) read it. The legacy PI_SUBAGENT_CHILD / PI_SUBAGENT_NAME and the
 * role hint PI_SUBAGENT_ROLE are deliberately not set.
 */
export const SUBAGENT_PARENT_SESSION_ENV = "PI_SUBAGENT_PARENT_SESSION";

/**
 * Builds the environment for a blocking subagent spawn: a full copy of
 * `base` (inheritance preserved), plus the subagent marker naming the parent
 * session when an id is present. Without an id the copy is unchanged — a
 * top-level run carries no marker. Pure announcement: the returned map is
 * handed to the child process and never read here.
 */
export function buildSubagentEnv(base: NodeJS.ProcessEnv, parentSessionId?: string): NodeJS.ProcessEnv {
  if (!parentSessionId) return { ...base };
  return { ...base, [SUBAGENT_PARENT_SESSION_ENV]: parentSessionId };
}

/**
 * `research`'s registered output schema (ADR 0017): the machine-readable
 * receipt returned as `structuredContent` on every successful call — exactly
 * the three string fields of `ResearchHandle`, mirrored from the same object
 * as `details`. Declared separately from the parameter schemas so the
 * model-facing surface (`description` + `parameters`) is untouched: pi's
 * provider layer never serializes `outputSchema`, so the token-regression
 * guard (which measures only the parameter surface) is unaffected.
 */
export const RESEARCH_RESULT_SCHEMA = Type.Object({
  researchId: Type.String({ description: "Unique id of the background research run." }),
  findingsPath: Type.String({ description: "Absolute path where the researcher writes cited findings (Markdown)." }),
  logPath: Type.String({ description: "Per-run log of the in-process research child session." }),
  droppedTools: Type.Optional(
    Type.Array(Type.String({ description: "Role tools declared but not loaded (package unavailable or platform-impossible)." })),
  ),
});

export interface ResearchHandle {
  researchId: string;
  findingsPath: string;
  logPath: string;
  /** Role tools that resolved to nothing (not installed / knob-disabled / platform-impossible); undefined when nothing drifted. */
  droppedTools?: string[];
}

/**
 * The minimal surface the runner needs on the in-process research child
 * (ADR 0013): its output stream (tee'd into the per-run log), a promise that
 * settles when it ends (resolves on success, rejects on failure), and an
 * abort path shared by the wall-clock kill and the manual kill. The real
 * wiring (createAgentSession + SessionManager.inMemory) lives in the
 * extension; tests inject fakes.
 */
export interface ResearchChildSession {
  /** The child's output stream; every chunk is tee'd into the per-run log. */
  output: AsyncIterable<string>;
  /**
   * Settles when the child session ends: resolves on success, rejects on
   * failure. Contract: the output stream must end before `done` settles —
   * the runner's natural-completion push (succeeded/failed) waits for the
   * full teed log, so a stream that outlives `done` would delay the push
   * indefinitely. Kill paths (wall-clock, manual) do not rely on this: the
   * runner bounds their drain, so the push arrives even on a stream that
   * never ends (see `push` in GLOSSARY.md).
   */
  done: Promise<void>;
  /** Aborts the in-process child (wall-clock kill and manual kill share this path). */
  abort(): void;
}

/**
 * One executed tool call, as reported by the child session's
 * `tool_execution_start` event — the audit hook's payload. Start events only:
 * no results, no truncation; `args` carries the final, post-mutation call
 * arguments.
 */
export interface ToolCallEvent {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export type CreateChildSession = (opts: {
  cwd: string;
  model?: unknown;
  thinkingLevel?: string;
  /** The extension packages to load into the child (knob value; undefined = legacy no-extension child). */
  extensions?: string[];
  tools?: string[];
  systemPrompt: string;
  task: string;
  findingsPath: string;
  /**
   * Optional synchronous hook invoked once per executed tool call (the child
   * session's `tool_execution_start` event). The runner uses it to append the
   * per-run toolCall audit; tests capture it through the same seam. Optional
   * so the existing fakes and the dev-only script compile unchanged.
   */
  onToolCall?: (call: ToolCallEvent) => void;
}) => ResearchChildSession;

/**
 * Resolves how to invoke the pi CLI from this process: reuse the current
 * script when run as a real pi entry point, otherwise fall back to `pi` on
 * PATH (node/bun generic runtimes) or the current executable (e.g. the pi
 * binary itself).
 */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

/**
 * Runs a background researcher as an in-process child session (ADR 0013) and
 * returns immediately with a handle. The caller does not wait for the child:
 * the runner tees the child's output into a per-run log, watches the single
 * wall-clock cap, and fires `onExit` exactly once when the run reaches a
 * terminal state — `succeeded` on a natural completion, `failed` on a
 * throwing child, `terminated` when the wall-clock cap aborts the run (the
 * slim `research-terminated` marker is appended to the findings file first),
 * `aborted` when `abortSignal` fires (manual kill).
 * `createChildSession` is injectable for tests.
 */
export function runBackgroundResearch(
  opts: ResearchRunOptions,
  createChildSession: CreateChildSession,
): ResearchHandle {
  const agent = resolveRole(opts.agents, "researcher");
  if (!agent) throw new Error('No "researcher" role available');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-research-"));
  const logPath = path.join(tmpDir, "research.log");
  const toolCallsPath = path.join(tmpDir, "toolcalls.jsonl");
  const researchId = path.basename(tmpDir);

  const deps = opts.watcherDeps ?? {};
  const nowFn = deps.now ?? Date.now;
  const setTimer = deps.setTimeout ?? ((fn: () => void, ms?: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimeout ?? ((id?: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));

  const maxWallClockMs = opts.maxWallClockMs ?? DEFAULT_RESEARCH_WALL_CLOCK_MS;
  // Resolution is registry-driven (issue #37): the resolved set becomes the
  // child's allowlist AND the prompt's tool-name line, so the two cannot
  // drift; names that resolved to nothing are surfaced at start time (handle
  // + per-run log) instead of surfacing as model-side tool-not-found loops.
  const { resolved, dropped } = resolveToolsInternal(
    opts.tools ?? agent.tools ?? DEFAULT_RESEARCH_TOOLS,
    opts.availableToolNames,
    process.platform,
  );
  const tools = resolved.filter((t) => !EXTENSION_TOOL_NAMES.has(t));
  const systemPrompt = buildResearchPrompt(agent, opts.task, opts.findingsPath, maxWallClockMs, tools);

  // The runner owns the per-run artifacts: the output log (every child output
  // chunk appended, serving `/subagents tail`) and the toolCall audit (one
  // JSON object per line, written through the child factory's optional
  // `onToolCall` hook). Both fds are opened eagerly and closed through the
  // same single exit path below — or on a synchronous factory throw — so a
  // stuck run cannot leak either. If the second open fails, the first fd is
  // closed before rethrowing: the pair must never leak mid-open.
  const logFd = fs.openSync(logPath, "a");
  if (dropped.length > 0) {
    // The drift report lands in the per-run log before anything else, so
    // /subagents tail shows it even when the child never emits a line.
    try {
      fs.writeSync(logFd, `[research-drift] declared but not loaded: ${dropped.join(", ")}\n`);
    } catch {
      /* a log write must never kill the run */
    }
  }
  let toolCallsFd: number;
  try {
    toolCallsFd = fs.openSync(toolCallsPath, "a");
  } catch (err) {
    try {
      fs.closeSync(logFd);
    } catch {
      /* already closed */
    }
    throw err;
  }
  const closeFds = () => {
    try {
      fs.closeSync(logFd);
    } catch {
      /* already closed */
    }
    try {
      fs.closeSync(toolCallsFd);
    } catch {
      /* already closed */
    }
  };
  // The audit line schema: start events only — `{ts, toolCallId, toolName,
  // args}`, no results, no truncation. Write failures are swallowed: a debug
  // artifact must never kill a research run.
  const onToolCall = (call: ToolCallEvent) => {
    try {
      fs.writeSync(
        toolCallsFd,
        `${JSON.stringify({ ts: nowFn(), toolCallId: call.toolCallId, toolName: call.toolName, args: call.args })}\n`,
      );
    } catch {
      /* audit write failures are swallowed */
    }
  };

  let child: ResearchChildSession;
  try {
    child = createChildSession({
      cwd: opts.cwd,
      model: opts.model,
      thinkingLevel: opts.thinkingLevel,
      extensions: opts.extensions,
      tools,
      systemPrompt,
      task: opts.task,
      findingsPath: opts.findingsPath,
      onToolCall,
    });
  } catch (err) {
    // A synchronous factory throw (the seam is test-injectable) must not leak
    // the eagerly-opened fds: close both and rethrow.
    closeFds();
    throw err;
  }

  const tee = (async () => {
    for await (const chunk of child.output) {
      fs.writeSync(logFd, chunk);
    }
  })();

  let terminal = false;
  let timer: unknown | undefined;
  // The single exit path for the per-run log: resolves once the tee has
  // flushed (natural end) or, for a stuck stream, after the bound — closing
  // the fd exactly once either way. onExit fires only after this resolves, so
  // the push's lastOutput tail never sees a half-flushed log, and a stream
  // that never ends cannot lose the push (ADR 0013: every terminal state is
  // pushed). Abort paths (wall-clock kill, manual kill) pass `bounded`:
  // abort() may not end the child's stream (a model call that ignores the
  // abort). The terminal status is resolved synchronously by the caller, so a
  // later done-rejection cannot override it; only the onExit delivery waits.
  const drainLog = (bounded: boolean): Promise<void> => {
    if (!bounded) {
      return tee
        .finally(() => {
          closeFds();
        })
        .catch(() => {});
    }
    let bound: unknown | undefined;
    return new Promise<void>((resolve) => {
      bound = setTimer(() => {
        // The stream is stuck: close both fds so a stuck run does not leak
        // them for the rest of the session. Any write that lands after the
        // close fails harmlessly (the tee rejection is swallowed below).
        closeFds();
        resolve();
      }, TEE_DRAIN_BOUND_MS);
      (bound as { unref?: () => void } | undefined)?.unref?.();
      void tee
        .finally(() => {
          if (bound !== undefined) clearTimer(bound);
          closeFds();
          resolve();
        })
        .catch(() => {});
    });
  };
  const settle = (
    status: ResearchExitInfo["status"],
    extra: { errorMessage?: string } = {},
    drain: "until-drained" | "bounded" = "until-drained",
  ) => {
    if (terminal) return;
    terminal = true;
    if (timer !== undefined) clearTimer(timer);
    const drained = drainLog(drain === "bounded");
    void drained.then(
      () => opts.onExit?.({ status, ...extra }),
      () => opts.onExit?.({ status, ...extra }),
    );
  };

  timer = setTimer(() => {
    child.abort();
    // The marker lands before onExit so a standalone reader can tell a
    // wall-clock cut from a complete run without the push's context.
    appendResearchTerminatedMarker(opts.findingsPath, new Date(nowFn()).toISOString());
    settle("terminated", {}, "bounded");
  }, maxWallClockMs);
  const asTimeout = timer as { unref?: () => void } | undefined;
  asTimeout?.unref?.();

  child.done.then(
    () => settle("succeeded"),
    (err: unknown) => settle("failed", { errorMessage: err instanceof Error ? err.message : String(err) }),
  );

  if (opts.abortSignal) {
    const onAbort = () => {
      child.abort();
      settle("aborted", {}, "bounded");
    };
    if (opts.abortSignal.aborted) {
      // A pre-aborted signal settles on a microtask, not synchronously: onExit
      // must never fire before the runner returns (the extension reads the
      // handle inside onExit). The child factory closes the same race by
      // checking its own abort flag before the session starts.
      queueMicrotask(onAbort);
    } else {
      opts.abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  }

  return {
    researchId,
    findingsPath: opts.findingsPath,
    logPath,
    ...(dropped.length > 0 ? { droppedTools: dropped } : {}),
  };
}

// ---------------------------------------------------------------------------
// Role resolution and research prompt
// ---------------------------------------------------------------------------

export function resolveRole(agents: AgentConfig[], name: string): AgentConfig | undefined {
  return agents.find((a) => a.name === name);
}

/**
 * Decides the thinking level for a subagent's pi invocation.
 * Priority: per-call override > the role's configured level > the config
 * default > the main session's inherited level (ADR 0005 extended). A
 * per-call override wins even when the agent pins its own model (explicit
 * escape hatch); without an override, a model-pinned agent gets undefined so
 * the caller does not force --thinking on a model that brings its own
 * reasoning configuration (historical behavior preserved).
 */
export function resolveThinkingLevel(opts: {
  roleLevel?: string;
  override?: string;
  inherited?: string;
  hasModel: boolean;
  configLevel?: string;
}): string | undefined {
  if (opts.override) return opts.override;
  // ADR 0018: a pinned model beats only the inherited layer; explicit role/config levels apply.
  const explicit = opts.roleLevel ?? opts.configLevel;
  if (opts.hasModel) return explicit;
  return explicit ?? opts.inherited;
}

/**
 * Resolves one run's thinking level (ADR 0005/0018/0020): a per-task/per-step
 * `thinkingLevel` (ADR 0020) wins over the call-level override; both override
 * the role tier, then the config default, then the inherited main-session level.
 */
export function resolveDispatchThinking(
  agent: AgentConfig | undefined,
  d: { thinkingLevel?: string; thinkingOverride?: string; configLevel?: string },
  taskLevel?: string,
): string | undefined {
  return resolveThinkingLevel({
    roleLevel: agent?.thinkingLevel,
    override: taskLevel ?? d.thinkingOverride,
    inherited: d.thinkingLevel,
    hasModel: Boolean(agent?.model),
    configLevel: d.configLevel,
  });
}

/**
 * Plans the thinking level to dispatch for one run. Undefined when there is
 * no request — the old path passes no `--thinking` and records nothing.
 * Otherwise returns the requested level plus the effective level the clamp
 * produced (the clamp is injected; the extension binds `clampThinkingLevel`
 * to the resolved target model, so parent and child agree by construction —
 * ADR 0018 clamp transparency) and whether the clamp changed it.
 */
export function planRunThinking(
  requested: string | undefined,
  clampToModel: (level: string) => string,
): { requested: string; actual: string; clamped: boolean } | undefined {
  if (requested === undefined) return undefined;
  const actual = clampToModel(requested);
  return { requested, actual, clamped: actual !== requested };
}

/**
 * Assembles the researcher prompt (ADR 0013): the role prompt, the findings
 * path, a single wall-clock cap line the model self-manages, and the
 * checkpoint rule. No budget block, no tiers — the wall-clock line and the
 * checkpoint instruction are the whole budget surface.
 */
export function buildResearchPrompt(
  agent: AgentConfig,
  task: string,
  findingsPath: string,
  maxWallClockMs: number = DEFAULT_RESEARCH_WALL_CLOCK_MS,
  toolNames?: string[],
): string {
  const toolLine =
    toolNames === undefined
      ? ""
      : toolNames.length > 0
        ? `Available tools (the only tools you can call): ${toolNames.join(", ")}.`
        : "Available tools: none.";
  const middle = toolLine ? [toolLine, ""] : [];
  return [
    agent.systemPrompt,
    "",
    `Findings path: ${findingsPath}`,
    "",
    `You have at most ${formatDuration(maxWallClockMs)} of wall-clock time before the run is cut off.`,
    "",
    ...middle,
    "Before each new search round, rewrite the findings file with everything gathered so far (a checkpoint), so a cut loses at most one round of work.",
    "",
    "Stop as soon as you have enough information to answer well — do not chase source code or implementation details beyond that.",
    "",
    `Task: ${task}`,
  ].join("\n");
}

/**
 * The pushed content for one terminal state — load-bearing: it becomes the
 * triggered turn's prompt, so it must instruct reading the findings file
 * (ADR 0013, prototype lesson), not just summarize. Runtime-free so the
 * wording is pinned by node --test.
 */
export function researchStatusContent(
  status: ResearchExitInfo["status"],
  findingsPath: string,
  logPath?: string,
): string {
  const log = logPath ? ` The run log is at ${logPath}.` : "";
  switch (status) {
    case "succeeded":
      return `The background research you started has completed. Read the findings file at ${findingsPath} to collect the results.`;
    case "failed":
      return `The background research you started failed. Read any partial findings at ${findingsPath} to see what exists.${log}`;
    case "terminated":
      return `The background research you started was stopped by its wall-clock limit, so the findings may be truncated. Read them at ${findingsPath} and judge by content.${log}`;
    case "aborted":
      return `The background research you started was stopped. Read any partial findings at ${findingsPath} to decide next steps.${log}`;
  }
}

/**
 * The push payload for one research terminal state (ADR 0013): the frozen
 * status union plus the paths the pushed instruction and the renderer card
 * need. Shared by the extension's `sendMessage` call and its message renderer
 * so the two cannot drift — the renderer's `status` stays on the frozen union
 * instead of re-widening to `string`.
 */
export interface ResearchStatusDetails {
  status: (typeof TERMINAL_RUN_STATUSES)[number];
  findingsPath: string;
  logPath?: string;
  lastOutput?: string;
}

// ---------------------------------------------------------------------------
// Research termination marker (ADR 0013)
//   The slim `research-terminated` marker the runner appends to the findings
//   file on a wall-clock kill: reason (always `wall_clock_exceeded`) and a
//   timestamp. A standalone reader — a later session, or the file shipped as
//   the deliverable — tells truncation from completion by its presence,
//   without the push's context. `partial` is implied by the marker itself.
// ---------------------------------------------------------------------------

/**
 * Appends the slim termination marker to the findings file (creating it if
 * absent) on a wall-clock kill. Frozen format, asserted by tests.
 */
export function appendResearchTerminatedMarker(findingsPath: string, at: string): void {
  const lines = [
    `<!-- ${RESEARCH_TERMINATED_MARKER}`,
    "reason: wall_clock_exceeded",
    `at: ${at}`,
    "-->",
  ];
  fs.appendFileSync(findingsPath, `\n${lines.join("\n")}\n`, "utf-8");
}
/** Human-readable duration: "900 ms", "2.2 s", "15 min". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${trimNumber(ms / 1000)} s`;
  return `${trimNumber(ms / 60_000)} min`;
}

function trimNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const fixed = n.toFixed(2);
  return fixed.replace(/\.?0+$/, "");
}

// ---------------------------------------------------------------------------
// Run registry (D3)
//   In-process registry of every tracked subagent run — blocking (single /
//   parallel / chain steps) and background (research) alike — plus the pure
//   display layer (`formatRunSnapshot`) and the outcome mappings used by the
//   extension to move runs to their terminal status. Zero pi-runtime imports
//   so it is testable with `node --test`.
// ---------------------------------------------------------------------------

export const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "aborted", "terminated"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ["queued", "running"];
// `satisfies` (not the plain annotation) so the element type stays the four
// literals: a `readonly RunStatus[]` annotation would widen them to the full
// six-member RunStatus, silently defeating derived types like
// ResearchExitInfo.status (the runner resolves only terminal outcomes).
export const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "aborted", "terminated"] as const satisfies readonly RunStatus[];

export function isActiveRunStatus(status: RunStatus): boolean {
  return (ACTIVE_RUN_STATUSES as readonly string[]).includes(status);
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

/**
 * The legal status transitions. A queued run may be aborted before its slot
 * opens; a running run may terminate into any terminal status.
 */
const RUN_STATUS_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: ["running", "aborted"],
  running: ["succeeded", "failed", "aborted", "terminated"],
  succeeded: [],
  failed: [],
  aborted: [],
  terminated: [],
};

/** The marker string the runner appends to a hard-capped run's findings file. */
export const RESEARCH_TERMINATED_MARKER = "research-terminated";

/**
 * One tracked run. `channel` is which of the two plugin channels spawned it:
 * blocking (subagent tool) or background (research tool). Display fields are
 * optional and channel-dependent: blocking runs carry usage; background runs
 * carry findings/log paths.
 */
export interface RunEntry {
  id: string;
  role: string;
  source: AgentSource;
  channel: "blocking" | "background";
  status: RunStatus;
  startedAt: number;
  /** Stamped on the terminal transition; display duration for finished runs. */
  endedAt?: number;
  lastOutput?: string;
  usage?: UsageStats;
  /** Dispatched model ref (`provider/id`, or a bare id for a pinned role); display-only. */
  model?: string;
  /** Effective dispatch thinking level; undefined when the run never pinned one (see ADR 0005). */
  thinkingLevel?: string;
  /** Requested level before clamping; only present when the resolved model could be clamped against (see ADR 0018). */
  requestedThinking?: string;
  findingsPath?: string;
  logPath?: string;
}

export type RunPatch = Partial<Omit<RunEntry, "id" | "status">> & { status?: RunStatus };

export interface RunRegistry {
  register(entry: Omit<RunEntry, "id" | "status"> & { status?: RunStatus }): string;
  update(id: string, patch: RunPatch): void;
  get(id: string): RunEntry | undefined;
  /** Drops an entry entirely (prune); no frozen guards — the caller picks which runs are removable. */
  remove(id: string): void;
  /** All entries in insertion order (unsorted). */
  list(): RunEntry[];
  snapshot(): RunEntry[];
  clear(): void;
}

/**
 * In-process registry of subagent runs. Terminal runs are frozen: any further
 * update throws, and illegal transitions throw without mutating. `snapshot`
 * returns a detached, startedAt-ascending copy for display.
 * `onChange` fires after every successful mutation (register / update / remove
 * / clear), so UI subscribers (the footer counter) converge by construction
 * instead of relying on every caller remembering to sync.
 */
export function createRunRegistry(now: () => number = Date.now, onChange?: () => void): RunRegistry {
  const runs = new Map<string, RunEntry>();
  let nextId = 1;

  const register = (entry: Omit<RunEntry, "id" | "status"> & { status?: RunStatus }): string => {
    const id = `run-${nextId++}`;
    runs.set(id, { ...entry, id, status: entry.status ?? "queued" });
    onChange?.();
    return id;
  };

  const update = (id: string, patch: RunPatch): void => {
    const run = runs.get(id);
    if (!run) return;
    if (isTerminalRunStatus(run.status)) {
      throw new Error(`run ${id} is terminal (${run.status}); updates are frozen`);
    }
    const next = patch.status ?? run.status;
    if (next !== run.status && !RUN_STATUS_TRANSITIONS[run.status].includes(next)) {
      throw new Error(`illegal status transition ${run.status} -> ${next} for run ${id}`);
    }
    runs.set(id, {
      ...run,
      ...patch,
      status: next,
      endedAt: isTerminalRunStatus(next) ? now() : undefined,
    });
    onChange?.();
  };

  const snapshot = (): RunEntry[] =>
    Array.from(runs.values())
      .map((r) => ({ ...r, usage: r.usage ? { ...r.usage } : undefined }))
      .sort((a, b) => a.startedAt - b.startedAt);

  return {
    register,
    update,
    get: (id) => runs.get(id),
    remove: (id) => {
      runs.delete(id);
      onChange?.();
    },
    list: () => Array.from(runs.values()),
    snapshot,
    clear: () => {
      runs.clear();
      onChange?.();
    },
  };
}

/** The display icon per status (frozen mapping). */
export const RUN_STATUS_ICONS: Record<RunStatus, string> = {
  queued: "⏳",
  running: "▶",
  succeeded: "✓",
  failed: "✗",
  aborted: "⊘",
  terminated: "⛔",
};

/** Formats the elapsed duration since `startedAt` (reuses formatDuration). */
function formatElapsed(startedAt: number, now: number): string {
  return formatDuration(Math.max(0, now - startedAt));
}

/** Human-readable start time: local HH:MM:SS. */
function formatStartTime(startedAt: number): string {
  const d = new Date(startedAt);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/** Displayed for a run whose thinking level was never pinned (`undefined`). */
export const THINKING_UNRESOLVED_LABEL = "default";

/**
 * Splits a dispatched model reference into provider and id. The dispatch
 * default is `provider/id`; a role-pinned model may be a bare id, in which
 * case there is no provider to show. A slash with an empty side carries no
 * provider information, so `/id` and `prov/` degrade to a bare id (stray slash
 * trimmed) instead of rendering a provider pair around nothing.
 */
export function splitModelRef(model: string): { provider?: string; id: string } {
  const slash = model.indexOf("/");
  if (slash < 0) return { id: model };
  const provider = model.slice(0, slash);
  const id = model.slice(slash + 1);
  if (!provider) return { id };
  if (!id) return { id: provider };
  return { provider, id };
}

/**
 * The model segment of a usage line, in pi's footer style —
 * `(provider) id • level`. `off` keeps pi's `thinking off` wording in both
 * positions; an unresolved level renders as `default`, because the child then
 * picked its own tier (ADR 0005: a model-pinned role gets no `--thinking` flag,
 * and the child stream does not report the effective level — ADR 0015).
 * Without a model the level still shows, as a standalone `thinking:<level>`
 * token (`thinking off` for `off`, the same wording as the attached form).
 * When `requestedThinking` differs from the effective level, the clamp is
 * annotated inline (`high (req: xhigh)`) — ADR 0018 clamp transparency.
 */
export function formatModelSegment(
  model: string | undefined,
  thinking: string | undefined,
  requestedThinking?: string,
): string {
  const base =
    thinking === undefined ? THINKING_UNRESOLVED_LABEL : thinking === "off" ? "thinking off" : thinking;
  const label =
    requestedThinking !== undefined && requestedThinking !== thinking ? `${base} (req: ${requestedThinking})` : base;
  if (!model) return label.startsWith("thinking ") ? label : `thinking:${label}`;
  const { provider, id } = splitModelRef(model);
  return `${provider ? `(${provider}) ` : ""}${id} • ${label}`;
}

/**
 * Human-readable usage line for one run (registry rows and tool-result
 * renderers share it). Turns pluralize properly; context tokens, model, and
 * thinking level are opt-in display fields the renderers ask for. The thinking
 * level is the resolved dispatch intent, not the child's effective tier (ADR
 * 0015); `undefined` displays as `default`.
 */
export function formatUsageLine(
  usage: UsageStats,
  opts: { model?: string; thinking?: string; requestedThinking?: string; showContext?: boolean } = {},
): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (opts.showContext && usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  }
  if (opts.model || opts.thinking !== undefined) {
    parts.push(formatModelSegment(opts.model, opts.thinking, opts.requestedThinking));
  }
  return parts.join(" ");
}

/** Human-readable token count (shared with the extension's renderer). */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

/**
 * Renders one run as a display row: icon + role (source) + status label +
 * started time + elapsed, then indented detail lines when present.
 */
function formatRunRow(run: RunEntry, now: number): string[] {
  const icon = RUN_STATUS_ICONS[run.status];
  // terminal runs show their actual duration (endedAt), not elapsed since the
  // snapshot was taken (D5: a terminated run must not keep counting).
  const header = `${icon} ${run.role} (${run.source}) [${run.status}] — started ${formatStartTime(
    run.startedAt,
  )}, ${formatElapsed(run.startedAt, run.endedAt ?? now)}`;
  const lines = [header];
  if (run.lastOutput) {
    // keep the progress line to one display line (spec: "最后输出行（截断）")
    const oneLine = run.lastOutput.split(/\s+/).join(" ").trim();
    lines.push(`  last: ${oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine}`);
  }
  if (run.usage) {
    const u = formatUsageLine(run.usage, {
      model: run.model,
      thinking: run.thinkingLevel,
      requestedThinking: run.requestedThinking,
    });
    if (u) lines.push(`  usage: ${u}`);
  } else if (run.channel === "background" && (run.model || run.thinkingLevel !== undefined)) {
    // Background runs carry no usage; still surface the dispatched model and
    // thinking level (with the clamp annotation) so the snapshot row stays
    // legible next to blocking rows (ADR 0018).
    lines.push(`  model: ${formatModelSegment(run.model, run.thinkingLevel, run.requestedThinking)}`);
  }
  if (run.findingsPath) lines.push(`  findings: ${run.findingsPath}`);
  if (run.logPath) lines.push(`  log: ${run.logPath}`);
  return lines;
}

/**
 * Renders the registry snapshot as display text: empty-state message, or
 * running runs first then finished runs, each group sorted by start time.
 */
export function formatRunSnapshot(runs: RunEntry[], now: number = Date.now()): string {
  if (runs.length === 0) return "No subagents running.";
  const byStart = (a: RunEntry, b: RunEntry) => a.startedAt - b.startedAt;
  const active = runs.filter((r) => isActiveRunStatus(r.status)).sort(byStart);
  const finished = runs.filter((r) => isTerminalRunStatus(r.status)).sort(byStart);
  const sections: string[] = [];
  if (active.length > 0) {
    sections.push("[running]", ...active.flatMap((r) => formatRunRow(r, now)));
  }
  if (finished.length > 0) {
    sections.push("[finished]", ...finished.flatMap((r) => formatRunRow(r, now)));
  }
  return sections.join("\n");
}

/**
 * Injectable file-system surface for readLogTail (tests substitute fakes).
 */
export interface LogTailFs {
  statSync: (p: string) => { size: number };
  openSync: (p: string, flag: string) => number;
  readSync: (fd: number, buf: Buffer, offset: number, length: number, position: number) => number;
  closeSync: (fd: number) => void;
}

const defaultLogTailFs: LogTailFs = {
  statSync: (p) => fs.statSync(p),
  openSync: (p, flag) => fs.openSync(p, flag),
  readSync: (fd, buf, offset, length, position) => fs.readSync(fd, buf, offset, length, position),
  closeSync: (fd) => fs.closeSync(fd),
};

/**
 * Reads the last `maxBytes` of a log file, dropping a partial leading line
 * (the tail is meant to be read as whole lines). Missing/empty files are
 * safe and return "". `fsImpl` is injectable for tests.
 */
export function readLogTail(logPath: string, maxBytes = 4096, fsImpl: LogTailFs = defaultLogTailFs): string {
  let fd: number | undefined;
  try {
    const size = fsImpl.statSync(logPath).size;
    if (size === 0) return "";
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    fd = fsImpl.openSync(logPath, "r");
    fsImpl.readSync(fd, buf, 0, len, start);
    let text = buf.toString("utf8");
    if (start > 0) {
      // We sliced into the middle of the file: drop the partial first line.
      const newline = text.indexOf("\n");
      if (newline >= 0) text = text.slice(newline + 1);
    }
    return text.replace(/\s+$/, "");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        fsImpl.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * The registry-status axis: where a blocking single-result lands in the run
 * registry. Abort stays a distinct status (aborted) — the error axis
 * (isToolError) separately decides whether it is a tool error for the throw
 * path.
 */
export function blockingRunStatus(result: {
  exitCode: number;
  stopReason?: string;
  aborted?: boolean;
}): RunStatus {
  if (result.aborted) return "aborted";
  if (result.stopReason === "aborted") return "aborted";
  if (result.exitCode !== 0 || result.stopReason === "error") return "failed";
  return "succeeded";
}

/**
 * The tool-error axis: whether a blocking result counts as a failure for the
 * throw path (single/chain) and for failure display. Abort is an error here
 * even though it is its own registry status (ADR 0016: blocking aborts
 * throw at the orchestrator; the tool boundary converts them into returned
 * error results).
 */
export function isToolError(result: { exitCode: number; stopReason?: string }): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

// ---------------------------------------------------------------------------
// Result output extraction
//   One structural message shape shared by the blocking protocol and the
//   research child session (the two pi message types are structurally
//   identical over the parts we read), so both channels agree on what "the
//   final output" is.
// ---------------------------------------------------------------------------

export interface AssistantMessageLike {
  role?: string;
  content?: unknown;
}

/** The text parts of one message (non-array content and non-text parts are tolerated). */
function textPartsOfMessage(msg: AssistantMessageLike): Array<{ type?: string; text?: string }> {
  return Array.isArray(msg.content)
    ? (msg.content as Array<{ type?: string; text?: string }>).filter((p) => p.type === "text" && typeof p.text === "string")
    : [];
}

/** All text parts of one assistant message, joined (the research tee input). */
export function assistantTextOfMessage(msg: AssistantMessageLike): string {
  if (msg.role !== "assistant") return "";
  return textPartsOfMessage(msg)
    .map((p) => p.text as string)
    .join("");
}

/** The first text part of the newest assistant message (the blocking result output). */
export function lastAssistantText(messages: readonly AssistantMessageLike[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const parts = textPartsOfMessage(msg);
    if (parts.length > 0) return parts[0].text as string;
  }
  return "";
}

/** The last non-empty trimmed line of a text block (a run's live progress line). */
export function lastOutputLine(text: string): string | undefined {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : undefined;
}

/** The text a consumer sees for one blocking result (error surfaces the failure detail). */
export function getResultOutput(result: {
  exitCode: number;
  stopReason?: string;
  errorMessage?: string;
  stderr: string;
  messages: readonly AssistantMessageLike[];
}): string {
  if (isToolError(result)) {
    return result.errorMessage || result.stderr || lastAssistantText(result.messages) || "(no output)";
  }
  return lastAssistantText(result.messages) || "(no output)";
}

/**
 * The tool-error message for a failed blocking run (single or chain step). The
 * orchestrator keeps throwing it (its tests pin that contract); the tool
 * boundary converts the throw into a returned error result whose content is
 * this message verbatim (ADR 0016). The text matches what the model would
 * otherwise receive in content.
 */
export function formatBlockingToolError(
  mode: "single" | "chain",
  opts: { agent?: string; step?: number; stopReason?: string; output: string },
): string {
  if (mode === "chain") return `Chain stopped at step ${opts.step} (${opts.agent}): ${opts.output}`;
  return `Agent ${opts.stopReason || "failed"}: ${opts.output}`;
}

/**
 * The model-visible text for a thrown value, shared by the tool-boundary
 * conversions (subagent blocking catch, research startup-failure catch): an
 * Error's message, a string as-is, and any other value JSON-stringified so an
 * object does not degrade to the useless `[object Object]`. JSON.stringify
 * can throw (circular/bigint) — fall back to String() then.
 */
export function toolErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    const json = JSON.stringify(err);
    return typeof json === "string" ? json : String(err);
  } catch {
    return String(err);
  }
}

// ---------------------------------------------------------------------------
// Tool-error details payload (ADR 0016)
//   Since pi 0.99.1 a tool may return an error result (`isError: true`) instead
//   of throwing. The `subagent` tool converts its orchestrator's throw at the
//   tool boundary and shapes the failed run's terminal info from the registry
//   (decided Q2=b): status, agent, source, usage, model, thinking level — the
//   display fields that make a failure legible in the transcript. The coverage
//   rule (3b) and the exceptions (parallel aggregate, input-JSON) are separate
//   concerns documented in ADR 0016.
// ---------------------------------------------------------------------------

/** The terminal-run info an error-marked subagent result carries (ADR 0016). */
export interface SubagentRunError {
  status: "failed" | "aborted";
  agent: string;
  agentSource: AgentSource;
  usage?: UsageStats;
  model?: string;
  thinkingLevel?: string;
  /** Requested level before clamping, when a level was requested. */
  requestedThinking?: string;
}

/**
 * Maps the failed run of one tool call onto an error payload. The caller
 * records the registry snapshot length before the call and passes the full
 * snapshot with that base index: only runs the call registered after the base
 * are its own (blocking plans register serially per step / pre-register
 * parallel tasks, so the delta isolates exactly this call's runs), and the
 * first one that ended failed/aborted is the failure the thrown error
 * reported. Returns undefined when the delta has no failed/aborted run — the
 * throw was then not a run failure (no payload to show). The error payload
 * carries a detached usage copy, so mutating it cannot leak into the registry.
 */
export function toolErrorDetails(snapshot: readonly RunEntry[], sinceIndex: number): SubagentRunError | undefined {
  const delta = snapshot.slice(sinceIndex);
  const failed = delta.find((r) => r.status === "failed" || r.status === "aborted");
  if (!failed) return undefined;
  return {
    status: failed.status === "aborted" ? "aborted" : "failed",
    agent: failed.role,
    agentSource: failed.source,
    usage: failed.usage ? { ...failed.usage } : undefined,
    model: failed.model,
    thinkingLevel: failed.thinkingLevel,
    ...(failed.requestedThinking !== undefined ? { requestedThinking: failed.requestedThinking } : {}),
  };
}

// ---------------------------------------------------------------------------
// Run management (D6)
//   Manual kill / prune / tail plumbing that lives in the pure layer so it is
//   testable under `node --test`; the extension wires it to the /subagents
//   command. Since ADR 0013 the research child is in-process: kill aborts the
//   child session via the extension-side AbortController (no OS signals), and
//   the run resolves `aborted` through the runner's onExit.
// ---------------------------------------------------------------------------

export type SubagentsCommand =
  | { action: "snapshot" }
  | { action: "kill"; id: string }
  | { action: "tail"; id: string }
  | { action: "prune" }
  | { action: "config"; verb: "show" }
  | { action: "config"; verb: "set"; key: ConfigKey; value: string }
  | { action: "config"; verb: "reset"; key?: ConfigKey }
  | { action: "invalid"; reason: string };

/** Parses the /subagents argument string into a command the handler can dispatch. */
export function parseSubagentsArgs(args: string): SubagentsCommand {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { action: "snapshot" };
  const [verb, ...rest] = parts;
  if (verb === "snapshot") {
    if (rest.length > 0) return { action: "invalid", reason: `unexpected extra arguments: ${rest.join(" ")}` };
    return { action: "snapshot" };
  }
  if (verb === "prune") {
    if (rest.length > 0) return { action: "invalid", reason: `unexpected extra arguments: ${rest.join(" ")}` };
    return { action: "prune" };
  }
  if (verb === "kill" || verb === "tail") {
    if (rest.length === 0) return { action: "invalid", reason: `${verb} requires a run id` };
    if (rest.length > 1) return { action: "invalid", reason: `unexpected extra arguments: ${rest.slice(1).join(" ")}` };
    return { action: verb, id: rest[0] };
  }
  if (verb === "config") {
    if (rest.length === 0 || (rest[0] === "show" && rest.length === 1)) return { action: "config", verb: "show" };
    if (rest[0] === "reset") {
      if (rest.length === 1) return { action: "config", verb: "reset" };
      if (rest.length === 2) {
        if (!(CONFIG_KEYS as readonly string[]).includes(rest[1])) {
          return { action: "invalid", reason: `unknown config key "${rest[1]}"` };
        }
        return { action: "config", verb: "reset", key: rest[1] as ConfigKey };
      }
      return { action: "invalid", reason: `unexpected extra arguments: ${rest.slice(2).join(" ")}` };
    }
    if (rest[0] === "set") {
      if (rest.length < 3) return { action: "invalid", reason: "config set requires a key and a value" };
      const key = rest[1] as ConfigKey;
      if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
        return { action: "invalid", reason: `unknown config key "${rest[1]}"` };
      }
      const value = rest.slice(2).join(" ");
      return { action: "config", verb: "set", key, value };
    }
    return { action: "invalid", reason: `unknown config verb "${rest[0]}"` };
  }
  return { action: "invalid", reason: `unknown action "${verb}"` };
}
