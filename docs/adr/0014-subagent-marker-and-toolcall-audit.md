# Subagent marker and research toolCall audit: the two future-proofing seams

> [ZH] 冻结两条面向未来的 seam（父 issue #24，落地于 #25/#26）：① blocking 子进程环境携带 `PI_SUBAGENT_PARENT_SESSION=<父会话 id>`（gotgenes 现行 out-of-process 约定，per-spawn 注入，纯公告——本包只设置从不读取）；② research 子会话经 `tool_execution_start` 事件 → 子会话工厂可选 `onToolCall` 钩子，由 runner 把每次执行的工具调用追加为 `toolcalls.jsonl` 的一行 JSON（start-only，行 schema `{ts, toolCallId, toolName, args}`）。同时冻结两处刻意的不作为：不设 legacy `PI_SUBAGENT_CHILD`/`PI_SUBAGENT_NAME` 与 role 提示 `PI_SUBAGENT_ROLE`；不为 in-process research 子会话发出 gotgenes in-process 生命周期事件。

Two seams were added so future consumers can rely on what this package sets or records without the package itself growing behavior it does not need: a subagent marker naming the parent session in every blocking child's environment, and a per-run audit of the research child's executed tool calls. Neither has a consumer inside this package today — the shape is the contract, recorded here so both stay durable instead of incidental.

## Decision: the subagent marker — choice and pure-announcement stance

Every blocking subagent run (single, parallel, chain — all dispatched through the one blocking spawn site) starts in a process whose environment names its **immediate** parent session: `PI_SUBAGENT_PARENT_SESSION=<parent session id>`. The variable name is the current gotgenes out-of-process convention, adopted as-is rather than reinvented.

- **Per-spawn injection, never a root mutation**: the parent session id is read from the extension context's session manager and threaded through the dispatch defaults; the child environment is produced by a pure builder (`buildSubagentEnv(base, parentSessionId?)`) that returns a full copy of the base environment with the marker added when an id is present. Each spawn gets its own copy, so nested subagents each name their own immediate parent and the root process environment is never touched.
- **Value semantics**: the marker is present exactly when a parent session id is given; a top-level manual run (no parent) carries no marker, and the base environment is preserved key-for-key. The caller's object is never mutated.
- **Pure announcement**: the package sets the marker and never reads it back. Consumers read it in the child process — permission ask-forwarding, identity guards — and this package stays indifferent to them. A manual run carries no such variable, so a child can distinguish "nested under a session" from "invoked directly".
- **Grandfathered legacy not set**: the legacy `PI_SUBAGENT_CHILD` / `PI_SUBAGENT_NAME` markers and the role hint `PI_SUBAGENT_ROLE` are deliberately **not** set. They belong to an older convention; a child that reads them would be reading a lie about the protocol in use, so the ADR freezes their non-emission.

## Decision: the research toolCall audit shape

Every research run records its executed tool calls: one JSON object per line in `toolcalls.jsonl`, written beside `research.log` in the run's tmp directory.

- **Event source**: the in-process child session's `tool_execution_start` event (`{toolCallId, toolName, args}`) — not parsing message content, so the audit reflects what the session actually executed, with the final, post-mutation call arguments.
- **Hook**: the child-session factory options gain an optional synchronous `onToolCall` hook; the extension wires the session event through it, the runner owns the file. The hook path touches nothing else — not the output log, the UI stream, `noExtensions`, or role tool lists.
- **Line schema**: `{"ts": <epoch ms>, "toolCallId": <string>, "toolName": <string>, "args": <unknown>}` — start events only; no results, no truncation. A run with zero tool calls leaves an empty file.
- **File lifecycle**: the audit fd is opened eagerly alongside the log fd and closed through the same single exit path (or on a synchronous factory throw), so a stuck run cannot leak either. Write failures — including a serialization failure — are swallowed: a debug artifact must never kill a research run.
- **No consumer in the package**: the file exists for future or external consumers (nested-run toolCall audit); nothing in this package reads it back.

## Deliberate non-emission: in-process lifecycle events for the research child

The gotgenes convention spans two channels: out-of-process env markers for spawned children, and in-process lifecycle events for in-process children. This package participates in the first channel only (blocking children, above). For the in-process research child (ADR 0013) it deliberately emits **no** in-process lifecycle events:

- The child is built with `noExtensions: true` and no announcement surface; its session events are consumed internally and only internally — `message_end` feeds the output stream (tee'd into the per-run log), `tool_execution_start` feeds the audit hook.
- The run's only outward surfaces are the run registry entry (a `background` research run) and the terminal-state push (ADR 0013). No start/end lifecycle event is broadcast for it.
- Rationale: a lifecycle-event channel exists to serve consumers; this package has none for in-process children, and an emitted-but-unowned event channel is a contract future work would have to stabilize. The audit file already gives consumers the toolCall record, without the package announcing the child's lifecycle.

## Considered options

- **Set the legacy `PI_SUBAGENT_CHILD` / `PI_SUBAGENT_NAME` markers** — rejected: grandfathered names from an older convention; a child reading them would be misled about the protocol in use. The current convention names the parent session, not the child.
- **Set a role hint (`PI_SUBAGENT_ROLE`)** — rejected: dispatch already knows the role; the hint would duplicate state and invite drift, and nothing reads it.
- **Mutate the root process environment once** — rejected: nested subagents would all name the outermost parent instead of their immediate parent; the per-spawn copy keeps the root untouched.
- **Read the marker back / grow an internal consumer** — rejected: the stance is pure announcement; an internal reader would turn a one-way signal into a contract the package must maintain.
- **Audit by parsing child message content** — rejected: content parsing misses executed calls that produce no message and requires fragile string matching; the session event is the accurate source.
- **Emit gotgenes in-process lifecycle events for the research child** — rejected: no consumer exists, and an emitted-but-unowned event channel is a stability liability (see the non-emission section).

## Consequences

- The seams are durable contract: any future consumer can rely on `PI_SUBAGENT_PARENT_SESSION` semantics (immediate parent, pure announcement, absent at top level) and on the `toolcalls.jsonl` start-only schema without this package changing.
- The two "not doing" decisions are frozen too: no legacy markers, no role hint, no in-process lifecycle events for the research child — so a future contributor does not reintroduce them as obvious additions.
- Changing either seam is now an ADR-worthy change, reviewed against the shapes recorded here.
- The research child stays opaque by design: its internals are visible only through the run registry, the terminal-state push, and the toolCall audit file.
