# pi-matt-subagent

> English: [README.md](README.md)

<p align="center">
  <img src="docs/banner.png" alt="pi-matt-subagent：从 Matt Pocock skills 到 blocking/background 子代理" width="800">
</p>

一个 pi 插件，负责把 [Matt Pocock 的 skills](https://github.com/mattpocock) 里「spawn sub-agents」这类指令变成真实可跑的动作。当某个 skill 写着 *"spawn sub-agents in parallel"* 或 *"fire the research subagents"* 时，这个插件就是执行层：它启动真正的 pi 子代理——blocking 用独立子进程，后台 research 用进程内第二会话（ADR 0013）——阻塞等待（后台场景则不等待），然后把结果交回给你。

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

每条运行都会反映在 footer 计数器（`⧗ N subagents running`）上，blocking 运行期间也能看到。`/subagents` 列出完整快照并管理运行：无参弹菜单（查看运行 / 终止 run / 清理已结束 / 查看日志末尾），带参直接操作（`kill <id>` / `tail <id>` / `prune` / `snapshot`）。停止一条 background research 运行会中止其进程内子会话，并把运行记作 `aborted`（和每个终态一样推送结果），而不是 `failed` 或 `terminated`。每条 `research` 运行都由单一的墙钟上限约束（默认 60 分钟；可按次用隐藏 `maxWallClockMs` 收紧）：findings 在每轮搜索前检查点落盘，所以上限击杀最多损失一轮工作；墙钟击杀会在 findings 文件末尾追加精简的 `research-terminated` 标记，并把运行记作 `terminated`。blocking 运行期间命令排队，中途只能用 Esc 整体中止。每条 blocking 用量行——`subagent` 工具结果里的行与 `/subagents` 快照行的 `usage:` 行——末尾都带派发模型及其思考档位，形态沿用 pi 主 footer（`(sensenova) deepseek-flash • high`）；`off` 写作 `thinking off`，未设档的运行写作 `default`（显示的是派发意图，不是子进程实际档位，见 ADR 0015）。

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

两种方式都会安装扩展（两个工具）和 prompt 模板（四个 slash command 中的三个——`/code-review`、`/design-it-twice`、`/research`；`/subagents` 随扩展内置）。用 `pi list` 确认；prompts 会出现在 TUI 的 `/` 补全里。

## 快速上手

装完开一个会话就能用。工具面向模型：你描述任务，主 agent 负责调用。

- **审你最近的提交** —— `/code-review HEAD~1` 用两个并行 blocking 子代理分别跑 Standards 和 Spec 两轴，并排报告。
- **后台研究，同时继续干活** —— `/research "验证某个论断…"` 立即返回 handle；run 结束时 findings 路径会推送给你。
- **直接调工具** —— 对主 agent 说 "run a `subagent` review of `src/lib.ts` with `standards-reviewer`"，或 "start a `research` on ADR 0013 and write findings to `docs/research-0013.md`"。

### 每次运行换模型

两个工具默认沿用主会话的模型，都支持通过隐藏的 `input` 字段按次覆盖：

| 工具 | 隐藏 `input` 键 | 作用 |
| --- | --- | --- |
| `subagent` | `model`、`thinkingOverride` | 本次运行的模型（`provider/id`）与思考档位 |
| `research` | `model`、`maxWallClockMs` | 模型覆盖；墙钟上限——只能收紧，默认 60 分钟 |

不用手写 `input`——直接说 "run that review with `deepseek-v4-pro`" 或 "research this with a 30-second cap"，主 agent 会在工具调用里带上。手写时形如：

```json
{
  "task": "review the diff since HEAD~1 for standards compliance",
  "agent": "standards-reviewer",
  "input": "{\"model\": \"sensenova/deepseek-v4-pro\", \"thinkingOverride\": \"high\"}"
}
```

模型名按 `provider/id` 对照 `~/.pi/agent/models.json` 注册表解析；解析不了的名字在工具层大声报错，run 不会启动。直接字段优先于 JSON 同名键，合并结果派发前按完整契约校验（ADR 0011）。

## 配置（ADR 0018）

本扩展的运行旋钮可通过惰性创建的文件配置：`~/.pi/agent/extensions/matt-subagent.json`。加载从不写盘——只有你 `set` 或 `reset` 时才生成文件——删除文件即恢复全部默认。改动对下一次 run 生效，无需 `/reload`。

七个旋钮及其内置默认值：

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `maxTasksPerCall` | 8 | 单次调用任务数上限——并行 tasks **与** chain steps；超出即拒绝该调用 |
| `maxConcurrency` | 4 | 并行模式下同时 in-flight 的子代理进程上限 |
| `perTaskOutputCap` | 50 KiB | 并行聚合中单个任务摘要的字节截断上限 |
| `researchWallClockMs` | 60 分钟 | 后台 research 默认墙钟，也是 `input.maxWallClockMs` 的硬天花板 |
| `logTailBytes` | 4096 | `/subagents tail` 读日志的字节上限 |
| `dispatchDefaultModel` | (继承) | 当调用与角色都未指定时的默认 `provider/id` |
| `dispatchDefaultThinkingLevel` | (继承) | 当调用与角色都未指定时的默认思考档位 |

`dispatchDefaultModel`/`dispatchDefaultThinkingLevel` 显示 `(inherit)`（= 继承主会话的模型/档位）。派发优先级：per-call override > 角色声明 > 配置默认 > 主会话继承。

通过 `/subagents` 命令驱动（也在菜单的 "Settings…" 入口里）：

```
/subagents config
/subagents config set maxConcurrency 6
/subagents config set dispatchDefaultThinkingLevel low
/subagents config set dispatchDefaultModel inherit
/subagents config reset
```

`set` 会重写全量 7 键（自文档化；未改的键保留其值或默认）。非法项——坏 JSON、未知键、类型错、正数约束下 ≤0、未知思考档位、空 model 串——会把该键降级回默认并在配置视图标记 `[degraded]`，所以手误不会弄垮会话。删除文件即完全重置。

## 项目结构

```
extensions/subagent.ts   pi 扩展：注册 subagent + research 两个工具，并提供进程内 research
                         子会话工厂（ADR 0013）
src/lib.ts               纯逻辑——角色定义、工具 schema（单一事实源）、input 合并/校验、
                         工具名解析、派发参数、research runner（子会话工厂 seam）；零 pi
                         运行时依赖，用 node --test 测
src/lib.test.ts          单元测试
scripts/                 token 基准（Seam E）+ 测量扩展 + push-e2e / blocking-e2e 脚本（仅开发用）
prompts/                 四个 slash command 模板
docs/adr/                决策记录：双通道、工具名归一化、research 重构（推送交付、墙钟上限）、
                         运行注册表 + 运行管理、input 逃生舱、共存立场、用量行的模型与思考档位
CONTEXT.md               领域词汇表（subagent、role、blocking、background、push、input-JSON……）
```

两个值得知道的决策：

- **工具名归一化**（`docs/adr/0002`）：角色声明的工具在派发前会对照当前环境的注册表解析。环境里没有的名字回退到内置名（`ffgrep` → `grep`），解析不了的名字直接剔除，而不是让子进程静默缺工具。能适应 fff 模式切换，又不耦合 fff 本身。
- **双通道**（`docs/adr/0001`）：blocking 是默认心智模型；只有 `research`/`wayfinder` 走后台通道。
- **Research 重构**（`docs/adr/0013`）：后台研究者作为进程内第二会话运行；每个终态都经 push 推进主上下文；预算机制坍缩为单一墙钟上限 + 检查点 findings。
- **`input` 逃生舱**（`docs/adr/0011`）：按次的高级参数（`model`、`thinkingOverride`）走 `input` JSON 字段——直接字段覆盖 JSON 键、非法输入大声失败、合并后按完整契约校验再派发。参数 schema 以 `src/lib.ts` 为单一事实源。
- **用量行的模型与思考档位**（`docs/adr/0015`）：每次运行的用量行末尾按 pi 主 footer 形态带出派发模型与思考档位；显示的是派发意图（子进程实际档位不可观测），未设档的运行标为 `default`。

## Token benchmark（token 基准）

单独启用本扩展时，模型可见的常驻初始化贡献如下：

| 工具 | 构成 | Tokens |
| --- | --- | ---: |
| `subagent` | description + 参数 schema | **630** |
| `research` | description + 参数 schema | **517** |

测量环境：pi 0.87.0，2026-09-22（ADR 0013 表面变更后重测），独立临时进程、空白工作目录与空白配置（排除其他扩展、Skills、上下文文件与 slash commands；计入 `before_agent_start` 表面）。Token 按 `ceil(字符数 / 4)` 的固定字符代理估算，并非 provider tokenizer 实际计费值。用 `node scripts/benchmark-tools.ts` 复测；`npm test` 断言序列化表面不超过基线 × 1.2（token 回归守卫），footprint 膨胀会被测试套件拦下。

## 开发

```sh
npm test          # 单元测试，不需要 pi 运行时——src/lib.ts 保持零运行时依赖
npm run typecheck # 扩展 + lib + scripts 类型检查（tsconfig.json，需要已安装的 pi 包）
```

扩展只是 `src/lib.ts` 的薄消费者；纯函数（派发参数装配、工具解析、带可注入子会话工厂 seam 的后台 runner、`input` 合并/校验、契约面）就是测试覆盖的对象。注册表面变化时用 `node scripts/benchmark-tools.ts` 刷新 token 基准数字与守卫基线。

### 真实 pi 的 e2e 脚本（仅开发用，需要可用的模型/API key）

```sh
pi -p --no-session --no-extensions -e extensions/subagent.ts -e scripts/push-e2e.ts \
  "Count slowly from 1 to 25, one number per line, then say done"   # research 接线：spawn、push、crash 隔离、shutdown 清理
pi -p --no-session --no-extensions -e extensions/subagent.ts -e scripts/blocking-e2e.ts \
  "Count slowly from 1 to 25, one number per line, then say done"   # blocking spawn 重接：协议 + usage、dispose-on-close
```

各脚本把 gate 结果追加到系统临时目录的 `push-e2e.log` / `blocking-e2e.log`；每个 gate 看 `PUSH-E2E OK` / `BLOCKING-E2E OK`。不进 `npm test`（Path-1 立场：纯接缝由 `node --test` 覆盖；真实 pi 接线回归由这些脚本捕获，不用 fake-pi harness）。

`blocking-e2e.ts` 是 `push-e2e.ts` 在 blocking 通道的对应物：单元测试用假 runner 和假计时器钉住纯语义（协议累积规则、SIGTERM→SIGKILL 兜底时序），本脚本钉住这些测试够不到的真实进程接线——`runSingleAgent` 用到的那些 spawn 接缝。Gate 1 拉起真实 pi 子进程，走完整条 `getPiInvocation → spawn → accumulator → result` 路径，断言 exitCode 0、消息解析、usage > 0。Gate 2 用 `escalateKill` 对运行中的长任务子进程发 SIGTERM（Esc 中止路径去掉 TUI），断言其在宽限窗口内关闭——即死于 SIGTERM 而非 SIGKILL 兜底——再验证 close→dispose 取消兜底。Windows 限制：进程无法捕获 SIGTERM（TerminateProcess），故 Windows 上 gate 2 只证明真实信号/计时器下的 dispose-on-close 路径；「兜底对无视 SIGTERM 的进程触发」的语义由假计时器单元测试钉住。

### 上游同步后重打 skill 补丁

已安装的 skills 跟随 mattpocock 上游，一次 sync 会覆盖 `research/SKILL.md` 和 `wayfinder/SKILL.md` 里的 ADR 0013 补丁文本（补丁文本保存在 `docs/design/research-redesign/`）。每次 sync 后运行：

```sh
node scripts/apply-skill-patch.ts                 # 重打到 ~/.pi/agent/skills
node scripts/apply-skill-patch.ts --skills-dir X  # 自定义 skills 目录
node scripts/apply-skill-patch.ts --dry-run       # 只预览不写
```

脚本直接从设计文档重打两个补丁：幂等（已打补丁的目标是 no-op，CRLF 安全）；缺目标时 all-or-nothing（任一文件缺失即视为 sync 未跑——一个文件都不动，exit 1）；参数错误报 usage 提示而不是崩溃栈。
