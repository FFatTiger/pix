import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessiondApplication } from "../application.js";
import type { ActivationContextProvider, SessiondDependencies, SessiondOptions, SessionMutationPort } from "../service.js";
import { SessiondService } from "../service.js";
import type { SessionCatalogPort, SessionLocatorPort } from "@fffattiger/pix-runtime-core";
import { SessiondRpcServer } from "../rpc.js";
import {
  acquireInstanceLock,
  assertSocketPathLength,
  loadOrCreateLocalSecret,
  makePrivateEndpointPath,
  needsUnixSocketPublication,
  publishPublicEndpoint,
  recoverStalePrivateAliases,
  recoverStalePublicSocket,
  releaseOwnedPublicEndpoint,
  removeOwnedPrivateSocket,
  sessiondPaths,
  type InstanceLock,
  type OwnedSocketPublication,
  type SessiondPaths,
} from "../local.js";
import type { WorkerProcessFactory } from "../worker.js";
import {
  createProductionWorkerProcessFactory,
  type ProductionWorkerProcessOptions,
} from "./worker-process.js";
import {
  createStubActivationContext,
  createStubSessionCatalog,
  createStubSessionLocator,
} from "./stubs.js";
import { resolveRuntimeDir } from "./locator.js";
import {
  createPiSdkSessionCatalog,
  createPiSdkSessionLocator,
} from "@fffattiger/pix-pi-sdk-adapter/sessions";

/** Optional overrides for the daemon bootstrap. */
export interface DaemonOptions {
  /** Runtime directory (defaults to `PIX_SESSIOND_DIR` then `~/.pi/pix/sessiond`). */
  directory?: string;
  /**
   * Worker factory. Defaults to the production child-process factory (R2).
   * Tests that need the M1 unavailable surface must inject
   * {@link UnavailableWorkerFactory} explicitly.
   */
  workerFactory?: WorkerProcessFactory;
  /**
   * Options for the default production worker factory. Ignored when
   * {@link workerFactory} is provided.
   */
  workerOptions?: ProductionWorkerProcessOptions;
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
  /**
   * @internal Test-only: inserts a delay at the very start of startup (after
   * {@link runDaemon} has installed its signal handlers) so a regression test
   * can deliver a signal mid-bootstrap. Has no effect in production.
   */
  __testStartupDelayMs?: number;
}

/** A running daemon handle. {@link shutdown} is idempotent and tear-down ordered. */
export interface DaemonHandle {
  readonly directory: string;
  readonly paths: SessiondPaths;
  readonly instanceId: string;
  /** Stable public endpoint every client should connect to (may be a hard link to the private socket). */
  readonly endpoint: string;
  /**
   * Unix only: the private per-instance socket path the RPC server actually
   * bound. `undefined` on Windows (named pipes bind the public endpoint
   * directly). Exposed for tests/observability; clients must use {@link endpoint}.
   */
  readonly privateEndpoint: string | undefined;
  readonly secret: string;
  /** Active production worker PIDs from the authoritative in-process registry. */
  workerPids(): number[];
  /** Resolves once shutdown has fully completed (signal or explicit). */
  readonly closed: Promise<void>;
  /** Idempotent tear-down: owned-public → server → service → private → lock. */
  shutdown(): Promise<void>;
}

/**
 * Build service dependencies, applying any caller overrides.
 *
 * Production default: the catalog and locator are backed by the Pi SDK
 * adapter's read-only JSONL surface (`createPiSdkSessionCatalog` /
 * `createPiSdkSessionLocator`). Constructing them does NOT spawn a worker or
 * open the network — they are lazy stores that only touch the SDK read-only
 * JSONL API when a method is called, and list/read/context/locate run
 * with zero workers. Test overrides (`sessionCatalog`, including `null` to run
 * with no catalog, and `sessionLocator`) always take priority so unit tests stay
 * deterministic.
 */
function buildDependencies(directory: string, options: DaemonOptions): SessiondDependencies {
  const workerFactory: WorkerProcessFactory =
    options.workerFactory ?? createProductionWorkerProcessFactory(options.workerOptions ?? {});
  const catalog = options.sessionCatalog === undefined ? createPiSdkSessionCatalog() : options.sessionCatalog;
  const deps: SessiondDependencies = {
    sessionLocator: options.sessionLocator ?? createPiSdkSessionLocator(),
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
 * {@link resolveRuntimeDir}). Order (Unix): private dir → instance lock →
 * fail-closed stale public/private socket recovery → private socket path +
 * length check → local secret → service/application → RPC listen on the
 * *private* path → atomic hard-link publish of the stable public endpoint.
 * Returns a handle whose {@link DaemonHandle.shutdown} performs the reverse,
 * idempotent, owner-safe tear-down.
 *
 * Never calls `process.exit`; the caller (see {@link main}) owns process exit.
 */
export async function startDaemon(options: DaemonOptions = {}): Promise<DaemonHandle> {
  if (options.__testStartupDelayMs && options.__testStartupDelayMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, options.__testStartupDelayMs));
  }
  const directory = resolveRuntimeDir(options.directory);
  const paths = sessiondPaths(directory);
  const lock = await acquireInstanceLock(paths);
  const teardown: Array<() => Promise<void>> = [];
  let server: SessiondRpcServer | undefined;
  let publication: OwnedSocketPublication | undefined;
  let privatePath: string | undefined;
  try {
    // Fail-closed stale recovery BEFORE publishing anything new: an old orphan
    // daemon's debris must never be removed unconditionally, and a live orphan
    // (lost lock/public but still serving) must block this start.
    await recoverStalePublicSocket(paths);
    await recoverStalePrivateAliases(paths);
    if (needsUnixSocketPublication()) {
      privatePath = makePrivateEndpointPath(directory);
      assertSocketPathLength(privatePath);
    }
    const secret = await loadOrCreateLocalSecret(paths);
    const service = new SessiondService(buildDependencies(directory, options), options.serviceOptions);
    teardown.push(() => service.shutdown());
    let requestedShutdown: () => Promise<void> = async () => {};
    const application = new SessiondApplication(service, {
      instanceId: lock.instanceId,
      onShutdown: () => requestedShutdown(),
    });
    // Unix: libuv binds the private per-instance path (never the stable public
    // one), so a close can never unlink another daemon's public endpoint.
    // Windows: named pipes leave no files; bind the public pipe directly.
    server = new SessiondRpcServer({ endpoint: privatePath ?? paths.endpoint, secret, handler: application });
    await server.listen();
    teardown.push(() => server!.close());
    if (needsUnixSocketPublication()) {
      publication = await publishPublicEndpoint(paths, privatePath!, lock.instanceId);
    }

    let shutdownPromise: Promise<void> | undefined;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const shutdown = async (): Promise<void> => {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        // 1) Owned public unlink while the server is still alive. Only removes
        //    the public when the lock still names this instance AND the public
        //    is still our socket inode; a replaced public/lock is left alone
        //    (the incident fix).
        if (publication) await releaseOwnedPublicEndpoint(paths, publication).catch(() => {});
        // 2) server → service teardown (libuv unlinks the private path).
        for (const step of teardown.splice(0).reverse()) await step().catch(() => {});
        // 3) Defensive residue removal of our own private path.
        if (privatePath) await removeOwnedPrivateSocket(privatePath).catch(() => {});
        // 4) Lock release.
        await lock.release().catch(() => {});
        resolveClosed();
      })();
      return shutdownPromise;
    };
    requestedShutdown = shutdown;

    return {
      directory,
      paths,
      instanceId: lock.instanceId,
      endpoint: paths.endpoint,
      privateEndpoint: privatePath,
      secret,
      workerPids: () => service.workerPids(),
      closed,
      shutdown,
    };
  } catch (error) {
    // Startup rollback must never leave our own published paths behind.
    if (publication) await releaseOwnedPublicEndpoint(paths, publication).catch(() => {});
    for (const step of teardown.splice(0).reverse()) await step().catch(() => {});
    if (privatePath) await removeOwnedPrivateSocket(privatePath).catch(() => {});
    await lock.release().catch(() => {});
    throw error;
  }
}

/**
 * Run the daemon until shutdown is requested. Signal handlers are installed
 * BEFORE startup so a `SIGINT`/`SIGTERM` arriving mid-bootstrap is recorded as
 * pending and applied the instant startup completes — never ignored (which
 * would let the default disposition terminate the process and leave a stale
 * lock). If startup fails, the handlers are removed and the error propagates.
 * Never calls `process.exit` itself.
 */
export async function runDaemon(options: DaemonOptions = {}, signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"]): Promise<number> {
  let pendingSignal: NodeJS.Signals | undefined;
  let handle: DaemonHandle | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (pendingSignal === undefined) pendingSignal = signal;
    // Once the daemon is up, begin idempotent shutdown immediately; otherwise
    // just record the pending signal and apply it after startup completes.
    if (handle) void handle.shutdown();
  };
  for (const signal of signals) process.on(signal, onSignal);
  try {
    handle = await startDaemon(options);
    if (pendingSignal !== undefined) await handle.shutdown();
    await handle.closed;
    return 0;
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
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
