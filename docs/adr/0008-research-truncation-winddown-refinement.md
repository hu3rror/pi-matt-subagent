# Hard-cap truncation reworked: checkpointed findings, final notice + grace, recalibrated tiers

A real run exposed that ADR 0003's truncation was both unannounced and destructive: a tight-tier research run was SIGKILLed at wall-clock 110% (5.52 min) mid-document-read, the 100% warn line having gone into a log the model never reads (wall-clock got no signal at all) — and the findings file contained zero deliverable, only the termination marker. We rework the path: the researcher now checkpoint-writes its findings before each search round; at 100% of a hard cap the runner writes a final notice to a budget-status file the model is told to read, then grants a fixed 60s grace period — a run that winds down and exits naturally in that window is `succeeded`, only a run still going at the deadline is SIGKILLed and marked `research-terminated`; the log dimension keeps a 110% immediate backstop solely for runaways. Tiers are recalibrated (tight: wall 5 → 10 min, log 2 → 6 MiB, findings 200 → 400 lines; standard: log 8 → 10 MiB), the research template and tool description now steer callers to match tier to task scope, and the registry records `endedAt` so `/subagents` shows real duration instead of elapsed-since-snapshot. Caps follow "rather too high than too low": an overrun costs a few MiB and is caught by the wall-clock main brake, while an underrun silently cuts legitimate work; the marker's observed/limit fields let us recalibrate from real distributions after launch rather than guessing now.

## Considered options

- **Prompt-only guidance** — already failed in production (the 20 MiB runaway in ADR 0003); not revisited.
- **Runner-side findings mirror** — rejected: the runner can only snapshot what the model already wrote, so it cannot rescue an end-only writer; prompt-level checkpointing is the necessary layer, and a mirror adds file copies with no upside once checkpoints exist.
- **SIGTERM graceful-stop** — rejected: the child's signal semantics are unverified and the grace period achieves the goal without touching signal handling; SIGKILL at the grace deadline stays.
- **Dropping the tight tier** — considered as the honest endpoint of loosening; kept for now since 10/6/400 preserves a real tier gap. If post-launch observed/limit data shows tight still truncating legitimate runs, deleting the tier (standard + per-call tightening only) is the follow-up.

## Consequences

- `terminated` now means "ignored the final notice", not "was cut mid-work"; runs that wind down in the grace window exit naturally as `succeeded`. A `wind-down-complete` sentinel lets readers distinguish complete-but-late findings from truncated ones.
- The model must poll the budget-status file (one extra read per search round) — the cost of making the hard dimensions observable.
- The log keeps human-readable warn/kill lines for post-mortem; the 100% warn is now also the status file's final notice.
- pi's `write` tool is in-place, not atomic — a SIGKILL landing exactly mid-write can truncate the findings file; the grace window plus "checkpoint first on final notice" makes that vanishingly rare, and the marker's `partial: true` keeps it honest.
