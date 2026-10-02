<div align="center">
  <h1 id="pi-matt-subagent">pi-matt-subagent</h1>
  
  English: [README.md](README.md)
  
  <img src="docs/banner.webp" alt="pi-matt-subagent：把 Matt Pocock 的 skills 变成阻塞式/后台式 subagent" width="800">
</div>

一个 [pi](https://github.com/earendil-works/pi) 插件，把 [Matt Pocock 的 skills](https://github.com/mattpocock) 里关于 subagent 的指令变成真正的工具调用。当某个 skill 写到 *"spawn sub-agents in parallel"* 或 *"fire the research subagents"* 时，这个插件就是执行层——它启动真实的 pi subagent（独立子进程；后台任务则用进程内会话），等它们完成，再把结果交给你。

> [!WARNING]
> 本插件注册了一个名为 `subagent` 的工具；其他 subagents 扩展也这么做。两者不要同时安装——二选一，不要共存。

## 特性

- **两个工具、两种语义** —— `subagent`（阻塞式）和 `research`（后台式），和上游 skills 的要求对齐。
- **阻塞式 subagent** —— 在独立子进程中跑单个 / 并行 / 链式 agent；结果一次性全部返回，`chain` 通过 `{previous}` 占位符把上一步的输出传给下一步。
- **后台 research** —— 进程内第二会话在后台把带引用的调研结果写入文件，你继续干活；完成状态（`succeeded` / `failed` / `terminated` / `aborted`）推回你的会话——不用轮询。
- **六个内置角色** —— `standards-reviewer`、`spec-reviewer`、`design-explorer`、`architecture-scout`、`researcher`、`fact-finder`，和 skills 里描述的角色一致。
- **四个斜杠命令** —— `/code-review <ref>`、`/design-it-twice <candidate>`、`/research <question>`，加上用于运行管理的 `/subagents`。
- **单次运行覆盖** —— 通过隐藏的 `input` 字段为某一次运行指定不同的模型或思考级别。
- **实时运行管理** —— 页脚计数器（`⧗ N subagents running`），用 `/subagents` 跟踪、停止或查看运行。

## 安装

```sh
pi install npm:pi-matt-subagent
```

或者从本地仓库安装：

```sh
pi install <path-to-this-repo>
```

两种方式都会安装扩展和 prompt 模板（`/code-review`、`/design-it-twice`、`/research`；`/subagents` 随扩展内置）。用 `pi list` 验证；prompt 会出现在 TUI 的 `/` 补全里。

## 快速上手

这里的一切都是模型来触发的：你描述任务，主 agent 负责发起调用。

- **审查最近一次提交** —— `/code-review HEAD~1` 用两个并行的阻塞式 subagent 分别从 Standards 和 Spec 两个角度审查，并排汇报。
- **后台调研，同时继续干活** —— `/research "verify the claim that …"` 立即返回；运行结束时把调研结果路径推回给你。
- **直接调用工具** —— 比如说"用 `standards-reviewer` 对 `src/lib.ts` 跑一次 `subagent` 审查"，或"对 ADR 0013 启动一个 `research`，把结果写到 `docs/research-0013.md`"。

## 两个工具

| 工具 | 语义 | 作用 |
| --- | --- | --- |
| `subagent` | **阻塞式** | 运行单个 / 并行 / 链式 subagent。在所有 subagent 完成前不返回；完整结果一次性回到一个工具结果里。`chain` 支持 `{previous}` 占位符，把上一步的输出传给下一步。 |
| `research` | **后台式** | 进程内第二会话把带引用的调研结果写入文件后立即返回，完成状态推回你的会话——不用轮询。 |

两者都接受可选的 `input` 字段：一个承载公开 schema 之外高级参数的 JSON 对象字符串。

- `subagent` 接受 `model` 和 `thinkingOverride`（单次运行的模型和思考级别）。
- `research` 接受 `model` 和 `maxWallClockMs`（运行时长上限，只能收紧默认值，默认 60 分钟）。

直接字段优先于同名 JSON 键；非法 JSON 会抛出清晰的模型可见错误，合并后的参数在派发前会按完整契约校验。

```json
{
  "task": "review the diff since HEAD~1 for standards compliance",
  "agent": "standards-reviewer",
  "input": "{\"model\": \"sensenova/deepseek-v4-pro\", \"thinkingOverride\": \"high\"}"
}
```

模型名按 `provider/id` 形式解析自 `~/.pi/agent/models.json` 注册表；无法解析的名称会大声失败，运行不会启动。

## 四个斜杠命令

- **`/code-review <ref>`** —— 对自 `<ref>` 起的 diff 做双角度审查（Standards + Spec），用两个并行的阻塞式 subagent 运行。
- **`/design-it-twice <candidate>`** —— 为一个待加深的候选生成 3–4 个截然不同的接口设计（并行阻塞式 subagent），再按深度、内聚性和边界位置比较。
- **`/research <question>`** —— 启动一个针对一手资料的后台研究员，你继续干活；完成后把调研结果路径和完成状态推回给你。
- **`/subagents`** —— 所有运行的概览和管理：跟踪进度、停掉失控的研究员、清理已结束记录、查看运行日志（`kill`、`tail`、`prune`、`snapshot`）。

## 角色和派发

插件内置六个角色。`~/.pi/agent/agents/` 下的用户 agent 和 `.pi/agents/` 下的项目 agent 按名称覆盖内置角色（项目 agent 需要信任确认）。

派发优先级：单次调用覆盖 > 角色声明 > 配置默认值 > 主会话继承。

## 配置

配置项存放在按需创建的文件 `~/.pi/agent/extensions/matt-subagent.json`。加载不会写它——只有 `set` 或 `reset` 时文件才会出现——删除文件即恢复全部默认值。修改在下次运行生效，不需要 `/reload`。

| 键 | 默认值 | 作用 |
| --- | --- | --- |
| `maxTasksPerCall` | 8 | 单次调用的任务上限——并行任务**和**链式步骤都算；超限拒绝调用 |
| `maxConcurrency` | 4 | 并行模式下同时运行的 subagent 进程数上限 |
| `perTaskOutputCap` | 50 KiB | 并行聚合中单个任务摘要输出的字节上限 |
| `researchWallClockMs` | 60 分钟 | 后台 research 的默认运行时长上限，也是 `input.maxWallClockMs` 的硬上限 |
| `logTailBytes` | 4096 | `/subagents tail` 读取日志的字节上限 |
| `dispatchDefaultModel` | （继承） | 调用和角色都未指定时的默认 `provider/id` |
| `dispatchDefaultThinkingLevel` | （继承） | 调用和角色都未指定时的默认思考级别 |

通过 `/subagents config` 操作：

```
/subagents config set maxConcurrency 6
/subagents config set dispatchDefaultThinkingLevel low
/subagents config reset maxConcurrency
/subagents config reset
```

`set` 把生效值写入文件；`reset` 移除单个键（回到该键的默认值）或整个文件。非法条目会把对应键回退为默认值，并在配置视图中标记 `[degraded]`。

## 项目结构

```
extensions/subagent.ts         pi 扩展：注册两个工具、运行注册表 UI、进程内 research 子会话工厂
src/lib.ts                     纯逻辑——角色、工具 schema（唯一事实来源）、input 合并/校验、
                               工具名解析、research runner、运行注册表记账；零 pi 运行时依赖
src/blocking-protocol.ts       纯阻塞子进程协议：JSON-lines stdout 累加、usage 跟踪、渐进式 kill
src/blocking-runner.ts         纯阻塞编排——单个 / 并行 / 链式计划
src/*.test.ts                  单元测试（node --test，不需要 pi 运行时）
scripts/                       token 基准和 e2e 脚本（仅开发用）
prompts/                       三个斜杠命令的模板
docs/adr/                      19 条已记录的决策（双通道、research 重构、配置面、usage 行……）
GLOSSARY.md                    领域词汇表（subagent、role、blocking、background、push……）
```

## 开发

```sh
npm test          # 单元测试，不需要 pi 运行时
npm run typecheck # 扩展、lib 和脚本的类型检查
```

扩展只是 `src/lib.ts` 的薄消费者；测试覆盖的是其中的纯函数（派发参数组装、工具解析、`input` 合并/校验、工具面契约）。真实 pi 的 e2e 脚本（`scripts/push-e2e.ts`、`scripts/blocking-e2e.ts`）覆盖单元测试涉及不到的进程接线；`node scripts/benchmark-tools.ts` 测量工具面的 token 贡献（`subagent` / `research` 约 531 / 448 tokens），并有回归测试守护。`node scripts/apply-skill-patch.ts` 在 mattpocock 上游同步后，把 ADR 0013 的补丁文本重新应用到已安装的 skills。
