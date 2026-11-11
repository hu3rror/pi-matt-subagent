import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { escalateKill, type BlockingResultAccumulator, type SingleResult } from "./blocking-protocol.ts";
import type { RunnerSeam, RunnerTask } from "./blocking-runner.ts";
import type { HcClient } from "./hc-client.ts";
import { findSh, runInTerminal, type TerminalInvocation } from "./terminal-run.ts";

export interface ChildSpec {
  invocation: TerminalInvocation;
  cwd: string;
  env: NodeJS.ProcessEnv;
  accumulator: BlockingResultAccumulator;
  /** The registry run id this child belongs to (terminal identity and failure messages). */
  runId: string;
  role: string;
}

export interface ChildRunOptions {
  signal?: AbortSignal;
  /** Surfaces a per-run degradation (the `hc` carrier falling back to `spawn`). */
  onWarn?: (message: string) => void;
}

export interface ChildOutcome {
  exitCode: number;
  aborted: boolean;
}

export type ChildTransport = (spec: ChildSpec, opts: ChildRunOptions) => Promise<ChildOutcome>;

export function blockingTerminalName(runId: string): string {
  const suffix = runId.slice(0, 8).replace(/[^a-z0-9-_.]/gi, "-");
  return `sa-${suffix || "run"}`;
}

/** The labels a terminal listing is correlated by. */
export function blockingTerminalLabels(runId: string, role: string): Record<string, string> {
  return { run: runId, kind: "blocking", role };
}

export const spawnTransport: ChildTransport = (spec, opts) =>
  new Promise<ChildOutcome>((resolve) => {
    let aborted = false;
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(spec.invocation.command, spec.invocation.args, {
        cwd: spec.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: spec.env,
      });
    } catch {
      resolve({ exitCode: 1, aborted: false });
      return;
    }

    proc.stdout?.on("data", (data) => spec.accumulator.onStdout(data.toString()));
    proc.stderr?.on("data", (data) => spec.accumulator.onStderr(data.toString()));
    proc.on("close", (code) => resolve({ exitCode: code ?? 0, aborted }));
    proc.on("error", () => resolve({ exitCode: 1, aborted }));

    if (opts.signal) {
      const escalation = escalateKill(proc);
      const onAbort = () => {
        aborted = true;
        escalation.send();
      };
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
      // Exit within grace cancels the SIGKILL backstop.
      proc.on("close", () => escalation.dispose());
    }
  });

export interface HcTransportDeps {
  client: HcClient;
  fallback?: ChildTransport;
  findShell?: (env: NodeJS.ProcessEnv) => string | undefined;
  makeRunDir?: () => string;
  removeRunDir?: (dir: string) => void;
  /** Seconds per `terminal.wait` check-in. */
  checkInSeconds?: number;
  /** Fires once with the address as soon as the terminal exists, before it is waited on. */
  onStarted?: (terminal: string) => void;
}

function makeTempRunDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-hc-run-"));
}

function removeTempRunDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Startup failures warn and fall back to `spawn`; a core lost mid-run fails the run. */
export function createHcTransport(deps: HcTransportDeps): ChildTransport {
  const fallback = deps.fallback ?? spawnTransport;
  const resolveShell = deps.findShell ?? ((env: NodeJS.ProcessEnv) => findSh(env));
  const makeRunDir = deps.makeRunDir ?? makeTempRunDir;
  const removeRunDir = deps.removeRunDir ?? removeTempRunDir;

  return async (spec, opts) => {
    const warn = opts.onWarn ?? (() => {});
    const shell = resolveShell(spec.env);
    if (!shell) {
      warn("carrier hc: no sh on PATH, so a terminal cannot run the child; falling back to spawn for this run.");
      return fallback(spec, opts);
    }

    const dir = makeRunDir();
    try {
      const outcome = await runInTerminal(
        {
          invocation: spec.invocation,
          sh: shell,
          cwd: spec.cwd,
          env: Object.fromEntries(
            Object.entries(spec.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
          ),
          name: blockingTerminalName(spec.runId),
          labels: blockingTerminalLabels(spec.runId, spec.role),
          outPath: path.join(dir, "stdout.jsonl"),
          errPath: path.join(dir, "stderr.log"),
        },
        {
          client: deps.client,
          signal: opts.signal,
          checkInSeconds: deps.checkInSeconds,
          onStarted: deps.onStarted,
        },
      );

      if (!outcome.ok) {
        if (outcome.kind === "startup") {
          warn(`carrier hc: ${outcome.message}; falling back to spawn for this run.`);
          return fallback(spec, opts);
        }
        if (outcome.kind === "aborted") {
          if (!outcome.killed) warn(`carrier hc: ${outcome.message}`);
          return { exitCode: 1, aborted: true };
        }
        throw new Error(
          `carrier hc: herdr-core lost terminal ${blockingTerminalName(spec.runId)} (${outcome.terminal}) ` +
            `during run ${spec.runId}: ${outcome.message}`,
        );
      }

      spec.accumulator.onStdout(outcome.stdout);
      spec.accumulator.onStderr(outcome.stderr);
      return { exitCode: outcome.exitCode, aborted: false };
    } finally {
      try {
        removeRunDir(dir);
      } catch (err) {
        warn(`carrier hc: leaving ${dir} behind (${(err as Error).message})`);
      }
    }
  };
}

export interface PreparedChild {
  spec: ChildSpec;
  cleanup: () => void;
}

export type PrepareOutcome =
  | { kind: "ready"; prepared: PreparedChild }
  | { kind: "failed"; result: SingleResult };

export type PrepareChild = (
  task: RunnerTask,
  opts: { onProgress: (partial: SingleResult) => void; runId: string },
) => PrepareOutcome | Promise<PrepareOutcome>;

export function createCarrierRunner(opts: {
  prepare: PrepareChild;
  transport: ChildTransport;
  onWarn?: (message: string) => void;
}): RunnerSeam {
  return {
    async runTask(task, runOpts) {
      const prepared = await opts.prepare(task, { onProgress: runOpts.onProgress, runId: runOpts.runId });
      if (prepared.kind === "failed") return prepared.result;
      const { spec, cleanup } = prepared.prepared;
      try {
        const outcome = await opts.transport(spec, { signal: runOpts.signal, onWarn: opts.onWarn });
        const result = spec.accumulator.finish();
        result.exitCode = outcome.exitCode;
        if (outcome.aborted) throw new Error("Subagent was aborted");
        return result;
      } finally {
        cleanup();
      }
    },
  };
}
