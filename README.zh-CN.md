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
- **单次运行覆盖** —— 通过公开的 `model` 字段钉住单次运行的模型；思考力度是确定性的（单任务 > 单次调用覆盖 > 会话声明档位 > 按角色定制 > 配置默认 > 角色预设 > 继承主会话档位（原样）），`set-thinking-level` 工具是模型改变它的唯一可见通道。
- **实时运行管理** —— 页脚计数器（`⧗ N subagents running`），用 `/subagents` 跟踪、停止或查看运行。

## 安装

```sh
pi install npm:pi-matt-subagent
```

或者从本地仓库安装：

```sh
pi install <path-to-this-repo>
```

两种方式都会安装扩展，扩展注册三个 workflow preset（`/code-review`、`/design-it-twice`、`/research`）和 `/subagents` 命令。用 `pi list` 验证；preset 会出现在 TUI 的 `/` 补全里，除非用 `hideWorkflowPresets` 配置隐藏（隐藏后需 `/reload` 生效）。

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
| `set-thinking-level` | **会话级** | 把主会话的思考级别设为本会话余下部分（上游 `pi.setThinkingLevel`，仅会话级、绝不持久化；新会话从你的全局默认开始）。模型改变思考力度的唯一可见通道——只在用户明确要求不同深度时调用。设置后，请求档位同时成为子代理派发压过配置默认与按角色钉的**声明档位**（issue #40）。 |

两者都接受可选的 `input` 字段：一个承载仍对公开 schema 隐藏的参数的 JSON 对象字符串（`subagent` 的 `thinkingOverride`；`research` 的 `maxWallClockMs`——运行时长上限，只能收紧默认值，默认 60 分钟）。**单次运行的 `model` 覆盖是两个工具上的公开字段**（ADR 0022——隐藏通道被证明不可靠：模型会漏掉它，运行静默回退到配置的默认模型）。

直接字段优先于同名 JSON 键；非法 JSON 会抛出清晰的模型可见错误，合并后的参数在派发前会按完整契约校验。

```json
{
  "task": "review the diff since HEAD~1 for standards compliance",
  "agent": "standards-reviewer",
  "model": "sensenova/sensenova-6.8-flash-lite"
}
```

思考力度不是参数：每次运行都通过决策层级（单任务 > 单次调用覆盖 > 会话声明档位 > 按角色定制 > 配置默认 > 角色预设 > 继承主会话档位（原样），再经模型能力钳制）解析，或由模型通过 `set-thinking-level` 执行显式指令。仍传 `thinkingLevel` 的旧式调用会以 unknown-parameter 错误响亮失败。

模型名按 `provider/id` 形式解析自 `~/.pi/agent/models.json` 注册表；无法解析的名称会大声失败，运行不会启动。

## 四个斜杠命令

- **`/code-review <ref>`** —— 对自 `<ref>` 起的 diff 做双角度审查（Standards + Spec），用两个并行的阻塞式 subagent 运行。
- **`/design-it-twice <candidate>`** —— 为一个待加深的候选生成 3–4 个截然不同的接口设计（并行阻塞式 subagent），再按深度、内聚性和边界位置比较。
- **`/research <question>`** —— 启动一个针对一手资料的后台研究员，你继续干活；完成后把调研结果路径和完成状态推回给你。
- **`/subagents`** —— 所有运行的概览和管理：跟踪进度、停掉失控的研究员、清理已结束记录、查看运行日志（`kill`、`tail`、`prune`、`snapshot`）。

## 角色和派发

插件内置六个角色。`~/.pi/agent/agents/` 下的用户 agent 和 `.pi/agents/` 下的项目 agent 按名称覆盖内置角色（项目 agent 需要信任确认）。

思考力度通过两个正交层级确定性解析。决策源层级是 **单任务/单步 `thinkingLevel` > 单次调用覆盖（`input.thinkingOverride`）> 声明（会话声明档位——转录里最后一个 `set-thinking-level` 调用的请求值，粘性跨换模型与续会话）> `roleDefaults` 按角色档位 > 配置默认（`dispatchDefaultThinkingLevel`）> 角色预设 > 继承**（主会话档位**原样透传**——你声明的深度如 `xhigh` 会原样传给无预置角色）。结果再经过目标模型的能力钳制（`clampThinkingLevel`，向上优先）——请求档与生效档双记录，被钳制时显示如 `high (req: xhigh)`。公开的 `thinkingLevel` 参数已移除（它是随机性的来源）；模型改变力度的唯一可见通道是 `set-thinking-level` 工具，仅在用户明确要求不同深度时调用。钉了模型的角色（frontmatter/embedded 或 `roleDefaults.<role>.model`）只跳过继承层。派发模型两个工具一致按 per-call 优先解析——per-call 覆盖 > 角色钉的模型 > `roleDefaults` 模型 > 配置默认 > 继承主会话模型。

## 配置

配置项存放在按需创建的文件 `~/.pi/agent/extensions/matt-subagent.json`。加载不会写它——只有 `set` 或 `reset` 时文件才会出现——删除文件即恢复全部默认值。修改在下次运行生效，不需要 `/reload`——例外：`hideWorkflowPresets` 在扩展加载时决定命令注册，需 `/reload` 生效。

| 键 | 默认值 | 作用 |
| --- | --- | --- |
| `maxTasksPerCall` | 8 | 单次调用的任务上限——并行任务**和**链式步骤都算；超限拒绝调用 |
| `maxConcurrency` | 4 | 并行模式下同时运行的 subagent 进程数上限 |
| `perTaskOutputCap` | 50 KiB | 并行聚合中单个任务摘要输出的字节上限 |
| `researchWallClockMs` | 45 分钟 | 后台 research 的默认运行时长上限，也是 `input.maxWallClockMs` 的硬上限（已显式配置的旧值会压过新默认——重置该键才能拿到 45 分钟） |
| `researchChildExtensions` | （默认两包） | research 子会话装载的 npm 包：默认 `npm:@ssk_dev/pi-web-access-lean` + `npm:@upstash/context7-pi`；只有在 JSON 文件里显式写成空数组才彻底禁用扩展 |
| `logTailBytes` | 4096 | `/subagents tail` 读取日志的字节上限 |
| `dispatchDefaultModel` | （继承） | 调用和角色都未指定时的默认 `provider/id` |
| `dispatchDefaultThinkingLevel` | （继承） | 高于角色预设的默认思考级别（issue #39——对六个内置角色生效，不再是死配置）；未设时 → 继承主会话档位（原样） |
| `roleDefaults` | （继承） | 按角色的派发定制：`{ "<role>": { model?, thinkingLevel? } }`。`roleDefaults.<role>.thinkingLevel` 压过配置默认与角色自身预设；`roleDefaults.<role>.model` 压过配置默认模型。用点分键编辑：`config set roleDefaults.standards-reviewer.thinkingLevel low` |
| `hideWorkflowPresets` | `false` | 隐藏三个内置 workflow preset（`/code-review`、`/design-it-twice`、`/research`）——适合已安装对应 skills（覆盖同一工作流）的用户。扩展加载时读取，需 `/reload` 生效。不影响三个工具与 `/subagents` |

`hideWorkflowPresets` 开启后，输入被隐藏的 preset 名称与任何未知 `/` 命令一样：文本原样发给模型。

通过 `/subagents config` 操作：

```
/subagents config set maxConcurrency 6
/subagents config set dispatchDefaultThinkingLevel low
/subagents config set roleDefaults.standards-reviewer.thinkingLevel low
/subagents config set roleDefaults.researcher.model openai/gpt-x
/subagents config set hideWorkflowPresets true
/subagents config reset roleDefaults.standards-reviewer.thinkingLevel
/subagents config reset maxConcurrency
/subagents config reset
```

`set` 把生效值写入文件；`reset` 移除单个键（回到该键的默认值）或整个文件。点分 `roleDefaults.<role>.<field>` 键编辑嵌套旋钮；reset 点分键只移除该字段（清空的角色自动剪除）。非法条目会把对应键回退为默认值，并在配置视图中标记 `[degraded]`。

## Research 子会话扩展（信任面维护）

后台 research 子会话启动时**只带内置工具加上获批的查询包**——绝不复用主会话的完整扩展集。默认装载 `npm:@ssk_dev/pi-web-access-lean`（网页搜索/抓取）与 `npm:@upstash/context7-pi`（库文档），researcher 角色声明的工具名是 `web_access`、`query-docs`、`resolve-library-id`。

这个清单是一块**精心维护的信任面，而不是「凡是查询类工具就默认放行」的承诺**。一个包要进默认列表，必须满足：只读、无外部写副作用、外部成本明确且低、服务于一手来源检案（官网/库文档）。

**按机器维护清单**（不改代码）：

- **扩充/覆盖** —— 把包加进 `researchChildExtensions`（JSON 文件里的数组，或 `/subagents config set researchChildExtensions npm:x,npm:y` 逗号列表）。别忘了下面第 2 步：加载的包只有在角色上也声明了它的工具后，researcher 才看得见。
- **彻底禁用** —— 在 JSON 文件里把 `researchChildExtensions` 写成 `[]`（config-set 命令表达不了空列表）：子会话将不装载任何扩展（完全断网，只剩内置工具）。
- **更细的控制** —— 在 `~/.pi/agent/agents/researcher.md` 建用户代理覆盖内置 researcher 角色（frontmatter `tools:` + 正文；同名覆盖生效，runner 仍会附加 findings 路径/墙钟/checkpoint 规则），精确钉住声明的工具。

**新增查询工具的两步**：(1) *装载*：把它的包放进 `researchChildExtensions`；(2) *暴露*：在 researcher 角色上声明工具名（内置角色列表，或你自己的 `researcher.md`）。两步缺一就是漂移。

**报错形态与处置**。当声明的工具无法装载（包未安装、被 knob 关闭、或平台不可能——例如非 Windows 上的 `powershell`），运行照常启动但该工具不会出现在子会话里：research 工具返回文本与运行日志会带一条 `⚠ Declared but not loaded: …` 漂移提示，researcher 的 prompt 只列出它真正拥有的工具。忽略提示的症状：researcher 模型瞎猜工具名然后死循环。处置：安装该包、把 knob 指向它、或从角色上删掉该工具。

**如何阅读 research 运行日志——每一行是什么**。每次运行的日志（`logPath`，用 `/subagents tail <id>` 看尾部）混着四类内容，其中只有一类是运行结果：

| 行 | 来源 | 说明什么 | 不等于什么 |
|---|---|---|---|
| `[loadout] ok/warn …` | 装载自检（日志首行起） | knob 包的工具是否**装载**成功 | 运行成败 |
| `[run] HH:MM:SS …` | 阶段线（`session created`、`prompt started`、`terminal: <状态>`） | 运行**现在在干什么** | — |
| 模型正文 | researcher 输出 | 研究**进度** | — |
| research-status 推送卡 | 终态推送 | 运行的**权威结果**（`succeeded`/`failed`/`terminated`/`aborted`） | — |

装载行只是装载状态、永远不是运行状态：researcher 照常运行，`terminal:` 阶段线（或推送卡）才是评判依据。正常信号：推送卡到达且为 `succeeded`、findings 文件已写出、日志持续增长。异常信号：长时间停在 `running` 且日志无新行（wall-clock 上限到点会以 `terminated` 收场），或推送卡报 `failed`/`aborted`。每次工具调用还会审计写入日志旁的 `toolcalls.jsonl`——真正跑过什么的最底实据。

## 项目结构

```
extensions/subagent.ts         pi 扩展：注册两个工具、运行注册表 UI、进程内 research 子会话工厂
src/lib.ts                     纯逻辑——角色、工具 schema（唯一事实来源）、input 合并/校验、
                               工具名解析、research runner、运行注册表记账；零 pi 运行时依赖
src/blocking-protocol.ts       纯阻塞子进程协议：JSON-lines stdout 累加、usage 跟踪、渐进式 kill
src/blocking-runner.ts         纯阻塞编排——单个 / 并行 / 链式计划
src/*.test.ts                  单元测试（node --test，不需要 pi 运行时）
scripts/                       token 基准和 e2e 脚本（仅开发用）
prompts/                       三个 workflow preset 的 markdown 源（扩展加载时读取）
docs/adr/                      19 条已记录的决策（双通道、research 重构、配置面、usage 行……）
GLOSSARY.md                    领域词汇表（subagent、role、blocking、background、push……）
```

## 开发

```sh
npm test          # 单元测试，不需要 pi 运行时
npm run typecheck # 扩展、lib 和脚本的类型检查
```

扩展只是 `src/lib.ts` 的薄消费者；测试覆盖的是其中的纯函数（派发参数组装、工具解析、`input` 合并/校验、工具面契约）。真实 pi 的 e2e 脚本（`scripts/push-e2e.ts`、`scripts/blocking-e2e.ts`）覆盖单元测试涉及不到的进程接线；`node scripts/benchmark-tools.ts` 测量工具面的 token 贡献（`subagent` / `research` / `set-thinking-level` 约 482 / 398 / 104 tokens），并有回归测试守护。`node scripts/apply-skill-patch.ts` 在 mattpocock 上游同步后，把 ADR 0013 的补丁文本重新应用到已安装的 skills。
