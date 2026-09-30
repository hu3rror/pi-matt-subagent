# The usage line shows the dispatched model and thinking level, and names an unpinned level `default`

> [ZH] blocking 运行的用量行（工具结果渲染与 `/subagents` 快照行共用）在 `7 turns ↑23k ↓3.5k R84k ctx:21k` 之后补上派发模型与思考档位，形态沿用 pi 主 footer：`(provider) id • <档位>`，`off` 写作 `thinking off`，未设档写作 `default`。显示的是**派发意图**（`resolveThinkingLevel` 的结果），不是子进程实际生效档位——子进程的 JSON 流只在档位变化时发 `thinking_level_changed`，新会话的初始档位只写进它自己的 transcript，父进程观测不到；因此只展示自己解析出的那一档，并把 ADR 0005 遗留的「role 钉了 model、插件不设档」盲区显式标成 `default`，而不是发明一个档位。数据面：`SingleResult` 与 `RunEntry` 各增 `thinkingLevel`（`RunEntry` 另增 `model`），由 spawn adapter 像 `model` 一样预置，随后与 `usage` 走同一条进度/终态 patch 落进 run registry。

ADR 0005 gave every subagent run an explicit thinking tier (per-call override > role-declared tier > inherited default), but the tier vanished at dispatch: the run's visible cost line — turns, tokens, context, model — never said how hard that run was asked to think, and its one deliberate blind spot (a model-pinned role gets no `--thinking` flag at all) was invisible to the caller. The usage line is the natural home for it: it already carries the per-run model, and it is the line a user sees both inline (the `subagent` tool result) and in the `/subagents` snapshot.

## Decision

`formatUsageLine` gains a `thinking` display field and renders the model segment in pi's own footer style: `(sensenova) deepseek-flash • high`. `off` keeps pi's wording (`• thinking off`) in both positions; a bare role-pinned id gets no provider parentheses (a slash with an empty side — `prov/`, `/id` — degrades to a bare id rather than rendering a provider pair around nothing); without a model the level still shows as a standalone `thinking:<level>` token (`thinking off` for `off`). An unresolved level (the run never pinned one) renders as `default` — the label says "we did not set a tier", never a tier we did not set.

The displayed value is the **resolved dispatch intent**, not the child's effective level. That is a constraint, not a preference: a spawned child emits `thinking_level_changed` only when the level *changes*, and a fresh session's initial level is written straight into its own transcript at creation (the CLI's re-apply is a no-op because the level does not change), so the parent cannot observe it. Displaying the intent is honest as long as the label grammar does not claim more than that, which is why `default` exists.

Data flows like `model` already does: the spawn adapter pre-sets `thinkingLevel` on `SingleResult` (accepting the accumulator's pre-set options, exactly as for `model`), and `runBlockingPlan` patches it — plus `model` — into the run registry on live progress and on the terminal transition. `RunEntry` gains `model` and `thinkingLevel`, so the `/subagents` row can show the same segment (`usage: 3 turns ↑1.2k … (sensenova) deepseek-flash • medium`). Background research rows are untouched: they carry no usage line.

The usage lines are renderer-only; nothing here enters tool `content`, so the model-visible surface and the token benchmark are unchanged.

## Considered options

- **Label the level as its own token (`thinking:high`) instead of pi's model style** — rejected: the user-facing convention already exists in pi's footer, and attaching it to the model reads as one unit ("this model, at this tier"). The standalone token is kept only for the no-model edge case.
- **Infer or invent the effective level when the run passed no `--thinking`** — rejected: unobservable (above). `default` is the honest third state.
- **Change dispatch so a model-pinned role always gets an explicit tier** — rejected: that reverses ADR 0005's deliberate protection against sending unsupported levels to a pinned model's map, and belongs to a behavior change, not a display change.
- **Display-only plumbing (read `SingleResult` in the renderer, leave the registry alone)** — rejected: `/subagents` is the surface where a finished run is audited, and the registry is the only place the finished run's facts live.

## Consequences

- The registry's public data model grows two optional display fields (`model`, `thinkingLevel`) on blocking runs; research runs keep them unset.
- The progress patch now fires even before the first assistant text lands (model and level are pre-set, `usage` is not), so the domain snapshot shows both while a run is active.
- `formatUsageLine`'s existing rendered format for the model changed (`prov/m` → `(prov) m • default`); the pinned format test was updated with it.
- No behavior change at dispatch: the level still only reaches the child through `--thinking`, unchanged from ADR 0005.
