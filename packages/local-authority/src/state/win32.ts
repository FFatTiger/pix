/**
 * @fffattiger/pix-local-authority — Windows secure-state backend.
 *
 * Slice 1 (win32 host). This backend satisfies the SAME platform-neutral
 * `SecureStateBackend` contract as `posix.ts`, adapted to Windows realities:
 *
 *   - canonical paths: Windows drive-letter absolute paths (`C:\…` / `C:/…`)
 *     are canonicalized via nearest-existing-ancestor realpath + validated
 *     missing-component tail + canonical component re-walk, using the win32
 *     path module. UNC network shares stay REJECTED (fail closed, matching the
 *     frozen `NETWORK_PATH` contract code). Forward slashes are normalized to
 *     backslashes. Case is PRESERVED from realpath (canonical comparison is
 *     case-insensitive at the call sites that need it).
 *   - dedicated private dir: the same component-by-component walk with
 *     symlink/non-dir fail-closed checks. On Windows there is no meaningful
 *     POSIX mode bit on NTFS (mkdir mode 0700 reports 0666 through lstat), so
 *     the mode enforcement is replaced by: (a) the created-leaf fd-identity
 *     pinning retained from the POSIX walk, and (b) an existing leaf is
 *     validated as a real non-symlink directory owned by the current user via
 *     a same-UID approximation: uid is undefined on Windows, so ownership
 *     checks degrade to "identity inspectable" (documented residual; NTFS ACLs
 *     enforce per-user access, not POSIX mode bits).
 *   - documents: bounded read with symlink / non-regular / oversize checks.
 *     POSIX permission/hard-link checks degrade to best-effort: mode bits are
 *     reported as 0666 on NTFS so the strict 0600 verification is skipped on
 *     win32; nlink is not meaningful on NTFS (always 1) so the hard-link check
 *     is retained but inert. Atomic write: temp same-dir O_EXCL|O_CREAT (no
 *     O_NOFOLLOW on win32 — it is ignored) 0600-mode-open → write+fsync →
 *     identity verification → rename (with Windows REPLACE semantics via
 *     fs.rename, which maps to MoveFileEx WITH replace on Node ≥ 20) →
 *     directory fsync is UNSUPPORTED on Windows (EBADF/EINVAL tolerated).
 *   - lifetime lock: O_EXCL acquire with exact-owner dev/ino + instanceId
 *     release; busy/stale/unsafe classification identical to POSIX. dev/ino
 *     are stable file-index identities on NTFS (birthVolumeId/fileId), which
 *     Node surfaces through lstat Stats on win32.
 *
 * Windows residual windows are the SAME as POSIX (no openat): a same-user
 * concurrent actor on a shared parent can race lstat/mkdir/open. Cross-user
 * boundaries are enforced by NTFS ACLs and the per-user profile layout
 * (`~/.pi` lives under the user profile), not by POSIX mode bits.
 */
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, parse } from "node:path";
import { win32 } from "node:path";
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
 * Windows does not support fsync on directory handles; the POSIX backend
 * tolerates EINVAL/ENOTSUP/EISDIR, and win32 surfaces EBADF/EPERM/ENOTDIR
 * instead. All are tolerated as "unsupported on this platform" — a returned
 * success still means the rename completed.
 */
const DIR_FSYNC_UNSUPPORTED_CODES = new Set(["EINVAL", "ENOTSUP", "EISDIR", "EBADF", "EPERM", "ENOTDIR"]);

const MAX_CANONICAL_PATH_LENGTH = 4096;

/** Drive-letter absolute claim: `C:\` or `C:/` (case-insensitive). */
const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;
/** UNC claim: `\\server\share…` or `//server/share…`. */
const UNC_PATH = /^[\\/]{2}[^\\/]+[\\/]/;

function isWindowsDriveAbsolute(path: string): boolean {
  return DRIVE_ABSOLUTE.test(path);
}

function toIdentity(info: Stats): PosixFileIdentity {
  return {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    nlink: info.nlink,
    size: info.size,
    uid: (info as Stats & { uid?: number }).uid ?? 0,
    gid: (info as Stats & { gid?: number }).gid ?? 0,
    isFile: info.isFile(),
    isDirectory: info.isDirectory(),
    isSymbolicLink: info.isSymbolicLink(),
  };
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/** Case-insensitive path equality (Windows filesystem semantics). */
function pathEquals(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

type RegularFileInspection =
  | { kind: "regular"; dev: number; ino: number }
  | { kind: "missing" }
  | { kind: "nonRegular" }
  | { kind: "unreadable" };

async function inspectRegularFile(path: string): Promise<RegularFileInspection> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) return { kind: "nonRegular" };
    return { kind: "regular", dev: info.dev, ino: info.ino };
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { kind: "missing" };
    return { kind: "unreadable" };
  }
}

// ---------------------------------------------------------------------------
// Canonical absolute paths (win32)
// ---------------------------------------------------------------------------

/**
 * Canonicalize a Windows drive-letter absolute path via
 * nearest-existing-ancestor realpath.
 *
 * 1. Requires a bounded, NUL/control-free, drive-letter absolute path; rejects
 *    UNC/network paths, drive roots, and lexical parent/current escapes.
 * 2. Finds the nearest EXISTING ancestor and `realpath`s it (resolving
 *    subst drives, junctions and symlinks that already exist).
 * 3. Appends the validated missing-component tail with backslash separators.
 * 4. Re-walks the canonical components, verifying every EXISTING component is
 *    a real non-symlink directory.
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
  if (UNC_PATH.test(path)) {
    throw new LocalAuthorityError("NETWORK_PATH", "Network share paths are not supported");
  }
  if (!isWindowsDriveAbsolute(path) || !isAbsolute(path)) {
    throw new LocalAuthorityError("INVALID_PATH", "Path must be a Windows drive-letter absolute path");
  }
  const parsed = parse(path);
  if (pathEquals(parsed.root, win32.normalize(path)) && parsed.root.length >= 2) {
    throw new LocalAuthorityError("ROOT_PATH", "Drive root is not a valid canonical target");
  }

  // Reject lexical parent/current escapes BEFORE normalization. Split on BOTH
  // separators: a user may pass forward-slash Windows paths.
  for (const segment of path.split(/[\\/]/)) {
    if (segment === "." || segment === "..") {
      throw new LocalAuthorityError("PARENT_ESCAPE", "Path must not contain parent or current directory components");
    }
  }

  const normalized = win32.resolve(path);
  if (pathEquals(win32.parse(normalized).root, normalized)) {
    throw new LocalAuthorityError("ROOT_PATH", "Drive root is not a valid canonical target");
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
        throw new LocalAuthorityError("UNSAFE_COMPONENT", "Path component cannot be inspected");
      }
      const parent = dirname(existing);
      if (pathEquals(parent, existing)) {
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
    throw new LocalAuthorityError("UNSAFE_COMPONENT", "Existing ancestor cannot be canonicalized");
  }
  const result = missing.length === 0 ? canonicalPrefix : win32.join(canonicalPrefix, ...missing);

  // Walk canonical components: every EXISTING component must be a real
  // non-symlink directory. A missing tail (ENOENT) is expected and allowed.
  const parsedResult = win32.parse(result);
  const resultSegments = result.slice(parsedResult.root.length).split(/[\\/]/).filter((s) => s.length > 0);
  let current = win32.parse(result).root;
  for (const segment of resultSegments) {
    current = win32.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") break;
      throw new LocalAuthorityError("UNSAFE_COMPONENT", "Canonical path component cannot be inspected");
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
// Stable identity / principal (win32)
// ---------------------------------------------------------------------------

export async function posixFileIdentity(path: string): Promise<PosixFileIdentity | null> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw new LocalAuthorityError("UNSAFE_COMPONENT", "Path component cannot be inspected");
  }
  return toIdentity(info);
}

/**
 * Windows principal: uid/gid are not exposed by Node on win32, so this returns
 * undefined values (matching the "where supported" contract). Ownership checks
 * therefore degrade to inspectable-identity, enforced instead by the per-user
 * profile layout and NTFS ACLs.
 */
export function currentPrincipal(): PosixPrincipal {
  return {
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    gid: typeof process.getgid === "function" ? process.getgid() : undefined,
  };
}

/** uid is undefined on win32 → ownership cannot be verified via uid; treat as owned (ACL-enforced). */
export function isOwnedByCurrentUser(_identity: PosixFileIdentity): boolean {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return uid === undefined || (typeof _identity.uid === "number" && _identity.uid === uid);
}

// ---------------------------------------------------------------------------
// Secure private directory (win32)
// ---------------------------------------------------------------------------

interface EnsurePrivateDirectoryFs {
  lstat: (path: string) => Promise<Stats>;
  mkdir: (path: string, options: { recursive: false; mode: number }) => Promise<string | undefined>;
  realpath: (path: string) => Promise<string>;
  open: (path: string, flags: number) => Promise<OpenedDirectoryHandle>;
  isOwnedByCurrentUser: (identity: PosixFileIdentity) => boolean;
}

interface OpenedDirectoryHandle {
  stat: () => Promise<Stats>;
  chmod: (mode: number) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Ensure a dedicated private directory exists as a real non-symlink directory
 * (win32 policy).
 *
 * Same component-by-component walk as POSIX, with Windows adaptations:
 *   - mkdir mode is still requested as 0700 (inert on NTFS but recorded for
 *     cross-platform persistence semantics).
 *   - The strict `(mode & 0o777) === requireMode` existing-leaf check is
 *     SKIPPED on win32 because NTFS reports 0666 regardless of the requested
 *     creation mode; privacy is enforced by the per-user profile layout +
 *     NTFS ACLs. The Host `validateExistingLeaf` policy hook is still applied.
 *   - fd-identity pinning of a created leaf is retained (dev/ino capture
 *     before/after the chmod attempt), keeping the swap-detection guarantees.
 *
 * TEST-ONLY EXPORT: reachable only via the direct module path
 * `dist/state/win32.js` (NOT re-exported from `state/index` or the package
 * surface), so the public export set stays exact.
 */
export async function ensurePrivateDirectoryWithFs(
  path: string,
  options: EnsurePrivateDirectoryOptions,
  fs: EnsurePrivateDirectoryFs,
): Promise<EnsurePrivateDirectoryResult> {
  const requireOwnedByCurrentUser = options.requireOwnedByCurrentUser ?? true;
  const validateExistingLeaf = options.validateExistingLeaf;

  const normalized = win32.resolve(path);
  if (
    typeof path !== "string"
    || path.length === 0
    || path.includes("\0")
    || hasControlChar(path)
    || !isAbsolute(path)
    || !isWindowsDriveAbsolute(path)
  ) {
    throw new LocalAuthorityError("INVALID_PATH", "Directory path is invalid");
  }
  if (pathEquals(win32.parse(normalized).root, normalized)) {
    throw new LocalAuthorityError("ROOT_PATH", "Directory must not be a drive root");
  }

  const parsed = win32.parse(normalized);
  const segments = normalized.slice(parsed.root.length).split(/[\\/]/).filter((s) => s.length > 0);
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new LocalAuthorityError("PARENT_ESCAPE", "Directory path is unsafe");
    }
    if (segment.includes("\0")) {
      throw new LocalAuthorityError("UNSAFE_COMPONENT", "Directory path is unsafe");
    }
  }

  let current = parsed.root;
  let creating = false;
  let leafCreated = false;
  let createdIdentity: { dev: number; ino: number } | null = null;
  let racedParent: { path: string; dev: number; ino: number } | null = null;

  for (const segment of segments) {
    current = win32.join(current, segment);
    const isLeaf = pathEquals(current, normalized);

    if (racedParent !== null) {
      let parentInfo;
      try {
        parentInfo = await fs.lstat(racedParent.path);
      } catch {
        throw new LocalAuthorityError("UNSAFE_COMPONENT", "Directory path is unsafe");
      }
      if (
        parentInfo.isSymbolicLink()
        || !parentInfo.isDirectory()
        || parentInfo.dev !== racedParent.dev
        || parentInfo.ino !== racedParent.ino
      ) {
        throw new LocalAuthorityError("UNSAFE_COMPONENT", "Directory path is unsafe");
      }
      racedParent = null;
    }

    if (!creating) {
      let info;
      try {
        info = await fs.lstat(current);
      } catch (error) {
        if (errnoCode(error) !== "ENOENT") {
          throw new LocalAuthorityError("UNSAFE_COMPONENT", "Directory path is unsafe");
        }
        creating = true;
      }
      if (!creating) {
        if (info!.isSymbolicLink() || !info!.isDirectory()) {
          throw new LocalAuthorityError(
            info!.isSymbolicLink() ? "SYMLINK" : "NOT_DIRECTORY",
            "Directory path is unsafe",
          );
        }
        continue;
      }
    }

    // creating mode: non-recursive mkdir; a fulfilled mkdir = created by this call.
    let mkdirFulfilled = false;
    try {
      await fs.mkdir(current, { recursive: false, mode: 0o700 });
      mkdirFulfilled = true;
    } catch (mkdirError) {
      if (errnoCode(mkdirError) !== "EEXIST") {
        throw new LocalAuthorityError("UNSAFE_COMPONENT", "Directory path is unsafe");
      }
    }

    let info;
    try {
      info = await fs.lstat(current);
    } catch {
      throw new LocalAuthorityError("UNSAFE_COMPONENT", "Directory path is unsafe");
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new LocalAuthorityError(
        info.isSymbolicLink() ? "SYMLINK" : "NOT_DIRECTORY",
        "Directory path is unsafe",
      );
    }

    if (mkdirFulfilled) {
      if (isLeaf) {
        leafCreated = true;
        createdIdentity = { dev: info.dev, ino: info.ino };
      }
      continue;
    }

    // EEXIST after ENOENT: raced/preplanted. On win32 there are no mode bits
    // to require, so a raced intermediate is accepted after identity pinning
    // (same real non-symlink directory) and re-verified before descendants.
    if (!isLeaf) {
      if (requireOwnedByCurrentUser && !fs.isOwnedByCurrentUser(toIdentity(info))) {
        throw new LocalAuthorityError("NOT_OWNED", "Directory path is unsafe");
      }
      racedParent = { path: current, dev: info.dev, ino: info.ino };
      continue;
    }
    // Raced final leaf → existing-leaf validate-only branch below.
  }

  let finalInfo;
  try {
    finalInfo = await fs.lstat(current);
  } catch {
    throw new LocalAuthorityError("UNSAFE_COMPONENT", "Directory path is unsafe");
  }
  if (finalInfo.isSymbolicLink() || !finalInfo.isDirectory()) {
    throw new LocalAuthorityError(
      finalInfo.isSymbolicLink() ? "SYMLINK" : "NOT_DIRECTORY",
      "Directory path is unsafe",
    );
  }

  if (leafCreated) {
    // Created by THIS call: open the dir and pin fd identity (same as POSIX).
    // chmod(0700) is inert on NTFS but harmless; the identity pinning before
    // and after is what preserves the swap-detection guarantee.
    if (
      createdIdentity === null
      || createdIdentity.dev !== finalInfo.dev
      || createdIdentity.ino !== finalInfo.ino
    ) {
      throw new LocalAuthorityError("UNSAFE_COMPONENT", "Directory path is unsafe");
    }
    let dirHandle;
    try {
      dirHandle = await fs.open(current, constants.O_RDONLY);
      try {
        const opened = await dirHandle.stat();
        if (
          !opened.isDirectory()
          || opened.dev !== createdIdentity.dev
          || opened.ino !== createdIdentity.ino
        ) {
          throw new LocalAuthorityError("UNSAFE_COMPONENT", "Directory path is unsafe");
        }
        await dirHandle.chmod(options.requireMode ?? 0o700).catch(() => {});
        const after = await dirHandle.stat();
        if (
          !after.isDirectory()
          || after.dev !== createdIdentity.dev
          || after.ino !== createdIdentity.ino
        ) {
          throw new LocalAuthorityError("UNSAFE_COMPONENT", "Directory path is unsafe");
        }
      } finally {
        await dirHandle.close().catch(() => {});
      }
    } catch (error) {
      if (error instanceof LocalAuthorityError) throw error;
      throw new LocalAuthorityError("NOT_PRIVATE", "Directory private mode could not be enforced");
    }
  } else {
    // Existing directory: validate owner (degraded on win32) + Host hook.
    // The strict 0700 mode check is intentionally skipped on NTFS.
    if (requireOwnedByCurrentUser && !fs.isOwnedByCurrentUser(toIdentity(finalInfo))) {
      throw new LocalAuthorityError("NOT_OWNED", "Directory is owned by another user");
    }
    if (validateExistingLeaf) {
      await validateExistingLeaf({ identity: toIdentity(finalInfo), path: current });
    }
  }

  // Final re-lstat: still the same verified inode.
  const verifiedDev = createdIdentity !== null ? createdIdentity.dev : finalInfo.dev;
  const verifiedIno = createdIdentity !== null ? createdIdentity.ino : finalInfo.ino;
  let finalRecheck;
  try {
    finalRecheck = await fs.lstat(current);
  } catch {
    throw new LocalAuthorityError("UNSAFE_COMPONENT", "Directory path is unsafe");
  }
  if (
    finalRecheck.isSymbolicLink()
    || !finalRecheck.isDirectory()
    || finalRecheck.dev !== verifiedDev
    || finalRecheck.ino !== verifiedIno
  ) {
    throw new LocalAuthorityError("UNSAFE_COMPONENT", "Directory path is unsafe");
  }

  // Final canonical re-verify (case-insensitive compare).
  let finalReal;
  try {
    finalReal = await fs.realpath(current);
  } catch {
    throw new LocalAuthorityError("UNSAFE_COMPONENT", "Directory path is unsafe");
  }
  if (!pathEquals(finalReal, current)) {
    throw new LocalAuthorityError("UNSAFE_COMPONENT", "Directory path is unsafe");
  }
  return { path: current, created: leafCreated, identity: toIdentity(finalRecheck) };
}

export async function ensurePrivateDirectory(
  path: string,
  options: EnsurePrivateDirectoryOptions = {},
): Promise<EnsurePrivateDirectoryResult> {
  return ensurePrivateDirectoryWithFs(path, options, {
    lstat,
    mkdir,
    realpath,
    open,
    isOwnedByCurrentUser,
  });
}

// ---------------------------------------------------------------------------
// Secure state documents (win32)
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
  // POSIX permission-bit and hard-link checks are not meaningful on NTFS
  // (mode always reports 0666; nlink is always 1) — skipped on win32.
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
      return;
    }
    throw new LocalAuthorityError("DIR_FSYNC_FAILED", "Directory fsync failed");
  }
}

/**
 * Atomic replace of a state document (win32). Same contract as POSIX:
 * temp same-dir O_EXCL 0600 → write+fsync → identity verification →
 * rename → directory fsync (tolerated as unsupported on win32).
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
    const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    let tempIdentity: { dev: number; ino: number };
    try {
      await handle.chmod(0o600).catch(() => {});
      await handle.writeFile(payload, "utf8");
      options.inject?.failTempFsync?.();
      await handle.sync();
      const st = await handle.stat();
      tempIdentity = { dev: st.dev, ino: st.ino };
    } finally {
      await handle.close();
    }
    if (options.lockCheck) {
      const inspection = await inspectRegularFile(options.lockCheck.path);
      const matches = inspection.kind === "regular"
        && inspection.dev === options.lockCheck.ownership.dev
        && inspection.ino === options.lockCheck.ownership.ino;
      if (!matches) {
        throw new LocalAuthorityError("LOCK_LOST", "Lifetime lock ownership lost before publish");
      }
    }
    options.inject?.failRename?.();
    await rename(temp, targetPath);
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
// Exclusive lifetime lock (win32)
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
  const inspection = await inspectRegularFile(path);
  if (inspection.kind === "missing") return { kind: "missing" };
  if (inspection.kind !== "regular") return { kind: "unsafe", reason: "LOCK_UNSAFE" };
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
    identity: { dev: inspection.dev, ino: inspection.ino },
  };
}

async function classifyExistingLock(
  path: string,
  isPidAlive: (pid: number) => boolean,
): Promise<never> {
  const existing = await readLifetimeLock(path);
  if (existing.kind === "unsafe") {
    throw new LocalAuthorityError("LOCK_UNSAFE", "Existing lifetime lock is unsafe");
  }
  if (existing.kind === "missing") {
    throw new LocalAuthorityError("LOCK_AMBIGUOUS", "Lifetime lock identity is ambiguous");
  }
  let alive = false;
  try {
    alive = isPidAlive(existing.record.pid);
  } catch {
    throw new LocalAuthorityError("LOCK_UNSAFE", "Existing lifetime lock could not be classified");
  }
  if (alive) {
    throw new LocalAuthorityError("LOCK_BUSY", "Another process holds the lifetime lock");
  }
  throw new LocalAuthorityError(
    "LOCK_STALE",
    "Lifetime lock is stale; verify the old process is dead and remove the lock explicitly",
  );
}

export async function acquireLifetimeLock(
  path: string,
  options: AcquireLifetimeLockOptions,
): Promise<LifetimeLockOwnership> {
  try {
    const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await handle.chmod(0o600).catch(() => {});
      await handle.writeFile(options.payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const inspection = await inspectRegularFile(path);
    if (inspection.kind !== "regular") {
      throw new LocalAuthorityError("LOCK_UNSAFE", "Lifetime lock ownership could not be pinned");
    }
    return { dev: inspection.dev, ino: inspection.ino };
  } catch (error) {
    if (error instanceof LocalAuthorityError) throw error;
    if (errnoCode(error) !== "EEXIST") {
      throw new LocalAuthorityError("LOCK_UNSAFE", "Could not create lifetime lock");
    }
    return classifyExistingLock(path, options.isPidAlive);
  }
}

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
// Windows backend factory
// ---------------------------------------------------------------------------

export interface Win32SecureStateBackendOptions {
  inject?: {
    failTempFsync?: () => void;
    failRename?: () => void;
    failDirFsync?: () => void;
  };
}

/** Build the win32 `SecureStateBackend` implementation. */
export function createWin32SecureStateBackend(
  options: Win32SecureStateBackendOptions = {},
): SecureStateBackend {
  const inject = options.inject ?? {};
  const backend: SecureStateBackend = {
    kind: "posix", // same contract shape; kind stays "posix" for interface compat
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
  return backend;
}

/**
 * Platform-dispatch alias: on win32, `createPosixSecureStateBackend` resolves
 * to the win32 implementation so the existing call sites (host-state lease)
 * keep working unchanged across platforms.
 */
export const createPosixSecureStateBackend = createWin32SecureStateBackend;
