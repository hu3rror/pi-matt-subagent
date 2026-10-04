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
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
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
  buildResearchFullParams,
  configToLimits,
  CONFIG_FILE_NAME,
  CONFIG_KEYS,
  configKeyLabel,
  configKeySpec,
  defaultConfig,
  discoverAgents,
  effectiveResearchChildExtensions,
  emptyUsage,
  formatConfigOverview,
  formatRunSnapshot,
  getPiInvocation,
  isActiveRunStatus,
  isTerminalRunStatus,
  mergeToolParams,
  omitConfigKey,
  parseConfigFile,
  parseConfigSetValue,
  parseSubagentsArgs,
  packageNameOfSpec,
  pathIsInsidePackage,
  planRunThinking,
  readLogTail,
  researchStatusContent,
  RESEARCH_RESULT_SCHEMA,
  RESEARCH_TOOL_DESCRIPTION,
  RESEARCH_TOOL_PARAMS,
  resolveDispatchThinking,
  runBackgroundResearch,
  RUN_STATUS_ICONS,
  scopeAllowsProject,
  serializeConfig,
  setConfigValue,
  splitModelRef,
  SUBAGENT_FULL_PARAMS,
  SUBAGENT_TOOL_DESCRIPTION,
  SUBAGENT_TOOL_PARAMS,
  THINKING_LEVELS,
  type AgentConfig,
  type AgentScope,
  type AgentSource,
  type AgentFrontmatter,
  type ConfigKey,
  type ConfigStatus,
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
  toolErrorMessage,
} from "../src/lib.ts";

import {
  firstInvalidPlanThinkingLevel,
  runBlockingPlan,
  type BlockingPlan,
  type RunnerSeam,
  type RunnerTask,
  type SubagentDetails,
} from "../src/blocking-runner.ts";

const parseAgentFrontmatter: FrontmatterParser = (content) => parseFrontmatter<AgentFrontmatter>(content);

// ---------------------------------------------------------------------------
// In-process research child (ADR 0013, revised by issue #37)
//   The real `createChildSession` factory wired into `runBackgroundResearch`:
//   an in-process second session (`createAgentSession` +
//   `SessionManager.inMemory()`) built with `systemPromptOverride`. The child's
//   extension loadout is curated: it loads exactly the approved query packages
//   (`researchChildExtensions`, issue #37) via an `extensionsOverride` filter;
//   only a caller that passes no extension list gets the legacy
//   `noExtensions: true` child. Anti-recursion is structural either way —
//   subagent/research (this extension) never match the knob, so no recursive
//   extension re-entry. The async body is wrapped in try/catch; every session
//   is tracked here so `session_shutdown` disposes any that outlive their runs
//   (session-scoped research lifetime).
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
  /** The extension packages to load into the child (knob value); undefined keeps the legacy fully-disabled child. */
  extensions?: string[];
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
      // issue #37 — a curated child loadout: an `extensions` list (the knob's
      // packages) filters the base's loaded extensions to exactly those
      // packages, so the child carries built-ins + the approved query tools
      // and nothing else (ADR 0013's anti-recursion property survives: the
      // extension's own subagent/research never match the knob). An undefined
      // value keeps the legacy noExtensions:true child. Uninstalled packages
      // simply never appear in the base's extensions, so the filter drops
      // them harmlessly (the drift report surfaces the consequence).
      const knob = opts.extensions;
      const loader = new DefaultResourceLoader({
        cwd: opts.cwd,
        agentDir: getAgentDir(),
        noExtensions: knob === undefined,
        ...(knob !== undefined
          ? {
              extensionsOverride: (base) => ({
                ...base,
                extensions: base.extensions.filter((e) =>
                  knob.some((k) => pathIsInsidePackage(e.sourceInfo.path, packageNameOfSpec(k))),
                ),
              }),
            }
          : {}),
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
      // issue #37 — a loadout self-report as the child's FIRST output line(s):
      // the knob-package tools actually registered, and any allowlist names
      // missing from the loadout. Tee'd into the per-run log before the
      // session ever prompts, so a loadout regression (a package that no
      // longer loads, a renamed/retired tool) surfaces at start time instead
      // of as model-side tool-not-found loops.
      if (knob && knob.length > 0) {
        const knobTools = session
          .getAllTools()
          .filter((t) => knob.some((k) => pathIsInsidePackage(t.sourceInfo.path, packageNameOfSpec(k))))
          .map((t) => t.name);
        if (knobTools.length > 0) {
          pushChunk(`[child-loadout] knob packages registered: ${knobTools.join(", ")}\n`);
        } else {
          pushChunk(
            "[child-loadout] NO knob packages registered — check that researchChildExtensions packages are installed and named correctly\n",
          );
        }
      }
      const childAll = new Set(session.getAllTools().map((t) => t.name));
      const missing = (opts.tools ?? []).filter((t) => !childAll.has(t));
      if (missing.length > 0) {
        pushChunk(`[child-loadout] allowlist missing from loadout: ${missing.join(", ")}\n`);
      }
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

/** The indented dim usage line shared by the error row and the success rows. */
function renderUsageLine(
  theme: { fg(color: ThemeColor, text: string): string },
  usage: UsageStats,
  opts: { model?: string; thinking?: string; requestedThinking?: string },
): string | undefined {
  const u = formatUsageLine(usage, { ...opts, showContext: true });
  return u ? `  ${theme.fg("dim", u)}` : undefined;
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
 * Probes the tool set a research child can actually call (issue #37) — the
 * built-ins plus the tools whose extension source is one of the knob's
 * packages — NOT the main session's full registry (the incident root cause:
 * the child had no web tools while the parent did). Tools are matched by
 * their install path (`node_modules/<pkg>`; the same predicate the child
 * loader's filter uses, so probe and loadout cannot drift); a tool's
 * `sourceInfo` is the same object as its extension's, and built-ins all
 * carry `source === "builtin"`. Off-win32, powershell is registered but not
 * callable (pi's implementation throws), so it is excluded here too. An
 * empty knob (network off) reduces the probe to built-ins. Also reports the
 * knob packages for which NOTHING registered — a mistyped or uninstalled
 * package stays silent when no role declares its tools, so the caller warns.
 */
function probeResearchChildTools(
  pi: ExtensionAPI,
  knob: string[],
): { names: ReadonlySet<string>; packagesNotLoaded: string[] } {
  const names = new Set<string>();
  const packagesHit = new Set<string>();
  for (const t of pi.getAllTools()) {
    if (t.sourceInfo?.source === "builtin") {
      names.add(t.name);
      continue;
    }
    const path = t.sourceInfo?.path ?? "";
    for (const k of knob) {
      if (pathIsInsidePackage(path, packageNameOfSpec(k))) {
        packagesHit.add(packageNameOfSpec(k));
        names.add(t.name);
        break;
      }
    }
  }
  if (process.platform !== "win32") names.delete("powershell");
  return {
    names,
    packagesNotLoaded: [...new Set(knob.map(packageNameOfSpec).filter((p) => !packagesHit.has(p)))],
  };
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
  /** Extension-config default thinking level (ADR 0018): sits between the role and the main-session level. */
  configLevel?: string;
  /** Parent session id threaded to the spawn env (subagent marker). */
  parentSessionId?: string;
}

/**
 * Binds a resolved Model to pi's model-capability clamp; only ever called
 * with a resolved model, so an unresolvable ref never fabricates an effective
 * level (the run then stays on its requested value — ADR 0018).
 */
const clampForModel = (model: Model<any>) => (level: string): string =>
  clampThinkingLevel(model, level as ModelThinkingLevel);

/**
 * Turns a model registry into the ref→Model resolver both tools share
 * (blocking pre-clamp and the research child). A bare id has no provider
 * side, so it resolves to undefined — the caller decides what that means:
 * blocking skips the pre-clamp, research keeps its loud unknown-model error.
 */
const makeModelResolver =
  (registry: { find: (provider: string, id: string) => Model<any> | undefined }) =>
  (ref: string): Model<any> | undefined => {
    const { provider, id } = splitModelRef(ref);
    return provider && id ? registry.find(provider, id) : undefined;
  };

/**
 * Plans one run's thinking pair (ADR 0018 clamp transparency): only a
 * resolved model clamps; otherwise the request passes through unchanged and
 * nothing extra is recorded.
 */
const planForRun = (requested: string | undefined, model: Model<any> | undefined) => {
  const planned = model ? planRunThinking(requested, clampForModel(model)) : undefined;
  return { effective: planned?.actual ?? requested, requested: planned?.requested };
};

// ---------------------------------------------------------------------------
// Blocking runner
// ---------------------------------------------------------------------------

async function runSingleAgent(
  defaultCwd: string,
  dispatchDefaults: DispatchDefaults,
  agents: AgentConfig[],
  agentTask: RunnerTask,
  signal: AbortSignal | undefined,
  onProgress: (partial: SingleResult) => void,
  availableToolNames: ReadonlySet<string>,
  resolveModel: (ref: string) => Model<any> | undefined,
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
  const requested = resolveDispatchThinking(agent, dispatchDefaults, agentTask.thinkingLevel);
  const resolvedModel = model ? resolveModel(model) : undefined;
  const { effective: thinking, requested: requestedThinking } = planForRun(requested, resolvedModel);

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
        requestedThinking,
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
  // Configured/logged-in models (provider/id) snapshotted on session start so
  // `/subagents` autocomplete and the model picker list only models whose
  // provider has working credentials — the same source pi's own /model uses.
  let availableModels: { ref: string; provider: string }[] = [];

  pi.on("session_start", (_event, ctx) => {
    availableModels = ctx.modelRegistry.getAvailable().map((m) => ({ ref: `${m.provider}/${m.id}`, provider: m.provider }));
  });
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
      input(title: string, placeholder?: string): Promise<string | undefined>;
      notify(message: string, type?: "info" | "warning" | "error"): void;
      setStatus(key: string, text: string | undefined): void;
    };
  };

  const MENU_SNAPSHOT = "View runs";
  const MENU_STOP = "Stop run…";
  const MENU_CLEAR = "Clear finished";
  const MENU_SHOW_LOG = "Show log…";
  const MENU_SETTINGS = "Settings…";

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
    const tail = readLogTail(run.logPath, readConfigStatus().effective.logTailBytes);
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

  // -------------------------------------------------------------------------
  // Extension config surface (ADR 0018). Lazy creation: reading never writes;
  // only `set`/`reset` creates the file. Every handler re-reads the file so a
  // change applies to the next dispatch without /reload.
  // -------------------------------------------------------------------------
  const configPath = () => path.join(getAgentDir(), "extensions", CONFIG_FILE_NAME);
  const configFileExists = () => fs.existsSync(configPath());
  const readConfigStatus = (): ConfigStatus => {
    const p = configPath();
    return parseConfigFile(configFileExists() ? fs.readFileSync(p, "utf8") : undefined);
  };
  const writeConfig = async (content: string) => {
    const p = configPath();
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    await withFileMutationQueue(p, async () => {
      fs.writeFileSync(p, content, "utf8");
    });
  };
  const showConfig = (ctx: SubagentsUi) => {
    const p = configPath();
    ctx.ui.notify(formatConfigOverview(readConfigStatus(), p, configFileExists()), "info");
  };
  const setConfig = async (ctx: SubagentsUi, key: ConfigKey, value: string) => {
    const parsed = parseConfigSetValue(key, value);
    if (!parsed.ok) {
      ctx.ui.notify(parsed.reason, "error");
      return;
    }
    const next = setConfigValue(readConfigStatus().effective, key, parsed.value);
    await writeConfig(serializeConfig(next));
    ctx.ui.notify(`config set ${key} \u2192 ${configKeyLabel(key, readConfigStatus())}`, "info");
  };
  const resetConfig = async (ctx: SubagentsUi) => {
    await writeConfig(serializeConfig(defaultConfig()));
    ctx.ui.notify("config reset: all values back to built-in defaults", "info");
    showConfig(ctx);
  };
  // Per-key reset removes just that knob from the file (unknown keys from
  // newer versions survive); the read-back falls to default/inherit, so the
  // view labels it [default]. A missing file stays untouched (no write =
  // no lazy creation).
  const resetConfigKey = async (ctx: SubagentsUi, key: ConfigKey) => {
    const p = configPath();
    if (!configFileExists()) {
      ctx.ui.notify(`config reset ${key}: already at default`, "info");
      return;
    }
    const next = omitConfigKey(fs.readFileSync(p, "utf8"), key);
    if (next === undefined) {
      ctx.ui.notify("config file is not valid JSON; use `config reset` to rebuild it", "error");
      return;
    }
    await writeConfig(next);
    ctx.ui.notify(`config reset ${key} → ${configKeyLabel(key, readConfigStatus())}`, "info");
  };
  const configMenu = async (ctx: SubagentsUi) => {
    const opts: string[] = CONFIG_KEYS.map((k) => configKeyLabel(k, readConfigStatus()));
    const MENU_CONFIG_RESET = "Reset all to defaults";
    const MENU_CONFIG_BACK = "\u2190 Back";
    const choice = await ctx.ui.select("Subagents config", [...opts, MENU_CONFIG_RESET, MENU_CONFIG_BACK]);
    if (!choice || choice === MENU_CONFIG_BACK) return;
    if (choice === MENU_CONFIG_RESET) {
      if (ctx.hasUI && !(await ctx.ui.confirm("Reset config?", "Restore every key to its built-in default?"))) return;
      return resetConfig(ctx);
    }
    const key = CONFIG_KEYS.find((k) => choice.startsWith(`${k} =`));
    if (!key) return;
    // Per-key actions: setting enters the kind-driven input below; resetting
    // drops just this knob back to default/inherit.
    const MENU_CONFIG_SET = "Set value…";
    const MENU_CONFIG_RESET_KEY = "Reset to default";
    const action = await ctx.ui.select(`${key}`, [MENU_CONFIG_SET, MENU_CONFIG_RESET_KEY, MENU_CONFIG_BACK]);
    if (!action || action === MENU_CONFIG_BACK) return;
    if (action === MENU_CONFIG_RESET_KEY) return resetConfigKey(ctx, key);
    // Set value…: the per-key spec drives the input — level → enum select,
    // model → pi model registry picker (text fallback), number → free text.
    const spec = configKeySpec(key);
    if (spec?.kind === "level") {
      const sel = await ctx.ui.select(`${key}`, [...THINKING_LEVELS, "inherit (clear)"]);
      if (sel === undefined) return;
      return setConfig(ctx, key, sel === "inherit (clear)" ? "inherit" : sel);
    }
    if (spec?.kind === "model") {
      const refs = availableModels.map((m) => m.ref);
      if (refs.length > 0) {
        const sel = await ctx.ui.select(`${key}`, [...refs, "inherit (clear)"]);
        if (sel === undefined) return;
        return setConfig(ctx, key, sel === "inherit (clear)" ? "inherit" : sel);
      }
    }
    const raw = await ctx.ui.input(`${key}`, "new value (inherit clears the dispatch knobs)");
    if (raw === undefined) return;
    setConfig(ctx, key, raw);
  };

  const openMenu = async (ctx: SubagentsUi) => {
    const choice = await ctx.ui.select("Subagent runs", [
      MENU_SNAPSHOT,
      MENU_STOP,
      MENU_CLEAR,
      MENU_SHOW_LOG,
      MENU_SETTINGS,
    ]);
    if (!choice) return;
    if (choice === MENU_SETTINGS) return configMenu(ctx);
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
      "List and manage tracked subagent runs: no args opens the menu; snapshot, kill <id>, tail <id>, prune, config [set <key> <value>|reset] run directly",
    getArgumentCompletions(argumentPrefix) {
      // pi replaces the whole argument text (everything after `/subagents`)
      // with `value`. The cursor sits either mid-token (no trailing space, the
      // last token is being typed) or after a space (the next token is fresh),
      // so keep that distinction: it decides whether the last token filters
      // the current candidates or is already settled.
      const text = argumentPrefix ?? "";
      const trailingSpace = /\s$/.test(text);
      const tokens = text.trim().split(/\s+/).filter(Boolean);
      const editIndex = trailingSpace ? tokens.length : tokens.length - 1;
      const fixed = tokens.slice(0, editIndex);
      const partial = trailingSpace ? "" : (tokens[editIndex] ?? "");
      const match = (arr: string[]) => (partial === "" ? arr : arr.filter((s) => s.startsWith(partial)));
      const suggest = (value: string, label: string) => ({ value, label });

      const VERBS = ["snapshot", "kill", "tail", "prune", "config"];
      const SUB_VERBS = ["show", "set", "reset"];

      let suggestions: Array<{ value: string; label: string; description?: string }> = [];
      if (fixed.length === 0) {
        // Verb position: an empty or partial token trims against the five
        // verbs; a fully typed "config" (with or without trailing space)
        // moves on to its sub-verbs instead of re-suggesting itself.
        if (partial === "config") {
          suggestions = SUB_VERBS.map((v) => suggest(`config ${v}`, v));
        } else {
          suggestions = match(VERBS).map((v) => suggest(v, v));
        }
      } else if (fixed[0] === "config") {
        if (fixed.length === 1) {
          suggestions = match(SUB_VERBS).map((v) => suggest(`config ${v}`, v));
        } else if (fixed.length === 2 && (fixed[1] === "set" || fixed[1] === "reset")) {
          suggestions = match([...CONFIG_KEYS]).map((k) => suggest(`config ${fixed[1]} ${k}`, k));
        } else if (fixed.length === 3 && fixed[1] === "set") {
          const key = fixed[2] as ConfigKey;
          const spec = (CONFIG_KEYS as readonly string[]).includes(key) ? configKeySpec(key) : undefined;
          if (spec?.kind === "model") {
            const items = availableModels
              .filter((m) => m.ref.startsWith(partial))
              .map((m) => ({
                value: `config set ${key} ${m.ref}`,
                label: m.ref,
                description: `provider: ${m.provider}`,
              }));
            return items.length > 0 ? items : null;
          }
          if (spec?.kind === "level") {
            suggestions = THINKING_LEVELS.filter((l) => l.startsWith(partial)).map((l) =>
              suggest(`config set ${key} ${l}`, l),
            );
          }
        }
      } else if (fixed[0] === "kill" || fixed[0] === "tail") {
        const ids = match(subagentRuns.snapshot().map((r) => r.id));
        suggestions = ids.map((id) => suggest(`${fixed[0]} ${id}`, id));
      }
      return suggestions.length > 0 ? suggestions : null;
    },
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
      if (cmd.action === "config") {
        if (cmd.verb === "show") return showConfig(ctx);
        if (cmd.verb === "reset") return cmd.key ? resetConfigKey(ctx, cmd.key) : resetConfig(ctx);
        return setConfig(ctx, cmd.key, cmd.value);
      }
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
      // Model resolution for pre-clamp (ADR 0018): a provider/id string any
      // source produced → Model object; unresolvable stays undefined so the
      // child's existing loud unknown-model error is preserved untouched.
      const resolveSubagentModel = makeModelResolver(ctx.modelRegistry);
      // Extension config (ADR 0018): read once per call, reused for this run.
      const config = readConfigStatus().effective;
      const dispatchDefaults: DispatchDefaults = {
        // Model: a role-declared model pins the run (kept); otherwise the
        // default chain is per-call override > config default > inherited
        // session model. Thinking is resolved separately (config layer).
        model: merged.model ?? (config.dispatchDefaultModel ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined)),
        thinkingLevel: ctx.thinkingLevel,
        // input.thinkingOverride is the canonical per-run override field; the
        // public `thinkingLevel` param maps to the same slot (ADR 0011).
        thinkingOverride: merged.thinkingOverride ?? merged.thinkingLevel,
        configLevel: config.dispatchDefaultThinkingLevel,
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

      const plan: BlockingPlan = hasChain
        ? { mode: "chain", steps: merged.chain! }
        : hasTasks
          ? { mode: "parallel", tasks: merged.tasks! }
          : { mode: "single", agent: merged.agent!, task: merged.task!, cwd: merged.cwd };

      // ADR 0020 — a bad per-task/per-step thinkingLevel fails loudly here,
      // before any agent-confirm prompt or run registers (see the validator's
      // JSDoc in blocking-runner.ts for the pass-through rationale).
      const badLevel = firstInvalidPlanThinkingLevel(plan);
      if (badLevel) {
        const kind = mode === "chain" ? "steps" : "tasks";
        return {
          content: [
            {
              type: "text",
              text:
                `Invalid thinkingLevel on ${kind}[${badLevel.index}]: ${JSON.stringify(badLevel.value)}. ` +
                `Must be one of: ${THINKING_LEVELS.join(", ")}.`,
            },
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

      const runner: RunnerSeam = {
        runTask(task, opts) {
          return runSingleAgent(
            ctx.cwd,
            dispatchDefaults,
            agents,
            {
              agentName: task.agentName,
              task: task.task,
              cwd: task.cwd,
              step: task.step,
              thinkingLevel: task.thinkingLevel,
            },
            opts.signal,
            opts.onProgress,
            availableToolNames,
            resolveSubagentModel,
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
          limits: configToLimits(config),
          onToolUpdate: (text, details) => {
            onUpdate?.({ content: [{ type: "text", text }], details });
          },
        });
      } catch (err) {
        const text = toolErrorMessage(err);
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
          const u = renderUsageLine(theme, details.error.usage, {
            model: details.error.model,
            thinking: details.error.thinkingLevel,
            requestedThinking: details.error.requestedThinking,
          });
          if (u) lines.push(u);
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
        const u = renderUsageLine(theme, r.usage, {
          model: r.model,
          thinking: r.thinkingLevel,
          requestedThinking: r.requestedThinking,
        });
        if (u) lines.push(u);
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
    // ADR 0017 — the machine-readable receipt shape for successful calls:
    // codemode scripts receive `structuredContent` instead of the text
    // content; the provider layer never serializes this schema, so the
    // model-facing token surface is unchanged.
    outputSchema: RESEARCH_RESULT_SCHEMA,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      footerUi = ctx as SubagentsUi;
      const { input, ...directParams } = params;
      // Extension config (ADR 0018): the wall-clock ceiling is the schema
      // maximum too, so raising the config immediately lets a run request it.
      const config = readConfigStatus().effective;
      const merged = mergeToolParams<typeof directParams, { model?: string; maxWallClockMs?: number }>({
        direct: directParams,
        input,
        fullSchema: buildResearchFullParams(config.researchWallClockMs),
      });
      const agentScope: AgentScope = merged.agentScope ?? "user";
      // issue #37 — the research child loads exactly the knob's extension
      // packages (effectiveResearchChildExtensions), so its callable tool set
      // is build-ins ∪ knob-package tools, probed as such instead of the main
      // session's full registry (the incident root cause). The same knob
      // reaches the child factory, so probe and loadout cannot drift.
      const knob = effectiveResearchChildExtensions(config);
      const probe = probeResearchChildTools(pi, knob);
      const availableToolNames = probe.names;
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
        // ADR 0016/0017 (3b) — a refused run is a not-completed call:
        // error-marked, content unchanged (no run is registered, so the
        // result carries no receipt and no details).
        return {
          content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
          details: undefined,
          isError: true,
        };
      }

      const researcher = agents.find((a) => a.name === "researcher");

      // The in-process child needs a Model object, not a provider/id string.
      // Precedence: per-call `model` override > role-declared researcher model >
      // config default > inherited main session model. An unresolvable override
      // (any source) fails loudly.
      const resolveSubagentModel = makeModelResolver(ctx.modelRegistry);
      let childModel: Model<any> | undefined = ctx.model;
      const rawModel = merged.model ?? researcher?.model ?? config.dispatchDefaultModel;
      if (rawModel) {
        const found = resolveSubagentModel(rawModel);
        if (!found) {
          // ADR 0016/0017 (3b) — an unresolvable model override is a
          // not-completed call: error-marked, content unchanged (no run is
          // registered, so no receipt and no details).
          return {
            content: [{ type: "text", text: `Unknown model override: ${rawModel}` }],
            details: undefined,
            isError: true,
          };
        }
        childModel = found;
      }

      const requested = resolveDispatchThinking(researcher, {
        thinkingLevel: ctx.thinkingLevel,
        thinkingOverride: merged.thinkingLevel,
        configLevel: config.dispatchDefaultThinkingLevel,
      });
      const { effective: thinking, requested: requestedThinking } = planForRun(requested, childModel);

      const runId = subagentRuns.register({
        role: "researcher",
        source: researcher?.source ?? "embedded",
        channel: "background",
        status: "running",
        startedAt: Date.now(),
        model: childModel ? `${childModel.provider}/${childModel.id}` : undefined,
        thinkingLevel: thinking,
        requestedThinking,
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
            maxWallClockMs: merged.maxWallClockMs ?? config.researchWallClockMs,
            availableToolNames,
            agents,
            extensions: knob,
            abortSignal: abortController.signal,
            // Fires exactly once at a terminal state: settle the registry entry
            // and push the outcome into the main context — content worded as an
            // instruction to read the findings file (ADR 0013).
            onExit: (info) => {
              researchAborts.delete(runId);
              const lastOutput = readLogTail(handle.logPath);
              updateRun(runId, { status: info.status, lastOutput: lastOutput || undefined });
              // A short-lived process can tear the session context down while
              // the researcher is still finishing: the terminal push then
              // throws the stale-context error, which inside the runner's
              // promise chain surfaces as an unhandled rejection that crashes
              // the process (observed in the scripted-run repro, #32). The
              // registry entry is already settled above, so only the push is
              // lost — swallow just that stale error; anything else stays
              // loud.
              try {
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
              } catch (err) {
                if (!(err instanceof Error && err.message.includes("stale"))) throw err;
              }
            },
          },
          (childOpts) => createResearchChildSession(childOpts),
        );
      } catch (err) {
        // A runner-level failure after the run was registered (e.g. the tmp
        // dir could not be created) must not leave a `running` registry entry
        // or a leaked abort handle: settle the run failed and release the
        // controller first. The run never started, so nothing is pushed (it
        // has no log); the not-completed call returns an error-marked result
        // whose content is the runner error's message — the same text the
        // harness derived from the former throw (ADR 0016/0017).
        researchAborts.delete(runId);
        updateRun(runId, { status: "failed" });
        return {
          content: [{ type: "text", text: toolErrorMessage(err) }],
          details: undefined,
          isError: true,
        };
      }
      // logPath is only known after the runner allocates its tmp dir; the run
      // may already be terminal, and a frozen-update error must not surface as
      // a tool error.
      updateRun(runId, { logPath: handle.logPath });

      const driftNote =
        handle.droppedTools && handle.droppedTools.length > 0
          ? `\n\n⚠ Declared but not loaded: ${handle.droppedTools.join(
              ", ",
            )}. Install the extension package, point 'researchChildExtensions' at it, or remove the tool from the role/call.`
          : "";
      const unloadedNote =
        probe.packagesNotLoaded.length > 0
          ? `\n⚠ Query packages in 'researchChildExtensions' registered nothing: ${probe.packagesNotLoaded.join(
              ", ",
            )}. Check they are installed and the names match the installed packages exactly.`
          : "";
      return {
        content: [
          {
            type: "text",
            text:
              `Research started (id: ${handle.researchId}). It is running in the background; ` +
              `findings will be written to: ${findingsPath}\n` +
              `Log: ${handle.logPath}\n\n` +
              `Keep working. The completion (succeeded / failed / terminated / aborted) is pushed to you — no polling needed.` +
              driftNote +
              unloadedNote,
          },
        ],
        details: handle,
        // ADR 0017 — the machine-readable receipt mirrors the handle exactly
        // (the same object as `details`), so codemode consumers get a
        // structured receipt without parsing the text. Error-marked branches
        // never carry one.
        structuredContent: { ...handle },
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
