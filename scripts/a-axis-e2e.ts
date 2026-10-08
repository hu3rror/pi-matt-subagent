/**
 * DEV-ONLY — real-pi e2e for the A-axis flip (issue #40): a conversationally-
 * declared session thinking level must sit ABOVE the config default
 * (`dispatchDefaultThinkingLevel`) in the subagent dispatch priority.
 *
 * Not part of `npm test`: the priority matrix is pinned at Seam A by the S8
 * tests; this run proves the wiring — that the declared level read from the
 * real session transcript reaches the subagent dispatch and wins over the
 * config default.
 *
 * How it works: the prompt asks the model to call `set-thinking-level xhigh`
 * (a REAL tool call, so the transcript carries the declaration), then to call
 * `a-axis-e2e-drive`. That tool runs the REAL `subagent` tool via
 * `ctx.executeTool` (nested calls deliberately do not appear in the
 * transcript) and logs the run's requested/effective levels. Under the
 * machine config (`dispatchDefaultThinkingLevel: high`), the acceptance
 * signal is `requestedThinking == "xhigh"` — pre-flip it would be `"high"`
 * (the config default beating the declaration).
 *
 * Run (a working model / API key is required):
 *   pi -p --session-dir <isolated-dir> --model sensenova/deepseek-v4-flash \
 *      -e extensions/subagent.ts -e scripts/a-axis-e2e.ts \
 *      "First call the set-thinking-level tool with level xhigh. Then call the a-axis-e2e-drive tool. Then reply with the single word: DONE"
 *
 * Results are appended to `a-axis-e2e.log` in the OS temp dir; a fresh log
 * is written per run. Look for `A-AXIS E2E OK`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findDeclaredThinkingLevel, type DeclaredLevelEntry } from "../src/lib.ts";

export default function (pi: ExtensionAPI) {
  const logPath = path.join(os.tmpdir(), "a-axis-e2e.log");
  fs.writeFileSync(logPath, "", { encoding: "utf-8" });
  const log = (msg: string) => fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`);

  pi.registerTool({
    name: "a-axis-e2e-drive",
    label: "A-axis e2e drive",
    description:
      "Dev-only e2e driver: runs the subagent tool once and reports whether the conversationally-declared thinking level reached the dispatch. No arguments.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const declared = findDeclaredThinkingLevel(ctx.sessionManager.getEntries() as unknown as DeclaredLevelEntry[]);
      log(`declared-from-transcript=${declared}`);
      const outcome = await ctx.executeTool("subagent", {
        agent: "standards-reviewer",
        task: "Reply with exactly the single word: pong",
      });
      const results = (outcome.result.details as { results?: Array<{ thinkingLevel?: string; requestedThinking?: string; model?: string }> } | undefined)?.results;
      const r0 = results?.[0];
      log(
        `subagent isError=${outcome.isError} thinkingLevel=${r0?.thinkingLevel ?? "(none)"} requestedThinking=${r0?.requestedThinking ?? "(none)"} model=${r0?.model ?? "(none)"}`,
      );
      if (outcome.isError) {
        log("A-AXIS E2E FAIL: subagent tool errored");
        return { content: [{ type: "text", text: "FAIL: subagent tool errored" }], details: { declared } };
      }
      if (declared !== "xhigh") {
        log("A-AXIS E2E FAIL: transcript has no set-thinking-level xhigh call");
        return { content: [{ type: "text", text: `FAIL: declared=${declared}` }], details: { declared } };
      }
      if (r0?.requestedThinking === "xhigh") {
        log("A-AXIS E2E OK: declared xhigh beat the config default (requestedThinking=xhigh)");
        return {
          content: [{ type: "text", text: `OK: requestedThinking=${r0.requestedThinking} thinkingLevel=${r0.thinkingLevel}` }],
          details: { declared },
        };
      }
      log(`A-AXIS E2E FAIL: requestedThinking=${r0?.requestedThinking ?? "(none)"} (expected xhigh — pre-flip the config default high wins)`);
      return { content: [{ type: "text", text: `FAIL: requestedThinking=${r0?.requestedThinking ?? "(none)"}` }], details: { declared } };
    },
  });
}
