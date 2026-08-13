/**
 * Narrow supervision/control surface for B4 (ensure / reuse / down-all).
 *
 * This module deliberately re-exports only what a supervisor needs to inspect a
 * (possibly separately-running) daemon without coupling to its internals: the
 * strict on-disk lock, authenticated endpoint probing, path construction, and
 * runtime-directory resolution. It performs no I/O side effects beyond reads.
 */
export {
  readInstanceLockStrict,
  instanceAlive,
  sessiondPaths,
  probeSocket,
  listPrivateSocketAliases,
  makePrivateEndpointPath,
  isPrivateSocketName,
  assertSocketPathLength,
  needsUnixSocketPublication,
  type InstanceLock,
  type InstanceLockRead,
  type InstanceLockRecord,
  type SessiondPaths,
  type SocketProbeResult,
  type OwnedSocketPublication,
} from "./local.js";
export { resolveRuntimeDir, DEFAULT_SESSIOND_DIRECTORY, SESSIOND_DIR_ENV } from "./composition/locator.js";
