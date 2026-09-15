---
description: Investigate a question against primary sources with a background research subagent, then keep working until the findings land
---
Spin up a **background** researcher for `$@` via the `research` tool, so you keep working while it reads.

1. Decide where the findings file goes: follow the repo's existing convention for research/notes files (`docs/`, a notes dir, or wherever similar notes already live); if there is none, pick a sensible location (e.g. `docs/research-<slug>.md` or next to the topic it concerns) and state it. Prefer an absolute path for the tool call — the tool also accepts repo-relative paths, resolved against the working directory, so an absolute path just avoids that ambiguity.
2. Call the `research` tool once with `task: $@` and that findings path. The tool returns immediately with a handle — do NOT wait, and do NOT poll for the file.
3. Tell the user the findings path and the log location from the handle, then continue with whatever you were doing.
4. Later, when the user asks or the task naturally needs the result, read the findings file and use it — summarizing, citing, or acting on it as appropriate.

The researcher investigates against primary sources (official docs, source code, specs, first-party APIs) and writes each claim with its source. If the question is vague, sharpen it in the `task` you pass (e.g. add the specific claim or API surface you want verified) rather than researching a fuzzy version of it.
