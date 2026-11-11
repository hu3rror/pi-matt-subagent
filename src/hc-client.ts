import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const STDERR_TAIL_BYTES = 4_096;
const DISPOSE_TERM_AFTER_MS = 500;
const DISPOSE_KILL_AFTER_MS = 1_000;
const SNIPPET_BYTES = 300;

/**
 * Why an hc request could not produce a result.
 *
 * - `unavailable`: the core could not be started or reached, or the connection
 *   died with the request in flight.
 * - `method-missing`: the core's reported surface does not include the method.
 * - `protocol`: the exchange broke the hc protocol — undefined output, an
 *   unusable `hello`, a malformed response — or the method failed with an error
 *   other than `unknown_method`.
 * - `killed`: the caller's abort signal fired.
 */
export type HcFailure = "unavailable" | "method-missing" | "protocol" | "killed";

/** One classified outcome per request; `result` is whatever the core returned. */
export type HcResult = { ok: true; result: unknown } | { ok: false; failure: HcFailure; message: string };

type HcFailureResult = Extract<HcResult, { ok: false }>;

/** What `hello` reported about the core; a new generation replaces these. */
export interface HcCapabilities {
  readonly generation: number;
  readonly version: string;
  readonly methods: readonly string[];
  readonly features: readonly string[];
}

/**
 * A handle on one core reached through `hc connect`.
 *
 * The wire is JSON-RPC 2.0 with one JSON object per line: requests go to the
 * child's stdin, responses arrive on its stdout as lines carrying the request
 * id.
 *
 * The capabilities `hello` reports are cached until the surface moves: a core
 * that rejects a reported method with `unknown_method` is probed again, and
 * only then does the call fail `method-missing`. Anything that breaks the
 * message exchange fails `protocol` and disposes of the connection, so the
 * next call starts a fresh one.
 */
export interface HcClient {
  /**
   * Resolve one request against the core and never throw.
   *
   * A request with no connection left — never started, dropped, or disposed —
   * resolves `unavailable`. Passing an already aborted signal resolves `killed`
   * before anything is sent; aborting in flight resolves `killed` and leaves the
   * connection usable for the next call.
   */
  call(method: string, params: unknown, signal?: AbortSignal): Promise<HcResult>;
  /**
   * What `hello` reported. Undefined before the first call and after the
   * connection is lost; a later call re-probes.
   */
  capabilities(): HcCapabilities | undefined;
  /**
   * End the connection: close stdin, escalate to SIGTERM then SIGKILL if the
   * child stays, and resolve once it has exited. Calls still in flight settle
   * `unavailable`. Safe to call more than once; a disposed client connects no
   * further.
   */
  dispose(): Promise<void>;
}

/** How to reach the core; by default runs `hc connect --json` with the inherited cwd and environment. */
export interface HcClientOptions {
  command?: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

interface PendingCall {
  settle(result: HcResult): void;
}

interface Connection {
  readonly child: ChildProcessWithoutNullStreams;
  readonly pending: Map<number, PendingCall>;
  readonly exited: Promise<void>;
  buffer: string;
  stderr: string;
  nextId: number;
  caps: HcCapabilities | undefined;
  probe: Promise<HcCapabilities | HcFailureResult> | undefined;
  alive: boolean;
}

function failure(kind: HcFailure, message: string): HcFailureResult {
  return { ok: false, failure: kind, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFailure(value: unknown): value is HcFailureResult {
  return isRecord(value) && value.ok === false;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function snippet(text: string): string {
  return text.length > SNIPPET_BYTES ? `${text.slice(0, SNIPPET_BYTES)}…` : text;
}

function stderrTail(connection: Connection): string {
  const text = connection.stderr.trim();
  return text ? `: ${text}` : "";
}

function readCapabilities(value: unknown): HcCapabilities | undefined {
  if (!isRecord(value)) return undefined;
  const { generation, version, methods, features } = value;
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1) return undefined;
  if (typeof version !== "string") return undefined;
  if (!isStringArray(methods) || !isStringArray(features)) return undefined;
  return { generation, version, methods, features };
}

/**
 * Build a client that speaks to `hc connect` over stdio.
 *
 * The child starts on the first call and is replaced when the exchange breaks;
 * `dispose` ends it for good.
 */
export function createHcClient(options: HcClientOptions = {}): HcClient {
  const command = options.command ?? "hc";
  const args = [...(options.args ?? ["connect", "--json"])];
  let connection: Connection | undefined;
  let disposed = false;

  function connect(): Connection | HcFailureResult {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      return failure("unavailable", `hc connect could not start (${command}): ${errorText(error)}`);
    }
    const exited = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });
    const opened: Connection = {
      child,
      exited,
      pending: new Map(),
      buffer: "",
      stderr: "",
      nextId: 0,
      caps: undefined,
      probe: undefined,
      alive: true,
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      opened.buffer += chunk;
      drain(opened);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      opened.stderr = (opened.stderr + chunk).slice(-STDERR_TAIL_BYTES);
    });
    child.stdin.on("error", (error) => {
      drop(opened, failure("unavailable", `hc connect stdin failed: ${errorText(error)}`));
    });
    child.on("error", (error) => {
      drop(opened, failure("unavailable", `hc connect could not start (${command}): ${errorText(error)}`));
    });
    child.on("close", (code, signal) => {
      drop(opened, failure("unavailable", `hc connect exited (${code ?? signal})${stderrTail(opened)}`));
    });
    return opened;
  }

  function drop(target: Connection, reason: HcFailureResult): void {
    if (!target.alive) return;
    target.alive = false;
    if (connection === target) connection = undefined;
    target.child.stdin.end();
    if (target.child.exitCode === null && target.child.signalCode === null) target.child.kill();
    const waiting = [...target.pending.values()];
    target.pending.clear();
    for (const pending of waiting) pending.settle(reason);
  }

  function send(target: Connection, method: string, params: unknown, signal?: AbortSignal): Promise<HcResult> {
    return new Promise<HcResult>((resolve) => {
      if (!target.alive) {
        resolve(failure("unavailable", `hc connect is not running${stderrTail(target)}`));
        return;
      }
      const id = ++target.nextId;
      let settled = false;
      let stopListening: (() => void) | undefined;
      const settle = (result: HcResult): void => {
        if (settled) return;
        settled = true;
        stopListening?.();
        target.pending.delete(id);
        resolve(result);
      };
      target.pending.set(id, { settle });

      if (signal) {
        if (signal.aborted) {
          settle(failure("killed", `hc request "${method}" was aborted`));
          return;
        }
        const onAbort = (): void => {
          settle(failure("killed", `hc request "${method}" was aborted`));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        stopListening = () => signal.removeEventListener("abort", onAbort);
      }

      try {
        target.child.stdin.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`);
      } catch (error) {
        drop(target, failure("unavailable", `hc connect write failed: ${errorText(error)}`));
      }
    });
  }

  function drain(target: Connection): void {
    let index: number;
    while (target.alive && (index = target.buffer.indexOf("\n")) >= 0) {
      const line = target.buffer.slice(0, index).trim();
      target.buffer = target.buffer.slice(index + 1);
      if (line) handleLine(target, line);
    }
  }

  function handleLine(target: Connection, line: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      drop(target, failure("protocol", `hc connect wrote a line that is not JSON: ${snippet(line)}`));
      return;
    }
    if (!isRecord(frame) || typeof frame.id !== "number") return;
    const waiting = target.pending.get(frame.id);
    if (!waiting) return;
    if ("result" in frame) {
      waiting.settle({ ok: true, result: frame.result });
      return;
    }
    if (isRecord(frame.error)) {
      const message = typeof frame.error.message === "string" ? frame.error.message : "hc request failed";
      const data = isRecord(frame.error.data) ? frame.error.data : undefined;
      const kind = data && typeof data.kind === "string" ? data.kind : "";
      waiting.settle(failure(kind === "unknown_method" ? "method-missing" : "protocol", message));
      return;
    }
    drop(target, failure("protocol", `hc connect response for "${frame.id}" has neither result nor error: ${snippet(line)}`));
  }

  async function probeCapabilities(target: Connection): Promise<HcCapabilities | HcFailureResult> {
    try {
      const hello = await send(target, "hello", {});
      if (!hello.ok) return hello;
      const caps = readCapabilities(hello.result);
      if (caps) {
        target.caps = caps;
        return caps;
      }
      const reason = failure(
        "protocol",
        `hc hello did not report generation, version, methods and features: ${snippet(JSON.stringify(hello.result))}`,
      );
      drop(target, reason);
      return reason;
    } finally {
      target.probe = undefined;
    }
  }

  /** One probe in flight at a time; concurrent callers share it. */
  function ensureCapabilities(target: Connection): Promise<HcCapabilities | HcFailureResult> {
    if (target.caps) return Promise.resolve(target.caps);
    let probe = target.probe;
    if (!probe) {
      probe = probeCapabilities(target);
      target.probe = probe;
    }
    return probe;
  }

  function notExposed(caps: HcCapabilities, method: string): HcFailureResult {
    return failure("method-missing", `hc core does not expose "${method}" (generation ${caps.generation}, version ${caps.version})`);
  }

  async function call(method: string, params: unknown, signal?: AbortSignal): Promise<HcResult> {
    if (disposed) return failure("unavailable", "hc client is disposed");
    if (signal?.aborted) return failure("killed", `hc request "${method}" was aborted`);
    if (!connection) {
      const opened = connect();
      if (isFailure(opened)) return opened;
      connection = opened;
    }
    const target = connection;
    const caps = await ensureCapabilities(target);
    if (isFailure(caps)) return caps;
    if (!caps.methods.includes(method)) return notExposed(caps, method);
    const result = await send(target, method, params, signal);
    if (result.ok || result.failure !== "method-missing") return result;
    target.caps = undefined;

    const refreshed = await ensureCapabilities(target);
    if (isFailure(refreshed)) return refreshed;
    return notExposed(refreshed, method);
  }

  async function dispose(): Promise<void> {
    disposed = true;
    const target = connection;
    connection = undefined;
    if (!target) return;
    target.alive = false;
    const waiting = [...target.pending.values()];
    target.pending.clear();
    for (const pending of waiting) pending.settle(failure("unavailable", "hc client was disposed"));

    target.child.stdin.end();
    const terminate = setTimeout(() => {
      if (target.child.exitCode === null) target.child.kill();
    }, DISPOSE_TERM_AFTER_MS);
    const force = setTimeout(() => {
      if (target.child.exitCode === null) target.child.kill("SIGKILL");
    }, DISPOSE_KILL_AFTER_MS);
    try {
      await target.exited;
    } finally {
      clearTimeout(terminate);
      clearTimeout(force);
    }
  }

  return {
    call,
    capabilities: () => connection?.caps,
    dispose,
  };
}
