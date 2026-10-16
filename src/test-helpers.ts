import type { AgentConfig, ResearchChildSession } from "./lib.ts";

/** A fake researcher role config shared by the lib and e2e test suites. */
export function embeddedResearcher(): AgentConfig {
  return { name: "researcher", description: "", source: "embedded", systemPrompt: "SP" };
}

/** A fake child session whose behavior tests configure per test. */
export function fakeChild(overrides: Partial<ResearchChildSession> = {}): ResearchChildSession {
  return {
    output: (async function* () {
      return;
    })(),
    done: new Promise<void>(() => {}),
    abort: () => {},
    ...overrides,
  };
}
