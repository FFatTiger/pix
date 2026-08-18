/**
 * Host-owned durable managed-worktree ledger (D3A managed-worktree foundation).
 *
 * Separate sidecar document `managed-worktrees.json` (kind
 * `pix.host.managed-worktrees`, version 1) that records exact management
 * evidence for Pix-created worktrees. This is OWNERSHIP evidence only — it
 * never grants delete authority by itself and never scans Git to invent
 * authorization; the future route wiring must consult this ledger before
 * removing any worktree.
 *
 * The ledger is a thin ADAPTER over the shared {@link HostStateDirectoryLease}
 * (`host-state-directory.ts`): the same safe host dir, the same exclusive
 * lifetime lock, the same in-process mutation mutex and the same atomic
 * durability contract as the trusted-roots ledger. There is NO second lock —
 * one lease serializes both documents to avoid lost updates.
 *
 * Frozen schema / safety decisions:
 *   - Missing sidecar ⇒ empty. It stays absent until the first managed record
 *     is written (production boot does NOT instantiate/write this ledger yet).
 *   - Corrupt / unknown-version / wrong-kind / duplicate / sparse /
 *     wrong-permission / hard-linked / unsafe sidecar fails startup and every
 *     mutation with a fixed sanitized error; it is never rewritten, truncated,
 *     renamed or deleted (immutable evidence, bytes+inode unchanged).
 *   - 0600 regular file, no symlink/hard-link, bounded size and record count.
 *   - Deterministic strict schema: absolute canonical paths, containment
 *     (path strictly inside `${repoRoot}-worktrees`; `dirname(commonDir)`
 *     equals `repoRoot`; adminDir inside commonDir), distinct worktreeIds and
 *     paths, safe-integer dev/ino identities, bounded metadata strings with
 *     ALL C0 control chars and DEL rejected.
 *   - `branchAtCreate` / `branchCreatedByPix` are audit metadata only: branch
 *     switching or detaching later must never invalidate ownership.
 *
 * This ledger is Host-internal and NOT exported from the package index; it is
 * not route-mounted and not wired into production boot yet.
 */
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep, join, dirname } from "node:path";
import {
  hasControlChar,
  isAbsoluteCanonicalShape,
  isIsoTimestamp,
  isRecord,
  isSafeInteger,
  isValidInstanceId,
  MANAGED_WORKTREES_STATE_DOCUMENT,
  openHostStateDirectoryLease,
  type HostStateDirectoryCode,
  type HostStateDirectoryIo,
  type HostStateDirectoryLease,
  type LeaseDocumentReadResult,
} from "./host-state-directory.js";
import { HostStateDirectoryError } from "./host-state-directory.js";

export const MANAGED_WORKTREES_KIND = "pix.host.managed-worktrees" as const;
export const MANAGED_WORKTREES_VERSION = 1 as const;
export const MANAGED_WORKTREES_SOURCE = "worktree.create" as const;
export const MANAGED_WORKTREES_FILE_NAME = MANAGED_WORKTREES_STATE_DOCUMENT;

/** Fixed warning / error codes — never embed paths or raw payloads. */
export type ManagedWorktreesLedgerCode =
  | "MANAGED_MISSING"
  | "MANAGED_SYMLINK"
  | "MANAGED_NOT_REGULAR"
  | "MANAGED_UNREADABLE"
  | "MANAGED_CORRUPT"
  | "MANAGED_UNKNOWN_VERSION"
  | "MANAGED_WRONG_KIND"
  | "MANAGED_OVERSIZE"
  | "MANAGED_DUPLICATE"
  | "MANAGED_SPARSE"
  | "MANAGED_PERMISSIONS"
  | "MANAGED_HARD_LINK"
  | "MANAGED_WRITE_FAILED"
  | "MANAGED_WRITE_REJECTED"
  | "MANAGED_LOCK_BUSY"
  | "MANAGED_LOCK_STALE"
  | "MANAGED_LOCK_UNSAFE"
  | "HOST_DIR_UNSAFE"
  | "HOST_DIR_INVALID";

export class ManagedWorktreesLedgerError extends Error {
  readonly code: ManagedWorktreesLedgerCode;
  constructor(code: ManagedWorktreesLedgerCode, message: string) {
    super(message);
    this.name = "ManagedWorktreesLedgerError";
    this.code = code;
  }
}

export interface ManagedWorktreeRecord {
  worktreeId: string;
  path: string;
  dev: number;
  ino: number;
  repoRoot: string;
  repoDev: number;
  repoIno: number;
  commonDir: string;
  commonDev: number;
  commonIno: number;
  adminDir: string;
  adminDev: number;
  adminIno: number;
  base: string;
  baseDev: number;
  baseIno: number;
  createdAt: string;
  source: typeof MANAGED_WORKTREES_SOURCE;
  /** Audit only — branch switch/detach later never invalidates ownership. */
  branchAtCreate: string;
  /** Audit only — whether Pix created the branch (`git worktree add -b`). */
  branchCreatedByPix: boolean;
}

export interface ManagedWorktreesLedgerDocument {
  kind: typeof MANAGED_WORKTREES_KIND;
  version: typeof MANAGED_WORKTREES_VERSION;
  records: ManagedWorktreeRecord[];
}

export interface ManagedWorktreesReadResult {
  records: ManagedWorktreeRecord[];
  /** Present only for a missing sidecar (empty). */
  warning?: "MANAGED_MISSING";
}

export interface ManagedWorktreesParseResult {
  records: ManagedWorktreeRecord[];
  warning?: ManagedWorktreesLedgerCode;
  dropped?: number;
}

export interface ManagedWorktreesLedger {
  readonly hostDir: string;
  readonly ledgerPath: string;
  readonly lockPath: string;
  /** Safe fail-closed read. Missing ⇒ empty; corrupt/unsafe ⇒ throws. */
  read(): Promise<ManagedWorktreesReadResult>;
  /** Atomic replace of the full record set under the held lifetime lock. */
  writeAll(records: readonly ManagedWorktreeRecord[]): Promise<void>;
  /**
   * Read (fail-closed) → pure mutator → atomic write. Returns the records that
   * were written. Corrupt/unsafe sidecar ⇒ throws without touching it.
   */
  update(
    mutator: (records: ManagedWorktreeRecord[]) => ManagedWorktreeRecord[] | Promise<ManagedWorktreeRecord[]>,
  ): Promise<ManagedWorktreeRecord[]>;
  /** In-process serialized critical section around custom work (shared mutex). */
  withLock<T>(operation: () => Promise<T>): Promise<T>;
  /**
   * Release the lease THIS handle opened (standalone open). For a shared-lease
   * handle this is a no-op — the lease owner closes the shared lease. Never
   * releases another handle's lock.
   */
  close(): Promise<void>;
}

export interface OpenManagedWorktreesLedgerOptions {
  hostDir: string;
  /** Upper bound on record count accepted from disk (defaults to 128). */
  maxRecords?: number;
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

export interface ManagedWorktreesLedgerFromLeaseOptions {
  /** Upper bound on record count accepted from disk (defaults to 128). */
  maxRecords?: number;
  /** When true, `close()` releases the shared lease (standalone open). */
  closeLease?: boolean;
}

const MAX_LEDGER_BYTES = 1_048_576;
const MAX_RECORDS_HARD = 1_024;
const MAX_WORKTREE_ID_LENGTH = 128;
const MIN_WORKTREE_ID_LENGTH = 8;

function isWithin(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

/** Map a shared-lease error code to the managed-worktrees ledger error code. */
export function mapLeaseCode(code: HostStateDirectoryCode): ManagedWorktreesLedgerCode {
  switch (code) {
    case "HOST_DIR_INVALID": return "HOST_DIR_INVALID";
    case "HOST_DIR_UNSAFE": return "HOST_DIR_UNSAFE";
    case "LOCK_BUSY": return "MANAGED_LOCK_BUSY";
    case "LOCK_STALE": return "MANAGED_LOCK_STALE";
    case "LOCK_UNSAFE": return "MANAGED_LOCK_UNSAFE";
    case "DOC_SYMLINK": return "MANAGED_SYMLINK";
    case "DOC_NOT_REGULAR": return "MANAGED_NOT_REGULAR";
    case "DOC_UNREADABLE": return "MANAGED_UNREADABLE";
    case "DOC_OVERSIZE": return "MANAGED_OVERSIZE";
    case "DOC_PERMISSIONS": return "MANAGED_PERMISSIONS";
    case "DOC_HARD_LINK": return "MANAGED_HARD_LINK";
    case "DOC_WRITE_FAILED": return "MANAGED_WRITE_FAILED";
    case "DOC_LOCK_LOST": return "MANAGED_LOCK_UNSAFE";
    case "DOC_UNKNOWN": return "MANAGED_CORRUPT";
  }
}

/** Ledger-specific messages for lease document codes (never leak paths/payloads). */
const MANAGED_DOC_MESSAGES: Partial<Record<HostStateDirectoryCode, string>> = {
  DOC_SYMLINK: "Managed-worktrees ledger must not be a symbolic link",
  DOC_NOT_REGULAR: "Managed-worktrees ledger must be a regular file",
  DOC_UNREADABLE: "Managed-worktrees ledger is unreadable",
  DOC_OVERSIZE: "Managed-worktrees ledger exceeds the size bound",
  DOC_PERMISSIONS: "Managed-worktrees ledger permissions are unsafe",
  DOC_HARD_LINK: "Managed-worktrees ledger must not be hard-linked",
  DOC_WRITE_FAILED: "Atomic managed-worktrees ledger write failed",
  DOC_LOCK_LOST: "Managed-worktrees ledger lock ownership lost before publish",
  DOC_UNKNOWN: "Managed-worktrees ledger failed validation",
};

/** Convert a shared-lease error into the managed-worktrees ledger error; rethrow others. */
function toManagedError(error: unknown): never {
  if (error instanceof ManagedWorktreesLedgerError) throw error;
  if (error instanceof HostStateDirectoryError) {
    throw new ManagedWorktreesLedgerError(
      mapLeaseCode(error.code),
      MANAGED_DOC_MESSAGES[error.code] ?? error.message,
    );
  }
  throw error;
}

/**
 * Deterministic, bounded JSON serialization (sorted worktreeIds, stable key order).
 */
export function serializeManagedWorktreesDocument(records: readonly ManagedWorktreeRecord[]): string {
  const sorted = [...records].sort((a, b) => a.worktreeId.localeCompare(b.worktreeId) || a.path.localeCompare(b.path));
  const body: ManagedWorktreesLedgerDocument = {
    kind: MANAGED_WORKTREES_KIND,
    version: MANAGED_WORKTREES_VERSION,
    records: sorted.map((record) => ({
      worktreeId: record.worktreeId,
      path: record.path,
      dev: record.dev,
      ino: record.ino,
      repoRoot: record.repoRoot,
      repoDev: record.repoDev,
      repoIno: record.repoIno,
      commonDir: record.commonDir,
      commonDev: record.commonDev,
      commonIno: record.commonIno,
      adminDir: record.adminDir,
      adminDev: record.adminDev,
      adminIno: record.adminIno,
      base: record.base,
      baseDev: record.baseDev,
      baseIno: record.baseIno,
      createdAt: record.createdAt,
      source: MANAGED_WORKTREES_SOURCE,
      branchAtCreate: record.branchAtCreate,
      branchCreatedByPix: record.branchCreatedByPix,
    })),
  };
  return `${JSON.stringify(body)}\n`;
}

function parseManagedRecord(
  raw: unknown,
  maxRecords: number,
  seen: Set<string>,
): ManagedWorktreeRecord | "sparse" | "duplicate" {
  if (!isRecord(raw)) return "sparse";
  const worktreeId = raw.worktreeId;
  const path = raw.path;
  const repoRoot = raw.repoRoot;
  const commonDir = raw.commonDir;
  const adminDir = raw.adminDir;
  const base = raw.base;
  const createdAt = raw.createdAt;
  const source = raw.source;
  const branchAtCreate = raw.branchAtCreate;

  if (
    typeof worktreeId !== "string"
    || worktreeId.length < MIN_WORKTREE_ID_LENGTH
    || worktreeId.length > MAX_WORKTREE_ID_LENGTH
    || hasControlChar(worktreeId)
  ) {
    return "sparse";
  }
  if (!isAbsoluteCanonicalShape(path)) return "sparse";
  if (!isAbsoluteCanonicalShape(repoRoot)) return "sparse";
  if (!isAbsoluteCanonicalShape(commonDir)) return "sparse";
  if (!isAbsoluteCanonicalShape(adminDir)) return "sparse";
  if (!isAbsoluteCanonicalShape(base)) return "sparse";
  if (
    !isSafeInteger(raw.dev) || !isSafeInteger(raw.ino)
    || !isSafeInteger(raw.repoDev) || !isSafeInteger(raw.repoIno)
    || !isSafeInteger(raw.commonDev) || !isSafeInteger(raw.commonIno)
    || !isSafeInteger(raw.adminDev) || !isSafeInteger(raw.adminIno)
    || !isSafeInteger(raw.baseDev) || !isSafeInteger(raw.baseIno)
  ) {
    return "sparse";
  }
  if (!isIsoTimestamp(createdAt)) return "sparse";
  if (source !== MANAGED_WORKTREES_SOURCE) return "sparse";
  if (
    typeof branchAtCreate !== "string"
    || branchAtCreate.length === 0
    || branchAtCreate.length > 255
    || hasControlChar(branchAtCreate)
  ) {
    return "sparse";
  }
  if (typeof raw.branchCreatedByPix !== "boolean") return "sparse";

  // Containment invariants:
  //  - `dirname(commonDir) === repoRoot` (common dir is `<repoRoot>/.git`).
  //  - `base === `${repoRoot}-worktrees`` (exact repository-linked base).
  //  - path strictly inside base.
  //  - adminDir inside commonDir (linked-worktree admin dir).
  if (dirname(commonDir) !== repoRoot) return "sparse";
  if (base !== `${resolve(repoRoot)}-worktrees`) return "sparse";
  if (!isWithin(base, path) || path === base) return "sparse";
  if (!isWithin(commonDir, adminDir)) return "sparse";

  if (seen.has(worktreeId) || seen.has(`path:${path}`)) return "duplicate";
  if (seen.size / 2 >= maxRecords) return "sparse";

  const allowed = new Set([
    "worktreeId", "path", "dev", "ino",
    "repoRoot", "repoDev", "repoIno",
    "commonDir", "commonDev", "commonIno",
    "adminDir", "adminDev", "adminIno",
    "base", "baseDev", "baseIno",
    "createdAt", "source", "branchAtCreate", "branchCreatedByPix",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) return "sparse";
  }
  seen.add(worktreeId);
  seen.add(`path:${path}`);
  return {
    worktreeId,
    path,
    dev: raw.dev,
    ino: raw.ino,
    repoRoot,
    repoDev: raw.repoDev,
    repoIno: raw.repoIno,
    commonDir,
    commonDev: raw.commonDev,
    commonIno: raw.commonIno,
    adminDir,
    adminDev: raw.adminDev,
    adminIno: raw.adminIno,
    base,
    baseDev: raw.baseDev,
    baseIno: raw.baseIno,
    createdAt,
    source: MANAGED_WORKTREES_SOURCE,
    branchAtCreate,
    branchCreatedByPix: raw.branchCreatedByPix,
  };
}

/**
 * Pure parse of a managed-worktrees sidecar (bounded). Returns a `warning`
 * code instead of throwing so callers can classify; the ledger {@link read}
 * path converts every warning except MANAGED_MISSING into a hard error.
 */
export function parseManagedWorktreesDocument(
  text: string,
  maxRecords: number,
): ManagedWorktreesParseResult {
  if (text.length > MAX_LEDGER_BYTES) {
    return { records: [], warning: "MANAGED_OVERSIZE" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { records: [], warning: "MANAGED_CORRUPT" };
  }
  if (!isRecord(parsed)) return { records: [], warning: "MANAGED_CORRUPT" };
  if (parsed.kind !== MANAGED_WORKTREES_KIND) return { records: [], warning: "MANAGED_WRONG_KIND" };
  if (parsed.version !== MANAGED_WORKTREES_VERSION) return { records: [], warning: "MANAGED_UNKNOWN_VERSION" };
  if (!Array.isArray(parsed.records)) return { records: [], warning: "MANAGED_CORRUPT" };
  if (parsed.records.length > Math.min(maxRecords, MAX_RECORDS_HARD)) {
    return { records: [], warning: "MANAGED_OVERSIZE" };
  }
  for (const key of Object.keys(parsed)) {
    if (key !== "kind" && key !== "version" && key !== "records") {
      return { records: [], warning: "MANAGED_CORRUPT" };
    }
  }
  const records: ManagedWorktreeRecord[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  let sparse = false;
  let duplicate = false;
  for (const entry of parsed.records) {
    const result = parseManagedRecord(entry, maxRecords, seen);
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
    records.push(result);
  }
  if (sparse || duplicate || dropped > 0) {
    return {
      records: [],
      warning: duplicate ? "MANAGED_DUPLICATE" : "MANAGED_SPARSE",
      dropped,
    };
  }
  return { records };
}

/**
 * Wrap an already-open shared lease as a managed-worktrees ledger. Internal
 * composition seam for the future shared-lease wiring (trusted + managed
 * ledgers over ONE lease, so a single mutex serializes both documents).
 * With `closeLease: true` (standalone open) `close()` releases the lease;
 * with the default (shared) it is a no-op — the lease owner closes it.
 */
export function createManagedWorktreesLedgerFromLease(
  lease: HostStateDirectoryLease,
  options: ManagedWorktreesLedgerFromLeaseOptions = {},
): ManagedWorktreesLedger {
  const maxRecords = options.maxRecords ?? 128;
  const ledgerPath = join(lease.hostDir, MANAGED_WORKTREES_FILE_NAME);

  function classify(result: LeaseDocumentReadResult): ManagedWorktreesReadResult {
    if ("missing" in result) {
      return { records: [], warning: "MANAGED_MISSING" };
    }
    const parsed = parseManagedWorktreesDocument(result.content, maxRecords);
    if (parsed.warning) {
      throw new ManagedWorktreesLedgerError(parsed.warning, "Managed-worktrees ledger failed validation");
    }
    return { records: parsed.records };
  }

  async function writeSerialized(io: HostStateDirectoryIo, records: readonly ManagedWorktreeRecord[]): Promise<void> {
    if (records.length > maxRecords) {
      throw new ManagedWorktreesLedgerError("MANAGED_OVERSIZE", "Record set exceeds maxRecords");
    }
    const serialized = serializeManagedWorktreesDocument(records);
    // Write-side round-trip gate: a record set that the schema cannot re-read
    // (Windows dev/ino beyond 2^53-1, non-canonical stored path shape, …) must
    // never be persisted as a ledger that later fail-closes as MANAGED_SPARSE.
    const reread = parseManagedWorktreesDocument(serialized, maxRecords);
    if (reread.warning) {
      throw new ManagedWorktreesLedgerError("MANAGED_WRITE_REJECTED", "Managed-worktrees record set cannot be re-read from its own schema");
    }
    try {
      await io.writeDocument(MANAGED_WORKTREES_FILE_NAME, serialized);
    } catch (error) {
      toManagedError(error);
    }
  }

  let closed = false;
  return {
    hostDir: lease.hostDir,
    ledgerPath,
    lockPath: lease.lockPath,
    async read() {
      let result: LeaseDocumentReadResult;
      try {
        result = await lease.readDocument(MANAGED_WORKTREES_FILE_NAME);
      } catch (error) {
        toManagedError(error);
      }
      return classify(result);
    },
    async writeAll(records) {
      return lease.withLock((io) => writeSerialized(io, records));
    },
    async update(mutator) {
      return lease.withLock(async (io) => {
        let current: ManagedWorktreesReadResult;
        try {
          const result = await io.readDocument(MANAGED_WORKTREES_FILE_NAME);
          current = classify(result);
        } catch (error) {
          toManagedError(error);
        }
        const next = await mutator([...current.records]);
        await writeSerialized(io, next);
        return next;
      });
    },
    async withLock(operation) {
      return lease.withLock(() => operation());
    },
    async close() {
      if (options.closeLease !== true || closed) return;
      closed = true;
      await lease.close();
    },
  };
}

/**
 * Open the managed-worktrees ledger over a fresh shared lease: validate the
 * host dir, validate the sidecar (fail-closed, no lock created for a
 * corrupt/unsafe sidecar), then acquire the exclusive lifetime host-dir lock.
 */
export async function openManagedWorktreesLedger(
  options: OpenManagedWorktreesLedgerOptions,
): Promise<ManagedWorktreesLedger> {
  const instanceId = options.instanceId ?? randomUUID();
  if (!isValidInstanceId(instanceId)) {
    throw new ManagedWorktreesLedgerError("MANAGED_LOCK_UNSAFE", "Managed-worktrees ledger instance id is invalid");
  }
  const maxRecords = options.maxRecords ?? 128;
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_RECORDS_HARD) {
    throw new ManagedWorktreesLedgerError("MANAGED_OVERSIZE", "maxRecords out of bounds");
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
        const result = await readDocument(MANAGED_WORKTREES_FILE_NAME);
        if ("missing" in result) return;
        const parsed = parseManagedWorktreesDocument(result.content, maxRecords);
        if (parsed.warning) {
          throw new ManagedWorktreesLedgerError(parsed.warning, "Managed-worktrees ledger failed validation");
        }
      },
    });
  } catch (error) {
    toManagedError(error);
  }
  return createManagedWorktreesLedgerFromLease(lease, { maxRecords, closeLease: true });
}
