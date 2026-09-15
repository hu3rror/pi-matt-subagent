# TODO

本插件（`pi-matt-subagent`）的待办事项，按「未验证 → 可修 → 可增强 → 实战验证」分档。勾选即完成；如需可拆成 issue。

## A. 未验证的代码路径

- [x] **A1 — `chain` 模式**：顺序执行 + `{previous}` 占位符传递整条分支未 smoke（只验证过 single/parallel）。需一次链式调用确认上下文逐级传递、失败即停。 — ✅ 已 smoke：顺序执行正常；第 2 步 task 中的 `{previous}` 已完成替换、子进程正常启动；因 provider 429 限流在第 2 步失败并按设计中断（`Chain stopped at step 2`）。成功路径的 `{previous}` 输出逐级传递仍缺一次完整观测。
- [x] **A2 — 后台 `research`**：detached 落盘 + log 文件句柄是独立代码路径，从未实测。需确认子进程真的后台跑完并写出 findings 文件、父进程立即返回 handle。 — ✅ 以 TDD 完成（预确认 seam A/B/C）：`buildResearchArgs` 与 `runBackgroundResearch`（spawn 可注入）从扩展移入 `src/lib.ts`，扩展去重为纯消费者；新增 8 个测试（Seam A ×5 命令装配、Seam B ×2 spawn 语义 + role 缺失抛错、Seam C ×1 真实后台落盘：调用方 <800ms 返回 / 子进程睡 1000ms / findings 含 `E2E OK`），全量 21/21；tmpdir 泄漏已清（e2e 曾漏删 `pi-research-*`）。真实 pi 冒烟仍待限流缓解后另测（触发即 `research` 工具 + 轮询 findings 文件）。
- [x] **A3 — project-agent 信任确认弹窗**：需 untrusted 项目 + TUI，未触发过（`ctx.ui.confirm` 分支）。 — ✅ 全验证。TUI 实测（`cd %TEMP%\a3-test-project` → `agentScope=both` 调 `a3-probe`）：① 弹窗出现（`Run project-local agents?` 列出 agent + 来源目录）；② 选 No → 返回 `Canceled: project-local agents not approved.`，子代理不执行；③ 重试批准 → `✓ a3-probe (project) A3 OK`，结果标注 `source=project`。发现逻辑：`both`/`project` scope 可发现 project agent，`user` 排除（单元已验证）。headless（`hasUI=false`）绕过确认直接执行（安全注意点）。**修正**：`ctx.ui.confirm` 是逐次授权，**不写 `trust.json`**（每次调用都会弹）；写 `trust.json` 的是 pi 内置的首次进入项目信任流程。
- [x] **A4 — 错误路径**：子代理失败（非零退出 / `stopReason=error` / `aborted`）的报错文案与 `isError` 传播未验证。 — ✅ 已验证：并行 2 任务遇 429 → 报告 `1/2 succeeded` + `failed (error)` + 原始错误体；链式失败步返回 `isError: true` 并附 `Chain stopped at step N` 文案。`aborted`（用户中断）分支仍未测。另：并行多任务会加剧 provider 限流（4 并发下 429 频发）。

## B. Spec 审查遗留（小修复）

- [x] **B1 — 后台 prompt 装配一致性**：阻塞路径用 `--append-system-prompt` 临时文件，后台路径把 role 内联进 positional prompt。可统一为 `--append-system-prompt`（对应 Spec 审查 c2）。 — ✅ 已统一：`buildResearchArgs` 输出 `--append-system-prompt <prompt.md>` + positional `Task: <task>`，role prompt 与 findings path 全在文件（0600，写于 `pi-research-*` tmpdir，与 log 同生命周期），不再进 argv（Seam A 有断言）。测试迁移踩过坑：S6 曾只迁 1/5 调用点导致 `undefined` 进 argv——已全部补齐。
- [x] **B2 — 后台 `research` 暴露 `agentScope`**：目前固定 `user` scope，project 级 `researcher` 覆盖对后台路径不生效。可选给 `research` 工具加 `agentScope` 参数（含 trust 确认）。 — ✅ 已实现：`ResearchParams.agentScope`（默认 `user`，TypeBox Union 运行时校验非法值）+ execute 用 scope 替换写死的 `"user"`；trust 确认与 `subagent` 工具共用 `confirmProjectAgents` helper（project/both + hasUI + 未信任 + 请求名含 project 源 → `ctx.ui.confirm`，拒绝返回 `Canceled: project-local agents not approved.`）。A2 重构使 lib.ts 零改动（`agents` 已注入）。另抽出 `scopeAllowsProject` 谓词消除枚举知识重复。

## C. 安装 / 分发

- [x] **C1 — `pi install <path>`（或 `-l`）**：安装后 `prompts/code-review.md`、`design-it-twice.md` 才能作为 `/code-review`、`/design-it-twice` slash command 被发现；顺带验证 `/reload`。会写 `~/.pi/agent/settings.json`。 — ✅ 已部分验证：`pi install -l <path>` 实测正常——写入测试项目 `.pi/settings.json`（相对路径 `..\..\x\Repos\pi-matt-subagent` 解析正确）；全局安装早已实证（本会话 `/code-review` 补全 + `subagent`/`research` 工具均在，prompts/extensions 静态检查存在）。🕓 TUI 待验：`/reload` 热重载、`/design-it-twice` 补全（同 `/code-review` 机制，TUI 输 `/` 确认即可）。
- [x] **C2 — 测试命令固化**：package.json 加 `scripts.test` + `.gitignore`。（实测 node v26.8.2 直接 `node --test src/lib.test.ts` 即可跑通 13 个测试，无需 `--experimental-strip-types`） — ✅ 已完成并加固：`scripts.test = node --test src/lib.test.ts src/research-e2e.test.ts src/ext-check.test.ts`（显式文件列表，避免 Windows glob 差异）；`.gitignore`（`node_modules/`）；`npm test` 30/30。**加固**：新增 `src/ext-check.test.ts`——提交态 parse 守卫（`node:module` 的 `stripTypeScriptTypes`）。背景：`node --check` 实测在 ESM+strip 项目作用域下对 `.ts` 一律放行（含坏形态），抓不到 `/**` 注释头丢失这类 parse 错误（曾致提交态扩展不可加载）；`stripTypeScriptTypes` 在 strip 阶段即抛 `ERR_INVALID_TYPESCRIPT_SYNTAX`，红绿演示验证有效。

## D. 子代理健壮性

- [x] **D1 — 思维等级继承**：子代理继承默认 `thinking=high`，复杂任务（如「自己跑 git」）在 `deepseek-v4-flash` 下会打转到上限而不收敛。给 role 加 `thinkingLevel` 字段（默认低一档），或让工具支持 per-call 覆盖。 — ✅ 已实现（TDD，seam 预确认：lib 纯函数 + 扩展透传）。前置查证：`deepseek-v4-flash` 的 `thinkingLevelMap = {off:none, minimal:low, low:low, medium:medium, high:high}` → medium/low 均受支持（无 xhigh/max）。`resolveThinkingLevel`（lib.ts，优先级 override > role > inherited，agent 钉 model 时 undefined 不传 `--thinking`）；embedded roles 差异化：standard/spec/architecture/design/researcher → `medium`，fact-finder → `low`；frontmatter `thinkingLevel` 可覆盖；subagent/research 工具加 per-call `thinkingLevel` 逃生舱（`THINKING_LEVELS` 枚举单一来源 + TypeBox Union 校验）。测试 27/27。🕓 真实生效验证：需**重启会话**（扩展重载）后跑 `/code-review` 对比 medium——本会话扩展为旧代码，子代理仍继承 high。
- [x] **D2 — fff 工具名映射**：`resolveTools` 只处理 `bash`→`powershell`；若 fff 切到 `override` 模式，`grep`/`find` 会失效。可检测 fff override 并映射 `grep`→`ffgrep`、`find`→`fffind`。 — ✅ 已完成，但**修正了原假设**：pi-fff 源码（`OVERRIDE_TOOL_NAMES` 保留 `grep`/`find` 名）+ headless 实测双证「override 下 grep/find 失效」不成立——恰恰相反，`ffgrep`/`ffind` 才在 override 模式（及未装 fff）下失效；TODO 建议的 `grep→ffgrep` 映射在 override 下反而破坏默认角色。**实现**（低耦合，零 pi-fff import）：`TOOL_ALIASES`（`ffgrep→grep`、`ffind→find`）+ `resolveTools(tools, availableTools?)` 仅当声明名不在当前环境工具注册表（扩展侧 `pi.getAllTools()` 探测，主会话注册表全量可靠）时降级到内置名；`buildDispatchArgs`/`buildResearchArgs`/`runBackgroundResearch` 透传 `availableTools`，subagent/research 工具 execute 均接入。新增 8 测试（降级/保留/无注册表透传/未知名透传/别名缺失/TOOL_ALIASES 锁定/win32 bash 共存/buildResearchArgs 透传），38/38 绿；`node --check`（strip）两文件通过；e2e 实跑：override 下声明 `ffgrep/ffind` 的 project role 实际用 `grep` 完成任务，tools-and-ui 下保留 `ffgrep`/`fffind`。

## E. 实战 dogfood

- [x] **E1 — 真实 `/code-review`**：装好后对某个真实 commit 跑一次两轴 review，验证 Standards+Spec 并行阻塞效果。 — ✅ 已完成：对 `6c33cf4`（/research prompt，固定点 `d3aa5fc`）跑完整两轴 review——一次 `subagent` 调用 + `tasks` 数组，standards-reviewer/spec-reviewer 并行阻塞、返回时两轴同时到手、分开报告（符合 blocking 语义与 ADR 0001）。结果：Standards 0 硬违规 + 3 判断项（已顺手修 #1 绝对路径措辞）；Spec 4 项无缺失/越界/错误实现（最重仅「未显式说 single Markdown file」，researcher role prompt 已强制）。
- [ ] **E2 — 真实 `/design-it-twice`**：对某个深化候选跑一次 3+ 并行接口设计。
