# pi-matt-subagent

> English: [README.md](README.md)

<p align="center">
  <img src="docs/banner.webp" alt="pi-matt-subagent：把 Matt Pocock 的 skills 变成阻塞式/后台式 subagent" width="800">
</p>

一个 [pi](https://github.com/earendil-works/pi) 插件，把 [Matt Pocock 的 skills](https://github.com/mattpocock) 里的 subagent 指令变成真正的工具调用。当某个 skill 写到 *"spawn sub-agents in parallel"* 或 *"fire the research subagents"* 时，本插件就是它的执行层——启动真实的 pi subagent（独立子进程，后台任务则用进程内会话），等待它们完成，然后把结果交还给你。

## 特性

- **两个工具、两种语义** —— `subagent`（阻塞式）与 `research`（后台式），与上游 skills 的要求一一对应。
- **阻塞式 subagent** —— 在独立子进程中运行单个 / 并行 / 链式 agent；结果一次性全部返回，`chain` 通过 `{previous}` 占位符实现步骤间传递。
- **后台 research** —— 进程内第二会话在后台把带引用的调研结果写入文件，你继续干活；完成状态（`succeeded` / `failed` / `terminated` / `aborted`）会推送到你的上下文——无需轮询。
- **六个内置角色** —— `standards-reviewer`、`spec-reviewer`、`design-explorer`、`architecture-scout`、`researcher`、`fact-finder`，与 skills 描述的角色一一对应。
- **四个斜杠命令** —— `/code-review <ref>`、`/design-it-twice <candidate>`、`/research <question>`，以及用于运行管理的 `/subagents`。
- **单次运行覆盖** —— 通过隐藏的 `input` 字段为某一次运行指定不同的模型或思考级别。
- **实时的运行管理** —— 页脚计数器（`⧗ N subagents running`），用 `/subagents` 跟踪、停止或查看运行。

> [!WARNING]
> 本插件注册了一个名为 `subagent` 的工具；其他 subagents 扩展也是这样。两者不要同时安装——二选一，绝不共存。

## 安装

```sh
pi install npm:pi-matt-subagent
```

或者从本地仓库安装：

```sh
pi install <path-to-this-repo>
```

两种方式都会安装扩展和 prompt 模板（`/code-review`、`/design-it-twice`、`/research`；`/subagents` 随扩展内置）。用 `pi list` 验证；prompt 会出现在 TUI 的 `/` 补全中。

## 快速上手

这里的一切都是面向模型的：你描述任务，主 agent 负责发起调用。

- **审查最近一次提交** —— `/code-review HEAD~1` 以两个并行的阻塞式 subagent 分别跑 Standards 与 Spec 两条轴线，并排汇报。
- **后台调研，同时继续干活** —— `/research "verify the claim that …"` 立即返回句柄；运行结束时把调研结果路径推送到你。
- **直接调用工具** —— 例如说"用 `standards-reviewer` 对 `src/lib.ts` 跑一次 `subagent` 审查"，或"对 ADR 0013 启动一个 `research`，把结果写到 `docs/research-0013.md`"。

## 用法

### 两个工具

| 工具 | 语义 | 作用 |
| --- | --- | --- |
| `subagent` | **阻塞式** | 运行单个 / 并行 / 链式 subagent。在所有 subagent 完成前不返回；完整结果一次性回到一个工具结果中。`chain` 支持 `{previous}` 占位符，把上一步的输出传给下一步。 |
| `research` | **后台式** | 进程内第二会话把带引用的调研结果写入文件后立即返回，完成状态推送到你的上下文——无需轮询。 |

两者都接受可选的 `input` 字段：一个承载公开 schema 之外高级参数的 JSON 对象字符串。`subagent` 接受 `model` 与 `thinkingOverride`（单次运行的模型与思考级别）；`research` 接受 `model` 与 `maxWallClockMs`（墙钟时间上限，只能收紧，默认 60 分钟）。直接字段优先于同名 JSON 键；非法 JSON 会抛出清晰的模型可见错误，合并后的参数在派发前会按完整契约校验。

```json
{
  "task": "review the diff since HEAD~1 for standards compliance",
  "agent": "standards-reviewer",
  "input": "{\"model\": \"sensenova/deepseek-v4-pro\", \"thinkingOverride\": \"high\"}"
}
```

模型名按 `provider/id` 形式解析自 `~/.pi/agent/models.json` 注册表；无法解析的名称会大声失败，运行不会启动。

### 四个斜杠命令

- **`/code-review <ref>`** —— 对自 `<ref>` 起的 diff 做双轴线（Standards + Spec）审查，以两个并行的阻塞式 subagent 运行。
- **`/design-it-twice <candidate>`** —— 为一个待加深的候选生成 3–4 个截然不同的接口设计（并行阻塞式 subagent），再按深度、内聚性与切缝位置比较。
- **`/research <question>`** —— 启动一个针对一手资料的后台研究员，你继续干活；完成后把调研结果路径连同完成状态推送给你。
- **`/subagents`** —— 所有运行的概览与管理：跟踪进度、停掉失控的研究员、清理已结束记录、查看运行日志（`kill`、`tail`、`prune`、`snapshot`）。

### 角色与派发

插件内置六个角色；`~/.pi/agent/agents/` 下的用户 agent 与 `.pi/agents/` 下的项目 agent 按名称覆盖内置角色（项目 agent 需经过信任确认）。派发优先级为：单次调用覆盖 > 角色声明 > 配置默认值 > 主会话继承。

## 配置

行为旋钮存放在懒创建的文件 `~/.pi/agent/extensions/matt-subagent.json`。加载不会写它——只有 `set` 或 `reset` 时文件才会出现——删除文件即恢复全部默认值。修改在下次运行生效，无需 `/reload`。

| 键 | 默认值 | 作用 |
| --- | --- | --- |
| `maxTasksPerCall` | 8 | 单次调用的任务上限——并行任务**和**链式步骤都算；超限拒绝调用 |
| `maxConcurrency` | 4 | 并行模式下同时在飞的 subagent 进程数上限 |
| `perTaskOutputCap` | 50 KiB | 并行聚合中单个任务摘要输出的字节上限 |
| `researchWallClockMs` | 60 分钟 | 后台 research 的默认墙钟上限，也是 `input.maxWallClockMs` 的硬上限 |
| `logTailBytes` | 4096 | `/subagents tail` 读取日志的字节上限 |
| `dispatchDefaultModel` | （继承） | 调用与角色都未指定时的默认 `provider/id` |
| `dispatchDefaultThinkingLevel` | （继承） | 调用与角色都未指定时的默认思考级别 |

通过 `/subagents config` 驱动：

```
/subagents config set maxConcurrency 6
/subagents config set dispatchDefaultThinkingLevel low
/subagents config reset maxConcurrency
/subagents config reset
```

`set` 把生效值写入文件；`reset` 移除单个键（回到该旋钮的默认值）或整个文件。非法条目会使对应键降级为默认值，并在配置视图中标记 `[degraded]`。

## 项目结构

```
extensions/subagent.ts   pi 扩展：注册 subagent 与 research 工具，以及进程内
                         research 子会话工厂
src/lib.ts               纯逻辑——角色、工具 schema（唯一事实来源）、input 合并/校验、
                         工具名解析、research runner；零 pi 运行时依赖，用 node --test 测试
src/lib.test.ts          单元测试
scripts/                 token 基准与 e2e 脚本（仅开发用）
prompts/                 四个斜杠命令的模板
docs/adr/                18 条已记录的决策（双通道、research 重构、配置面、usage 行……）
GLOSSARY.md              领域词汇表（subagent、role、blocking、background、push……）
```

## 开发

```sh
npm test          # 单元测试，无需 pi 运行时
npm run typecheck # 扩展、lib 与脚本的类型检查
```

扩展只是 `src/lib.ts` 的薄消费者；测试覆盖的是其中的纯函数（派发参数组装、工具解析、`input` 合并/校验、工具面契约）。真实 pi 的 e2e 脚本（`scripts/push-e2e.ts`、`scripts/blocking-e2e.ts`）钉住了单元测试够不到的进程接线；`node scripts/benchmark-tools.ts` 测量工具面的 token 贡献（`subagent` / `research` 约 531 / 448 tokens），并有回归测试守护。`node scripts/apply-skill-patch.ts` 在 mattpocock 上游同步后，把 ADR 0013 的补丁文本重新应用到已安装的 skills。