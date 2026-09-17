/**
 * pi-matt-subagent — blocking + background subagents for skills that require
 * subagents (code-review, codebase-design/design-it-twice,
 * improve-codebase-architecture, research, wayfinder, grilling).
 *
 * Two tools:
 *   - `subagent` (blocking): single / parallel / chain. Does not return until
 *     every subagent finishes; full results come back in one tool result. This
 *     is the primitive a skill means when it says "spawn sub-agents".
 *   - `research` (background): spawns a background researcher process that
 *     writes findings to a file, then returns immediately with a handle.
 *
 * Six bundled roles live in src/lib.ts (standards-reviewer, spec-reviewer,
 * design-explorer, architecture-scout, researcher, fact-finder). User agents
 * from ~/.pi/agent/agents/*.md and project agents from .pi/agents/*.md
 * override bundled roles by name.
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

import {
  AGENT_SCOPES,
  RESEARCH_BUDGET_TIERS,
  THINKING_LEVELS,
  buildDispatchArgs,
  discoverAgents,
  emptyUsage,
  getPiInvocation,
  resolveEffectiveResearchBudget,
  resolveThinkingLevel,
  runBackgroundResearch,
  scopeAllowsProject,
  type AgentConfig,
  type AgentScope,
  type AgentSource,
  type AgentFrontmatter,
  type FrontmatterParser,
  type ResearchBudgetTier,
  type ResearchHandle,
  type ResearchBudget,
  type ResearchBudgetOverrides,
  type UsageStats,
} from "../src/lib.ts";

const parseAgentFrontmatter: FrontmatterParser = (content) => parseFrontmatter<AgentFrontmatter>(content);

const MAX_TASKS_PER_CALL = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

// ---------------------------------------------------------------------------
// Display helpers
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

function formatAgentList(agents: AgentConfig[]): string {
  return agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
}

/**
 * Probes the tool registry of the current (main) session for the names a
 * child subagent process can be handed via `--tools`. The child starts from
 * the same settings and extensions as this session, so its registry is the
 * main registry intersected with the `--tools` allowlist: probing here and
 * filtering each role's declarations against it keeps names that only exist
 * in this environment (e.g. fff's ffgrep/ffind outside override mode) or not
 * at all out of the child's allowlist.
 */
function probeAvailableToolNames(pi: ExtensionAPI): ReadonlySet<string> {
  return new Set(pi.getAllTools().map((t) => t.name));
}

/**
 * Gates project-local agents behind a trust confirmation, shared by the
 * blocking `subagent` tool and the background `research` tool. Returns true
 * when no confirmation is needed (user scope, headless, trusted project, or
 * no requested agent resolves to a project source) or when the user approves.
 */
async function confirmProjectAgents(
  ctx: {
    hasUI: boolean;
    isProjectTrusted: () => boolean;
    ui: { confirm: (title: string, message: string) => Promise<boolean> };
  },
  agentScope: AgentScope,
  agents: AgentConfig[],
  projectAgentsDir: string | null,
  requestedNames: string[],
  title: string,
): Promise<boolean> {
  if (!scopeAllowsProject(agentScope) || !ctx.hasUI || ctx.isProjectTrusted() || requestedNames.length === 0) {
    return true;
  }
  const projectAgents = agents.filter((a) => requestedNames.includes(a.name) && a.source === "project");
  if (projectAgents.length === 0) return true;
  const dir = projectAgentsDir ?? "(unknown)";
  const names = projectAgents.map((a) => a.name).join(", ");
  return ctx.ui.confirm(
    title,
    `Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
  );
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface SingleResult {
  agent: string;
  agentSource: AgentSource;
  task: string;
  exitCode: number;
  running?: boolean;
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
  thinkingOverride?: string;
}

/**
 * Decides the thinking level for one subagent run, shared by the blocking
 * runner and the background researcher: per-call override > role level > the
 * inherited main-session level; undefined when the agent pins its own model.
 */
function resolveDispatchThinking(
  agent: AgentConfig | undefined,
  d: { thinkingLevel?: string; thinkingOverride?: string },
): string | undefined {
  return resolveThinkingLevel({
    roleLevel: agent?.thinkingLevel,
    override: d.thinkingOverride,
    inherited: d.thinkingLevel,
    hasModel: Boolean(agent?.model),
  });
}

// ---------------------------------------------------------------------------
// Blocking runner
// ---------------------------------------------------------------------------

interface AgentTask {
  agentName: string;
  task: string;
  cwd?: string;
  step?: number;
}

async function runSingleAgent(
  defaultCwd: string,
  dispatchDefaults: DispatchDefaults,
  agents: AgentConfig[],
  agentTask: AgentTask,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdate | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
  availableToolNames?: ReadonlySet<string>,
): Promise<SingleResult> {
  const { agentName, task, cwd, step } = agentTask;
  const agent = agents.find((a) => a.name === agentName);

  if (!agent) {
    const available = formatAgentList(agents);
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      usage: emptyUsage(),
      step,
    };
  }

  const model = agent.model ?? dispatchDefaults.model;
  const thinking = resolveDispatchThinking(agent, dispatchDefaults);

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  const currentResult: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
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
    }
    const args = buildDispatchArgs({
      model,
      thinking,
      tools: agent.tools,
      availableToolNames,
      promptPath: tmpPromptPath ?? undefined,
      task,
    });
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
//   Implementation lives in src/lib.ts (runBackgroundResearch) so it is
//   testable under `node --test`; spawn is injectable there.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const AgentScopeSchema = Type.Union(AGENT_SCOPES.map((s) => Type.Literal(s)));
const ThinkingLevelSchema = Type.Union(THINKING_LEVELS.map((l) => Type.Literal(l)));
const BudgetTierSchema = Type.Union(RESEARCH_BUDGET_TIERS.map((b) => Type.Literal(b)));
const BudgetOverridesSchema = Type.Object(
  {
    maxSearchRounds: Type.Optional(Type.Integer({ minimum: 1, description: "Soft: max search rounds." })),
    maxFetchPages: Type.Optional(Type.Integer({ minimum: 1, description: "Soft: max total fetch pages." })),
    maxFindingLines: Type.Optional(Type.Integer({ minimum: 1, description: "Soft: max findings lines." })),
    maxLogBytes: Type.Optional(Type.Integer({ minimum: 1, description: "Hard: max log bytes (runner-enforced; may only tighten)." })),
    maxWallClockMs: Type.Optional(Type.Integer({ minimum: 1, description: "Hard: max wall clock ms (runner-enforced; may only tighten)." })),
  },
  { additionalProperties: false },
);

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
  agentScope: Type.Optional(AgentScopeSchema),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

const ResearchParams = Type.Object({
  task: Type.String({ description: "The research question to investigate" }),
  findingsPath: Type.String({
    description: "Absolute or repo-relative path where the researcher must write findings (Markdown).",
  }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the researcher process" })),
  tools: Type.Optional(Type.Array(Type.String({ description: "Tool names to enable" }))),
  agentScope: Type.Optional(AgentScopeSchema),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  budget: Type.Optional(BudgetTierSchema),
  budgetOverrides: Type.Optional(BudgetOverridesSchema),
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
      const availableToolNames = probeAvailableToolNames(pi);
      const dispatchDefaults: DispatchDefaults = {
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        thinkingLevel: ctx.thinkingLevel,
        thinkingOverride: params.thinkingLevel,
      };
      const discovery = discoverAgents(ctx.cwd, getAgentDir(), CONFIG_DIR_NAME, agentScope, parseAgentFrontmatter);
      const agents = discovery.agents;

      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
      const mode: "single" | "parallel" | "chain" = hasChain ? "chain" : hasTasks ? "parallel" : "single";

      const makeDetails = (results: SingleResult[]): SubagentDetails => ({ mode, results });

      if (modeCount !== 1) {
        const available = formatAgentList(agents);
        return {
          content: [
            { type: "text", text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}` },
          ],
          details: makeDetails([]),
        };
      }

      const requestedNames = new Set<string>();
      if (params.chain) for (const s of params.chain) requestedNames.add(s.agent);
      if (params.tasks) for (const t of params.tasks) requestedNames.add(t.agent);
      if (params.agent) requestedNames.add(params.agent);

      const approved = await confirmProjectAgents(
        ctx,
        agentScope,
        agents,
        discovery.projectAgentsDir,
        Array.from(requestedNames),
        "Run project-local agents?",
      );
      if (!approved) {
        return {
          content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
          details: makeDetails([]),
        };
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
                    details: makeDetails([...results, current]),
                  });
                }
              }
            : undefined;

          const result = await runSingleAgent(
            ctx.cwd,
            dispatchDefaults,
            agents,
            { agentName: step.agent, task: taskWithContext, cwd: step.cwd, step: i + 1 },
            signal,
            chainUpdate,
            makeDetails,
            availableToolNames,
          );
          results.push(result);

          if (isFailedResult(result)) {
            return {
              content: [
                { type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${getResultOutput(result)}` },
              ],
              details: makeDetails(results),
              isError: true,
            };
          }
          previousOutput = getFinalOutput(result.messages);
        }
        return {
          content: [
            { type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" },
          ],
          details: makeDetails(results),
        };
      }

      if (hasTasks && params.tasks) {
        if (params.tasks.length > MAX_TASKS_PER_CALL) {
          return {
            content: [
              {
                type: "text",
                text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_TASKS_PER_CALL}.`,
              },
            ],
            details: makeDetails([]),
          };
        }

        const allResults: SingleResult[] = new Array(params.tasks.length);
        for (let i = 0; i < params.tasks.length; i++) {
          allResults[i] = {
            agent: params.tasks[i].agent,
            agentSource: "unknown",
            task: params.tasks[i].task,
            exitCode: 0,
            running: true,
            messages: [],
            stderr: "",
            usage: emptyUsage(),
          };
        }

        const emitParallelUpdate = () => {
          if (onUpdate) {
            const running = allResults.filter((r) => r.running).length;
            const done = allResults.filter((r) => !r.running).length;
            onUpdate({
              content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
              details: makeDetails([...allResults]),
            });
          }
        };

        const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
          const result = await runSingleAgent(
            ctx.cwd,
            dispatchDefaults,
            agents,
            { agentName: t.agent, task: t.task, cwd: t.cwd },
            signal,
            (partial) => {
              if (partial.details?.results[0]) {
                allResults[index] = partial.details.results[0];
                emitParallelUpdate();
              }
            },
            makeDetails,
            availableToolNames,
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
          details: makeDetails(results),
        };
      }

      if (hasSingle && params.agent && params.task) {
        const result = await runSingleAgent(
          ctx.cwd,
          dispatchDefaults,
          agents,
          { agentName: params.agent, task: params.task, cwd: params.cwd },
          signal,
          onUpdate,
          makeDetails,
          availableToolNames,
        );
        if (isFailedResult(result)) {
          return {
            content: [
              { type: "text", text: `Agent ${result.stopReason || "failed"}: ${getResultOutput(result)}` },
            ],
            details: makeDetails([result]),
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
          details: makeDetails([result]),
        };
      }

      const available = formatAgentList(agents);
      return {
        content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
        details: makeDetails([]),
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
        const icon = r.running ? "⏳" : isFailedResult(r) ? "✗" : "✓";
        lines.push(`${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`);
        const out = getResultOutput(r);
        if (r.running) {
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
      'Agent scope is "user" by default (user agents plus the bundled researcher role); use "both" or "project" so a project-local `researcher` from .pi/agents overrides the bundled role (untrusted projects get a confirmation first).',
      "Budget (optional): `budget` picks the effort tier (standard | tight) and `budgetOverrides` adjusts individual caps — 3 soft (maxSearchRounds, maxFetchPages, maxFindingLines) written into the prompt, 2 hard (maxLogBytes, maxWallClockMs) enforced by the runner (killed at 110%). Hard overrides may only tighten.",
    ].join(" "),
    parameters: ResearchParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const agentScope: AgentScope = (params.agentScope as AgentScope) ?? "user";
      const availableToolNames = probeAvailableToolNames(pi);
      const findingsPath = path.isAbsolute(params.findingsPath)
        ? params.findingsPath
        : path.join(ctx.cwd, params.findingsPath);

      const discovery = discoverAgents(ctx.cwd, getAgentDir(), CONFIG_DIR_NAME, agentScope, parseAgentFrontmatter);
      const agents = discovery.agents;

      const approved = await confirmProjectAgents(
        ctx,
        agentScope,
        agents,
        discovery.projectAgentsDir,
        ["researcher"],
        "Run project-local researcher?",
      );
      if (!approved) {
        return { content: [{ type: "text", text: "Canceled: project-local agents not approved." }] };
      }

      const researcher = agents.find((a) => a.name === "researcher");
      const thinking = resolveDispatchThinking(researcher, {
        thinkingLevel: ctx.thinkingLevel,
        thinkingOverride: params.thinkingLevel,
      });

      let effectiveBudget: ResearchBudget;
      try {
        // every run carries a budget: call tier > role frontmatter tier > standard (ADR 0003)
        effectiveBudget = resolveEffectiveResearchBudget({
          tier: params.budget as ResearchBudgetTier | undefined,
          roleTier: researcher?.budget,
          overrides: params.budgetOverrides as ResearchBudgetOverrides | undefined,
        });
      } catch (err) {
        return { content: [{ type: "text", text: `Invalid research budget: ${(err as Error).message}` }] };
      }

      const handle = runBackgroundResearch({
        cwd: params.cwd ?? ctx.cwd,
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        thinkingLevel: thinking,
        tools: params.tools,
        task: params.task,
        findingsPath,
        budget: effectiveBudget,
        availableToolNames,
        agents,
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
