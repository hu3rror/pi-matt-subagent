import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendResearchTerminatedMarker,
  blockingRunStatus,
  buildResearchPrompt,
  buildSubagentEnv,
  createRunRegistry,
  DEFAULT_RESEARCH_WALL_CLOCK_MS,
  discoverAgents,
  emptyUsage,
  estimateToolSurfaceTokens,
  formatBlockingToolError,
  formatRunSnapshot,
  mergeToolParams,
  parseSubagentsArgs,
  readLogTail,
  researchStatusContent,
  RESEARCH_FULL_PARAMS,
  RESEARCH_INPUT_KEYS,
  RESEARCH_TOOL_DESCRIPTION,
  RESEARCH_TOOL_PARAMS,
  resolveRole,
  resolveThinkingLevel,
  resolveTools,
  runBackgroundResearch,
  RUN_STATUS_ICONS,
  RUN_STATUSES,
  scopeAllowsProject,
  SUBAGENT_FULL_PARAMS,
  SUBAGENT_INPUT_KEYS,
  SUBAGENT_PARENT_SESSION_ENV,
  SUBAGENT_TOOL_DESCRIPTION,
  SUBAGENT_TOOL_PARAMS,
  TERMINAL_RUN_STATUSES,
  TOKEN_GUARD_MULTIPLIER,
  TOOL_ALIASES,
  TOOL_CONTRACTS,
  type AgentConfig,
  type FrontmatterParser,
  type LogTailFs,
  type ResearchChildSession,
  type ResearchExitInfo,
  type RunEntry,
  type ToolCallEvent,
} from "./lib.ts";
import { embeddedResearcher, fakeChild } from "./test-helpers.ts";

const stubParser: FrontmatterParser = (content) => {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: content };
  const frontmatter: Record<string, unknown> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { frontmatter, body: m[2] ?? "" };
};

function makeAgentFile(dir: string, name: string, description: string, body: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
}

// S1 — resolveTools
test("resolveTools maps bash to powershell on win32 and passes through otherwise", () => {
  const expected = process.platform === "win32" ? ["read", "powershell", "ls"] : ["read", "bash", "ls"];
  assert.deepEqual(resolveTools(["read", "bash", "ls"]), expected);
});

test("resolveTools leaves non-bash tools untouched", () => {
  assert.deepEqual(resolveTools(["read", "grep"]), ["read", "grep"]);
});

test("resolveTools returns undefined for undefined input", () => {
  assert.equal(resolveTools(undefined), undefined);
});

// S1a — fff tool-name degradation (D2).
// pi-fff registers ffgrep/ffind (tools/tools-and-ui) or grep/find
// (override mode); the built-in grep/find exist in every mode and are
// always enabled by the --tools allowlist. So a role declaring the fff
// names degrades to the built-in names when the fff names are missing
// from the current environment's tool registry — never the other way.
test("resolveTools degrades ffgrep/ffind to grep/find when the fff names are unavailable", () => {
  const available = new Set(["grep", "find", "ls"]);
  assert.deepEqual(resolveTools(["ffgrep", "ffind", "ls"], available), ["grep", "find", "ls"]);
});

test("resolveTools keeps ffgrep/ffind when the fff names are available", () => {
  const available = new Set(["ffgrep", "ffind", "grep", "find", "ls", "bash"]);
  assert.deepEqual(resolveTools(["ffgrep", "ffind", "ls"], available), ["ffgrep", "ffind", "ls"]);
});

test("resolveTools passes tools through unchanged when no registry is provided", () => {
  assert.deepEqual(resolveTools(["ffgrep", "ffind", "grep", "find"]), ["ffgrep", "ffind", "grep", "find"]);
});

test("resolveTools degrades known aliases and drops unknown names against a registry", () => {
  const available = new Set(["grep", "ls"]);
  assert.deepEqual(resolveTools(["ffgrep", "mystery", "ls"], available), ["grep", "ls"]);
});

test("resolveTools drops a declared tool when neither it nor its alias is available", () => {
  const available = new Set(["ls", "bash"]);
  assert.deepEqual(resolveTools(["ffgrep", "ffind", "ls"], available), ["ls"]);
});

test("resolveTools drops every tool when the registry has none of them", () => {
  assert.deepEqual(resolveTools(["ffgrep", "ffind"], new Set()), []);
});

test("TOOL_ALIASES maps only the fff search names to built-ins", () => {
  assert.deepEqual(TOOL_ALIASES, { ffgrep: "grep", ffind: "find" });
});

test("resolveTools applies the win32 bash mapping alongside alias degradation", () => {
  const available = new Set(["powershell", "grep", "find", "bash"]);
  const expected = process.platform === "win32" ? ["grep", "find", "powershell"] : ["grep", "find", "bash"];
  assert.deepEqual(resolveTools(["ffgrep", "ffind", "bash"], available), expected);
});

// S2 — emptyUsage
test("emptyUsage returns an all-zero usage struct", () => {
  assert.deepEqual(emptyUsage(), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  });
});

// S3 — discoverAgents
test("discoverAgents returns the six embedded roles", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  try {
    const { agents } = discoverAgents(root, path.join(root, "agentDir"), ".pi", "user", stubParser);
    const names = agents.map((a) => a.name).sort();
    assert.deepEqual(names, [
      "architecture-scout",
      "design-explorer",
      "fact-finder",
      "researcher",
      "spec-reviewer",
      "standards-reviewer",
    ]);
    for (const a of agents) assert.equal(a.source, "embedded");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a user agent overrides an embedded role by name", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const agentDir = path.join(root, "agentDir");
  try {
    makeAgentFile(path.join(agentDir, "agents"), "researcher", "custom", "CUSTOM PROMPT");
    const { agents } = discoverAgents(root, agentDir, ".pi", "user", stubParser);
    const r = agents.find((a) => a.name === "researcher");
    assert.ok(r);
    assert.equal(r.source, "user");
    assert.equal(r.systemPrompt.trim(), "CUSTOM PROMPT");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a project agent overrides a user agent by name in 'both' scope", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const agentDir = path.join(root, "agentDir");
  try {
    makeAgentFile(path.join(agentDir, "agents"), "researcher", "user", "USER PROMPT");
    makeAgentFile(path.join(root, ".pi", "agents"), "researcher", "project", "PROJECT PROMPT");
    const { agents } = discoverAgents(root, agentDir, ".pi", "both", stubParser);
    const r = agents.find((a) => a.name === "researcher");
    assert.ok(r);
    assert.equal(r.source, "project");
    assert.equal(r.systemPrompt.trim(), "PROJECT PROMPT");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("'project' scope excludes user agents", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const agentDir = path.join(root, "agentDir");
  try {
    makeAgentFile(path.join(agentDir, "agents"), "fact-finder", "user", "USER PROMPT");
    const { agents } = discoverAgents(root, agentDir, ".pi", "project", stubParser);
    const f = agents.find((a) => a.name === "fact-finder");
    assert.ok(f);
    assert.equal(f.source, "embedded");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("'user' scope excludes project agents", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const agentDir = path.join(root, "agentDir");
  try {
    makeAgentFile(path.join(root, ".pi", "agents"), "fact-finder", "project", "PROJECT PROMPT");
    const { agents } = discoverAgents(root, agentDir, ".pi", "user", stubParser);
    const f = agents.find((a) => a.name === "fact-finder");
    assert.ok(f);
    assert.equal(f.source, "embedded");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// S4 — resolveRole
test("resolveRole returns the effective agent for a name", () => {
  const agents: AgentConfig[] = [{ name: "researcher", description: "", source: "user", systemPrompt: "CUSTOM" }];
  const r = resolveRole(agents, "researcher");
  assert.ok(r);
  assert.equal(r.systemPrompt, "CUSTOM");
});

test("resolveRole returns undefined for an unknown name", () => {
  assert.equal(resolveRole([], "nope"), undefined);
});

// S5 — buildResearchPrompt (ADR 0013): role prompt + findings path + a single
// wall-clock cap line + the checkpoint rule. No budget block, no tiers.
test("buildResearchPrompt embeds the agent system prompt, findings path, and task", () => {
  const agent: AgentConfig = {
    name: "researcher",
    description: "",
    source: "embedded",
    systemPrompt: "CUSTOM PROMPT",
  };
  const p = buildResearchPrompt(agent, "do the thing", "/tmp/out.md");
  assert.ok(p.includes("CUSTOM PROMPT"));
  assert.ok(p.includes("/tmp/out.md"));
  assert.ok(p.includes("do the thing"));
});

test("buildResearchPrompt writes the 60-minute wall-clock cap as a single line by default", () => {
  const p = buildResearchPrompt(embeddedResearcher(), "T", "/tmp/f.md");
  assert.ok(p.includes("60 min"), "the default cap must reach the prompt");
  assert.ok(p.includes("wall-clock time"), "the wall-clock line must be present");
  assert.equal(DEFAULT_RESEARCH_WALL_CLOCK_MS, 60 * 60 * 1000, "the default is 60 minutes");
});

test("buildResearchPrompt reflects a tightened wall-clock cap", () => {
  const p = buildResearchPrompt(embeddedResearcher(), "T", "/tmp/f.md", 5 * 60 * 1000);
  assert.ok(p.includes("5 min"));
  assert.ok(!p.includes("60 min"));
});

test("buildResearchPrompt carries the checkpoint rule and the enough-to-answer rule", () => {
  const p = buildResearchPrompt(embeddedResearcher(), "T", "/tmp/f.md");
  assert.ok(p.includes("checkpoint"), "checkpoint-write behaviour must be in the prompt");
  assert.ok(p.includes("enough information to answer well"), "the enough-to-answer rule must be in the prompt");
});

test("buildResearchPrompt has no budget block or tiers", () => {
  const p = buildResearchPrompt(embeddedResearcher(), "T", "/tmp/f.md");
  assert.ok(!p.includes("Research budget"));
  assert.ok(!p.includes("search rounds"));
  assert.ok(!p.includes("wind-down"));
  assert.ok(!p.includes("soft_limit_exceeded"));
});

// tracer bullet for Spec-9: an overridden researcher role must win in the background path
test("background research prompt uses an overridden researcher role", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const agentDir = path.join(root, "agentDir");
  try {
    makeAgentFile(path.join(agentDir, "agents"), "researcher", "custom", "CUSTOM OVERRIDE PROMPT");
    const { agents } = discoverAgents(root, agentDir, ".pi", "user", stubParser);
    const agent = resolveRole(agents, "researcher");
    assert.ok(agent);
    const prompt = buildResearchPrompt(agent, "task", "/tmp/f.md");
    assert.ok(prompt.includes("CUSTOM OVERRIDE PROMPT"));
    assert.ok(!prompt.includes("You are a researcher."));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// S5a — researchStatusContent (ADR 0013): the pushed content becomes the
// triggered turn's prompt — every terminal state must instruct reading the
// findings file (prototype lesson), not just summarize.
test("researchStatusContent words every terminal state as a read-the-findings instruction", () => {
  // Iterate the frozen terminal-status const, not a hand-copied list: the
  // derived ResearchExitInfo.status stays exact only while the const's
  // element type is the four literals (lib.ts), so this loop doubles as the
  // drift guard for both.
  for (const status of TERMINAL_RUN_STATUSES) {
    const text = researchStatusContent(status, "/tmp/f.md", "/tmp/research.log");
    assert.ok(text.includes("Read"), `${status}: the pushed content must instruct reading the findings file`);
    assert.ok(text.includes("/tmp/f.md"), `${status}: the findings path must be named`);
  }
});

test("researchStatusContent flags the wall-clock cut and names the log only when present", () => {
  const terminated = researchStatusContent("terminated", "/tmp/f.md");
  assert.ok(terminated.includes("wall-clock"), "terminated must flag truncation risk");
  assert.ok(terminated.includes("truncated"), "terminated must warn the findings may be truncated");
  assert.ok(!terminated.includes("research.log"), "no log line without a logPath");
  const failed = researchStatusContent("failed", "/tmp/f.md", "/tmp/research.log");
  assert.ok(failed.includes("/tmp/research.log"), "the run log is named when available");
});

// AgentScope helpers
test("scopeAllowsProject is true only for project and both", () => {
  assert.equal(scopeAllowsProject("user"), false);
  assert.equal(scopeAllowsProject("project"), true);
  assert.equal(scopeAllowsProject("both"), true);
});

// S7 — runBackgroundResearch (ADR 0013, primary seam). The runner is
// runtime-free: an injectable child-session factory stands in for the
// extension's in-process createAgentSession wiring.

function pendingChild(): { child: ResearchChildSession; abortCalls: number } {
  const state = { abortCalls: 0 };
  return {
    child: fakeChild({ abort: () => state.abortCalls++ }),
    get abortCalls() {
      return state.abortCalls;
    },
  };
}

test("runBackgroundResearch returns immediately and starts the child with the assembled prompt", (t) => {
  const calls: Array<Record<string, unknown>> = [];
  let returnedBeforeChildDone = false;
  const { child } = pendingChild();
  const handle = runBackgroundResearch(
    {
      cwd: "/w",
      model: "p/m",
      thinkingLevel: "low",
      tools: ["read", "write"],
      task: "T",
      findingsPath: "/tmp/f.md",
      agents: [embeddedResearcher()],
    },
    (opts) => {
      calls.push(opts);
      return child;
    },
  );
  t.after(() => {
    fs.rmSync(path.dirname(handle.logPath), { recursive: true, force: true });
  });
  returnedBeforeChildDone = true;

  // handle shape: researchId names the tmp dir, logPath is a research.log inside it
  assert.equal(handle.findingsPath, "/tmp/f.md");
  assert.match(handle.researchId, /^pi-research-/);
  assert.match(handle.logPath, /research\.log$/);
  assert.ok(handle.logPath.includes(handle.researchId));
  assert.ok(returnedBeforeChildDone, "the runner must not wait for the child");

  // exactly one child factory call, carrying the assembled prompt surface
  assert.equal(calls.length, 1);
  const c = calls[0] as {
    cwd: string;
    model: unknown;
    thinkingLevel: string;
    tools: string[];
    systemPrompt: string;
    task: string;
    findingsPath: string;
  };
  assert.equal(c.cwd, "/w");
  assert.equal(c.model, "p/m");
  assert.equal(c.thinkingLevel, "low");
  assert.deepEqual(c.tools, ["read", "write"]);
  assert.equal(c.task, "T");
  assert.equal(c.findingsPath, "/tmp/f.md");
  assert.ok(c.systemPrompt.includes("SP"), "role system prompt reaches the child");
  assert.ok(c.systemPrompt.includes("/tmp/f.md"), "findings path reaches the child (in the override, not argv)");
  assert.ok(c.systemPrompt.includes("60 min"), "the wall-clock cap line reaches the child");
});

test("runBackgroundResearch resolves tools for the child against the registry", () => {
  const calls: Array<{ tools?: string[] }> = [];
  runBackgroundResearch(
    {
      cwd: "/w",
      task: "T",
      findingsPath: "/tmp/f.md",
      tools: ["ffgrep", "ffind", "ls"],
      availableToolNames: new Set(["grep", "find", "ls"]),
      agents: [embeddedResearcher()],
    },
    (opts) => {
      calls.push({ tools: opts.tools });
      return fakeChild();
    },
  );
  assert.deepEqual(calls[0]?.tools, ["grep", "find", "ls"], "declared fff names degrade to built-ins");
});

test("runBackgroundResearch throws when no researcher role is available", () => {
  const factory = () => {
    throw new Error("must not create a child");
  };
  assert.throws(
    () => runBackgroundResearch({ cwd: "/w", task: "T", findingsPath: "/tmp/f.md", agents: [] }, factory),
    /No "researcher" role available/,
  );
});

test("runBackgroundResearch tees the child output into the per-run log", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const findingsPath = path.join(dir, "findings.md");
  const output = (async function* () {
    yield "first chunk\n";
    yield "second chunk\n";
  })();
  const handle = runBackgroundResearch(
    { cwd: dir, task: "T", findingsPath, agents: [embeddedResearcher()] },
    () => fakeChild({ output }),
  );
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(handle.logPath), { recursive: true, force: true });
  });
  await new Promise((r) => setTimeout(r, 20));
  const logText = fs.readFileSync(handle.logPath, "utf8");
  assert.equal(logText, "first chunk\nsecond chunk\n");
});

test("runBackgroundResearch resolves succeeded on a natural completion", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const findingsPath = path.join(dir, "findings.md");
  const exits: ResearchExitInfo[] = [];
  const handle = runBackgroundResearch(
    {
      cwd: dir,
      task: "T",
      findingsPath,
      agents: [embeddedResearcher()],
      onExit: (info) => exits.push(info),
    },
    () => fakeChild({ done: Promise.resolve() }),
  );
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(handle.logPath), { recursive: true, force: true });
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(exits, [{ status: "succeeded" }]);
  assert.ok(!fs.existsSync(findingsPath), "a natural completion must not write the termination marker");
});

test("runBackgroundResearch resolves failed when the child throws", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const findingsPath = path.join(dir, "findings.md");
  const exits: ResearchExitInfo[] = [];
  const handle = runBackgroundResearch(
    {
      cwd: dir,
      task: "T",
      findingsPath,
      agents: [embeddedResearcher()],
      onExit: (info) => exits.push(info),
    },
    () => fakeChild({ done: Promise.reject(new Error("boom")) }),
  );
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(handle.logPath), { recursive: true, force: true });
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(exits, [{ status: "failed", errorMessage: "boom" }]);
});

test("runBackgroundResearch kills at the wall-clock cap, marks the findings, and resolves terminated", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const findingsPath = path.join(dir, "findings.md");
  fs.writeFileSync(findingsPath, "# Findings\n\npartial content\n");
  const pending = pendingChild();
  const exits: ResearchExitInfo[] = [];
  let timer: (() => void) | undefined;
  let cleared = false;
  const handle = runBackgroundResearch(
    {
      cwd: dir,
      task: "T",
      findingsPath,
      maxWallClockMs: 5 * 60 * 1000,
      agents: [embeddedResearcher()],
      watcherDeps: {
        now: () => 1_700_000_000_000,
        setTimeout: (fn: () => void) => {
          timer = fn;
          return { unref() {} } as never;
        },
        clearTimeout: () => {
          cleared = true;
        },
      },
      onExit: (info) => exits.push(info),
    },
    () => pending.child,
  );
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(handle.logPath), { recursive: true, force: true });
  });
  assert.equal(typeof timer, "function", "a wall-clock timer must be scheduled");
  timer!();
  assert.equal(pending.abortCalls, 1, "the child must be aborted at the cap");
  // onExit fires only after the tee has drained the child's output into the log
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(exits, [{ status: "terminated" }]);
  const text = fs.readFileSync(findingsPath, "utf8");
  assert.ok(text.includes("<!-- research-terminated"), "the slim marker must be on disk");
  assert.ok(text.includes("reason: wall_clock_exceeded"), "the only cause is the wall clock");
  assert.ok(text.includes("at: 2023-11-14T22:13:20.000Z"), "the marker carries the injected timestamp");
  assert.ok(text.includes("partial content"), "existing findings content is preserved");
  assert.ok(!text.includes("partial: true"), "the slim marker drops the old partial/limit/observed fields");
});

test("runBackgroundResearch resolves aborted on the abort signal without a marker", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const findingsPath = path.join(dir, "findings.md");
  const pending = pendingChild();
  const exits: ResearchExitInfo[] = [];
  const controller = new AbortController();
  const handle = runBackgroundResearch(
    {
      cwd: dir,
      task: "T",
      findingsPath,
      agents: [embeddedResearcher()],
      abortSignal: controller.signal,
      onExit: (info) => exits.push(info),
    },
    () => pending.child,
  );
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(handle.logPath), { recursive: true, force: true });
  });
  controller.abort();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(pending.abortCalls, 1, "a manual kill aborts the in-process child");
  assert.deepEqual(exits, [{ status: "aborted" }]);
  assert.ok(!fs.existsSync(findingsPath), "a manual kill must not write the termination marker");
});

test("a pre-aborted signal settles on a microtask, never synchronously before the handle returns", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const findingsPath = path.join(dir, "findings.md");
  const pending = pendingChild();
  const exits: ResearchExitInfo[] = [];
  const controller = new AbortController();
  controller.abort();
  const handleSeenInOnExit = { seen: false };
  const handle = runBackgroundResearch(
    {
      cwd: dir,
      task: "T",
      findingsPath,
      agents: [embeddedResearcher()],
      abortSignal: controller.signal,
      onExit: () => {
        // The extension reads handle.logPath inside onExit; a synchronous
        // onExit would hit the const in TDZ. Assert the handle exists here.
        handleSeenInOnExit.seen = typeof handle.logPath === "string";
        exits.push({ status: "aborted" });
      },
    },
    () => pending.child,
  );
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(handle.logPath), { recursive: true, force: true });
  });
  assert.deepEqual(exits, [], "a pre-aborted signal must not settle synchronously");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(exits, [{ status: "aborted" }]);
  assert.ok(handleSeenInOnExit.seen, "onExit must run after the handle exists (async settle)");
});

// ADR 0013 push delivery — a wall-clock kill or manual kill must push its
// terminal state even when abort() cannot end the child's output stream (a
// model call that ignores the abort leaves the stream open forever). The
// runner resolves the status synchronously at the kill and fires onExit after
// a bounded drain window, so the push is never lost to a stuck stream.
test("wall-clock kill pushes terminated even when the child stream never ends (bounded drain window)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const findingsPath = path.join(dir, "findings.md");
  fs.writeFileSync(findingsPath, "# Findings\n\npartial\n");
  const state = { abortCalls: 0 };
  const child = fakeChild({
    output: (async function* () {
      // Never yields, never ends: the tee's for-await suspends forever.
      await new Promise<void>(() => {});
    })(),
    abort: () => state.abortCalls++,
  });
  const exits: ResearchExitInfo[] = [];
  const timers: Array<() => void> = [];
  const handle = runBackgroundResearch(
    {
      cwd: dir,
      task: "T",
      findingsPath,
      maxWallClockMs: 5 * 60 * 1000,
      agents: [embeddedResearcher()],
      watcherDeps: {
        now: () => 1_700_000_000_000,
        setTimeout: (fn: () => void) => {
          timers.push(fn);
          return { unref() {} } as never;
        },
        clearTimeout: () => {},
      },
      onExit: (info) => exits.push(info),
    },
    () => child,
  );
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(handle.logPath), { recursive: true, force: true });
  });
  assert.equal(timers.length, 1, "initially only the wall-clock timer is scheduled");
  timers[0]!();
  assert.equal(state.abortCalls, 1, "the child must be aborted at the cap");
  const text = fs.readFileSync(findingsPath, "utf8");
  assert.ok(text.includes("<!-- research-terminated"), "the marker lands before the push");
  assert.deepEqual(exits, [], "the push waits for the bounded drain (the stream is still open)");
  assert.equal(timers.length, 2, "the drain bound is scheduled at settle");
  timers[1]!();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(exits, [{ status: "terminated" }], "the terminated push must arrive even on a stuck stream");
});

test("a manual kill pushes aborted even when the child stream never ends", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const findingsPath = path.join(dir, "findings.md");
  const state = { abortCalls: 0 };
  const child = fakeChild({
    output: (async function* () {
      await new Promise<void>(() => {});
    })(),
    abort: () => state.abortCalls++,
  });
  const exits: ResearchExitInfo[] = [];
  const timers: Array<() => void> = [];
  const controller = new AbortController();
  const handle = runBackgroundResearch(
    {
      cwd: dir,
      task: "T",
      findingsPath,
      agents: [embeddedResearcher()],
      abortSignal: controller.signal,
      watcherDeps: {
        now: () => 1_700_000_000_000,
        setTimeout: (fn: () => void) => {
          timers.push(fn);
          return { unref() {} } as never;
        },
        clearTimeout: () => {},
      },
      onExit: (info) => exits.push(info),
    },
    () => child,
  );
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(handle.logPath), { recursive: true, force: true });
  });
  controller.abort();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(state.abortCalls, 1, "a manual kill aborts the in-process child");
  assert.deepEqual(exits, [], "the push waits for the bounded drain");
  assert.equal(timers.length, 2, "the wall-clock timer plus the drain grace");
  timers[1]!();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(exits, [{ status: "aborted" }], "the aborted push must arrive even on a stuck stream");
  assert.ok(!fs.existsSync(findingsPath), "a manual kill must not write the termination marker");
});

// ADR 0013 — the research child is restricted to built-in tools: the
// extension's own tool names (subagent, research) must never reach its
// allowlist, even though the main session's registry contains them.
test("runBackgroundResearch never hands the extension's own tools to the child", () => {
  const calls: Array<{ tools?: string[] }> = [];
  runBackgroundResearch(
    {
      cwd: "/w",
      task: "T",
      findingsPath: "/tmp/f.md",
      tools: ["subagent", "research", "read"],
      availableToolNames: new Set(["subagent", "research", "read", "grep"]),
      agents: [embeddedResearcher()],
    },
    (opts) => {
      calls.push({ tools: opts.tools });
      return fakeChild();
    },
  );
  assert.deepEqual(calls[0]?.tools, ["read"], "subagent/research must never reach a research child allowlist");
});

test("runBackgroundResearch drops extension tools without a tool registry too", () => {
  const calls: Array<{ tools?: string[] }> = [];
  runBackgroundResearch(
    {
      cwd: "/w",
      task: "T",
      findingsPath: "/tmp/f.md",
      tools: ["research", "subagent", "write"],
      agents: [embeddedResearcher()],
    },
    (opts) => {
      calls.push({ tools: opts.tools });
      return fakeChild();
    },
  );
  assert.deepEqual(calls[0]?.tools, ["write"]);
});

// Issue #26 — the toolCall audit seam: the runner appends one JSON object per
// line to `toolcalls.jsonl` beside `research.log`, driven through the child
// factory's optional synchronous `onToolCall` hook (the `tool_execution_start`
// event source). Start events only, no results, no truncation; a zero-call
// run leaves an empty file; the output log and UI stream are untouched.

test("runBackgroundResearch appends one JSONL line per tool call through the injected hook", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const findingsPath = path.join(dir, "findings.md");
  let hook: ((call: ToolCallEvent) => void) | undefined;
  const handle = runBackgroundResearch(
    {
      cwd: dir,
      task: "T",
      findingsPath,
      agents: [embeddedResearcher()],
      watcherDeps: { now: () => 1_700_000_000_000 },
    },
    (opts) => {
      hook = opts.onToolCall;
      return fakeChild({ done: Promise.resolve() });
    },
  );
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(handle.logPath), { recursive: true, force: true });
  });
  const toolCallsPath = path.join(path.dirname(handle.logPath), "toolcalls.jsonl");
  assert.equal(typeof hook, "function", "the runner must hand the child factory an onToolCall hook");
  // a zero-call run leaves an empty (but existing) file
  assert.ok(fs.existsSync(toolCallsPath), "the audit file is created eagerly beside the log");
  assert.equal(fs.readFileSync(toolCallsPath, "utf8"), "");

  hook!({ toolCallId: "call-1", toolName: "bash", args: { command: "echo hi", timeout: 1000 } });
  hook!({ toolCallId: "call-2", toolName: "read", args: { path: "/tmp/x" } });
  const lines = fs
    .readFileSync(toolCallsPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(lines, [
    { ts: 1_700_000_000_000, toolCallId: "call-1", toolName: "bash", args: { command: "echo hi", timeout: 1000 } },
    { ts: 1_700_000_000_000, toolCallId: "call-2", toolName: "read", args: { path: "/tmp/x" } },
  ]);
});

test("the toolCall audit writes only to toolcalls.jsonl, never the output log", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const findingsPath = path.join(dir, "findings.md");
  const output = (async function* () {
    yield "assistant text\n";
  })();
  let hook: ((call: ToolCallEvent) => void) | undefined;
  const handle = runBackgroundResearch(
    { cwd: dir, task: "T", findingsPath, agents: [embeddedResearcher()] },
    (opts) => {
      hook = opts.onToolCall;
      return fakeChild({ output });
    },
  );
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(handle.logPath), { recursive: true, force: true });
  });
  hook!({ toolCallId: "c", toolName: "bash", args: { command: "ls" } });
  await new Promise((r) => setTimeout(r, 20));
  // the output log is a 1:1 tee of the child's output stream (the UI
  // stream), so an untouched log also proves the stream is untouched — the
  // audit writes only to its own file
  assert.equal(fs.readFileSync(handle.logPath, "utf8"), "assistant text\n");
  const toolCallsPath = path.join(path.dirname(handle.logPath), "toolcalls.jsonl");
  const line = JSON.parse(fs.readFileSync(toolCallsPath, "utf8").trim());
  assert.equal(line.toolName, "bash");
  assert.equal(line.args.command, "ls");
});

test("a toolCall audit serialization failure is swallowed and writes no line", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const findingsPath = path.join(dir, "findings.md");
  const exits: ResearchExitInfo[] = [];
  let hook: ((call: ToolCallEvent) => void) | undefined;
  const handle = runBackgroundResearch(
    {
      cwd: dir,
      task: "T",
      findingsPath,
      agents: [embeddedResearcher()],
      onExit: (info) => exits.push(info),
    },
    (opts) => {
      hook = opts.onToolCall;
      return fakeChild({ done: Promise.resolve() });
    },
  );
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(handle.logPath), { recursive: true, force: true });
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(exits, [{ status: "succeeded" }], "the run settles normally");
  // an unserializable arg (BigInt) must not throw out of the hook and must
  // write no line — a debug artifact can never kill a research run
  const toolCallsPath = path.join(path.dirname(handle.logPath), "toolcalls.jsonl");
  assert.doesNotThrow(() => hook!({ toolCallId: "c", toolName: "bash", args: { n: 1n } }));
  assert.equal(fs.readFileSync(toolCallsPath, "utf8"), "");
});

test("runBackgroundResearch unrefs the wall-clock timer so it never holds the host alive", (t) => {
  const { child } = pendingChild();
  let unrefCalls = 0;
  const handle = runBackgroundResearch(
    {
      cwd: "/w",
      task: "T",
      findingsPath: "/tmp/f.md",
      agents: [embeddedResearcher()],
      watcherDeps: {
        setTimeout: () =>
          ({
            unref() {
              unrefCalls++;
            },
          }) as never,
      },
    },
    () => child,
  );
  t.after(() => {
    fs.rmSync(path.dirname(handle.logPath), { recursive: true, force: true });
  });
  assert.equal(unrefCalls, 1, "the wall-clock timer must be unref'd");
});

// S8 — resolveThinkingLevel
test("resolveThinkingLevel returns undefined when the agent pins its own model", () => {
  assert.equal(resolveThinkingLevel({ hasModel: true, roleLevel: "medium", inherited: "high" }), undefined);
  assert.equal(resolveThinkingLevel({ hasModel: true }), undefined);
});

test("resolveThinkingLevel honors the per-call override even for model-pinned agents", () => {
  // the escape hatch beats everything, including a pinned model
  assert.equal(resolveThinkingLevel({ hasModel: true, override: "low" }), "low");
  assert.equal(resolveThinkingLevel({ hasModel: true, override: "low", roleLevel: "medium", inherited: "high" }), "low");
});

test("resolveThinkingLevel prefers a per-call override over role and inherited levels", () => {
  assert.equal(resolveThinkingLevel({ hasModel: false, override: "low", roleLevel: "medium", inherited: "high" }), "low");
});

test("resolveThinkingLevel falls back to the role level, then the inherited level", () => {
  assert.equal(resolveThinkingLevel({ hasModel: false, roleLevel: "medium", inherited: "high" }), "medium");
  assert.equal(resolveThinkingLevel({ hasModel: false, inherited: "high" }), "high");
  assert.equal(resolveThinkingLevel({ hasModel: false }), undefined);
});

// Literals, not derived from EMBEDDED_ROLES: a regression to a uniform role
// level is caught here rather than in the fixtures.
test("embedded roles carry per-role thinking levels", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  try {
    const { agents } = discoverAgents(root, path.join(root, "agentDir"), ".pi", "user", stubParser);
    const levelOf = (name: string) => agents.find((a) => a.name === name)?.thinkingLevel;
    assert.equal(levelOf("standards-reviewer"), "medium");
    assert.equal(levelOf("spec-reviewer"), "medium");
    assert.equal(levelOf("architecture-scout"), "medium");
    assert.equal(levelOf("design-explorer"), "medium");
    assert.equal(levelOf("researcher"), "medium");
    assert.equal(levelOf("fact-finder"), "low");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a user agent frontmatter can set a custom thinkingLevel", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const agentDir = path.join(root, "agentDir");
  try {
    fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "agents", "researcher.md"),
      "---\nname: researcher\ndescription: custom\nthinkingLevel: minimal\n---\nCUSTOM PROMPT\n",
    );
    const { agents } = discoverAgents(root, agentDir, ".pi", "user", stubParser);
    const r = agents.find((a) => a.name === "researcher");
    assert.ok(r);
    assert.equal(r.thinkingLevel, "minimal");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a user agent frontmatter with an invalid thinkingLevel is ignored", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const agentDir = path.join(root, "agentDir");
  try {
    fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "agents", "researcher.md"),
      "---\nname: researcher\ndescription: custom\nthinkingLevel: meduim\n---\nCUSTOM PROMPT\n",
    );
    const { agents } = discoverAgents(root, agentDir, ".pi", "user", stubParser);
    const r = agents.find((a) => a.name === "researcher");
    assert.ok(r);
    assert.equal(r.thinkingLevel, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// S11 — appendResearchTerminatedMarker (ADR 0013). The slim marker is frozen
// as a literal: reason (always wall_clock_exceeded) + at. No partial/limit/
// observed fields — `partial` is implied by the marker itself.
test("appendResearchTerminatedMarker appends the frozen slim marker", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const findingsPath = path.join(dir, "findings.md");
  try {
    fs.writeFileSync(findingsPath, "# Findings\n\nsome content\n");
    appendResearchTerminatedMarker(findingsPath, "2026-09-17T10:00:00.000Z");
    const text = fs.readFileSync(findingsPath, "utf8");
    assert.ok(text.includes("<!-- research-terminated"));
    assert.ok(text.includes("reason: wall_clock_exceeded"));
    assert.ok(text.includes("at: 2026-09-17T10:00:00.000Z"));
    assert.ok(text.includes("-->"), "marker must be closed");
    assert.ok(text.includes("some content"), "existing findings content is preserved");
    assert.ok(!text.includes("partial: true"), "the slim marker drops the old fields");
    assert.ok(!text.includes("limit:"), "no limit/observed fields in the slim marker");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
// S16 — run registry (D3, Seam A). The status enum is frozen as a literal;
// terminal states are frozen (no further updates); transitions are guarded.
test("RUN_STATUSES freezes the D3 status enum", () => {
  assert.deepEqual(RUN_STATUSES, ["queued", "running", "succeeded", "failed", "aborted", "terminated"]);
});

test("createRunRegistry registers a run, defaulting to queued, and returns its id", () => {
  const reg = createRunRegistry();
  const id = reg.register({ role: "researcher", source: "embedded", channel: "background", startedAt: 1000 });
  const run = reg.get(id);
  assert.ok(run);
  assert.equal(run.id, id);
  assert.equal(run.status, "queued");
  assert.equal(run.role, "researcher");
  assert.equal(run.channel, "background");
  assert.equal(run.startedAt, 1000);
});

test("createRunRegistry assigns distinct ids", () => {
  const reg = createRunRegistry();
  const a = reg.register({ role: "a", source: "embedded", channel: "blocking", startedAt: 0 });
  const b = reg.register({ role: "b", source: "embedded", channel: "blocking", startedAt: 0 });
  assert.notEqual(a, b);
});

test("register honors an explicit initial status", () => {
  const reg = createRunRegistry();
  const id = reg.register({ role: "r", source: "embedded", channel: "background", startedAt: 0, status: "running" });
  assert.equal(reg.get(id)?.status, "running");
});

test("update mutates fields and follows legal transitions", () => {
  const reg = createRunRegistry();
  const id = reg.register({ role: "r", source: "embedded", channel: "blocking", startedAt: 0 });
  reg.update(id, { status: "running", lastOutput: "working..." });
  reg.update(id, { status: "succeeded", usage: emptyUsage() });
  const run = reg.get(id);
  assert.equal(run?.status, "succeeded");
  assert.equal(run?.lastOutput, "working...");
  assert.ok(run?.usage);
});

test("update throws on a terminal run (frozen)", () => {
  const reg = createRunRegistry();
  const id = reg.register({ role: "r", source: "embedded", channel: "blocking", startedAt: 0, status: "running" });
  reg.update(id, { status: "succeeded" });
  assert.throws(() => reg.update(id, { status: "failed" }), /terminal/);
  assert.throws(() => reg.update(id, { lastOutput: "late" }), /terminal/);
});

test("update records endedAt when transitioning to a terminal status", () => {
  const reg = createRunRegistry(() => 5000);
  const id = reg.register({
    role: "r",
    source: "embedded",
    channel: "background",
    startedAt: 1000,
    status: "running",
  });
  reg.update(id, { status: "succeeded" });
  assert.equal(reg.get(id)?.endedAt, 5000, "terminal transition stamps endedAt from the registry clock");
  const id2 = reg.register({ role: "r2", source: "embedded", channel: "blocking", startedAt: 0, status: "running" });
  reg.update(id2, { lastOutput: "working" });
  assert.equal(reg.get(id2)?.endedAt, undefined, "non-terminal updates do not stamp endedAt");
});

test("update rejects an illegal status transition", () => {
  const reg = createRunRegistry();
  const id = reg.register({ role: "r", source: "embedded", channel: "blocking", startedAt: 0 });
  // queued must pass through running before reaching a terminal state
  assert.throws(() => reg.update(id, { status: "succeeded" }), /transition/);
  assert.equal(reg.get(id)?.status, "queued", "failed transition must not corrupt the run");
});

test("running may terminate into any terminal status", () => {
  const reg = createRunRegistry();
  for (const s of ["succeeded", "failed", "aborted", "terminated"] as const) {
    const id = reg.register({ role: "r", source: "embedded", channel: "blocking", startedAt: 0, status: "running" });
    reg.update(id, { status: s });
    assert.equal(reg.get(id)?.status, s);
  }
});

test("queued may be aborted directly (call cancelled before the slot opens)", () => {
  const reg = createRunRegistry();
  const id = reg.register({ role: "r", source: "embedded", channel: "blocking", startedAt: 0 });
  reg.update(id, { status: "aborted" });
  assert.equal(reg.get(id)?.status, "aborted");
});

test("snapshot returns a startedAt-ascending copy detached from the registry", () => {
  const reg = createRunRegistry();
  const a = reg.register({ role: "a", source: "embedded", channel: "blocking", startedAt: 300 });
  const b = reg.register({ role: "b", source: "embedded", channel: "blocking", startedAt: 100 });
  const snap = reg.snapshot();
  assert.deepEqual(snap.map((r) => r.role), ["b", "a"]);
  snap[0].role = "mutated";
  assert.equal(reg.get(b)?.role, "b", "snapshot must not alias registry state");
});

test("list returns entries in insertion order", () => {
  const reg = createRunRegistry();
  const a = reg.register({ role: "a", source: "embedded", channel: "blocking", startedAt: 300 });
  const b = reg.register({ role: "b", source: "embedded", channel: "blocking", startedAt: 100 });
  assert.deepEqual(reg.list().map((r) => r.role), ["a", "b"], "list is insertion-ordered, unlike snapshot");
});

test("clear empties the registry", () => {
  const reg = createRunRegistry();
  reg.register({ role: "r", source: "embedded", channel: "blocking", startedAt: 0 });
  reg.clear();
  assert.deepEqual(reg.snapshot(), []);
});

test("get returns undefined for an unknown id", () => {
  const reg = createRunRegistry();
  assert.equal(reg.get("nope"), undefined);
});

test("RUN_STATUS_ICONS freezes the icon mapping", () => {
  assert.deepEqual(RUN_STATUS_ICONS, {
    queued: "⏳",
    running: "▶",
    succeeded: "✓",
    failed: "✗",
    aborted: "⊘",
    terminated: "⛔",
  });
});

// S17 — snapshot formatting (D3, display layer). Pure text, grouped
// running-before-finished, startedAt-ascending within a group.
test("formatRunSnapshot returns an empty-state message for no runs", () => {
  assert.equal(formatRunSnapshot([], 1000), "No subagents running.");
});

test("formatRunSnapshot groups running before finished, sorted by start time", () => {
  const runs: RunEntry[] = [
    { id: "a", role: "spec-reviewer", source: "embedded", channel: "blocking", status: "succeeded", startedAt: 300 },
    { id: "b", role: "researcher", source: "embedded", channel: "background", status: "running", startedAt: 100 },
    { id: "c", role: "fact-finder", source: "embedded", channel: "blocking", status: "failed", startedAt: 200 },
  ];
  const text = formatRunSnapshot(runs, 1000);
  const runningIdx = text.indexOf("[running]");
  const finishedIdx = text.indexOf("[finished]");
  assert.ok(runningIdx >= 0 && finishedIdx > runningIdx, "running group must come before finished");
  assert.ok(text.indexOf("researcher") < text.indexOf("spec-reviewer"), "running group sorts by start time");
  assert.ok(text.indexOf("fact-finder") < text.indexOf("spec-reviewer"), "finished group sorts by start time");
});

test("formatRunSnapshot renders role, source, status, elapsed, and start time per run", () => {
  const runs: RunEntry[] = [
    { id: "a", role: "researcher", source: "user", channel: "background", status: "running", startedAt: 0 },
  ];
  const text = formatRunSnapshot(runs, 1000);
  assert.ok(text.includes("▶"), "running icon");
  assert.ok(text.includes("researcher (user)"), "role + source");
  assert.ok(text.includes("[running]"), "status label");
  assert.ok(text.includes("1 s"), "elapsed 1000ms");
  assert.ok(text.includes("started"), "start time marker");
});

test("formatRunSnapshot shows actual duration for a terminal run, not elapsed since the snapshot", () => {
  const runs: RunEntry[] = [
    {
      id: "a",
      role: "researcher",
      source: "embedded",
      channel: "background",
      status: "terminated",
      startedAt: 0,
      endedAt: 5_500,
    },
  ];
  const text = formatRunSnapshot(runs, 7_800);
  assert.ok(text.includes("5.5 s"), "terminal duration comes from endedAt, not the snapshot time");
  assert.ok(!text.includes("7.8 s"), "elapsed must not keep counting after the run ended");
});

test("formatRunSnapshot renders last output, usage, and paths when present", () => {
  const runs: RunEntry[] = [
    {
      id: "a",
      role: "researcher",
      source: "embedded",
      channel: "background",
      status: "running",
      startedAt: 0,
      lastOutput: "Investigating...",
      findingsPath: "/tmp/f.md",
      logPath: "/tmp/research.log",
      usage: { input: 1200, output: 800, cacheRead: 0, cacheWrite: 0, cost: 0.0012, contextTokens: 2000, turns: 3 },
    },
  ];
  const text = formatRunSnapshot(runs, 1000);
  assert.ok(text.includes("Investigating..."), "last output line");
  assert.ok(text.includes("3 turns"), "usage turns");
  assert.ok(text.includes("↑1.2k"), "usage input");
  assert.ok(text.includes("↓800"), "usage output");
  assert.ok(text.includes("$0.0012"), "usage cost");
  assert.ok(text.includes("/tmp/f.md"), "findings path");
  assert.ok(text.includes("/tmp/research.log"), "log path");
});

test("formatRunSnapshot collapses and truncates an over-long last output to one line", () => {
  const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
  const runs: RunEntry[] = [
    { id: "a", role: "researcher", source: "embedded", channel: "background", status: "running", startedAt: 0, lastOutput: long },
  ];
  const text = formatRunSnapshot(runs, 1000);
  const lastOutputLine = text.split("\n")[2]; // [running] / header / last:
  const output = lastOutputLine.slice("  last: ".length);
  assert.ok(lastOutputLine.startsWith("  last: "), "last output is a single indented line");
  assert.ok(output.length <= 120, `last output must be capped, got ${output.length}`);
  assert.ok(output.endsWith("..."), "over-long output is truncated");
  assert.ok(!output.includes("word99"), "far tail is cut");
});

// S18 — readLogTail (D3). Last maxBytes of a log file, partial leading line
// dropped, missing file safe.
test("readLogTail returns the last lines of a log file, truncated to maxBytes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const logPath = path.join(dir, "research.log");
  try {
    fs.writeFileSync(logPath, "line1\nline2\nline3\n");
    const tail = readLogTail(logPath, 7); // "line3\n" is 6 bytes; a 7-byte window grabs it whole
    assert.equal(tail, "line3");
    assert.ok(!tail.includes("line1"), "old lines must not appear");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readLogTail returns the full text for a small file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const logPath = path.join(dir, "research.log");
  try {
    fs.writeFileSync(logPath, "hello\nworld\n");
    assert.equal(readLogTail(logPath, 4096), "hello\nworld");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readLogTail is safe for a missing or empty file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  try {
    assert.equal(readLogTail(path.join(dir, "nope.log"), 4096), "");
    fs.writeFileSync(path.join(dir, "empty.log"), "");
    assert.equal(readLogTail(path.join(dir, "empty.log"), 4096), "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readLogTail honors an injected fs surface", () => {
  const calls: string[] = [];
  const fakeFs: LogTailFs = {
    statSync: () => {
      calls.push("stat");
      return { size: 10 };
    },
    openSync: () => {
      calls.push("open");
      return 3;
    },
    readSync: (fd, buf) => {
      calls.push("read");
      return buf.write("last line".padEnd(buf.length, " "));
    },
    closeSync: () => {
      calls.push("close");
    },
  };
  const tail = readLogTail("/virtual/log", 4096, fakeFs);
  assert.equal(tail, "last line");
  assert.deepEqual(calls, ["stat", "open", "read", "close"], "fs calls go through the injected surface");
});

// S19 — outcome mapping (D3). blockingRunStatus mirrors isFailedResult
// semantics + the abort flag. The background status resolution moved into the
// runner itself (ADR 0013): onExit delivers the resolved terminal status.
test("blockingRunStatus maps a single result to a run status", () => {
  assert.equal(blockingRunStatus({ exitCode: 0, stopReason: "end" }), "succeeded");
  assert.equal(blockingRunStatus({ exitCode: 0 }), "succeeded");
  assert.equal(blockingRunStatus({ exitCode: 1 }), "failed");
  assert.equal(blockingRunStatus({ exitCode: 0, stopReason: "error" }), "failed");
  assert.equal(blockingRunStatus({ exitCode: 0, stopReason: "aborted" }), "aborted");
  assert.equal(blockingRunStatus({ exitCode: 1, aborted: true }), "aborted", "abort wins over exit code");
});

test("formatBlockingToolError formats a failed single run as the tool error", () => {
  assert.equal(formatBlockingToolError("single", { stopReason: "error", output: "boom" }), "Agent error: boom");
  assert.equal(formatBlockingToolError("single", { output: "boom" }), "Agent failed: boom");
  assert.equal(
    formatBlockingToolError("single", { stopReason: "aborted", output: "(no output)" }),
    "Agent aborted: (no output)",
  );
});

test("formatBlockingToolError formats a failed chain step as the tool error", () => {
  assert.equal(
    formatBlockingToolError("chain", { agent: "researcher", step: 2, output: "boom" }),
    "Chain stopped at step 2 (researcher): boom",
  );
});

// S20 — run management (D6): prune/remove, args. Kill moved from pid/OS-signal
// to aborting the in-process child (ADR 0013), so there is no pid plumbing to
// assert here — the runner's abort-signal test covers the kill semantics.
test("createRunRegistry remove drops the entry and is safe for unknown ids", () => {
  const reg = createRunRegistry();
  const a = reg.register({ role: "a", source: "embedded", channel: "blocking", startedAt: 0, status: "succeeded" });
  const b = reg.register({ role: "b", source: "embedded", channel: "blocking", startedAt: 0, status: "running" });
  reg.remove(a);
  assert.equal(reg.get(a), undefined);
  assert.deepEqual(reg.list().map((r) => r.id), [b]);
  assert.equal(reg.snapshot().length, 1, "snapshot reflects the removal");
  assert.doesNotThrow(() => reg.remove("nope"));
});

test("parseSubagentsArgs maps the four command forms and rejects the rest", () => {
  assert.deepEqual(parseSubagentsArgs(""), { action: "snapshot" });
  assert.deepEqual(parseSubagentsArgs("   "), { action: "snapshot" });
  assert.deepEqual(parseSubagentsArgs("snapshot"), { action: "snapshot" });
  assert.deepEqual(parseSubagentsArgs("snapshot extra"), {
    action: "invalid",
    reason: "unexpected extra arguments: extra",
  });
  assert.deepEqual(parseSubagentsArgs("prune"), { action: "prune" });
  assert.deepEqual(parseSubagentsArgs("kill run-3"), { action: "kill", id: "run-3" });
  assert.deepEqual(parseSubagentsArgs("tail run-3"), { action: "tail", id: "run-3" });
  assert.deepEqual(parseSubagentsArgs("kill"), { action: "invalid", reason: "kill requires a run id" });
  assert.deepEqual(parseSubagentsArgs("tail"), { action: "invalid", reason: "tail requires a run id" });
  assert.deepEqual(parseSubagentsArgs("prune extra"), { action: "invalid", reason: "unexpected extra arguments: extra" });
  assert.deepEqual(parseSubagentsArgs("kill run-3 extra"), {
    action: "invalid",
    reason: "unexpected extra arguments: extra",
  });
  assert.deepEqual(parseSubagentsArgs("bogus"), { action: "invalid", reason: 'unknown action "bogus"' });
});

// ---------------------------------------------------------------------------
// S21 — Seam A: `input` merge semantics (ADR 0011). Direct fields override
// same-name JSON keys; absent/empty input is a passthrough; unparseable or
// non-object input raises the documented model-visible error; the merged
// object is validated against the full contract and failures name field
// paths. Pure, runtime-free: unit-tested with node --test.
// ---------------------------------------------------------------------------

test("mergeToolParams merges input JSON under the direct params (direct fields win)", () => {
  const direct: Record<string, unknown> = { agent: "researcher", task: "direct task" };
  const merged = mergeToolParams({
    direct,
    input: JSON.stringify({ task: "input task", model: "anthropic/claude-x", thinkingOverride: "low" }),
    fullSchema: SUBAGENT_FULL_PARAMS,
  });
  assert.equal(merged.task, "direct task", "direct field wins over the same-name JSON key");
  assert.equal(merged.agent, "researcher");
  assert.equal(merged.model, "anthropic/claude-x", "hidden params are routed into the merged object");
  assert.equal(merged.thinkingOverride, "low");
});

test("mergeToolParams passes through when input is absent or empty", () => {
  const direct: Record<string, unknown> = { agent: "researcher", task: "T" };
  assert.equal(mergeToolParams({ direct, fullSchema: SUBAGENT_FULL_PARAMS }), direct, "no input returns direct untouched");
  assert.deepEqual(mergeToolParams({ direct, input: "", fullSchema: SUBAGENT_FULL_PARAMS }), direct);
  assert.deepEqual(mergeToolParams({ direct, input: "   ", fullSchema: SUBAGENT_FULL_PARAMS }), direct);
});

test("mergeToolParams throws a model-visible error on unparseable input", () => {
  assert.throws(
    () => mergeToolParams({ direct: { task: "T" }, input: "{not json", fullSchema: SUBAGENT_FULL_PARAMS }),
    /input must be a JSON object string: /,
  );
});

test("mergeToolParams rejects non-object JSON input values", () => {
  const base = { direct: { task: "T" } as Record<string, unknown>, fullSchema: SUBAGENT_FULL_PARAMS };
  assert.throws(() => mergeToolParams({ ...base, input: "[1, 2]" }), /input must decode to a JSON object, got array/);
  assert.throws(() => mergeToolParams({ ...base, input: "42" }), /input must decode to a JSON object, got number/);
  assert.throws(() => mergeToolParams({ ...base, input: '"str"' }), /input must decode to a JSON object, got string/);
  assert.throws(() => mergeToolParams({ ...base, input: "null" }), /input must decode to a JSON object, got null/);
  assert.throws(() => mergeToolParams({ ...base, input: "true" }), /input must decode to a JSON object, got boolean/);
});

test("mergeToolParams names the offending field path on a type violation", () => {
  assert.throws(
    () => mergeToolParams({ direct: { task: "T" }, input: '{"model": 42}', fullSchema: SUBAGENT_FULL_PARAMS }),
    /Invalid input parameters: \/model: must be string/,
  );
});

test("mergeToolParams collapses a union violation to the allowed values with the field path", () => {
  assert.throws(
    () =>
      mergeToolParams({ direct: { task: "T" }, input: '{"thinkingOverride": "bogus"}', fullSchema: SUBAGENT_FULL_PARAMS }),
    /\/thinkingOverride: must be one of: "off", "minimal", "low", "medium", "high", "xhigh", "max"/,
  );
});

test("mergeToolParams rejects unknown keys in input by path", () => {
  assert.throws(
    () => mergeToolParams({ direct: { task: "T" }, input: '{"bogus": 1}', fullSchema: SUBAGENT_FULL_PARAMS }),
    /\/bogus: unknown parameter/,
  );
});

test("mergeToolParams validates nested input paths", () => {
  assert.throws(
    () => mergeToolParams({ direct: { task: "T" }, input: '{"tasks": [{"agent": 5}]}', fullSchema: SUBAGENT_FULL_PARAMS }),
    /\/tasks\/0\/agent: must be string/,
  );
});

test("mergeToolParams validates the research full contract (model + maxWallClockMs routed, unknown keys rejected)", () => {
  const merged = mergeToolParams({
    direct: { task: "Q", findingsPath: "/tmp/f.md" } as Record<string, unknown>,
    input: JSON.stringify({ model: "openai/gpt-x", maxWallClockMs: 5 * 60 * 1000 }),
    fullSchema: RESEARCH_FULL_PARAMS,
  });
  assert.equal(merged.model, "openai/gpt-x");
  assert.equal(merged.maxWallClockMs, 5 * 60 * 1000);
  assert.throws(
    () =>
      mergeToolParams({
        direct: { task: "Q", findingsPath: "/tmp/f.md" } as Record<string, unknown>,
        input: '{"steer": true}',
        fullSchema: RESEARCH_FULL_PARAMS,
      }),
    /\/steer: unknown parameter/,
  );
});

test("maxWallClockMs is a hidden positive integer that may only tighten the 60-minute default", () => {
  const direct = { task: "Q", findingsPath: "/tmp/f.md" } as Record<string, unknown>;
  // tighten: accepted
  const tight = mergeToolParams({
    direct,
    input: JSON.stringify({ maxWallClockMs: 60_000 }),
    fullSchema: RESEARCH_FULL_PARAMS,
  });
  assert.equal(tight.maxWallClockMs, 60_000);
  // the 60-minute ceiling itself: accepted
  const ceiling = mergeToolParams({
    direct,
    input: JSON.stringify({ maxWallClockMs: DEFAULT_RESEARCH_WALL_CLOCK_MS }),
    fullSchema: RESEARCH_FULL_PARAMS,
  });
  assert.equal(ceiling.maxWallClockMs, DEFAULT_RESEARCH_WALL_CLOCK_MS);
  // above the ceiling: rejected (tighten-only)
  assert.throws(
    () =>
      mergeToolParams({
        direct,
        input: JSON.stringify({ maxWallClockMs: DEFAULT_RESEARCH_WALL_CLOCK_MS + 1 }),
        fullSchema: RESEARCH_FULL_PARAMS,
      }),
    /maxWallClockMs/,
  );
  // non-positive or non-integer: rejected
  assert.throws(
    () => mergeToolParams({ direct, input: '{"maxWallClockMs": 0}', fullSchema: RESEARCH_FULL_PARAMS }),
    /maxWallClockMs/,
  );
  assert.throws(
    () => mergeToolParams({ direct, input: '{"maxWallClockMs": 1.5}', fullSchema: RESEARCH_FULL_PARAMS }),
    /maxWallClockMs/,
  );
});

// ---------------------------------------------------------------------------
// S22 — Seam D: surface contract tests (ADR 0011). The model-facing contract
// (tool names, required parameters, hidden parameters present only in the
// full schema) is asserted against the shared lib module — no fake pi is
// constructed (Path 1). The token-budget guard keeps the serialized surface
// (description + parameter schema, ceil(chars/4)) within baseline × 1.2 of
// the Seam E measurement recorded below.
// ---------------------------------------------------------------------------

// Seam E baseline — measured with `node scripts/benchmark-tools.ts`
// (separate pi process, empty config, before_agent_start, ceil(chars/4)).
// Per-tool tokens of description + serialized parameter schema, measured
// with pi 0.87.0 on 2026-09-22 after the ADR 0013 surface change (research
// lost budget/budgetOverrides, gained the hidden maxWallClockMs).
const TOKEN_BASELINE: Record<string, number> = { subagent: 630, research: 517 };

test("TOOL_CONTRACTS covers exactly the two frozen tool surfaces", () => {
  assert.deepEqual(TOOL_CONTRACTS.map((t) => t.name), ["subagent", "research"]);
});

test("subagent schema keeps its public fields and gains the input field", () => {
  const props = Object.keys(SUBAGENT_TOOL_PARAMS.properties ?? {});
  assert.deepEqual(
    new Set(props),
    new Set(["agent", "task", "tasks", "chain", "agentScope", "thinkingLevel", "cwd", "input"]),
  );
  assert.deepEqual(SUBAGENT_TOOL_PARAMS.required ?? [], [], "subagent has no required parameters");
});

test("research schema keeps its public fields and gains the input field, budget fields gone", () => {
  const props = Object.keys(RESEARCH_TOOL_PARAMS.properties ?? {});
  assert.deepEqual(
    new Set(props),
    new Set(["task", "findingsPath", "cwd", "tools", "agentScope", "thinkingLevel", "input"]),
  );
  assert.deepEqual(RESEARCH_TOOL_PARAMS.required ?? [], ["task", "findingsPath"]);
});

test("hidden parameters live only in the full schemas, never in the public ones", () => {
  for (const contract of TOOL_CONTRACTS) {
    const publicProps = Object.keys(contract.parameters.properties ?? {});
    const fullProps = Object.keys(contract.fullParameters.properties ?? {});
    for (const key of contract.hiddenKeys) {
      assert.ok(fullProps.includes(key), `${contract.name} full schema carries hidden ${key}`);
      assert.ok(!publicProps.includes(key), `${contract.name} public schema hides ${key}`);
    }
    assert.ok(!fullProps.includes("input"), `${contract.name} full schema consumes the transport field`);
  }
  assert.deepEqual(SUBAGENT_INPUT_KEYS, ["model", "thinkingOverride"]);
  assert.deepEqual(RESEARCH_INPUT_KEYS, ["model", "maxWallClockMs"]);
});

test("the registered descriptions match the frozen surface", () => {
  assert.ok(SUBAGENT_TOOL_DESCRIPTION.startsWith("Delegate tasks to specialized subagents"));
  assert.ok(RESEARCH_TOOL_DESCRIPTION.startsWith("Run a background research subagent"));
  assert.ok(RESEARCH_TOOL_DESCRIPTION.includes("pushed"), "the description advertises push delivery");
  assert.ok(!RESEARCH_TOOL_DESCRIPTION.includes("budget"), "the description no longer mentions budget tiers");
  assert.equal(TOOL_CONTRACTS.find((t) => t.name === "subagent")?.description, SUBAGENT_TOOL_DESCRIPTION);
  assert.equal(TOOL_CONTRACTS.find((t) => t.name === "research")?.description, RESEARCH_TOOL_DESCRIPTION);
});

test("estimateToolSurfaceTokens uses ceil(chars / 4) on description + serialized schema", () => {
  const contract = TOOL_CONTRACTS[0];
  const tokens = estimateToolSurfaceTokens({ description: contract.description, parameters: contract.parameters });
  const chars = JSON.stringify({ description: contract.description, parameters: contract.parameters }).length;
  assert.equal(tokens, Math.ceil(chars / 4));
});

test("model-facing tool surface stays within baseline × 1.2 (token regression guard)", () => {
  for (const contract of TOOL_CONTRACTS) {
    const tokens = estimateToolSurfaceTokens({ description: contract.description, parameters: contract.parameters });
    const ceiling = TOKEN_BASELINE[contract.name] * TOKEN_GUARD_MULTIPLIER;
    assert.ok(
      tokens <= ceiling,
      `${contract.name} model-facing surface is ${tokens} tokens, over the ${ceiling} guard ceiling ` +
        `(baseline ${TOKEN_BASELINE[contract.name]} × ${TOKEN_GUARD_MULTIPLIER})`,
    );
  }
});

// ---------------------------------------------------------------------------
// S23 — buildSubagentEnv: the pure env builder for blocking spawns. The base
// environment is fully preserved (inheritance), the marker is present exactly
// when a parent session id is given, and absent otherwise (a manual top-level
// run carries none). The env-var name is the frozen gotgenes out-of-process
// convention; the function itself never reads the marker back.
// ---------------------------------------------------------------------------

test("buildSubagentEnv preserves the base environment and adds the marker with an id", () => {
  const base = { HOME: "/home/u", PATH: "/usr/bin", EMPTY: "" };
  const env = buildSubagentEnv(base, "session-123");
  assert.ok(env !== base, "returns a fresh map, not the caller's object");
  // every base key/value survives
  assert.equal(env.HOME, "/home/u");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.EMPTY, "");
  // the marker names the parent session
  assert.equal(env[SUBAGENT_PARENT_SESSION_ENV], "session-123");
});

test("buildSubagentEnv omits the marker when no id is given", () => {
  const base: NodeJS.ProcessEnv = { HOME: "/home", ALREADY: "set" };
  const env = buildSubagentEnv(base);
  assert.deepEqual(env, base, "an unchanged copy of the base");
  assert.ok(env !== base, "still a copy, not the caller's object");
  assert.equal(env[SUBAGENT_PARENT_SESSION_ENV], undefined);
});

test("buildSubagentEnv never mutates the caller's base", () => {
  const base = { HOME: "/home" };
  const snapshot = { ...base };
  buildSubagentEnv(base, "sess");
  buildSubagentEnv(base);
  assert.deepEqual(base, snapshot, "the caller's object is untouched");
});
