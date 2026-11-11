import type { HcCapabilities, HcClient, HcResult } from "./hc-client.ts";
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

/** A request the fake hc client received. */
export interface FakeHcCall {
  readonly method: string;
  readonly params: unknown;
  readonly signal: AbortSignal | undefined;
}

/** How a fake hc client answers calls and what it reports. */
export interface FakeHcClientOptions {
  result?: HcResult;
  onCall?: (call: FakeHcCall) => HcResult | undefined;
  capabilities?: HcCapabilities;
}

/** A fake hc client that records its calls. */
export function fakeHcClient(options: FakeHcClientOptions = {}): HcClient & { readonly calls: readonly FakeHcCall[] } {
  const calls: FakeHcCall[] = [];
  return {
    calls,
    call: async (method, params, signal) => {
      const call = { method, params, signal };
      calls.push(call);
      return options.onCall?.(call) ?? options.result ?? { ok: true, result: undefined };
    },
    capabilities: () => options.capabilities,
    dispose: async () => {},
  };
}
