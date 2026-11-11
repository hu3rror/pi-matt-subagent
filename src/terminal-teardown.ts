import type { HcClient } from "./hc-client.ts";

/**
 * The terminals one session started, so its shutdown can clean them up (issue #54).
 * A started terminal has no `rm` flag and no explicit parent: hc gives it the
 * terminal the call came from when pi runs inside one (there it ends with pi's
 * program), and none otherwise — and nothing in hc ends a parentless terminal.
 */
export interface SessionTerminals {
  /** Records a terminal this session created; the same address twice is one terminal. */
  track(terminal: string): void;
  /**
   * Kills every tracked terminal and removes the ones the kill left finished.
   * Never throws: shutdown has no failure channel, and a terminal that cannot
   * be stopped is reported through `onWarn` and left in the listing.
   */
  teardown(onWarn?: (message: string) => void): Promise<void>;
}

export interface SessionTerminalsDeps {
  /** The core connection, resolved lazily so a session that never runs a terminal never connects. */
  client: () => HcClient;
}
function openClient(deps: SessionTerminalsDeps, onWarn: (message: string) => void): HcClient | undefined {
  try {
    return deps.client();
  } catch (err) {
    onWarn(`carrier hc: the core connection could not be opened (${err instanceof Error ? err.message : String(err)})`);
    return undefined;
  }
}
function terminalState(result: unknown): string | undefined {
  const state = (result as { state?: unknown } | null)?.state;
  return typeof state === "string" ? state : undefined;
}

export function createSessionTerminals(deps: SessionTerminalsDeps): SessionTerminals {
  const terminals = new Set<string>();
  return {
    track(terminal) {
      if (terminal !== "") terminals.add(terminal);
    },
    async teardown(onWarn = () => {}) {
      const addresses = [...terminals];
      terminals.clear();
      if (addresses.length === 0) return;
      const client = openClient(deps, onWarn);
      if (!client) return;
      for (const terminal of addresses) {
        const killed = await client.call("terminal.kill", { terminal });
        if (!killed.ok) {
          onWarn(`carrier hc: terminal ${terminal} could not be killed (${killed.failure}: ${killed.message})`);
          continue;
        }
        const state = terminalState(killed.result);
        if (state !== "finished") {
          onWarn(
            state === undefined
              ? `carrier hc: terminal ${terminal} was not removed (the kill answered without a state)`
              : `carrier hc: terminal ${terminal} is still ${state} after the kill`,
          );
          continue;
        }
        const removed = await client.call("terminal.rm", { terminal });
        if (!removed.ok) {
          onWarn(`carrier hc: terminal ${terminal} could not be removed (${removed.failure}: ${removed.message})`);
        }
      }
    },
  };
}
