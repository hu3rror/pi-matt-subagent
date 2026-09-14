# Blocking-first subagents, with a separate background channel for research

The skills this plugin serves split into two kinds: `code-review`, `design-it-twice`, `improve-codebase-architecture`, and `grilling` need the main session to WAIT for subagent results before the next step (their aggregation or comparison depends on all results), while `research` and `wayfinder` explicitly want a background agent so the main agent keeps working while it reads. We therefore ship two tools: `subagent` (blocking — single/parallel/chain, returns only after every subagent finishes, with full results in one result) and `research` (background — returns immediately with a findings-file handle). Blocking is the default mental model; only research/wayfinder use the background channel.

## Considered options

- **Make everything blocking** — simplest and most consistent, but research loses its parallelism and the `research` skill's whole point is "keep working while it reads".
- **Make everything background** — contradicts the core requirement that code-review/design-it-twice block for aggregation.
- **Dual-channel (chosen)** — two tools, each matching the semantics of the skills that use them.

## Consequences

- Two tools to teach and document instead of one.
- Background results are file-mediated: the main agent reads the findings path later, so a result is found by path, not by a returned message.
