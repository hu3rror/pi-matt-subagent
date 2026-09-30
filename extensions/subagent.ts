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
import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  CONFIG_DIR_NAME,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  parseFrontmatter,
  SessionManager,
  type ThemeColor,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

import {
  buildDispatchArgs,
  buildSubagentEnv,
  createRunRegistry,
  DEFAULT_RESEARCH_WALL_CLOCK_MS,
  discoverAgents,
  emptyUsage,
  formatRunSnapshot,
  getPiInvocation,
  isActiveRunStatus,
  isTerminalRunStatus,
  mergeToolParams,
  parseSubagentsArgs,
  readLogTail,
  researchStatusContent,
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
  type ResearchHandle,
  type ResearchChildSession,
  type ResearchStatusDetails,
  type RunEntry,
  type RunPatch,
  type RunRegistry,
  type ThinkingLevel,
  type ToolCallEvent,
  type UsageStats,
} from "../src/lib.ts";

import {
  createResultAccumulator,
  escalateKill,
  type SingleResult,
} from "../src/blocking-protocol.ts";

import {
  assistantTextOfMessage,
  formatUsageLine,
  getResultOutput,
  isToolError,
  lastOutputLine,
  toolErrorDetails,
} from "../src/lib.ts";

import {
  runBlockingPlan,
  type BlockingPlan,
  type RunnerSeam,
  type SubagentDetails,
} from "../src/blocking-runner.ts";

const parseAgentFrontmatter: FrontmatterParser = (content) => parseFrontmatter<AgentFrontmatter>(content);

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
  /** Optional synchronous audit hook (toolCall audit): invoked once per executed tool call. */
  onToolCall?: (call: ToolCallEvent) => void;
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

  let session: AgentSession | undefined;
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
          const text = assistantTextOfMessage(event.message);
          if (text) pushChunk(`${text}\n`);
        } else if (event.type === "tool_execution_start") {
          // ToolCall audit seam: every executed tool call is dispatched through
          // the optional onToolCall hook with its final arguments — start
          // events only, no results. The runner owns the file; nothing here
          // touches the output stream or the UI.
          opts.onToolCall?.({ toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
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

/**
 * The customType of the push card that renders research terminal states.
 */
export const RESEARCH_STATUS_CUSTOM_TYPE = "research-status";

// Status → theme color for the push card, keyed on the frozen terminal
// statuses (like the shared RUN_STATUS_ICONS map) so the renderer's colors
// cannot drift from what the runner resolves. Theme colors stay renderer-side
// — lib is pi-runtime-free — but the key set is the exact union, so the map
// is total and needs no fallback.
const RESEARCH_STATUS_COLORS: Record<ResearchStatusDetails["status"] | "unknown", ThemeColor> = {
  succeeded: "success",
  failed: "error",
  terminated: "warning",
  aborted: "dim",
  unknown: "dim",
};

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

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
 * The icon + agent (source) header row shared by both renderResult branches.
 * The theme shape is structural: the real pi Theme is an internal deep import
 * the extension must not reach into, so the helper only needs the two styling
 * methods both branches use identically.
 */
function renderAgentRow(
  theme: { fg(color: ThemeColor, text: string): string; bold(text: string): string },
  icon: string,
  agent: string,
  source: AgentSource,
): string {
  return `${icon} ${theme.fg("toolTitle", theme.bold(agent))}${theme.fg("muted", ` (${source})`)}`;
}

/** The indented, 10-line-capped body text shared by both renderResult branches. */
function renderIndentedBody(text: string): string {
  return text.split("\n").slice(0, 10).map((l) => `  ${l}`).join("\n");
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

interface DispatchDefaults {
  model?: string;
  thinkingLevel?: string;
  thinkingOverride?: string;
  /** Parent session id threaded to the spawn env (subagent marker). */
  parentSessionId?: string;
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
  onProgress: (partial: SingleResult) => void,
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
    let accumulated: SingleResult | undefined;

    // The protocol accumulator (src/blocking-protocol.ts) owns the child's
    // JSON-lines protocol and usage accounting; this adapter owns only the
    // process lifecycle: spawn, stdio wiring, abort escalation, exitCode patch.
    const exitCode = await new Promise<number>((resolve) => {
      const acc = createResultAccumulator({
        agent: agentName,
        agentSource: agent.source,
        task,
        step,
        model,
        thinkingLevel: thinking,
        onProgress,
      });
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd: cwd ?? defaultCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        // Per-spawn injection, so nested subagents each name their immediate
        // parent (buildSubagentEnv, lib.ts). Pure announcement.
        env: buildSubagentEnv(process.env, dispatchDefaults.parentSessionId),
      });

      proc.stdout.on("data", (data) => acc.onStdout(data.toString()));
      proc.stderr.on("data", (data) => acc.onStderr(data.toString()));

      proc.on("close", (code) => {
        // The close handler flushes any pending partial line, like the old
        // inline buffer.
        accumulated = acc.finish();
        resolve(code ?? 0);
      });

      proc.on("error", () => {
        // Spawn failure: Node emits error then close; finish is idempotent so
        // the second call is a no-op.
        accumulated = acc.finish();
        resolve(1);
      });

      if (signal) {
        const escalation = escalateKill(proc);
        const onAbort = () => {
          wasAborted = true;
          escalation.send();
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
        // Exit within grace cancels the SIGKILL backstop.
        proc.on("close", () => escalation.dispose());
      }
    });

    const currentResult = accumulated as SingleResult;
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
  // Footer sync rides the registry's onChange hook: every mutation re-counts
  // active runs, so no caller has to remember to refresh the footer (this
  // replaced the 16 scattered updateSubagentFooter call sites).
  let footerUi: SubagentsUi | undefined;
  const subagentRuns = createRunRegistry(Date.now, () => {
    if (footerUi?.hasUI) updateSubagentFooter(footerUi, subagentRuns);
  });
  // ADR 0013 — per-run AbortController backing /subagents kill: aborting it
  // aborts the in-process child session; the runner resolves the run `aborted`
  // and pushes the outcome (no OS signals, no pid reuse hazard).
  const researchAborts = new Map<string, AbortController>();
  // Registry update that tolerates the already-terminal race: the first
  // terminal status wins, and a late backfill (logPath) can race the push, so
  // a frozen-update error must never surface as a tool error.
  const updateRun = (runId: string, patch: RunPatch) => {
    try {
      subagentRuns.update(runId, patch);
    } catch {
      /* run already terminal (frozen elsewhere) — the first terminal wins */
    }
  };

  pi.on("session_shutdown", () => {
    // Drop the cached tool context first: the footer hook it feeds lives on a
    // UI that may already be tearing down, and a throw from its onChange
    // callback inside clear() would skip the child-session disposal below.
    // At teardown there is no footer left to keep in sync (story 7's
    // convergence only applies to a live session).
    footerUi = undefined;
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
    // `Partial` because the renderer must tolerate malformed messages; the
    // status stays on the frozen terminal union (plus an explicit `unknown`
    // sentinel) instead of re-widening to `string`.
    const details = message.details as Partial<ResearchStatusDetails> | undefined;
    const status: ResearchStatusDetails["status"] | "unknown" = details?.status ?? "unknown";
    // Reuse the frozen icon map from lib (single source for status icons);
    // colors come from the sibling RESEARCH_STATUS_COLORS map, not a cascade.
    const icon = status === "unknown" ? "?" : RUN_STATUS_ICONS[status];
    const color = RESEARCH_STATUS_COLORS[status];
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
        const tail = lastOutputLine(readLogTail(r.logPath));
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
      footerUi = ctx as SubagentsUi;
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
      footerUi = ctx as SubagentsUi;
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
        parentSessionId: ctx.sessionManager.getSessionId(),
      };
      const discovery = discoverAgents(ctx.cwd, getAgentDir(), CONFIG_DIR_NAME, agentScope, parseAgentFrontmatter);
      const agents = discovery.agents;

      const hasChain = (merged.chain?.length ?? 0) > 0;
      const hasTasks = (merged.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(merged.agent && merged.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
      const mode: "single" | "parallel" | "chain" = hasChain ? "chain" : hasTasks ? "parallel" : "single";
      // The empty-details shape every not-completed branch returns (ADR 0016:
      // an error result has no runs; a payload only when a run failed/aborted).
      const noRunDetails: SubagentDetails = { mode, results: [] };

      if (modeCount !== 1) {
        const available = formatAgentList(agents);
        // ADR 0016 (3b) — a call that did not complete is an error result, not
        // a success-marked text reply; the recovery text stays byte-identical.
        return {
          content: [
            { type: "text", text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}` },
          ],
          details: noRunDetails,
          isError: true,
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
        // ADR 0016 (3b) — a refused run is a not-completed call: error-marked,
        // content unchanged (no registry entry exists, so no error payload).
        return {
          content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
          details: noRunDetails,
          isError: true,
        };
      }

      const plan: BlockingPlan = hasChain
        ? { mode: "chain", steps: merged.chain! }
        : hasTasks
          ? { mode: "parallel", tasks: merged.tasks! }
          : { mode: "single", agent: merged.agent!, task: merged.task!, cwd: merged.cwd };

      const runner: RunnerSeam = {
        runTask(task, opts) {
          return runSingleAgent(
            ctx.cwd,
            dispatchDefaults,
            agents,
            { agentName: task.agentName, task: task.task, cwd: task.cwd, step: task.step },
            opts.signal,
            opts.onProgress,
            availableToolNames,
          );
        },
      };

      // ADR 0016 — the conversion point (decided Q1=A): the orchestrator
      // keeps throwing its tool error internally (its tests pin that
      // contract); this boundary converts any throw into an error-marked
      // result whose content is the thrown message byte-identical. The
      // details carry the failed run's terminal info from the registry — only
      // runs this call registered (the snapshot base index isolates the delta)
      // and that ended failed/aborted, via the pure toolErrorDetails helper.
      // A throw that is not a run failure (e.g. an internal bug) yields no
      // payload, exactly like the harness's old throw-derived error result.
      const sinceIndex = subagentRuns.snapshot().length;
      let blockingResult: { text: string; details: SubagentDetails };
      try {
        blockingResult = await runBlockingPlan({
          plan,
          runner,
          registry: subagentRuns,
          agents,
          signal,
          onToolUpdate: (text, details) => {
            onUpdate?.({ content: [{ type: "text", text }], details });
          },
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text }],
          details: { ...noRunDetails, error: toolErrorDetails(subagentRuns.snapshot(), sinceIndex) },
          isError: true,
        };
      }
      return { content: [{ type: "text", text: blockingResult.text }], details: blockingResult.details };
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
      if (details?.error) {
        // ADR 0016 (decided Q2=b) — the error row: icon + agent (source) +
        // the thrown message + usage/model/thinking, so a failed run is
        // legible from the transcript without opening /subagents. Aborted
        // keeps the registry's distinct iconography (⊘); a plain failure
        // renders the tool-error ✗.
        const lines: string[] = [];
        const icon = details.error.status === "aborted" ? "⊘" : "✗";
        lines.push(renderAgentRow(theme, icon, details.error.agent, details.error.agentSource));
        if (first?.type === "text" && first.text) lines.push(renderIndentedBody(first.text));
        if (details.error.usage) {
          const u = formatUsageLine(details.error.usage, {
            model: details.error.model,
            thinking: details.error.thinkingLevel,
            showContext: true,
          });
          if (u) lines.push(`  ${theme.fg("dim", u)}`);
        }
        return new Text(lines.join("\n"), 0, 0);
      }
      if (!details || details.results.length === 0) {
        return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
      }

      const lines: string[] = [];
      for (const r of details.results) {
        const icon = r.running ? "⏳" : isToolError(r) ? "✗" : "✓";
        lines.push(renderAgentRow(theme, icon, r.agent, r.agentSource));
        const out = getResultOutput(r);
        if (r.running) {
          lines.push("  (running...)");
        } else if (out && out !== "(no output)") {
          lines.push(renderIndentedBody(out));
        }
        const u = formatUsageLine(r.usage, { model: r.model, thinking: r.thinkingLevel, showContext: true });
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
      footerUi = ctx as SubagentsUi;
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

      let handle: ResearchHandle;
      try {
        handle = runBackgroundResearch(
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
              updateRun(runId, { status: info.status, lastOutput: lastOutput || undefined });
              pi.sendMessage(
                {
                  customType: RESEARCH_STATUS_CUSTOM_TYPE,
                  content: researchStatusContent(info.status, findingsPath, handle.logPath),
                  display: true,
                  details: {
                    status: info.status,
                    findingsPath,
                    logPath: handle.logPath,
                    lastOutput,
                  } satisfies ResearchStatusDetails,
                },
                { deliverAs: "followUp", triggerTurn: true },
              );
            },
          },
          (childOpts) => createResearchChildSession(childOpts),
        );
      } catch (err) {
        // A runner-level failure after the run was registered (e.g. the tmp
        // dir could not be created) must not leave a `running` registry entry
        // or a leaked abort handle: settle the run failed and release the
        // controller before the error escapes to the harness. No push here —
        // the run never started, and the thrown tool error is the model's
        // signal (ADR 0010).
        researchAborts.delete(runId);
        updateRun(runId, { status: "failed" });
        throw err;
      }
      // logPath is only known after the runner allocates its tmp dir; the run
      // may already be terminal, and a frozen-update error must not surface as
      // a tool error.
      updateRun(runId, { logPath: handle.logPath });

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
