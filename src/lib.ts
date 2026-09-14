/**
 * Pure subagent logic: role definitions, agent discovery, tool resolution,
 * usage defaults, role resolution, and background-research prompt assembly.
 *
 * Zero pi-runtime imports so this module is testable with `node --test`.
 * `agentDir` and the frontmatter parser are injected so callers (the pi
 * extension) supply the runtime-specific values and tests supply stubs.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoleDef {
  description: string;
  tools?: string[];
  systemPrompt: string;
}

export type AgentSource = "embedded" | "user" | "project" | "unknown";
export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: AgentSource;
}

export type AgentFrontmatter = {
  name?: unknown;
  description?: unknown;
  tools?: unknown;
  model?: unknown;
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
    systemPrompt: `You are a researcher. Investigate a question against primary sources available locally (official docs, source code, specs, first-party APIs — repo files and installed docs). Follow every claim back to the source that owns it.

Write your findings to a single Markdown file at the findings path given in your task, citing each claim's source. The file is the deliverable; do not answer in chat.`,
  },

  "fact-finder": {
    description:
      "Answers a precise factual question using the environment (filesystem, tools), citing sources.",
    tools: ["read", "grep", "find", "ls", "bash"],
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
      systemPrompt: role.systemPrompt,
      source: "embedded",
    });
  }

  if (scope !== "project") {
    for (const a of loadAgentsFromDir(path.join(agentDir, "agents"), "user", parseFrontmatter)) map.set(a.name, a);
  }

  const projectAgentsDir = findNearestProjectAgentsDir(cwd, configDirName);
  if (scope === "project" || scope === "both") {
    if (projectAgentsDir) {
      for (const a of loadAgentsFromDir(projectAgentsDir, "project", parseFrontmatter)) map.set(a.name, a);
    }
  }

  return { agents: Array.from(map.values()), projectAgentsDir };
}

// ---------------------------------------------------------------------------
// Tool resolution and usage
// ---------------------------------------------------------------------------

export function resolveTools(tools: string[] | undefined): string[] | undefined {
  if (!tools || tools.length === 0) return tools;
  if (process.platform === "win32") {
    return tools.map((t) => (t === "bash" ? "powershell" : t));
  }
  return tools;
}

export function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

// ---------------------------------------------------------------------------
// Role resolution and research prompt
// ---------------------------------------------------------------------------

export function resolveRole(agents: AgentConfig[], name: string): AgentConfig | undefined {
  return agents.find((a) => a.name === name);
}

export function buildResearchPrompt(agent: AgentConfig, task: string, findingsPath: string): string {
  return [agent.systemPrompt, "", `Findings path: ${findingsPath}`, "", `Task: ${task}`].join("\n");
}
