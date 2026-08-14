/**
 * Managed-worktree domain service (D3A managed-worktree foundation, backend).
 *
 * Owns the exact management-evidence lifecycle for Pix-created worktrees:
 *   - {@link recordCreated}: capture evidence (path/repo/common/admin/base
 *     identities + git topology), persist to the managed-worktrees ledger
 *     (disk FIRST), then publish memory authorization via the AllowedRoot
 *     seam. Never writes a trusted-root ledger claim.
 *   - {@link findLiveAuthority} / {@link classify}: determine whether a path is
 *     a Pix-managed worktree and whether it is currently live (identity +
 *     git-topology corroboration). Never auto-imports Git worktrees and never
 *     treats git-topology membership alone as authority.
 *   - {@link commitRemoved}: exact record/path removal (disk then memory). No
 *     branch/base automatic deletion authority.
 *   - {@link rehydrateManagedWorktrees}: reconcile on-disk records against live
 *     identity + topology evidence; drops stale records only where evidence
 *     safely allows, preserves foreign-installation/repository records without
 *     authorizing them, and leaves corrupt evidence untouched (fail-closed).
 *
 * Semantics frozen for the current foundation:
 *   - branch switch/detach later never invalidates ownership (branchAtCreate is
 *     audit-only); remove/re-add the same path loses authority via inode/admin
 *     identity replacement.
 *   - created under an already-durable AllowedRoot still gets a managed record
 *     and memory authorization with no trusted claim.
 *   - durable root promotion never erases managed ownership.
 *
 * The service is Host-internal, not route-mounted, and not wired into
 * production boot yet. The current DELETE /v1/worktrees vulnerability (git
 * topology membership treated as delete authority) remains until the future
 * route integration consults this ledger — UI must stay disabled.
 */
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { HttpError } from "../errors.js";
import {
  registerManagedAuthorizedRoot,
  unregisterManagedAuthorizedRoot,
  type AllowedRootService,
} from "./allowed-roots.js";
import { MANAGED_WORKTREES_SOURCE, type ManagedWorktreeRecord, type ManagedWorktreesLedger } from "./managed-worktrees-ledger.js";
import { createProcessRunner, runChecked, type ProcessRunner } from "./process-runner.js";

export interface ManagedWorktreesDeps {
  /** Managed-worktrees ledger (shared lease; disk ownership evidence). */
  ledger: ManagedWorktreesLedger;
  /** Injectable narrow runner (defaults to a git-only process runner). */
  runner?: ProcessRunner;
  /** AllowedRoot seam for memory-only authorization publication (optional). */
  allowedRoots?: AllowedRootService;
  /** Upper bound on git subprocess output (defaults to 8 MiB). */
  maxOutputBytes?: number;
}

export interface ManagedWorktreesCapture {
  /** Canonical path of the just-created worktree checkout. */
  path: string;
  /** Branch at creation time (audit only — later switch/detach is fine). */
  branchAtCreate: string;
  /** Whether Pix created the branch via `git worktree add -b`. */
  branchCreatedByPix: boolean;
  /** Stable owner token (defaults to a fresh UUID). */
  worktreeId?: string;
  /** ISO timestamp (defaults to now). */
  createdAt?: string;
}

export interface ManagedAuthority {
  record: ManagedWorktreeRecord;
  /** Whether the record currently corroborates live (identity + topology). */
  live: boolean;
}

export type ManagedClassification =
  | { kind: "managed"; record: ManagedWorktreeRecord; live: boolean }
  | { kind: "unmanaged" };

export interface RehydrateManagedWorktreesOptions {
  /**
   * Whether THIS host manages the repository. Records for repos this host
   * does not manage are preserved on disk but never authorized.
   */
  isRepoManaged(repoRoot: string): boolean | Promise<boolean>;
}

export interface RehydrateManagedWorktreesResult {
  restored: number;
  dropped: number;
  preservedForeign: number;
  rewritten: boolean;
}

/** Narrow internal service facade for future production composition. */
export interface ManagedWorktreesService {
  recordCreated(capture: ManagedWorktreesCapture): Promise<ManagedWorktreeRecord>;
  findLiveAuthority(target: string): Promise<ManagedAuthority | null>;
  classify(target: string): Promise<ManagedClassification>;
  commitRemoved(worktreeId: string, path: string): Promise<boolean>;
  rehydrate(options: RehydrateManagedWorktreesOptions): Promise<RehydrateManagedWorktreesResult>;
}

/**
 * Narrow internal factory binding the domain methods to a {@link ManagedWorktreesDeps}
 * (shared lease + optional AllowedRoot seam). Host-internal; NOT exported from
 * the package index and not wired into production boot yet.
 */
export function createManagedWorktreesService(deps: ManagedWorktreesDeps): ManagedWorktreesService {
  return {
    recordCreated: (capture) => recordCreated(deps, capture),
    findLiveAuthority: (target) => findLiveAuthority(deps, target),
    classify: (target) => classify(deps, target),
    commitRemoved: (worktreeId, path) => commitRemoved(deps, worktreeId, path),
    rehydrate: (options) => rehydrateManagedWorktrees(deps, options),
  };
}

function isWithin(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function maxOutput(deps: ManagedWorktreesDeps): number {
  return deps.maxOutputBytes ?? 8 * 1024 * 1024;
}

function runnerFor(deps: ManagedWorktreesDeps): ProcessRunner {
  return deps.runner ?? createProcessRunner();
}

async function isRealDirWithIdentity(path: string, dev: number, ino: number): Promise<boolean> {
  try {
    if (await realpath(path) !== path) return false;
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink() && info.dev === dev && info.ino === ino;
  } catch {
    return false;
  }
}

/**
 * List non-main live worktree checkout paths for a repository via
 * `git worktree list --porcelain -z`. Missing/symlink entries are filtered.
 * Failures return an empty set (fail-closed corroboration, never authority).
 */
async function listNonMainWorktreePaths(
  runner: ProcessRunner,
  repoRoot: string,
  limit: number,
): Promise<ReadonlySet<string>> {
  let out: string;
  try {
    out = await runChecked(runner, {
      command: "git",
      args: ["-C", repoRoot, "worktree", "list", "--porcelain", "-z"],
      maxOutputBytes: limit,
    });
  } catch {
    return new Set();
  }
  const paths: string[] = [];
  for (const record of out.split("\0").filter(Boolean)) {
    const first = record.split("\n", 1)[0];
    if (first?.startsWith("worktree ")) {
      paths.push(first.slice("worktree ".length));
    }
  }
  const existing = new Set<string>();
  for (const path of paths) {
    try {
      const info = await lstat(path);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        existing.add(await realpath(path));
      }
    } catch {
      /* stale */
    }
  }
  return existing;
}

/**
 * Capture exact management evidence for a Pix-created worktree. Validates
 * absolute canonical paths, containment (path strictly inside
 * `${repoRoot}-worktrees`, `dirname(commonDir) === repoRoot`, adminDir inside
 * commonDir) and safe-integer identities. Throws {@link HttpError} with fixed
 * sanitized codes on any unsafe condition.
 */
export async function captureManagedWorktreeEvidence(
  deps: ManagedWorktreesDeps,
  capture: ManagedWorktreesCapture,
): Promise<ManagedWorktreeRecord> {
  const runner = runnerFor(deps);
  const limit = maxOutput(deps);

  let canonical: string;
  try {
    canonical = await realpath(capture.path);
  } catch {
    throw new HttpError(404, "WORKTREE_NOT_FOUND", "Worktree not found");
  }
  const pathInfo = await lstat(canonical);
  if (pathInfo.isSymbolicLink() || !pathInfo.isDirectory()) {
    throw new HttpError(400, "UNSAFE_WORKTREE_TARGET", "Worktree target must be a real directory");
  }

  let commonRaw: string;
  let adminRaw: string;
  try {
    commonRaw = (await runChecked(runner, {
      command: "git",
      args: ["-C", canonical, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      maxOutputBytes: limit,
    })).trim();
    adminRaw = (await runChecked(runner, {
      command: "git",
      args: ["-C", canonical, "rev-parse", "--path-format=absolute", "--absolute-git-dir"],
      maxOutputBytes: limit,
    })).trim();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "WORKTREE_CAPTURE_FAILED", "Failed to capture worktree evidence");
  }

  let commonDir: string;
  let adminDir: string;
  try {
    commonDir = await realpath(commonRaw);
    adminDir = await realpath(adminRaw);
  } catch {
    throw new HttpError(400, "UNSAFE_WORKTREE_BASE", "Worktree git directories are not real");
  }
  const repoRoot = await realpath(dirname(commonDir));
  const base = `${resolve(repoRoot)}-worktrees`;

  // Containment invariants (same as the ledger schema).
  if (dirname(commonDir) !== repoRoot) {
    throw new HttpError(400, "UNSAFE_WORKTREE_BASE", "Worktree common dir must sit directly under the repository root");
  }
  if (!isWithin(base, canonical) || canonical === base) {
    throw new HttpError(409, "UNSAFE_WORKTREE_TARGET", "Worktree target must be strictly inside its base");
  }
  if (!isWithin(commonDir, adminDir)) {
    throw new HttpError(400, "UNSAFE_WORKTREE_ADMIN", "Worktree admin dir must be inside the common dir");
  }

  const branchAtCreate = capture.branchAtCreate ?? "";
  if (!branchAtCreate || branchAtCreate.length > 255 || /[\u0000-\u001f\u007f]/u.test(branchAtCreate)) {
    throw new HttpError(400, "INVALID_BRANCH", "Invalid branch at create");
  }
  const worktreeId = capture.worktreeId ?? randomUUID();
  if (worktreeId.length < 8 || worktreeId.length > 128 || /[\u0000-\u001f\u007f]/u.test(worktreeId)) {
    throw new HttpError(400, "INVALID_WORKTREE_ID", "Invalid worktree id");
  }

  const repoInfo = await lstat(repoRoot);
  const commonInfo = await lstat(commonDir);
  const adminInfo = await lstat(adminDir);
  let baseInfo;
  try {
    baseInfo = await lstat(base);
  } catch {
    throw new HttpError(404, "WORKTREE_BASE_NOT_FOUND", "Worktree base not found");
  }
  if (baseInfo.isSymbolicLink() || !baseInfo.isDirectory()) {
    throw new HttpError(400, "UNSAFE_WORKTREE_BASE", "Worktree base must be a real directory");
  }

  return {
    worktreeId,
    path: canonical,
    dev: pathInfo.dev,
    ino: pathInfo.ino,
    repoRoot,
    repoDev: repoInfo.dev,
    repoIno: repoInfo.ino,
    commonDir,
    commonDev: commonInfo.dev,
    commonIno: commonInfo.ino,
    adminDir,
    adminDev: adminInfo.dev,
    adminIno: adminInfo.ino,
    base,
    baseDev: baseInfo.dev,
    baseIno: baseInfo.ino,
    createdAt: capture.createdAt ?? new Date().toISOString(),
    source: MANAGED_WORKTREES_SOURCE,
    branchAtCreate,
    branchCreatedByPix: capture.branchCreatedByPix,
  };
}

/** Corroborate a record against live path/repo/common/admin/base identities and git topology. */
async function corroborateRecord(deps: ManagedWorktreesDeps, record: ManagedWorktreeRecord): Promise<boolean> {
  if (!(await isRealDirWithIdentity(record.path, record.dev, record.ino))) return false;
  if (!(await isRealDirWithIdentity(record.repoRoot, record.repoDev, record.repoIno))) return false;
  if (!(await isRealDirWithIdentity(record.commonDir, record.commonDev, record.commonIno))) return false;
  if (!(await isRealDirWithIdentity(record.adminDir, record.adminDev, record.adminIno))) return false;
  if (!(await isRealDirWithIdentity(record.base, record.baseDev, record.baseIno))) return false;
  if (dirname(record.commonDir) !== record.repoRoot) return false;
  if (record.base !== `${record.repoRoot}-worktrees`) return false;
  if (!isWithin(record.base, record.path) || record.path === record.base) return false;
  if (!isWithin(record.commonDir, record.adminDir)) return false;
  const listed = await listNonMainWorktreePaths(runnerFor(deps), record.repoRoot, maxOutput(deps));
  if (!listed.has(record.path)) return false;
  return true;
}

/**
 * Record a just-created managed worktree. Disk commit (ledger) happens BEFORE
 * memory authorization publication, so a persistence failure never leaks
 * authorization. Throws on duplicate worktreeId/path.
 */
export async function recordCreated(
  deps: ManagedWorktreesDeps,
  capture: ManagedWorktreesCapture,
): Promise<ManagedWorktreeRecord> {
  const record = await captureManagedWorktreeEvidence(deps, capture);
  const committed = await deps.ledger.update((records) => {
    if (records.some((existing) => existing.worktreeId === record.worktreeId || existing.path === record.path)) {
      throw new HttpError(409, "MANAGED_WORKTREE_EXISTS", "Managed worktree record already exists");
    }
    return [...records, record];
  });
  if (deps.allowedRoots) {
    await registerManagedAuthorizedRoot(deps.allowedRoots, {
      worktreeId: record.worktreeId,
      path: record.path,
      dev: record.dev,
      ino: record.ino,
    });
  }
  return committed.find((item) => item.worktreeId === record.worktreeId) ?? record;
}

/**
 * Remove the EXACT managed record (worktreeId + path). No branch/base deletion
 * authority. Returns true when a record was removed. Memory authorization is
 * dropped only after the disk record is gone.
 */
export async function commitRemoved(
  deps: ManagedWorktreesDeps,
  worktreeId: string,
  path: string,
): Promise<boolean> {
  let removed = false;
  await deps.ledger.update((records) => {
    const next = records.filter((item) => !(item.worktreeId === worktreeId && item.path === path));
    removed = next.length < records.length;
    return next;
  });
  if (removed && deps.allowedRoots) {
    await unregisterManagedAuthorizedRoot(deps.allowedRoots, worktreeId, path);
  }
  return removed;
}

/**
 * Find the managed authority for an exact canonical path. Returns null when no
 * record exists (unmanaged / never Pix-created). `live` reflects current
 * identity + topology corroboration; ownership is not inferred from topology.
 */
export async function findLiveAuthority(
  deps: ManagedWorktreesDeps,
  target: string,
): Promise<ManagedAuthority | null> {
  let canonical: string;
  try {
    canonical = await realpath(target);
  } catch {
    return null;
  }
  const records = (await deps.ledger.read()).records;
  const record = records.find((item) => item.path === canonical);
  if (!record) return null;
  return { record, live: await corroborateRecord(deps, record) };
}

/** Classify a path as Pix-managed or unmanaged. */
export async function classify(
  deps: ManagedWorktreesDeps,
  target: string,
): Promise<ManagedClassification> {
  const authority = await findLiveAuthority(deps, target);
  if (!authority) return { kind: "unmanaged" };
  return { kind: "managed", record: authority.record, live: authority.live };
}

/**
 * Rehydrate/reconcile the managed-worktrees sidecar.
 *
 * - Records for repositories THIS host does not manage are preserved on disk
 *   but never authorized (foreign installation/repository).
 * - Live records (identity + topology corroborated) are restored and
 *   re-authorized in memory.
 * - Stale records (original path/repo identity gone, or removed from git
 *   topology) are dropped ONLY as exact records.
 * - A corrupt/unsafe sidecar fails closed (ledger read throws) and is never
 *   rewritten.
 */
export async function rehydrateManagedWorktrees(
  deps: ManagedWorktreesDeps,
  options: RehydrateManagedWorktreesOptions,
): Promise<RehydrateManagedWorktreesResult> {
  const snapshot = await deps.ledger.read();
  const snapshotMissing = snapshot.warning === "MANAGED_MISSING";
  const survivors: ManagedWorktreeRecord[] = [];
  let restored = 0;
  let dropped = 0;
  let preservedForeign = 0;
  for (const record of snapshot.records) {
    let managed: boolean;
    try {
      managed = await options.isRepoManaged(record.repoRoot);
    } catch {
      managed = false;
    }
    if (!managed) {
      preservedForeign += 1;
      survivors.push(record);
      continue;
    }
    if (await corroborateRecord(deps, record)) {
      survivors.push(record);
      restored += 1;
      if (deps.allowedRoots) {
        await registerManagedAuthorizedRoot(deps.allowedRoots, {
          worktreeId: record.worktreeId,
          path: record.path,
          dev: record.dev,
          ino: record.ino,
        });
      }
    } else {
      dropped += 1;
    }
  }
  let rewritten = false;
  // A missing sidecar stays ABSENT until the first managed record is written:
  // with no on-disk records there is nothing to reconcile, so skip the rewrite
  // entirely (writing an empty document here would violate the invariant that
  // the managed sidecar only appears with real ownership evidence).
  if (!snapshotMissing) {
    await deps.ledger.update((records) => {
      const survivorKeys = new Set(survivors.map((item) => `${item.worktreeId}\0${item.path}`));
      const next = records.filter((item) => survivorKeys.has(`${item.worktreeId}\0${item.path}`));
      rewritten = next.length !== records.length;
      return next;
    });
  }
  return { restored, dropped, preservedForeign, rewritten };
}
