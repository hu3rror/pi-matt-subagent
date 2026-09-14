/**
 * pi-matt-subagent — blocking + background subagents for skills that require
 * subagents (code-review, codebase-design/design-it-twice,
 * improve-codebase-architecture, research, wayfinder, grilling).
 *
 * Two tools:
 *   - `subagent` (blocking): single / parallel / chain. Does not return until
 *     every subagent finishes; full results come back in one tool result. This
 *     is the primitive a skill means when it says "spawn sub-agents".
 *   - `research` (background): spawns a detached researcher that writes
 *     findings to a file, then returns immediately with a handle.
 *
 * Six bundled roles: standards-reviewer, spec-reviewer, design-explorer,
 * architecture-scout, researcher, fact-finder. User agents from
 * ~/.pi/agent/agents/*.md and project agents from .pi/agents/*.md override
 * bundled roles by name.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  getAgentDir,
  parseFrontmatter,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

// ---------------------------------------------------------------------------
// Embedded roles
// ---------------------------------------------------------------------------

interface RoleDef {
  description: string;
  tools?: string[];
  systemPrompt: string;
}

const EMBEDDED_ROLES: Record<string, RoleDef> = {
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
// Agent discovery (embedded + file overrides)
// ---------------------------------------------------------------------------

type AgentSource = "embedded" | "user" | "project" | "unknown";
type AgentScope = "user" | "project" | "both";

interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: AgentSource;
}

type AgentFrontmatter = {
  name?: unknown;
  description?: unknown;
  tools?: unknown;
  model?: unknown;
};

function parseToolList(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const tools = raw
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
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

    const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);
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

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
    if (isDirectory(candidate)) return candidate;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

function discoverAgents(cwd: string, scope: AgentScope): { agents: AgentConfig[]; projectAgentsDir: string | null } {
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
    for (const a of loadAgentsFromDir(path.join(getAgentDir(), "agents"), "user")) map.set(a.name, a);
  }

  const projectAgentsDir = findNearestProjectAgentsDir(cwd);
  if (scope === "project" || scope === "both") {
    if (projectAgentsDir) {
      for (const a of loadAgentsFromDir(projectAgentsDir, "project")) map.set(a.name, a);
    }
  }

  return { agents: Array.from(map.values()), projectAgentsDir };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens?: number;
    turns?: number;
  },
  model?: string,
): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

function isFailedResult(result: SingleResult): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
  if (isFailedResult(result)) {
    return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
  }
  return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
  const byteLength = Buffer.byteLength(output, "utf8");
  if (byteLength <= PER_TASK_OUTPUT_CAP) return output;
  let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
  while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) truncated = truncated.slice(0, -1);
  return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  });
  return { dir: tmpDir, filePath };
}

function resolveTools(tools: string[] | undefined): string[] | undefined {
  if (!tools || tools.length === 0) return tools;
  if (process.platform === "win32") {
    return tools.map((t) => (t === "bash" ? "powershell" : t));
  }
  return tools;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
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

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

interface SingleResult {
  agent: string;
  agentSource: AgentSource;
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  results: SingleResult[];
}

type OnUpdate = (partial: AgentToolResult<SubagentDetails>) => void;

interface DispatchDefaults {
  model?: string;
  thinkingLevel?: string;
}

// ---------------------------------------------------------------------------
// Blocking runner
// ---------------------------------------------------------------------------

async function runSingleAgent(
  defaultCwd: string,
  dispatchDefaults: DispatchDefaults,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdate | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
  const agent = agents.find((a) => a.name === agentName);

  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      step,
    };
  }

  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  const model = agent.model ?? dispatchDefaults.model;
  if (model) args.push("--model", model);
  if (!agent.model && dispatchDefaults.thinkingLevel) args.push("--thinking", dispatchDefaults.thinkingLevel);
  const resolvedTools = resolveTools(agent.tools);
  if (resolvedTools && resolvedTools.length > 0) args.push("--tools", resolvedTools.join(","));

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  const currentResult: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model,
    step,
  };

  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
        details: makeDetails([currentResult]),
      });
    }
  };

  try {
    if (agent.systemPrompt.trim()) {
      const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
      args.push("--append-system-prompt", tmpPromptPath);
    }

    args.push(`Task: ${task}`);
    let wasAborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd: cwd ?? defaultCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (event.type === "message_end" && event.message) {
          const msg = event.message as Message;
          currentResult.messages.push(msg);
          if (msg.role === "assistant") {
            currentResult.usage.turns++;
            const usage = msg.usage;
            if (usage) {
              currentResult.usage.input += usage.input || 0;
              currentResult.usage.output += usage.output || 0;
              currentResult.usage.cacheRead += usage.cacheRead || 0;
              currentResult.usage.cacheWrite += usage.cacheWrite || 0;
              currentResult.usage.cost += usage.cost?.total || 0;
              currentResult.usage.contextTokens = usage.totalTokens || 0;
            }
            if (!currentResult.model && msg.model) currentResult.model = msg.model;
            if (msg.stopReason) currentResult.stopReason = msg.stopReason;
            if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
          }
          emitUpdate();
        }

        if (event.type === "tool_result_end" && event.message) {
          currentResult.messages.push(event.message as Message);
          emitUpdate();
        }
      };

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data) => {
        currentResult.stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });

      proc.on("error", () => {
        resolve(1);
      });

      if (signal) {
        const killProc = () => {
          wasAborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });

    currentResult.exitCode = exitCode;
    if (wasAborted) throw new Error("Subagent was aborted");
    return currentResult;
  } finally {
    if (tmpPromptPath) {
      try {
        fs.unlinkSync(tmpPromptPath);
      } catch {
        /* ignore */
      }
    }
    if (tmpPromptDir) {
      try {
        fs.rmdirSync(tmpPromptDir);
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Background research runner
// ---------------------------------------------------------------------------

interface ResearchHandle {
  researchId: string;
  findingsPath: string;
  logPath: string;
}

function runBackgroundResearch(opts: {
  cwd: string;
  model?: string;
  thinkingLevel?: string;
  tools?: string[];
  task: string;
  findingsPath: string;
}): ResearchHandle {
  const role = EMBEDDED_ROLES.researcher;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-research-"));
  const logPath = path.join(tmpDir, "research.log");
  const researchId = path.basename(tmpDir);

  const prompt = [role.systemPrompt, "", `Findings path: ${opts.findingsPath}`, "", `Task: ${opts.task}`].join("\n");

  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.thinkingLevel) args.push("--thinking", opts.thinkingLevel);
  const tools = resolveTools(opts.tools ?? role.tools ?? ["read", "grep", "find", "ls", "bash", "write"]);
  if (tools && tools.length > 0) args.push("--tools", tools.join(","));
  args.push(prompt);

  const invocation = getPiInvocation(args);
  const logFd = fs.openSync(logPath, "a");
  const proc = spawn(invocation.command, invocation.args, {
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
// Tool schemas
// ---------------------------------------------------------------------------

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

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
  task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
  agentScope: Type.Optional(
    Type.String({ description: 'Which agent directories to use: "user" (default), "project", or "both".' }),
  ),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

const ResearchParams = Type.Object({
  task: Type.String({ description: "The research question to investigate" }),
  findingsPath: Type.String({
    description: "Absolute or repo-relative path where the researcher must write findings (Markdown).",
  }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the researcher process" })),
  tools: Type.Optional(Type.Array(Type.String({ description: "Tool names to enable" }))),
});

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate tasks to specialized subagents with isolated context windows (each runs in a separate pi process).",
      "This is the BLOCKING subagent primitive: the call does not return until every subagent finishes, and the full results are returned in one result. Do NOT spawn subagents via bash and poll files.",
      "When a skill says 'spawn sub-agents in parallel', use the `tasks` array (parallel mode); for a sequential handoff use `chain` (with the {previous} placeholder); for one task use `agent` + `task`.",
      "Bundled roles: standards-reviewer, spec-reviewer, design-explorer, architecture-scout, researcher, fact-finder.",
      'Agent scope is "user" by default (user agents from ~/.pi/agent/agents plus the bundled roles); use "both" or "project" to add project agents from .pi/agents.',
    ].join(" "),
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const agentScope: AgentScope = (params.agentScope as AgentScope) ?? "user";
      const dispatchDefaults: DispatchDefaults = {
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        thinkingLevel: ctx.thinkingLevel,
      };
      const discovery = discoverAgents(ctx.cwd, agentScope);
      const agents = discovery.agents;

      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

      const makeDetails =
        (mode: "single" | "parallel" | "chain") =>
        (results: SingleResult[]): SubagentDetails => ({ mode, results });

      if (modeCount !== 1) {
        const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
        return {
          content: [
            { type: "text", text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}` },
          ],
          details: makeDetails("single")([]),
        };
      }

      if (
        (agentScope === "project" || agentScope === "both") &&
        ctx.hasUI &&
        !ctx.isProjectTrusted() &&
        (params.chain || params.tasks || params.agent)
      ) {
        const requestedNames = new Set<string>();
        if (params.chain) for (const s of params.chain) requestedNames.add(s.agent);
        if (params.tasks) for (const t of params.tasks) requestedNames.add(t.agent);
        if (params.agent) requestedNames.add(params.agent);

        const projectAgentsRequested = Array.from(requestedNames)
          .map((name) => agents.find((a) => a.name === name))
          .filter((a): a is AgentConfig => a?.source === "project");

        if (projectAgentsRequested.length > 0) {
          const names = projectAgentsRequested.map((a) => a.name).join(", ");
          const dir = discovery.projectAgentsDir ?? "(unknown)";
          const ok = await ctx.ui.confirm(
            "Run project-local agents?",
            `Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
          );
          if (!ok) {
            return {
              content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
              details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
            };
          }
        }
      }

      if (hasChain && params.chain) {
        const results: SingleResult[] = [];
        let previousOutput = "";

        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i];
          const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

          const chainUpdate: OnUpdate | undefined = onUpdate
            ? (partial) => {
                const current = partial.details?.results[0];
                if (current) {
                  onUpdate({
                    content: partial.content,
                    details: makeDetails("chain")([...results, current]),
                  });
                }
              }
            : undefined;

          const result = await runSingleAgent(
            ctx.cwd,
            dispatchDefaults,
            agents,
            step.agent,
            taskWithContext,
            step.cwd,
            i + 1,
            signal,
            chainUpdate,
            makeDetails("chain"),
          );
          results.push(result);

          if (isFailedResult(result)) {
            return {
              content: [
                { type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${getResultOutput(result)}` },
              ],
              details: makeDetails("chain")(results),
              isError: true,
            };
          }
          previousOutput = getFinalOutput(result.messages);
        }
        return {
          content: [
            { type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" },
          ],
          details: makeDetails("chain")(results),
        };
      }

      if (hasTasks && params.tasks) {
        if (params.tasks.length > MAX_PARALLEL_TASKS) {
          return {
            content: [
              {
                type: "text",
                text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
              },
            ],
            details: makeDetails("parallel")([]),
          };
        }

        const allResults: SingleResult[] = new Array(params.tasks.length);
        for (let i = 0; i < params.tasks.length; i++) {
          allResults[i] = {
            agent: params.tasks[i].agent,
            agentSource: "unknown",
            task: params.tasks[i].task,
            exitCode: -1,
            messages: [],
            stderr: "",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
          };
        }

        const emitParallelUpdate = () => {
          if (onUpdate) {
            const running = allResults.filter((r) => r.exitCode === -1).length;
            const done = allResults.filter((r) => r.exitCode !== -1).length;
            onUpdate({
              content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
              details: makeDetails("parallel")([...allResults]),
            });
          }
        };

        const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
          const result = await runSingleAgent(
            ctx.cwd,
            dispatchDefaults,
            agents,
            t.agent,
            t.task,
            t.cwd,
            undefined,
            signal,
            (partial) => {
              if (partial.details?.results[0]) {
                allResults[index] = partial.details.results[0];
                emitParallelUpdate();
              }
            },
            makeDetails("parallel"),
          );
          allResults[index] = result;
          emitParallelUpdate();
          return result;
        });

        const successCount = results.filter((r) => !isFailedResult(r)).length;
        const summaries = results.map((r) => {
          const output = truncateParallelOutput(getResultOutput(r));
          const status = isFailedResult(r)
            ? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
            : "completed";
          return `### [${r.agent}] ${status}\n\n${output}`;
        });
        return {
          content: [
            {
              type: "text",
              text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
            },
          ],
          details: makeDetails("parallel")(results),
        };
      }

      if (hasSingle && params.agent && params.task) {
        const result = await runSingleAgent(
          ctx.cwd,
          dispatchDefaults,
          agents,
          params.agent,
          params.task,
          params.cwd,
          undefined,
          signal,
          onUpdate,
          makeDetails("single"),
        );
        if (isFailedResult(result)) {
          return {
            content: [
              { type: "text", text: `Agent ${result.stopReason || "failed"}: ${getResultOutput(result)}` },
            ],
            details: makeDetails("single")([result]),
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
          details: makeDetails("single")([result]),
        };
      }

      const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
      return {
        content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
        details: makeDetails("single")([]),
      };
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("subagent "));
      if (args.chain && args.chain.length > 0) {
        text += theme.fg("accent", `chain (${args.chain.length} steps)`);
      } else if (args.tasks && args.tasks.length > 0) {
        text += theme.fg("accent", `parallel (${args.tasks.length} tasks)`);
      } else {
        text += theme.fg("accent", args.agent ?? "...");
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _opts, theme, _context) {
      const details = result.details as SubagentDetails | undefined;
      const first = result.content?.[0];
      if (!details || details.results.length === 0) {
        return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
      }

      const lines: string[] = [];
      for (const r of details.results) {
        const icon = r.exitCode === -1 ? "⏳" : isFailedResult(r) ? "✗" : "✓";
        lines.push(`${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`);
        const out = getResultOutput(r);
        if (r.exitCode === -1) {
          lines.push("  (running...)");
        } else if (out && out !== "(no output)") {
          lines.push(out.split("\n").slice(0, 10).map((l) => `  ${l}`).join("\n"));
        }
        const u = formatUsageStats(r.usage, r.model);
        if (u) lines.push(`  ${theme.fg("dim", u)}`);
      }

      if (details.mode !== "single" && first?.type === "text" && first.text) {
        const heading = first.text.split("\n")[0];
        if (heading) lines.unshift(theme.fg("accent", heading));
      }
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  pi.registerTool({
    name: "research",
    label: "Research",
    description: [
      "Run a background research subagent (isolated pi process) that writes cited findings to a file, then return immediately.",
      "Use when the research or wayfinder skill asks for a background agent: call this tool, keep working, then read the returned findingsPath later to collect the results.",
      "This is NOT for code review or design exploration — those must block for their results, so use the `subagent` tool instead.",
    ].join(" "),
    parameters: ResearchParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const findingsPath = path.isAbsolute(params.findingsPath)
        ? params.findingsPath
        : path.join(ctx.cwd, params.findingsPath);

      const handle = runBackgroundResearch({
        cwd: params.cwd ?? ctx.cwd,
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        thinkingLevel: ctx.thinkingLevel,
        tools: params.tools,
        task: params.task,
        findingsPath,
      });

      return {
        content: [
          {
            type: "text",
            text:
              `Research started (id: ${handle.researchId}). It is running in the background; ` +
              `findings will be written to: ${findingsPath}\n` +
              `Log: ${handle.logPath}\n\n` +
              `Keep working. Read ${findingsPath} later to collect the results.`,
          },
        ],
        details: handle,
      };
    },

    renderCall(args, theme, _context) {
      const text =
        theme.fg("toolTitle", theme.bold("research ")) +
        theme.fg("accent", "background") +
        theme.fg("dim", ` → ${args.findingsPath ?? "..."}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _opts, theme, _context) {
      const h = result.details as ResearchHandle | undefined;
      const first = result.content?.[0];
      const text = first?.type === "text" ? first.text : "(no output)";
      return new Text(h ? text : theme.fg("muted", text), 0, 0);
    },
  });
}
