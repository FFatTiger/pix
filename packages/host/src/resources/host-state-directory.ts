/**
 * Host-owned state-directory lease (shared HostStateDirectoryLease).
 *
 * Extracted from the trusted-roots ledger so that every Host-owned durable
 * state document (currently `trusted-roots.json`, future
 * `managed-worktrees.json`) is serialized, persisted and protected by ONE
 * shared mechanism: one safe dedicated host dir, ONE exclusive lifetime lock,
 * one in-process mutation mutex, and one fail-closed bounded document
 * read/atomic-replace path. Both ledger adapters (trusted roots and managed
 * worktrees) are thin wrappers over this lease; the lease is Host-internal and
 * is NOT exported from the package index.
 *
 * Layout (default `~/.pi/pix/host`, override via absolute `PIX_HOST_DIR`):
 *   trusted-roots.json     — trusted-roots schema v1 claims (0600)
 *   managed-worktrees.json — future managed-worktrees schema v1 records (0600)
 *   trusted-roots.lock     — EXCLUSIVE LIFETIME host-dir lock (0600, pid+instanceId)
 *
 * Frozen architecture decisions (parent D3A-P0 mandate, preserved verbatim):
 *   1. STRICT single Host per host dir. `openHostStateDirectoryLease` acquires
 *      an exclusive lifetime lock from pre-listen until graceful `close()`.
 *      Any existing lock (live OR stale) fails startup with a fixed sanitized
 *      error. There is NO automatic stale-lock reclaim: SIGKILL leaves a stale
 *      lock and the next startup must fail closed without touching the state.
 *      An operator may explicitly remove the fixture lock after proving the
 *      old pid is dead. `close()` removes only its exact lock identity
 *      (dev/ino + instanceId); a wrong instance id can never unlock another
 *      Host's dir.
 *   2. Safe dedicated host dir only. Newly created dedicated leaf is created
 *      safely and set 0700 via fd. An existing directory is never chmod'd: it
 *      must be current-user owned (where supported), mode 0700, real
 *      non-symlink, and contain only the recognized Pix state-document/lock/
 *      temp layout. Filesystem root, home itself, shared tmp itself,
 *      repository/source trees and populated unrelated dirs are rejected
 *      BEFORE any mutation.
 *   3. A corrupt state document is immutable evidence. Missing ⇒ empty. Any
 *      corrupt / unknown-version / wrong-kind / duplicate / sparse /
 *      wrong-permission / hard-linked / unsafe document fails startup and every
 *      mutation with a fixed sanitized error; it is never rewritten,
 *      truncated, renamed or deleted (schema validation is delegated to each
 *      ledger adapter; the lease enforces the bounded file-safety half).
 *   4. Durability contract: temp same-dir O_EXCL|O_NOFOLLOW 0600 → write+fsync →
 *      identity verification → atomic rename → directory fsync. Directory fsync
 *      errors are FATAL except a narrowly enumerated truly-unsupported platform
 *      error set (EINVAL / ENOTSUP / EISDIR — see DIR_FSYNC_UNSUPPORTED_CODES);
 *      arbitrary errors are never swallowed. A returned success means the
 *      publish completed per this contract.
 *
 * The recognized layout policy deliberately already includes the future
 * `managed-worktrees.json` document and its temp pattern. This lets today's
 * trusted-roots adapter open a host dir that already contains the future
 * sidecar without treating it as unsafe — enabling rollback compatibility once
 * the sidecar exists. Unknown entries still fail closed.
 *
 * Logs never include raw JSON, stacks, claim paths, host paths or branch
 * names — fixed codes/counts only.
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { AsyncMutex } from "./mutex.js";

/** Canonical host-dir default segments (`~/.pi/pix/host`). */
export const DEFAULT_PIX_HOST_DIR_SEGMENTS = [".pi", "pix", "host"] as const;

/** Recognized host-owned state documents (the full layout policy). */
export const TRUSTED_ROOTS_STATE_DOCUMENT = "trusted-roots.json" as const;
export const MANAGED_WORKTREES_STATE_DOCUMENT = "managed-worktrees.json" as const;
export const DEFAULT_RECOGNIZED_DOCUMENTS = [
  TRUSTED_ROOTS_STATE_DOCUMENT,
  MANAGED_WORKTREES_STATE_DOCUMENT,
] as const;

/** Single canonical exclusive lifetime lock name for the host state dir. */
export const HOST_STATE_LOCK_NAME = "trusted-roots.lock" as const;

/** Fixed warning / error codes for the shared lease — never embed paths/raw payloads. */
export type HostStateDirectoryCode =
  | "HOST_DIR_INVALID"
  | "HOST_DIR_UNSAFE"
  | "LOCK_UNSAFE"
  | "LOCK_BUSY"
  | "LOCK_STALE"
  | "DOC_UNKNOWN"
  | "DOC_SYMLINK"
  | "DOC_NOT_REGULAR"
  | "DOC_UNREADABLE"
  | "DOC_OVERSIZE"
  | "DOC_PERMISSIONS"
  | "DOC_HARD_LINK"
  | "DOC_WRITE_FAILED"
  | "DOC_LOCK_LOST";

export class HostStateDirectoryError extends Error {
  readonly code: HostStateDirectoryCode;
  constructor(code: HostStateDirectoryCode, message: string) {
    super(message);
    this.name = "HostStateDirectoryError";
    this.code = code;
  }
}

/** Bounded read result for a recognized state document. */
export type LeaseDocumentReadResult = { content: string } | { missing: true };

/** Unlocked IO primitives handed to `withLock` callers (already inside the mutex). */
export interface HostStateDirectoryIo {
  readDocument(name: string): Promise<LeaseDocumentReadResult>;
  writeDocument(name: string, payload: string): Promise<void>;
}

export interface HostStateDirectoryLease {
  readonly hostDir: string;
  readonly lockPath: string;
  /**
   * Safe fail-closed bounded read of a recognized document. Missing ⇒
   * `{ missing: true }`; unsafe (symlink / non-regular / wrong-permission /
   * hard-linked / oversize / unreadable) ⇒ throws {@link HostStateDirectoryError}.
   * Runs under the shared in-process mutex.
   */
  readDocument(name: string): Promise<LeaseDocumentReadResult>;
  /**
   * Atomic replace of a recognized document under the held lifetime lock.
   * Deterministic JSON is the caller's responsibility (serialization happens in
   * the ledger adapter); the lease enforces size bounds, file safety, identity
   * re-verification and durability. Runs under the shared in-process mutex.
   */
  writeDocument(name: string, payload: string): Promise<void>;
  /**
   * In-process serialized critical section around custom work (shared mutex).
   * The operation receives {@link HostStateDirectoryIo} whose primitives are
   * ALREADY inside the mutex — callers must use `io.readDocument`/`io.writeDocument`
   * (never the public mutex-guarded methods) to avoid nested-acquisition deadlock.
   */
  withLock<T>(operation: (io: HostStateDirectoryIo) => Promise<T>): Promise<T>;
  /**
   * Release the exclusive lifetime host-dir lock. Removes only the exact lock
   * identity this lease created (dev/ino + instanceId). Idempotent; a lease
   * with a different instance id can never unlock this dir.
   */
  close(): Promise<void>;
}

export interface HostStateDirectoryLeaseOptions {
  hostDir: string;
  /**
   * Recognized state documents for the layout policy. Defaults to the full
   * Pix layout (trusted-roots + managed-worktrees) so any adapter can open a
   * host dir that already carries the other sidecar (rollback compatibility).
   * Unknown entries in an existing host dir still fail closed.
   */
  recognizedDocuments?: readonly string[];
  /** Upper bound on any single state document bytes (defaults to 1 MiB). */
  maxDocumentBytes?: number;
  /** Test hook: override pid liveness probe. */
  isPidAlive?: (pid: number) => boolean;
  /** Test hook: override instance id for lock ownership. */
  instanceId?: string;
  /** Test hook: throw to inject a temp-file fsync failure. */
  failTempFsync?: () => void;
  /** Test hook: throw to inject an atomic-rename failure. */
  failRename?: () => void;
  /** Test hook: throw to inject a directory-fsync failure. */
  failDirFsync?: () => void;
  /**
   * Called after host-dir validation but BEFORE the lifetime lock is acquired.
   * Lets a ledger adapter validate its own document (fail-closed) so a corrupt
   * state document fails startup without creating any lock file (immutable
   * evidence, no-touch). `readDocument` here reads without the lock (safe at
   * open time — no in-process concurrency exists yet).
   */
  validateBeforeLock?: (ctx: { readDocument(name: string): Promise<LeaseDocumentReadResult> }) => void | Promise<void>;
}

const MAX_STATE_DOCUMENT_BYTES = 1_048_576;

/**
 * Narrowly enumerated truly-unsupported directory-fsync error codes. These mean
 * "this OS/filesystem does not support fsync on a directory handle", never
 * "the durable write is lost" — so they are tolerated. Any other error (EIO,
 * EACCES, EROFS, ENOSPC, EMFILE, ENOMEM, ...) is FATAL and fails the publish.
 */
const DIR_FSYNC_UNSUPPORTED_CODES = new Set(["EINVAL", "ENOTSUP", "EISDIR"]);

// Shared pure validators used by the lease and both ledger adapters.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isValidInstanceId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 8
    && value.length <= 128
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function isAbsoluteCanonicalShape(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 4096
    && !value.includes("\0")
    && isAbsolute(value)
    && resolve(value) === value;
}

export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 10 || value.length > 64) return false;
  return Number.isFinite(Date.parse(value));
}

/** True when a string contains any C0 control character or DEL (metadata safety). */
export function hasControlChar(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Resolve Host data directory.
 * - unset ⇒ `~/.pi/pix/host`
 * - set ⇒ must be non-empty absolute path with no NUL (no ~ / relative resolve)
 */
export function resolvePixHostDir(
  raw: string | undefined,
  home: string = homedir(),
): string {
  if (raw === undefined) {
    if (!home || !isAbsolute(home) || home.includes("\0")) {
      throw new HostStateDirectoryError("HOST_DIR_INVALID", "Home directory is not absolute");
    }
    return resolve(join(home, ...DEFAULT_PIX_HOST_DIR_SEGMENTS));
  }
  if (raw === "" || raw.includes("\0") || !isAbsolute(raw)) {
    throw new HostStateDirectoryError(
      "HOST_DIR_INVALID",
      "PIX_HOST_DIR must be a non-empty absolute path",
    );
  }
  return resolve(raw);
}

/** True when `path` is a real existing directory (non-symlink). */
/** Reject repository/source trees: any ancestor (incl. hostDir) with a `.git` entry. */
async function isInsideRepository(path: string): Promise<boolean> {
  let current = resolve(path);
  for (;;) {
    try {
      await lstat(join(current, ".git"));
      return true;
    } catch {
      /* no .git at this level (or not a directory) */
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTempPatterns(documents: readonly string[]): RegExp[] {
  return documents.map(
    (name) => new RegExp(`^${escapeRegExp(name)}\\.\\d+\\.[0-9a-f-]{8,128}\\.tmp$`),
  );
}

/**
 * Ensure Host dir exists as a real non-symlink directory with mode 0700.
 *
 * Does not use mkdir({ recursive: true }) (which follows intermediate symlinks).
 * Walks every textual component of the absolute path from the root:
 * 1. Reserved destinations are rejected BEFORE any mutation: filesystem root,
 *    the user's home itself, shared tmp itself, and any repository/source tree.
 * 2. Build prefix segment-by-segment; lstat each existing prefix. Existing
 *    components must be non-symlink directories (a symlink at any depth is
 *    HOST_DIR_UNSAFE).
 * 3. On first ENOENT, create each remaining segment with mkdir(recursive:false);
 *    a newly created dedicated leaf is set to 0700 via fd-based fchmod (open the
 *    dir with O_RDONLY|O_NOFOLLOW, fchmod the opened handle — never path-chmod
 *    after a handle close, so a swapped-in symlink cannot be followed).
 * 4. An EXISTING final directory is NEVER chmod'd. It must be current-user owned
 *    (where supported), mode 0700, real non-symlink, and empty or contain only
 *    the recognized Pix state-document/lock/temp layout. A populated unrelated
 *    dir is rejected with no mode/content mutation.
 *
 * Residual (Node has no openat): TOCTOU between lstat and mkdir remains under a
 * hostile concurrent actor on a shared parent; the final fchmod acts on the
 * opened inode and the re-lstat/realpath after it fail closed on any swap.
 */
async function ensurePixHostDir(
  hostDir: string,
  recognizedEntries: ReadonlySet<string>,
  tempPatterns: readonly RegExp[],
): Promise<string> {
  const normalized = resolve(hostDir);
  if (!isAbsolute(normalized) || normalized.includes("\0")) {
    throw new HostStateDirectoryError("HOST_DIR_INVALID", "Host directory path is invalid");
  }
  if (normalized === "/") {
    throw new HostStateDirectoryError("HOST_DIR_INVALID", "Host directory must not be the filesystem root");
  }

  // Reserved destinations: home itself and shared tmp itself (never the leaf).
  const home = homedir();
  const tmp = tmpdir();
  for (const candidate of [home, tmp]) {
    if (!candidate || !isAbsolute(candidate) || candidate.includes("\0")) continue;
    let canonical: string;
    try {
      canonical = await realpath(candidate);
    } catch {
      canonical = resolve(candidate);
    }
    if (normalized === resolve(candidate) || normalized === canonical) {
      throw new HostStateDirectoryError("HOST_DIR_INVALID", "Host directory must not be a reserved shared directory");
    }
  }

  // Repository/source trees are not dedicated host dirs.
  if (await isInsideRepository(normalized)) {
    throw new HostStateDirectoryError("HOST_DIR_INVALID", "Host directory must not be inside a repository");
  }

  const segments = normalized === "/"
    ? []
    : normalized.slice(1).split("/").filter((segment) => segment.length > 0);
  for (const segment of segments) {
    if (
      segment === "."
      || segment === ".."
      || segment.includes("\0")
      || segment.includes("/")
    ) {
      throw new HostStateDirectoryError("HOST_DIR_UNSAFE", "Host directory path is unsafe");
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
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new HostStateDirectoryError("HOST_DIR_UNSAFE", "Host directory path is unsafe");
        }
        creating = true;
      }
      if (!creating) {
        // Existing component of the *original* absolute path: never a symlink.
        // Covers `parent/link/child` even when outside/child already exists
        // (lstat(hostDir) would see a directory via the link — we still reject).
        if (info!.isSymbolicLink() || !info!.isDirectory()) {
          throw new HostStateDirectoryError("HOST_DIR_UNSAFE", "Host directory path is unsafe");
        }
        continue;
      }
    }

    try {
      await mkdir(current, { recursive: false, mode: 0o700 });
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new HostStateDirectoryError("HOST_DIR_UNSAFE", "Host directory path is unsafe");
      }
    }
    let createdInfo;
    try {
      createdInfo = await lstat(current);
    } catch {
      throw new HostStateDirectoryError("HOST_DIR_UNSAFE", "Host directory path is unsafe");
    }
    if (createdInfo.isSymbolicLink() || !createdInfo.isDirectory()) {
      throw new HostStateDirectoryError("HOST_DIR_UNSAFE", "Host directory path is unsafe");
    }
    if (current === normalized) leafCreated = true;
  }

  let finalInfo;
  try {
    finalInfo = await lstat(current);
  } catch {
    throw new HostStateDirectoryError("HOST_DIR_UNSAFE", "Host directory path is unsafe");
  }
  if (finalInfo.isSymbolicLink() || !finalInfo.isDirectory()) {
    throw new HostStateDirectoryError("HOST_DIR_UNSAFE", "Host directory path is unsafe");
  }

  if (leafCreated) {
    // Newly created dedicated leaf: enforce 0700 via fd-based fchmod. O_NOFOLLOW
    // refuses a swapped-in symlink at open time (ELOOP → fail closed); fchmod
    // applies to the opened inode regardless of path swaps. No path chmod.
    let dirHandle;
    try {
      dirHandle = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        await dirHandle.chmod(0o700);
      } finally {
        await dirHandle.close();
      }
    } catch {
      throw new HostStateDirectoryError("HOST_DIR_UNSAFE", "Host directory path is unsafe");
    }
  } else {
    // Existing directory: NEVER chmod. Require current-user ownership where
    // supported, exact mode 0700, and only the recognized Pix
    // state-document/lock/temp layout — a populated unrelated dir is rejected
    // without mutation.
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (typeof finalInfo.uid === "number" && typeof uid === "number" && finalInfo.uid !== uid) {
      throw new HostStateDirectoryError("HOST_DIR_UNSAFE", "Host directory is owned by another user");
    }
    if ((finalInfo.mode & 0o777) !== 0o700) {
      throw new HostStateDirectoryError("HOST_DIR_UNSAFE", "Host directory mode must be 0700");
    }
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      throw new HostStateDirectoryError("HOST_DIR_UNSAFE", "Host directory is not readable");
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new HostStateDirectoryError("HOST_DIR_UNSAFE", "Host directory contains a symbolic link");
      }
      if (!recognizedEntries.has(entry.name) && !tempPatterns.some((pattern) => pattern.test(entry.name))) {
        throw new HostStateDirectoryError("HOST_DIR_UNSAFE", "Host directory is not a dedicated empty Pix directory");
      }
    }
  }

  // Final re-verify the leaf is still a real canonical non-symlink directory.
  let finalReal: string;
  try {
    finalReal = await realpath(current);
  } catch (error) {
    if (error instanceof HostStateDirectoryError) throw error;
    throw new HostStateDirectoryError("HOST_DIR_UNSAFE", "Host directory path is unsafe");
  }
  if (finalReal !== current) {
    throw new HostStateDirectoryError("HOST_DIR_UNSAFE", "Host directory path is unsafe");
  }
  return current;
}

function openFlags(): number {
  return constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
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

/**
 * Open the shared host-state-directory lease: validate/create the host dir,
 * (optionally) validate the caller's document before any lock is created, then
 * acquire the exclusive LIFETIME lock. The returned lease serializes every
 * document read/write through ONE in-process mutex and holds the lock until
 * {@link HostStateDirectoryLease.close} releases it.
 */
export async function openHostStateDirectoryLease(
  options: HostStateDirectoryLeaseOptions,
): Promise<HostStateDirectoryLease> {
  // Validate lock ownership metadata before creating or changing any filesystem
  // path. The same predicate is used when reading locks so an owner can never
  // create a lock that it subsequently considers malformed and cannot release.
  const instanceId = options.instanceId ?? randomUUID();
  if (!isValidInstanceId(instanceId)) {
    throw new HostStateDirectoryError("LOCK_UNSAFE", "Host directory lease instance id is invalid");
  }
  const recognizedDocuments = options.recognizedDocuments ?? DEFAULT_RECOGNIZED_DOCUMENTS;
  if (recognizedDocuments.length === 0) {
    throw new HostStateDirectoryError("LOCK_UNSAFE", "Host directory lease requires recognized documents");
  }
  const recognizedEntries = new Set<string>([...recognizedDocuments, HOST_STATE_LOCK_NAME]);
  const tempPatterns = buildTempPatterns(recognizedDocuments);
  const hostDir = await ensurePixHostDir(options.hostDir, recognizedEntries, tempPatterns);
  const lockPath = join(hostDir, HOST_STATE_LOCK_NAME);
  const maxDocumentBytes = options.maxDocumentBytes ?? MAX_STATE_DOCUMENT_BYTES;
  const isAlive = options.isPidAlive ?? pidAlive;
  const mutex = new AsyncMutex();

  async function readDocumentUnlocked(name: string): Promise<LeaseDocumentReadResult> {
    if (!recognizedEntries.has(name)) {
      throw new HostStateDirectoryError("DOC_UNKNOWN", "Unrecognized state document");
    }
    const path = join(hostDir, name);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { missing: true };
      }
      throw new HostStateDirectoryError("DOC_UNREADABLE", "State document is unreadable");
    }
    if (info.isSymbolicLink()) {
      throw new HostStateDirectoryError("DOC_SYMLINK", "State document must not be a symbolic link");
    }
    if (!info.isFile()) {
      throw new HostStateDirectoryError("DOC_NOT_REGULAR", "State document must be a regular file");
    }
    if (info.size > maxDocumentBytes) {
      throw new HostStateDirectoryError("DOC_OVERSIZE", "State document exceeds the size bound");
    }
    // Wrong permission: no group/other read/write access on the document.
    if ((info.mode & 0o077) !== 0) {
      throw new HostStateDirectoryError("DOC_PERMISSIONS", "State document permissions are unsafe");
    }
    // Hard-linked document: extra names could alias a file we must not rewrite.
    if (info.nlink > 1) {
      throw new HostStateDirectoryError("DOC_HARD_LINK", "State document must not be hard-linked");
    }
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      throw new HostStateDirectoryError("DOC_UNREADABLE", "State document is unreadable");
    }
    return { content: text };
  }

  async function writeDocumentUnlocked(name: string, payload: string): Promise<void> {
    if (!recognizedEntries.has(name)) {
      throw new HostStateDirectoryError("DOC_UNKNOWN", "Unrecognized state document");
    }
    if (Buffer.byteLength(payload, "utf8") > maxDocumentBytes) {
      throw new HostStateDirectoryError("DOC_OVERSIZE", "Serialized state document exceeds size bound");
    }
    const targetPath = join(hostDir, name);
    try {
      const existing = await lstat(targetPath);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new HostStateDirectoryError("DOC_NOT_REGULAR", "State document path is not a regular file");
      }
    } catch (error) {
      if (error instanceof HostStateDirectoryError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new HostStateDirectoryError("DOC_WRITE_FAILED", "State document path unsafe");
      }
    }
    const temp = join(hostDir, `${name}.${process.pid}.${randomUUID()}.tmp`);
    try {
      // Mode is set on the O_EXCL open handle (and reinforced via handle.chmod)
      // before close. Never path-chmod temp/document after close — a same-user
      // swap to a symlink would be followed by chmod(path).
      const handle = await open(temp, openFlags(), 0o600);
      let tempIdentity: { dev: number; ino: number };
      try {
        await handle.chmod(0o600);
        await handle.writeFile(payload, "utf8");
        options.failTempFsync?.();
        await handle.sync();
        const st = await handle.stat();
        tempIdentity = { dev: st.dev, ino: st.ino };
      } finally {
        await handle.close();
      }
      // Cross-process ownership re-verification immediately before publish: if
      // the lifetime lock was lost (external removal/replacement), abort
      // fail-closed instead of publishing under an unlocked dir.
      const currentLock = await lstatRegularFile(lockPath);
      if (!currentLock || currentLock.dev !== owned.dev || currentLock.ino !== owned.ino) {
        throw new HostStateDirectoryError("DOC_LOCK_LOST", "Host directory lock ownership lost before publish");
      }
      options.failRename?.();
      await rename(temp, targetPath);
      // rename preserves mode/identity; verify final is the same regular file.
      let published;
      try {
        published = await lstat(targetPath);
      } catch {
        throw new HostStateDirectoryError("DOC_WRITE_FAILED", "Atomic state document write failed");
      }
      if (
        published.isSymbolicLink()
        || !published.isFile()
        || published.dev !== tempIdentity.dev
        || published.ino !== tempIdentity.ino
      ) {
        throw new HostStateDirectoryError("DOC_WRITE_FAILED", "Published state document identity mismatch");
      }
      await fsyncDir();
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      if (error instanceof HostStateDirectoryError) throw error;
      throw new HostStateDirectoryError("DOC_WRITE_FAILED", "Atomic state document write failed");
    }
  }

  /**
   * Directory fsync after the atomic rename. FATAL on any error EXCEPT the
   * narrowly enumerated truly-unsupported platform set (EINVAL / ENOTSUP /
   * EISDIR) — those mean the OS/filesystem cannot fsync a directory handle, not
   * that the publish is lost. Arbitrary errors are never swallowed: a returned
   * success must mean the rename is durably on disk.
   */
  async function fsyncDir(): Promise<void> {
    try {
      options.failDirFsync?.();
      const handle = await open(hostDir, constants.O_RDONLY);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (typeof code === "string" && DIR_FSYNC_UNSUPPORTED_CODES.has(code)) {
        // Truly-unsupported platform/filesystem: tolerate (documented above).
        return;
      }
      throw new HostStateDirectoryError("DOC_WRITE_FAILED", "Directory fsync failed");
    }
  }

  interface LockRecord {
    pid: number;
    instanceId: string;
    createdAt: number;
  }

  async function readLock(): Promise<
    | { kind: "missing" }
    | { kind: "unsafe"; reason: HostStateDirectoryCode }
    | { kind: "valid"; record: LockRecord; identity: { dev: number; ino: number } }
  > {
    const identity = await lstatRegularFile(lockPath);
    if (identity === null) {
      try {
        const info = await lstat(lockPath);
        if (info.isSymbolicLink() || !info.isFile()) return { kind: "unsafe", reason: "LOCK_UNSAFE" };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
        return { kind: "unsafe", reason: "LOCK_UNSAFE" };
      }
      return { kind: "missing" };
    }
    let text: string;
    try {
      text = await readFile(lockPath, "utf8");
    } catch {
      return { kind: "unsafe", reason: "LOCK_UNSAFE" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { kind: "unsafe", reason: "LOCK_UNSAFE" };
    }
    if (!isRecord(parsed)) return { kind: "unsafe", reason: "LOCK_UNSAFE" };
    if (!isSafeInteger(parsed.pid) || parsed.pid <= 0) return { kind: "unsafe", reason: "LOCK_UNSAFE" };
    if (!isValidInstanceId(parsed.instanceId)) {
      return { kind: "unsafe", reason: "LOCK_UNSAFE" };
    }
    if (!isSafeInteger(parsed.createdAt)) return { kind: "unsafe", reason: "LOCK_UNSAFE" };
    return {
      kind: "valid",
      record: { pid: parsed.pid, instanceId: parsed.instanceId, createdAt: parsed.createdAt },
      identity: { dev: identity.dev, ino: identity.ino },
    };
  }

  interface LockOwnership { dev: number; ino: number }

  /**
   * Acquire the exclusive LIFETIME host-dir lock (O_EXCL). If any lock exists
   * — live (LOCK_BUSY) or stale/ambiguous (LOCK_STALE / LOCK_UNSAFE) — fail
   * closed with a fixed sanitized error. NEVER auto-reclaims a stale lock:
   * after SIGKILL the next startup fails closed and the operator must explicitly
   * remove the fixture lock after proving the old pid is dead.
   */
  async function acquireLifetimeLock(): Promise<LockOwnership> {
    const payload = `${JSON.stringify({ pid: process.pid, instanceId, createdAt: Date.now() })}\n`;
    try {
      // Mode via O_EXCL open + handle.chmod only; never path-chmod after close.
      const handle = await open(lockPath, openFlags(), 0o600);
      try {
        await handle.chmod(0o600);
        await handle.writeFile(payload, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      const owned = await lstatRegularFile(lockPath);
      if (!owned) {
        // Lock vanished immediately after O_EXCL create: cannot pin identity →
        // ambiguous → fail closed.
        throw new HostStateDirectoryError("LOCK_UNSAFE", "Host directory lock ownership could not be pinned");
      }
      return { dev: owned.dev, ino: owned.ino };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        if (error instanceof HostStateDirectoryError) throw error;
        throw new HostStateDirectoryError("LOCK_UNSAFE", "Could not create Host directory lock");
      }
      const existing = await readLock();
      if (existing.kind === "unsafe") {
        throw new HostStateDirectoryError("LOCK_UNSAFE", "Existing Host directory lock is unsafe");
      }
      if (existing.kind === "missing") {
        // Lock existed at O_EXCL but vanished before the read — ambiguous.
        throw new HostStateDirectoryError("LOCK_UNSAFE", "Host directory lock identity is ambiguous");
      }
      if (isAlive(existing.record.pid)) {
        throw new HostStateDirectoryError("LOCK_BUSY", "Another Host holds the Host directory lock");
      }
      throw new HostStateDirectoryError(
        "LOCK_STALE",
        "Host directory lock is stale; verify the old process is dead and remove the lock explicitly",
      );
    }
  }

  // Validate the caller's document BEFORE acquiring the lifetime lock: a
  // corrupt/unsafe state document must fail startup without creating any new
  // file (immutable evidence, no-touch).
  if (options.validateBeforeLock) {
    await options.validateBeforeLock({ readDocument: (name) => readDocumentUnlocked(name) });
  }

  const owned = await acquireLifetimeLock();
  let closed = false;

  // Unlocked IO primitives (must only be used inside the shared mutex).
  const io: HostStateDirectoryIo = {
    readDocument: (name) => readDocumentUnlocked(name),
    writeDocument: (name, payload) => writeDocumentUnlocked(name, payload),
  };

  return {
    hostDir,
    lockPath,
    async readDocument(name) {
      return mutex.runExclusive(() => readDocumentUnlocked(name));
    },
    async writeDocument(name, payload) {
      return mutex.runExclusive(() => writeDocumentUnlocked(name, payload));
    },
    async withLock(operation) {
      return mutex.runExclusive(() => operation(io));
    },
    async close() {
      return mutex.runExclusive(async () => {
        if (closed) return;
        closed = true;
        try {
          const current = await readLock();
          if (current.kind !== "valid") return;
          // Graceful shutdown removes only its exact lock identity: same
          // instanceId AND same dev/ino. A wrong instance cannot unlock.
          if (current.record.instanceId !== instanceId) return;
          if (current.identity.dev !== owned.dev || current.identity.ino !== owned.ino) return;
          await rm(lockPath, { force: true });
        } catch {
          /* lock already gone or replaced */
        }
      });
    },
  };
}
