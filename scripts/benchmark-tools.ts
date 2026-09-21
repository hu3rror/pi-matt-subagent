/**
 * Seam E — real-pi token benchmark for the two tools' model-facing surface.
 *
 * Usage: `node scripts/benchmark-tools.ts`
 *
 * Spawns a separate pi process with an empty working directory and empty
 * configuration (no other extensions, skills, prompt templates, or context
 * files) that loads the plugin extension plus the measurement extension. The
 * measurement extension captures each tool's description + serialized
 * parameter schema at before_agent_start (the recurring model-facing
 * contribution) and writes the per-tool char/token numbers. Tokens are the
 * fixed ceil(chars / 4) character-proxy estimate, not a provider tokenizer.
 *
 * Prints the README table rows (annotated with measurement date and pi
 * version) and the guard-test baseline constants to paste into
 * src/lib.test.ts. Not part of `npm test`; run manually whenever the
 * registered surface changes and paste the fresh numbers.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { TOKEN_GUARD_MULTIPLIER } from "../src/lib.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginExt = path.resolve(here, "../extensions/subagent.ts");
const measureExt = path.resolve(here, "measure-tool-surface.ts");

function piVersion(): string {
  try {
    return execFileSync("pi", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-token-bench-"));
const outFile = path.join(tmp, "measurement.json");
const workDir = path.join(tmp, "work");
fs.mkdirSync(workDir, { recursive: true });

try {
  execFileSync(
    "pi",
    [
      "-p",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "-e",
      pluginExt,
      "-e",
      measureExt,
      "hi",
    ],
    {
      cwd: workDir,
      env: { ...process.env, MEASURE_OUT: outFile, PI_OFFLINE: "1" },
      stdio: "pipe",
      timeout: 180_000,
    },
  );
} catch {
  // The provider call may fail (offline / no key); the measurement is written
  // by before_agent_start before the request, so only a missing file fails.
}

if (!fs.existsSync(outFile)) {
  console.error("benchmark failed: no measurement written (did before_agent_start fire?)");
  process.exit(1);
}

const measured = JSON.parse(fs.readFileSync(outFile, "utf8")) as Record<string, { chars: number; tokens: number }>;
const version = piVersion();
const date = new Date().toISOString().slice(0, 10);

console.log("Token benchmark (Seam E)");
console.log(`pi ${version} · measured ${date} · empty config, before_agent_start, ceil(chars/4)`);
console.log("");
for (const name of ["subagent", "research"]) {
  const m = measured[name];
  console.log(`- ${name}: ${m.tokens} tokens (${m.chars} chars)`);
}
console.log("");
console.log("Guard baselines (paste into src/lib.test.ts TOKEN_BASELINE):");
for (const name of ["subagent", "research"]) {
  console.log(
    `  ${name}: ${measured[name].tokens},  ceiling (× ${TOKEN_GUARD_MULTIPLIER}): ${Math.ceil(measured[name].tokens * TOKEN_GUARD_MULTIPLIER)}`,
  );
}
console.log("");
console.log("README table rows:");
console.log(`| \`subagent\` | description + parameter schema | **${measured.subagent.tokens}** |`);
console.log(`| \`research\` | description + parameter schema | **${measured.research.tokens}** |`);
console.log("");
console.log("Measured with pi " + version + " in a separate temporary process with empty working directory and configuration.");
