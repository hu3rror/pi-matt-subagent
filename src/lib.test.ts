import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildResearchArgs,
  buildResearchPrompt,
  discoverAgents,
  emptyUsage,
  resolveRole,
  resolveThinkingLevel,
  resolveTools,
  runBackgroundResearch,
  scopeAllowsProject,
  type AgentConfig,
  type FrontmatterParser,
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
// The S8 role-level expectations below are literals for the same reason: a
// regression to a uniform level is caught here rather than in the fixtures.
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

test("resolveThinkingLevel prefers a per-call override over role and inherited levels", () => {
  assert.equal(resolveThinkingLevel({ hasModel: false, override: "low", roleLevel: "medium", inherited: "high" }), "low");
});

test("resolveThinkingLevel falls back to the role level, then the inherited level", () => {
  assert.equal(resolveThinkingLevel({ hasModel: false, roleLevel: "medium", inherited: "high" }), "medium");
  assert.equal(resolveThinkingLevel({ hasModel: false, inherited: "high" }), "high");
  assert.equal(resolveThinkingLevel({ hasModel: false }), undefined);
});

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
