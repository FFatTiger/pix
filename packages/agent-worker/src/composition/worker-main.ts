/**
 * worker-main — the R2 executable Worker composition root.
 *
 * Readable via `@fffattiger/pix-agent-worker/worker-main` and runnable as
 * `node <absolute dist path>`. Composition rules: only this root reads
 * `PIX_AGENT_BACKEND` and assembles dependencies; it holds no business rules.
 *
 * - Backend selection: M2 supports only `sdk` (Pi SDK Agent Adapter via
 *   `createPiSdkAgentRuntimeFactory({ capabilities: PRODUCTION_AGENT_CAPABILITIES })`).
 *   `PIX_AGENT_WORKER_FACTORY` is a test-only injection seam (absolute path to
 *   a module exporting a factory as `default` or `createFactory`) used by the
 *   no-network composition smoke; it is never set in production.
 * - stdio: strict NDJSON frames in/out, logs to stderr (see
 *   {@link NdjsonStdioTransport}). Logger is EPIPE-safe and never throws.
 * - Signals: SIGINT/SIGTERM perform an ordered shutdown. Uncaught exceptions /
 *   unhandled rejections fail closed with `worker.fatal` + exit(1) via an
 *   idempotent safe handler (no recursive stderr writes).
 * - On stdin EOF the transport triggers an ordered shutdown and process exit.
 *   A hard exit watchdog guarantees termination even when the parent dies and
 *   stdout/stderr close together (broken-pipe parent-death case).
 *
 * Direct execution (`node dist/composition/worker-main.js`) is detected by
 * argv[1] matching this module; importing `runWorkerMain` from tests does not
 * install process handlers.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Readable, Writable as NodeWritableStream } from "node:stream";
import type { AgentRuntimeFactory } from "@fffattiger/pix-runtime-core";
import {
  createPiSdkAgentRuntimeFactory,
  PRODUCTION_AGENT_CAPABILITIES,
} from "@fffattiger/pix-pi-sdk-adapter/agent";
import type { ProtocolError } from "@fffattiger/pix-protocol";
import { WorkerController } from "../controller/worker-controller.js";
import { NdjsonStdioTransport } from "../transport/ndjson-transport.js";
import { protocolError, toProtocolError } from "../mapper/protocol-error.js";
import {
  BROKEN_STDIO_EOF_WATCHDOG_MS,
  createExitWatchdog,
  createSafeStderrLogger,
  createStdinEofLatch,
  DEFAULT_EOF_WATCHDOG_MS,
  installParentDeathWatchdog,
  installProcessStdioGuards,
  isProcessStdioBroken,
  type ExitWatchdog,
} from "../transport/safe-stdio.js";

export interface WorkerMainOptions {
  /** Override the factory (tests). Defaults to the PIX_AGENT_BACKEND selection. */
  readonly factory?: AgentRuntimeFactory;
  readonly stdin?: Readable;
  readonly stdout?: NodeWritableStream;
  readonly stderr?: (line: string) => void;
  readonly exit?: (code: number) => void;
  /** Override the EOF hard-exit budget (tests). */
  readonly eofWatchdogMs?: number;
  /** Override the broken-stdio EOF budget (tests). */
  readonly brokenStdioWatchdogMs?: number;
}

export interface WorkerMainHandle {
  /** null when factory resolution failed (fatal already emitted). */
  readonly controller: WorkerController | null;
  readonly transport: NdjsonStdioTransport;
  /** Resolves with the exit code once the process exit is requested. */
  readonly closed: Promise<number>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Build the composition: transport + controller, and start the transport. */
export async function runWorkerMain(options: WorkerMainOptions = {}): Promise<WorkerMainHandle> {
  installProcessStdioGuards();
  const stderr = options.stderr ?? createSafeStderrLogger();
  const closed = deferred<number>();
  const rawExit = options.exit ?? ((code: number) => process.exit(code));
  // Watchdog is independent of the Promise chain so a stuck runtime.close /
  // logger / stdout flush still terminates the process under parent death.
  // Holder lets the exit wrapper cancel the timer once the watchdog exists.
  const watchdogHolder: { current: ExitWatchdog | null } = { current: null };
  const exit = (code: number): void => {
    try {
      watchdogHolder.current?.cancel();
    } catch {
      // ignore
    }
    closed.resolve(code);
    rawExit(code);
  };
  watchdogHolder.current = createExitWatchdog(exit);
  const armEofWatchdog = (): void => {
    const broken = isProcessStdioBroken();
    const budget = broken
      ? (options.brokenStdioWatchdogMs ?? BROKEN_STDIO_EOF_WATCHDOG_MS)
      : (options.eofWatchdogMs ?? DEFAULT_EOF_WATCHDOG_MS);
    watchdogHolder.current?.arm(budget, broken ? 1 : 0);
  };

  let factory = options.factory;
  let fatalOnStart: ProtocolError | undefined;
  if (factory === undefined) {
    const resolved = await resolveFactoryFromEnvironment();
    if (!resolved.ok) fatalOnStart = resolved.error;
    else factory = resolved.factory;
  }

  const transportOptions = {
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    ...(options.stdout === undefined ? {} : { stdout: options.stdout }),
    stderr,
    exit,
  };

  // Factory resolution failed (unsupported backend / bad injection): fail
  // closed with worker.fatal and exit before any init can be processed.
  if (factory === undefined || fatalOnStart !== undefined) {
    const transport = new NdjsonStdioTransport({
      ...transportOptions,
      onMessage: () => {},
      onInputClosed: () => {
        armEofWatchdog();
        transport.requestExit(0);
      },
    });
    transport.start();
    void transport.fatal(
      fatalOnStart ?? protocolError("internal", "no agent runtime factory available"),
      1,
    );
    return { controller: null, transport, closed: closed.promise };
  }

  let controller!: WorkerController;
  const transport = new NdjsonStdioTransport({
    ...transportOptions,
    onMessage: (message) => {
      void controller.handleMessage(message);
    },
    onInputClosed: () => {
      // Arm first so even a synchronous throw in onInputClosed cannot orphan us.
      armEofWatchdog();
      void controller.onInputClosed().catch((error) => {
        try {
          stderr(
            `[worker-main] onInputClosed failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        } catch {
          // safe logger should never throw; belt-and-suspenders
        }
        // Prefer ordered exit request; watchdog is the backstop.
        try {
          transport.requestExit(1);
        } catch {
          exit(1);
        }
      });
    },
  });
  controller = new WorkerController({
    factory,
    outbound: { send: (message) => transport.send(message) },
    requestExit: (code) => transport.requestExit(code),
    logger: stderr,
  });
  transport.start();
  return { controller, transport, closed: closed.promise };
}

async function resolveFactoryFromEnvironment(): Promise<
  | { ok: true; factory: AgentRuntimeFactory }
  | { ok: false; error: ProtocolError }
> {
  const injectPath = process.env.PIX_AGENT_WORKER_FACTORY;
  if (injectPath !== undefined && injectPath !== "") {
    try {
      const mod = await import(pathToFileURL(resolve(injectPath)).href);
      const exported =
        (mod as { default?: unknown }).default ??
        (mod as { createFactory?: unknown }).createFactory;
      const factory = await normalizeFactoryExport(exported);
      if (factory !== undefined) return { ok: true, factory };
      return {
        ok: false,
        error: protocolError("internal", "PIX_AGENT_WORKER_FACTORY module did not export a factory"),
      };
    } catch (error) {
      return { ok: false, error: toProtocolError(error, "internal") };
    }
  }

  const backend = process.env.PIX_AGENT_BACKEND ?? "sdk";
  if (backend !== "sdk") {
    return {
      ok: false,
      error: protocolError(
        "unsupported_capability",
        `unsupported PIX_AGENT_BACKEND: ${backend} (M2 supports only "sdk")`,
      ),
    };
  }
  return {
    ok: true,
    factory: createPiSdkAgentRuntimeFactory({ capabilities: PRODUCTION_AGENT_CAPABILITIES }),
  };
}

async function normalizeFactoryExport(exported: unknown): Promise<AgentRuntimeFactory | undefined> {
  if (exported === null || exported === undefined) return undefined;
  if (typeof exported === "function") {
    const created = (exported as () => unknown | Promise<unknown>)();
    return isAgentRuntimeFactory(created) ? created : normalizeFactoryExport(created);
  }
  return isAgentRuntimeFactory(exported) ? (exported as AgentRuntimeFactory) : undefined;
}

function isAgentRuntimeFactory(value: unknown): value is AgentRuntimeFactory {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.create === "function" && typeof record.open === "function";
}

function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return (
      realpathSync(resolve(entry)) ===
      realpathSync(fileURLToPath(metaUrl))
    );
  } catch {
    return false;
  }
}

/**
 * Install auto-run process handlers once the composition is ready. Fatal and
 * signal paths use the safe logger and are idempotent so a broken stderr pipe
 * cannot recurse through uncaughtException.
 */
function installAutoRunHandlers(handle: WorkerMainHandle, stderr: (line: string) => void): void {
  installProcessStdioGuards();
  let fatalInFlight = false;
  const onFatal = (error: unknown): void => {
    if (fatalInFlight) return;
    fatalInFlight = true;
    try {
      const message = error instanceof Error ? error.message : String(error);
      stderr(`[worker-main] fatal: ${message}`);
    } catch {
      // ignore — never rethrow from the fatal path
    }
    try {
      if (handle.controller === null) {
        handle.transport.requestExit(1);
      } else {
        void handle.transport.fatal(protocolError("internal", "worker crashed"), 1);
      }
    } catch {
      try {
        process.exit(1);
      } catch {
        // exhausted
      }
    }
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    try {
      stderr(`[worker-main] received ${signal}; shutting down`);
    } catch {
      // ignore
    }
    try {
      if (handle.controller === null) handle.transport.requestExit(0);
      else void handle.controller.onInputClosed();
    } catch {
      try {
        process.exit(0);
      } catch {
        // exhausted
      }
    }
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);
}

// Auto-run when executed directly as `node dist/composition/worker-main.js`.
if (isMainModule(import.meta.url)) {
  installProcessStdioGuards();
  const stderr = createSafeStderrLogger();
  // Install the parent-death watchdog SYNCHRONOUSLY, before any async work, so
  // a parent that dies during factory resolution / transport boot cannot leave
  // an orphan. It never logs on fire (stderr may be broken) and is independent
  // of stdin EOF (which Node defers until a consumer attaches). The ref'd
  // interval is cleaned up by process.exit() on any normal/ordered exit path.
  installParentDeathWatchdog();
  // Latch stdin EOF synchronously so an early close during the boot gap is not
  // lost before the transport attaches its consumer.
  const eofLatch = createStdinEofLatch();
  void runWorkerMain({ stderr })
    .then((handle) => {
      eofLatch.release();
      installAutoRunHandlers(handle, stderr);
      // If EOF arrived during the boot gap (parent died while we were booting),
      // trigger ordered shutdown now. The transport's own EOF path also covers
      // this, but this guarantees it even if the race beat transport.start().
      if (eofLatch.eofSeen) {
        try {
          if (handle.controller === null) handle.transport.requestExit(0);
          else void handle.controller.onInputClosed();
        } catch {
          try {
            process.exit(0);
          } catch {
            // exhausted
          }
        }
      }
    })
    .catch((error) => {
      eofLatch.release();
      try {
        stderr(
          `[worker-main] boot failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } catch {
        // ignore
      }
      try {
        process.exit(1);
      } catch {
        // exhausted
      }
    });
}

// Re-export watchdog constants for tests that assert budgets without hardcoding.
export {
  BROKEN_STDIO_EOF_WATCHDOG_MS,
  DEFAULT_EOF_WATCHDOG_MS,
  type ExitWatchdog,
};
