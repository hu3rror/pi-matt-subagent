# Research runs carry a budget: soft caps in the prompt, hard caps in the runner

Background researchers (the `research` tool) used to run with no depth control: one PWA question chased all the way into chromium source, the run log growing past 20 MiB before stopping. Every research run now carries a **budget** — a tier (`standard` | `tight`, default `standard`) mapping to five budget/control dimensions, enforced in two layers: three soft budget dimensions (total fetch pages, search rounds, findings lines) are written into the researcher's prompt as guidance, and two hard control dimensions (log size, wall clock) are enforced by the runner, which watches the log file and the clock and kills the subprocess at 110% of the cap, appending a `research-terminated` marker to the findings file so the main session can tell a truncated result from a complete one. The budget is injected at prompt-assembly time (`buildResearchPrompt`), never baked into the embedded role prompt, so user/project-defined `researcher` roles inherit it; per-call overrides follow overrides > tier > system default, and hard-dimension overrides may only tighten, never exceed the global ceiling. Soft overruns do not kill: the researcher enters wind-down, freezes the exceeded dimension, finishes the summary, and writes a `soft_limit_exceeded` marker.

Tier table (standard / tight): search rounds 10 / 5, fetch total pages 20 / 8, findings lines 500 / 200, log 8 MiB / 2 MiB, wall clock 15 min / 5 min.

The hard caps' 100% wind-down line is enforced asymmetrically where the model can't self-observe: the subprocess's stdout/stderr are redirected into the runner's log file, so the model never sees its own log size — on the log dimension the runner writes an "approaching cap" warning into the log instead, while on the wall-clock dimension the model self-manages from the budget numbers in its prompt. The 110% kill line is enforced uniformly by the runner on both hard dimensions.

A user/project-defined `researcher` role may declare a default tier in frontmatter (`budget: tight`), same pattern as `thinkingLevel`, used when the caller passes no per-call override. If neither the caller nor the role declares a tier, the system default (`standard`) applies: every run carries a budget, so a custom researcher that never declares one still gets standard caps.

## Considered options

- **Prompt-only guidance** — simplest, but it already failed in production: the 20 MiB runaway was exactly a prompt with no caps.
- **Runner-only hard caps** — stops catastrophes but can't teach proportionate effort, and fetch/search-round counts are invisible to the runner.
- **Hybrid (chosen)** — prompt guidance for the dimensions only the model can see, runner enforcement for the two it can't be trusted with.

## Consequences

- The runner needs a watcher that stats the log file and checks the clock; enforcement is best-effort while the main session lives (the child is detached and keeps running if the session exits, as before).
- `terminated` as a background-task status is defined together with D3's status model, not here.
- Blocking `subagent` calls to the `researcher` role are not budgeted: the main session is present and waiting, so a runaway is visible; budget only guards the background channel.
