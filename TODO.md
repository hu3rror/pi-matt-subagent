# TODO → 归档索引

本文件已不再承载待办内容：所有条目均已实现，并迁移为 GitHub issues / ADR 作为定位记录（本地 Markdown 会污染 AI 上下文，检索请走 issue tracker / `docs/adr/`）。

## 条目映射

| 原条目 | 载体 | 定位 |
|---|---|---|
| A1 chain 模式 smoke 验证 | Issue [#3](https://github.com/hu3rror/pi-matt-subagent/issues/3) | `{previous}` 逐级传递 + 失败即停 |
| A2 后台 research 验证（Seam A/B/C） | Issue [#4](https://github.com/hu3rror/pi-matt-subagent/issues/4) | lib.ts 重构 + 8 测试，commit `797b5e1` |
| A3 project-agent 信任确认弹窗 | Issue [#5](https://github.com/hu3rror/pi-matt-subagent/issues/5) + ADR 0007 | `ctx.ui.confirm` 逐次授权、不写 trust.json |
| A4 错误路径验证 | Issue [#6](https://github.com/hu3rror/pi-matt-subagent/issues/6) | 429/error 报错 + isError 传播 |
| B1 后台 prompt 装配统一 | [ADR 0006](docs/adr/0006-background-prompt-file-assembly.md) | 统一 `--append-system-prompt`，role 内容不进 argv |
| B2 research 暴露 agentScope | [ADR 0007](docs/adr/0007-research-agentscope-trust-confirm.md) | `agentScope` + `confirmProjectAgents` 共用 |
| C1 `pi install -l` 验证 | Issue [#7](https://github.com/hu3rror/pi-matt-subagent/issues/7) | slash command 发现；TUI 部分待验 |
| C2 测试命令固化 + parse 守卫 | Issue [#8](https://github.com/hu3rror/pi-matt-subagent/issues/8) | `npm test` + `stripTypeScriptTypes` 守卫 |
| D1 thinkingLevel 继承 | [ADR 0005](docs/adr/0005-thinking-level-inheritance.md) | override > role > inherited + per-call 逃生舱 |
| D2 fff 工具名映射 | [ADR 0002](docs/adr/0002-tool-name-resolution-direction.md) | 增强名→内置名，绝不反向 |
| D3 运行注册表总览 | Issue [#2](https://github.com/hu3rror/pi-matt-subagent/issues/2) + [ADR 0004](docs/adr/0004-subagent-run-registry-overview.md) | footer 计数 + `/subagents` |
| D4 research budget | Issue [#1](https://github.com/hu3rror/pi-matt-subagent/issues/1) + [ADR 0003](docs/adr/0003-research-budget-effort-control.md) | 3 soft + 2 hard，110% kill |
| E1 实战 /code-review | Issue [#9](https://github.com/hu3rror/pi-matt-subagent/issues/9) | 6c33cf4 两轴 review |
| E2 实战 /design-it-twice | Issue [#10](https://github.com/hu3rror/pi-matt-subagent/issues/10) | 4 路并行接口设计 + 限流观测 |

## 未闭合注意点

- A1：成功路径的 `{previous}` 输出逐级传递缺一次完整观测。
- A4：`aborted`（用户中断）分支仍未测。
- C1：TUI `/reload` 热重载、`/design-it-twice` 补全待验。
- A2：真实 pi 冒烟待 provider 限流缓解后另测。