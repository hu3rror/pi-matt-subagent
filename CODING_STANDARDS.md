# Coding Standards

Rules for code written in this repository. Agent behavior rules live in `AGENTS.md`; trade-off rationale and rejected alternatives live in ADRs. Extend this file as the repo's conventions crystallize.

## Comments

- Default to no comments. Let names and structure make the code self-explanatory.
- Write comments only for reasons the code itself cannot express: hidden constraints, counterintuitive behavior, historical pitfalls, and special compatibility requirements.
- Put trade-off rationale and rejected alternatives in ADRs, not in code comments.

## Repo conventions

- TypeScript in strict mode; typecheck with `npm run typecheck` (`tsc --noEmit`) and test with `npm test` (`node --test` on `src/*.test.ts`). Run both before considering a change done.
- The package is ESM (`"type": "module"` in `package.json`); modules use ESM `import`/`export`.

## Out of scope

- Updating or merging an existing standards file: the human decides what changes.
- Writing ADRs: rationale belongs in ADRs, and the doc points there.
