# Research redesign — skill rewrites (design deliverables)

Proposed rewrites of the two mattpocock-fork skills affected by the research redesign, locked in [ADR 0013](../../adr/0013-research-background-push-redesign.md). These are **design deliverables for review**, not live skill files: the installed skills track mattpocock upstream, so the texts here are applied as a **patch after each upstream sync** at implementation time. A direct overwrite would conflict with the sync; an upstream PR is not viable.

## Artifacts

- [research-skill.md](./research-skill.md) — complete replacement text for `research/SKILL.md` (push semantics).
- [wayfinder-step5.md](./wayfinder-step5.md) — targeted edit for `wayfinder/SKILL.md` step 5 ("Fire the research subagents").

## Apply (implementation time)

1. Pull the latest mattpocock upstream sync of the skills.
2. Run `node scripts/apply-skill-patch.ts` — it re-applies both patches (the `research/SKILL.md` full replacement and the `wayfinder/SKILL.md` step-5 edit) straight from these files, idempotently. `--dry-run` previews; `--skills-dir <path>` targets a custom skills dir; a missing target (sync never ran) reports and exits nonzero. Run it again after every future sync — a sync restores the upstream texts, which is exactly what makes the script fire.
3. Re-run the token benchmark baseline and the surface-contract tests — the `research` tool's description and schema change with the redesign.
