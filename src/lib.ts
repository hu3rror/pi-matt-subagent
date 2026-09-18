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
import { spawn, spawnSync, type SpawnOptions } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoleDef {
  description: string;
  tools?: string[];
  thinkingLevel?: ThinkingLevel;
  budget?: ResearchBudgetTier;
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
// Research budget (D4, recalibrated in ADR 0008)
//   Effort control for the background researcher: 3 soft budget dimensions
//   (fetch pages, search rounds, findings lines) written into the prompt as
//   guidance, 2 hard control dimensions (log bytes, wall clock) enforced by
//   the runner. Tier table frozen in ADR 0003, revised by ADR 0008 (tight
//   10/6/400, standard log 10 MiB); overrides follow
//   overrides > tier > system default, and hard caps may only tighten.
// ---------------------------------------------------------------------------

export const RESEARCH_BUDGET_TIERS = ["standard", "tight"] as const;
export type ResearchBudgetTier = (typeof RESEARCH_BUDGET_TIERS)[number];

export function isResearchBudgetTier(value: unknown): value is ResearchBudgetTier {
  return typeof value === "string" && (RESEARCH_BUDGET_TIERS as readonly string[]).includes(value);
}

export interface ResearchBudget {
  maxSearchRounds: number;
  maxFetchPages: number;
  maxFindingLines: number;
  maxLogBytes: number;
  maxWallClockMs: number;
}

/** The two runner-enforced hard control dimensions. */
export const HARD_BUDGET_DIMS = ["maxLogBytes", "maxWallClockMs"] as const;
export type HardBudgetDim = (typeof HARD_BUDGET_DIMS)[number];

export interface ResearchBudgetOverrides {
  maxSearchRounds?: number;
  maxFetchPages?: number;
  maxFindingLines?: number;
  maxLogBytes?: number;
  maxWallClockMs?: number;
}

/** The five budget keys, single source for unknown-key rejection. */
export const RESEARCH_BUDGET_KEYS = [
  "maxSearchRounds",
  "maxFetchPages",
  "maxFindingLines",
  "maxLogBytes",
  "maxWallClockMs",
] as const;

export const RESEARCH_BUDGETS: Record<ResearchBudgetTier, ResearchBudget> = {
  standard: {
    maxSearchRounds: 10,
    maxFetchPages: 20,
    maxFindingLines: 500,
    maxLogBytes: 10 * 1024 * 1024,
    maxWallClockMs: 15 * 60 * 1000,
  },
  tight: {
    maxSearchRounds: 5,
    maxFetchPages: 8,
    maxFindingLines: 400,
    maxLogBytes: 6 * 1024 * 1024,
    maxWallClockMs: 10 * 60 * 1000,
  },
};

/**
 * Resolves the effective budget for a research run: per-call overrides win
 * over the tier defaults, which win over the system default. Hard-dimension
 * overrides may only tighten (never exceed the tier ceiling); invalid values
 * throw instead of being silently clamped.
 */
export function resolveResearchBudget(tier: ResearchBudgetTier, overrides?: ResearchBudgetOverrides): ResearchBudget {
  const base = RESEARCH_BUDGETS[tier];
  if (!base) throw new Error(`Unknown research budget tier: ${String(tier)}`);
  if (!overrides) return base;
  const result: ResearchBudget = { ...base };
  for (const key of Object.keys(overrides)) {
    const value = (overrides as Record<string, number | undefined>)[key];
    if (value === undefined) continue;
    if (!RESEARCH_BUDGET_KEYS.includes(key as (typeof RESEARCH_BUDGET_KEYS)[number])) {
      throw new Error(`Unknown budget override key: ${key}`);
    }
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`Invalid budget override ${key}: ${value} (must be a positive integer)`);
    }
    if ((HARD_BUDGET_DIMS as readonly string[]).includes(key) && value > base[key as HardBudgetDim]) {
      throw new Error(
        `Budget override ${key}: ${value} exceeds the ${tier} ceiling ${base[key as HardBudgetDim]}; hard caps may only be tightened`,
      );
    }
    result[key as keyof ResearchBudget] = value as number;
  }
  return result;
}

/**
 * Resolves the effective budget for a research run, guaranteeing a budget is
 * always present (per ADR 0003 / spec: every run carries one). Precedence:
 * per-call tier > the role's frontmatter tier > the system default (standard).
 */
export function resolveEffectiveResearchBudget(opts: {
  tier?: ResearchBudgetTier;
  roleTier?: ResearchBudgetTier;
  overrides?: ResearchBudgetOverrides;
}): ResearchBudget {
  const tier: ResearchBudgetTier = opts.tier ?? opts.roleTier ?? "standard";
  return resolveResearchBudget(tier, opts.overrides);
}

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  thinkingLevel?: string;
  budget?: ResearchBudgetTier;
  systemPrompt: string;
  source: AgentSource;
}

export type AgentFrontmatter = {
  name?: unknown;
  description?: unknown;
  tools?: unknown;
  model?: unknown;
  thinkingLevel?: unknown;
  budget?: unknown;
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
    budget: "standard",
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
      budget: isResearchBudgetTier(frontmatter.budget) ? frontmatter.budget : undefined,
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
      budget: role.budget,
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

export interface ResearchRunOptions {
  task: string;
  findingsPath: string;
  model?: string;
  thinkingLevel?: string;
  tools?: string[];
  availableToolNames?: ReadonlySet<string>;
  /** Resolved research budget: enables the prompt budget block and the runner watcher. */
  budget?: ResearchBudget;
  /** Injectable timer/stat/append deps for the watcher (tests). */
  watcherDeps?: ResearchWatcherDeps;
  /** Grace period after the 100% final notice before a kill (tests shorten it). */
  graceMs?: number;
  /** Fired (best-effort) when the background child exits or is killed. */
  onExit?: (info: ResearchExitInfo) => void;
}

/** The research child's exit, as observed by the runner's watcher. */
export interface ResearchExitInfo {
  /** True when the run was killed by a hard cap (vs. a natural exit). */
  killed: boolean;
  /** Exit code on natural exit; null on a kill. */
  exitCode: number | null;
}

/**
 * Assembles a pi invocation for a subagent process, shared by the blocking
 * runner and the background researcher: fixed flags first, then optional
 * --model / --thinking / --tools, then the role prompt via
 * --append-system-prompt (file path, keeping prompt text out of argv), then
 * the task positionally.
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
 * Assembles the pi invocation args for a background researcher: fixed flags
 * first, then optional --model / --thinking / --tools, then the role prompt
 * via --append-system-prompt (file path, keeping prompt text out of argv,
 * consistent with the blocking path), then the task positionally.
 */
export function buildResearchArgs(
  opts: ResearchRunOptions & { agent: AgentConfig; promptPath: string },
): string[] {
  return buildDispatchArgs({
    model: opts.model,
    thinking: opts.thinkingLevel,
    tools: opts.tools ?? opts.agent.tools ?? DEFAULT_RESEARCH_TOOLS,
    availableToolNames: opts.availableToolNames,
    promptPath: opts.promptPath,
    task: opts.task,
  });
}

export interface ResearchHandle {
  researchId: string;
  findingsPath: string;
  logPath: string;
  /** The spawned child's pid, present on a real spawn (D6: kill target). */
  pid?: number;
}

/**
 * The minimal handle the runner needs on a spawned research child: detach it,
 * kill it, and observe whether it has exited. node's ChildProcess satisfies
 * all three; fakes in tests implement them trivially.
 */
export interface ResearchChild {
  unref(): void;
  kill(signal?: string): boolean;
  /** null while the child is still running; set once it has exited. */
  exitCode: number | null;
  /** The spawned child's pid (D6: kill target); fakes may omit it. */
  pid?: number;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ResearchChild;

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
 * Spawns a background researcher that writes findings to `findingsPath`, and
 * returns immediately with a handle. The caller does not wait for the
 * subprocess (background semantics per ADR 0001): the result is found later
 * by reading the findings file; the child process is unref'd so it keeps
 * running after the main session exits.
 * `spawnImpl` is injectable for tests.
 */
export function runBackgroundResearch(
  opts: ResearchRunOptions & { cwd: string; agents: AgentConfig[] },
  spawnImpl: SpawnFn = spawn as SpawnFn,
): ResearchHandle {
  const agent = resolveRole(opts.agents, "researcher");
  if (!agent) throw new Error('No "researcher" role available');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-research-"));
  const logPath = path.join(tmpDir, "research.log");
  const statusPath = researchStatusPath(logPath);
  const researchId = path.basename(tmpDir);

  // The role prompt (with findings path) goes to a file, like the blocking
  // path's --append-system-prompt, so prompt text never appears in argv.
  // The file stays in the tmp dir for as long as the background subprocess
  // needs to read it at startup (this dir already outlives the caller: the
  // main session is not meant to wait or clean up after a background run).
  const promptPath = path.join(tmpDir, "prompt.md");
  fs.writeFileSync(promptPath, buildResearchPrompt(agent, opts.task, opts.findingsPath, opts.budget, statusPath), {
    encoding: "utf-8",
    mode: 0o600,
  });

  const args = buildResearchArgs({
    agent,
    task: opts.task,
    findingsPath: opts.findingsPath,
    model: opts.model,
    thinkingLevel: opts.thinkingLevel,
    tools: opts.tools,
    availableToolNames: opts.availableToolNames,
    promptPath,
  });
  const invocation = getPiInvocation(args);
  const logFd = fs.openSync(logPath, "a");
  const proc = spawnImpl(invocation.command, invocation.args, {
    cwd: opts.cwd,
    shell: false,
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });
  proc.unref();
  fs.closeSync(logFd);

  if (opts.budget) {
    const nowFn = opts.watcherDeps?.now ?? Date.now;
    startResearchWatcher({
      child: proc,
      logPath,
      findingsPath: opts.findingsPath,
      budget: opts.budget,
      startedAt: nowFn(),
      graceMs: opts.graceMs,
      deps: opts.watcherDeps,
      onExit: opts.onExit,
    });
  }

  return { researchId, findingsPath: opts.findingsPath, logPath, pid: proc.pid };
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
 * The budget paragraph appended to a researcher prompt when a budget applies.
 * Must guide the model on the three soft dimensions (fetch pages, search
 * rounds, findings lines) and the wall-clock number it can self-manage, state
 * the enough-to-answer rule, and describe wind-down + the soft-limit marker.
 * With a statusPath (ADR 0008) it also asks for checkpoint writes and teaches
 * the model to read the budget-status file and wind down on a final notice.
 */
export function buildResearchBudgetBlock(budget: ResearchBudget, statusPath?: string): string {
  const lines = [
    "## Research budget",
    "Stay within these limits unless answering requires it:",
    `- search rounds: at most ${budget.maxSearchRounds}`,
    `- fetch pages (total): at most ${budget.maxFetchPages}`,
    `- findings: at most ${budget.maxFindingLines} lines`,
    `- wall clock: at most ${formatDuration(budget.maxWallClockMs)}`,
    "",
    "Stop as soon as you have enough information to answer well — do not chase source code or implementation details beyond that. That is the enough-to-answer rule.",
    "",
    "Before each new search round, rewrite the findings file with everything gathered so far (a checkpoint), so a hard kill loses at most one round of work.",
    "",
    "If a soft limit gets exceeded, do NOT keep going: enter wind-down — freeze that dimension (no further fetches/search rounds; stop appending findings once the line count is reached), finish your summary, and add `soft_limit_exceeded` next to it.",
  ];
  if (statusPath) {
    lines.push(
      "",
      `Budget status file: ${statusPath}. Read it before starting a new search round and before writing findings. If it contains "STATUS: FINAL", wind down immediately: stop new fetches/searches, first write a complete checkpoint of the findings file with your summary, ending with "<!-- wind-down-complete -->", then finish and end.`,
    );
  }
  return lines.join("\n");
}

export function buildResearchPrompt(
  agent: AgentConfig,
  task: string,
  findingsPath: string,
  budget?: ResearchBudget,
  statusPath?: string,
): string {
  return [
    agent.systemPrompt,
    "",
    `Findings path: ${findingsPath}`,
    budget ? ["", buildResearchBudgetBlock(budget, statusPath)].join("\n") : "",
    "",
    `Task: ${task}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Research budget enforcement (D4)
//   The hard-cap decision (100% warn / 110% kill) and the termination marker
//   are pure; the runner watcher in runBackgroundResearch drives them.
// ---------------------------------------------------------------------------

export type ResearchHardCap = "log_bytes" | "wall_clock";

export interface ResearchRunCheck {
  action: "continue" | "final_notice" | "kill";
  /** The caps that crossed the relevant line: >=110% for a backstop kill, >=100% for a final notice / grace-deadline kill. */
  caps: ResearchHardCap[];
}

/**
 * Decides what the runner should do for a research run at this instant
 * (ADR 0008). 100% of a hard cap -> final notice (the watcher starts the
 * grace period); once a grace deadline is set, now >= deadline -> kill. The
 * log 110% line remains an immediate runaway backstop that beats the grace
 * period; wall clock has no 110% line — the grace deadline governs it. A
 * kill records the caps that caused it: the backstop caps for a backstop
 * kill, the dims currently over 100% for a grace-deadline kill.
 */
export function evaluateResearchRun(
  now: number,
  startedAt: number,
  logBytes: number,
  budget: ResearchBudget,
  graceDeadline?: number,
): ResearchRunCheck {
  const elapsed = now - startedAt;
  const over100: ResearchHardCap[] = [];
  if (logBytes / budget.maxLogBytes >= 1.0) over100.push("log_bytes");
  if (elapsed / budget.maxWallClockMs >= 1.0) over100.push("wall_clock");
  if (logBytes / budget.maxLogBytes >= 1.1) return { action: "kill", caps: ["log_bytes"] };
  if (graceDeadline !== undefined) {
    if (now >= graceDeadline) return { action: "kill", caps: over100 };
    return { action: "continue", caps: [] };
  }
  if (over100.length > 0) return { action: "final_notice", caps: over100 };
  return { action: "continue", caps: [] };
}

/** Human-readable byte size: "512 B", "1 KiB", "8.83 MiB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${trimNumber(bytes / 1024)} KiB`;
  return `${trimNumber(bytes / (1024 * 1024))} MiB`;
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

export interface TerminationMarkerEntry {
  cap: ResearchHardCap;
  limit: number;
  observed: number;
}

export interface TerminationMarkerData {
  entries: TerminationMarkerEntry[];
  at: string;
}

const REASON_LABELS: Record<ResearchHardCap, string> = {
  log_bytes: "log_bytes_exceeded",
  wall_clock: "wall_clock_exceeded",
};

/** Formats one hard-cap value in its own unit (bytes vs duration). */
export function formatCapValue(cap: ResearchHardCap, value: number): string {
  return cap === "log_bytes" ? formatBytes(value) : formatDuration(value);
}

/** A cap's live usage in human form: "2 KiB (cap 1 KiB)" / "3 s (cap 1 s)". */
function capUsage(cap: ResearchHardCap, logBytes: number, elapsed: number, budget: ResearchBudget): string {
  return cap === "log_bytes"
    ? `${formatBytes(logBytes)} (cap ${formatBytes(budget.maxLogBytes)})`
    : `${formatDuration(elapsed)} (cap ${formatDuration(budget.maxWallClockMs)})`;
}

/**
 * Appends the frozen termination marker to the findings file (creating it if
 * absent), so the main session can tell a hard-capped run from a complete one.
 */
export function appendResearchTerminationMarker(findingsPath: string, data: TerminationMarkerData): void {
  const reasons = data.entries.map((e) => REASON_LABELS[e.cap]);
  const lines = [
    `<!-- ${RESEARCH_TERMINATED_MARKER}`,
    `reason: ${reasons.join(", ")}`,
    "partial: true",
    `limit: ${data.entries.map((e) => formatCapValue(e.cap, e.limit)).join(", ")}`,
    `observed: ${data.entries.map((e) => formatCapValue(e.cap, e.observed)).join(", ")}`,
    `at: ${data.at}`,
    "-->",
  ];
  fs.appendFileSync(findingsPath, `\n${lines.join("\n")}\n`, "utf-8");
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
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["succeeded", "failed", "aborted", "terminated"];

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
  /** The spawned child's pid (background runs only; the /subagents kill target). */
  pid?: number;
}

export type RunPatch = Partial<Omit<RunEntry, "id" | "status">> & { status?: RunStatus };

export interface RunRegistry {
  register(entry: Omit<RunEntry, "id">): string;
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

  const register = (entry: Omit<RunEntry, "id">): string => {
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
 * Maps a background research child's exit info to its run status: a hard-cap
 * kill with the termination marker on disk is `terminated`; a kill without
 * the marker, or any nonzero natural exit, is `failed`; a clean exit is
 * `succeeded`.
 */
export function resolveResearchRunStatus(info: {
  killed: boolean;
  exitCode: number | null;
  findingsText?: string;
  /** D6: a manual kill (abortIntent) is the authoritative "who killed it" — beats every exit signal. */
  aborted?: boolean;
}): RunStatus {
  if (info.aborted) return "aborted";
  if (info.killed) {
    return info.findingsText?.includes(RESEARCH_TERMINATED_MARKER) ? "terminated" : "failed";
  }
  return info.exitCode === 0 ? "succeeded" : "failed";
}

// ---------------------------------------------------------------------------
// Run management (D6)
//   Manual kill / prune / tail plumbing that lives in the pure layer so it is
//   testable under `node --test`; the extension wires it to the /subagents
//   command. Kill semantics are frozen by ADR 0009: a manual kill resolves to
//   aborted (never terminated — that stays marker-based), kills the whole
//   process tree hard (platform split), and treats an already-gone process as
//   success.
// ---------------------------------------------------------------------------

export interface KillProcessGroupDeps {
  /** Test override; defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Test override; defaults to process.kill. */
  kill?: (pid: number, signal: string) => boolean;
  /** Test override; defaults to a real taskkill invocation (win32 only). */
  spawnSync?: (command: string, args: string[]) => { status: number | null; error?: Error } | undefined;
}

/**
 * Hard-kill of the research process tree (ADR 0009): the child is detached,
 * so POSIX signals the group via -pid and Windows reaps via taskkill /T /F;
 * an already-gone process (ESRCH / nonzero taskkill status) is success.
 */
export function killProcessGroup(pid: number, deps: KillProcessGroupDeps = {}): void {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    const run = deps.spawnSync ?? ((cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: "ignore" }));
    const result = run("taskkill", ["/pid", String(pid), "/T", "/F"]);
    // Nonzero taskkill status means "already gone" (success); a failed invocation is the only real error.
    if (result?.error) throw result.error;
    return;
  }
  const kill = deps.kill ?? process.kill;
  try {
    kill(-pid, "SIGKILL");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}

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

/** Keeps intents for still-active runs — prune-time consistency cleanup for never-settled kills (ADR 0009). */
export function cleanupAbortIntents(intents: ReadonlySet<string>, runs: readonly RunEntry[]): Set<string> {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const kept = new Set<string>();
  for (const id of intents) {
    const run = byId.get(id);
    if (run && isActiveRunStatus(run.status)) kept.add(id);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Hard-cap watcher
// ---------------------------------------------------------------------------

export interface ResearchWatcherDeps {
  now?: () => number;
  stat?: (filePath: string) => { size: number } | undefined;
  setInterval?: (fn: () => void, ms?: number) => unknown;
  clearInterval?: (id?: unknown) => void;
}

export interface StartResearchWatcherOptions {
  child: ResearchChild;
  logPath: string;
  findingsPath: string;
  budget: ResearchBudget;
  startedAt: number;
  /** Grace period after the 100% final notice before a kill; tests shorten it. */
  graceMs?: number;
  deps?: ResearchWatcherDeps;
  onExit?: (info: ResearchExitInfo) => void;
}

const RESEARCH_WATCH_INTERVAL_MS = 2000;

/** Default grace period after the 100% final notice before a hard-cap kill (ADR 0008). */
export const DEFAULT_RESEARCH_GRACE_MS = 60_000;

/** The budget-status file lives next to the research log in the run's tmp dir. */
export function researchStatusPath(logPath: string): string {
  return path.join(path.dirname(logPath), "budget-status.txt");
}

/**
 * Watches a background research run against its hard caps. Every tick it stats
 * the log file and checks the wall clock (ADR 0008): at 100% of a cap it
 * writes a one-time final notice to the log and the budget-status file, then
 * grants a grace period (default 60s) during which a natural exit is a
 * success; at the grace deadline it kills the child and appends the
 * termination marker to the findings file. The log 110% line remains an
 * immediate runaway backstop. The interval is unref'd so it never holds the
 * host process alive; enforcement is best-effort while the host lives.
 */
export function startResearchWatcher(opts: StartResearchWatcherOptions): void {
  const deps = opts.deps ?? {};
  const now = deps.now ?? Date.now;
  const stat =
    deps.stat ??
    ((p: string) => {
      try {
        return { size: fs.statSync(p).size };
      } catch {
        return undefined;
      }
    });
  const setIntervalFn = deps.setInterval ?? ((fn: () => void, ms?: number) => setInterval(fn, ms));
  const clearIntervalFn = deps.clearInterval ?? ((id?: unknown) => clearInterval(id as ReturnType<typeof setInterval>));
  const append = fs.appendFileSync;
  const graceMs = opts.graceMs ?? DEFAULT_RESEARCH_GRACE_MS;
  const statusPath = researchStatusPath(opts.logPath);
  let intervalId: unknown;
  let stopped = false;
  let graceDeadline: number | undefined;

  const stop = () => {
    stopped = true;
    if (intervalId !== undefined) clearIntervalFn(intervalId);
  };

  const writeStatus = (t: number, elapsed: number, logSize: number) => {
    const state =
      graceDeadline !== undefined
        ? `STATUS: FINAL — wind down now · deadline in ${formatDuration(graceDeadline - t)}`
        : `STATUS: running`;
    const line = `${state} · elapsed ${formatDuration(elapsed)}/${formatDuration(
      opts.budget.maxWallClockMs,
    )} · log ${formatBytes(logSize)}/${formatBytes(opts.budget.maxLogBytes)}`;
    fs.writeFileSync(statusPath, `${line}\n`, "utf-8");
  };

  const check = () => {
    if (stopped) return;
    if (opts.child.exitCode !== null) {
      opts.onExit?.({ exitCode: opts.child.exitCode, killed: false });
      stop();
      return;
    }
    const t = now();
    const elapsed = t - opts.startedAt;
    const logSize = stat(opts.logPath)?.size ?? 0;
    const result = evaluateResearchRun(t, opts.startedAt, logSize, opts.budget, graceDeadline);

    if (result.action === "kill") {
      opts.child.kill("SIGKILL");
      appendResearchTerminationMarker(opts.findingsPath, {
        entries: result.caps.map((cap) => ({
          cap,
          limit: cap === "log_bytes" ? opts.budget.maxLogBytes : opts.budget.maxWallClockMs,
          observed: cap === "log_bytes" ? logSize : elapsed,
        })),
        at: new Date(t).toISOString(),
      });
      // human-readable kill reason at the log tail (ADR 0003 / 0008): the log
      // 110% line is a runaway backstop, anything else is a grace-deadline kill
      const backstop = logSize / opts.budget.maxLogBytes >= 1.1;
      const reasons = result.caps
        .map((cap) =>
          cap === "log_bytes"
            ? `log exceeded ${capUsage(cap, logSize, elapsed, opts.budget)}${backstop ? " at 110%" : " at grace deadline"}`
            : `wall clock exceeded ${capUsage(cap, logSize, elapsed, opts.budget)} at grace deadline`,
        )
        .join("; ");
      append(opts.logPath, `\n[research-budget] killed: ${reasons}\n`);
      // Tell the caller (the run registry) the child is gone. Runs after the
      // termination marker so a killed-vs-failed decision can read it.
      opts.onExit?.({ exitCode: null, killed: true });
      stop();
      return;
    }

    // A final notice can fire at most once: setting graceDeadline makes
    // evaluateResearchRun return only continue/kill on later ticks.
    if (result.action === "final_notice") {
      graceDeadline = t + graceMs;
      const dims = result.caps
        .map((cap) => `${cap === "log_bytes" ? "log" : "wall clock"} ${capUsage(cap, logSize, elapsed, opts.budget)}`)
        .join(", ");
      append(
        opts.logPath,
        `\n[research-budget] final notice: ${dims} at 100%; wind down; killed in ${formatDuration(
          graceDeadline - t,
        )}\n`,
      );
    }

    writeStatus(t, elapsed, logSize);
  };

  check();
  if (!stopped) {
    intervalId = setIntervalFn(check, RESEARCH_WATCH_INTERVAL_MS);
    const asTimeout = intervalId as { unref?: () => void } | undefined;
    asTimeout?.unref?.();
  }
}
