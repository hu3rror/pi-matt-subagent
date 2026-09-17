import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendResearchTerminationMarker,
  blockingRunStatus,
  buildResearchArgs,
  buildResearchPrompt,
  createRunRegistry,
  discoverAgents,
  emptyUsage,
  evaluateResearchRun,
  formatRunSnapshot,
  readLogTail,
  RESEARCH_BUDGETS,
  resolveEffectiveResearchBudget,
  resolveResearchBudget,
  resolveResearchRunStatus,
  resolveRole,
  resolveThinkingLevel,
  resolveTools,
  runBackgroundResearch,
  RUN_STATUS_ICONS,
  RUN_STATUSES,
  scopeAllowsProject,
  startResearchWatcher,
  TOOL_ALIASES,
  type AgentConfig,
  type FrontmatterParser,
  type LogTailFs,
  type ResearchBudgetOverrides,
  type ResearchBudgetTier,
  type ResearchChild,
  type RunEntry,
} from "./lib.ts";

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

// S5 — buildResearchPrompt
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

// S6 — buildResearchArgs
function embeddedResearcher(): AgentConfig {
  return { name: "researcher", description: "", source: "embedded", systemPrompt: "SP" };
}

// Expected tool list for the default research set after platform mapping.
// Deliberately a literal, not derived from DEFAULT_RESEARCH_TOOLS, so the
// mapping is verified independently of the implementation.
const TOOLS_EXPECTED = process.platform === "win32" ? ["read", "grep", "find", "ls", "powershell", "write"] : ["read", "grep", "find", "ls", "bash", "write"];

test("buildResearchArgs prefixes the fixed pi flags", () => {
  const args = buildResearchArgs({
    agent: embeddedResearcher(),
    task: "T",
    findingsPath: "/tmp/f.md",
    promptPath: "/tmp/p.md",
  });
  assert.deepEqual(args.slice(0, 4), ["--mode", "json", "-p", "--no-session"]);
});

test("buildResearchArgs renders model and thinkingLevel when given", () => {
  const args = buildResearchArgs({
    agent: embeddedResearcher(),
    task: "T",
    findingsPath: "/tmp/f.md",
    model: "p/m",
    thinkingLevel: "low",
    promptPath: "/tmp/p.md",
  });
  assert.ok(args.includes("--model") && args[args.indexOf("--model") + 1] === "p/m");
  assert.ok(args.includes("--thinking") && args[args.indexOf("--thinking") + 1] === "low");
});

test("buildResearchArgs defaults tools to the research set, mapped for the platform", () => {
  const args = buildResearchArgs({
    agent: embeddedResearcher(),
    task: "T",
    findingsPath: "/tmp/f.md",
    promptPath: "/tmp/p.md",
  });
  const i = args.indexOf("--tools");
  assert.ok(i >= 0);
  assert.deepEqual(args[i + 1].split(","), TOOLS_EXPECTED);
});

test("buildResearchArgs honors explicit tools over role defaults", () => {
  const args = buildResearchArgs({
    agent: embeddedResearcher(),
    task: "T",
    findingsPath: "/tmp/f.md",
    tools: ["read", "write"],
    promptPath: "/tmp/p.md",
  });
  const i = args.indexOf("--tools");
  assert.deepEqual(args[i + 1].split(","), ["read", "write"]);
});

test("buildResearchArgs degrades fff tool names against the given registry", () => {
  const args = buildResearchArgs({
    agent: embeddedResearcher(),
    task: "T",
    findingsPath: "/tmp/f.md",
    tools: ["ffgrep", "ffind", "ls"],
    availableToolNames: new Set(["grep", "find", "ls"]),
    promptPath: "/tmp/p.md",
  });
  const i = args.indexOf("--tools");
  assert.deepEqual(args[i + 1].split(","), ["grep", "find", "ls"]);
});

test("buildResearchArgs routes the prompt file via --append-system-prompt and keeps the task positional", () => {
  const args = buildResearchArgs({
    agent: embeddedResearcher(),
    task: "investigate X",
    findingsPath: "/tmp/f.md",
    promptPath: "/tmp/p.md",
  });
  const i = args.indexOf("--append-system-prompt");
  assert.ok(i >= 0);
  assert.equal(args[i + 1], "/tmp/p.md");
  assert.equal(args[args.length - 1], "Task: investigate X");
  assert.ok(
    !args.some((a) => a.includes("/tmp/f.md")),
    "findings path must not leak into argv (it lives in the prompt file instead)",
  );
  assert.ok(
    !args.some((a) => a.includes("SP")),
    "role prompt text must not leak into argv (it lives in the prompt file instead)",
  );
});

// AgentScope helpers
test("scopeAllowsProject is true only for project and both", () => {
  assert.equal(scopeAllowsProject("user"), false);
  assert.equal(scopeAllowsProject("project"), true);
  assert.equal(scopeAllowsProject("both"), true);
});

// S7 — runBackgroundResearch
test("runBackgroundResearch backgrounds the researcher, wiring the log fd, and returns a handle", (t) => {
  const calls: Array<{ cmd: string; args: string[]; opts: { detached?: boolean; shell?: boolean; cwd?: string; stdio?: unknown[] } }> = [];
  const unrefCalls: boolean[] = [];
  const fakeSpawn = (cmd: string, args: string[], opts: { detached?: boolean; shell?: boolean; cwd?: string; stdio?: unknown[] }) => {
    calls.push({ cmd, args, opts });
    return {
      unref: () => {
        unrefCalls.push(true);
      },
    };
  };
  const agents: AgentConfig[] = [embeddedResearcher()];

  const handle = runBackgroundResearch(
    {
      cwd: "/w",
      model: "p/m",
      thinkingLevel: "low",
      tools: ["read", "write"],
      task: "T",
      findingsPath: "/tmp/f.md",
      agents,
    },
    fakeSpawn as never,
  );
  t.after(() => {
    fs.rmSync(path.dirname(handle.logPath), { recursive: true, force: true });
  });

  // handle shape: researchId names the tmp dir, logPath is a research.log inside it
  assert.equal(handle.findingsPath, "/tmp/f.md");
  assert.match(handle.researchId, /^pi-research-/);
  assert.match(handle.logPath, /research\.log$/);
  assert.ok(handle.logPath.includes(handle.researchId));

  // exactly one spawn, with background semantics
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.opts.detached, true);
  assert.equal(c.opts.shell, false);
  assert.equal(c.opts.cwd, "/w");
  assert.equal(c.opts.stdio[0], "ignore");
  assert.equal(typeof c.opts.stdio[1], "number");
  assert.equal(c.opts.stdio[1], c.opts.stdio[2]); // stdout+stderr share the log fd
  assert.equal(unrefCalls.length, 1);

  // args routed through buildResearchArgs (token presence; exact structure is Seam A's job, and
  // getPiInvocation prepends the current script under node --test)
  assert.ok(c.args.includes("--mode"));
  assert.ok(c.args.includes("--model"));
  assert.ok(c.args.includes("--tools"));
  assert.ok(c.args.includes("--append-system-prompt"));

  // the prompt file sits next to the log and carries role prompt + findings path
  const promptFile = path.join(path.dirname(handle.logPath), "prompt.md");
  const promptText = fs.readFileSync(promptFile, "utf8");
  assert.ok(promptText.includes("SP"), "role system prompt should be in the file");
  assert.ok(promptText.includes("/tmp/f.md"), "findings path should be in the file, not argv");
  assert.ok(promptText.includes("T"), "task should be in the file");
});

test("runBackgroundResearch throws when no researcher role is available", () => {
  const fakeSpawn = () => {
    throw new Error("must not spawn");
  };
  assert.throws(
    () =>
      runBackgroundResearch(
        { cwd: "/w", task: "T", findingsPath: "/tmp/f.md", agents: [] },
        fakeSpawn as never,
      ),
    /No "researcher" role available/,
  );
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

// S9 — research budget (D4). Literals, not derived from RESEARCH_BUDGETS: the
// tier table was frozen in the design session (ADR 0003) and a regression to
// different numbers is caught here.
test("RESEARCH_BUDGETS freezes the tier table at the agreed values", () => {
  assert.deepEqual(RESEARCH_BUDGETS.standard, {
    maxSearchRounds: 10,
    maxFetchPages: 20,
    maxFindingLines: 500,
    maxLogBytes: 8 * 1024 * 1024,
    maxWallClockMs: 15 * 60 * 1000,
  });
  assert.deepEqual(RESEARCH_BUDGETS.tight, {
    maxSearchRounds: 5,
    maxFetchPages: 8,
    maxFindingLines: 200,
    maxLogBytes: 2 * 1024 * 1024,
    maxWallClockMs: 5 * 60 * 1000,
  });
});

test("resolveResearchBudget returns the tier defaults when no overrides are given", () => {
  assert.deepEqual(resolveResearchBudget("standard"), RESEARCH_BUDGETS.standard);
  assert.deepEqual(resolveResearchBudget("tight"), RESEARCH_BUDGETS.tight);
});

test("resolveResearchBudget merges overrides over tier defaults", () => {
  const b = resolveResearchBudget("standard", { maxFetchPages: 6, maxFindingLines: 100 });
  assert.equal(b.maxFetchPages, 6);
  assert.equal(b.maxFindingLines, 100);
  assert.equal(b.maxLogBytes, RESEARCH_BUDGETS.standard.maxLogBytes); // untouched dim
  assert.equal(b.maxWallClockMs, RESEARCH_BUDGETS.standard.maxWallClockMs);
});

test("resolveResearchBudget allows tightening a hard cap within the ceiling", () => {
  const b = resolveResearchBudget("standard", { maxLogBytes: 1024 * 1024, maxWallClockMs: 5 * 60 * 1000 });
  assert.equal(b.maxLogBytes, 1024 * 1024);
  assert.equal(b.maxWallClockMs, 5 * 60 * 1000);
});

test("resolveResearchBudget rejects a hard override above the tier ceiling", () => {
  assert.throws(() => resolveResearchBudget("standard", { maxLogBytes: 16 * 1024 * 1024 }), /may only be tightened/);
  assert.throws(() => resolveResearchBudget("tight", { maxWallClockMs: 20 * 60 * 1000 }), /may only be tightened/);
});

test("resolveResearchBudget rejects non-positive or non-integer overrides", () => {
  assert.throws(() => resolveResearchBudget("standard", { maxSearchRounds: 0 }), /positive/);
  assert.throws(() => resolveResearchBudget("standard", { maxFetchPages: -1 }), /positive/);
  assert.throws(() => resolveResearchBudget("standard", { maxFindingLines: 1.5 }), /positive/);
});

test("resolveResearchBudget rejects an unknown tier", () => {
  assert.throws(() => resolveResearchBudget("deep" as ResearchBudgetTier), /Unknown research budget tier/);
});

test("resolveResearchBudget rejects an unknown override key", () => {
  assert.throws(
    () => resolveResearchBudget("standard", { maxDepth: 5 } as unknown as ResearchBudgetOverrides),
    /Unknown budget override key/,
  );
});

test("resolveEffectiveResearchBudget always yields a budget: call tier > role tier > system default", () => {
  // role has no tier -> system default standard
  assert.deepEqual(resolveEffectiveResearchBudget({}), RESEARCH_BUDGETS.standard);
  assert.deepEqual(resolveEffectiveResearchBudget({ roleTier: undefined }), RESEARCH_BUDGETS.standard);
  // role tier applies when no per-call tier
  assert.deepEqual(resolveEffectiveResearchBudget({ roleTier: "tight" }), RESEARCH_BUDGETS.tight);
  // per-call tier beats the role tier
  assert.deepEqual(
    resolveEffectiveResearchBudget({ tier: "standard", roleTier: "tight" }),
    RESEARCH_BUDGETS.standard,
  );
  // overrides still apply on top
  const b = resolveEffectiveResearchBudget({ roleTier: "tight", overrides: { maxSearchRounds: 3 } });
  assert.equal(b.maxSearchRounds, 3);
  assert.equal(b.maxFetchPages, RESEARCH_BUDGETS.tight.maxFetchPages);
});

// S10 — evaluateResearchRun (hard-cap decision). 100% line = warn, 110% line
// = kill; a kill records only the caps that caused it, a warn only the caps
// that crossed 100% but not 110%.
test("evaluateResearchRun continues below both 100% lines", () => {
  const b = RESEARCH_BUDGETS.standard;
  assert.deepEqual(evaluateResearchRun(0, 0, 0, b), { action: "continue", caps: [] });
  assert.deepEqual(evaluateResearchRun(1_000, 0, b.maxLogBytes - 1, b), { action: "continue", caps: [] });
});

test("evaluateResearchRun warns at exactly 100% of the log cap", () => {
  const b = RESEARCH_BUDGETS.standard;
  assert.deepEqual(evaluateResearchRun(0, 0, b.maxLogBytes, b), { action: "warn", caps: ["log_bytes"] });
});

test("evaluateResearchRun warns between 100% and 110% of the log cap", () => {
  const b = RESEARCH_BUDGETS.standard;
  assert.deepEqual(evaluateResearchRun(0, 0, Math.floor(b.maxLogBytes * 1.05), b), {
    action: "warn",
    caps: ["log_bytes"],
  });
});

test("evaluateResearchRun kills at 110% of the log cap", () => {
  const b = RESEARCH_BUDGETS.standard;
  assert.deepEqual(evaluateResearchRun(0, 0, Math.ceil(b.maxLogBytes * 1.1), b), {
    action: "kill",
    caps: ["log_bytes"],
  });
});

test("evaluateResearchRun warns at 100% of the wall clock cap", () => {
  const b = RESEARCH_BUDGETS.standard;
  assert.deepEqual(evaluateResearchRun(b.maxWallClockMs, 0, 0, b), { action: "warn", caps: ["wall_clock"] });
});

test("evaluateResearchRun kills at 110% of the wall clock cap", () => {
  const b = RESEARCH_BUDGETS.standard;
  assert.deepEqual(evaluateResearchRun(Math.ceil(b.maxWallClockMs * 1.1), 0, 0, b), {
    action: "kill",
    caps: ["wall_clock"],
  });
});

test("evaluateResearchRun records both caps when both exceed 110%", () => {
  const b = RESEARCH_BUDGETS.standard;
  assert.deepEqual(
    evaluateResearchRun(Math.ceil(b.maxWallClockMs * 1.2), 0, Math.ceil(b.maxLogBytes * 1.2), b),
    { action: "kill", caps: ["log_bytes", "wall_clock"] },
  );
});

test("evaluateResearchRun prefers kill over warn and keeps only the kill reasons", () => {
  const b = RESEARCH_BUDGETS.standard;
  // log at 120% (kill), wall clock at exactly 100% (would warn) -> kill with only log_bytes
  assert.deepEqual(evaluateResearchRun(b.maxWallClockMs, 0, Math.ceil(b.maxLogBytes * 1.2), b), {
    action: "kill",
    caps: ["log_bytes"],
  });
});

// S11 — appendResearchTerminationMarker. Expected strings are hand-written
// literals (the frozen format), not derived from the implementation.
test("appendResearchTerminationMarker appends the frozen marker for a log-cap kill", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const findingsPath = path.join(dir, "findings.md");
  try {
    fs.writeFileSync(findingsPath, "# Findings\n\nsome content\n");
    appendResearchTerminationMarker(findingsPath, {
      entries: [{ cap: "log_bytes", limit: 8 * 1024 * 1024, observed: Math.floor(8.83 * 1024 * 1024) }],
      at: "2026-09-17T10:00:00.000Z",
    });
    const text = fs.readFileSync(findingsPath, "utf8");
    assert.ok(text.includes("<!-- research-terminated"));
    assert.ok(text.includes("reason: log_bytes_exceeded"));
    assert.ok(text.includes("partial: true"));
    assert.ok(text.includes("limit: 8 MiB"));
    assert.ok(text.includes("observed: 8.83 MiB"));
    assert.ok(text.includes("at: 2026-09-17T10:00:00.000Z"));
    assert.ok(text.includes("-->"), "marker must be closed");
    assert.ok(text.includes("some content"), "existing findings content is preserved");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("appendResearchTerminationMarker creates the findings file when it does not exist", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const findingsPath = path.join(dir, "findings.md");
  try {
    appendResearchTerminationMarker(findingsPath, {
      entries: [{ cap: "wall_clock", limit: 5 * 60 * 1000, observed: 5 * 60 * 1000 + 12_000 }],
      at: "2026-09-17T10:00:00.000Z",
    });
    const text = fs.readFileSync(findingsPath, "utf8");
    assert.ok(text.includes("reason: wall_clock_exceeded"));
    assert.ok(text.includes("limit: 5 min"));
    assert.ok(text.includes("observed: 5.2 min"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("appendResearchTerminationMarker records both caps with per-cap units, comma-joined", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const findingsPath = path.join(dir, "findings.md");
  try {
    appendResearchTerminationMarker(findingsPath, {
      entries: [
        { cap: "log_bytes", limit: 8 * 1024 * 1024, observed: Math.floor(8.83 * 1024 * 1024) },
        { cap: "wall_clock", limit: 15 * 60 * 1000, observed: 16.2 * 60 * 1000 },
      ],
      at: "2026-09-17T10:00:00.000Z",
    });
    const text = fs.readFileSync(findingsPath, "utf8");
    assert.ok(text.includes("reason: log_bytes_exceeded, wall_clock_exceeded"));
    assert.ok(text.includes("limit: 8 MiB, 15 min"));
    assert.ok(text.includes("observed: 8.83 MiB, 16.2 min"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("appendResearchTerminationMarker formats small values in B/KiB and seconds", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const findingsPath = path.join(dir, "findings.md");
  try {
    appendResearchTerminationMarker(findingsPath, {
      entries: [
        { cap: "log_bytes", limit: 1024, observed: 2048 },
        { cap: "wall_clock", limit: 1000, observed: 2200 },
      ],
      at: "2026-09-17T10:00:00.000Z",
    });
    const text = fs.readFileSync(findingsPath, "utf8");
    assert.ok(text.includes("limit: 1 KiB, 1 s"));
    assert.ok(text.includes("observed: 2 KiB, 2.2 s"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// S12 — budget block in the research prompt (D4). The block carries the soft
// dimension numbers + the wall-clock number (self-managed by the model), the
// enough-to-answer rule, and the wind-down / soft_limit_exceeded behaviour.
test("buildResearchPrompt appends the budget block when a budget is given", () => {
  const agent: AgentConfig = { name: "researcher", description: "", source: "embedded", systemPrompt: "SP" };
  const p = buildResearchPrompt(agent, "do the thing", "/tmp/out.md", RESEARCH_BUDGETS.standard);
  assert.ok(p.includes("SP"));
  assert.ok(p.includes("/tmp/out.md"));
  assert.ok(p.includes("do the thing"));
  assert.ok(p.includes("search rounds: at most 10"));
  assert.ok(p.includes("fetch pages (total): at most 20"));
  assert.ok(p.includes("findings: at most 500 lines"));
  assert.ok(p.includes("wall clock: at most 15 min"));
  assert.ok(p.includes("enough-to-answer"), "the enough-to-answer rule must be in the prompt");
  assert.ok(p.includes("wind-down"), "wind-down behaviour must be in the prompt");
  assert.ok(p.includes("soft_limit_exceeded"), "the soft-limit marker format must be in the prompt");
});

test("buildResearchPrompt budget block reflects the tight tier numbers", () => {
  const agent: AgentConfig = { name: "researcher", description: "", source: "embedded", systemPrompt: "SP" };
  const p = buildResearchPrompt(agent, "T", "/tmp/out.md", RESEARCH_BUDGETS.tight);
  assert.ok(p.includes("search rounds: at most 5"));
  assert.ok(p.includes("fetch pages (total): at most 8"));
  assert.ok(p.includes("findings: at most 200 lines"));
  assert.ok(p.includes("wall clock: at most 5 min"));
});

test("buildResearchPrompt without a budget stays unchanged", () => {
  const agent: AgentConfig = { name: "researcher", description: "", source: "embedded", systemPrompt: "SP" };
  const p = buildResearchPrompt(agent, "T", "/tmp/out.md");
  assert.ok(!p.includes("Research budget"));
});

// S13 — budget tier on roles (frontmatter, same pattern as thinkingLevel).
test("embedded researcher role declares the standard budget tier", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  try {
    const { agents } = discoverAgents(root, path.join(root, "agentDir"), ".pi", "user", stubParser);
    assert.equal(agents.find((a) => a.name === "researcher")?.budget, "standard");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a user agent frontmatter can set a custom budget tier", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const agentDir = path.join(root, "agentDir");
  try {
    fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "agents", "researcher.md"),
      "---\nname: researcher\ndescription: custom\nbudget: tight\n---\nCUSTOM PROMPT\n",
    );
    const { agents } = discoverAgents(root, agentDir, ".pi", "user", stubParser);
    const r = agents.find((a) => a.name === "researcher");
    assert.ok(r);
    assert.equal(r.budget, "tight");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a user agent frontmatter with an invalid budget tier is ignored", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const agentDir = path.join(root, "agentDir");
  try {
    fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "agents", "researcher.md"),
      "---\nname: researcher\ndescription: custom\nbudget: deep\n---\nCUSTOM PROMPT\n",
    );
    const { agents } = discoverAgents(root, agentDir, ".pi", "user", stubParser);
    const r = agents.find((a) => a.name === "researcher");
    assert.ok(r);
    assert.equal(r.budget, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// S14 — runBackgroundResearch budget integration + startResearchWatcher.
// Fake deps make the watcher deterministic: immediate check + manual ticks.
test("runBackgroundResearch with a budget embeds the budget block and starts a watcher", (t) => {
  const fakeSpawn = () => ({ unref() {}, kill: () => true, exitCode: null as number | null });
  let tick: (() => void) | undefined;
  const handle = runBackgroundResearch(
    {
      cwd: "/w",
      task: "T",
      findingsPath: "/tmp/f.md",
      agents: [embeddedResearcher()],
      budget: RESEARCH_BUDGETS.tight,
      watcherDeps: {
        now: () => 0,
        stat: () => ({ size: 0 }),
        setInterval: (fn: () => void) => {
          tick = fn;
          return { unref() {} } as never;
        },
        clearInterval: () => {},
      },
    },
    fakeSpawn as never,
  );
  t.after(() => {
    fs.rmSync(path.dirname(handle.logPath), { recursive: true, force: true });
  });

  const promptText = fs.readFileSync(path.join(path.dirname(handle.logPath), "prompt.md"), "utf8");
  assert.ok(promptText.includes("Research budget"), "budget block must reach the prompt file");
  assert.ok(promptText.includes("search rounds: at most 5"), "tight numbers must reach the prompt file");
  assert.ok(typeof tick === "function", "a watcher interval must be scheduled when a budget is present");
});

test("startResearchWatcher kills the child and appends the termination marker when the log cap is exceeded", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const logPath = path.join(dir, "research.log");
  const findingsPath = path.join(dir, "findings.md");
  try {
    fs.writeFileSync(logPath, "x".repeat(4096));
    const killed: string[] = [];
    const child: ResearchChild = {
      unref() {},
      kill: (s) => {
        killed.push(s ?? "");
        return true;
      },
      exitCode: null,
    };
    const budget = { ...RESEARCH_BUDGETS.standard, maxLogBytes: 1024 };
    startResearchWatcher({
      child,
      logPath,
      findingsPath,
      budget,
      startedAt: 1000,
      deps: {
        now: () => 1000,
        stat: (p) => (p === logPath ? { size: 4096 } : undefined),
        setInterval: () => ({ unref() {} }) as never,
        clearInterval: () => {},
      },
    });
    // immediate check: 4096 > 1.1 * 1024 -> kill before any tick
    assert.deepEqual(killed, ["SIGKILL"]);
    const text = fs.readFileSync(findingsPath, "utf8");
    assert.ok(text.includes("research-terminated"));
    assert.ok(text.includes("reason: log_bytes_exceeded"));
    assert.ok(text.includes("limit: 1 KiB"));
    assert.ok(text.includes("observed: 4 KiB"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("startResearchWatcher warns once on the log dimension at 100% and does not kill", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const logPath = path.join(dir, "research.log");
  const findingsPath = path.join(dir, "findings.md");
  try {
    fs.writeFileSync(logPath, "");
    const killed: string[] = [];
    const child: ResearchChild = {
      unref() {},
      kill: (s) => {
        killed.push(s ?? "");
        return true;
      },
      exitCode: null,
    };
    let tick: (() => void) | undefined;
    const budget = { ...RESEARCH_BUDGETS.standard, maxLogBytes: 1024 };
    startResearchWatcher({
      child,
      logPath,
      findingsPath,
      budget,
      startedAt: 0,
      deps: {
        now: () => 0,
        stat: () => ({ size: 1024 }), // exactly 100% of the log cap
        setInterval: (fn: () => void) => {
          tick = fn;
          return { unref() {} } as never;
        },
        clearInterval: () => {},
      },
    });
    tick?.();
    tick?.();
    const logText = fs.readFileSync(logPath, "utf8");
    assert.equal((logText.match(/approaching cap/g) ?? []).length, 1, "the 100% warning must be written exactly once");
    assert.deepEqual(killed, [], "warn must not kill");
    assert.ok(!fs.existsSync(findingsPath), "no termination marker without a kill");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("startResearchWatcher writes the human-readable kill reason to the log tail", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const logPath = path.join(dir, "research.log");
  const findingsPath = path.join(dir, "findings.md");
  try {
    fs.writeFileSync(logPath, "");
    const killed: string[] = [];
    const child: ResearchChild = {
      unref() {},
      kill: (s) => {
        killed.push(s ?? "");
        return true;
      },
      exitCode: null,
    };
    const budget = { ...RESEARCH_BUDGETS.standard, maxLogBytes: 1024, maxWallClockMs: 60_000 };
    startResearchWatcher({
      child,
      logPath,
      findingsPath,
      budget,
      startedAt: 0,
      deps: {
        now: () => 4000,
        stat: () => ({ size: 2048 }), // 2x cap -> kill; wall clock 4s < 110% of 60s
        setInterval: () => ({ unref() {} }) as never,
        clearInterval: () => {},
      },
    });
    assert.deepEqual(killed, ["SIGKILL"]);
    const logText = fs.readFileSync(logPath, "utf8");
    assert.ok(logText.includes("[research-budget] killed: log exceeded 2 KiB (cap 1 KiB) at 110%"), "kill reason must be in the log tail");
    // 100% warning happens only if a tick saw [100%,110%); the kill jump skips it
    assert.ok(!logText.includes("approaching cap"), "no 100% warning when log jumps straight past 110%");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("startResearchWatcher does not surface the wall-clock 100% line (model self-manages it)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const logPath = path.join(dir, "research.log");
  const findingsPath = path.join(dir, "findings.md");
  try {
    fs.writeFileSync(logPath, "");
    const killed: string[] = [];
    const child: ResearchChild = {
      unref() {},
      kill: (s) => {
        killed.push(s ?? "");
        return true;
      },
      exitCode: null,
    };
    const budget = { ...RESEARCH_BUDGETS.standard, maxLogBytes: 64 * 1024 * 1024 }; // log far from cap
    startResearchWatcher({
      child,
      logPath,
      findingsPath,
      budget,
      startedAt: 0,
      deps: {
        now: () => budget.maxWallClockMs, // exactly 100% of the wall clock cap
        stat: () => ({ size: 0 }),
        setInterval: () => ({ unref() {} }) as never,
        clearInterval: () => {},
      },
    });
    assert.deepEqual(killed, [], "wall-clock warn must not kill");
    const logText = fs.readFileSync(logPath, "utf8");
    assert.ok(!logText.includes("[research-budget]"), "no runner warning for the wall-clock dimension (ADR 0003)");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("startResearchWatcher stops itself when the child has already exited", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const logPath = path.join(dir, "research.log");
  const findingsPath = path.join(dir, "findings.md");
  try {
    fs.writeFileSync(logPath, "");
    const killed: string[] = [];
    let scheduled = false;
    const child: ResearchChild = {
      unref() {},
      kill: (s) => {
        killed.push(s ?? "");
        return true;
      },
      exitCode: 0,
    };
    startResearchWatcher({
      child,
      logPath,
      findingsPath,
      budget: RESEARCH_BUDGETS.standard,
      startedAt: 0,
      deps: {
        now: () => 0,
        stat: () => ({ size: 10 * 1024 * 1024 }), // would kill if the child were alive
        setInterval: () => {
          scheduled = true;
          return { unref() {} } as never;
        },
        clearInterval: () => {},
      },
    });
    assert.deepEqual(killed, [], "an exited child must not be killed");
    assert.ok(!scheduled, "no ticks must be scheduled for an already-exited child");
    assert.ok(!fs.existsSync(findingsPath), "no termination marker for an exited child");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// S15 — startResearchWatcher onExit (D3). The runner must tell the caller
// when the child is done, both on natural exit and on a hard-cap kill, with
// the marker written before the kill-path callback fires (the caller
// distinguishes terminated from failed by the marker).
test("startResearchWatcher calls onExit with killed:false when the child exits naturally", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const logPath = path.join(dir, "research.log");
  const findingsPath = path.join(dir, "findings.md");
  try {
    fs.writeFileSync(logPath, "");
    const exits: Array<{ exitCode: number | null; killed: boolean }> = [];
    const child: ResearchChild = {
      unref() {},
      kill: () => true,
      exitCode: 0,
    };
    startResearchWatcher({
      child,
      logPath,
      findingsPath,
      budget: RESEARCH_BUDGETS.standard,
      startedAt: 0,
      deps: {
        now: () => 0,
        stat: () => ({ size: 0 }),
        setInterval: () => ({ unref() {} }) as never,
        clearInterval: () => {},
      },
      onExit: (info) => exits.push(info),
    });
    assert.deepEqual(exits, [{ exitCode: 0, killed: false }], "natural exit must be reported exactly once");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("startResearchWatcher calls onExit with killed:true after a hard-cap kill, marker first", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  const logPath = path.join(dir, "research.log");
  const findingsPath = path.join(dir, "findings.md");
  try {
    fs.writeFileSync(logPath, "");
    const killed: string[] = [];
    let markerSeenAtCallback = false;
    const child: ResearchChild = {
      unref() {},
      kill: (s) => {
        killed.push(s ?? "");
        return true;
      },
      exitCode: null,
    };
    const budget = { ...RESEARCH_BUDGETS.standard, maxLogBytes: 1024 };
    const exits: Array<{ exitCode: number | null; killed: boolean }> = [];
    startResearchWatcher({
      child,
      logPath,
      findingsPath,
      budget,
      startedAt: 0,
      deps: {
        now: () => 0,
        stat: () => ({ size: 4096 }), // 4x cap -> kill on the immediate check
        setInterval: () => ({ unref() {} }) as never,
        clearInterval: () => {},
      },
      onExit: (info) => {
        markerSeenAtCallback = fs.existsSync(findingsPath) && fs.readFileSync(findingsPath, "utf8").includes("research-terminated");
        exits.push(info);
      },
    });
    assert.deepEqual(killed, ["SIGKILL"]);
    assert.deepEqual(exits, [{ exitCode: null, killed: true }], "kill must be reported exactly once");
    assert.ok(markerSeenAtCallback, "the termination marker must be on disk before onExit fires");
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
// semantics + the abort flag; resolveResearchRunStatus maps watcher exit
// info, distinguishing terminated (kill + marker) from failed.
test("blockingRunStatus maps a single result to a run status", () => {
  assert.equal(blockingRunStatus({ exitCode: 0, stopReason: "end" }), "succeeded");
  assert.equal(blockingRunStatus({ exitCode: 0 }), "succeeded");
  assert.equal(blockingRunStatus({ exitCode: 1 }), "failed");
  assert.equal(blockingRunStatus({ exitCode: 0, stopReason: "error" }), "failed");
  assert.equal(blockingRunStatus({ exitCode: 0, stopReason: "aborted" }), "aborted");
  assert.equal(blockingRunStatus({ exitCode: 1, aborted: true }), "aborted", "abort wins over exit code");
});

test("resolveResearchRunStatus maps watcher exit info to a run status", () => {
  assert.equal(resolveResearchRunStatus({ killed: false, exitCode: 0 }), "succeeded");
  assert.equal(resolveResearchRunStatus({ killed: false, exitCode: 1 }), "failed");
  assert.equal(resolveResearchRunStatus({ killed: true, findingsText: "<!-- research-terminated" }), "terminated");
  assert.equal(resolveResearchRunStatus({ killed: true, findingsText: "# no marker" }), "failed", "kill without marker is a failure");
});
