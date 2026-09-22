/**
 * DEV-ONLY — re-applies the ADR 0013 skill patches after a mattpocock
 * upstream sync overwrites the installed skills.
 *
 * The patch texts live in docs/design/research-redesign/ (research-skill.md =
 * full replacement for research/SKILL.md; wayfinder-step5.md = the step-5
 * edit). Installed skills track mattpocock upstream, so a sync clobbers the
 * applied patches; run this script after each sync. Idempotent: a target that
 * already carries the patch is left untouched, so an early or repeated run is
 * a no-op.
 *
 * Usage:
 *   node scripts/apply-skill-patch.ts                   # apply to ~/.pi/agent/skills
 *   node scripts/apply-skill-patch.ts --skills-dir X    # apply to a custom skills dir
 *   node scripts/apply-skill-patch.ts --dry-run         # preview only, no writes
 *
 * A missing target (sync never ran) reports and exits nonzero; the script does
 * not create files it has nothing to patch against.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PATCH_DIR = path.join(REPO_ROOT, "docs", "design", "research-redesign");
const DEFAULT_SKILLS_DIR = path.join(os.homedir(), ".pi", "agent", "skills");

interface Patch {
  name: string;
  targetRel: string;
  /** Returns the content to write, or null when the target already carries the patch. */
  render: (current: string) => string | null;
}

/** Full-file replacement: patch wins unless the target already equals it. */
function fullFileReplacement(patched: string): Patch["render"] {
  // EOL-normalize before comparing: a sync that wrote the installed file with
  // CRLF must still be recognized as already-patched, or idempotency breaks.
  const norm = (s: string) => s.replace(/\r\n/g, "\n").trim();
  return (current) => (norm(current) === norm(patched) ? null : patched);
}

/**
 * Line edit: replaces the line starting with `anchorPrefix` by `patchedLine`.
 * Already-patched when that line already equals the patched line, so a sync
 * (which restores the upstream Before text) is what makes this fire again.
 */
function lineReplacement(anchorPrefix: string, patchedLine: string): Patch["render"] {
  return (current) => {
    const eol = current.includes("\r\n") ? "\r\n" : "\n";
    const lines = current.split(/\r?\n/);
    const idx = lines.findIndex((l) => l.startsWith(anchorPrefix));
    if (idx === -1) throw new Error(`anchor line not found: ${anchorPrefix}`);
    if (lines[idx].trim() === patchedLine.trim()) return null;
    lines[idx] = patchedLine;
    return lines.join(eol);
  };
}

/** Extracts the first ```markdown code block's content from a patch doc. */
function extractMarkdownCodeBlock(docPath: string): string {
  const doc = fs.readFileSync(docPath, "utf-8");
  const m = doc.match(/```markdown\n([\s\S]*?)```/);
  if (!m) throw new Error("no '```markdown' code-block fence found in " + docPath);
  return m[1].replace(/\s+$/, "") + "\n";
}

/** Extracts the first `> ` blockquote line after `## After` from a patch doc. */
function extractAfterLine(docPath: string): string {
  const doc = fs.readFileSync(docPath, "utf-8");
  const m = doc.match(/## After\n\n> (.*)$/m);
  if (!m) throw new Error('no "## After" blockquote found in ' + docPath);
  return m[1];
}

function parseArgs(argv: string[]): { skillsDir: string; dryRun: boolean } {
  let skillsDir = DEFAULT_SKILLS_DIR;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--skills-dir") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--skills-dir requires a value");
      }
      skillsDir = value;
    } else if (arg.startsWith("--skills-dir=")) skillsDir = arg.slice("--skills-dir=".length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return { skillsDir, dryRun };
}

function main() {
  let skillsDir: string;
  let dryRun: boolean;
  let patches: Patch[];
  try {
    ({ skillsDir, dryRun } = parseArgs(process.argv.slice(2)));
    patches = [
      {
        name: "research/SKILL.md (full replacement)",
        targetRel: path.join("research", "SKILL.md"),
        render: fullFileReplacement(
          extractMarkdownCodeBlock(path.join(PATCH_DIR, "research-skill.md")),
        ),
      },
      {
        name: "wayfinder/SKILL.md step 5",
        targetRel: path.join("wayfinder", "SKILL.md"),
        render: lineReplacement(
          "5. **Fire the research subagents.**",
          extractAfterLine(path.join(PATCH_DIR, "wayfinder-step5.md")),
        ),
      },
    ];
  } catch (err) {
    console.error(`[error] ${(err as Error).message}`);
    console.error("usage: node scripts/apply-skill-patch.ts [--skills-dir <path>] [--dry-run]");
    process.exitCode = 1;
    return;
  }

  console.log(`skills dir: ${skillsDir}${dryRun ? " (dry-run, no writes)" : ""}`);

  // All-or-nothing: any missing target means the sync hasn't run (or ran
  // incompletely); touch no file and fail, so a half-patched install is never
  // produced.
  const missing = patches.filter((p) => !fs.existsSync(path.join(skillsDir, p.targetRel)));
  if (missing.length > 0) {
    for (const p of missing) {
      console.error(
        `[missing] ${p.name} — ${path.join(skillsDir, p.targetRel)} not found; run the upstream sync first`,
      );
    }
    process.exitCode = 1;
    return;
  }

  for (const p of patches) {
    const target = path.join(skillsDir, p.targetRel);
    const current = fs.readFileSync(target, "utf-8");
    let next: string | null;
    try {
      next = p.render(current);
    } catch (err) {
      console.error(`[error] ${p.name} — ${(err as Error).message}`);
      process.exitCode = 1;
      continue;
    }
    if (next === null) {
      console.log(`[ok] ${p.name} — already applied`);
      continue;
    }
    if (dryRun) {
      console.log(`[dry-run] ${p.name} — would patch ${target}`);
      continue;
    }
    fs.writeFileSync(target, next, "utf-8");
    console.log(`[patched] ${p.name} — ${target}`);
  }
}

main();
