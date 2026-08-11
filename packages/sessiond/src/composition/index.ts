/**
 * Daemon composition root.
 *
 * Wires the standalone sessiond daemon: runtime-directory resolution, the R2
 * production child-process worker factory (with injectable override), session
 * locator/context stubs, instance lock and local secret bootstrap, stale-socket
 * recovery, the RPC server, and an idempotent, ordered shutdown. Importable via
 * the package `./daemon` export.
 */
export { startDaemon, runDaemon, main } from "./daemon.js";
export type { DaemonOptions, DaemonHandle } from "./daemon.js";
export { UnavailableWorkerFactory } from "./unavailable-worker.js";
export {
  ProductionWorkerProcessFactory,
  createProductionWorkerProcessFactory,
  buildWorkerEnv,
  resolveWorkerMainPath,
  WORKER_ENV_KEY_ALLOWLIST,
} from "./worker-process.js";
export type { ProductionWorkerProcessOptions, WorkerEnvBuildInput } from "./worker-process.js";
export {
  createStubActivationContext,
  createStubSessionCatalog,
  createStubSessionLocator,
} from "./stubs.js";
export { resolveRuntimeDir, DEFAULT_SESSIOND_DIRECTORY, SESSIOND_DIR_ENV } from "./locator.js";
