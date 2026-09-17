# 研究：subagent 任务完成时抑制 notify.ts 的「任务完成」通知

> 研究日期/环境：pi 0.85.1（npm 包 `@earendil-works/pi-coding-agent`，下文简称 **$PI_PKG** =
> `C:/Users/Hue/AppData/Local/mise/installs/npm-earendil-works-pi-coding-agent/0.85.1/node_modules/.mise/@earendil-works+pi-coding-agent@0.85.1/node_modules/@earendil-works/pi-coding-agent`）
> 目标仓库：`C:/Users/Hue/Repos/pi-matt-subagent`
>
> **结论先行：可以实现。** 推荐在 notify.ts 的 `agent_settled` 处理器里用官方提供的
> `ctx.mode === "json"` 提前 `return`（方案 A），只改一个文件、零侵入；若想语义最精确
> （只抑制本扩展派生的子进程），改 subagent 扩展的 spawn 注入自定义环境变量（方案 B）。
> pi 官方**没有**为 subagent 子进程设置任何专属环境变量，`agent_settled` payload 也**不带**
> agent 身份信息；唯一的官方判别字段是 `ExtensionContext.mode`。

---

## 1. notify.ts 的通知入口 —— 「任务完成」只有 `agent_settled` 一个入口

### 1.1 用户实际版本（`C:/Users/Hue/.pi/agent/extensions/notify.ts`）

三个事件处理器，但「✅ Pi · 任务完成」只由 `agent_settled` 触发：

| 行号 | 事件 | 内容 |
|---|---|---|
| L96-97 | `pi.on("agent_settled", ...)` | `notify("✅ Pi · 任务完成", "任务已执行完毕")` ← **「任务完成」唯一入口** |
| L103 | `pi.on("ui_prompt_start", ...)` | ⚠️ 等待确认（permission-gate 的 select） |
| L114 | `pi.on("tool_execution_end", ...)` | ⛔ 已拦截（permission-gate tag + `no UI`） |

来源：`C:/Users/Hue/.pi/agent/extensions/notify.ts` L96-97、L103、L114（`ffgrep "pi\.on|notify("`）。

### 1.2 官方示例（`$PI_PKG/examples/extensions/notify.ts`）

只有一处 `pi.on("agent_settled", async () => { notify("Pi", "Ready for input"); })`（L54），
与用户版本一致：通知的唯一生命周期入口是 `agent_settled`。

**结论**：要抑制「subagent 完成时的任务完成通知」，只需处理 `agent_settled` 这一个入口。
（`ui_prompt_start` / `tool_execution_end` 也会在子进程里触发，但用户只抱怨任务完成通知；
如需一并抑制，可在这些 handler 里加同样的守卫，见方案 A 的备注。）

---

## 2. subagent 任务如何执行 —— 独立 pi 子进程，**未设置任何自定义环境变量**

### 2.1 blocking 路径（`subagent` 工具）

`extensions/subagent.ts` 用 `node:child_process` 的 `spawn` 启动子进程（L336-339）：

```ts
const proc = spawn(invocation.command, invocation.args, {
  cwd: cwd ?? defaultCwd,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
});
```

来源：`C:/Users/Hue/Repos/pi-matt-subagent/extensions/subagent.ts` L336-339。
**关键事实：spawn options 里没有 `env` 字段 → 子进程完整继承父进程环境。**

子进程参数由 `buildDispatchArgs` 固定生成（`src/lib.ts` L371-375）：

```ts
const args: string[] = ["--mode", "json", "-p", "--no-session"];
if (opts.model) args.push("--model", opts.model);
if (opts.thinking) args.push("--thinking", opts.thinking);
// 可选 --tools a,b；可选 --append-system-prompt <path>；最后是 "Task: <task>"
```

来源：`C:/Users/Hue/Repos/pi-matt-subagent/src/lib.ts` L371-375。

### 2.2 background 路径（`research` 工具）

`src/lib.ts` L473-477：

```ts
const proc = spawnImpl(invocation.command, invocation.args, {
  cwd: opts.cwd,
  shell: false,
  stdio: ["ignore", logFd, logFd],   // stdout/stderr → 日志文件
  detached: true,
});
```

来源：`C:/Users/Hue/Repos/pi-matt-subagent/src/lib.ts` L473-477。
同样**没有 `env` 字段**，参数同样来自 `buildResearchArgs → buildDispatchArgs`
（`src/lib.ts` L383-399、L371），即同样是 `--mode json -p --no-session` 开头。

### 2.3 官方 pi 示例的做法（对照组）

`$PI_PKG/examples/extensions/subagent/index.ts` L300：`const args: string[] = ["--mode", "json", "-p", "--no-session"];`
spawn 调用（L346 附近）同样不设 `env`。即 pi-matt-subagent 与官方示例的子进程**运行形态完全一致**。

**结论**：subagent 任务 = 独立 pi 子进程，固定带 `--mode json -p --no-session`；
没有任何 `PI_SUBAGENT` / `PI_AGENT` / `SUPERAGENT` 之类的自定义环境变量（未设置 env 选项，全部继承）。

---

## 3. 子进程确实会加载 notify.ts 并触发 `agent_settled` —— 骚扰的机制

1. **子进程会加载扩展**：print mode（`pi -p` 文本 与 `--mode json` 都用它）在启动时调用
   `session.bindExtensions(...)`（`$PI_PKG/dist/modes/print-mode.js` L53-54），子进程内
   notify.ts 照常注册。
2. **每次 run settle 都发 `agent_settled`**：`dist/core/agent-session.js` L347-357
   `_emitAgentSettled()` 里 `await this._extensionRunner.emit({ type: "agent_settled" })`；
   它在 `_runAgentPrompt()` 的 `finally` 中被调用（L784），即子进程跑完唯一一轮 prompt 后必然触发。
3. **Windows 上 toast 不依赖 stdout**：notify.ts 的 `notify()` 在 `WT_SESSION` 存在时走
   `notifyWindows` → `execFile("powershell.exe", ...)` 弹 Windows toast（notify.ts L72-75、L90-93），
   与子进程 stdout 是 pipe 还是日志文件无关。用户环境是 Windows（路径 `C:/Users/...`），
   子进程继承 `WT_SESSION` → 每个 subagent 结束都弹一个「✅ Pi · 任务完成」。
   （OSC 777/99 走 `process.stdout.write`，在 blocking/background 子进程里会被 pipe/日志吞掉，不产生骚扰；
   但 Windows toast 是独立的，这就是骚扰来源。）

来源：`$PI_PKG/dist/modes/print-mode.js` L53-54、`$PI_PKG/dist/core/agent-session.js` L347-357、L784、
`C:/Users/Hue/.pi/agent/extensions/notify.ts` L72-75（notifyWindows）、L90-93（notify 分支）。

---

## 4. 官方 API 里有没有「我是 subagent」的判别？（问题 3 的正面回答）

### 4.1 `agent_settled` payload —— **无身份信息**

```ts
/** Fired after an agent run has fully settled ... */
export interface AgentSettledEvent {
    type: "agent_settled";
}
```

来源：`$PI_PKG/dist/core/extensions/types.d.ts` L560-562。
只有 `type`，没有 agent id/name、没有 session 信息。文档侧同样如此：
`$PI_PKG/docs/extensions.md` L567-578 对 `agent_start / agent_end / agent_settled` 的说明
（`agent_settled` handler 示例只用到 `ctx.isIdle()`）。

### 4.2 ExtensionAPI / ExtensionContext —— **没有身份字段，但有 `ctx.mode`**

- `ExtensionAPI`（types.d.ts L906 起）没有 `pi.agent` 之类的字段；session 相关方法
  （`getSessionName` 等，L959-960 附近）是会话显示名，不标识「主/子」。
- handler 签名：`ExtensionHandler<E, R> = (event: E, ctx: ExtensionContext) => ...`
  （types.d.ts L902）。
- `ExtensionContext` 上**唯一能区分运行形态的官方字段**是 `mode`：

```ts
export type ExtensionMode = "tui" | "rpc" | "json" | "print";
// ExtensionContext 内：
/** Current run mode. Use "tui" to guard terminal-only UI such as custom components. */
mode: ExtensionMode;
```

来源：types.d.ts L208、L213。官方文档 `docs/extensions.md` L968-970：
「Current run mode: `"tui"`, `"rpc"`, `"json"`, or `"print"`」。

各模式的实际绑定值（源码证据）：

| 运行形态 | `ctx.mode` | 来源 |
|---|---|---|
| 交互式 TUI（用户主会话） | `"tui"` | `dist/modes/interactive/interactive-mode.js` L1402-1404 `bindExtensions({ mode: "tui" })` |
| RPC（headless json 协议） | `"rpc"` | `dist/modes/rpc/rpc-mode.js` L230-232 |
| **subagent 子进程（`--mode json -p`）** | **`"json"`** | `dist/modes/print-mode.js` L54 `mode: mode === "json" ? "json" : "print"` |
| `pi -p "..."` 文本单次模式 | `"print"` | 同上（mode 非 json 时） |

**结论**：`ctx.mode === "json"` 精确命中 pi-matt-subagent 与官方示例派生的所有子进程
（两者都固定 `--mode json`），且不命中用户的 TUI 主会话（`"tui"`）。

### 4.3 环境变量 —— **pi 不设置任何 subagent 专属变量**

官方文档 `$PI_PKG/docs/environment-variables.md` 罗列了全部环境变量用法：

1. **进程标记**（所有 CLI/RPC 进程统一设置，主/子一样，无法区分）：
   `AI_AGENT=pi`、`PI_CODING_AGENT=true`。源码：`dist/cli/setup.js` L5-6
   （`dist/rpc-entry.js` L6-7 同样）。
2. **Shell 工具会话变量**：`PI_SESSION_ID` / `PI_SESSION_FILE` / `PI_PROVIDER` / `PI_MODEL` /
   `PI_REASONING_LEVEL` —— 文档明确「These variables are injected into the LLM-callable
   `bash` and `powershell` tools」，即只注入 shell 工具的子进程，**pi 进程自身环境没有**
   （源码：`dist/core/tools/bash.js` L121-134 在构建 shell env 时设置）。
3. **Pi 进程配置变量**（`PI_OFFLINE` 等）：与 subagent 身份无关。

对 `$PI_PKG` 整个包（docs + dist，排除 .map）grep `PI_AGENT|PI_SUBAGENT|SUPERAGENT`：
**无任何匹配**。`PI_SESSION` 系列只在 bash.js 出现（shell 工具注入）。

**结论**：官方没有任何「我在 subagent 子进程里」的环境变量或事件字段可查；
`ctx.mode` 是唯一官方支持的判别途径（且因为 subagent 扩展固定用 `--mode json`，该判别恰好成立）。

---

## 5. 可行过滤方案（问题 4）

### 方案 A（**推荐**）：notify.ts 内用 `ctx.mode === "json"` 提前 return

```ts
pi.on("agent_settled", async (_event, ctx) => {
  if (ctx.mode === "json") return; // subagent 子进程（及任何 --mode json 脚本调用）不通知
  notify("✅ Pi · 任务完成", "任务已执行完毕");
});
```

- 依据：
  - `ctx.mode` 类型与语义：types.d.ts L208/L213；docs/extensions.md L968-970。
  - subagent 子进程固定 `--mode json`：pi-matt-subagent `src/lib.ts` L371；
    官方示例 `examples/extensions/subagent/index.ts` L300。
  - 子进程里 `ctx.mode` 实测为 `"json"`：`dist/modes/print-mode.js` L54。
  - 主 TUI 会话为 `"tui"`：`dist/modes/interactive/interactive-mode.js` L1402-1404。
- 覆盖范围：blocking（`subagent`）与 background（`research`）两种子进程都会被抑制（参数同源）。
- 边界情况：
  - 用户自己手动 `pi --mode json ...` 跑脚本也会被抑制（语义合理：json 模式本就是给脚本/子进程用的，不是交互会话；如需也保留通知可自行调整）。
  - 用户手动 `pi -p "..."`（文本单次，`ctx.mode === "print"`）**仍会**通知。
    若想连它也抑制，可改成 `if (ctx.mode !== "tui") return;`。
  - 仅改 notify.ts 一个文件，不碰 subagent 扩展，升级 pi 也不受影响。

### 方案 B（语义最精确）：subagent 扩展 spawn 时注入自定义环境变量

1. 在 `extensions/subagent.ts` L336-339 与 `src/lib.ts` L473-477 的 spawn 加
   `env: { ...process.env, PI_SUBAGENT: "1" }`。
2. notify.ts 里 `if (process.env.PI_SUBAGENT) return;`。

- 依据：当前两处 spawn 均未设 `env`（继承父环境）——`extensions/subagent.ts` L336-339、
  `src/lib.ts` L473-477；官方不占用该变量名（§4.3 全包 grep 无 `PI_SUBAGENT`）。
- 优点：只抑制**本扩展**派生的子进程，完全不误伤用户自己的 `--mode json` / `-p` 调用。
- 缺点：需要改两个文件并保持 notify.ts 与 subagent 扩展的约定同步；
  变量名是自定义的，理论上可能与未来 pi 版本冲突（可加注释说明）。

### 方案 C：notify.ts 内检查 `process.argv`

子进程 argv 恒包含 `--no-session`、`--mode`、`json`、`-p`（`src/lib.ts` L371），可据此判断：

```ts
const argv = process.argv;
if (argv.includes("--no-session") && argv.includes("--mode") && argv.includes("json")) return;
```

- 依据：`buildDispatchArgs`（`src/lib.ts` L371-375）；`--no-session` 是「临时会话不保存」
  （`docs/usage.md` L205、`docs/sessions.md` L12）。
- 缺点：字符串匹配脆弱；用户手动 `pi --no-session -p ...` 也会被抑制；
  与方案 A 相比没有任何优势（A 用的还是官方类型化字段）。不推荐，仅作备选。

### 方案 D：`registerFlag` + `getFlag` 协作（官方扩展机制）

1. notify.ts 注册 flag：`pi.registerFlag("subagent-child", { type: "boolean" })`，
   在 `agent_settled` 里 `if (pi.getFlag("subagent-child")) return;`。
2. subagent 扩展在 `buildDispatchArgs`（`src/lib.ts` L371）恒追加 `--subagent-child`。

- 依据：`ExtensionAPI.registerFlag / getFlag`（types.d.ts 中 `registerFlag` / `getFlag` 声明）。
- 优点：类型化、自解释；缺点：与方案 B 一样要改两个扩展，且多一步 flag 注册，复杂度高于 B。
  一般不如 B。

### 建议

- **最小改动、官方 API**：方案 A（一个 `if`，纯 notify.ts）。
- **只抑制本扩展子进程、不误伤手动调用**：方案 B。
- 无论哪个方案，都只在 `agent_settled` 入口加守卫即可（§1 已证「任务完成」通知唯一入口）；
  若要连子进程里 permission-gate 的 ⚠️/⛔ 通知一起抑制，在 `ui_prompt_start`（notify.ts L103）
  和 `tool_execution_end`（L114）的 handler 里加同样的守卫。

---

## 6. 未验证事项（明确标注）

1. **Windows toast 与子进程退出的竞态**：`notifyWindows` 用 `execFile` fire-and-forget
   （notify.ts L72-75），`agent_settled` 的 emit 是 `await` 的（agent-session.js L350），
   子进程随后退出；powershell 进程是否一定在退出前完成 toast 显示，**源码层面未验证**。
   用户实证报告「每次 subagent 完成都弹通知」，说明实际会弹；实现后如想确认可用日志验证。
2. **用户是否手动使用 `pi --mode json` / `pi -p`**：未知，影响方案 A/C 的边界行为
   （A 会抑制手动 `--mode json`，不会抑制 `-p`；B 两者都不影响）。
3. **方案 B/D 的环境变量/flag 名与未来 pi 版本是否冲突**：按当前 0.85.1 全包 grep 无冲突，
   未来版本未验证。

---

## 附：关键来源清单（文件 + 位置）

| 事实 | 来源 |
|---|---|
| 「任务完成」唯一入口 `agent_settled`（用户 notify.ts L96-97） | `C:/Users/Hue/.pi/agent/extensions/notify.ts` |
| 官方 notify.ts 仅 `agent_settled`（L54） | `$PI_PKG/examples/extensions/notify.ts` |
| 子进程 spawn 无 env（L336-339） | `C:/Users/Hue/Repos/pi-matt-subagent/extensions/subagent.ts` |
| 子进程参数 `--mode json -p --no-session`（L371） | `C:/Users/Hue/Repos/pi-matt-subagent/src/lib.ts` |
| background spawn 无 env（L473-477） | `C:/Users/Hue/Repos/pi-matt-subagent/src/lib.ts` |
| 官方示例同参数（L300） | `$PI_PKG/examples/extensions/subagent/index.ts` |
| 子进程加载扩展 + mode="json"（L53-54） | `$PI_PKG/dist/modes/print-mode.js` |
| 主 TUI mode="tui"（L1402-1404） | `$PI_PKG/dist/modes/interactive/interactive-mode.js` |
| RPC mode="rpc"（L230-232） | `$PI_PKG/dist/modes/rpc/rpc-mode.js` |
| `agent_settled` 每次 run settle 必发（L347-357、L784） | `$PI_PKG/dist/core/agent-session.js` |
| `AgentSettledEvent` 无身份（L560-562） | `$PI_PKG/dist/core/extensions/types.d.ts` |
| `ExtensionMode` / `ctx.mode`（L208、L213） | `$PI_PKG/dist/core/extensions/types.d.ts` |
| `ctx.mode` 文档（L968-970） | `$PI_PKG/docs/extensions.md` |
| 环境变量全览（进程标记 / shell 工具变量） | `$PI_PKG/docs/environment-variables.md` |
| `AI_AGENT` / `PI_CODING_AGENT` 全进程统一（L5-6） | `$PI_PKG/dist/cli/setup.js` |
| `PI_SESSION_ID` 等仅注入 shell 工具（L121-134） | `$PI_PKG/dist/core/tools/bash.js` |
| 无 `PI_AGENT/PI_SUBAGENT/SUPERAGENT` | `$PI_PKG` 全包 grep（docs+dist，排除 .map） |
| `--no-session` = 临时会话（L205） | `$PI_PKG/docs/usage.md` |
