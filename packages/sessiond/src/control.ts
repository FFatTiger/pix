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
  readInstanceLockStrict,
  classifyInstanceLock,
  instanceAlive,
  sessiondPaths,
  probeSocket,
  listPrivateSocketAliases,
  makePrivateEndpointPath,
  isPrivateSocketName,
  assertSocketPathLength,
  unixSocketPathBudgetBytes,
  needsUnixSocketPublication,
  type InstanceLock,
  type InstanceLockRead,
  type InstanceLockRecord,
  type SessiondPaths,
  type SocketProbeResult,
  type OwnedSocketPublication,
} from "./local.js";
export { resolveRuntimeDir, DEFAULT_SESSIOND_DIRECTORY, SESSIOND_DIR_ENV } from "./composition/locator.js";
export { inspectSecureStateBackend, type SecureStateBackendInspection } from "./inspect-backend.js";
export {
  lastStartPath,
  readLastStartRecord,
  classifyLastStartError,
  lastStartRecordFromError,
  lastStartOkRecord,
  parseLastStartRecord,
  LAST_START_FILE_NAME,
  type LastStartCode,
  type LastStartRead,
  type LastStartRecord,
} from "./last-start.js";
