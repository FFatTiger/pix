/**
 * Daemon composition root.
 *
 * Wires the standalone sessiond daemon: runtime-directory resolution, the M1
 * unavailable worker factory + session locator/context stubs, instance lock and
 * local secret bootstrap, stale-socket recovery, the RPC server, and an
 * idempotent, ordered shutdown. Importable via the package `./daemon` export.
 */
export { startDaemon, runDaemon, main } from "./daemon.js";
export type { DaemonOptions, DaemonHandle } from "./daemon.js";
export { UnavailableWorkerFactory } from "./unavailable-worker.js";
export {
  createStubActivationContext,
  createStubSessionCatalog,
  createStubSessionLocator,
} from "./stubs.js";
export { resolveRuntimeDir, DEFAULT_SESSIOND_DIRECTORY, SESSIOND_DIR_ENV } from "./locator.js";
