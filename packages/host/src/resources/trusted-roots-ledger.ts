/**
 * Host-owned durable trusted-roots ledger (D3A-P0).
 *
 * Authority remains AllowedRootService; this module only persists and reloads
 * Host-created trusted claims. Never scans Git to invent authorization.
 *
 * This module is now a thin ADAPTER over the shared
 * {@link HostStateDirectoryLease} (`host-state-directory.ts`): host-dir
 * safety, the exclusive lifetime lock, bounded document read and the atomic
 * durability contract all live in the lease. The external narrow facade,
 * schema, error codes, semantics and byte output are unchanged.
 *
 * Layout (default `~/.pi/pix/host`, override via absolute `PIX_HOST_DIR`):
 *   trusted-roots.json   — schema v1 claims (0600, regular file, no symlink)
 *   trusted-roots.lock   — EXCLUSIVE LIFETIME host-dir lock (0600, pid+instanceId)
 *
 * The lease recognizes the future `managed-worktrees.json` sidecar as part of
 * the host-dir layout policy, so this ledger can open a host dir that already
 * carries that sidecar (rollback compatibility); unknown entries still fail
 * closed. The trusted ledger never writes the managed sidecar.
 *
 * Frozen architecture decisions (parent D3A-P0 mandate):
 *   1. STRICT single Host per PIX_HOST_DIR (see lease).
 *   2. Safe dedicated PIX_HOST_DIR only (see lease).
 *   3. A corrupt ledger is immutable evidence. Missing ⇒ empty. Any
 *      corrupt / unknown-version / wrong-kind / duplicate / sparse /
 *      wrong-permission / hard-linked / unsafe ledger fails startup and every
 *      mutation with a fixed sanitized error; it is never rewritten, truncated,
 *      renamed or deleted. Tests assert bytes and inode are unchanged.
 *   4. Durability contract: temp same-dir O_EXCL|O_NOFOLLOW 0600 → write+fsync →
 *      identity verification → atomic rename → directory fsync (see lease).
 *
 * Logs never include raw JSON, stacks, claim paths, host paths or branch names —
 * fixed codes/counts only.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  isAbsoluteCanonicalShape,
  isIsoTimestamp,
  isRecord,
  isSafeInteger,
  isValidInstanceId,
  openHostStateDirectoryLease,
  resolvePixHostDir as resolvePixHostDirInLease,
  type HostStateDirectoryCode,
  type HostStateDirectoryIo,
  type HostStateDirectoryLease,
  type LeaseDocumentReadResult,
} from "./host-state-directory.js";
import { HostStateDirectoryError } from "./host-state-directory.js";

export const TRUSTED_ROOTS_KIND = "pix.host.trusted-roots" as const;
export const TRUSTED_ROOTS_VERSION = 1 as const;
export const TRUSTED_ROOTS_SOURCE = "worktree.create" as const;

export const LEDGER_FILE_NAME = "trusted-roots.json";
export const LEDGER_LOCK_NAME = "trusted-roots.lock";

export type { HostStateDirectoryLease, LeaseDocumentReadResult } from "./host-state-directory.js";

// Re-exported for the narrow facade with the ledger's fixed error class: the
// shared lease throws HostStateDirectoryError, but this facade promises a
// TrustedRootsLedgerError (HOST_DIR_INVALID) so callers and the package index
// surface are unchanged.
export function resolvePixHostDir(raw: string | undefined, home?: string): string {
  try {
    return resolvePixHostDirInLease(raw, home);
  } catch (error) {
    if (error instanceof HostStateDirectoryError && error.code === "HOST_DIR_INVALID") {
      throw new TrustedRootsLedgerError("HOST_DIR_INVALID", error.message);
    }
    throw error;
  }
}

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

export interface TrustedRootsLedgerFromLeaseOptions {
  /** Upper bound on claim count accepted from disk (defaults to 128). */
  maxClaims?: number;
  /** Lock ownership instance id used by the shared lease. */
  instanceId?: string;
}

const MAX_LEDGER_BYTES = 1_048_576;
const MAX_CLAIMS_HARD = 1_024;

/** Map a shared-lease error code to the trusted-roots ledger error code. */
function mapLeaseCode(code: HostStateDirectoryCode): TrustedRootsLedgerCode {
  switch (code) {
    case "HOST_DIR_INVALID": return "HOST_DIR_INVALID";
    case "HOST_DIR_UNSAFE": return "HOST_DIR_UNSAFE";
    case "LOCK_BUSY": return "LEDGER_LOCK_BUSY";
    case "LOCK_STALE": return "LEDGER_LOCK_STALE";
    case "LOCK_UNSAFE": return "LEDGER_LOCK_UNSAFE";
    case "DOC_SYMLINK": return "LEDGER_SYMLINK";
    case "DOC_NOT_REGULAR": return "LEDGER_NOT_REGULAR";
    case "DOC_UNREADABLE": return "LEDGER_UNREADABLE";
    case "DOC_OVERSIZE": return "LEDGER_OVERSIZE";
    case "DOC_PERMISSIONS": return "LEDGER_PERMISSIONS";
    case "DOC_HARD_LINK": return "LEDGER_HARD_LINK";
    case "DOC_WRITE_FAILED": return "LEDGER_WRITE_FAILED";
    case "DOC_LOCK_LOST": return "LEDGER_LOCK_UNSAFE";
    case "DOC_UNKNOWN": return "LEDGER_CORRUPT";
  }
}

/** Ledger-specific messages for lease document codes (never leak paths/payloads). */
const LEDGER_DOC_MESSAGES: Partial<Record<HostStateDirectoryCode, string>> = {
  DOC_SYMLINK: "Trusted-roots ledger must not be a symbolic link",
  DOC_NOT_REGULAR: "Trusted-roots ledger must be a regular file",
  DOC_UNREADABLE: "Trusted-roots ledger is unreadable",
  DOC_OVERSIZE: "Trusted-roots ledger exceeds the size bound",
  DOC_PERMISSIONS: "Trusted-roots ledger permissions are unsafe",
  DOC_HARD_LINK: "Trusted-roots ledger must not be hard-linked",
  DOC_WRITE_FAILED: "Atomic ledger write failed",
  DOC_LOCK_LOST: "Ledger lock ownership lost before publish",
  DOC_UNKNOWN: "Trusted-roots ledger failed validation",
};

/** Convert a shared-lease error into the trusted-roots ledger error; rethrow others. */
function toLedgerError(error: unknown): never {
  if (error instanceof TrustedRootsLedgerError) throw error;
  if (error instanceof HostStateDirectoryError) {
    throw new TrustedRootsLedgerError(
      mapLeaseCode(error.code),
      LEDGER_DOC_MESSAGES[error.code] ?? error.message,
    );
  }
  throw error;
}

/**
 * Deterministic, bounded JSON serialization (sorted claimIds, stable key order).
 */
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

/**
 * Wrap an already-open shared lease as a trusted-roots ledger. Internal
 * composition seam for the future shared-lease wiring (trusted + managed
 * ledgers over ONE lease, so a single mutex serializes both documents).
 * The lease must already be open (host dir validated, lifetime lock held).
 */
export function createTrustedRootsLedgerFromLease(
  lease: HostStateDirectoryLease,
  options: TrustedRootsLedgerFromLeaseOptions = {},
): TrustedRootsLedger {
  const maxClaims = options.maxClaims ?? 128;
  const ledgerPath = join(lease.hostDir, LEDGER_FILE_NAME);

  /**
   * Classify a bounded document read into ledger semantics. Missing ⇒ empty.
   * Every other invalid condition (corrupt/unknown-version/wrong-kind/
   * duplicate/sparse/oversize) THROWS a fixed sanitized error and never
   * rewrites/truncates/renames/deletes the file.
   */
  function classify(result: LeaseDocumentReadResult): TrustedRootsReadResult {
    if ("missing" in result) {
      return { claims: [], warning: "LEDGER_MISSING" };
    }
    const parsed = parseTrustedRootsDocument(result.content, maxClaims);
    if (parsed.warning) {
      throw new TrustedRootsLedgerError(parsed.warning, "Trusted-roots ledger failed validation");
    }
    return { claims: parsed.claims };
  }

  async function writeSerialized(io: HostStateDirectoryIo, claims: readonly TrustedRootClaimRecord[]): Promise<void> {
    if (claims.length > maxClaims) {
      throw new TrustedRootsLedgerError("LEDGER_OVERSIZE", "Claim set exceeds maxClaims");
    }
    try {
      await io.writeDocument(LEDGER_FILE_NAME, serializeTrustedRootsDocument(claims));
    } catch (error) {
      toLedgerError(error);
    }
  }

  return {
    hostDir: lease.hostDir,
    ledgerPath,
    lockPath: lease.lockPath,
    async read() {
      let result: LeaseDocumentReadResult;
      try {
        result = await lease.readDocument(LEDGER_FILE_NAME);
      } catch (error) {
        toLedgerError(error);
      }
      return classify(result);
    },
    async writeAll(claims) {
      return lease.withLock((io) => writeSerialized(io, claims));
    },
    async update(mutator) {
      return lease.withLock(async (io) => {
        let current: TrustedRootsReadResult;
        try {
          const result = await io.readDocument(LEDGER_FILE_NAME);
          current = classify(result);
        } catch (error) {
          toLedgerError(error);
        }
        const next = await mutator([...current.claims]);
        await writeSerialized(io, next);
        return next;
      });
    },
    async withLock(operation) {
      return lease.withLock(() => operation());
    },
    async close() {
      return lease.close();
    },
  };
}

/**
 * Open the trusted-roots ledger over a fresh shared lease: validate the host
 * dir, validate the ledger document (fail-closed, no lock created for a
 * corrupt/unsafe ledger), then acquire the exclusive lifetime Host-dir lock
 * held until graceful {@link TrustedRootsLedger.close}.
 */
export async function openTrustedRootsLedger(
  options: OpenTrustedRootsLedgerOptions,
): Promise<TrustedRootsLedger> {
  // Validate lock ownership metadata before creating or changing any filesystem
  // path (exact facade message preserved).
  const instanceId = options.instanceId ?? randomUUID();
  if (!isValidInstanceId(instanceId)) {
    throw new TrustedRootsLedgerError("LEDGER_LOCK_UNSAFE", "Ledger instance id is invalid");
  }
  const maxClaims = options.maxClaims ?? 128;
  if (!Number.isInteger(maxClaims) || maxClaims < 1 || maxClaims > MAX_CLAIMS_HARD) {
    throw new TrustedRootsLedgerError("LEDGER_OVERSIZE", "maxClaims out of bounds");
  }

  let lease: HostStateDirectoryLease;
  try {
    lease = await openHostStateDirectoryLease({
      hostDir: options.hostDir,
      instanceId,
      ...(options.isPidAlive ? { isPidAlive: options.isPidAlive } : {}),
      ...(options.failTempFsync ? { failTempFsync: options.failTempFsync } : {}),
      ...(options.failRename ? { failRename: options.failRename } : {}),
      ...(options.failDirFsync ? { failDirFsync: options.failDirFsync } : {}),
      validateBeforeLock: async ({ readDocument }) => {
        const result = await readDocument(LEDGER_FILE_NAME);
        if ("missing" in result) return;
        const parsed = parseTrustedRootsDocument(result.content, maxClaims);
        if (parsed.warning) {
          throw new TrustedRootsLedgerError(parsed.warning, "Trusted-roots ledger failed validation");
        }
      },
    });
  } catch (error) {
    toLedgerError(error);
  }
  return createTrustedRootsLedgerFromLease(lease, { maxClaims, instanceId });
}
