# TODO

本插件（`pi-matt-subagent`）的待办事项，按「未验证 → 可修 → 可增强 → 实战验证」分档。勾选即完成；如需可拆成 issue。

## A. 未验证的代码路径

- [x] **A1 — `chain` 模式**：顺序执行 + `{previous}` 占位符传递整条分支未 smoke（只验证过 single/parallel）。需一次链式调用确认上下文逐级传递、失败即停。 — ✅ 已 smoke：顺序执行正常；第 2 步 task 中的 `{previous}` 已完成替换、子进程正常启动；因 provider 429 限流在第 2 步失败并按设计中断（`Chain stopped at step 2`）。成功路径的 `{previous}` 输出逐级传递仍缺一次完整观测。
- [x] **A2 — 后台 `research`**：detached 落盘 + log 文件句柄是独立代码路径，从未实测。需确认子进程真的后台跑完并写出 findings 文件、父进程立即返回 handle。 — ✅ 以 TDD 完成（预确认 seam A/B/C）：`buildResearchArgs` 与 `runBackgroundResearch`（spawn 可注入）从扩展移入 `src/lib.ts`，扩展去重为纯消费者；新增 8 个测试（Seam A ×5 命令装配、Seam B ×2 spawn 语义 + role 缺失抛错、Seam C ×1 真实 detached 落盘：调用方 <800ms 返回 / 子进程睡 1000ms / findings 含 `E2E OK`），全量 21/21；tmpdir 泄漏已清（e2e 曾漏删 `pi-research-*`）。真实 pi 冒烟仍待限流缓解后另测（触发即 `research` 工具 + 轮询 findings 文件）。
- [x] **A3 — project-agent 信任确认弹窗**：需 untrusted 项目 + TUI，未触发过（`ctx.ui.confirm` 分支）。 — ✅ 全验证。TUI 实测（`cd %TEMP%\a3-test-project` → `agentScope=both` 调 `a3-probe`）：① 弹窗出现（`Run project-local agents?` 列出 agent + 来源目录）；② 选 No → 返回 `Canceled: project-local agents not approved.`，子代理不执行；③ 重试批准 → `✓ a3-probe (project) A3 OK`，结果标注 `source=project`。发现逻辑：`both`/`project` scope 可发现 project agent，`user` 排除（单元已验证）。headless（`hasUI=false`）绕过确认直接执行（安全注意点）。**修正**：`ctx.ui.confirm` 是逐次授权，**不写 `trust.json`**（每次调用都会弹）；写 `trust.json` 的是 pi 内置的首次进入项目信任流程。
- [x] **A4 — 错误路径**：子代理失败（非零退出 / `stopReason=error` / `aborted`）的报错文案与 `isError` 传播未验证。 — ✅ 已验证：并行 2 任务遇 429 → 报告 `1/2 succeeded` + `failed (error)` + 原始错误体；链式失败步返回 `isError: true` 并附 `Chain stopped at step N` 文案。`aborted`（用户中断）分支仍未测。另：并行多任务会加剧 provider 限流（4 并发下 429 频发）。

## B. Spec 审查遗留（小修复）

- [x] **B1 — 后台 prompt 装配一致性**：阻塞路径用 `--append-system-prompt` 临时文件，后台路径把 role 内联进 positional prompt。可统一为 `--append-system-prompt`（对应 Spec 审查 c2）。 — ✅ 已统一：`buildResearchArgs` 输出 `--append-system-prompt <prompt.md>` + positional `Task: <task>`，role prompt 与 findings path 全在文件（0600，写于 `pi-research-*` tmpdir，与 log 同生命周期），不再进 argv（Seam A 有断言）。测试迁移踩过坑：S6 曾只迁 1/5 调用点导致 `undefined` 进 argv——已全部补齐。
- [x] **B2 — 后台 `research` 暴露 `agentScope`**：目前固定 `user` scope，project 级 `researcher` 覆盖对后台路径不生效。可选给 `research` 工具加 `agentScope` 参数（含 trust 确认）。 — ✅ 已实现：`ResearchParams.agentScope`（默认 `user`，TypeBox Union 运行时校验非法值）+ execute 用 scope 替换写死的 `"user"`；trust 确认与 `subagent` 工具共用 `confirmProjectAgents` helper（project/both + hasUI + 未信任 + 请求名含 project 源 → `ctx.ui.confirm`，拒绝返回 `Canceled: project-local agents not approved.`）。A2 重构使 lib.ts 零改动（`agents` 已注入）。另抽出 `scopeAllowsProject` 谓词消除枚举知识重复。

## C. 安装 / 分发

- [ ] **C1 — `pi install <path>`（或 `-l`）**：安装后 `prompts/code-review.md`、`design-it-twice.md` 才能作为 `/code-review`、`/design-it-twice` slash command 被发现；顺带验证 `/reload`。会写 `~/.pi/agent/settings.json`。
- [ ] **C2 — 测试命令固化**：package.json 加 `scripts.test` + `.gitignore`。（实测 node v26.8.2 直接 `node --test src/lib.test.ts` 即可跑通 13 个测试，无需 `--experimental-strip-types`）

## D. 子代理健壮性

- [ ] **D1 — 思维等级继承**：子代理继承默认 `thinking=high`，复杂任务（如「自己跑 git」）在 `deepseek-v4-flash` 下会打转到上限而不收敛。给 role 加 `thinkingLevel` 字段（默认低一档），或让工具支持 per-call 覆盖。
- [ ] **D2 — fff 工具名映射**：`resolveTools` 只处理 `bash`→`powershell`；若 fff 切到 `override` 模式，`grep`/`find` 会失效。可检测 fff override 并映射 `grep`→`ffgrep`、`find`→`fffind`。

## E. 实战 dogfood

- [ ] **E1 — 真实 `/code-review`**：装好后对某个真实 commit 跑一次两轴 review，验证 Standards+Spec 并行阻塞效果。
- [ ] **E2 — 真实 `/design-it-twice`**：对某个深化候选跑一次 3+ 并行接口设计。
