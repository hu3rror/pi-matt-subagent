# Session teardown kills the terminals it started

> [ZH] `hc` 载体的终端不挂在 pi 的生命周期上：blocking 与 research 两种载体都用 `terminal.run` 起一个终端，不传 `parent`、不传 `rm`，pi 的 `session_shutdown` 原来只 `dispose` 掉 hc 客户端，于是会话结束时仍在跑的终端继续跑、已经跑完的终端留在列表里（`hc ls --all` 能看到历史遗留的 `finished` 终端）。本 ADR 决定：每会话记录自己起过的终端地址，两种载体在终端创建时就上报，`session_shutdown` 逐个 `terminal.kill`，kill 后落定为 `finished` 的再 `terminal.rm`；杀不掉就告警并留在列表里。硬死（SIGKILL/崩溃）越过不了 `session_shutdown`，那部分终端没人回收——这是被接受的缺口，恢复手段是 `hc ls --all` 加手工 `hc kill`/`hc rm`。

## The defect

Both `hc` carriers start a terminal through `terminal.run` (`src/terminal-run.ts`, `src/research-carrier.ts`) and then wait on it. The request passes no `parent`, no `rm`, and no `keep`:

- hc's default parent is "the terminal it is started from". When pi itself runs inside an hc terminal, the child is nested under that terminal and — per hc's documented default — ends when the parent's program ends. When pi runs anywhere else there is no terminal identity in the environment, the terminal gets **no parent**, and nothing in hc ends it when pi goes away.
- No `rm`, so a finished terminal stays in the listing until someone removes it.

`session_shutdown` disposed the hc client and cleared the registries, but never touched the terminals themselves. The leftovers were visible in a live core: finished `zsh`/`sh` terminals from earlier sessions (`hc ls --all`) with no run behind them.

## Decision

The extension owns one `SessionTerminals` tracker per loaded extension (`src/terminal-teardown.ts`): a set of terminal addresses, `track()`ed by both carriers at the moment the terminal exists (`onStarted` on the blocking `HcTransport`, `onStarted` on the research child), and drained by an async `session_shutdown` handler:

1. `terminal.kill` every tracked address.
2. Keep only an answer that settles the terminal `finished`: a `live` answer, or an answer without a `state`, warns and leaves the terminal (a kill that missed, or that proves nothing, is not a removal we may force).
3. `terminal.rm` the `finished` ones — the remove is legal there; a failed remove warns.

The teardown runs **before** the client is disposed (the client is what reaches the terminals) and **after** the run registry is cleared, so a terminal that does not stop can never turn a finished run into a failure: shutdown has no failure channel, and a run already settled terminal stays settled. Warnings are the only report, and at shutdown they may not land at all: the UI is already tearing down (`notifyWarning` swallows the stale-context throw, the condition ADR 0027 records), so a terminal that could not be stopped is visible only in `hc ls --all`.

The tracker resolves the hc client lazily (`client: () => HcClient`), so a session that never starts a terminal never connects, and `teardown()` with an empty set makes no call at all.

## Consequences

- On a graceful end of the session (quit, reload, session switch) both carriers' terminals are killed and the finished ones are removed; the listing no longer collects orphans from normal use.
- A **hard** kill of pi — SIGKILL, crash, the parent shell dying — never reaches `session_shutdown`. Nested terminals (pi inside an hc terminal) end with pi's program per hc's default; parentless terminals (pi in a plain terminal) keep running and finished ones stay listed. Recovery is manual: `hc ls --all`, then `hc kill <t>` and `hc rm <t>`. Making pi the parent of its own terminals would be a different design (`outlive_parent`/`keep` decisions, identity plumbing); #54 does not take it.
- The teardown is per loaded extension instance, so the records die with the extension; nothing persists across pi restarts.
- Research children already kill their own terminal on abort (`src/research-carrier.ts`); the tracker then sees a `finished` terminal and removes it. Killing an already-finished terminal is legal (it answers with the terminal), so the two paths do not conflict.
- Tests: `src/terminal-teardown.test.ts` pins the fake-port contract (kill then remove, finished-only, warnings for a missed kill/remove or an answer without a state, an empty session making no call, and a second teardown doing nothing); `src/blocking-carrier.test.ts` and `src/research-carrier.test.ts` pin the tracking callback firing with the terminal address.
