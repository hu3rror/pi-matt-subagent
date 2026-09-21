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
预算的两层执行语义。soft cap 超限不 kill：researcher 进入收尾模式（wind-down），冻结对应维度、继续完成总结、写 `soft_limit_exceeded` 标记。hard cap 100% 线触达时 runner 发出最后通牒（final notice）并进入收尾宽限（grace period），researcher 收尾后自然退出即成功，宽限到期仍未退出才强 kill 并追加 `research-terminated` 标记；log 维度另保留 110% 即时兜底，只咬失控深挖（runaway）。
_Avoid_: limit, 限制

**wind-down（收尾模式）**:
预算触限后 researcher 进入的收尾状态：冻结已超维度（不再 fetch、不再新搜、不再追加 findings）、落盘检查点（checkpoint）、完成总结。两个触发通道：soft 维度由模型自感知（数行数/轮数）；hard 维度模型无法自观测，靠 runner 的最后通牒（final notice）经预算状态文件（budget-status file）通知。收尾后自然退出记 succeeded，宽限到期未退则 terminated。
_Avoid_: graceful degradation, 降级

**checkpoint（检查点写入）**:
researcher 周期性把 findings 重写为截至目前的全部内容（每轮搜索前一次），使任何 kill/crash 最多损失最后一次落盘之后的新增。交付物保全的第一道保障。
_Avoid_: 定期保存, 快照, snapshot

**grace period（收尾宽限）**:
hard cap 100% 线触达后、强 kill 之前的固定缓冲期，给 researcher 完成检查点与总结并自然退出的机会。宽限内自然退出记 succeeded，到点未退则 terminated。
_Avoid_: 缓冲, cooldown

**final notice（最后通牒）**:
runner 在 hard cap 100% 线触达时发出的收尾信号：researcher 收到后立即停止扩张（fetch/搜索）、落盘检查点、完成总结并结束。它是 hard 维度（模型无法自观测的时间、日志体积）的 wind-down 触发通道。
_Avoid_: warning, 警告

**budget-status file（预算状态文件）**:
runner 周期性重写、researcher 可读的预算消耗视图（各维度当前值 vs 上限、当前阶段）。弥补模型无法自观测 hard 维度的缺口——模型靠读它感知时间与日志消耗，而不是猜测。
_Avoid_: status file, 状态文件

**research-terminated marker（终止标记）**:
收尾宽限（grace period）到期仍未自然退出、被强 kill 后 runner 追加到 findings 的固定注释标记，记录 reason（`wall_clock_exceeded` / `log_bytes_exceeded`）、partial、limit、observed、at。主会话读 findings 时靠它分辨「被硬上限截断」与「正常结果」。partial 描述的是运行被切断，交付物是否完整由 findings 内容自证（收尾检查点带 wind-down-complete 哨兵则完整）。
_Avoid_: kill marker, 截断标记

**runaway（失控深挖）**:
researcher 脱离问题本身、沿无关路径持续深挖（如 PWA 问题一路追到 chromium 源码）直至资源耗尽的行为。hard cap 存在即为其兜底。
_Avoid_: rabbit hole, 打转

**够用即停**:
researcher 的停止规则：信息足够回答问题时立即收尾写 findings，不追源码/实现细节。由 budget 的 prompt 文案显式强调。
_Avoid_: saturation, 信息饱和

**run registry（运行注册表）**:
进程内统一追踪每个 subagent 运行（blocking 的 single/parallel/chain 每任务一条 + background research 一条）的状态表：role、source、channel、status、startedAt、最后输出行、token 用量（blocking 侧）、findings/log 路径与进程 pid（background 侧，manual kill 的定位依据）。会话内概念，`session_shutdown` 时清空。驱动 footer 计数与 `/subagents` 命令两条可见性入口。
_Avoid_: session store, 状态表

**run status（运行状态）**:
一个 subagent 运行的生命周期状态，枚举冻结为 `queued / running / succeeded / failed / aborted / terminated`。`queued` 是并行模式里等并发槽（`MAX_CONCURRENCY`）的任务；`aborted` 是用户主动终止——blocking 期间 Esc 整体中止，或空闲时手动 kill 一个 running 的 background research（见 run management）；`terminated` 严格保留给 background research 被硬上限击杀的终态——收尾宽限到期仍未自然退出，或 log 维度 110% 兜底触发（靠 findings 里的 `research-terminated` marker 判定），手动 kill 从不记作 terminated；宽限内自然退出则记 succeeded。终态（succeeded/failed/aborted/terminated）冻结，不可再更新。TODO 原文的 `blocked` 无现实对应（本插件无重试/等待），已删除。
_Avoid_: pending, blocked, 状态机

**run management（运行管理）**:
用户对 run registry 的可操作面，v1 三个动作：kill（手动终止 running 的 background research，终态 aborted）、prune（移除全部已结束 run 的注册记录，文件保留在 tmp）、tail（读取 research.log 末尾，沿用 readLogTail 的字节上限）。入口是 `/subagents` 命令本身：无参弹 interactive menu，带参直接操作。硬约束：blocking 期间命令不可达，可管理的活动 run 只有 background research——blocking 任务的中止仍是 Esc 整体终止，不经本语义。UI 呈现词（菜单 Stop run / Clear finished / Show log…）与术语/命令动词（kill / tail / prune）分离——后者是规范用词。
_Avoid_: 管理面板, panel

**subagent overview（运行总览）**:
用户查看运行注册表的入口：footer 常驻计数（`⧗ N subagents running`，N 含 queued+running，blocking 期间也可见）+ `/subagents` 命令（空闲时读完整快照：状态分组、开始时间、时长、最后输出、用量、路径）。blocking 期间命令不可达是输入排队机制的固有行为；`/subagents` 同时是 run management 的入口（无参菜单 / 带参直操作）。
_Avoid_: status panel, 面板

**tool error（工具错误信号）**:
失败 blocking subagent 运行通过 throw 向 harness 显式报错——harness 只从 throw 派生 isError（返回字段是死代码，见 ADR 0010）。覆盖 chain 失败步与 single 失败（含 `aborted`，与 runSingleAgent 的 abort throw 一致）；抛出的 Error message 即模型可见文案，与旧 content 逐字相同，由纯函数 `formatBlockingToolError`（lib.ts，node --test 覆盖）构造。parallel 的聚合语义与 research 工具的返回（handle / canceled / budget-error 文本）不在此语义内。
_Avoid_: isError 字段, 错误返回

**input-JSON**:
两个工具各带的可选 `input` 字段的契约（ADR 0011）：值必须是 JSON 对象字符串，携带公开 schema 未暴露但运行时已支持的参数（`subagent`: `model`/`thinkingOverride`；`research`: `model`）。合并规则沿用轻量 subagents 门面的通用做法：直接字段覆盖 JSON 同名键（`{...parsed, ...direct}`）；缺失/空 `input` 直通；非法 JSON 或非对象抛模型可见错误（ADR 0010 throw 契约）。合并后按完整契约（公开 + 隐藏，`additionalProperties: false`）定向校验，错误按字段路径（如 `/model`）报出。
_Avoid_: input param, JSON escape hatch

**token benchmark（token 基准）**:
Seam E 的真实 pi 测量：在独立空配置进程中加载插件扩展 + 测量扩展，于 `before_agent_start` 捕获两个工具注册的模型可见面（description + 参数 schema 序列化），token 按 `ceil(字符数 / 4)` 的固定字符代理估算（非 provider tokenizer 计费）。记录测量日期与 pi 版本，结果喂给 README 表格，并作为回归守卫的基线常量（基线 × 1.2 硬断言，见 surface contract test）。脚本：`scripts/benchmark-tools.ts`，不进 `npm test`。
_Avoid_: footprint estimate, 上下文占用

**surface contract test（契约面测试）**:
Seam D 的测试形态（Path 1，无假 pi）：在 runtime-free 的 lib 层断言两个工具的模型可见契约面——工具名、必填参数、隐藏参数只存在于完整 schema、token 回归守卫（description + schema 序列化的 char/4 ≤ 基线 × 1.2）。schema 单一事实源在 lib 模块，扩展与测试消费同一批对象，两者不会漂移。
_Avoid_: fake-pi harness, 契约测试（泛称）

**help-on-demand（按需帮助）**:
被明确推迟的 schema 瘦身方案（ADR 0012）：把公开 schema 的详细参数藏到 `help` 操作/文档，按需展开，以缩小模型可见 footprint（轻量 subagents 门面的做法）。本插件在 token 基准基线建立之前不做——不盲目瘦身；基线数字出来后再单独决策。
_Avoid_: schema slimming（作为已采纳）, help 命令
