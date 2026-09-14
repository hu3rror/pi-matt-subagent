# pi-matt-subagent

一个 pi 插件：为一批「明确依赖 subagents」的 skill（`code-review`、`codebase-design`、`improve-codebase-architecture`、`research`、`wayfinder`、`grilling`）提供 pi 原生的 subagent 原语。

## Language

**subagent**:
一次隔离上下文的委托执行——在独立 pi 子进程里完成一个任务并返回结果，与主会话内联执行相对。
_Avoid_: sub-agent, 后台任务

**role**:
一个命名了的 subagent 模板：固定的 system prompt、工具集、可选 model。每次运行的具体任务由调用方在 `task` 里给出。
_Avoid_: subagent（与「执行实例」混淆时，用 role 指模板、subagent 指实例）

**blocking**:
subagent 在工具返回前完成、主会话拿到结果才继续的语义。
_Avoid_: synchronous, wait, join

**background**:
工具立即返回、subagent 稍后把结果落盘、主会话稍后再取回的语义。
_Avoid_: async, fire-and-forget, detached

**two-axis review**:
`code-review` 的并行审查——Standards（是否符合仓库规范）与 Spec（是否忠实实现原始 issue/spec）两轴并行、分开报告、不跨轴排序。
_Avoid_: combined review, merged review

**design-it-twice**:
对同一个深化候选并行生成 3+ 个差异显著的接口设计，再横向比较。
_Avoid_: brainstorming, options

**workflow preset**:
预编码一次编排（single/parallel/chain）的 prompt 模板。
_Avoid_: command, recipe
