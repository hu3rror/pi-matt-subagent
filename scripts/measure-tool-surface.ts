/**
 * Seam E measurement extension (dev-only, not shipped): hooked at
 * before_agent_start, captures the registered model-facing surface of the two
 * tools (`subagent`, `research`) exactly as the extension registered it, and
 * writes the per-tool char/token numbers to MEASURE_OUT. Tokens are the
 * fixed ceil(chars / 4) proxy shared with the regression guard
 * (`estimateToolSurfaceTokens` in src/lib.ts). Loaded by
 * scripts/benchmark-tools.ts in a separate empty-config pi process.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", () => {
    const out = process.env.MEASURE_OUT;
    if (!out) return;
    const all = pi.getAllTools();
    const result: Record<string, { chars: number; tokens: number }> = {};
    for (const name of ["subagent", "research"]) {
      const tool = all.find((t) => t.name === name);
      if (!tool) {
        result[name] = { chars: -1, tokens: -1 };
        continue;
      }
      const chars = JSON.stringify({ description: tool.description, parameters: tool.parameters }).length;
      result[name] = { chars, tokens: Math.ceil(chars / 4) };
    }
    fs.writeFileSync(out, JSON.stringify(result, null, 2), "utf8");
  });
}
