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
 * Slice 1 (secure-Windows-state): the LOW-LEVEL secure-state operations now
 * DELEGATE to the dependency-free infrastructure workspace
 * `@fffattiger/pix-local-authority/state` — canonical absolute paths
 * (nearest-existing-ancestor realpath, so the macOS `/var` → `/private/var`
 * system alias canonicalizes instead of false-rejecting), stable POSIX
 * identity/principal, secure private-directory + atomic durable document
 * publication, and exclusive lifetime locks. This module keeps the Host
 * orchestration: the recognized layout policy, the shared in-process mutex,
 * validate-before-lock ordering, and the fixed Host error codes/messages
 * (mapped from `LocalAuthorityError`, never leaking raw paths/os errors). Its
 * public/API/error/layout/byte semantics are unchanged.
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
import { lstat, realpath, readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  createPosixSecureStateBackend,
  LocalAuthorityError,
  isRecord,
  isSafeInteger,
  isIsoTimestamp,
  hasControlChar,
  isValidInstanceId,
  isAbsoluteCanonicalShape,
  type LocalAuthorityCode,
} from "@fffattiger/pix-local-authority/state";
import { AsyncMutex } from "./mutex.js";

// The Host ledgers consume these pure predicates through this module; they are
// implemented in the local-authority contracts and re-exported unchanged.
export {
  isRecord,
  isSafeInteger,
  isIsoTimestamp,
  hasControlChar,
  isValidInstanceId,
  isAbsoluteCanonicalShape,
};

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

/** Map a local-authority low-level code to the fixed Host lease code. */
const LOCAL_TO_HOST_CODES: Record<LocalAuthorityCode, HostStateDirectoryCode> = {
  INVALID_PATH: "HOST_DIR_INVALID",
  ROOT_PATH: "HOST_DIR_INVALID",
  PARENT_ESCAPE: "HOST_DIR_UNSAFE",
  UNSAFE_COMPONENT: "HOST_DIR_UNSAFE",
  WINDOWS_PATH: "HOST_DIR_INVALID",
  NETWORK_PATH: "HOST_DIR_INVALID",
  NOT_DIRECTORY: "HOST_DIR_UNSAFE",
  SYMLINK: "HOST_DIR_UNSAFE",
  NOT_OWNED: "HOST_DIR_UNSAFE",
  NOT_PRIVATE: "HOST_DIR_UNSAFE",
  NOT_REGULAR: "DOC_NOT_REGULAR",
  DOC_SYMLINK: "DOC_SYMLINK",
  DOC_UNREADABLE: "DOC_UNREADABLE",
  DOC_OVERSIZE: "DOC_OVERSIZE",
  DOC_PERMISSIONS: "DOC_PERMISSIONS",
  DOC_HARD_LINK: "DOC_HARD_LINK",
  WRITE_FAILED: "DOC_WRITE_FAILED",
  DIR_FSYNC_FAILED: "DOC_WRITE_FAILED",
  LOCK_UNSAFE: "LOCK_UNSAFE",
  LOCK_BUSY: "LOCK_BUSY",
  LOCK_STALE: "LOCK_STALE",
  LOCK_LOST: "DOC_LOCK_LOST",
  LOCK_AMBIGUOUS: "LOCK_UNSAFE",
};

/** Fixed Host messages for each local-authority code (never leak paths/payloads). */
const LOCAL_TO_HOST_MESSAGES: Record<LocalAuthorityCode, string> = {
  INVALID_PATH: "Host directory path is invalid",
  ROOT_PATH: "Host directory must not be the filesystem root",
  PARENT_ESCAPE: "Host directory path is unsafe",
  UNSAFE_COMPONENT: "Host directory path is unsafe",
  WINDOWS_PATH: "Host directory path is invalid",
  NETWORK_PATH: "Host directory path is invalid",
  NOT_DIRECTORY: "Host directory path is unsafe",
  SYMLINK: "Host directory path is unsafe",
  NOT_OWNED: "Host directory is owned by another user",
  NOT_PRIVATE: "Host directory mode must be 0700",
  NOT_REGULAR: "State document must be a regular file",
  DOC_SYMLINK: "State document must not be a symbolic link",
  DOC_UNREADABLE: "State document is unreadable",
  DOC_OVERSIZE: "State document exceeds the size bound",
  DOC_PERMISSIONS: "State document permissions are unsafe",
  DOC_HARD_LINK: "State document must not be hard-linked",
  WRITE_FAILED: "Atomic state document write failed",
  DIR_FSYNC_FAILED: "Atomic state document write failed",
  LOCK_UNSAFE: "Host directory lock is unsafe",
  LOCK_BUSY: "Another Host holds the Host directory lock",
  LOCK_STALE: "Host directory lock is stale; verify the old process is dead and remove the lock explicitly",
  LOCK_LOST: "Host directory lock ownership lost before publish",
  LOCK_AMBIGUOUS: "Host directory lock identity is ambiguous",
};

/** Convert a local-authority error into the fixed Host lease error; rethrow others. */
function toHostStateError(error: unknown): never {
  if (error instanceof HostStateDirectoryError) throw error;
  if (error instanceof LocalAuthorityError) {
    throw new HostStateDirectoryError(
      LOCAL_TO_HOST_CODES[error.code] ?? "HOST_DIR_UNSAFE",
      LOCAL_TO_HOST_MESSAGES[error.code] ?? "Host directory path is unsafe",
    );
  }
  // Defense in depth: an unexpected non-local-authority error (a raw fs error,
  // a throwing test hook, or a policy-callback bug) must NEVER leak a raw
  // path/os message across the Host boundary — map it to the fixed sanitized
  // code/message.
  throw new HostStateDirectoryError("HOST_DIR_UNSAFE", "Host directory path is unsafe");
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
 * Reject a hostDir whose ORIGINAL path contains a symlinked intermediate
 * component OTHER than a root-level canonical system alias (macOS
 * `/var` → `/private/var`, `/tmp`, `/etc`). The canonicalize primitive resolves
 * existing-prefix aliases generally; Host policy here keeps the frozen
 * "no symlinked intermediate components beyond canonical alias" invariant:
 * only a root-level system alias is accepted — a generic user symlink fails
 * closed before any mutation (nothing is created behind it).
 */
async function assertNoUnsafeIntermediateSymlink(original: string): Promise<void> {
  const normalized = resolve(original);
  const segments = normalized === "/"
    ? []
    : normalized.slice(1).split("/").filter((segment) => segment.length > 0);
  let current = "/";
  for (const segment of segments) {
    current = current === "/" ? `/${segment}` : `${current}/${segment}`;
    let info;
    try {
      info = await lstat(current);
    } catch {
      // Missing component: the creation zone starts here; remaining components
      // are created by the secure-directory walk. Nothing more to reject.
      return;
    }
    if (info.isDirectory() && !info.isSymbolicLink()) continue;
    if (info.isSymbolicLink()) {
      // Root-level canonical system alias (macOS /var → /private/var etc.):
      // accept only when it resolves to a real directory.
      if (dirname(current) === "/") {
        let target: string | undefined;
        try {
          target = await realpath(current);
        } catch {
          /* fall through to reject */
        }
        if (target && target !== current) {
          let targetInfo;
          try {
            targetInfo = await lstat(target);
          } catch {
            /* reject */
          }
          if (targetInfo && targetInfo.isDirectory() && !targetInfo.isSymbolicLink()) {
            continue;
          }
        }
      }
      throw new HostStateDirectoryError("HOST_DIR_UNSAFE", "Host directory path is unsafe");
    }
    throw new HostStateDirectoryError("HOST_DIR_UNSAFE", "Host directory path is unsafe");
  }
}

/**
 * Ensure Host dir exists as a real non-symlink directory with mode 0700.
 *
 * Delegates the low-level walk/create/validate to the local-authority POSIX
 * backend; Host keeps the policy: reserved destinations (filesystem root,
 * home itself, shared tmp itself) and repository/source trees are rejected
 * BEFORE any mutation, and an existing leaf must contain only the recognized
 * Pix state-document/lock/temp layout.
 *
 * The path is canonicalized FIRST via nearest-existing-ancestor realpath, so a
 * `PIX_HOST_DIR` under the macOS `/var` system alias canonicalizes to
 * `/private/var/...` instead of being false-rejected; the canonical result
 * never contains a symlinked intermediate component. An existing final
 * directory is NEVER chmod'd (validate-only: owner/exact 0700/entries).
 */
async function ensurePixHostDir(
  hostDir: string,
  recognizedEntries: ReadonlySet<string>,
  tempPatterns: readonly RegExp[],
  backend: ReturnType<typeof createPosixSecureStateBackend>,
): Promise<string> {
  try {
    const canonical = await backend.canonicalizePath(hostDir);

    // Strict original-path policy: generic user symlinks between the root and
    // the leaf are rejected BEFORE any mutation; only a root-level canonical
    // system alias (macOS /var → /private/var etc.) is accepted.
    await assertNoUnsafeIntermediateSymlink(hostDir);

    // Reserved destinations: home itself and shared tmp itself (never the leaf).
    const home = homedir();
    const tmp = tmpdir();
    for (const candidate of [home, tmp]) {
      if (!candidate || !isAbsolute(candidate) || candidate.includes("\0")) continue;
      let canonicalCandidate: string;
      try {
        canonicalCandidate = await realpath(candidate);
      } catch {
        canonicalCandidate = resolve(candidate);
      }
      if (canonical === resolve(candidate) || canonical === canonicalCandidate) {
        throw new HostStateDirectoryError("HOST_DIR_INVALID", "Host directory must not be a reserved shared directory");
      }
    }

    // Repository/source trees are not dedicated host dirs.
    if (await isInsideRepository(canonical)) {
      throw new HostStateDirectoryError("HOST_DIR_INVALID", "Host directory must not be inside a repository");
    }

    // Walk/create/validate via the backend; Host policy checks the existing
    // leaf contents (recognized entries + temp patterns, no symlinks).
    const result = await backend.ensurePrivateDirectory(canonical, {
      requireOwnedByCurrentUser: true,
      requireMode: 0o700,
      validateExistingLeaf: async ({ path: leafPath }) => {
        let entries;
        try {
          entries = await readdir(leafPath, { withFileTypes: true });
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
      },
    });
    return result.path;
  } catch (error) {
    toHostStateError(error);
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
  // Private backend injection seam: forwards the current fault-injection test
  // hooks into the POSIX atomic-write primitive (never used in production).
  const backend = createPosixSecureStateBackend(
    options.failTempFsync || options.failRename || options.failDirFsync
      ? {
          inject: {
            ...(options.failTempFsync ? { failTempFsync: options.failTempFsync } : {}),
            ...(options.failRename ? { failRename: options.failRename } : {}),
            ...(options.failDirFsync ? { failDirFsync: options.failDirFsync } : {}),
          },
        }
      : {},
  );
  const hostDir = await ensurePixHostDir(options.hostDir, recognizedEntries, tempPatterns, backend);
  const lockPath = join(hostDir, HOST_STATE_LOCK_NAME);
  const maxDocumentBytes = options.maxDocumentBytes ?? MAX_STATE_DOCUMENT_BYTES;
  const isAlive = options.isPidAlive ?? ((pid: number) => backend.isPidAlive(pid));
  const mutex = new AsyncMutex();

  async function readDocumentUnlocked(name: string): Promise<LeaseDocumentReadResult> {
    if (!recognizedEntries.has(name)) {
      throw new HostStateDirectoryError("DOC_UNKNOWN", "Unrecognized state document");
    }
    try {
      return await backend.readStateDocument(join(hostDir, name), { maxBytes: maxDocumentBytes });
    } catch (error) {
      toHostStateError(error);
    }
  }

  async function writeDocumentUnlocked(name: string, payload: string): Promise<void> {
    if (!recognizedEntries.has(name)) {
      throw new HostStateDirectoryError("DOC_UNKNOWN", "Unrecognized state document");
    }
    try {
      await backend.writeStateDocument(join(hostDir, name), payload, {
        maxBytes: maxDocumentBytes,
        lockCheck: { path: lockPath, ownership: owned },
      });
    } catch (error) {
      toHostStateError(error);
    }
  }

  async function acquireOwnedLock(): Promise<{ dev: number; ino: number }> {
    try {
      return await backend.acquireLifetimeLock(lockPath, {
        payload: `${JSON.stringify({ pid: process.pid, instanceId, createdAt: Date.now() })}\n`,
        isPidAlive: isAlive,
      });
    } catch (error) {
      toHostStateError(error);
    }
  }

  // Validate the caller's document BEFORE acquiring the lifetime lock: a
  // corrupt/unsafe state document must fail startup without creating any new
  // file (immutable evidence, no-touch).
  if (options.validateBeforeLock) {
    await options.validateBeforeLock({ readDocument: (name) => readDocumentUnlocked(name) });
  }

  const owned = await acquireOwnedLock();
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
          // Graceful shutdown removes only its exact lock identity: same
          // instanceId AND same dev/ino. A wrong instance cannot unlock.
          await backend.releaseLifetimeLock(lockPath, { ownership: owned, instanceId });
        } catch {
          /* lock already gone or replaced */
        }
      });
    },
  };
}
