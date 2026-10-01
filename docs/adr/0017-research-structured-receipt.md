# Structured research receipts: `outputSchema` + `structuredContent` on the research tool

> Companion to ADR-0016 (the returned tool-error contract). It does not supersede anything: ADR-0013's push delivery and ADR-0011's input-JSON loud-throw survive as before. It adopts the second survey item — declaring a result schema and returning machine-readable content — for the `research` tool only, and migrates research's not-completed branches to the ADR-0016 coverage rule.

## Decision

- The `research` tool declares `outputSchema: RESEARCH_RESULT_SCHEMA`, a TypeBox object of the research handle (`researchId` / `findingsPath` / `logPath`, all strings, all required), and every successful call returns `structuredContent` mirroring the handle — the same object content as `details`. Programmatic consumers (e.g. codemode scripts) receive the structured receipt instead of parsing the "Research started (id: …)" text.
- The `subagent` tool does **not** declare an `outputSchema`: it has no known programmatic consumer, and the declared schema would ride along in some serializations; the token surface is kept at today's size.
- Research's not-completed branches now return `isError: true` with **byte-identical content** (ADR-0016 coverage rule):
  - project-local researcher declined ("Canceled: project-local agents not approved.") — no run is registered, so no receipt and no details;
  - unresolvable `model` override ("Unknown model override: …") — same;
  - runner-startup failure after registration — the registry entry is settled to `failed` **first** and the abort handle is released, nothing is pushed (the run never started, it has no log), and the result's content is the runner error's message — the same text the harness derived from the former throw.
- Error-marked branches never carry `structuredContent`.
- The transport exceptions are untouched: `mergeToolParams` still throws loudly on malformed `input` (ADR-0011), unchanged by this adoption.

## Why the token surface is untouched

The provider layer never serializes `outputSchema` (pi-ai/pi-agent-core JavaScript never references it; the built-in `bash` tool declares one). The model-facing surface is `description` + `parameters` — exactly what the token benchmark measures (Seam E) and the regression guard recomputes, both of which are unchanged.

## Considered options

- **Also declare `outputSchema` on `subagent`** — rejected: no consumer for a structured blocking result today; declaring it costs nothing at runtime but is a promise of a shape we would have to keep stable for no benefit.
- **Return only `content`, no `structuredContent`** — rejected: the point of declaring `outputSchema` is that consumers receive the receipt; declaring a schema without returning the field is the same dead-field trap as ADR-0010's returned `isError`.
- **Keep the startup-failure branch throwing (ADR-0010 signal)** — rejected: the run's registry entry is settled `failed` in both cases; the returned error result carries the same message, and the uniform coverage rule (not-completed → `isError: true`) keeps research consistent with subagent (ADR-0016).

## Consequences

- Codemode and script consumers can read `structuredContent` on successful research calls: `{ researchId, findingsPath, logPath }`, identical to `details`.
- Research not-completed calls are error-marked in the transcript; the model sees the same text as before.
- The startup-failure invariant (frozen-update-first, no push) is preserved; only the carrier changes from throw to returned error result.
- `[NEEDS MANUAL VERIFICATION]` — live rendering of research pushes under a real pi session via the existing real-pi e2e script; the not-completed branches are live-drivable (unknown-model override is deterministic; refusal needs an untrusted project; startup failure needs a runner-level failure such as tmp-dir creation).
