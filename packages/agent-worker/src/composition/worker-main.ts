/**
 * worker-main — the R2 executable Worker composition root.
 *
 * Readable via `@fffattiger/pix-agent-worker/worker-main` and runnable as
 * `node <absolute dist path>`. Composition rules: only this root reads
 * `PIX_AGENT_BACKEND` and assembles dependencies; it holds no business rules.
 *
 * - Backend selection: M2 supports only `sdk` (Pi SDK Agent Adapter via
 *   `createPiSdkAgentRuntimeFactory({ capabilities: M2_AGENT_CAPABILITIES })`).
 *   `PIX_AGENT_WORKER_FACTORY` is a test-only injection seam (absolute path to
 *   a module exporting a factory as `default` or `createFactory`) used by the
 *   no-network composition smoke; it is never set in production.
 * - stdio: strict NDJSON frames in/out, logs to stderr (see
 *   {@link NdjsonStdioTransport}).
 * - Signals: SIGINT/SIGTERM perform an ordered shutdown. Uncaught exceptions /
 *   unhandled rejections fail closed with `worker.fatal` + exit(1).
 * - On stdin EOF the transport triggers an ordered shutdown and process exit.
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
  M2_AGENT_CAPABILITIES,
} from "@fffattiger/pix-pi-sdk-adapter/agent";
import type { ProtocolError } from "@fffattiger/pix-protocol";
import { WorkerController } from "../controller/worker-controller.js";
import { NdjsonStdioTransport } from "../transport/ndjson-transport.js";
import { protocolError, toProtocolError } from "../mapper/protocol-error.js";

export interface WorkerMainOptions {
  /** Override the factory (tests). Defaults to the PIX_AGENT_BACKEND selection. */
  readonly factory?: AgentRuntimeFactory;
  readonly stdin?: Readable;
  readonly stdout?: NodeWritableStream;
  readonly stderr?: (line: string) => void;
  readonly exit?: (code: number) => void;
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
  const stderr = options.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const closed = deferred<number>();
  const rawExit = options.exit ?? ((code: number) => process.exit(code));
  const exit = (code: number): void => {
    closed.resolve(code);
    rawExit(code);
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
    ...(options.stderr === undefined ? {} : { stderr }),
    exit,
  };

  // Factory resolution failed (unsupported backend / bad injection): fail
  // closed with worker.fatal and exit before any init can be processed.
  if (factory === undefined || fatalOnStart !== undefined) {
    const transport = new NdjsonStdioTransport({
      ...transportOptions,
      onMessage: () => {},
      onInputClosed: () => transport.requestExit(0),
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
      void controller.onInputClosed();
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
    factory: createPiSdkAgentRuntimeFactory({ capabilities: M2_AGENT_CAPABILITIES }),
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

// Auto-run when executed directly as `node dist/composition/worker-main.js`.
if (isMainModule(import.meta.url)) {
  void runWorkerMain().then((handle) => {
    const stderr = (line: string) => process.stderr.write(`${line}\n`);
    const onFatal = (error: unknown): void => {
      const message = error instanceof Error ? error.message : String(error);
      stderr(`[worker-main] fatal: ${message}`);
      if (handle.controller === null) {
        handle.transport.requestExit(1);
      } else {
        void handle.transport.fatal(protocolError("internal", "worker crashed"), 1);
      }
    };
    const onSignal = (signal: NodeJS.Signals): void => {
      stderr(`[worker-main] received ${signal}; shutting down`);
      if (handle.controller === null) handle.transport.requestExit(0);
      else void handle.controller.onInputClosed();
    };
    process.on("SIGINT", () => onSignal("SIGINT"));
    process.on("SIGTERM", () => onSignal("SIGTERM"));
    process.on("uncaughtException", onFatal);
    process.on("unhandledRejection", onFatal);
  });
}
