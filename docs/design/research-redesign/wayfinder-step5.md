# Wayfinder step 5 — proposed edit

Target: `wayfinder/SKILL.md`, the "Fire the research subagents" step in "Chart the map". See [ADR 0013](../../adr/0013-research-background-push-redesign.md).

## Before

> 5. **Fire the research subagents.** For each `research` ticket you just created, spin up a subagent that calls the Skill tool with "research" to resolve it in parallel, capturing its findings on a throwaway `research/<name>` branch with a context pointer from the ticket.

## After

> 5. **Fire the research subagents.** For each `research` ticket you just created, spin up a subagent that calls the Skill tool with "research" to resolve it in parallel, capturing its findings on a throwaway `research/<name>` branch with a context pointer from the ticket. Completion arrives as a **push** carrying the findings path: read the file when the push lands — or, since research is session-scoped and charting stops here, resume from the branch's checkpointed findings in a later session if the run didn't finish before this one ended.

## Why

The `research` tool now delivers completion by push instead of "read the findings path later" (ADR 0013): the main agent is notified at every terminal state and doesn't poll. Research is session-scoped (in-process execution), so a charting session that stops at step 6 may cut runs short; checkpointed findings on the branch bound the loss, and a later session resumes from them.
