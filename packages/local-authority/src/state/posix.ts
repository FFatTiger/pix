/**
 * @fffattiger/pix-local-authority — high-assurance POSIX secure-state backend.
 *
 * Extracted/adapted from the pix-host `HostStateDirectoryLease`
 * (`packages/host/src/resources/host-state-directory.ts`) so the same
 * fail-closed primitives are a dependency-free infrastructure workspace with
 * platform-neutral contracts (`contracts.ts`) and a POSIX implementation here.
 *
 * Frozen semantics preserved from the Host source (see the Host module header
 * for the full rationale):
 *   - canonical paths: nearest-existing-ancestor realpath (resolves the macOS
 *     `/var` → `/private/var` system alias instead of false-rejecting), then a
 *     validated missing-component tail, then a canonical component re-walk;
 *   - dedicated private dir: component-by-component walk, symlink/non-dir
 *     components fail closed, newly created leaf is 0700 via fd-based fchmod,
 *     an EXISTING leaf is NEVER chmod'd (validate-only: owner, exact mode,
 *     Host policy hook);
 *   - documents: bounded read with symlink / non-regular / oversize /
 *     permissions / hard-link checks; atomic write temp same-dir O_EXCL|O_NOFOLLOW
 *     0600 → write+fsync → identity verification → atomic rename → directory
 *     fsync (FATAL except the narrowly enumerated EINVAL / ENOTSUP / EISDIR
 *     unsupported set). A returned success means the publish completed.
 *   - lifetime lock: O_EXCL acquire with exact-owner dev/ino + instanceId
 *     release; busy (live pid) / stale (dead pid, NEVER auto-reclaimed) /
 *     unsafe / ambiguous classification; identity re-verification before every
 *     atomic publish (lock lost ⇒ fail closed).
 *
 * Residual (Node has no openat): a same-UID concurrent actor on a shared parent
 * can race lstat/mkdir/open — the final fd-based fchmod/identity re-checks fail
 * closed on any swap. Cross-user boundaries are never weakened.
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  hasControlChar,
  isRecord,
  isSafeInteger,
  isValidInstanceId,
  LocalAuthorityError,
  type AcquireLifetimeLockOptions,
  type EnsurePrivateDirectoryOptions,
  type EnsurePrivateDirectoryResult,
  type LifetimeLockOwnership,
  type LifetimeLockReadResult,
  type PosixFileIdentity,
  type PosixPrincipal,
  type ReadStateDocumentOptions,
  type ReleaseLifetimeLockOptions,
  type SecureStateBackend,
  type StateDocumentReadResult,
  type WriteStateDocumentOptions,
} from "./contracts.js";

/**
 * Narrowly enumerated truly-unsupported directory-fsync error codes. These mean
 * "this OS/filesystem does not support fsync on a directory handle", never
 * "the durable write is lost" — so they are tolerated. Any other error (EIO,
 * EACCES, EROFS, ENOSPC, EMFILE, ENOMEM, ...) is FATAL and fails the publish.
 */
const DIR_FSYNC_UNSUPPORTED_CODES = new Set(["EINVAL", "ENOTSUP", "EISDIR"]);

const MAX_CANONICAL_PATH_LENGTH = 4096;
const DEFAULT_PRIVATE_DIR_MODE = 0o700;

function openFlags(): number {
  return constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
}

function toIdentity(info: { dev: number; ino: number; mode: number; nlink: number; size: number; uid: number; gid: number; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): PosixFileIdentity {
  return {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    nlink: info.nlink,
    size: info.size,
    uid: info.uid,
    gid: info.gid,
    isFile: info.isFile(),
    isDirectory: info.isDirectory(),
    isSymbolicLink: info.isSymbolicLink(),
  };
}

async function lstatRegularFile(path: string): Promise<{ dev: number; ino: number } | null> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) return null;
    return { dev: info.dev, ino: info.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

// ---------------------------------------------------------------------------
// Canonical absolute paths
// ---------------------------------------------------------------------------

/**
 * Canonicalize an absolute path via nearest-existing-ancestor realpath.
 *
 * 1. Requires an absolute, bounded, NUL/control-free path; rejects filesystem
 *    roots, lexical parent/current escapes, network (UNC) and Windows claims.
 * 2. Finds the nearest EXISTING ancestor and `realpath`s it (so the macOS
 *    `/var` → `/private/var` system alias, and generic existing-prefix aliases,
 *    resolve instead of false-rejecting).
 * 3. Appends the validated missing-component tail.
 * 4. Re-walks the canonical components, verifying every EXISTING component is a
 *    real non-symlink directory (the returned path never contains a symlinked
 *    intermediate component; a symlink swapped in after realpath fails closed).
 *
 * Never creates anything; the caller's secure-dir walk handles creation.
 */
export async function canonicalizeAbsolutePath(path: string): Promise<string> {
  if (
    typeof path !== "string"
    || path.length === 0
    || path.length > MAX_CANONICAL_PATH_LENGTH
    || path.includes("\0")
    || hasControlChar(path)
  ) {
    throw new LocalAuthorityError("INVALID_PATH", "Path must be a bounded absolute path without control characters");
  }
  if (/^[A-Za-z]:[\\/]/.test(path)) {
    throw new LocalAuthorityError("WINDOWS_PATH", "Windows drive-letter paths are not supported");
  }
  if (/^\/\//.test(path)) {
    throw new LocalAuthorityError("NETWORK_PATH", "Network share paths are not supported");
  }
  if (!isAbsolute(path)) {
    throw new LocalAuthorityError("INVALID_PATH", "Path must be absolute");
  }
  if (path === "/") {
    throw new LocalAuthorityError("ROOT_PATH", "Filesystem root is not a valid canonical target");
  }

  // Reject lexical parent/current escapes BEFORE normalization (never silently
  // resolve `..` across a symlink boundary).
  for (const segment of path.split("/")) {
    if (segment === "." || segment === "..") {
      throw new LocalAuthorityError("PARENT_ESCAPE", "Path must not contain parent or current directory components");
    }
    if (segment.includes("\0")) {
      throw new LocalAuthorityError("UNSAFE_COMPONENT", "Path component is unsafe");
    }
  }

  const normalized = resolve(path);
  if (normalized === "/") {
    throw new LocalAuthorityError("ROOT_PATH", "Filesystem root is not a valid canonical target");
  }

  // Nearest existing ancestor: climb until lstat succeeds.
  let existing = normalized;
  const missing: string[] = [];
  for (;;) {
    try {
      await lstat(existing);
      break;
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") {
        throw new LocalAuthorityError("INVALID_PATH", "Path component cannot be inspected");
      }
      const parent = dirname(existing);
      if (parent === existing) {
        throw new LocalAuthorityError("ROOT_PATH", "Path has no existing ancestor");
      }
      missing.unshift(basename(existing));
      existing = parent;
    }
  }

  let canonicalPrefix: string;
  try {
    canonicalPrefix = await realpath(existing);
  } catch {
    throw new LocalAuthorityError("INVALID_PATH", "Existing ancestor cannot be canonicalized");
  }
  const result = missing.length === 0 ? canonicalPrefix : join(canonicalPrefix, ...missing);

  // Walk canonical components: every EXISTING component must be a real
  // non-symlink directory. A missing tail (ENOENT) is expected and allowed.
  const resultSegments = result.slice(1).split("/").filter((segment) => segment.length > 0);
  let current = "/";
  for (const segment of resultSegments) {
    current = current === "/" ? `/${segment}` : `${current}/${segment}`;
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") break;
      throw new LocalAuthorityError("INVALID_PATH", "Canonical path component cannot be inspected");
    }
    if (info.isSymbolicLink()) {
      throw new LocalAuthorityError("SYMLINK", "Canonical path must not contain a symbolic link");
    }
    if (!info.isDirectory()) {
      throw new LocalAuthorityError("NOT_DIRECTORY", "Canonical path must be a directory");
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Stable POSIX identity / principal
// ---------------------------------------------------------------------------

export async function posixFileIdentity(path: string): Promise<PosixFileIdentity | null> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
  return toIdentity(info);
}

export function currentPrincipal(): PosixPrincipal {
  return {
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    gid: typeof process.getgid === "function" ? process.getgid() : undefined,
  };
}

export function isOwnedByCurrentUser(identity: PosixFileIdentity): boolean {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return typeof identity.uid === "number" && typeof uid === "number" && identity.uid === uid;
}

// ---------------------------------------------------------------------------
// Secure private directory
// ---------------------------------------------------------------------------

/**
 * Ensure a dedicated private directory exists as a real non-symlink directory.
 *
 * Walks every textual component of the (already canonical) absolute path from
 * the root:
 * 1. Existing components must be non-symlink directories (a symlink at any
 *    depth is fail-closed).
 * 2. On first ENOENT, create each remaining segment with mkdir(recursive:false);
 *    a newly created leaf is set to 0700 via fd-based fchmod (open the dir with
 *    O_RDONLY|O_NOFOLLOW, fchmod the opened handle — never path-chmod after a
 *    handle close, so a swapped-in symlink cannot be followed).
 * 3. An EXISTING final directory is NEVER chmod'd. It must be current-user
 *    owned (where supported), exact 0700, real non-symlink, and pass the Host
 *    `validateExistingLeaf` policy hook (entries allowlist).
 *
 * Reserved-destination / repository-tree rejection is Host policy and is
 * applied by the caller BEFORE this walk (so nothing is mutated for a rejected
 * dir).
 */
export async function ensurePrivateDirectory(
  path: string,
  options: EnsurePrivateDirectoryOptions = {},
): Promise<EnsurePrivateDirectoryResult> {
  const requireOwnedByCurrentUser = options.requireOwnedByCurrentUser ?? true;
  const requireMode = options.requireMode ?? DEFAULT_PRIVATE_DIR_MODE;
  const validateExistingLeaf = options.validateExistingLeaf;

  const normalized = resolve(path);
  if (
    typeof path !== "string"
    || path.length === 0
    || path.includes("\0")
    || hasControlChar(path)
    || !isAbsolute(path)
  ) {
    throw new LocalAuthorityError("INVALID_PATH", "Directory path is invalid");
  }
  if (normalized === "/") {
    throw new LocalAuthorityError("ROOT_PATH", "Directory must not be the filesystem root");
  }

  const segments = normalized === "/"
    ? []
    : normalized.slice(1).split("/").filter((segment) => segment.length > 0);
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new LocalAuthorityError("PARENT_ESCAPE", "Directory path is unsafe");
    }
    if (segment.includes("\0") || segment.includes("/")) {
      throw new LocalAuthorityError("UNSAFE_COMPONENT", "Directory path is unsafe");
    }
  }

  let current = "/";
  let creating = false;
  let leafCreated = false;
  for (const segment of segments) {
    current = current === "/" ? `/${segment}` : `${current}/${segment}`;

    if (!creating) {
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if (errnoCode(error) !== "ENOENT") {
          throw new LocalAuthorityError("INVALID_PATH", "Directory path is unsafe");
        }
        creating = true;
      }
      if (!creating) {
        // Existing component of the original absolute path: never a symlink.
        if (info!.isSymbolicLink() || !info!.isDirectory()) {
          throw new LocalAuthorityError(
            info!.isSymbolicLink() ? "SYMLINK" : "NOT_DIRECTORY",
            "Directory path is unsafe",
          );
        }
        continue;
      }
    }

    try {
      await mkdir(current, { recursive: false, mode: 0o700 });
    } catch (mkdirError) {
      if (errnoCode(mkdirError) !== "EEXIST") {
        throw new LocalAuthorityError("INVALID_PATH", "Directory path is unsafe");
      }
    }
    let createdInfo;
    try {
      createdInfo = await lstat(current);
    } catch {
      throw new LocalAuthorityError("INVALID_PATH", "Directory path is unsafe");
    }
    if (createdInfo.isSymbolicLink() || !createdInfo.isDirectory()) {
      throw new LocalAuthorityError(
        createdInfo.isSymbolicLink() ? "SYMLINK" : "NOT_DIRECTORY",
        "Directory path is unsafe",
      );
    }
    if (current === normalized) leafCreated = true;
  }

  let finalInfo;
  try {
    finalInfo = await lstat(current);
  } catch {
    throw new LocalAuthorityError("INVALID_PATH", "Directory path is unsafe");
  }
  if (finalInfo.isSymbolicLink() || !finalInfo.isDirectory()) {
    throw new LocalAuthorityError(
      finalInfo.isSymbolicLink() ? "SYMLINK" : "NOT_DIRECTORY",
      "Directory path is unsafe",
    );
  }

  if (leafCreated) {
    // Newly created dedicated leaf: enforce 0700 via fd-based fchmod. O_NOFOLLOW
    // refuses a swapped-in symlink at open time (ELOOP → fail closed); fchmod
    // applies to the opened inode regardless of path swaps. No path chmod.
    let dirHandle;
    try {
      dirHandle = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        await dirHandle.chmod(requireMode);
      } finally {
        await dirHandle.close();
      }
    } catch {
      throw new LocalAuthorityError("NOT_PRIVATE", "Directory private mode could not be enforced");
    }
  } else {
    // Existing directory: NEVER chmod. Require current-user ownership where
    // supported and exact private mode; Host policy validates the contents.
    if (requireOwnedByCurrentUser && !isOwnedByCurrentUser(toIdentity(finalInfo))) {
      throw new LocalAuthorityError("NOT_OWNED", "Directory is owned by another user");
    }
    if ((finalInfo.mode & 0o777) !== requireMode) {
      throw new LocalAuthorityError("NOT_PRIVATE", "Directory mode must be private");
    }
    if (validateExistingLeaf) {
      await validateExistingLeaf({ identity: toIdentity(finalInfo), path: current });
    }
  }

  // Final re-verify the leaf is still a real canonical non-symlink directory.
  let finalReal: string;
  try {
    finalReal = await realpath(current);
  } catch {
    throw new LocalAuthorityError("INVALID_PATH", "Directory path is unsafe");
  }
  if (finalReal !== current) {
    throw new LocalAuthorityError("INVALID_PATH", "Directory path is unsafe");
  }
  return { path: current, created: leafCreated, identity: toIdentity(finalInfo) };
}

// ---------------------------------------------------------------------------
// Secure state documents (bounded read + atomic durable write)
// ---------------------------------------------------------------------------

export async function readStateDocument(
  path: string,
  options: ReadStateDocumentOptions,
): Promise<StateDocumentReadResult> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      return { missing: true };
    }
    throw new LocalAuthorityError("DOC_UNREADABLE", "State document is unreadable");
  }
  if (info.isSymbolicLink()) {
    throw new LocalAuthorityError("DOC_SYMLINK", "State document must not be a symbolic link");
  }
  if (!info.isFile()) {
    throw new LocalAuthorityError("NOT_REGULAR", "State document must be a regular file");
  }
  if (info.size > options.maxBytes) {
    throw new LocalAuthorityError("DOC_OVERSIZE", "State document exceeds the size bound");
  }
  // Wrong permission: no group/other read/write access on the document.
  if ((info.mode & 0o077) !== 0) {
    throw new LocalAuthorityError("DOC_PERMISSIONS", "State document permissions are unsafe");
  }
  // Hard-linked document: extra names could alias a file we must not rewrite.
  if (info.nlink > 1) {
    throw new LocalAuthorityError("DOC_HARD_LINK", "State document must not be hard-linked");
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new LocalAuthorityError("DOC_UNREADABLE", "State document is unreadable");
  }
  return { content: text };
}

async function fsyncDirectory(dirPath: string, failDirFsync?: () => void): Promise<void> {
  try {
    failDirFsync?.();
    const handle = await open(dirPath, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = errnoCode(error);
    if (typeof code === "string" && DIR_FSYNC_UNSUPPORTED_CODES.has(code)) {
      // Truly-unsupported platform/filesystem: tolerate (documented above).
      return;
    }
    throw new LocalAuthorityError("DIR_FSYNC_FAILED", "Directory fsync failed");
  }
}

/**
 * Atomic replace of a state document under the held lifetime lock.
 * Enforces size bounds, file safety, identity re-verification and durability:
 * temp same-dir O_EXCL|O_NOFOLLOW 0600 → write+fsync → identity → atomic
 * rename → directory fsync. The temp is always cleaned on failure. `lockCheck`
 * re-verifies the caller's held lifetime-lock identity immediately before the
 * rename (fail closed on a lost/replaced lock).
 */
export async function writeStateDocument(
  path: string,
  payload: string,
  options: WriteStateDocumentOptions,
): Promise<void> {
  if (Buffer.byteLength(payload, "utf8") > options.maxBytes) {
    throw new LocalAuthorityError("DOC_OVERSIZE", "Serialized state document exceeds size bound");
  }
  const targetPath = path;
  try {
    const existing = await lstat(targetPath);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new LocalAuthorityError("NOT_REGULAR", "State document path is not a regular file");
    }
  } catch (error) {
    if (error instanceof LocalAuthorityError) throw error;
    if (errnoCode(error) !== "ENOENT") {
      throw new LocalAuthorityError("WRITE_FAILED", "State document path unsafe");
    }
  }
  const temp = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // Mode is set on the O_EXCL open handle (and reinforced via handle.chmod)
    // before close. Never path-chmod temp/document after close — a same-user
    // swap to a symlink would be followed by chmod(path).
    const handle = await open(temp, openFlags(), 0o600);
    let tempIdentity: { dev: number; ino: number };
    try {
      await handle.chmod(0o600);
      await handle.writeFile(payload, "utf8");
      options.inject?.failTempFsync?.();
      await handle.sync();
      const st = await handle.stat();
      tempIdentity = { dev: st.dev, ino: st.ino };
    } finally {
      await handle.close();
    }
    // Cross-process ownership re-verification immediately before publish: if
    // the lifetime lock was lost (external removal/replacement), abort
    // fail-closed instead of publishing under an unlocked dir.
    if (options.lockCheck) {
      const currentLock = await lstatRegularFile(options.lockCheck.path);
      if (
        !currentLock
        || currentLock.dev !== options.lockCheck.ownership.dev
        || currentLock.ino !== options.lockCheck.ownership.ino
      ) {
        throw new LocalAuthorityError("LOCK_LOST", "Lifetime lock ownership lost before publish");
      }
    }
    options.inject?.failRename?.();
    await rename(temp, targetPath);
    // rename preserves mode/identity; verify final is the same regular file.
    let published;
    try {
      published = await lstat(targetPath);
    } catch {
      throw new LocalAuthorityError("WRITE_FAILED", "Atomic state document write failed");
    }
    if (
      published.isSymbolicLink()
      || !published.isFile()
      || published.dev !== tempIdentity.dev
      || published.ino !== tempIdentity.ino
    ) {
      throw new LocalAuthorityError("WRITE_FAILED", "Published state document identity mismatch");
    }
    await fsyncDirectory(dirname(targetPath), options.inject?.failDirFsync);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    if (error instanceof LocalAuthorityError) throw error;
    throw new LocalAuthorityError("WRITE_FAILED", "Atomic state document write failed");
  }
}

// ---------------------------------------------------------------------------
// Exclusive lifetime lock
// ---------------------------------------------------------------------------

export function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockRecord(text: string): { pid: number; instanceId: string; createdAt: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (!isSafeInteger(parsed.pid) || parsed.pid <= 0) return null;
  if (!isValidInstanceId(parsed.instanceId)) return null;
  if (!isSafeInteger(parsed.createdAt)) return null;
  return {
    pid: parsed.pid,
    instanceId: parsed.instanceId,
    createdAt: parsed.createdAt,
  };
}

export async function readLifetimeLock(path: string): Promise<LifetimeLockReadResult> {
  const identity = await lstatRegularFile(path);
  if (identity === null) {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) return { kind: "unsafe", reason: "LOCK_UNSAFE" };
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return { kind: "missing" };
      return { kind: "unsafe", reason: "LOCK_UNSAFE" };
    }
    return { kind: "missing" };
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { kind: "unsafe", reason: "LOCK_UNSAFE" };
  }
  const record = readLockRecord(text);
  if (record === null) return { kind: "unsafe", reason: "LOCK_UNSAFE" };
  return {
    kind: "valid",
    record,
    identity: { dev: identity.dev, ino: identity.ino },
  };
}

/**
 * Acquire the exclusive LIFETIME lock (O_EXCL). If any lock exists — live
 * (LOCK_BUSY) or stale/ambiguous (LOCK_STALE / LOCK_UNSAFE / LOCK_AMBIGUOUS) —
 * fail closed. NEVER auto-reclaims a stale lock: after SIGKILL the next
 * acquire fails closed and the operator must explicitly remove the fixture
 * lock after proving the old pid is dead.
 */
export async function acquireLifetimeLock(
  path: string,
  options: AcquireLifetimeLockOptions,
): Promise<LifetimeLockOwnership> {
  try {
    // Mode via O_EXCL open + handle.chmod only; never path-chmod after close.
    const handle = await open(path, openFlags(), 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(options.payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const owned = await lstatRegularFile(path);
    if (!owned) {
      // Lock vanished immediately after O_EXCL create: cannot pin identity →
      // ambiguous → fail closed.
      throw new LocalAuthorityError("LOCK_UNSAFE", "Lifetime lock ownership could not be pinned");
    }
    return { dev: owned.dev, ino: owned.ino };
  } catch (error) {
    if (error instanceof LocalAuthorityError) throw error;
    if (errnoCode(error) !== "EEXIST") {
      throw new LocalAuthorityError("LOCK_UNSAFE", "Could not create lifetime lock");
    }
    const existing = await readLifetimeLock(path);
    if (existing.kind === "unsafe") {
      throw new LocalAuthorityError("LOCK_UNSAFE", "Existing lifetime lock is unsafe");
    }
    if (existing.kind === "missing") {
      // Lock existed at O_EXCL but vanished before the read — ambiguous.
      throw new LocalAuthorityError("LOCK_AMBIGUOUS", "Lifetime lock identity is ambiguous");
    }
    if (options.isPidAlive(existing.record.pid)) {
      throw new LocalAuthorityError("LOCK_BUSY", "Another process holds the lifetime lock");
    }
    throw new LocalAuthorityError(
      "LOCK_STALE",
      "Lifetime lock is stale; verify the old process is dead and remove the lock explicitly",
    );
  }
}

/**
 * Release the lock only when its exact record instanceId AND dev/ino identity
 * match this handle. A wrong instance or a replaced lock is never removed.
 */
export async function releaseLifetimeLock(
  path: string,
  options: ReleaseLifetimeLockOptions,
): Promise<void> {
  const current = await readLifetimeLock(path);
  if (current.kind !== "valid") return;
  if (current.record.instanceId !== options.instanceId) return;
  if (current.identity.dev !== options.ownership.dev || current.identity.ino !== options.ownership.ino) {
    return;
  }
  await rm(path, { force: true }).catch(() => {});
}

// ---------------------------------------------------------------------------
// POSIX backend factory
// ---------------------------------------------------------------------------

export interface PosixSecureStateBackendOptions {
  /** Test-only fault-injection seam merged into every atomic write (never production). */
  inject?: {
    failTempFsync?: () => void;
    failRename?: () => void;
    failDirFsync?: () => void;
  };
}

/** Build the POSIX `SecureStateBackend` implementation. */
export function createPosixSecureStateBackend(
  options: PosixSecureStateBackendOptions = {},
): SecureStateBackend {
  const inject = options.inject ?? {};
  return {
    kind: "posix",
    canonicalizePath: (path) => canonicalizeAbsolutePath(path),
    fileIdentity: (path) => posixFileIdentity(path),
    principal: () => currentPrincipal(),
    isOwnedByCurrentUser: (identity) => isOwnedByCurrentUser(identity),
    ensurePrivateDirectory: (path, opts) => ensurePrivateDirectory(path, opts),
    readStateDocument: (path, opts) => readStateDocument(path, opts),
    writeStateDocument: (path, payload, opts) =>
      writeStateDocument(path, payload, {
        maxBytes: opts.maxBytes,
        ...(opts.lockCheck ? { lockCheck: opts.lockCheck } : {}),
        inject: { ...inject, ...(opts.inject ?? {}) },
      }),
    acquireLifetimeLock: (path, opts) => acquireLifetimeLock(path, opts),
    readLifetimeLock: (path) => readLifetimeLock(path),
    releaseLifetimeLock: (path, opts) => releaseLifetimeLock(path, opts),
    isPidAlive: (pid) => isPidAlive(pid),
  };
}
