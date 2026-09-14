---
description: Generate 3+ radically different interface designs for a deepening candidate as parallel blocking subagents
---
Explore alternative interfaces for the chosen deepening candidate `$@` using the design-it-twice pattern, via the `subagent` tool's `tasks` array (parallel, blocking).

1. Frame the problem space for the user: the constraints, the dependencies and their category, and a rough illustrative sketch. Show it, then proceed.
2. Call the `subagent` tool ONCE with a `tasks` array of 3-4 `design-explorer` tasks. Each task carries the same technical brief (file paths, coupling details, dependency category, what sits behind the seam, plus the architecture vocabulary and the project's `CONTEXT.md` domain vocabulary) and a DIFFERENT constraint:
   - "Minimize the interface: aim for 1-3 entry points max. Maximise leverage per entry point."
   - "Maximise flexibility: support many use cases and extension."
   - "Optimise for the most common caller: make the default case trivial."
   - (optional) "Design around ports & adapters for cross-seam dependencies."
3. Present each design sequentially, then compare by depth, locality, and seam placement. Give your own recommendation; propose a hybrid if elements combine well. Be opinionated.
