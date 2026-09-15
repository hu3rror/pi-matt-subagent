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
import { spawn, type SpawnOptions } from "node:child_process";

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
 * - A declared tool that is NOT in `availableTools` (the tool registry of the
 *   current environment, probed via `pi.getAllTools()` by the extension)
 *   falls back to its built-in alias when that alias IS available. Without
 *   `availableTools` the list passes through untouched (legacy behavior).
 */
export function resolveTools(
  tools: string[] | undefined,
  availableTools?: ReadonlySet<string>,
): string[] | undefined {
  if (!tools || tools.length === 0) return tools;
  return tools.map((t) => {
    if (process.platform === "win32" && t === "bash") return "powershell";
    if (availableTools && !availableTools.has(t)) {
      const alias = TOOL_ALIASES[t];
      if (alias && availableTools.has(alias)) return alias;
    }
    return t;
  });
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
  availableTools?: ReadonlySet<string>;
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
  availableTools?: ReadonlySet<string>;
  promptPath?: string;
  task: string;
}): string[] {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.thinking) args.push("--thinking", opts.thinking);
  const tools = resolveTools(opts.tools, opts.availableTools);
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
    availableTools: opts.availableTools,
    promptPath: opts.promptPath,
    task: opts.task,
  });
}

export interface ResearchHandle {
  researchId: string;
  findingsPath: string;
  logPath: string;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => { unref: () => void };

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
  const researchId = path.basename(tmpDir);

  // The role prompt (with findings path) goes to a file, like the blocking
  // path's --append-system-prompt, so prompt text never appears in argv.
  // The file stays in the tmp dir for as long as the background subprocess
  // needs to read it at startup (this dir already outlives the caller: the
  // main session is not meant to wait or clean up after a background run).
  const promptPath = path.join(tmpDir, "prompt.md");
  fs.writeFileSync(promptPath, buildResearchPrompt(agent, opts.task, opts.findingsPath), {
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
    availableTools: opts.availableTools,
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

export function buildResearchPrompt(agent: AgentConfig, task: string, findingsPath: string): string {
  return [agent.systemPrompt, "", `Findings path: ${findingsPath}`, "", `Task: ${task}`].join("\n");
}
