# Coding Standards

Rules for code written in this repository. Agent behavior rules live in `AGENTS.md`. Extend this file as the repo's conventions crystallize.

## Comments

- The code is the source of truth; a comment never is. When a comment and the code disagree, the code wins: fix the comment or delete it.
- No comment survives on comfort: a comment is kept only when it states a constraint the code cannot express and we cannot encode — hidden constraints, counterintuitive behavior, deliberate deviations, compatibility requirements — and it must show it still binds. Ambiguity is a defect: when in doubt, delete.
- Encode before commenting. A constraint worth stating is worth encoding as a type, a runtime check, a test, or a CI lint rule; a comment is the fallback for what cannot be encoded, not the first resort. An encoded constraint is enforced; a comment is a promise.
- Lint and type-checker suppressions are comments: silent suppressions are defects; correctness or safety suppressions carry the same proof as any other kept comment.
- Bare `TODO`/`FIXME` are defects: a deferred item is an issue with an owner, referenced as `TODO(#NN)`.
- Document exported API — symbols other code or packages consume — with doc comments that state the contract (purpose, invariants, units, thread-safety, caller obligations).
- Do not restate the code: the contract is what the name and signature cannot say.
- Trade-off rationale and rejected alternatives live in ADRs, not in code comments.

## Error handling

- Handle errors, or propagate them with context (what failed, with what input); silently swallowing an error is a defect. Let tooling flag the mechanical forms (empty `catch`, ignored error returns).
- Errors surfaced to users never leak internals — stack traces, internal paths, queries, secrets. Return a generic message and log the detail.

## Resources

- Acquired resources (handles, connections, locks, temp files) are released on every path, including error paths; prefer scoped owners (`defer`, `with`, RAII, `Drop`) over manual release.

## Tests

- Behavior ships with a test that fails without it; a test that always passes is waste.

## Consistency

- Match the convention of the file you are editing; surrounding style settles style debates, not taste.

## Concurrency

- Shared mutable state has one owner or one synchronization mechanism; keep critical sections minimal, and never hold a lock across blocking work.

## Out of scope

- Updating or merging an existing standards file: the human decides what changes.
- Writing ADRs: rationale belongs in ADRs, and the doc points there.

<!-- end of baseline v2; repo-owned content below survives baseline updates -->

## Repo conventions

- TypeScript in strict mode; typecheck with `npm run typecheck` (`tsc --noEmit`) and test with `npm test` (`node --test` on `src/*.test.ts`). Run both before considering a change done.
- The package is ESM (`"type": "module"` in `package.json`); modules use ESM `import`/`export`.