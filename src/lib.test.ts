import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildResearchPrompt,
  discoverAgents,
  emptyUsage,
  resolveRole,
  resolveTools,
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
