import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessiondApplication } from "../application.js";
import type { ActivationContextProvider, SessiondDiagnostics, SessiondDependencies, SessiondOptions } from "../service.js";
import { SessiondService } from "../service.js";
import type { SessionCatalogPort, SessionLocatorPort, SessionMutationPort } from "@fffattiger/pix-runtime-core";
import { SessiondRpcServer } from "../rpc.js";
import { SessiondError } from "../errors.js";
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
import { resolveRuntimeDir } from "./locator.js";
import {
  createPiSdkSessionPorts,
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
  /**
   * Override the activation context resolver. Takes priority over the
   * catalog-derived production default (see {@link createCatalogActivationContext}).
   */
  activationContext?: ActivationContextProvider;
  /**
   * Override the catalog (pass `null` to run with no catalog). Also controls
   * the default activation resolver: with no explicit `activationContext` and
   * no requested cwd, a `null` catalog makes activation fail closed.
   */
  sessionCatalog?: SessionCatalogPort | null;
  /**
   * Override the session mutation port (offline rename). `undefined` uses the
   * SAME `createPiSdkSessionPorts()` result as the default catalog/locator;
   * `null` explicitly disables it for fail-closed tests.
   */
  sessionMutation?: SessionMutationPort | null;
  /** Forwarded to {@link SessiondService}. */
  serviceOptions?: SessiondOptions;
  /**
   * @internal Test-only: inserts a delay at the very start of startup (after
   * {@link runDaemon} has installed its signal handlers) so a regression test
   * can deliver a signal mid-bootstrap. Has no effect in production.
   */
  __testStartupDelayMs?: number;
}

/**
 * @internal In-process Worker lifecycle diagnostics surface on the daemon
 * handle (PR#3). Handle-only: this is deliberately NOT exported as a Protocol
 * DTO, RPC method, Host `/health` field, CLI JSON, or capability. It exposes
 * only bounded counts and current PIDs derived from authoritative service
 * records — never session ids, names, paths, stderr, or raw errors. No new
 * timers/handles/retention: every call is O(records) over the live service.
 */
export interface DaemonDiagnostics {
  /** Unique safe positive PIDs of live Worker records, ascending. */
  workerPids(): readonly number[];
  /** Bounded per-status worker counts plus the existing service counts. */
  snapshot(): SessiondDiagnostics;
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
  /** Resolves once shutdown has fully completed (signal or explicit). */
  readonly closed: Promise<void>;
  /**
   * @internal In-process authoritative Worker lifecycle diagnostics (PIDs +
   * bounded counts). Handle-only, never exposed over any public surface.
   */
  readonly diagnostics: DaemonDiagnostics;
  /** Idempotent tear-down: owned-public → server → service → private → lock. */
  shutdown(): Promise<void>;
}

/**
 * Validate a catalog-derived working directory used for activation. It must be
 * a non-empty absolute path with no NUL byte. Relative paths, empty values and
 * NUL-containing values fail closed with a fixed canonical {@link SessiondError}
 * that never echoes the offending value. Deliberately NO realpath: a historical
 * cwd may not currently exist and the Worker/SDK own the open semantics.
 */
const assertValidCatalogCwd = (value: string, which: "cwd" | "projectRoot"): void => {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !isAbsolute(value)) {
    throw new SessiondError("internal", `session catalog returned an invalid ${which}`);
  }
};

/**
 * Production activation-context resolver, fixed to the cold-open semantics:
 *
 * - Explicit `requestedCwd` keeps the override behavior: cwd and projectRoot
 *   both mirror the requested value. Only `undefined` means "not provided" —
 *   the RPC schema (`NonEmptyStringSchema.optional()`) already rejects
 *   blank/empty strings before this resolver is reached, so no truthiness
 *   guesswork is performed here.
 * - No `requestedCwd`: derive cwd/projectRoot from the SAME catalog instance
 *   backing the {@link SessiondDependencies.sessionCatalog} dependency via
 *   `catalog.readSession` — never a second store, never a spawned worker. The
 *   catalog is mandatory: a null or missing catalog fails activation closed
 *   rather than falling back to `/workspace` or `process.cwd()`. The returned
 *   cwd/projectRoot must be non-empty absolute paths; anything else fails
 *   closed with a fixed canonical error that never echoes the offending value.
 */
function createCatalogActivationContext(catalog: SessionCatalogPort | null | undefined): ActivationContextProvider {
  return {
    async resolve(sessionId, _location, requestedCwd) {
      if (requestedCwd !== undefined) {
        return { cwd: requestedCwd, projectRoot: requestedCwd };
      }
      if (catalog == null) {
        throw new SessiondError("unavailable", "session catalog is unavailable");
      }
      const detail = await catalog.readSession(sessionId);
      assertValidCatalogCwd(detail.cwd, "cwd");
      assertValidCatalogCwd(detail.projectRoot, "projectRoot");
      return { cwd: detail.cwd, projectRoot: detail.projectRoot };
    },
  };
}

/**
 * Build service dependencies, applying any caller overrides.
 *
 * Production default: the catalog and locator are backed by the Pi SDK
 * adapter's read-only JSONL surface, and they SHARE ONE session store
 * (`createPiSdkSessionPorts`), so a cold locate followed by a catalog read
 * (sessions.resolve → catalog-derived activation context) runs a single
 * session-list scan against one shared cache instead of two independent
 * stores. Constructing the pair does NOT spawn a worker or open the network —
 * it is a lazy store that only touches the SDK read-only JSONL API when a
 * method is called, and list/read/context/locate run with zero workers. The
 * production activation context (see {@link createCatalogActivationContext})
 * derives an opened session's cwd/projectRoot from the SAME catalog instance:
 * an explicit requested cwd keeps its override, otherwise the recorded session
 * cwd/projectRoot are used, and a missing catalog fails activation closed
 * instead of falling back to `/workspace`. Test overrides (`sessionCatalog`,
 * including `null` to run with no catalog, and `sessionLocator`) always take
 * priority so unit tests stay deterministic; an explicit `activationContext`
 * override keeps priority and decouples activation resolution from the catalog.
 */
function buildDependencies(directory: string, options: DaemonOptions): SessiondDependencies {
  const workerFactory: WorkerProcessFactory =
    options.workerFactory ?? createProductionWorkerProcessFactory(options.workerOptions ?? {});
  // One shared default triple: catalog + locator + mutation over a single
  // private Pi SDK session store. Constructing it is lazy and side-effect-free
  // (no worker, no network, no SDK call) even when all defaults are overridden.
  // The production daemon's catalog, locator AND mutation MUST come from the
  // same createPiSdkSessionPorts() result so an offline rename invalidates the
  // same shared store the catalog reads from (immediate title convergence).
  const defaultPorts = createPiSdkSessionPorts();
  const catalog = options.sessionCatalog === undefined ? defaultPorts.catalog : options.sessionCatalog;
  const deps: SessiondDependencies = {
    sessionLocator: options.sessionLocator ?? defaultPorts.locator,
    activationContext: options.activationContext ?? createCatalogActivationContext(catalog),
    workerFactory,
  };
  if (catalog) deps.sessionCatalog = catalog;
  // undefined → the production shared adapter mutation; null → explicitly
  // disabled (fail-closed tests observe a fixed unavailable for offline rename).
  const mutation = options.sessionMutation === undefined ? defaultPorts.mutation : options.sessionMutation;
  if (mutation) deps.sessionMutation = mutation;
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
    // @internal handle-only diagnostics: delegates the LIVE service, so a
    // closed/shutdown daemon reports no workers and no leaked records.
    const diagnostics: DaemonDiagnostics = {
      workerPids: () => service.workerPids(),
      snapshot: () => service.diagnostics(),
    };
    teardown.push(() => service.shutdown());
    const application = new SessiondApplication(service);
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

    return {
      directory,
      paths,
      instanceId: lock.instanceId,
      endpoint: paths.endpoint,
      privateEndpoint: privatePath,
      secret,
      closed,
      shutdown,
      diagnostics,
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
