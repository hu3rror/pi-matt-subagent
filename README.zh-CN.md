# pi-matt-subagent

> English: [README.md](README.md)

<p align="center">
  <img src="docs/banner.png" alt="pi-matt-subagent：从 Matt Pocock skills 到 blocking/background 子代理" width="800">
</p>

一个 pi 插件，负责把 [Matt Pocock 的 skills](https://github.com/mattpocock) 里「spawn sub-agents」这类指令变成真实可跑的动作。当某个 skill 写着 *"spawn sub-agents in parallel"* 或 *"fire the research subagents"* 时，这个插件就是执行层：它启动真正的 pi 子代理——blocking 用分离子进程，后台 research 用进程内第二会话（ADR 0013）——阻塞等待（后台场景则不等待），然后把结果交回给你。

这个插件本身就是 dogfooding 的产物：上游 skills 有子代理需求，插件才存在。它的两个工具与这些 skill 描述的子代理模式一一对应。

## 为什么会有这个插件

Matt Pocock 的 skills 到处都在要求子代理，却没说明 pi 里具体怎么做。翻一遍就会发现同样的话反复出现：

- **`code-review`** —— Standards 和 Spec 两轴要作为 *并行子代理* 运行，互不污染上下文。
- **`codebase-design`**（`DESIGN-IT-TWICE.md`）—— 派生 3+ 个子代理，各自为同一个模块设计 *截然不同* 的接口。
- **`improve-codebase-architecture`** —— 子代理走查代码库并报告架构摩擦；最后一步就是上面的 design-it-twice。
- **`research`** / **`wayfinder`** —— 起一个 *后台* 代理读一手资料，把结论写进文件，主会话继续干活。

这个插件把这几句话变成工具调用。它内置的角色与这些 skill 描述的任务同名（standards-reviewer、spec-reviewer、design-explorer、architecture-scout、researcher、fact-finder），词汇原样沿用。

## 装了什么

两个工具，对应上游 skills 需要的两种语义：

| 工具 | 语义 | 做什么 |
|---|---|---|
| `subagent` | **blocking** | 运行 single / parallel / chain 子代理。所有子代理跑完才返回，完整结果一次拿回。`chain` 支持 `{previous}` 占位符，把上一步输出传给下一步。 |
| `research` | **background** | 在进程内第二会话（ADR 0013）里运行，把带引用的结论写进文件，立即返回 handle，并把完成状态（succeeded / failed / terminated / aborted）推送进你的上下文——无需轮询。 |

六个内置角色：`standards-reviewer`、`spec-reviewer`、`design-explorer`、`architecture-scout`、`researcher`、`fact-finder`。`~/.pi/agent/agents/` 下的用户代理和 `.pi/agents/` 下的项目代理按名字覆盖内置角色；项目代理需要信任确认。

两个工具都接受一个可选的 `input` 字段：JSON 对象字符串，携带公开 schema 未暴露的高级参数——`subagent` 接受 `model`（本次运行的模型覆盖）和 `thinkingOverride`（本次运行的思考档位），`research` 接受 `model` 和 `maxWallClockMs`（隐藏的墙钟上限，只能把 60 分钟默认值收得更紧）。直接字段覆盖 JSON 同名键；非法 JSON 或非对象值会抛清晰的模型可见错误；合并后的参数在派发前按完整契约校验（ADR 0011）。

> **共存声明**：本插件注册名为 `subagent` 的工具，类似的 subagents 扩展也会注册同名工具。请避免与本插件同时使用其他 subagents 扩展——同名工具会冲突，二选一安装，不要同时装（ADR 0012）。

每条运行都会反映在 footer 计数器（`⧗ N subagents running`）上，blocking 运行期间也能看到。`/subagents` 列出完整快照并管理运行：无参弹菜单（查看运行 / 终止 run / 清理已结束 / 查看日志末尾），带参直接操作（`kill <id>` / `tail <id>` / `prune` / `snapshot`）。停止一条 background research 运行会中止其进程内子会话，并把运行记作 `aborted`（和每个终态一样推送结果），而不是 `failed` 或 `terminated`。每条 `research` 运行都由单一的墙钟上限约束（默认 60 分钟；可按次用隐藏 `maxWallClockMs` 收紧）：findings 在每轮搜索前检查点落盘，所以上限击杀最多损失一轮工作；墙钟击杀会在 findings 文件末尾追加精简的 `research-terminated` 标记，并把运行记作 `terminated`。blocking 运行期间命令排队，中途只能用 Esc 整体中止。

四个 slash command——前三个各直通一个上游模式：

- **`/code-review <ref>`** —— 对 `<ref>` 以来的 diff 做两轴审查（Standards + Spec），两个并行 blocking 子代理。适合审一个 commit、分支或 merge-base。对应 `code-review` skill。
- **`/design-it-twice <candidate>`** —— 为一个深化候选并行生成 3-4 个差异显著的接口设计，再从深度、局部性、接缝位置比较。对应 `codebase-design` 的 DESIGN-IT-TWICE 模式（也是 `improve-codebase-architecture` 的最后一步）。
- **`/research <question>`** —— 起一个后台研究者查一手资料，主会话继续干活；完成状态（succeeded / failed / terminated / aborted）会连同 findings 路径推送给你。对应 `research` skill（以及 `wayfinder` 的 research 工单）。
- **`/subagents`** —— 运行总览与管理：跟踪进度、终止 runaway 的 researcher、清理已结束记录、读 background run 日志。

## 安装

从 npm 安装：

```sh
pi install npm:pi-matt-subagent
```

或从本地仓库安装：

```sh
pi install <本仓库路径>
```

两种方式都会安装扩展（两个工具）和 prompts（三个 slash command）。用 `pi list` 确认；prompts 会出现在 TUI 的 `/` 补全里。

## 项目结构

```
extensions/subagent.ts   pi 扩展：注册 subagent + research 两个工具，并提供进程内 research
                         子会话工厂（ADR 0013）
src/lib.ts               纯逻辑——角色定义、工具 schema（单一事实源）、input 合并/校验、
                         工具名解析、派发参数、research runner（子会话工厂 seam）；零 pi
                         运行时依赖，用 node --test 测
src/lib.test.ts          单元测试
scripts/                 token 基准（Seam E）+ 测量扩展 + push-e2e 脚本（仅开发用）
prompts/                 四个 slash command 模板
docs/adr/                决策记录：双通道、工具名归一化、research 重构（推送交付、墙钟上限）、
                         运行注册表 + 运行管理、input 逃生舱、共存立场
CONTEXT.md               领域词汇表（subagent、role、blocking、background、push、input-JSON……）
```

两个值得知道的决策：

- **工具名归一化**（`docs/adr/0002`）：角色声明的工具在派发前会对照当前环境的注册表解析。环境里没有的名字回退到内置名（`ffgrep` → `grep`），解析不了的名字直接剔除，而不是让子进程静默缺工具。能适应 fff 模式切换，又不耦合 fff 本身。
- **双通道**（`docs/adr/0001`）：blocking 是默认心智模型；只有 `research`/`wayfinder` 走后台通道。
- **Research 重构**（`docs/adr/0013`）：后台研究者作为进程内第二会话运行；每个终态都经 push 推进主上下文；预算机制坍缩为单一墙钟上限 + 检查点 findings。
- **`input` 逃生舱**（`docs/adr/0011`）：按次的高级参数（`model`、`thinkingOverride`）走 `input` JSON 字段——直接字段覆盖 JSON 键、非法输入大声失败、合并后按完整契约校验再派发。参数 schema 以 `src/lib.ts` 为单一事实源。

## Token benchmark（token 基准）

单独启用本扩展时，模型可见的常驻初始化贡献如下：

| 工具 | 构成 | Tokens |
| --- | --- | ---: |
| `subagent` | description + 参数 schema | **630** |
| `research` | description + 参数 schema | **517** |

测量环境：pi 0.87.0，2026-09-22（ADR 0013 表面变更后重测），独立临时进程、空白工作目录与空白配置（排除其他扩展、Skills、上下文文件与 slash commands；计入 `before_agent_start` 表面）。Token 按 `ceil(字符数 / 4)` 的固定字符代理估算，并非 provider tokenizer 实际计费值。用 `node scripts/benchmark-tools.ts` 复测；`npm test` 断言序列化表面不超过基线 × 1.2（token 回归守卫），footprint 膨胀会被测试套件拦下。

## 开发

```sh
npm test   # 单元测试，不需要 pi 运行时——src/lib.ts 保持零运行时依赖
```

扩展只是 `src/lib.ts` 的薄消费者；纯函数（派发参数装配、工具解析、带可注入子会话工厂 seam 的后台 runner、`input` 合并/校验、契约面）就是测试覆盖的对象。注册表面变化时用 `node scripts/benchmark-tools.ts` 刷新 token 基准数字与守卫基线。
