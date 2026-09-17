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

**tool-name resolution**:
把 role 声明的工具名归一化到子代理进程实际可用的名字：环境没有的名字回退到内置替代名（如 `ffgrep`→`grep`），替代名也不存在则从派发清单剔除。方向恒为「增强名→内置名」，绝不反向（内置名在任何环境下都可用）。
_Avoid_: tool fallback, alias mapping, tool renaming

**budget（研究预算）**:
一次 research 运行的力度档位（standard / tight），映射到 5 个预算/控制维度：3 个 soft 预算维（fetch 总页数、搜索轮数、findings 行数）+ 2 个 hard 控制维（log 大小、墙钟）。调用方按次覆盖（优先级：overrides > 档位默认 > 系统默认），未传时取 researcher role 的默认档，role 也未声明则取系统默认 standard——每次运行必有预算；hard 维覆盖只允许收紧，不允许超过全局 ceiling。
_Avoid_: maxDepth, effort, 力度

**hard cap / soft cap（硬上限 / 软约束）**:
预算的两层执行语义。soft cap 超限不 kill：researcher 进入收尾模式（wind-down），冻结对应维度、继续完成总结、写 `soft_limit_exceeded` 标记。hard cap 100% 线触达同样先收尾；110% 线强 kill 子进程，runner 在 findings 追加 `research-terminated` 标记。
_Avoid_: limit, 限制

**wind-down（收尾模式）**:
soft cap 超限或 hard cap 100% 线触达后 researcher 进入的状态：冻结已超维度（不再 fetch、不再新搜、不再追加 findings），继续完成总结并写 `soft_limit_exceeded` 标记。
_Avoid_: graceful degradation, 降级

**research-terminated marker（终止标记）**:
hard cap 110% 线强 kill 后 runner 追加到 findings 的固定注释标记，记录 reason（`wall_clock_exceeded` / `log_bytes_exceeded`）、partial、limit、observed、at。主会话读 findings 时靠它分辨「被硬上限截断」与「正常结果」。
_Avoid_: kill marker, 截断标记

**runaway（失控深挖）**:
researcher 脱离问题本身、沿无关路径持续深挖（如 PWA 问题一路追到 chromium 源码）直至资源耗尽的行为。hard cap 存在即为其兜底。
_Avoid_: rabbit hole, 打转

**够用即停**:
researcher 的停止规则：信息足够回答问题时立即收尾写 findings，不追源码/实现细节。由 budget 的 prompt 文案显式强调。
_Avoid_: saturation, 信息饱和

**run registry（运行注册表）**:
进程内统一追踪每个 subagent 运行（blocking 的 single/parallel/chain 每任务一条 + background research 一条）的状态表：role、source、channel、status、startedAt、最后输出行、token 用量（blocking 侧）、findings/log 路径（background 侧）。会话内概念，`session_shutdown` 时清空。驱动 footer 计数与 `/subagents` 命令两条可见性入口。
_Avoid_: session store, 状态表

**run status（运行状态）**:
一个 subagent 运行的生命周期状态，枚举冻结为 `queued / running / succeeded / failed / aborted / terminated`。`queued` 是并行模式里等并发槽（`MAX_CONCURRENCY`）的任务；`terminated` 是 background research 被 hard cap 击杀的终态（靠 findings 里的 `research-terminated` marker 判定）；终态（succeeded/failed/aborted/terminated）冻结，不可再更新。TODO 原文的 `blocked` 无现实对应（本插件无重试/等待），已删除。
_Avoid_: pending, blocked, 状态机

**subagent overview（运行总览）**:
用户查看运行注册表的入口：footer 常驻计数（`⧗ N subagents running`，N 含 queued+running，blocking 期间也可见）+ `/subagents` 命令（空闲时读完整快照：状态分组、开始时间、时长、最后输出、用量、路径）。blocking 期间命令不可达是输入排队机制的固有行为。
_Avoid_: status panel, 面板
