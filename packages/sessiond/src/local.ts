import { constants } from "node:fs";
import { link, lstat, open, readdir, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { basename, dirname, join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createSecureStateBackend,
  LocalAuthorityError,
  type FileIdentity,
  type SecureStateBackend,
} from "@fffattiger/pix-local-authority/state";
import {
  classifyLockProcess,
  currentProcessStartIdentity,
  type ProcessStartIdentity,
} from "@fffattiger/pix-local-authority/process";
import { SessiondError } from "./errors.js";
import { readExistingSecret, SESSIOND_SECRET_MIN_BYTES } from "./internal/local-state-security.js";
import {
  ensureSessiondPrivateDirectory,
  reverifySessiondPrivateDirectory,
  type SessiondPrivateDirectory,
} from "./local-posix.js";

export interface SessiondPaths {
  directory: string;
  endpoint: string;
  lockFile: string;
  secretFile: string;
}

export interface InstanceLock {
  instanceId: string;
  release(): Promise<void>;
}

/** Persisted contents of `sessiond.lock`; the pid lets B4 reach a live daemon. */
export interface InstanceLockRecord {
  pid: number;
  instanceId: string;
  createdAt: number;
  /** Process-start identity. Absent on legacy locks and macOS. */
  start?: ProcessStartIdentity;
}

/**
 * Strict, side-effect-free view of the on-disk instance lock. Unlike
 * {@link readInstanceLock}, this distinguishes "absent" from "present but
 * unsafe" (symlink, non-regular, unreadable, corrupt, malformed payload) so
 * owners and supervisors can fail closed instead of treating an unsafe lock as
 * a missing one and auto-removing it.
 */
export type InstanceLockIdentity =
  | { readonly kind: "posix"; readonly dev: bigint; readonly ino: bigint }
  | { readonly kind: "windows"; readonly volumeSerial: string; readonly fileId: string };

export type InstanceLockRead =
  | { kind: "missing" }
  | { kind: "ok"; record: InstanceLockRecord; identity: InstanceLockIdentity }
  | { kind: "unsafe"; reason: string };

/**
 * Read the on-disk instance lock without claiming it (strict). Fail-closed on
 * any unsafe lock: symlinks, non-regular files, unreadable files and corrupt
 * payloads are reported as `{ kind: "unsafe" }` rather than silently
 * treated as absent.
 */
function parseLockProcessStart(value: unknown): ProcessStartIdentity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { kind?: unknown; value?: unknown };
  if ((record.kind !== "linux-startticks" && record.kind !== "windows-creation-time") || typeof record.value !== "string") {
    return undefined;
  }
  if (!/^[0-9]+$/u.test(record.value) || record.value.length > 32) return undefined;
  return { kind: record.kind, value: record.value };
}

function fileIdentityToLockIdentity(identity: FileIdentity): InstanceLockIdentity | undefined {
  if (identity.kind === "posix" && identity.isFile && !identity.isSymbolicLink) {
    return { kind: "posix", dev: BigInt(identity.dev), ino: BigInt(identity.ino) };
  }
  if (identity.kind === "windows" && identity.isFile && !identity.isReparsePoint) {
    return { kind: "windows", volumeSerial: identity.volumeSerial, fileId: identity.fileId };
  }
  return undefined;
}

export async function readInstanceLockStrict(paths: SessiondPaths): Promise<InstanceLockRead> {
  const backend = createSecureStateBackend();
  const before = await backend.fileIdentity(paths.lockFile).catch(() => undefined);
  if (before === null || before === undefined) {
    if (before === null) return { kind: "missing" };
    return { kind: "unsafe", reason: "sessiond lock file is not readable" };
  }
  const identity = fileIdentityToLockIdentity(before);
  if (identity === undefined) {
    return { kind: "unsafe", reason: "sessiond lock file is not a regular file" };
  }
  let text: string;
  try {
    const read = await backend.readStateDocument(paths.lockFile, { maxBytes: 4096 });
    if ("missing" in read) return { kind: "missing" };
    text = read.content;
  } catch {
    return { kind: "unsafe", reason: "sessiond lock file is unreadable" };
  }
  const after = await backend.fileIdentity(paths.lockFile).catch(() => undefined);
  const afterIdentity = after ? fileIdentityToLockIdentity(after) : undefined;
  if (!afterIdentity || !sameLockIdentity(afterIdentity, identity)) {
    return { kind: "unsafe", reason: "sessiond lock file identity changed during read" };
  }
  try {
    const parsed = JSON.parse(text) as Partial<InstanceLockRecord>;
    if (typeof parsed.pid !== "number" || typeof parsed.instanceId !== "string") {
      return { kind: "unsafe", reason: "sessiond lock file is malformed" };
    }
    const start = parseLockProcessStart(parsed.start);
    return {
      kind: "ok",
      record: {
        pid: parsed.pid,
        instanceId: parsed.instanceId,
        createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
        ...(start ? { start } : {}),
      },
      identity,
    };
  } catch {
    return { kind: "unsafe", reason: "sessiond lock file is corrupt" };
  }
}

/**
 * Backward-compatible wrapper for B4 supervision: reads the lock but collapses
 * "unsafe" onto "absent" (`undefined`). Callers that need to distinguish an
 * unsafe lock from a missing one must use {@link readInstanceLockStrict}.
 */
export async function readInstanceLock(paths: SessiondPaths): Promise<InstanceLockRecord | undefined> {
  const result = await readInstanceLockStrict(paths);
  return result.kind === "ok" ? result.record : undefined;
}

export function classifyInstanceLock(record: InstanceLockRecord): "live" | "stale" | "obstructed" {
  return classifyLockProcess({
    pid: record.pid,
    ...(record.start ? { start: record.start } : {}),
  });
}

/** True when the lock names a live process with a matching start identity. */
export async function instanceAlive(paths: SessiondPaths): Promise<boolean> {
  const lock = await readInstanceLock(paths);
  return lock !== undefined && classifyInstanceLock(lock) === "live";
}

export function sessiondPaths(directory: string): SessiondPaths {
  return {
    directory,
    endpoint: process.platform === "win32" ? `\\\\.\\pipe\\pix-sessiond-${createHash("sha256").update(directory).digest("hex").slice(0, 24)}` : join(directory, "sessiond.sock"),
    lockFile: join(directory, "sessiond.lock"),
    secretFile: join(directory, "sessiond.secret"),
  };
}

/**
 * Resolve the sessiond private-directory context for a critical step.
 *
 * When the daemon already preflighted the directory (production), the context
 * is re-verified (bounded dev/ino re-check) and reused. A direct caller without
 * a context runs a full preflight itself (canonicalize + secure walk), so the
 * exported functions stay self-contained and fail closed on any unsafe layout.
 */
async function resolveSessiondPrivateDirectory(
  paths: SessiondPaths,
  ctx?: SessiondPrivateDirectory,
): Promise<SessiondPrivateDirectory> {
  if (ctx !== undefined) {
    await reverifySessiondPrivateDirectory(ctx);
    return ctx;
  }
  return ensureSessiondPrivateDirectory(paths.directory);
}

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export interface InstanceLockTestHooks {
  /** After stale classification, before identity re-check/removal. */
  beforeStaleLockRemoval?: () => void | Promise<void>;
  /** After owner validation, before final identity re-check/removal. */
  beforeReleaseRemoval?: () => void | Promise<void>;
}

function sameLockIdentity(
  left: InstanceLockIdentity,
  right: InstanceLockIdentity,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "posix" && right.kind === "posix") {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return left.kind === "windows"
    && right.kind === "windows"
    && left.volumeSerial === right.volumeSerial
    && left.fileId === right.fileId;
}

function lockIdentityFromExclusive(identity: FileIdentity): InstanceLockIdentity {
  const mapped = fileIdentityToLockIdentity(identity);
  if (!mapped) throw new SessiondError("forbidden", "sessiond lock ownership could not be verified");
  return mapped;
}

export async function acquireInstanceLock(
  paths: SessiondPaths,
  privateDir?: SessiondPrivateDirectory,
  hooks: InstanceLockTestHooks = {},
): Promise<InstanceLock> {
  // The containing directory must be preflighted private FIRST, and its
  // dev/ino identity re-verified immediately before the O_EXCL create below.
  await resolveSessiondPrivateDirectory(paths, privateDir);
  const backend = createSecureStateBackend();
  const instanceId = randomUUID();
  const start = currentProcessStartIdentity();
  const payload = `${JSON.stringify({
    pid: process.pid,
    instanceId,
    createdAt: Date.now(),
    ...(start ? { start } : {}),
  })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const created = await backend.createExclusivePrivateFile(paths.lockFile, payload, { maxBytes: 4096 });
      const createdIdentity = lockIdentityFromExclusive(created.identity);
      const owned = await readInstanceLockStrict(paths);
      if (
        owned.kind !== "ok"
        || owned.record.instanceId !== instanceId
        || owned.record.pid !== process.pid
        || !sameLockIdentity(owned.identity, createdIdentity)
      ) {
        throw new SessiondError("forbidden", "sessiond lock ownership could not be verified");
      }
      let released = false;
      return {
        instanceId,
        async release() {
          if (released) return;
          released = true;
          try {
            const current = await readInstanceLockStrict(paths);
            if (
              current.kind !== "ok"
              || current.record.instanceId !== instanceId
              || !sameLockIdentity(current.identity, createdIdentity)
            ) {
              return;
            }
            await hooks.beforeReleaseRemoval?.();
            const beforeRemove = await readInstanceLockStrict(paths);
            if (
              beforeRemove.kind !== "ok"
              || beforeRemove.record.instanceId !== instanceId
              || !sameLockIdentity(beforeRemove.identity, createdIdentity)
            ) {
              return;
            }
            await rm(paths.lockFile, { force: true });
          } catch { /* lock already gone or replaced */ }
        },
      };
    } catch (error) {
      if (error instanceof SessiondError) throw error;
      const alreadyExists = error instanceof LocalAuthorityError && error.code === "ALREADY_EXISTS";
      if (!alreadyExists || attempt > 0) throw new SessiondError("conflict", "another sessiond instance is running");
      // EEXIST: inspect the existing lock and fail closed on anything unsafe.
      // Only a *valid* lock naming a *dead* pid is stale debris we may remove;
      // corrupt/symlink/non-regular/unreadable locks are never auto-removed and
      // never treated as missing.
      const existing = await readInstanceLockStrict(paths);
      if (existing.kind === "missing") continue; // raced with another acquirer; retry
      if (existing.kind === "unsafe") throw new SessiondError("forbidden", existing.reason);
      const existingClass = classifyInstanceLock(existing.record);
      if (existingClass === "live") throw new SessiondError("conflict", "another sessiond instance is running");
      if (existingClass === "obstructed") throw new SessiondError("forbidden", "sessiond lock process identity is unverifiable");
      // Valid lock naming a dead or reused pid → stale debris. Re-check record
      // + inode immediately before removal so a concurrent/live replacement is
      // never deleted based on stale evidence.
      await hooks.beforeStaleLockRemoval?.();
      const beforeRemove = await readInstanceLockStrict(paths);
      if (beforeRemove.kind === "missing") continue;
      if (beforeRemove.kind === "unsafe") throw new SessiondError("forbidden", beforeRemove.reason);
      if (
        !sameLockIdentity(beforeRemove.identity, existing.identity)
        || beforeRemove.record.instanceId !== existing.record.instanceId
        || beforeRemove.record.pid !== existing.record.pid
      ) {
        throw new SessiondError("conflict", "sessiond lock identity changed during stale recovery");
      }
      const beforeClass = classifyInstanceLock(beforeRemove.record);
      if (beforeClass === "live") {
        throw new SessiondError("conflict", "another sessiond instance is running");
      }
      if (beforeClass === "obstructed") {
        throw new SessiondError("forbidden", "sessiond lock process identity is unverifiable");
      }
      await rm(paths.lockFile, { force: true });
    }
  }
  throw new SessiondError("conflict", "could not acquire sessiond lock");
}

/** Minimum secret entropy, in bytes, before base64url encoding. */
const SECRET_MIN_BYTES = SESSIOND_SECRET_MIN_BYTES;
/** Suffix (and naming pattern) for in-progress publish temps. */
const SECRET_TEMP_SUFFIX = ".tmp";

/**
 * Test-only hooks for {@link loadOrCreateLocalSecret}. `beforePublish` fires
 * after the temp is fully written and fsynced, immediately before the atomic
 * link publish — throw from it to deterministically simulate a crash between
 * write and publish.
 */
export interface LocalSecretTestHooks {
  beforePublish?: () => void | Promise<void>;
  /** After pre-read validation, before reading the existing secret. */
  beforeSecretRead?: () => void | Promise<void>;
  /** After classifying zero-byte legacy debris, before identity re-check/removal. */
  beforeZeroByteRemoval?: () => void | Promise<void>;
}

/**
 * Load the local sessiond secret, creating it atomically on first use.
 *
 * Crash-safety / race-safety guarantees:
 *   - `final` is published only via `link(temp, final)`, which is atomic and
 *     refuses to replace an existing file (EEXIST). So `final` is always either
 *     absent or complete — never a 0-byte / partial file. (The legacy code
 *     opened `final` with O_CREAT|O_EXCL and then wrote into it, which left a
 *     0-byte `final` on interruption and permanently bricked the daemon.)
 *   - The full secret is written to a unique temp (`wx`, 0o600) and fsynced for
 *     durability before publishing.
 *   - Concurrent creators converge: the loser of the `link` race adopts the
 *     winner's already-published secret instead of overwriting it.
 *   - On entry, stale temps from dead processes (this naming pattern only) are
 *     swept; a live owner's temp is left untouched.
 *   - Self-heal: a 0-byte `final` can only be legacy-publish debris (this code
 *     never writes `final` directly). When the daemon holds the instance lock it
 *     is sole owner, so a 0-byte regular non-symlink `final` is removed and
 *     rebuilt. Any other malformed `final` (non-zero, unreadable) is fail-closed.
 */
async function readExistingSecretForBackend(
  backend: SecureStateBackend,
  paths: SessiondPaths,
  hooks: LocalSecretTestHooks,
): Promise<string | undefined> {
  if (backend.kind === "posix") {
    return readExistingSecret(paths, hooks);
  }
  const before = await backend.fileIdentity(paths.secretFile);
  if (before === null) return undefined;
  if (before.kind !== "windows" || before.isReparsePoint || !before.isFile) {
    throw new SessiondError("forbidden", "unsafe sessiond secret file");
  }
  if (BigInt(before.size) === 0n) {
    await hooks.beforeZeroByteRemoval?.();
    const beforeRemove = await backend.fileIdentity(paths.secretFile);
    if (
      beforeRemove === null
      || beforeRemove.kind !== "windows"
      || beforeRemove.fileId !== before.fileId
      || beforeRemove.volumeSerial !== before.volumeSerial
    ) {
      return undefined;
    }
    await rm(paths.secretFile, { force: true });
    return undefined;
  }
  await hooks.beforeSecretRead?.();
  const read = await backend.readStateDocument(paths.secretFile, { maxBytes: 1024 });
  if ("missing" in read) return undefined;
  const after = await backend.fileIdentity(paths.secretFile);
  if (
    after === null
    || after.kind !== "windows"
    || after.fileId !== before.fileId
    || after.volumeSerial !== before.volumeSerial
  ) {
    throw new SessiondError("forbidden", "sessiond secret file identity changed during read");
  }
  const secret = read.content.trim();
  if (secret.length < SESSIOND_SECRET_MIN_BYTES) {
    throw new SessiondError("internal", "invalid sessiond secret");
  }
  return secret;
}

async function loadOrCreateSecretForBackend(
  backend: SecureStateBackend,
  paths: SessiondPaths,
  hooks: LocalSecretTestHooks,
): Promise<string> {
  if (backend.kind === "posix") await sweepStaleSecretTemps(paths);
  for (let attempt = 0; ; attempt += 1) {
    const existing = await readExistingSecretForBackend(backend, paths, hooks);
    if (existing !== undefined) return existing;
    if (attempt > 8) throw new SessiondError("conflict", "sessiond secret publish did not converge");
    const secret = randomBytes(SECRET_MIN_BYTES).toString("base64url");
    if (backend.kind === "windows") {
      try {
        // CREATE_NEW is the Windows no-replace publish operation. The test seam
        // is therefore immediately before it, never after the final secret is
        // visible (unlike POSIX's temp-file → link publish sequence).
        await hooks.beforePublish?.();
        await backend.createExclusivePrivateFile(paths.secretFile, `${secret}\n`, { maxBytes: 1024 });
        return secret;
      } catch (error) {
        if (error instanceof LocalAuthorityError && error.code === "ALREADY_EXISTS") continue;
        throw error;
      }
    }
    const temp = `${paths.secretFile}.${process.pid}.${randomUUID()}${SECRET_TEMP_SUFFIX}`;
    try {
      const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        await handle.writeFile(`${secret}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await hooks.beforePublish?.();
      try {
        await link(temp, paths.secretFile);
        return secret;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
  }
}

// Windows CREATE_NEW makes the final name visible before its async JS-side
// write completes. Sessiond itself serializes processes with its instance lock;
// this single-flight also preserves the public helper's same-process concurrent
// creator guarantee, so another caller never mistakes that transient empty
// file for legacy zero-byte debris and removes the winner's name.
const windowsSecretFlights = new Map<string, Promise<string>>();

export async function loadOrCreateLocalSecret(
  paths: SessiondPaths,
  hooks: LocalSecretTestHooks = {},
  privateDir?: SessiondPrivateDirectory,
): Promise<string> {
  // The containing directory must be preflighted private FIRST, and its
  // identity re-verified immediately before any exclusive create/sweep.
  await resolveSessiondPrivateDirectory(paths, privateDir);
  const backend = createSecureStateBackend();
  if (backend.kind !== "windows") {
    return loadOrCreateSecretForBackend(backend, paths, hooks);
  }
  const inFlight = windowsSecretFlights.get(paths.secretFile);
  if (inFlight) return inFlight;
  const operation = loadOrCreateSecretForBackend(backend, paths, hooks);
  windowsSecretFlights.set(paths.secretFile, operation);
  try {
    return await operation;
  } finally {
    if (windowsSecretFlights.get(paths.secretFile) === operation) {
      windowsSecretFlights.delete(paths.secretFile);
    }
  }
}

/**
 * Best-effort sweep of in-progress publish temps that match this module's
 * naming pattern (`<secretFile>.<pid>.<uuid>.tmp`) and whose owning pid is no
 * longer alive. A live owner's temp (same or recycled pid) is always left in
 * place, so concurrent publishers never disrupt each other.
 */
async function sweepStaleSecretTemps(paths: SessiondPaths): Promise<void> {
  const dir = dirname(paths.secretFile);
  const prefix = `${basename(paths.secretFile)}.`;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(SECRET_TEMP_SUFFIX)) continue;
    const middle = entry.slice(prefix.length, entry.length - SECRET_TEMP_SUFFIX.length);
    const pid = Number(middle.split(".")[0]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue; // not our pattern
    if (pidAlive(pid)) continue; // owner may still be writing/publishing
    const candidate = join(dir, entry);
    try {
      const info = await lstat(candidate);
      if (!info.isFile() || info.isSymbolicLink()) continue; // only sweep regular files
      await rm(candidate, { force: true });
    } catch {
      /* best-effort; a concurrent sweeper may have removed it */
    }
  }
}

/** Platform Unix `sun_path` budget in bytes, or null on Windows named pipes. */
export function unixSocketPathBudgetBytes(platform: NodeJS.Platform = process.platform): number | null {
  if (platform === "win32") return null;
  return platform === "darwin" ? 104 : 108;
}
/** Naming pattern for per-instance private sockets, so orphan discovery can scan for them. */
const PRIVATE_SOCKET_PREFIX = "pixsd-";
const PRIVATE_SOCKET_SUFFIX = ".sock";
/** Upper bound for a single active-connect liveness probe. */
const SOCKET_PROBE_TIMEOUT_MS = 500;

/** True when this platform publishes via Unix filesystem hard links (not Windows named pipes). */
export function needsUnixSocketPublication(): boolean {
  return process.platform !== "win32";
}

/**
 * Build a per-instance private socket path inside `directory` (Unix only). It
 * lives on the same filesystem as the public endpoint so a hard `link` can
 * atomically publish it, and its basename is short and fixed-length
 * (`pixsd-<6hex>.sock`, 17 bytes) so the full path stays within the platform
 * `sun_path` budget even for long runtime dirs. The 24-bit random token is
 * enough for per-directory uniqueness between concurrent instances.
 */
export function makePrivateEndpointPath(directory: string, token: string = randomBytes(3).toString("hex")): string {
  return join(directory, `${PRIVATE_SOCKET_PREFIX}${token}${PRIVATE_SOCKET_SUFFIX}`);
}

/** True when `name` matches the Pix private-socket naming pattern (used for orphan scanning). */
export function isPrivateSocketName(name: string): boolean {
  if (!name.startsWith(PRIVATE_SOCKET_PREFIX) || !name.endsWith(PRIVATE_SOCKET_SUFFIX)) return false;
  return name.length > PRIVATE_SOCKET_PREFIX.length + PRIVATE_SOCKET_SUFFIX.length;
}

/** Fail closed when a socket path would exceed the platform `sun_path` limit. */
export function assertSocketPathLength(path: string): void {
  const budget = unixSocketPathBudgetBytes();
  if (budget === null) return;
  const bytes = Buffer.byteLength(path, "utf8");
  if (bytes > budget) {
    throw new SessiondError("forbidden", `sessiond socket path too long (${bytes} > ${budget} bytes)`);
  }
}

/** Result of an active-connect liveness probe on a Unix socket path. */
export type SocketProbeResult = "live" | "dead" | "unknown";

/**
 * Active-connect liveness probe for a Unix socket path. A successful connect
 * proves a live listener; ECONNREFUSED/ENOENT means no listener (debris or
 * absent); timeout/EACCES/anything else is "unknown" and callers must fail
 * closed. Never throws; the probe socket is always destroyed.
 */
export function probeSocket(path: string, timeoutMs = SOCKET_PROBE_TIMEOUT_MS): Promise<SocketProbeResult> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: SocketProbeResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => finish("live"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") finish("dead");
      else finish("unknown");
    });
    timer = setTimeout(() => finish("unknown"), timeoutMs);
  });
}

/**
 * List the Pix-named private socket alias paths present in `directory` (Unix
 * only). Read-only; used for orphan discovery. On Windows named pipes leave no
 * files and this returns `[]`.
 */
export async function listPrivateSocketAliases(directory: string): Promise<string[]> {
  if (process.platform === "win32") return [];
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const aliases: string[] = [];
  for (const entry of entries) {
    if (!isPrivateSocketName(entry)) continue;
    const candidate = join(directory, entry);
    try {
      const info = await lstat(candidate);
      if (info.isSocket()) aliases.push(candidate);
    } catch {
      /* raced away; skip */
    }
  }
  return aliases;
}

/**
 * Safe startup recovery of a leftover socket at the stable public endpoint.
 *
 * Never deletes unconditionally (this is the incident fix: an old orphan's
 * stale cleanup must not be able to unlink the current daemon's socket). Rules,
 * all fail closed:
 *   - missing path → nothing to do
 *   - non-socket / symlink → refuse, never delete
 *   - socket → active-connect probe:
 *       live → conflict (a live listener is serving; never delete)
 *       dead (ECONNREFUSED) → lstat again; only remove when the socket identity
 *             (dev/ino) is unchanged — otherwise a concurrent replacement is
 *             left untouched
 *       timeout/EACCES/unknown → fail closed
 */
export async function recoverStalePublicSocket(paths: SessiondPaths, privateDir?: SessiondPrivateDirectory): Promise<void> {
  if (process.platform === "win32") return; // named pipes leave no files
  // When the daemon preflighted the directory, re-verify its dev/ino identity
  // before removing debris. A direct caller without a context proceeds as
  // before (recovery never creates the directory itself).
  if (privateDir !== undefined) await reverifySessiondPrivateDirectory(privateDir);
  const info = await lstat(paths.endpoint, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info === undefined) return;
  if (!info.isSocket()) {
    throw new SessiondError("forbidden", "unsafe sessiond socket path (not a socket)");
  }
  const result = await probeSocket(paths.endpoint);
  if (result === "live") {
    throw new SessiondError("conflict", "a live sessiond listener is already published at the public endpoint");
  }
  if (result === "unknown") {
    throw new SessiondError("unavailable", "could not confirm sessiond socket liveness; refusing to remove");
  }
  const after = await lstat(paths.endpoint, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (after === undefined) return; // removed concurrently; nothing to do
  if (!after.isSocket() || after.dev !== info.dev || after.ino !== info.ino) {
    throw new SessiondError("forbidden", "sessiond socket identity changed during recovery; refusing to remove");
  }
  await rm(paths.endpoint, { force: true });
}

/**
 * Safe startup recovery of leftover Pix-named private socket aliases (orphan
 * discovery). A live private alias means a daemon lost its lock/public but is
 * still serving — startup must fail closed rather than start a second daemon
 * over it. Only a provably-dead alias (socket, ECONNREFUSED, identity stable)
 * is removed as debris. Windows: no-op.
 */
export async function recoverStalePrivateAliases(paths: SessiondPaths, privateDir?: SessiondPrivateDirectory): Promise<void> {
  if (process.platform === "win32") return;
  // When the daemon preflighted the directory, re-verify its dev/ino identity
  // before removing debris. A direct caller without a context proceeds as
  // before (recovery never creates the directory itself).
  if (privateDir !== undefined) await reverifySessiondPrivateDirectory(privateDir);
  for (const alias of await listPrivateSocketAliases(paths.directory)) {
    const info = await lstat(alias, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info === undefined || !info.isSocket()) continue; // raced away / not a socket → leave
    const result = await probeSocket(alias);
    if (result === "live") {
      throw new SessiondError("conflict", "a live sessiond private socket is present; refusing to start over it");
    }
    if (result === "unknown") {
      throw new SessiondError("unavailable", "could not confirm sessiond private socket liveness; refusing to start");
    }
    const after = await lstat(alias, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (after === undefined) continue;
    if (!after.isSocket() || after.dev !== info.dev || after.ino !== info.ino) {
      throw new SessiondError("forbidden", "sessiond private socket identity changed during recovery; refusing to remove");
    }
    await rm(alias, { force: true });
  }
}

/** Ownership record for a published Unix socket, used for owner-safe cleanup. */
export interface OwnedSocketPublication {
  readonly privatePath: string;
  readonly publicPath: string;
  readonly instanceId: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

/**
 * Atomically publish the private listener at the stable public endpoint via a
 * hard `link` (Unix only). Records the socket identity (dev/ino) for owner-safe
 * cleanup. EEXIST is never overwritten — a different daemon's public socket is a
 * conflict. Must run after the RPC server is listening on `privatePath`.
 */
export async function publishPublicEndpoint(
  paths: SessiondPaths,
  privatePath: string,
  instanceId: string,
  privateDir?: SessiondPrivateDirectory,
): Promise<OwnedSocketPublication> {
  // The containing directory identity is re-verified before the atomic link
  // publishes the stable public socket inside it.
  await resolveSessiondPrivateDirectory(paths, privateDir);
  const info = await lstat(privatePath, { bigint: true });
  if (!info.isSocket()) {
    throw new SessiondError("internal", "private sessiond socket is missing after listen");
  }
  try {
    await link(privatePath, paths.endpoint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new SessiondError("conflict", "a sessiond socket is already published at the public endpoint");
    }
    throw error;
  }
  const published = await lstat(paths.endpoint, { bigint: true });
  if (!published.isSocket() || published.dev !== info.dev || published.ino !== info.ino) {
    throw new SessiondError("internal", "sessiond public socket publication failed identity check");
  }
  return { privatePath, publicPath: paths.endpoint, instanceId, dev: published.dev, ino: published.ino };
}

/**
 * Remove the public endpoint ONLY if it still belongs to this instance: the
 * instance lock still names this instanceId AND the public path is still the
 * same socket inode this instance published. Any mismatch (lock replaced or
 * externally deleted, public replaced by another daemon) → leave it alone.
 * Idempotent. Must run while the RPC server is still alive, before
 * `server.close()` (which unlinks only the private path).
 */
export async function releaseOwnedPublicEndpoint(
  paths: SessiondPaths,
  publication: OwnedSocketPublication,
): Promise<void> {
  if (process.platform === "win32") return;
  const lock = await readInstanceLockStrict(paths);
  if (lock.kind !== "ok" || lock.record.instanceId !== publication.instanceId) {
    return; // lock gone/replaced: not our instance anymore — never touch public
  }
  let info;
  try {
    info = await lstat(publication.publicPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // already gone (idempotent)
    throw error;
  }
  if (!info.isSocket() || info.dev !== publication.dev || info.ino !== publication.ino) {
    return; // public was replaced by another daemon — never delete it
  }
  await rm(publication.publicPath, { force: true });
}

/**
 * Best-effort removal of this instance's own private socket path after the RPC
 * server has closed. libuv normally unlinks the bound path on close; this only
 * covers residue. Only a socket at our unique token path is ever removed — a
 * non-socket or an ENOENT is left alone. Windows: no-op.
 */
export async function removeOwnedPrivateSocket(privatePath: string): Promise<void> {
  if (process.platform === "win32") return;
  let info;
  try {
    info = await lstat(privatePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!info.isSocket()) return; // not our socket file → leave it
  await rm(privatePath, { force: true });
}
