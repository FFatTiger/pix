/**
 * ProductionWorkerProcessFactory — R2 child-process Worker factory.
 *
 * Spawns one supervised Node child per session via
 * `process.execPath` + the absolute dist path of
 * `@fffattiger/pix-agent-worker/worker-main`. Wire is NDJSON on stdio
 * (2 MiB/frame). Listeners are installed before spawn settles so early
 * stdout messages and exit/error events are buffered and delivered
 * exactly-once to later subscribers.
 *
 * Factory never forges business commands (no synthetic worker.shutdown).
 * Close is graceful: stdin.end() → SIGTERM → SIGKILL through the shared
 * process-tree controller, with PID reuse guards. Environment is a strict
 * allowlist — never `...process.env`. Windows descendant cleanup uses the
 * shared process-tree owner (VS Code System32 taskkill /T).
 */
import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { createProcessTreeController, type ProcessTreeController } from "@fffattiger/pix-local-authority/process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SessiondToWorkerMessageSchema,
  safeParseWorkerToSessiondMessage,
  type ProtocolError,
  type SessiondToWorkerMessage,
  type WorkerToSessiondMessage,
} from "@fffattiger/pix-protocol";
import { SessiondError } from "../errors.js";
import {
  DEFAULT_MAX_FRAME_BYTES,
  NdjsonStdoutReader,
  SerialStdinWriter,
  StderrRing,
} from "../internal/child-stdio.js";
import type {
  WorkerConnection,
  WorkerExit,
  WorkerProcessFactory,
  WorkerStartInput,
} from "../worker.js";

const requireFromHere = createRequire(import.meta.url);

/** Default close escalation deadlines (ms). */
export const DEFAULT_STDIN_END_MS = 2_000;
export const DEFAULT_SIGTERM_MS = 2_000;
export const DEFAULT_SIGKILL_MS = 2_000;

/**
 * Explicit provider credential names allowed into the worker env.
 * Never spread process.env; only these known keys pass through when present.
 */
export const WORKER_ENV_KEY_ALLOWLIST = [
  // Anthropic / OpenAI / Google / OpenRouter / Groq / Mistral / DeepSeek / xAI / Azure
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_API_BASE",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_ORGANIZATION",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "PERPLEXITY_API_KEY",
  "COHERE_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
] as const;

export interface ProductionWorkerProcessOptions {
  /**
   * Absolute path to the worker-main entry. Production resolves via package
   * exports; tests may inject a fixture script. Never read from untrusted env
   * unless the caller intentionally opts in through this option.
   */
  workerMainPath?: string;
  /**
   * Absolute path for the R1 test-only factory injection seam
   * (`PIX_AGENT_WORKER_FACTORY`). Production leaves this unset so the worker
   * uses the SDK backend. Never auto-forwarded from process.env.
   */
  workerFactoryModulePath?: string;
  /** Override Node executable (defaults to `process.execPath`). */
  execPath?: string;
  /** Parent env snapshot used as the allowlist source (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Override PI_CODING_AGENT_DIR default (`~/.pi`). */
  defaultPiCodingAgentDir?: string;
  /** Close escalation: wait after stdin.end() before SIGTERM. */
  stdinEndMs?: number;
  /** Close escalation: wait after SIGTERM before SIGKILL. */
  sigtermMs?: number;
  /** Close escalation: wait after SIGKILL before giving up. */
  sigkillMs?: number;
  /** Max NDJSON frame size in UTF-8 bytes (default 2 MiB). */
  maxFrameBytes?: number;
  /** Spawn cwd (neutral; real cwd is carried by worker.init). Defaults to dirname(workerMain). */
  spawnCwd?: string;
  /** Optional shared process-tree controller (defaults to the platform owner). */
  processTree?: ProcessTreeController;
  /**
   * Extra env keys merged AFTER the allowlist (test injection only).
   * Never used to smuggle sessiond secrets in production — callers must not
   * put PIX_SESSIOND_DIR / secrets here. Production composition leaves this
   * unset.
   */
  extraEnv?: NodeJS.ProcessEnv;
}

export interface WorkerEnvBuildInput {
  sourceEnv?: NodeJS.ProcessEnv;
  /** Explicit test-only factory module path → PIX_AGENT_WORKER_FACTORY. */
  workerFactoryModulePath?: string;
  defaultPiCodingAgentDir?: string;
  /** Merged last; see {@link ProductionWorkerProcessOptions.extraEnv}. */
  extraEnv?: NodeJS.ProcessEnv;
}

/**
 * Build the minimal worker environment. Never spreads process.env.
 * Always sets PIX_AGENT_BACKEND=sdk. Forwards PATH/HOME, PI_CODING_AGENT_DIR
 * (ONLY when the operator environment or an explicit test default provides
 * one — never a hardcoded fallback; the SDK's own default resolves to
 * ~/.pi/agent, and forcing ~/.pi here would point workers at the wrong
 * sessions root), and an explicit provider credential allowlist. Rejects
 * sessiond secrets and any other PIX_* keys.
 */
export function buildWorkerEnv(input: WorkerEnvBuildInput = {}): NodeJS.ProcessEnv {
  const source = input.sourceEnv ?? process.env;
  const env: NodeJS.ProcessEnv = {
    PIX_AGENT_BACKEND: "sdk",
  };
  if (typeof source.PATH === "string" && source.PATH.length > 0) env.PATH = source.PATH;
  if (typeof source.HOME === "string" && source.HOME.length > 0) env.HOME = source.HOME;
  // Windows Node looks up USERPROFILE for homedir-equivalent paths.
  if (typeof source.USERPROFILE === "string" && source.USERPROFILE.length > 0) {
    env.USERPROFILE = source.USERPROFILE;
  }
  if (typeof source.LANG === "string" && source.LANG.length > 0) env.LANG = source.LANG;
  if (typeof source.LC_ALL === "string" && source.LC_ALL.length > 0) env.LC_ALL = source.LC_ALL;
  if (typeof source.TMPDIR === "string" && source.TMPDIR.length > 0) env.TMPDIR = source.TMPDIR;
  if (typeof source.TEMP === "string" && source.TEMP.length > 0) env.TEMP = source.TEMP;
  if (typeof source.TMP === "string" && source.TMP.length > 0) env.TMP = source.TMP;

  const explicitPiDir =
    typeof source.PI_CODING_AGENT_DIR === "string" && source.PI_CODING_AGENT_DIR.length > 0
      ? source.PI_CODING_AGENT_DIR
      : input.defaultPiCodingAgentDir;
  if (explicitPiDir !== undefined) env.PI_CODING_AGENT_DIR = explicitPiDir;

  for (const key of WORKER_ENV_KEY_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }

  // Test-only injection: only when the factory options explicitly request it.
  if (
    typeof input.workerFactoryModulePath === "string" &&
    input.workerFactoryModulePath.length > 0
  ) {
    env.PIX_AGENT_WORKER_FACTORY = input.workerFactoryModulePath;
  }

  // Optional explicit extras (tests). Still refuse to forward sessiond secrets
  // even if a caller tries.
  if (input.extraEnv) {
    for (const [key, value] of Object.entries(input.extraEnv)) {
      if (value === undefined) continue;
      if (key === "PIX_SESSIOND_DIR" || key === "PIX_PASSWORD" || key === "SESSIOND_SECRET") continue;
      if (key.startsWith("PIX_") && key !== "PIX_AGENT_BACKEND" && key !== "PIX_AGENT_WORKER_FACTORY" && key !== "PIX_FIXTURE_MODE") {
        continue;
      }
      env[key] = value;
    }
  }

  return env;
}

/** Resolve the absolute dist path of the worker-main package export. */
export function resolveWorkerMainPath(): string {
  // Prefer package exports resolution (matches R1's own test pattern).
  try {
    const url = import.meta.resolve("@fffattiger/pix-agent-worker/worker-main");
    return fileURLToPath(url);
  } catch {
    // Fallback for environments where import.meta.resolve is unavailable.
    return requireFromHere.resolve("@fffattiger/pix-agent-worker/worker-main");
  }
}

function toProtocolError(message: string, code: ProtocolError["code"] = "worker_unavailable"): ProtocolError {
  return { code, message, retryable: true };
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

class ProductionWorkerConnection implements WorkerConnection {
  readonly pid?: number;

  private readonly messageListeners = new Set<(message: WorkerToSessiondMessage) => void>();
  private readonly exitListeners = new Set<(exit: WorkerExit) => void>();
  private readonly earlyMessages: WorkerToSessiondMessage[] = [];
  private earlyExit: WorkerExit | undefined;
  private exitEmitted = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private fatalFraming = false;
  private readonly spawnedPid: number | undefined;
  private readonly stdin: SerialStdinWriter;
  private readonly stdout: NdjsonStdoutReader;
  private readonly stderr: StderrRing;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly processTree: ProcessTreeController;
  private readonly stdinEndMs: number;
  private readonly sigtermMs: number;
  private readonly sigkillMs: number;

  constructor(
    child: ChildProcessWithoutNullStreams,
    options: {
      processTree: ProcessTreeController;
      stdinEndMs: number;
      sigtermMs: number;
      sigkillMs: number;
      maxFrameBytes: number;
    },
  ) {
    this.child = child;
    this.processTree = options.processTree;
    this.spawnedPid = typeof child.pid === "number" ? child.pid : undefined;
    if (typeof child.pid === "number") {
      (this as { pid: number }).pid = child.pid;
    }
    this.stdinEndMs = options.stdinEndMs;
    this.sigtermMs = options.sigtermMs;
    this.sigkillMs = options.sigkillMs;

    this.stdin = new SerialStdinWriter(child.stdin);
    this.stderr = new StderrRing(child.stderr);
    this.stdout = new NdjsonStdoutReader(child.stdout, {
      maxFrameBytes: options.maxFrameBytes,
      onFrame: (line) => this.handleFrame(line),
      onFatal: (reason) => this.handleFatalFraming(reason),
    });

    // Install ALL lifecycle listeners BEFORE the caller can race with early
    // stdout / immediate exit. start() only resolves after spawn succeeds, but
    // a child can exit or print before the awaiter attaches subscribe/onExit.
    // VS Code's child wrapper does the same: attach `exit`, then drain an
    // already-reaped child (Darwin + detached:true can reap before this
    // constructor returns; a missed `exit` leaves no stdio handle and the
    // event loop looks empty).
    this.stderr.start();
    this.stdout.start();
    child.once("error", (error) => {
      this.emitExit({
        error: toProtocolError(
          `worker process error: ${error instanceof Error ? error.message : String(error)}`,
        ),
      });
    });
    const handleChildExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      const exit: WorkerExit = {};
      if (code !== null && code !== undefined) exit.code = code;
      if (signal !== null && signal !== undefined) exit.signal = signal;
      if (this.fatalFraming && exit.error === undefined) {
        exit.error = toProtocolError("worker framing failure", "invalid_request");
      } else if (code !== 0 && code !== null && exit.error === undefined) {
        // Non-zero exit without a prior worker.fatal still surfaces as an error
        // so sessiond can mark the session crashed. Expected closes (stdin EOF
        // / SIGTERM after close) typically exit 0.
        const detail = this.stderr.snapshot().trim().slice(0, 400);
        exit.error = toProtocolError(
          detail.length > 0
            ? `worker exited with code ${code}: ${detail}`
            : `worker exited with code ${code}`,
        );
      }
      this.emitExit(exit);
    };
    child.once("exit", handleChildExit);
    if (this.hasExited()) {
      handleChildExit(child.exitCode, child.signalCode);
    } else {
      queueMicrotask(() => {
        if (!this.exitEmitted && this.hasExited()) {
          handleChildExit(child.exitCode, child.signalCode);
        }
      });
    }
  }

  async send(message: SessiondToWorkerMessage): Promise<void> {
    if (this.closed || this.exitEmitted) {
      throw new SessiondError("worker_unavailable", "worker connection is closed", true);
    }
    const parsed = SessiondToWorkerMessageSchema.safeParse(message);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")
        .slice(0, 300);
      throw new SessiondError("invalid_request", `invalid worker frame: ${detail || "schema violation"}`, false);
    }
    const frame = JSON.stringify(parsed.data);
    if (Buffer.byteLength(frame, "utf8") > DEFAULT_MAX_FRAME_BYTES) {
      throw new SessiondError("invalid_request", "worker frame exceeds the size limit", false);
    }
    try {
      await this.stdin.enqueue(frame);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.emitExit({ error: toProtocolError(`worker stdin write failed: ${err.message}`) });
      throw new SessiondError("worker_unavailable", `worker stdin write failed: ${err.message}`, true);
    }
  }

  subscribe(listener: (message: WorkerToSessiondMessage) => void): () => void {
    this.messageListeners.add(listener);
    // Replay anything that arrived before the first subscriber (service
    // registers subscribe only after factory.start resolves).
    if (this.earlyMessages.length > 0) {
      const pending = this.earlyMessages.splice(0);
      for (const message of pending) {
        try {
          listener(message);
        } catch {
          // listener errors must not break the connection
        }
      }
    }
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  onExit(listener: (exit: WorkerExit) => void): () => void {
    this.exitListeners.add(listener);
    if (this.earlyExit !== undefined) {
      const exit = this.earlyExit;
      this.earlyExit = undefined;
      try {
        listener(exit);
      } catch {
        // ignore
      }
    }
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.runClose().catch((error) => {
      // Allow a later close() to observe a subsequent OS exit instead of
      // permanently replaying this failure.
      this.closePromise = undefined;
      throw error;
    });
    return this.closePromise;
  }

  /** Diagnostic stderr snapshot (redacted). */
  stderrSnapshot(): string {
    return this.stderr.snapshot();
  }

  private async runClose(): Promise<void> {
    // Wait for the real child process, not merely exit-listener emission.
    // Framing/write failures may emitExit while the OS process is still alive;
    // close must still escalate so sessiond never leaves orphans.
    if (this.hasExited()) {
      this.cleanupStreams();
      return;
    }

    // 1) Graceful: stdin EOF. R1 worker exits on stdin end; factory never
    //    forges worker.shutdown (service owns business commands).
    try {
      this.stdin.end();
    } catch {
      // ignore
    }

    if (await this.waitForExit(this.stdinEndMs)) {
      this.cleanupStreams();
      return;
    }

    // 2) SIGTERM (only if this is still the same process).
    if (this.isSameProcess() && this.spawnedPid !== undefined) {
      this.processTree.terminate(this.spawnedPid, "SIGTERM");
    }
    if (await this.waitForExit(this.sigtermMs)) {
      this.cleanupStreams();
      return;
    }

    // 3) SIGKILL last resort. Windows maps this to TerminateProcess; the name
    // is not POSIX two-level semantics. If the OS process is still the same
    // child after the bounded wait, close must fail — never report success.
    if (this.isSameProcess() && this.spawnedPid !== undefined) {
      this.processTree.terminate(this.spawnedPid, "SIGKILL");
    }
    const terminated = await this.waitForExit(this.sigkillMs);
    this.cleanupStreams();
    if (!terminated && !this.hasExited() && this.isSameProcess()) {
      throw new SessiondError("worker_unavailable", "worker process did not terminate", false);
    }
  }

  private hasExited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }

  private isSameProcess(): boolean {
    if (this.spawnedPid === undefined || this.child.pid === undefined) return false;
    if (this.child.pid !== this.spawnedPid) return false;
    if (this.hasExited()) return false;
    try {
      process.kill(this.spawnedPid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Bounded wait for the OS child to exit. Early buffered messages/exits never
   * affect this — only `child.exitCode` / `signalCode` / the `exit` event.
   * Each deadline resolves false on timeout so escalation always progresses.
   */
  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.hasExited()) return Promise.resolve(true);
    return new Promise<boolean>((resolveWait) => {
      let settled = false;
      const done = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.child.off("exit", onExit);
        resolveWait(value);
      };
      const onExit = () => done(true);
      const timer = setTimeout(() => done(false), Math.max(0, timeoutMs));
      this.child.once("exit", onExit);
      // Re-check after attaching in case exit raced with the listener install.
      if (this.hasExited()) done(true);
    });
  }

  private cleanupStreams(): void {
    this.stdin.close();
    this.stdout.stop();
    this.stderr.stop();
    // Destroy pipes so the parent event loop is not held open by open stdio
    // handles after the child has exited (or after we gave up waiting).
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      try {
        stream?.destroy?.();
      } catch {
        // ignore
      }
    }
  }

  private handleFrame(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.handleFatalFraming("malformed frame: not valid JSON");
      return;
    }
    const result = safeParseWorkerToSessiondMessage(parsed);
    if (!result.success) {
      this.handleFatalFraming("malformed frame: schema violation");
      return;
    }
    this.dispatchMessage(result.data);
  }

  private handleFatalFraming(reason: string): void {
    if (this.fatalFraming) return;
    this.fatalFraming = true;
    this.emitExit({ error: toProtocolError(reason, "invalid_request") });
    // Best-effort terminate; do not await (exit handler will settle close).
    if (this.isSameProcess() && this.spawnedPid !== undefined) {
      this.processTree.terminate(this.spawnedPid, "SIGTERM");
    }
  }

  private dispatchMessage(message: WorkerToSessiondMessage): void {
    if (this.messageListeners.size === 0) {
      this.earlyMessages.push(message);
      return;
    }
    for (const listener of [...this.messageListeners]) {
      try {
        listener(message);
      } catch {
        // isolate listener failures
      }
    }
  }

  private emitExit(exit: WorkerExit): void {
    if (this.exitEmitted) return;
    this.exitEmitted = true;
    this.cleanupStreams();
    if (this.exitListeners.size === 0) {
      this.earlyExit = exit;
      return;
    }
    for (const listener of [...this.exitListeners]) {
      try {
        listener(exit);
      } catch {
        // isolate
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export class ProductionWorkerProcessFactory implements WorkerProcessFactory {
  private readonly options: ProductionWorkerProcessOptions;

  constructor(options: ProductionWorkerProcessOptions = {}) {
    this.options = options;
  }

  async start(_input: WorkerStartInput): Promise<WorkerConnection> {
    const workerMain =
      this.options.workerMainPath !== undefined && this.options.workerMainPath.length > 0
        ? this.options.workerMainPath
        : resolveWorkerMainPath();
    const execPath = this.options.execPath ?? process.execPath;
    const envInput: WorkerEnvBuildInput = {};
    if (this.options.env !== undefined) envInput.sourceEnv = this.options.env;
    if (this.options.workerFactoryModulePath !== undefined) {
      envInput.workerFactoryModulePath = this.options.workerFactoryModulePath;
    }
    if (this.options.defaultPiCodingAgentDir !== undefined) {
      envInput.defaultPiCodingAgentDir = this.options.defaultPiCodingAgentDir;
    }
    if (this.options.extraEnv !== undefined) envInput.extraEnv = this.options.extraEnv;
    const env = buildWorkerEnv(envInput);
    // Prefer an explicit spawn cwd; otherwise use dirname(workerMain) only when
    // that directory exists. Falling back to process.cwd() avoids ENOENT when
    // tests point at a not-yet-copied fixture path. Real session cwd is always
    // delivered via worker.init, never via spawn cwd.
    const mainDir = dirname(workerMain);
    const cwd =
      this.options.spawnCwd ??
      (existsSync(mainDir) ? mainDir : process.cwd());
    const stdinEndMs = this.options.stdinEndMs ?? DEFAULT_STDIN_END_MS;
    const sigtermMs = this.options.sigtermMs ?? DEFAULT_SIGTERM_MS;
    const sigkillMs = this.options.sigkillMs ?? DEFAULT_SIGKILL_MS;
    const maxFrameBytes = this.options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;

    let child: ChildProcessWithoutNullStreams;
    try {
      const processTree = this.options.processTree ?? createProcessTreeController();
      child = processTree.spawn({
        argv: [execPath, workerMain],
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SessiondError("worker_unavailable", `failed to spawn worker: ${message}`, true);
    }

    // Spawn returned a ChildProcess. Attach connection immediately so early
    // stdout/exit are buffered. Reject if the child fails to launch (error
    // before spawn is fully ready — e.g. missing binary).
    const connection = new ProductionWorkerConnection(child, {
      processTree: this.options.processTree ?? createProcessTreeController(),
      stdinEndMs,
      sigtermMs,
      sigkillMs,
      maxFrameBytes,
    });

    // If spawn itself emitted an error synchronously (ENOENT on execPath),
    // wait a tick for the error event and surface it as start() rejection.
    const spawnFailure = await waitForSpawnSettlement(child, 50);
    if (spawnFailure !== undefined) {
      await connection.close().catch(() => {});
      throw new SessiondError(
        "worker_unavailable",
        `failed to spawn worker: ${spawnFailure}`,
        true,
      );
    }

    // start() resolves only after a successful spawn. Service then registers
    // subscribe/onExit and sends worker.init — early messages stay buffered.
    return connection;
  }
}

/**
 * Brief window to catch synchronous spawn failures (ENOENT). Resolves with an
 * error message when the child errors before producing a pid / exit, else
 * undefined once the process looks alive or has already exited cleanly.
 */
function waitForSpawnSettlement(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<string | undefined> {
  if (child.exitCode !== null || child.signalCode !== null) {
    // Immediate exit can be legitimate (fixture that prints and quits); do not
    // treat as spawn failure — connection buffers the exit for onExit.
    return Promise.resolve(undefined);
  }
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onError);
      child.off("spawn", onSpawn);
      resolvePromise(value);
    };
    const onError = (error: Error) => finish(error.message);
    const onSpawn = () => finish(undefined);
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    child.once("error", onError);
    child.once("spawn", onSpawn);
    // Node may have already emitted 'spawn' before we attached.
    if (typeof child.pid === "number" && child.pid > 0) {
      // Defer so a same-tick error still wins if both fire.
      queueMicrotask(() => {
        if (!settled && (child as { spawnargs?: unknown }).spawnargs !== undefined) {
          // pid assigned is a strong signal; only wait out the timer for late errors
        }
      });
    }
  });
}

/** Default factory used by the daemon composition root. */
export function createProductionWorkerProcessFactory(
  options: ProductionWorkerProcessOptions = {},
): ProductionWorkerProcessFactory {
  return new ProductionWorkerProcessFactory(options);
}
