# Proposed `research/SKILL.md` (complete replacement)

Target: `research/SKILL.md` in the installed mattpocock-fork skills. Replace the whole file with this text. See [ADR 0013](../../adr/0013-research-background-push-redesign.md).

```markdown
---
name: research
description: Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to a background agent.
---

Spin up a **background agent** to do the research, so you keep working while it reads.

Its job:

1. Investigate the question against **primary sources** (official docs, source code, specs, first-party APIs), not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Write the findings to a single Markdown file, citing each claim's source.
3. Save it where the repo already keeps such notes; match the existing convention, and if there is none, put it somewhere sensible and say where.

The agent's completion is **pushed** back to you: when it finishes (or fails, or is stopped), a notification arrives in your context carrying the findings path. Read the file when the push lands — don't poll for it, and don't plan around reading it at a fixed time.
```
