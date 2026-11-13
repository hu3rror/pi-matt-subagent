import * as fs from "node:fs";
import * as path from "node:path";
import { createFileTail } from "./file-tail.ts";
import type { HcClient, HcResult } from "./hc-client.ts";

export interface TerminalInvocation {
  command: string;
  args: string[];
}

export interface TerminalRunRequest {
  invocation: TerminalInvocation;
  sh: string;
  cwd: string;
  /** Environment overrides for the terminal; the core inherits the rest. */
  env?: Record<string, string>;
  name: string;
  labels: Record<string, string>;
  outPath: string;
  errPath: string;
}

export interface TerminalRunDeps {
  client: HcClient;
  signal?: AbortSignal;
  /** Seconds before `terminal.wait` checks in; the core's own default when omitted. */
  checkInSeconds?: number;
  /** Reads one output file; a missing file reads as empty (the command may never have started writing). */
  readText?: (file: string) => string;
  /** Fires once with the address as soon as the terminal exists, before it is waited on. */
  onStarted?: (terminal: string) => void;
  /** Hands over the stdout appended since the previous check-in; the outcome still carries the whole file. */
  onStdout?: (delta: string) => void;
}

/**
 * Why a terminal run did not produce an exit code.
 *
 * - `startup`: the terminal was never created (core unreachable, probe or
 *   `terminal.run` failing). Nothing ran; the caller may fall back.
 * - `lost`: the core took the run and then stopped answering, so the outcome is
 *   unknown. Nothing may be re-run: the command could still be running.
 * - `aborted`: the caller's signal fired. `killed` reports whether the terminal
 *   could be stopped; when it could not, `terminal` names the survivor.
 */
export type TerminalRunOutcome =
  | { ok: true; terminal: string; exitCode: number; stdout: string; stderr: string }
  | { ok: false; kind: "startup" | "lost"; message: string; terminal?: string }
  | { ok: false; kind: "aborted"; message: string; killed: boolean; terminal?: string };
/** POSIX single-quote quoting: the one form that survives every shell metacharacter. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function toShellScript(invocation: TerminalInvocation, outPath: string, errPath: string): string {
  const command = [invocation.command, ...invocation.args].map(shellQuote).join(" ");
  const codePath = shellQuote(`${outPath}.exit`);
  return [
    `{ ${command} 2> ${shellQuote(errPath)}; echo $? > ${codePath}; } | tee ${shellQuote(outPath)}`,
    `exit "$(cat ${codePath} 2>/dev/null || echo 1)"`,
  ].join("\n");
}

function findOnPath(
  names: string[],
  env: NodeJS.ProcessEnv,
  exists: (file: string) => boolean,
): string | undefined {
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Resolves `tee` on PATH. The run script mirrors the child's stdout through it,
 * so a caller that skips this check starts the child and reads back nothing.
 */
export function findTee(
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = fs.existsSync,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  return findOnPath(platform === "win32" ? ["tee.exe", "tee"] : ["tee"], env, exists);
}

/**
 * Resolves `sh` on PATH. The carrier builds its command around a POSIX shell,
 * so a host without one (Windows without Git/MSYS/`sh.exe`) must be detected
 * up front and reported as a missing dependency instead of failing as a
 * cryptic spawn error inside the core.
 */
export function findSh(
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = fs.existsSync,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  return findOnPath(platform === "win32" ? ["sh.exe", "sh"] : ["sh"], env, exists);
}

interface WaitResultLike {
  ended?: boolean;
  exit_code?: number | null;
}

/** The terminal address `terminal.run` answers with, or undefined when it answered without one. */
export function terminalAddress(result: unknown): string | undefined {
  const address = (result as { address?: unknown } | null)?.address;
  return typeof address === "string" && address !== "" ? address : undefined;
}

function defaultReadText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export async function runInTerminal(
  request: TerminalRunRequest,
  deps: TerminalRunDeps,
): Promise<TerminalRunOutcome> {
  const { client, signal } = deps;
  const readText = deps.readText ?? defaultReadText;

  const started: HcResult = await client.call(
    "terminal.run",
    {
      argv: [request.sh, "-c", toShellScript(request.invocation, request.outPath, request.errPath)],
      cwd: request.cwd,
      env: request.env ?? {},
      name: request.name,
      labels: request.labels,
    },
    signal,
  );
  if (!started.ok) {
    if (started.failure === "killed" && signal?.aborted === true) {
      return { ok: false, kind: "aborted", message: "aborted before the terminal started", killed: true };
    }
    return { ok: false, kind: "startup", message: started.message };
  }
  const terminal = terminalAddress(started.result);
  if (!terminal) {
    return {
      ok: false,
      kind: "lost",
      message: "terminal.run answered without a terminal address, so the run may have started",
    };
  }
  deps.onStarted?.(terminal);
  const stdoutTail = deps.onStdout ? createFileTail(request.outPath) : undefined;
  const pumpStdout = () => {
    if (!stdoutTail || !deps.onStdout) return;
    for (let delta = stdoutTail.read(); delta !== ""; delta = stdoutTail.read()) deps.onStdout(delta);
  };
  let aborted = signal?.aborted === true;
  const onAbort = () => {
    aborted = true;
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const killTerminal = async (): Promise<TerminalRunOutcome> => {
    const killed = await client.call("terminal.kill", { terminal });
    if (killed.ok) return { ok: false, kind: "aborted", message: "aborted by the caller", killed: true, terminal };
    return {
      ok: false,
      kind: "aborted",
      message: `aborted by the caller, but terminal ${terminal} could not be killed (${killed.failure}: ${killed.message})`,
      killed: false,
      terminal,
    };
  };

  try {
    while (true) {
      if (aborted) return await killTerminal();
      pumpStdout();
      const waited = await client.call(
        "terminal.wait",
        { terminal, ...(deps.checkInSeconds === undefined ? {} : { timeout: deps.checkInSeconds }) },
        signal,
      );
      if (!waited.ok) {
        if (aborted) return await killTerminal();
        return { ok: false, kind: "lost", message: `${waited.failure}: ${waited.message}`, terminal };
      }
      const result = waited.result as WaitResultLike | null;
      // `ended: false` is a bounded check-in, not a failure: keep waiting.
      if (!result?.ended) continue;
      pumpStdout();
      return {
        ok: true,
        terminal,
        exitCode: result.exit_code ?? 1,
        stdout: readText(request.outPath),
        stderr: readText(request.errPath),
      };
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
