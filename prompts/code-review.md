---
description: Two-axis review (Standards + Spec) of the diff since a fixed point, run as two parallel blocking subagents
argument-hint: "<ref>"
---
Review the changes since `${@:-HEAD~1}` (a commit SHA, branch, tag, or merge-base) along two axes, running each axis as a parallel **blocking** subagent via the `subagent` tool's `tasks` array.

0. If no ref was given and you fell back to the default `HEAD~1`, open with one line stating the ref you resolved so the user can correct it. Never invent a ref beyond the default.
1. Resolve the fixed point: let `R` be the ref you review against (the one above). Run `git rev-parse <R>`, confirm `git diff <R>...HEAD` is non-empty, and capture `git log <R>..HEAD --oneline`.
2. Identify the spec source (issue refs in commits, an argument, or a file under `docs/`, `specs/`, `.scratch/`) and the standards sources (e.g. `CODING_STANDARDS.md`, `CONTRIBUTING.md`). If the spec is missing, note it and skip the Spec axis.
3. Call the `subagent` tool ONCE with a `tasks` array (parallel, blocking — the call returns only after both axes finish):
   - agent `standards-reviewer`, task = the diff command + commit list + the standards-source file list + the full smell baseline, with the brief "report under 400 words; distinguish hard violations from judgement calls; skip anything tooling enforces".
   - agent `spec-reviewer`, task = the diff command + commit list + the spec path or contents, with the brief "report missing/partial, scope creep, and wrong-looking implementations, quoting spec lines; under 400 words".
4. Present the two reports under `## Standards` and `## Spec`, verbatim. Do not merge or rerank. End with one line per axis: total findings and the worst issue within that axis.
