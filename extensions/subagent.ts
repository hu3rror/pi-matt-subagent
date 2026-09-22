/**
 * pi-matt-subagent — blocking + background subagents for skills that require
 * subagents (code-review, codebase-design/design-it-twice,
 * improve-codebase-architecture, research, wayfinder, grilling).
 *
 * Two tools:
 *   - `subagent` (blocking): single / parallel / chain. Does not return until
 *     every subagent finishes; full results come back in one tool result. This
 *     is the primitive a skill means when it says "spawn sub-agents".
 *   - `research` (background, ADR 0013): runs an in-process second session
 *     (`createAgentSession` + `SessionManager.inMemory()`) that writes findings
 *     to a file, returns immediately with a handle, and pushes every terminal
 *     state (succeeded / failed / terminated / aborted) into the main context
 *     via `pi.sendMessage` — no polling.
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
import type { AgentToolResult, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, Model } from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  parseFrontmatter,
  SessionManager,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

import {
  blockingRunStatus,
  buildDispatchArgs,
  createRunRegistry,
  DEFAULT_RESEARCH_WALL_CLOCK_MS,
  discoverAgents,
  emptyUsage,
  formatBlockingToolError,
  formatRunSnapshot,
  formatTokens,
  getPiInvocation,
  isActiveRunStatus,
  isTerminalRunStatus,
  mergeToolParams,
  parseSubagentsArgs,
  readLogTail,
  RESEARCH_FULL_PARAMS,
  RESEARCH_TOOL_DESCRIPTION,
  RESEARCH_TOOL_PARAMS,
  resolveThinkingLevel,
  runBackgroundResearch,
  RUN_STATUS_ICONS,
  scopeAllowsProject,
  SUBAGENT_FULL_PARAMS,
  SUBAGENT_TOOL_DESCRIPTION,
  SUBAGENT_TOOL_PARAMS,
  type AgentConfig,
  type AgentScope,
  type AgentSource,
  type AgentFrontmatter,
  type FrontmatterParser,
  type ResearchExitInfo,
  type ResearchHandle,
  type ResearchChildSession,
  type RunEntry,
  type RunRegistry,
  type ThinkingLevel,
  type UsageStats,
} from "../src/lib.ts";

const parseAgentFrontmatter: FrontmatterParser = (content) => parseFrontmatter<AgentFrontmatter>(content);

const MAX_TASKS_PER_CALL = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

// ---------------------------------------------------------------------------
// In-process research child (ADR 0013)
//   The real `createChildSession` factory wired into `runBackgroundResearch`:
//   an in-process second session (`createAgentSession` +
//   `SessionManager.inMemory()`) built with `noExtensions: true` +
//   `systemPromptOverride` and only built-in tools (no recursive extension
//   re-entry, no subagent/research in the child). The async body is wrapped in
//   try/catch; every session is tracked here so `session_shutdown` disposes
//   any that outlive their runs (session-scoped research lifetime).
// ---------------------------------------------------------------------------

interface Disposable {
  dispose(): void;
}

/** Every live in-process research session; disposed on session_shutdown. */
const researchChildren = new Set<Disposable>();

/** Extracts the assistant text parts of a message_end event (the tee input). */
function assistantTextOf(msg: AgentMessage): string {
  if (msg.role !== "assistant") return "";
  return (msg.content as Array<{ type: string; text?: string }>)
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text as string)
    .join("");
}

/**
 * The real child-session factory (ADR 0013): creates the in-process research
 * session, returns a `ResearchChildSession` immediately (creation is async,
 * so `done`/`output` are backed by promises), tees assistant output into the
 * runner's log via `output`, and rejects `done` when the child throws or is
 * aborted. `session.abort()` is the kill path shared by the wall-clock cap
 * and the manual /subagents kill.
 * Named export so the dev-only push-e2e script (`scripts/push-e2e.ts`) can
 * exercise the real wiring against pi.
 */
export function createResearchChildSession(opts: {
  cwd: string;
  model?: unknown;
  thinkingLevel?: string;
  tools?: string[];
  systemPrompt: string;
  task: string;
  findingsPath: string;
}): ResearchChildSession {
  // A tiny async queue serving the runner's `for await` tee over `output`.
  const chunks: string[] = [];
  let ended = false;
  const waiters: Array<() => void> = [];
  // Wake waiters whenever there is something to consume OR the stream has
  // ended: a consumer suspended on an empty queue must still be released by
  // endStream(), otherwise the runner's tee never terminates and logFd stays
  // open whenever the child ends without trailing output.
  const flush = () => {
    while (waiters.length > 0 && (chunks.length > 0 || ended)) waiters.shift()!();
  };
  const pushChunk = (chunk: string) => {
    chunks.push(chunk);
    flush();
  };
  const endStream = () => {
    ended = true;
    flush();
  };

  const output = (async function* () {
    while (true) {
      while (chunks.length > 0) yield chunks.shift()!;
      if (ended) return;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  })();

  let session: Disposable & { abort: () => Promise<void>; subscribe: (l: (e: { type: string; message?: AgentMessage }) => void) => () => void } | undefined;
  // Internal abort flag: `abort()` before the session exists (a manual kill or
  // a very tight wall-clock cap landing inside the async creation window) must
  // still stop the researcher — after creation resolves, the flag is checked
  // before the session ever prompts, and the fresh session is disposed instead
  // of started.
  const abortController = new AbortController();
  const done = (async () => {
    try {
      const loader = new DefaultResourceLoader({
        cwd: opts.cwd,
        agentDir: getAgentDir(),
        noExtensions: true,
        systemPromptOverride: () => opts.systemPrompt,
      });
      await loader.reload();
      const created = await createAgentSession({
        cwd: opts.cwd,
        agentDir: getAgentDir(),
        sessionManager: SessionManager.inMemory(),
        model: opts.model as Model<any> | undefined,
        thinkingLevel: opts.thinkingLevel as ThinkingLevel | undefined,
        tools: opts.tools,
        resourceLoader: loader,
      });
      if (abortController.signal.aborted) {
        // The run was already killed while the session was being created:
        // dispose the fresh session and settle as a rejection — the runner has
        // already resolved the terminal status, so this only stops the work.
        created.session.dispose();
        throw new Error("research child aborted before start");
      }
      session = created.session;
      researchChildren.add(session);
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "message_end" && event.message) {
          const text = assistantTextOf(event.message);
          if (text) pushChunk(`${text}\n`);
        }
      });
      try {
        if (abortController.signal.aborted) throw new Error("research child aborted before start");
        await session.prompt(opts.task);
      } finally {
        unsubscribe();
        researchChildren.delete(session);
        try {
          session.dispose();
        } catch {
          /* ignore */
        }
        endStream();
      }
    } catch (err) {
      endStream();
      throw err;
    }
  })();

  return {
    output,
    done,
    abort: () => {
      abortController.abort();
      const s = session;
      if (s) void s.abort().catch(() => {});
    },
  };
}

/** The `customType` of the push card that renders research terminal states. */
export const RESEARCH_STATUS_CUSTOM_TYPE = "research-status";

/**
 * The pushed content for one terminal state — load-bearing: it becomes the
 * triggered turn's prompt, so it must instruct reading the findings file
 * (ADR 0013, prototype lesson), not just summarize.
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

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

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
 * Last non-empty line of a text block (used for a run's live progress line).
 */
function lastLine(text: string): string | undefined {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : undefined;
}

/**
 * Keeps the footer count in sync with the run registry. Counts active runs
 * (queued + running); clears the status when nothing is active. No-op
 * without a UI (headless / print / json mode).
 */
function updateSubagentFooter(
  ctx: { hasUI: boolean; ui: { setStatus: (key: string, value?: string) => void } },
  registry: RunRegistry,
): void {
  if (!ctx.hasUI) return;
  const active = registry.snapshot().filter((r) => isActiveRunStatus(r.status)).length;
  if (active === 0) ctx.ui.setStatus("subagents", undefined);
  else ctx.ui.setStatus("subagents", `⧗ ${active} subagent${active > 1 ? "s" : ""} running`);
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
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // D3 — in-session registry of every tracked subagent run (blocking +
  // background). Cleared on session teardown so no stale state survives into
  // a new session.
  const subagentRuns = createRunRegistry();
  // ADR 0013 — per-run AbortController backing /subagents kill: aborting it
  // aborts the in-process child session; the runner resolves the run `aborted`
  // and pushes the outcome (no OS signals, no pid reuse hazard).
  const researchAborts = new Map<string, AbortController>();

  pi.on("session_shutdown", () => {
    subagentRuns.clear();
    researchAborts.clear();
    // Session-scoped research lifetime (ADR 0013): dispose every in-process
    // child session that is still alive so no orphaned work outlives the session.
    for (const child of researchChildren) {
      try {
        child.dispose();
      } catch {
        /* ignore */
      }
    }
    researchChildren.clear();
  });

  // ADR 0013 — the push card: renders a research terminal state as a readable
  // transcript entry (status + findings path + log path; expanded shows the tail).
  pi.registerMessageRenderer(RESEARCH_STATUS_CUSTOM_TYPE, (message, { expanded, outputPad }, theme) => {
    const details = message.details as
      | { status?: string; findingsPath?: string; logPath?: string; lastOutput?: string }
      | undefined;
    const status = details?.status ?? "succeeded";
    // Reuse the frozen icon map from lib (single source for status icons);
    // only the color stays renderer-local.
    const icon = RUN_STATUS_ICONS[status as keyof typeof RUN_STATUS_ICONS] ?? "?";
    const color =
      status === "succeeded" ? "success" : status === "failed" ? "error" : status === "terminated" ? "warning" : "dim";
    const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(`${theme.fg("toolTitle", theme.bold("research"))} ${theme.fg(color, `${icon} ${status}`)}`, 0, 0));
    if (details?.findingsPath) box.addChild(new Text(`findings: ${details.findingsPath}`, 0, 0));
    if (details?.logPath) box.addChild(new Text(`log: ${details.logPath}`, 0, 0));
    if (expanded && details?.lastOutput) box.addChild(new Text(theme.fg("dim", details.lastOutput), 0, 0));
    return box;
  });

  // D3 — unified overview of all tracked runs; use when idle to read the
  // snapshot (blocking runs are not reachable mid-run by design, since input
  // queues until the agent finishes).
  // D6 — /subagents surface: kill aborts an in-process researcher via its
  // AbortController (never re-kill a finished run), prune is terminal-only, tail is byte-capped.
  type SubagentsUi = {
    hasUI: boolean;
    ui: {
      select(title: string, options: string[]): Promise<string | undefined>;
      confirm(title: string, message: string): Promise<boolean>;
      notify(message: string, type?: "info" | "warning" | "error"): void;
      setStatus(key: string, text: string | undefined): void;
    };
  };

  const MENU_SNAPSHOT = "View runs";
  const MENU_STOP = "Stop run…";
  const MENU_CLEAR = "Clear finished";
  const MENU_SHOW_LOG = "Show log…";

  const showSnapshot = (ctx: SubagentsUi) => {
    const runs = subagentRuns.snapshot().map((r) => {
      if (r.channel === "background" && !r.lastOutput && r.logPath) {
        const tail = lastLine(readLogTail(r.logPath));
        return tail ? { ...r, lastOutput: tail } : r;
      }
      return r;
    });
    ctx.ui.notify(formatRunSnapshot(runs), "info");
  };

  const runLabel = (r: RunEntry) => `${r.id} · ${RUN_STATUS_ICONS[r.status]} ${r.role} (${r.source})`;
  const runRef = (r: RunEntry) => `${r.id} (${r.role})`;
  // Only running background runs with a live abort handle are killable
  // (ADR 0013): blocking runs stay interruptible via Esc only.
  const isKillable = (r: RunEntry) => r.status === "running" && r.channel === "background" && researchAborts.has(r.id);

  const killRun = async (id: string, ctx: SubagentsUi) => {
    const run = subagentRuns.get(id);
    if (!run) {
      ctx.ui.notify(`No run "${id}".`, "error");
      return;
    }
    if (!isKillable(run)) {
      ctx.ui.notify(`${runRef(run)} is not a stoppable running process.`, "error");
      return;
    }
    if (ctx.hasUI) {
      const ok = await ctx.ui.confirm("Stop subagent run?", `Stop ${runRef(run)}? Partial findings stay on disk.`);
      if (!ok) return;
    }
    const controller = researchAborts.get(id);
    if (!controller) return;
    researchAborts.delete(id);
    controller.abort();
    ctx.ui.notify(`Stop signal sent to ${runRef(run)}; the outcome is pushed when the run settles.`, "info");
  };

  const tailRun = (id: string, ctx: SubagentsUi) => {
    const run = subagentRuns.get(id);
    if (!run) {
      ctx.ui.notify(`No run "${id}".`, "error");
      return;
    }
    if (!run.logPath) {
      ctx.ui.notify(`${runRef(run)} has no log to show — only background runs keep a log file.`, "error");
      return;
    }
    const tail = readLogTail(run.logPath);
    ctx.ui.notify(tail ? `Log tail of ${runRef(run)}:\n${tail}` : `(empty log for ${id})`, "info");
  };

  const pruneFinishedRuns = async (ctx: SubagentsUi) => {
    const terminal = subagentRuns.snapshot().filter((r) => isTerminalRunStatus(r.status));
    if (terminal.length === 0) {
      ctx.ui.notify("Nothing to clear — no finished runs.", "info");
      return;
    }
    if (ctx.hasUI) {
      const ok = await ctx.ui.confirm(
        "Clear finished runs?",
        `Remove ${terminal.length} finished run record(s)? Findings/log files stay on disk.`,
      );
      if (!ok) return;
    }
    for (const r of terminal) {
      subagentRuns.remove(r.id);
      researchAborts.delete(r.id);
    }
    updateSubagentFooter(ctx, subagentRuns);
    ctx.ui.notify(`Cleared ${terminal.length} finished run(s).`, "info");
  };

  const pickRun = async (
    ctx: SubagentsUi,
    title: string,
    eligible: RunEntry[],
  ): Promise<string | undefined> => {
    if (eligible.length === 0) {
      ctx.ui.notify("Nothing eligible for that action right now.", "info");
      return undefined;
    }
    const choice = await ctx.ui.select(title, eligible.map(runLabel));
    if (!choice) return undefined;
    return choice.split(" · ")[0];
  };

  const openMenu = async (ctx: SubagentsUi) => {
    const choice = await ctx.ui.select("Subagent runs", [MENU_SNAPSHOT, MENU_STOP, MENU_CLEAR, MENU_SHOW_LOG]);
    if (!choice) return;
    if (choice === MENU_SNAPSHOT) return showSnapshot(ctx);
    if (choice === MENU_STOP) {
      const id = await pickRun(
        ctx,
        "Stop which run?",
        subagentRuns.snapshot().filter(isKillable),
      );
      if (id) await killRun(id, ctx);
      return;
    }
    if (choice === MENU_CLEAR) return pruneFinishedRuns(ctx);
    const id = await pickRun(ctx, "Show log for which run?", subagentRuns.snapshot().filter((r) => r.logPath != null));
    if (id) tailRun(id, ctx);
  };

  pi.registerCommand("subagents", {
    description:
      "List and manage tracked subagent runs: no args opens the menu; snapshot, kill <id>, tail <id>, prune run directly",
    handler: async (args, ctx) => {
      const argText = args ?? "";
      if (!argText.trim()) {
        // non-TUI modes have no menu: fall back to the snapshot
        if (!ctx.hasUI) return showSnapshot(ctx);
        return openMenu(ctx);
      }
      const cmd = parseSubagentsArgs(argText);
      if (cmd.action === "invalid") return ctx.ui.notify(cmd.reason, "error");
      if (cmd.action === "snapshot") return showSnapshot(ctx);
      if (cmd.action === "prune") return pruneFinishedRuns(ctx);
      if (cmd.action === "kill") return killRun(cmd.id, ctx);
      tailRun(cmd.id, ctx);
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: SUBAGENT_TOOL_DESCRIPTION,
    parameters: SUBAGENT_TOOL_PARAMS,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const { input, ...directParams } = params;
      const merged = mergeToolParams<typeof directParams, { model?: string; thinkingOverride?: ThinkingLevel }>({
        direct: directParams,
        input,
        fullSchema: SUBAGENT_FULL_PARAMS,
      });
      const agentScope: AgentScope = merged.agentScope ?? "user";
      const availableToolNames = probeAvailableToolNames(pi);
      const dispatchDefaults: DispatchDefaults = {
        model: merged.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
        thinkingLevel: ctx.thinkingLevel,
        // input.thinkingOverride is the canonical per-run override field; the
        // public `thinkingLevel` param maps to the same slot (ADR 0011).
        thinkingOverride: merged.thinkingOverride ?? merged.thinkingLevel,
      };
      const discovery = discoverAgents(ctx.cwd, getAgentDir(), CONFIG_DIR_NAME, agentScope, parseAgentFrontmatter);
      const agents = discovery.agents;

      const hasChain = (merged.chain?.length ?? 0) > 0;
      const hasTasks = (merged.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(merged.agent && merged.task);
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
      if (merged.chain) for (const s of merged.chain) requestedNames.add(s.agent);
      if (merged.tasks) for (const t of merged.tasks) requestedNames.add(t.agent);
      if (merged.agent) requestedNames.add(merged.agent);

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

      if (hasChain && merged.chain) {
        const results: SingleResult[] = [];
        let previousOutput = "";

        for (let i = 0; i < merged.chain.length; i++) {
          const step = merged.chain[i];
          const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
          const runId = subagentRuns.register({
            role: step.agent,
            source: agents.find((a) => a.name === step.agent)?.source ?? "unknown",
            channel: "blocking",
            status: "running",
            startedAt: Date.now(),
          });
          updateSubagentFooter(ctx, subagentRuns);

          const chainUpdate: OnUpdate | undefined = onUpdate
            ? (partial) => {
                const current = partial.details?.results[0];
                if (current) {
                  const out = getFinalOutput(current.messages);
                  if (out) subagentRuns.update(runId, { lastOutput: lastLine(out), usage: current.usage });
                  onUpdate({
                    content: partial.content,
                    details: makeDetails([...results, current]),
                  });
                }
              }
            : undefined;

          let result: SingleResult;
          try {
            result = await runSingleAgent(
              ctx.cwd,
              dispatchDefaults,
              agents,
              { agentName: step.agent, task: taskWithContext, cwd: step.cwd, step: i + 1 },
              signal,
              chainUpdate,
              makeDetails,
              availableToolNames,
            );
          } catch (err) {
            subagentRuns.update(runId, { status: "aborted" });
            updateSubagentFooter(ctx, subagentRuns);
            throw err;
          }
          results.push(result);
          subagentRuns.update(runId, {
            status: blockingRunStatus({ exitCode: result.exitCode, stopReason: result.stopReason }),
            lastOutput: lastLine(getFinalOutput(result.messages)),
            usage: result.usage,
          });
          updateSubagentFooter(ctx, subagentRuns);

          if (isFailedResult(result)) {
            throw new Error(
              formatBlockingToolError("chain", { agent: step.agent, step: i + 1, output: getResultOutput(result) }),
            );
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

      if (hasTasks && merged.tasks) {
        if (merged.tasks.length > MAX_TASKS_PER_CALL) {
          return {
            content: [
              {
                type: "text",
                text: `Too many parallel tasks (${merged.tasks.length}). Max is ${MAX_TASKS_PER_CALL}.`,
              },
            ],
            details: makeDetails([]),
          };
        }

        const allResults: SingleResult[] = new Array(merged.tasks.length);
        // D3: pre-register every task as queued; each flips to running when
        // its concurrency slot actually opens (inside the map worker).
        const runIds: string[] = merged.tasks.map((t) =>
          subagentRuns.register({
            role: t.agent,
            source: agents.find((a) => a.name === t.agent)?.source ?? "unknown",
            channel: "blocking",
            status: "queued",
            startedAt: Date.now(),
          }),
        );
        updateSubagentFooter(ctx, subagentRuns);
        for (let i = 0; i < merged.tasks.length; i++) {
          allResults[i] = {
            agent: merged.tasks[i].agent,
            agentSource: "unknown",
            task: merged.tasks[i].task,
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

        let results: SingleResult[];
        try {
          results = await mapWithConcurrencyLimit(merged.tasks, MAX_CONCURRENCY, async (t, index) => {
            subagentRuns.update(runIds[index], { status: "running" });
            updateSubagentFooter(ctx, subagentRuns);
            let result: SingleResult;
            try {
              result = await runSingleAgent(
                ctx.cwd,
                dispatchDefaults,
                agents,
                { agentName: t.agent, task: t.task, cwd: t.cwd },
                signal,
                (partial) => {
                  if (partial.details?.results[0]) {
                    const current = partial.details.results[0];
                    allResults[index] = current;
                    const out = getFinalOutput(current.messages);
                    if (out) subagentRuns.update(runIds[index], { lastOutput: lastLine(out), usage: current.usage });
                    emitParallelUpdate();
                  }
                },
                makeDetails,
                availableToolNames,
              );
            } catch (err) {
              subagentRuns.update(runIds[index], { status: "aborted" });
              updateSubagentFooter(ctx, subagentRuns);
              throw err;
            }
            allResults[index] = result;
            subagentRuns.update(runIds[index], {
              status: blockingRunStatus({ exitCode: result.exitCode, stopReason: result.stopReason }),
              lastOutput: lastLine(getFinalOutput(result.messages)),
              usage: result.usage,
            });
            updateSubagentFooter(ctx, subagentRuns);
            emitParallelUpdate();
            return result;
          });
        } catch (err) {
          // An abort surfaces here (user Esc). Leftover workers never started:
          // their runs sit in queued (active). Mark every still-active run
          // aborted so the footer stops counting them and /subagents shows the
          // truth instead of zombie queued entries (spec: queued may be
          // aborted directly — card cancelled before its slot opens).
          for (const id of runIds) {
            const r = subagentRuns.get(id);
            if (r && isActiveRunStatus(r.status)) {
              subagentRuns.update(id, { status: "aborted" });
            }
          }
          updateSubagentFooter(ctx, subagentRuns);
          throw err;
        }

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

      if (hasSingle && merged.agent && merged.task) {
        const runId = subagentRuns.register({
          role: merged.agent,
          source: agents.find((a) => a.name === merged.agent)?.source ?? "unknown",
          channel: "blocking",
          status: "running",
          startedAt: Date.now(),
        });
        updateSubagentFooter(ctx, subagentRuns);
        let result: SingleResult;
        try {
          result = await runSingleAgent(
            ctx.cwd,
            dispatchDefaults,
            agents,
            { agentName: merged.agent, task: merged.task, cwd: merged.cwd },
            signal,
            (partial) => {
              // live progress: keep the registry's last output current
              const current = partial.details?.results[0];
              if (current) {
                const out = getFinalOutput(current.messages);
                if (out) subagentRuns.update(runId, { lastOutput: lastLine(out), usage: current.usage });
              }
              onUpdate?.(partial);
            },
            makeDetails,
            availableToolNames,
          );
        } catch (err) {
          subagentRuns.update(runId, { status: "aborted" });
          updateSubagentFooter(ctx, subagentRuns);
          throw err;
        }
        subagentRuns.update(runId, {
          status: blockingRunStatus({ exitCode: result.exitCode, stopReason: result.stopReason }),
          lastOutput: lastLine(getFinalOutput(result.messages)),
          usage: result.usage,
        });
        updateSubagentFooter(ctx, subagentRuns);
        if (isFailedResult(result)) {
          throw new Error(
            formatBlockingToolError("single", { stopReason: result.stopReason, output: getResultOutput(result) }),
          );
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
    description: RESEARCH_TOOL_DESCRIPTION,
    parameters: RESEARCH_TOOL_PARAMS,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { input, ...directParams } = params;
      const merged = mergeToolParams<typeof directParams, { model?: string; maxWallClockMs?: number }>({
        direct: directParams,
        input,
        fullSchema: RESEARCH_FULL_PARAMS,
      });
      const agentScope: AgentScope = merged.agentScope ?? "user";
      const availableToolNames = probeAvailableToolNames(pi);
      const findingsPath = path.isAbsolute(merged.findingsPath)
        ? merged.findingsPath
        : path.join(ctx.cwd, merged.findingsPath);

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
        return { content: [{ type: "text", text: "Canceled: project-local agents not approved." }], details: undefined };
      }

      // The in-process child needs a Model object, not a provider/id string:
      // inherit the main session's model, or resolve the input `model` override
      // through the registry. An unresolvable override fails loudly.
      let childModel: Model<any> | undefined = ctx.model;
      if (merged.model) {
        const slash = merged.model.indexOf("/");
        const found =
          slash > 0
            ? ctx.modelRegistry.find(merged.model.slice(0, slash), merged.model.slice(slash + 1))
            : undefined;
        if (!found) {
          return {
            content: [{ type: "text", text: `Unknown model override: ${merged.model}` }],
            details: undefined,
          };
        }
        childModel = found;
      }

      const researcher = agents.find((a) => a.name === "researcher");
      const thinking = resolveDispatchThinking(researcher, {
        thinkingLevel: ctx.thinkingLevel,
        thinkingOverride: merged.thinkingLevel,
      });

      const runId = subagentRuns.register({
        role: "researcher",
        source: researcher?.source ?? "embedded",
        channel: "background",
        status: "running",
        startedAt: Date.now(),
        findingsPath,
      });
      // ADR 0013 — per-run abort handle backing /subagents kill; the runner
      // resolves the run `aborted` and the push below delivers the outcome.
      const abortController = new AbortController();
      researchAborts.set(runId, abortController);
      updateSubagentFooter(ctx, subagentRuns);

      const handle = runBackgroundResearch(
        {
          cwd: merged.cwd ?? ctx.cwd,
          model: childModel,
          thinkingLevel: thinking,
          tools: merged.tools,
          task: merged.task,
          findingsPath,
          maxWallClockMs: merged.maxWallClockMs,
          availableToolNames,
          agents,
          abortSignal: abortController.signal,
          // Fires exactly once at a terminal state: settle the registry entry
          // and push the outcome into the main context — content worded as an
          // instruction to read the findings file (ADR 0013).
          onExit: (info) => {
            researchAborts.delete(runId);
            const lastOutput = readLogTail(handle.logPath);
            try {
              subagentRuns.update(runId, { status: info.status, lastOutput: lastOutput || undefined });
            } catch {
              /* run already terminal (frozen elsewhere) — the first terminal wins */
            }
            updateSubagentFooter(ctx, subagentRuns);
            pi.sendMessage(
              {
                customType: RESEARCH_STATUS_CUSTOM_TYPE,
                content: researchStatusContent(info.status, findingsPath, handle.logPath),
                display: true,
                details: { status: info.status, findingsPath, logPath: handle.logPath, lastOutput },
              },
              { deliverAs: "followUp", triggerTurn: true },
            );
          },
        },
        (childOpts) => createResearchChildSession(childOpts),
      );
      // logPath is only known after the runner allocates its tmp dir; the run
      // may already be terminal (a failed update must not surface as a tool error).
      try {
        subagentRuns.update(runId, { logPath: handle.logPath });
      } catch {
        /* run already frozen by onExit */
      }
      updateSubagentFooter(ctx, subagentRuns);

      return {
        content: [
          {
            type: "text",
            text:
              `Research started (id: ${handle.researchId}). It is running in the background; ` +
              `findings will be written to: ${findingsPath}\n` +
              `Log: ${handle.logPath}\n\n` +
              `Keep working. The completion (succeeded / failed / terminated / aborted) is pushed to you — no polling needed.`,
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
