/**
 * Host-owned durable trusted-roots ledger (D3A-P0).
 *
 * Authority remains AllowedRootService; this module only persists and reloads
 * Host-created trusted claims. Never scans Git to invent authorization.
 *
 * Layout (default `~/.pi/pix/host`, override via absolute `PIX_HOST_DIR`):
 *   trusted-roots.json   — schema v1 claims (0600, regular file, no symlink)
 *   trusted-roots.lock   — EXCLUSIVE LIFETIME Host-dir lock (0600, pid+instanceId)
 *
 * Frozen architecture decisions (parent D3A-P0 mandate):
 *   1. STRICT single Host per PIX_HOST_DIR. `openTrustedRootsLedger` acquires an
 *      exclusive lifetime lock from pre-listen until graceful `close()`. Any
 *      existing lock (live OR stale) fails startup with a fixed sanitized error.
 *      There is NO automatic stale-lock reclaim: SIGKILL leaves a stale lock and
 *      the next startup must fail closed without touching the ledger. An operator
 *      may explicitly remove the fixture lock after proving the old pid is dead.
 *      `close()` removes only its exact lock identity (dev/ino + instanceId); a
 *      wrong instance id can never unlock another Host's dir.
 *   2. Safe dedicated PIX_HOST_DIR only. Newly created dedicated leaf is created
 *      safely and set 0700 via fd. An existing directory is never chmod'd: it
 *      must be current-user owned (where supported), mode 0700, real non-symlink,
 *      and contain only the recognized Pix ledger/lock/temp layout. Filesystem
 *      root, home itself, shared tmp itself, repository/source trees and
 *      populated unrelated dirs are rejected BEFORE any mutation.
 *   3. A corrupt ledger is immutable evidence. Missing ledger ⇒ empty. Any
 *      corrupt / unknown-version / wrong-kind / duplicate / sparse /
 *      wrong-permission / hard-linked / unsafe ledger fails startup and every
 *      mutation with a fixed sanitized error; it is never rewritten, truncated,
 *      renamed or deleted. Tests assert bytes and inode are unchanged.
 *   4. Durability contract: temp same-dir O_EXCL|O_NOFOLLOW 0600 → write+fsync →
 *      identity verification → atomic rename → directory fsync. Directory fsync
 *      errors are FATAL except a narrowly enumerated truly-unsupported platform
 *      error set (EINVAL / ENOTSUP / EISDIR — see DIR_FSYNC_UNSUPPORTED_CODES);
 *      arbitrary errors are never swallowed. A returned success/201 means the
 *      publish completed per this contract.
 *
 * Logs never include raw JSON, stacks, claim paths, host paths or branch names —
 * fixed codes/counts only.
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

export const TRUSTED_ROOTS_KIND = "pix.host.trusted-roots" as const;
export const TRUSTED_ROOTS_VERSION = 1 as const;
export const TRUSTED_ROOTS_SOURCE = "worktree.create" as const;
export const DEFAULT_PIX_HOST_DIR_SEGMENTS = [".pi", "pix", "host"] as const;

export const LEDGER_FILE_NAME = "trusted-roots.json";
export const LEDGER_LOCK_NAME = "trusted-roots.lock";

/** Fixed warning / error codes — never embed paths or raw payloads. */
export type TrustedRootsLedgerCode =
  | "LEDGER_MISSING"
  | "LEDGER_SYMLINK"
  | "LEDGER_NOT_REGULAR"
  | "LEDGER_UNREADABLE"
  | "LEDGER_CORRUPT"
  | "LEDGER_UNKNOWN_VERSION"
  | "LEDGER_WRONG_KIND"
  | "LEDGER_OVERSIZE"
  | "LEDGER_DUPLICATE"
  | "LEDGER_SPARSE"
  | "LEDGER_PERMISSIONS"
  | "LEDGER_HARD_LINK"
  | "LEDGER_WRITE_FAILED"
  | "LEDGER_LOCK_BUSY"
  | "LEDGER_LOCK_STALE"
  | "LEDGER_LOCK_UNSAFE"
  | "HOST_DIR_UNSAFE"
  | "HOST_DIR_INVALID";

export class TrustedRootsLedgerError extends Error {
  readonly code: TrustedRootsLedgerCode;
  constructor(code: TrustedRootsLedgerCode, message: string) {
    super(message);
    this.name = "TrustedRootsLedgerError";
    this.code = code;
  }
}

export interface TrustedRootClaimRecord {
  claimId: string;
  path: string;
  dev: number;
  ino: number;
  repoRoot: string;
  repoDev: number;
  repoIno: number;
  base: string;
  createdAt: string;
  source: typeof TRUSTED_ROOTS_SOURCE;
  /** Metadata only — never used to rebuild paths. */
  branch?: string;
}

export interface TrustedRootsLedgerDocument {
  kind: typeof TRUSTED_ROOTS_KIND;
  version: typeof TRUSTED_ROOTS_VERSION;
  claims: TrustedRootClaimRecord[];
}

export interface TrustedRootsReadResult {
  claims: TrustedRootClaimRecord[];
  /**
   * Present only for a missing ledger (empty). Every other invalid condition
   * throws {@link TrustedRootsLedgerError} instead — a corrupt ledger is
   * immutable evidence and must fail startup/mutations closed.
   */
  warning?: "LEDGER_MISSING";
}

/** Pure parse result used by {@link parseTrustedRootsDocument}. */
export interface TrustedRootsParseResult {
  claims: TrustedRootClaimRecord[];
  /** Present when the on-disk document was rejected. */
  warning?: TrustedRootsLedgerCode;
  /** Sanitized count of claims that were dropped during parse (duplicates/sparse). */
  dropped?: number;
}

export interface TrustedRootsLedger {
  readonly hostDir: string;
  readonly ledgerPath: string;
  readonly lockPath: string;
  /** Safe fail-closed read. Missing ⇒ empty; corrupt/unsafe ⇒ throws. */
  read(): Promise<TrustedRootsReadResult>;
  /**
   * Atomic replace of the full claim set under the held lifetime lock.
   * Deterministic JSON. Refuses symlink/non-regular ledger path.
   */
  writeAll(claims: readonly TrustedRootClaimRecord[]): Promise<void>;
  /**
   * Read (fail-closed) → pure mutator → atomic write. Returns the claims that
   * were written. Corrupt/unsafe ledger ⇒ throws without touching it.
   */
  update(
    mutator: (claims: TrustedRootClaimRecord[]) => TrustedRootClaimRecord[] | Promise<TrustedRootClaimRecord[]>,
  ): Promise<TrustedRootClaimRecord[]>;
  /** In-process serialized critical section around custom work. */
  withLock<T>(operation: () => Promise<T>): Promise<T>;
  /**
   * Release the exclusive lifetime Host-dir lock. Removes only the exact lock
   * identity this handle created (dev/ino + instanceId). Idempotent; a handle
   * with a different instance id can never unlock this dir.
   */
  close(): Promise<void>;
}

export interface OpenTrustedRootsLedgerOptions {
  hostDir: string;
  /** Upper bound on claim count accepted from disk (defaults to 128). */
  maxClaims?: number;
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
}

const MAX_LEDGER_BYTES = 1_048_576;
const MAX_CLAIMS_HARD = 1_024;

/**
 * Narrowly enumerated truly-unsupported directory-fsync error codes. These mean
 * "this OS/filesystem does not support fsync on a directory handle", never
 * "the durable write is lost" — so they are tolerated. Any other error (EIO,
 * EACCES, EROFS, ENOSPC, EMFILE, ENOMEM, ...) is FATAL and fails the publish.
 */
const DIR_FSYNC_UNSUPPORTED_CODES = new Set(["EINVAL", "ENOTSUP", "EISDIR"]);

/** Recognized entries allowed inside an existing PIX_HOST_DIR (ledger/lock/temp). */
const RECOGNIZED_HOST_ENTRIES = new Set([LEDGER_FILE_NAME, LEDGER_LOCK_NAME]);
const HOST_TEMP_ENTRY = /^trusted-roots\.json\.\d+\.[0-9a-f-]{8,128}\.tmp$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isValidInstanceId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 8
    && value.length <= 128
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isAbsoluteCanonicalShape(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 4096
    && !value.includes("\0")
    && isAbsolute(value)
    && resolve(value) === value;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 10 || value.length > 64) return false;
  return Number.isFinite(Date.parse(value));
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
      throw new TrustedRootsLedgerError("HOST_DIR_INVALID", "Home directory is not absolute");
    }
    return resolve(join(home, ...DEFAULT_PIX_HOST_DIR_SEGMENTS));
  }
  if (raw === "" || raw.includes("\0") || !isAbsolute(raw)) {
    throw new TrustedRootsLedgerError(
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
 *    the recognized Pix ledger/lock/temp layout. A populated unrelated dir is
 *    rejected with no mode/content mutation.
 *
 * Residual (Node has no openat): TOCTOU between lstat and mkdir remains under a
 * hostile concurrent actor on a shared parent; the final fchmod acts on the
 * opened inode and the re-lstat/realpath after it fail closed on any swap.
 */
export async function ensurePixHostDir(hostDir: string): Promise<string> {
  const normalized = resolve(hostDir);
  if (!isAbsolute(normalized) || normalized.includes("\0")) {
    throw new TrustedRootsLedgerError("HOST_DIR_INVALID", "Host directory path is invalid");
  }
  if (normalized === "/") {
    throw new TrustedRootsLedgerError("HOST_DIR_INVALID", "Host directory must not be the filesystem root");
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
      throw new TrustedRootsLedgerError("HOST_DIR_INVALID", "Host directory must not be a reserved shared directory");
    }
  }

  // Repository/source trees are not dedicated host dirs.
  if (await isInsideRepository(normalized)) {
    throw new TrustedRootsLedgerError("HOST_DIR_INVALID", "Host directory must not be inside a repository");
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
      throw new TrustedRootsLedgerError("HOST_DIR_UNSAFE", "Host directory path is unsafe");
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
          throw new TrustedRootsLedgerError("HOST_DIR_UNSAFE", "Host directory path is unsafe");
        }
        creating = true;
      }
      if (!creating) {
        // Existing component of the *original* absolute path: never a symlink.
        // Covers `parent/link/child` even when outside/child already exists
        // (lstat(hostDir) would see a directory via the link — we still reject).
        if (info!.isSymbolicLink() || !info!.isDirectory()) {
          throw new TrustedRootsLedgerError("HOST_DIR_UNSAFE", "Host directory path is unsafe");
        }
        continue;
      }
    }

    try {
      await mkdir(current, { recursive: false, mode: 0o700 });
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new TrustedRootsLedgerError("HOST_DIR_UNSAFE", "Host directory path is unsafe");
      }
    }
    let createdInfo;
    try {
      createdInfo = await lstat(current);
    } catch {
      throw new TrustedRootsLedgerError("HOST_DIR_UNSAFE", "Host directory path is unsafe");
    }
    if (createdInfo.isSymbolicLink() || !createdInfo.isDirectory()) {
      throw new TrustedRootsLedgerError("HOST_DIR_UNSAFE", "Host directory path is unsafe");
    }
    if (current === normalized) leafCreated = true;
  }

  let finalInfo;
  try {
    finalInfo = await lstat(current);
  } catch {
    throw new TrustedRootsLedgerError("HOST_DIR_UNSAFE", "Host directory path is unsafe");
  }
  if (finalInfo.isSymbolicLink() || !finalInfo.isDirectory()) {
    throw new TrustedRootsLedgerError("HOST_DIR_UNSAFE", "Host directory path is unsafe");
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
      throw new TrustedRootsLedgerError("HOST_DIR_UNSAFE", "Host directory path is unsafe");
    }
  } else {
    // Existing directory: NEVER chmod. Require current-user ownership where
    // supported, exact mode 0700, and only recognized Pix ledger/lock/temp
    // layout — a populated unrelated dir is rejected without mutation.
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (typeof finalInfo.uid === "number" && typeof uid === "number" && finalInfo.uid !== uid) {
      throw new TrustedRootsLedgerError("HOST_DIR_UNSAFE", "Host directory is owned by another user");
    }
    if ((finalInfo.mode & 0o777) !== 0o700) {
      throw new TrustedRootsLedgerError("HOST_DIR_UNSAFE", "Host directory mode must be 0700");
    }
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      throw new TrustedRootsLedgerError("HOST_DIR_UNSAFE", "Host directory is not readable");
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new TrustedRootsLedgerError("HOST_DIR_UNSAFE", "Host directory contains a symbolic link");
      }
      if (!RECOGNIZED_HOST_ENTRIES.has(entry.name) && !HOST_TEMP_ENTRY.test(entry.name)) {
        throw new TrustedRootsLedgerError("HOST_DIR_UNSAFE", "Host directory is not a dedicated empty Pix directory");
      }
    }
  }

  // Final re-verify the leaf is still a real canonical non-symlink directory.
  let finalReal: string;
  try {
    finalReal = await realpath(current);
  } catch (error) {
    if (error instanceof TrustedRootsLedgerError) throw error;
    throw new TrustedRootsLedgerError("HOST_DIR_UNSAFE", "Host directory path is unsafe");
  }
  if (finalReal !== current) {
    throw new TrustedRootsLedgerError("HOST_DIR_UNSAFE", "Host directory path is unsafe");
  }
  return current;
}

function openFlags(): number {
  return constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
}

async function lstatRegularFile(path: string): Promise<{ dev: number; ino: number; size: number } | null> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) return null;
    return { dev: info.dev, ino: info.ino, size: info.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Deterministic, bounded JSON serialization (sorted claimIds, stable key order). */
export function serializeTrustedRootsDocument(claims: readonly TrustedRootClaimRecord[]): string {
  const sorted = [...claims].sort((a, b) => a.claimId.localeCompare(b.claimId) || a.path.localeCompare(b.path));
  const body: TrustedRootsLedgerDocument = {
    kind: TRUSTED_ROOTS_KIND,
    version: TRUSTED_ROOTS_VERSION,
    claims: sorted.map((claim) => {
      const entry: TrustedRootClaimRecord = {
        claimId: claim.claimId,
        path: claim.path,
        dev: claim.dev,
        ino: claim.ino,
        repoRoot: claim.repoRoot,
        repoDev: claim.repoDev,
        repoIno: claim.repoIno,
        base: claim.base,
        createdAt: claim.createdAt,
        source: TRUSTED_ROOTS_SOURCE,
      };
      if (claim.branch !== undefined) entry.branch = claim.branch;
      return entry;
    }),
  };
  return `${JSON.stringify(body)}\n`;
}

function parseClaim(
  raw: unknown,
  maxClaims: number,
  seen: Set<string>,
): TrustedRootClaimRecord | "sparse" | "duplicate" {
  if (!isRecord(raw)) return "sparse";
  const claimId = raw.claimId;
  const path = raw.path;
  const repoRoot = raw.repoRoot;
  const base = raw.base;
  const createdAt = raw.createdAt;
  const source = raw.source;
  if (typeof claimId !== "string" || claimId.length < 8 || claimId.length > 128 || claimId.includes("\0")) return "sparse";
  if (!isAbsoluteCanonicalShape(path)) return "sparse";
  if (!isAbsoluteCanonicalShape(repoRoot)) return "sparse";
  if (!isAbsoluteCanonicalShape(base)) return "sparse";
  if (!isSafeInteger(raw.dev) || !isSafeInteger(raw.ino)) return "sparse";
  if (!isSafeInteger(raw.repoDev) || !isSafeInteger(raw.repoIno)) return "sparse";
  if (!isIsoTimestamp(createdAt)) return "sparse";
  if (source !== TRUSTED_ROOTS_SOURCE) return "sparse";
  if (seen.has(claimId) || seen.has(`path:${path}`)) return "duplicate";
  if (seen.size / 2 >= maxClaims) return "sparse";
  let branch: string | undefined;
  if (raw.branch !== undefined) {
    if (typeof raw.branch !== "string" || raw.branch.length === 0 || raw.branch.length > 255 || raw.branch.includes("\0")) {
      return "sparse";
    }
    branch = raw.branch;
  }
  const allowed = new Set([
    "claimId", "path", "dev", "ino", "repoRoot", "repoDev", "repoIno", "base", "createdAt", "source", "branch",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) return "sparse";
  }
  seen.add(claimId);
  seen.add(`path:${path}`);
  const record: TrustedRootClaimRecord = {
    claimId,
    path,
    dev: raw.dev,
    ino: raw.ino,
    repoRoot,
    repoDev: raw.repoDev,
    repoIno: raw.repoIno,
    base,
    createdAt,
    source: TRUSTED_ROOTS_SOURCE,
  };
  if (branch !== undefined) record.branch = branch;
  return record;
}

/**
 * Pure parse of a ledger document (bounded). Returns a `warning` code instead
 * of throwing so callers can classify; the ledger {@link read} path converts
 * every warning except LEDGER_MISSING into a hard {@link TrustedRootsLedgerError}.
 */
export function parseTrustedRootsDocument(
  text: string,
  maxClaims: number,
): TrustedRootsParseResult {
  if (text.length > MAX_LEDGER_BYTES) {
    return { claims: [], warning: "LEDGER_OVERSIZE" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { claims: [], warning: "LEDGER_CORRUPT" };
  }
  if (!isRecord(parsed)) return { claims: [], warning: "LEDGER_CORRUPT" };
  if (parsed.kind !== TRUSTED_ROOTS_KIND) return { claims: [], warning: "LEDGER_WRONG_KIND" };
  if (parsed.version !== TRUSTED_ROOTS_VERSION) return { claims: [], warning: "LEDGER_UNKNOWN_VERSION" };
  if (!Array.isArray(parsed.claims)) return { claims: [], warning: "LEDGER_CORRUPT" };
  if (parsed.claims.length > Math.min(maxClaims, MAX_CLAIMS_HARD)) {
    return { claims: [], warning: "LEDGER_OVERSIZE" };
  }
  for (const key of Object.keys(parsed)) {
    if (key !== "kind" && key !== "version" && key !== "claims") {
      return { claims: [], warning: "LEDGER_CORRUPT" };
    }
  }
  const claims: TrustedRootClaimRecord[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  let sparse = false;
  let duplicate = false;
  for (const entry of parsed.claims) {
    const result = parseClaim(entry, maxClaims, seen);
    if (result === "sparse") {
      sparse = true;
      dropped += 1;
      continue;
    }
    if (result === "duplicate") {
      duplicate = true;
      dropped += 1;
      continue;
    }
    claims.push(result);
  }
  // Partial/sparse/duplicate ledgers fail closed entirely.
  if (sparse || duplicate || dropped > 0) {
    return {
      claims: [],
      warning: duplicate ? "LEDGER_DUPLICATE" : "LEDGER_SPARSE",
      dropped,
    };
  }
  return { claims };
}

export async function openTrustedRootsLedger(
  options: OpenTrustedRootsLedgerOptions,
): Promise<TrustedRootsLedger> {
  // Validate lock ownership metadata before creating or changing any filesystem
  // path. The same predicate is used when reading locks so an owner can never
  // create a lock that it subsequently considers malformed and cannot release.
  const instanceId = options.instanceId ?? randomUUID();
  if (!isValidInstanceId(instanceId)) {
    throw new TrustedRootsLedgerError("LEDGER_LOCK_UNSAFE", "Ledger instance id is invalid");
  }
  const hostDir = await ensurePixHostDir(options.hostDir);
  const ledgerPath = join(hostDir, LEDGER_FILE_NAME);
  const lockPath = join(hostDir, LEDGER_LOCK_NAME);
  const maxClaims = options.maxClaims ?? 128;
  if (!Number.isInteger(maxClaims) || maxClaims < 1 || maxClaims > MAX_CLAIMS_HARD) {
    throw new TrustedRootsLedgerError("LEDGER_OVERSIZE", "maxClaims out of bounds");
  }
  const isAlive = options.isPidAlive ?? pidAlive;
  const mutex = new AsyncMutex();

  /**
   * Read + validate the on-disk ledger. Missing ⇒ empty. Every other invalid
   * condition (corrupt/unknown-version/wrong-kind/duplicate/sparse/oversize/
   * wrong-permission/hard-link/symlink/non-regular/unreadable) THROWS a fixed
   * sanitized error and never rewrites/truncates/renames/deletes the file.
   */
  async function readUnlocked(): Promise<TrustedRootsReadResult> {
    let info;
    try {
      info = await lstat(ledgerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { claims: [], warning: "LEDGER_MISSING" };
      }
      throw new TrustedRootsLedgerError("LEDGER_UNREADABLE", "Trusted-roots ledger is unreadable");
    }
    if (info.isSymbolicLink()) {
      throw new TrustedRootsLedgerError("LEDGER_SYMLINK", "Trusted-roots ledger must not be a symbolic link");
    }
    if (!info.isFile()) {
      throw new TrustedRootsLedgerError("LEDGER_NOT_REGULAR", "Trusted-roots ledger must be a regular file");
    }
    if (info.size > MAX_LEDGER_BYTES) {
      throw new TrustedRootsLedgerError("LEDGER_OVERSIZE", "Trusted-roots ledger exceeds the size bound");
    }
    // Wrong permission: no group/other read/write access on the ledger.
    if ((info.mode & 0o077) !== 0) {
      throw new TrustedRootsLedgerError("LEDGER_PERMISSIONS", "Trusted-roots ledger permissions are unsafe");
    }
    // Hard-linked ledger: extra names could alias a file we must not rewrite.
    if (info.nlink > 1) {
      throw new TrustedRootsLedgerError("LEDGER_HARD_LINK", "Trusted-roots ledger must not be hard-linked");
    }
    let text: string;
    try {
      text = await readFile(ledgerPath, "utf8");
    } catch {
      throw new TrustedRootsLedgerError("LEDGER_UNREADABLE", "Trusted-roots ledger is unreadable");
    }
    const parsed = parseTrustedRootsDocument(text, maxClaims);
    if (parsed.warning) {
      throw new TrustedRootsLedgerError(parsed.warning, "Trusted-roots ledger failed validation");
    }
    return { claims: parsed.claims };
  }

  async function writeAllUnlocked(
    claims: readonly TrustedRootClaimRecord[],
  ): Promise<void> {
    if (claims.length > maxClaims) {
      throw new TrustedRootsLedgerError("LEDGER_OVERSIZE", "Claim set exceeds maxClaims");
    }
    try {
      const existing = await lstat(ledgerPath);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new TrustedRootsLedgerError("LEDGER_NOT_REGULAR", "Ledger path is not a regular file");
      }
    } catch (error) {
      if (error instanceof TrustedRootsLedgerError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new TrustedRootsLedgerError("LEDGER_WRITE_FAILED", "Ledger path unsafe");
      }
    }
    const payload = serializeTrustedRootsDocument(claims);
    if (Buffer.byteLength(payload, "utf8") > MAX_LEDGER_BYTES) {
      throw new TrustedRootsLedgerError("LEDGER_OVERSIZE", "Serialized ledger exceeds size bound");
    }
    const temp = join(hostDir, `${LEDGER_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
    try {
      // Mode is set on the O_EXCL open handle (and reinforced via handle.chmod)
      // before close. Never path-chmod temp/ledger after close — a same-user
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
        throw new TrustedRootsLedgerError("LEDGER_LOCK_UNSAFE", "Ledger lock ownership lost before publish");
      }
      options.failRename?.();
      await rename(temp, ledgerPath);
      // rename preserves mode/identity; verify final is the same regular file.
      let published;
      try {
        published = await lstat(ledgerPath);
      } catch {
        throw new TrustedRootsLedgerError("LEDGER_WRITE_FAILED", "Atomic ledger write failed");
      }
      if (
        published.isSymbolicLink()
        || !published.isFile()
        || published.dev !== tempIdentity.dev
        || published.ino !== tempIdentity.ino
      ) {
        throw new TrustedRootsLedgerError("LEDGER_WRITE_FAILED", "Published ledger identity mismatch");
      }
      await fsyncDir();
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      if (error instanceof TrustedRootsLedgerError) throw error;
      throw new TrustedRootsLedgerError("LEDGER_WRITE_FAILED", "Atomic ledger write failed");
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
      throw new TrustedRootsLedgerError("LEDGER_WRITE_FAILED", "Directory fsync failed");
    }
  }

  interface LockRecord {
    pid: number;
    instanceId: string;
    createdAt: number;
  }

  async function readLock(): Promise<
    | { kind: "missing" }
    | { kind: "unsafe"; reason: TrustedRootsLedgerCode }
    | { kind: "valid"; record: LockRecord; identity: { dev: number; ino: number } }
  > {
    const identity = await lstatRegularFile(lockPath);
    if (identity === null) {
      try {
        const info = await lstat(lockPath);
        if (info.isSymbolicLink() || !info.isFile()) return { kind: "unsafe", reason: "LEDGER_LOCK_UNSAFE" };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
        return { kind: "unsafe", reason: "LEDGER_LOCK_UNSAFE" };
      }
      return { kind: "missing" };
    }
    let text: string;
    try {
      text = await readFile(lockPath, "utf8");
    } catch {
      return { kind: "unsafe", reason: "LEDGER_LOCK_UNSAFE" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { kind: "unsafe", reason: "LEDGER_LOCK_UNSAFE" };
    }
    if (!isRecord(parsed)) return { kind: "unsafe", reason: "LEDGER_LOCK_UNSAFE" };
    if (!isSafeInteger(parsed.pid) || parsed.pid <= 0) return { kind: "unsafe", reason: "LEDGER_LOCK_UNSAFE" };
    if (!isValidInstanceId(parsed.instanceId)) {
      return { kind: "unsafe", reason: "LEDGER_LOCK_UNSAFE" };
    }
    if (!isSafeInteger(parsed.createdAt)) return { kind: "unsafe", reason: "LEDGER_LOCK_UNSAFE" };
    return {
      kind: "valid",
      record: { pid: parsed.pid, instanceId: parsed.instanceId, createdAt: parsed.createdAt },
      identity: { dev: identity.dev, ino: identity.ino },
    };
  }

  interface LockOwnership { dev: number; ino: number }

  /**
   * Acquire the exclusive LIFETIME Host-dir lock (O_EXCL). If any lock exists
   * — live (LEDGER_LOCK_BUSY) or stale/ambiguous (LEDGER_LOCK_STALE / UNSAFE) —
   * fail closed with a fixed sanitized error. NEVER auto-reclaims a stale lock:
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
        throw new TrustedRootsLedgerError("LEDGER_LOCK_UNSAFE", "Ledger lock ownership could not be pinned");
      }
      return { dev: owned.dev, ino: owned.ino };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        if (error instanceof TrustedRootsLedgerError) throw error;
        throw new TrustedRootsLedgerError("LEDGER_LOCK_UNSAFE", "Could not create Host directory lock");
      }
      const existing = await readLock();
      if (existing.kind === "unsafe") {
        throw new TrustedRootsLedgerError("LEDGER_LOCK_UNSAFE", "Existing Host directory lock is unsafe");
      }
      if (existing.kind === "missing") {
        // Lock existed at O_EXCL but vanished before the read — ambiguous.
        throw new TrustedRootsLedgerError("LEDGER_LOCK_UNSAFE", "Host directory lock identity is ambiguous");
      }
      if (isAlive(existing.record.pid)) {
        throw new TrustedRootsLedgerError("LEDGER_LOCK_BUSY", "Another Host holds the Host directory lock");
      }
      throw new TrustedRootsLedgerError(
        "LEDGER_LOCK_STALE",
        "Host directory lock is stale; verify the old process is dead and remove the lock explicitly",
      );
    }
  }

  // Validate the ledger BEFORE acquiring the lifetime lock: a corrupt ledger
  // must fail startup without creating any new file (immutable evidence).
  await readUnlocked();

  const owned = await acquireLifetimeLock();
  let closed = false;

  return {
    hostDir,
    ledgerPath,
    lockPath,
    async read() {
      return mutex.runExclusive(() => readUnlocked());
    },
    async writeAll(claims) {
      return mutex.runExclusive(() => writeAllUnlocked(claims));
    },
    async update(mutator) {
      return mutex.runExclusive(async () => {
        const current = await readUnlocked();
        const next = await mutator([...current.claims]);
        if (next.length > maxClaims) {
          throw new TrustedRootsLedgerError("LEDGER_OVERSIZE", "Claim set exceeds maxClaims");
        }
        await writeAllUnlocked(next);
        return next;
      });
    },
    async withLock(operation) {
      return mutex.runExclusive(() => operation());
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
