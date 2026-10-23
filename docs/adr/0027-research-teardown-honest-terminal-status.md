# Research teardown: a disposed child settles `aborted`, never a false `succeeded`

> [ZH] ADR 0013 的会话作用域研究生命周期有一个诚实性缺陷：pi 的 `AgentSession.dispose()` 会中止 agent 并 **resolve** 在途 `session.prompt()`，因此 teardown 时被切断的子会话 `done` 像自然完成一样 resolve，runner 把运行记成 `succeeded`——即使它零工具调用、无 findings 文件；随后的推送因 dead ctx 抛 stale 错误被吞，唯一留下的记录是 run log 里那句假的 `terminal · succeeded`。本 ADR 决定：`session_shutdown` 先经每个活动 run 的 per-run abort controller（`/subagents kill` 同一杠杆）路由 teardown，runner 同步落定 `aborted`（首个终态胜出），dispose 兜底只保证会话收尾、不能再改写状态。终态并集不加新成员；teardown 推送仍无法送达，但因状态诚实，静默可接受。

## The defect

ADR 0013 made research lifetime session-scoped: "children are disposed on `session_shutdown`". That disposal had an honesty bug:

1. `session_shutdown` called `child.dispose()` on every live research child session.
2. pi's `AgentSession.dispose()` (pi dist `core/agent-session.js`) aborts the agent and **resolves** the in-flight `session.prompt()` — the agent loop returns normally on abort, it does not throw.
3. The factory's `done` therefore resolved exactly like a natural completion, and the runner's `child.done.then(() => settle("succeeded"))` settled the run **`succeeded`** — even for a child that did zero work (empty `toolcalls.jsonl`, no findings file).
4. The terminal push then threw pi's stale-context error at teardown and was swallowed (the established #32 pattern), so the only record left was the run log's false `terminal · succeeded` line.

Reproduced in one-shot runs: the main turn ends right after a research run starts, the session quits, the run log ends `terminal · succeeded` while `toolcalls.jsonl` is 0 bytes and the findings file never exists. The user's report — `/subagents` showing `succeeded` with no push in a normal TUI session whose context was reloaded — matches this signature.

## Decision

`session_shutdown` now routes teardown through **each live run's abort controller first**: the same `researchAborts` levers that back `/subagents kill`. `AbortController.abort()` fires its listener synchronously, so the runner settles the run `aborted` (with its bounded drain) before the disposed child's `done` can resolve `succeeded` — the first terminal settle wins. The existing per-child `dispose()` loop stays as the hard-unwind backstop: it guarantees a stuck child session ends, and because the runner has already settled, dispose resolving a stuck prompt cannot override the terminal status.

The frozen terminal union gains no member: `aborted` is the honest bucket for a run cut short by the session ending, `terminated` stays wall-clock-only, and a child that genuinely completed before the session ended usually still settles `succeeded` (findings on disk are the evidence of real completion); when shutdown and `done` resolve in the same tick the abort may win instead — either way the status is honest.

## Consequences

- At teardown a cut-short run settles **`aborted`**: the run log's `terminal · aborted` line is the honesty surface per-run. The push still cannot land (dead ctx — the stale error is swallowed), but that silence is acceptable because the status is not a false success. ADR 0013's "every terminal state is pushed" is untouched for live sessions.
- The `/subagents` registry is cleared at `session_shutdown` as before; after the session ends the run log's terminal line is the only visibility.
- The runner (`src/lib.ts`) is unchanged — the extension only changes which lever teardown pulls.
- Tests: `scripts/research-teardown-e2e.ts` is the real-pi gate for the honesty invariant (a disposed child that wrote no findings must never settle `succeeded`); `src/research-e2e.test.ts` pins the runner half (an abort signal settling before a resolved `done` wins). The dispose→resolve behavior lives in pi's runtime, so no fake-child unit test can reach the extension's teardown wiring — the real-pi gate is the regression seam.

## Supersedes

ADR 0013's consequence "children are disposed on `session_shutdown`" — disposal remains the backstop, but teardown settles the runs through their abort controllers first.
