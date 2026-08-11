import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessiondApplication } from "../application.js";
import type { ActivationContextProvider, SessiondDependencies, SessiondOptions, SessionMutationPort } from "../service.js";
import { SessiondService } from "../service.js";
import type { SessionCatalogPort, SessionLocatorPort } from "@fffattiger/pi-web-runtime-core";
import { SessiondRpcServer } from "../rpc.js";
import {
  acquireInstanceLock,
  clearStaleSocket,
  loadOrCreateLocalSecret,
  sessiondPaths,
  type InstanceLock,
  type SessiondPaths,
} from "../local.js";
import type { WorkerProcessFactory } from "../worker.js";
import { UnavailableWorkerFactory } from "./unavailable-worker.js";
import {
  createStubActivationContext,
  createStubSessionCatalog,
  createStubSessionLocator,
} from "./stubs.js";
import { resolveRuntimeDir } from "./locator.js";

/** Optional overrides for the daemon bootstrap. All default to M1 stubs. */
export interface DaemonOptions {
  /** Runtime directory (defaults to `PI_WEB_SESSIOND_DIR` then `~/.pi/agent/sessiond`). */
  directory?: string;
  /** Worker factory. Defaults to {@link UnavailableWorkerFactory} (M1: no worker). */
  workerFactory?: WorkerProcessFactory;
  /** Override the session locator stub. */
  sessionLocator?: SessionLocatorPort;
  /** Override the activation context stub. */
  activationContext?: ActivationContextProvider;
  /** Override the catalog stub (pass `null` to run with no catalog). */
  sessionCatalog?: SessionCatalogPort | null;
  /** Override the session mutation stub. */
  sessionMutation?: SessionMutationPort;
  /** Forwarded to {@link SessiondService}. */
  serviceOptions?: SessiondOptions;
}

/** A running daemon handle. {@link shutdown} is idempotent and tear-down ordered. */
export interface DaemonHandle {
  readonly directory: string;
  readonly paths: SessiondPaths;
  readonly instanceId: string;
  readonly endpoint: string;
  readonly secret: string;
  /** Resolves once shutdown has fully completed (signal or explicit). */
  readonly closed: Promise<void>;
  /** Idempotent tear-down: server → service → socket → lock. */
  shutdown(): Promise<void>;
}

/** Build M1 service dependencies, applying any caller overrides. */
function buildDependencies(directory: string, options: DaemonOptions): SessiondDependencies {
  const workerFactory: WorkerProcessFactory = options.workerFactory ?? new UnavailableWorkerFactory();
  const catalog = options.sessionCatalog === undefined ? createStubSessionCatalog() : options.sessionCatalog;
  const deps: SessiondDependencies = {
    sessionLocator: options.sessionLocator ?? createStubSessionLocator(directory),
    activationContext: options.activationContext ?? createStubActivationContext(),
    workerFactory,
  };
  if (catalog) deps.sessionCatalog = catalog;
  // M1 ships no real mutation backend: rename of a non-active session reports
  // "session mutation is unavailable" rather than silently succeeding.
  if (options.sessionMutation) deps.sessionMutation = options.sessionMutation;
  return deps;
}

/**
 * Boot a standalone sessiond daemon in `directory` (resolved via
 * {@link resolveRuntimeDir}). Order: private dir → instance lock → stale socket
 * sweep → local secret → service/application → RPC listen. Returns a handle
 * whose {@link DaemonHandle.shutdown} performs the reverse, idempotent tear-down.
 *
 * Never calls `process.exit`; the caller (see {@link main}) owns process exit.
 */
export async function startDaemon(options: DaemonOptions = {}): Promise<DaemonHandle> {
  const directory = resolveRuntimeDir(options.directory);
  const paths = sessiondPaths(directory);
  const lock = await acquireInstanceLock(paths);
  const teardown: Array<() => Promise<void>> = [];
  let server: SessiondRpcServer | undefined;
  try {
    await clearStaleSocket(paths);
    const secret = await loadOrCreateLocalSecret(paths);
    const service = new SessiondService(buildDependencies(directory, options), options.serviceOptions);
    teardown.push(() => service.shutdown());
    const application = new SessiondApplication(service);
    server = new SessiondRpcServer({ endpoint: paths.endpoint, secret, handler: application });
    await server.listen();
    teardown.push(() => server!.close());

    let shutdownPromise: Promise<void> | undefined;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const shutdown = async (): Promise<void> => {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        // Idempotent, ordered tear-down: server → service → socket → lock.
        for (const step of teardown.splice(0).reverse()) await step().catch(() => {});
        await clearStaleSocket(paths).catch(() => {});
        await lock.release().catch(() => {});
        resolveClosed();
      })();
      return shutdownPromise;
    };

    return { directory, paths, instanceId: lock.instanceId, endpoint: paths.endpoint, secret, closed, shutdown };
  } catch (error) {
    for (const step of teardown.splice(0).reverse()) await step().catch(() => {});
    await lock.release().catch(() => {});
    throw error;
  }
}

/**
 * Run the daemon until shutdown is requested. Wires `SIGINT`/`SIGTERM` to an
 * idempotent shutdown and resolves with an exit code once tear-down completes.
 * Never calls `process.exit` itself.
 */
export async function runDaemon(options: DaemonOptions = {}, signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"]): Promise<number> {
  const handle = await startDaemon(options);
  let triggered = false;
  const trigger = (): void => {
    if (triggered) return;
    triggered = true;
    void handle.shutdown();
  };
  for (const signal of signals) process.on(signal, trigger);
  try {
    await handle.closed;
    return 0;
  } finally {
    for (const signal of signals) process.off(signal, trigger);
  }
}

/**
 * Process entry point. Boots the daemon, awaits shutdown, and returns the exit
 * code. This is the only place that should translate daemon lifecycle into a
 * process exit; library functions stay exit-free and testable.
 */
export async function main(): Promise<number> {
  try {
    return await runDaemon();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[sessiond] fatal: ${message}`);
    return 1;
  }
}

const isMainModule = (): boolean => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

// When executed directly (`node …/composition/daemon.js`), run and set the exit
// code without a hard `process.exit`, so pending I/O flushes normally.
if (isMainModule()) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
