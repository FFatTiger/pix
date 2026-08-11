/**
 * Narrow supervision/control surface for B4 (ensure / reuse / down-all).
 *
 * This module deliberately re-exports only what a supervisor needs to inspect a
 * (possibly separately-running) daemon without coupling to its internals: the
 * on-disk lock (with the pid B4 needs for `down-all` via SIGTERM), a liveness
 * probe, path resolution, and runtime-directory resolution. It performs no I/O
 * side effects beyond reads.
 */
export {
  readInstanceLock,
  instanceAlive,
  sessiondPaths,
  type InstanceLock,
  type InstanceLockRecord,
  type SessiondPaths,
} from "./local.js";
export { resolveRuntimeDir, DEFAULT_SESSIOND_DIRECTORY, SESSIOND_DIR_ENV } from "./composition/locator.js";
