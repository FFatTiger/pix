/**
 * @fffattiger/pix-local-authority — platform-neutral secure-state contracts.
 *
 * Slice 1 (POSIX host). These contracts describe the LOW-LEVEL secure-state
 * primitives the pix host-state lease actually needs:
 *
 *   1. canonical absolute paths  — nearest-existing-ancestor realpath with
 *      validated missing-component tail and a canonical component re-walk;
 *   2. stable platform identity / principal — POSIX dev/ino + uid/gid today,
 *      with a reserved native Windows SID/file-id contract for the future;
 *   3. secure directory + state-document publication — dedicated 0700 private
 *      dir, bounded fail-closed reads, temp same-dir O_EXCL → fsync → identity
 *      re-verification → atomic rename → directory fsync;
 *   4. exclusive lifetime-lock primitives — O_EXCL acquire with busy/stale/
 *      unsafe classification, identity-pinned read, and exact-owner release.
 *
 * The contracts deliberately do NOT know any Host ledger name, schema, layout,
 * document name, or error code: Host maps `LocalAuthorityError` codes to its own
 * fixed codes/messages. They are platform-neutral so a future native Windows
 * backend can satisfy the same `SecureStateBackend` interface; this slice ships
 * ONLY the POSIX implementation (`posix.ts`). No Protocol / Runtime Core / Pi
 * SDK / Hono / React dependency.
 */

/**
 * Fixed low-level error codes thrown by the POSIX backend. Never embed raw
 * paths, payloads, or os error text in the message (Host maps codes to its own
 * sanitized messages).
 */
export type LocalAuthorityCode =
  | "INVALID_PATH"        // empty / overlong / NUL / control chars / not absolute
  | "ROOT_PATH"           // filesystem root (or nothing exists above root)
  | "PARENT_ESCAPE"       // literal "." / ".." component (lexical parent escape)
  | "UNSAFE_COMPONENT"    // NUL / "/" embedded in a single component
  | "WINDOWS_PATH"        // drive-letter claim (C:\...) — unsupported
  | "NETWORK_PATH"        // network/UNC claim (//host/... or \\host\...) — unsupported
  | "UNSUPPORTED_PLATFORM" // selected platform has no secure native backend
  | "NOT_DIRECTORY"       // an existing path component is not a directory
  | "SYMLINK"             // an existing path component is a symbolic link
  | "NOT_OWNED"           // existing directory owned by another user
  | "NOT_PRIVATE"         // existing directory mode is not the required private mode
  | "NOT_REGULAR"         // state-document path is not a regular file
  | "DOC_SYMLINK"         // state document is a symbolic link
  | "DOC_UNREADABLE"      // state document cannot be read
  | "DOC_OVERSIZE"        // state document exceeds the byte bound
  | "DOC_PERMISSIONS"     // state document has group/other read/write bits
  | "DOC_HARD_LINK"       // state document is hard-linked (nlink > 1)
  | "WRITE_FAILED"        // atomic state-document write failed
  | "DIR_FSYNC_FAILED"    // directory fsync failed (unsupported codes are tolerated)
  | "LOCK_UNSAFE"         // existing lock is malformed / cannot be pinned / creation failed
  | "LOCK_BUSY"           // another live process holds the lock
  | "LOCK_STALE"          // lock belongs to a dead pid; never auto-reclaimed
  | "LOCK_LOST"           // held lock identity vanished before an atomic publish
  | "LOCK_AMBIGUOUS"      // lock existed at O_EXCL but vanished before identity pin
  | "ALREADY_EXISTS";     // exclusive create found an existing private file

export class LocalAuthorityError extends Error {
  readonly code: LocalAuthorityCode;
  constructor(code: LocalAuthorityCode, message: string) {
    super(message);
    this.name = "LocalAuthorityError";
    this.code = code;
  }
}

/** Stable lstat identity of a POSIX path (never names, never content). */
export interface PosixFileIdentity {
  readonly kind: "posix";
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  size: number;
  uid: number;
  gid: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

/** Reserved native Windows identity shape; no Windows backend ships yet. */
export interface WindowsFileIdentity {
  readonly kind: "windows";
  volumeSerial: string;
  fileId: string;
  /** Decimal byte size as a string; never a JS number. */
  size: string;
  ownerSid: string;
  isFile: boolean;
  isDirectory: boolean;
  isReparsePoint: boolean;
}

export type FileIdentity = PosixFileIdentity | WindowsFileIdentity;

/** Current process POSIX principal (uid/gid when exposed). */
export interface PosixPrincipal {
  readonly kind: "posix";
  uid: number | undefined;
  gid: number | undefined;
}

/** Reserved Windows principal shape; no Windows backend ships yet. */
export interface WindowsPrincipal {
  readonly kind: "windows";
  sid: string;
}

export type Principal = PosixPrincipal | WindowsPrincipal;

/** Bounded fail-closed state-document read result. Missing ⇒ `{ missing: true }`. */
export type StateDocumentReadResult = { content: string } | { missing: true };

/** Persisted exclusive lifetime-lock record (opaque pid/instance/createdAt). */
export interface LifetimeLockRecord {
  pid: number;
  instanceId: string;
  createdAt: number;
}

/** POSIX lock inode this handle created/owns. */
export interface PosixLifetimeLockOwnership {
  readonly kind: "posix";
  dev: number;
  ino: number;
}

/** Windows lock identity this handle created/owns. */
export interface WindowsLifetimeLockOwnership {
  readonly kind: "windows";
  volumeSerial: string;
  fileId: string;
}

export type LifetimeLockOwnership = PosixLifetimeLockOwnership | WindowsLifetimeLockOwnership;

export type LifetimeLockReadResult =
  | { kind: "missing" }
  | { kind: "unsafe"; reason: LocalAuthorityCode }
  | { kind: "valid"; record: LifetimeLockRecord; identity: LifetimeLockOwnership };

export interface EnsurePrivateDirectoryOptions {
  /** Existing leaf must be owned by the current user where supported (default true). */
  requireOwnedByCurrentUser?: boolean;
  /** Existing leaf exact mode (default 0o700). Never applied to an existing dir. */
  requireMode?: number;
  /** Host policy hook for an EXISTING leaf (entries allowlist). Throwing rejects. */
  validateExistingLeaf?: (ctx: { identity: FileIdentity; path: string }) => void | Promise<void>;
}

export interface EnsurePrivateDirectoryResult {
  /** The (canonical) private directory. */
  path: string;
  /** True when the final leaf was newly created (empty, 0700 via fd). */
  created: boolean;
  identity: FileIdentity;
}

export interface ReadStateDocumentOptions {
  /** Upper bound on the document bytes (fail-closed). */
  maxBytes: number;
}

export interface WriteStateDocumentOptions {
  maxBytes: number;
  /** Re-verify the exclusive lifetime-lock identity before the atomic publish. */
  lockCheck?: { path: string; ownership: LifetimeLockOwnership };
  /** Test-only fault-injection seam (never used in production). */
  inject?: {
    failTempFsync?: () => void;
    failRename?: () => void;
    failDirFsync?: () => void;
  };
}

export interface AcquireLifetimeLockOptions {
  /** Lock record to persist (JSON text; callers append a trailing newline). */
  payload: string;
  /** POSIX pid-liveness probe used for LOCK_BUSY vs LOCK_STALE classification. */
  isPidAlive: (pid: number) => boolean;
}

export interface ReleaseLifetimeLockOptions {
  /** The exact platform identity this handle created. */
  ownership: LifetimeLockOwnership;
  /** The lock record instanceId this handle owns. */
  instanceId: string;
}

export interface CreateExclusivePrivateFileOptions {
  maxBytes: number;
}

export interface ExclusivePrivateFile {
  identity: FileIdentity;
}

/**
 * The platform-neutral secure-state backend contract. The POSIX implementation
 * (`createPosixSecureStateBackend`) satisfies it today; a future native Windows
 * backend would satisfy the same interface.
 */
export type SecureStateBackendKind = "posix" | "windows";

interface SecureStateBackendBase {
  readonly kind: SecureStateBackendKind;
  /** Canonicalize an absolute path (nearest-existing-ancestor realpath + validated tail + canonical re-walk). */
  canonicalizePath(path: string): Promise<string>;
  /** Stable native identity, or null when the path is missing. */
  fileIdentity(path: string): Promise<FileIdentity | null>;
  /** Current process principal. */
  principal(): Principal;
  /** True when an identity is owned by the current process principal. */
  isOwnedByCurrentUser(identity: FileIdentity): boolean;
  /** Ensure a dedicated private directory exists (walk + create 0700 via fd; existing leaf validate-only). */
  ensurePrivateDirectory(path: string, options?: EnsurePrivateDirectoryOptions): Promise<EnsurePrivateDirectoryResult>;
  /** Bounded fail-closed state-document read. */
  readStateDocument(path: string, options: ReadStateDocumentOptions): Promise<StateDocumentReadResult>;
  /** Atomic durable state-document write (temp O_EXCL → fsync → identity → rename → dir fsync). */
  writeStateDocument(path: string, payload: string, options: WriteStateDocumentOptions): Promise<void>;
  /** Exclusive lifetime-lock acquire (O_EXCL). Classifies busy/stale/unsafe; no auto-reclaim. */
  acquireLifetimeLock(path: string, options: AcquireLifetimeLockOptions): Promise<LifetimeLockOwnership>;
  /** Read an existing lifetime lock (missing / unsafe / valid record + identity). */
  readLifetimeLock(path: string): Promise<LifetimeLockReadResult>;
  /** Release the lock only when record instanceId AND dev/ino match this handle. */
  releaseLifetimeLock(path: string, options: ReleaseLifetimeLockOptions): Promise<void>;
  /** Platform-native pid-liveness probe. */
  isPidAlive(pid: number): boolean;
  /** Exclusive no-replace private-file create (O_EXCL / CREATE_NEW). */
  createExclusivePrivateFile(path: string, payload: string, options: CreateExclusivePrivateFileOptions): Promise<ExclusivePrivateFile>;
}

export interface PosixSecureStateBackend extends SecureStateBackendBase {
  readonly kind: "posix";
  fileIdentity(path: string): Promise<PosixFileIdentity | null>;
  principal(): PosixPrincipal;
  isOwnedByCurrentUser(identity: PosixFileIdentity): boolean;
}

export interface WindowsSecureStateBackend extends SecureStateBackendBase {
  readonly kind: "windows";
  fileIdentity(path: string): Promise<WindowsFileIdentity | null>;
  principal(): WindowsPrincipal;
  isOwnedByCurrentUser(identity: WindowsFileIdentity): boolean;
}

export type SecureStateBackend = PosixSecureStateBackend | WindowsSecureStateBackend;

// ---------------------------------------------------------------------------
// Pure shared predicates (platform-neutral; Host ledgers re-export these).
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** True when a string contains any C0 control character or DEL (metadata safety). */
export function hasControlChar(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 10 || value.length > 64) return false;
  return Number.isFinite(Date.parse(value));
}

export function isValidInstanceId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 8
    && value.length <= 128
    && !hasControlChar(value);
}

/**
 * Pure shape predicate for a stored absolute canonical path: already
 * normalized (no "." / ".." / empty / trailing-slash / leading-double-slash
 * segments), bounded, no NUL. Equivalent to the old Host
 * `isAbsolute && resolve(value) === value` check without a path import, so it
 * stays platform-neutral.
 */
export function isAbsoluteCanonicalShape(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 4096
    || value.includes("\0")
  ) {
    return false;
  }
  if (!value.startsWith("/")) return false;
  // Filesystem root is a valid *shape* (matches the original
  // `isAbsolute && resolve(value) === value` semantics); the canonicalize and
  // secure-directory primitives reject roots operationally.
  if (value === "/") return true;
  if (value.startsWith("//") || value.endsWith("/")) return false;
  const segments = value.slice(1).split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return true;
}
