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
//   (ADR 0003/0008): a wall-clock cap, default 60 minutes, written into the
//   researcher's prompt as a single line. Findings are checkpointed before
//   each search round, so a kill or crash loses at most one round of work;
//   the runner enforces the cap by aborting the in-process child and
//   appending the slim `research-terminated` marker.
// ---------------------------------------------------------------------------

export const DEFAULT_RESEARCH_WALL_CLOCK_MS = 60 * 60 * 1000;

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
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const SubagentPublicFields = {
  agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
  task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
  agentScope: Type.Optional(AgentScopeSchema),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
};

const ResearchPublicFields = {
  task: Type.String({ description: "The research question to investigate" }),
  findingsPath: Type.String({
    description: "Absolute or repo-relative path where the researcher must write findings (Markdown).",
  }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the researcher process" })),
  tools: Type.Optional(Type.Array(Type.String({ description: "Tool names to enable" }))),
  agentScope: Type.Optional(AgentScopeSchema),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
};

const SUBAGENT_INPUT_DESCRIPTION =
  "JSON object string carrying advanced parameters the public schema hides. " +
  "Direct fields override same-name JSON keys. Carries: model (provider/id override for this run), " +
  "thinkingOverride (thinking level for this run).";

const RESEARCH_INPUT_DESCRIPTION =
  "JSON object string carrying advanced parameters the public schema hides. " +
  "Direct fields override same-name JSON keys. Carries: model (provider/id override for this run), " +
  "maxWallClockMs (hidden wall-clock cap in ms; may only tighten the 60-minute default).";

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
export const SUBAGENT_INPUT_KEYS = ["model", "thinkingOverride"] as const;

/** Hidden parameters `research` accepts through `input` (runtime-supported, schema-hidden). */
export const RESEARCH_INPUT_KEYS = ["model", "maxWallClockMs"] as const;

/**
 * The full `subagent` dispatch contract: the public fields plus the hidden
 * parameters. The merged params object is validated against this before
 * dispatch; it is never registered as the model-facing schema. Unlike the
 * public schema (which stays as it always was), unknown keys are rejected
 * here so a mistyped `input` fails loudly.
 */
export const SUBAGENT_FULL_PARAMS = Type.Object(
  {
    ...SubagentPublicFields,
    model: Type.Optional(Type.String({ description: "Model override for this run (provider/id)." })),
    thinkingOverride: Type.Optional(ThinkingLevelSchema),
  },
  { additionalProperties: false },
);

/** The full `research` dispatch contract (public fields + hidden `model` / `maxWallClockMs`). */
export const RESEARCH_FULL_PARAMS = Type.Object(
  {
    ...ResearchPublicFields,
    model: Type.Optional(Type.String({ description: "Model override for this run (provider/id)." })),
    maxWallClockMs: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: DEFAULT_RESEARCH_WALL_CLOCK_MS,
        description: "Hidden: wall-clock hard cap in ms; may only tighten the 60-minute default.",
      }),
    ),
  },
  { additionalProperties: false },
);

/** `subagent`'s registered description — part of the model-facing surface. */
export const SUBAGENT_TOOL_DESCRIPTION = [
  "Delegate tasks to specialized subagents with isolated context windows (each runs in a separate pi process).",
  "This is the BLOCKING subagent primitive: the call does not return until every subagent finishes, and the full results are returned in one result. Do NOT spawn subagents via bash and poll files.",
  "When a skill says 'spawn sub-agents in parallel', use the `tasks` array (parallel mode); for a sequential handoff use `chain` (with the {previous} placeholder); for one task use `agent` + `task`.",
  "Bundled roles: standards-reviewer, spec-reviewer, design-explorer, architecture-scout, researcher, fact-finder.",
  'Agent scope is "user" by default (user agents from ~/.pi/agent/agents plus the bundled roles); use "both" or "project" to add project agents from .pi/agents.',
].join(" ");

/** `research`'s registered description — part of the model-facing surface. */
export const RESEARCH_TOOL_DESCRIPTION = [
  "Run a background research subagent (an in-process second session) that writes cited findings to a file, then return immediately.",
  "Use when the research or wayfinder skill asks for a background agent: call this tool, keep working, and the completion (succeeded / failed / terminated / aborted) is pushed to you with the findings path — no polling, no \"read later\".",
  "This is NOT for code review or design exploration — those must block for their results, so use the `subagent` tool instead.",
  'Agent scope is "user" by default (user agents plus the bundled researcher role); use "both" or "project" so a project-local `researcher` from .pi/agents overrides the bundled role (untrusted projects get a confirmation first).',
  "Every run is bounded by a single wall-clock cap (default 60 minutes); findings are checkpointed before each search round, so a cap kill or crash loses at most one round of work.",
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
 * 0010 contract) when `input` is present but not a JSON object string, or
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

Name concepts using the brief's architecture vocabulary and the project's CONTEXT.md domain vocabulary.`,
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
    tools: ["read", "grep", "find", "ls", "bash", "write"],
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
 * Resolves role tool names for a subagent's `--tools` allowlist:
 * - `bash` maps to `powershell` on win32 (no powershell on other platforms).
 * - When `availableToolNames` (the tool registry of the current environment,
 *   probed via `pi.getAllTools()` by the extension) is given, a declared tool
 *   that is not in it falls back to its built-in alias when that alias IS
 *   available, and is DROPPED when neither the declared name nor its alias
 *   exists — passing an unknown name to the child's allowlist would silently
 *   leave the agent without the tool until the first call. Without the
 *   registry the list passes through untouched (legacy behavior).
 */
export function resolveTools(
  tools: string[] | undefined,
  availableToolNames?: ReadonlySet<string>,
): string[] | undefined {
  if (!tools || tools.length === 0) return tools;
  const resolved: string[] = [];
  for (const t of tools) {
    let name = t;
    if (process.platform === "win32" && t === "bash") name = "powershell";
    if (!availableToolNames) {
      resolved.push(name);
      continue;
    }
    if (availableToolNames.has(name)) {
      resolved.push(name);
      continue;
    }
    const alias = TOOL_ALIASES[t];
    if (alias && availableToolNames.has(alias)) {
      resolved.push(alias);
      continue;
    }
    // Neither the declared name nor its alias exists in this environment's
    // tool registry: drop it rather than hand the child an unknown --tools
    // entry.
  }
  return resolved;
}

export function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

// ---------------------------------------------------------------------------
// Background research
// ---------------------------------------------------------------------------

export const DEFAULT_RESEARCH_TOOLS = ["read", "grep", "find", "ls", "bash", "write"];

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

export interface ResearchHandle {
  researchId: string;
  findingsPath: string;
  logPath: string;
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
   * never ends (see `push` in CONTEXT.md).
   */
  done: Promise<void>;
  /** Aborts the in-process child (wall-clock kill and manual kill share this path). */
  abort(): void;
}

export type CreateChildSession = (opts: {
  cwd: string;
  model?: unknown;
  thinkingLevel?: string;
  tools?: string[];
  systemPrompt: string;
  task: string;
  findingsPath: string;
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
  const researchId = path.basename(tmpDir);

  const maxWallClockMs = opts.maxWallClockMs ?? DEFAULT_RESEARCH_WALL_CLOCK_MS;
  const systemPrompt = buildResearchPrompt(agent, opts.task, opts.findingsPath, maxWallClockMs);
  const tools = resolveTools(opts.tools ?? agent.tools ?? DEFAULT_RESEARCH_TOOLS, opts.availableToolNames)?.filter(
    (t) => !EXTENSION_TOOL_NAMES.has(t),
  );

  const child = createChildSession({
    cwd: opts.cwd,
    model: opts.model,
    thinkingLevel: opts.thinkingLevel,
    tools,
    systemPrompt,
    task: opts.task,
    findingsPath: opts.findingsPath,
  });

  // The runner owns the per-run log: every child output chunk is appended,
  // serving `/subagents tail` and post-mortem inspection (ADR 0013).
  const logFd = fs.openSync(logPath, "a");
  const closeLogFd = () => {
    try {
      fs.closeSync(logFd);
    } catch {
      /* already closed */
    }
  };
  const tee = (async () => {
    for await (const chunk of child.output) {
      fs.writeSync(logFd, chunk);
    }
  })();

  const deps = opts.watcherDeps ?? {};
  const nowFn = deps.now ?? Date.now;
  const setTimer = deps.setTimeout ?? ((fn: () => void, ms?: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimeout ?? ((id?: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));

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
          closeLogFd();
        })
        .catch(() => {});
    }
    let bound: unknown | undefined;
    return new Promise<void>((resolve) => {
      bound = setTimer(() => {
        // The stream is stuck: close the log fd so a stuck run does not leak
        // it for the rest of the session. Any chunk that lands after the
        // close fails harmlessly (the tee rejection is swallowed below).
        closeLogFd();
        resolve();
      }, TEE_DRAIN_BOUND_MS);
      (bound as { unref?: () => void } | undefined)?.unref?.();
      void tee
        .finally(() => {
          if (bound !== undefined) clearTimer(bound);
          closeLogFd();
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

  return { researchId, findingsPath: opts.findingsPath, logPath };
}

// ---------------------------------------------------------------------------
// Role resolution and research prompt
// ---------------------------------------------------------------------------

export function resolveRole(agents: AgentConfig[], name: string): AgentConfig | undefined {
  return agents.find((a) => a.name === name);
}

/**
 * Decides the thinking level for a subagent's pi invocation.
 * Priority: per-call override > the role's configured level > the main
 * session's inherited level. A per-call override wins even when the agent
 * pins its own model (explicit escape hatch); without an override, a
 * model-pinned agent gets undefined so the caller does not force --thinking
 * on a model that brings its own reasoning configuration (historical
 * behavior preserved).
 */
export function resolveThinkingLevel(opts: {
  roleLevel?: string;
  override?: string;
  inherited?: string;
  hasModel: boolean;
}): string | undefined {
  if (opts.override) return opts.override;
  if (opts.hasModel) return undefined;
  return opts.roleLevel ?? opts.inherited;
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
): string {
  return [
    agent.systemPrompt,
    "",
    `Findings path: ${findingsPath}`,
    "",
    `You have at most ${formatDuration(maxWallClockMs)} of wall-clock time before the run is cut off.`,
    "",
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
 */
export function createRunRegistry(now: () => number = Date.now): RunRegistry {
  const runs = new Map<string, RunEntry>();
  let nextId = 1;

  const register = (entry: Omit<RunEntry, "id" | "status"> & { status?: RunStatus }): string => {
    const id = `run-${nextId++}`;
    runs.set(id, { ...entry, id, status: entry.status ?? "queued" });
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
    },
    list: () => Array.from(runs.values()),
    snapshot,
    clear: () => runs.clear(),
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

/** Human-readable usage line for one blocking run. */
export function formatRunUsage(usage: UsageStats): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turns`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
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
    const u = formatRunUsage(run.usage);
    if (u) lines.push(`  usage: ${u}`);
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
 * Maps a blocking single-result to its run status. Mirrors isFailedResult
 * semantics (nonzero exit / error stop reason) plus the abort flag the
 * runner sets when the user cancels.
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
 * The tool-error message for a failed blocking run (single or chain step),
 * thrown so the harness marks the result as an error (it derives isError only
 * from throws; a returned field is dead code). The text matches what the model
 * would otherwise receive in content.
 */
export function formatBlockingToolError(
  mode: "single" | "chain",
  opts: { agent?: string; step?: number; stopReason?: string; output: string },
): string {
  if (mode === "chain") return `Chain stopped at step ${opts.step} (${opts.agent}): ${opts.output}`;
  return `Agent ${opts.stopReason || "failed"}: ${opts.output}`;
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
  return { action: "invalid", reason: `unknown action "${verb}"` };
}
