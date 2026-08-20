/**
 * Managed-worktree domain service (D3A managed-worktree foundation, backend).
 *
 * Owns the exact management-evidence lifecycle for Pix-created worktrees:
 *   - {@link recordCreated}: capture evidence (path/repo/common/admin/base
 *     identities + git topology), persist to the managed-worktrees ledger
 *     (disk FIRST), then publish memory authorization via the AllowedRoot
 *     seam. Never writes a trusted-root ledger claim.
 *   - {@link findLiveAuthority} / {@link classify}: determine whether a path is
 *     recorded and whether it retains current-process destructive ownership.
 *     Path + Git topology may restore workspace access after restart, but never
 *     recreates the runtime delete token.
 *   - {@link commitRemoved}: exact record/path removal (disk then memory). No
 *     branch/base automatic deletion authority.
 *   - {@link rehydrateManagedWorktrees}: reconcile on-disk records against live
 *     identity + topology evidence; drops stale records only where evidence
 *     safely allows, preserves foreign-installation/repository records without
 *     authorizing them, and leaves corrupt evidence untouched (fail-closed).
 *
 * Semantics frozen for the current foundation:
 *   - branch switch/detach later never invalidates a current-process ownership
 *     token (branchAtCreate is audit-only); remove/re-add or Host restart does
 *     not recreate destructive ownership from reusable path/topology evidence.
 *   - created under an already-durable AllowedRoot still gets a managed record
 *     and memory authorization with no trusted claim.
 *   - durable root promotion never erases managed ownership.
 *
 * This service is wired into production Host resources and worktree routes.
 * The managed ledger is the only DELETE authority source, but restart/path+Git
 * corroboration restores workspace access only; destructive ownership requires
 * a current-process runtime identity token.
 */
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createSecureStateBackend, type FileIdentity } from "@fffattiger/pix-local-authority/state";
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
  /** AllowedRoot seam for memory-only workspace access publication (optional). */
  allowedRoots?: AllowedRootService;
  /** Runtime-only destructive ownership tokens (empty after Host restart). */
  ownedIdentities?: Map<string, FileIdentity>;
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
  /**
   * Destructive ownership for DELETE. True only for a current-process
   * recordCreated() claim whose runtime FileIdentity still matches.
   */
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
 * (shared lease + optional AllowedRoot seam). Host-internal and production-
 * composed by `createProductionResources`.
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

function ownedIdentitiesFor(deps: ManagedWorktreesDeps): Map<string, FileIdentity> {
  if (!deps.ownedIdentities) deps.ownedIdentities = new Map();
  return deps.ownedIdentities;
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  if (left.kind !== right.kind || !left.isDirectory || !right.isDirectory) return false;
  if (left.kind === "posix" && right.kind === "posix") {
    return !left.isSymbolicLink && !right.isSymbolicLink && left.dev === right.dev && left.ino === right.ino;
  }
  return left.kind === "windows"
    && right.kind === "windows"
    && !left.isReparsePoint
    && !right.isReparsePoint
    && left.volumeSerial === right.volumeSerial
    && left.fileId === right.fileId;
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

type IdentityProbe =
  | { status: "confirmed"; identity: FileIdentity }
  | { status: "negative" }
  | { status: "unavailable" };

async function probeLiveDirectoryIdentity(path: string): Promise<IdentityProbe> {
  try {
    const canonical = await realpath(path);
    const info = await lstat(path);
    if (canonical !== path || !info.isDirectory() || info.isSymbolicLink()) return { status: "negative" };
  } catch (error) {
    return isMissingPathError(error) ? { status: "negative" } : { status: "unavailable" };
  }
  try {
    const identity = await createSecureStateBackend().fileIdentity(path);
    if (!identity?.isDirectory) return { status: "negative" };
    if (identity.kind === "posix" && identity.isSymbolicLink) return { status: "negative" };
    if (identity.kind === "windows" && identity.isReparsePoint) return { status: "negative" };
    return { status: "confirmed", identity };
  } catch {
    return { status: "unavailable" };
  }
}

async function captureLiveDirectoryIdentity(path: string): Promise<FileIdentity> {
  const probe = await probeLiveDirectoryIdentity(path);
  if (probe.status !== "confirmed") throw new Error("directory identity unavailable");
  return probe.identity;
}

async function isOwnedIdentityLive(deps: ManagedWorktreesDeps, record: ManagedWorktreeRecord): Promise<boolean> {
  const expected = ownedIdentitiesFor(deps).get(record.worktreeId);
  if (!expected) return false;
  try {
    const current = await captureLiveDirectoryIdentity(record.path);
    if (sameFileIdentity(expected, current)) return true;
    // Continuity was definitively disproved. Revoke permanently for this Host
    // process so a later OS identity reuse cannot resurrect delete authority.
    ownedIdentitiesFor(deps).delete(record.worktreeId);
    return false;
  } catch {
    ownedIdentitiesFor(deps).delete(record.worktreeId);
    return false;
  }
}

type WorktreeListResult =
  | { status: "available"; paths: ReadonlySet<string> }
  | { status: "unavailable" };

/**
 * List non-main, non-prunable live worktree checkout paths for a repository via
 * `git worktree list --porcelain -z`. Missing/symlink entries are filtered.
 * Runner failures are unavailable (never authoritative absence).
 */
async function listNonMainWorktreePaths(
  runner: ProcessRunner,
  repoRoot: string,
  limit: number,
): Promise<WorktreeListResult> {
  let out: string;
  try {
    out = await runChecked(runner, {
      command: "git",
      args: ["-C", repoRoot, "worktree", "list", "--porcelain", "-z"],
      maxOutputBytes: limit,
    });
  } catch {
    return { status: "unavailable" };
  }
  const paths: string[] = [];
  let current: {
    path?: string;
    prunable?: boolean;
    isMain?: boolean;
    headCount: number;
    stateCount: number;
    lockedCount: number;
    prunableCount: number;
  } | null = null;
  let worktreeIndex = 0;
  let sawWorktree = false;
  let malformed = false;
  const flush = () => {
    if (!current) return;
    if (!current.path || current.headCount !== 1 || current.stateCount !== 1 || current.lockedCount > 1 || current.prunableCount > 1) {
      malformed = true;
    } else if (!current.prunable && current.isMain === false) {
      paths.push(current.path);
    }
    current = null;
  };
  // With `-z`, each FIELD is NUL-terminated and records are separated by an
  // empty field (double NUL). Preserve empty tokens so record boundaries remain
  // authoritative; a missing final empty separator is truncated/unavailable.
  const fields = out.split("\0");
  if (fields.at(-1) !== "" || fields.at(-2) !== "") return { status: "unavailable" };
  for (const field of fields) {
    if (field === "") {
      flush();
      continue;
    }
    if (field.startsWith("worktree ")) {
      if (current) { malformed = true; flush(); }
      const path = field.slice("worktree ".length);
      current = {
        path,
        isMain: worktreeIndex === 0,
        headCount: 0,
        stateCount: 0,
        lockedCount: 0,
        prunableCount: 0,
      };
      worktreeIndex += 1;
      sawWorktree = true;
      if (!path) malformed = true;
      continue;
    }
    if (!current) { malformed = true; continue; }
    if (field.startsWith("HEAD ")) current.headCount += 1;
    else if (field.startsWith("branch ") || field === "detached" || field === "bare") current.stateCount += 1;
    else if (field === "locked" || field.startsWith("locked ")) current.lockedCount += 1;
    else if (field === "prunable" || field.startsWith("prunable ")) {
      current.prunable = true;
      current.prunableCount += 1;
    } else malformed = true;
  }
  if (current) malformed = true;
  if (!sawWorktree || malformed) return { status: "unavailable" };
  const existing = new Set<string>();
  for (const path of paths) {
    try {
      const info = await lstat(path);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        existing.add(await realpath(path));
      }
    } catch (error) {
      if (!isMissingPathError(error)) return { status: "unavailable" };
      /* confirmed stale entry */
    }
  }
  return { status: "available", paths: existing };
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

  const record: ManagedWorktreeRecord = {
    worktreeId,
    path: canonical,
    repoRoot,
    commonDir,
    adminDir,
    base,
    createdAt: capture.createdAt ?? new Date().toISOString(),
    source: MANAGED_WORKTREES_SOURCE,
    branchAtCreate,
    branchCreatedByPix: capture.branchCreatedByPix,
  };
  // POSIX stat identity remains optional audit metadata. Windows native file
  // identity is runtime-only; never persist Node's pseudo-POSIX dev/ino as
  // cross-restart authority or reject an otherwise valid record when it cannot
  // round-trip safely.
  const auditPairs: Array<[number, number, "path" | "repo" | "common" | "admin" | "base"]> = [
    [pathInfo.dev, pathInfo.ino, "path"],
    [repoInfo.dev, repoInfo.ino, "repo"],
    [commonInfo.dev, commonInfo.ino, "common"],
    [adminInfo.dev, adminInfo.ino, "admin"],
    [baseInfo.dev, baseInfo.ino, "base"],
  ];
  if (process.platform !== "win32") {
    for (const [dev, ino, kind] of auditPairs) {
      if (!Number.isSafeInteger(dev) || dev <= 0 || !Number.isSafeInteger(ino) || ino <= 0) continue;
      if (kind === "path") { record.dev = dev; record.ino = ino; }
      else if (kind === "repo") { record.repoDev = dev; record.repoIno = ino; }
      else if (kind === "common") { record.commonDev = dev; record.commonIno = ino; }
      else if (kind === "admin") { record.adminDev = dev; record.adminIno = ino; }
      else { record.baseDev = dev; record.baseIno = ino; }
    }
  }
  return record;
}

type Corroboration =
  | { status: "confirmed"; identity: FileIdentity }
  | { status: "negative" }
  | { status: "unavailable" };

type CheckedDirectoryIdentities = {
  path: FileIdentity;
  repoRoot: FileIdentity;
  commonDir: FileIdentity;
  adminDir: FileIdentity;
  base: FileIdentity;
};

async function captureRecordIdentities(record: ManagedWorktreeRecord): Promise<
  | { status: "confirmed"; identities: CheckedDirectoryIdentities }
  | { status: "negative" }
  | { status: "unavailable" }
> {
  const paths = [record.path, record.repoRoot, record.commonDir, record.adminDir, record.base] as const;
  const probes: IdentityProbe[] = [];
  for (const path of paths) probes.push(await probeLiveDirectoryIdentity(path));
  if (probes.some((probe) => probe.status === "unavailable")) return { status: "unavailable" };
  if (probes.some((probe) => probe.status === "negative")) return { status: "negative" };
  return {
    status: "confirmed",
    identities: {
      path: (probes[0] as { status: "confirmed"; identity: FileIdentity }).identity,
      repoRoot: (probes[1] as { status: "confirmed"; identity: FileIdentity }).identity,
      commonDir: (probes[2] as { status: "confirmed"; identity: FileIdentity }).identity,
      adminDir: (probes[3] as { status: "confirmed"; identity: FileIdentity }).identity,
      base: (probes[4] as { status: "confirmed"; identity: FileIdentity }).identity,
    },
  };
}

function sameRecordIdentities(left: CheckedDirectoryIdentities, right: CheckedDirectoryIdentities): boolean {
  return sameFileIdentity(left.path, right.path)
    && sameFileIdentity(left.repoRoot, right.repoRoot)
    && sameFileIdentity(left.commonDir, right.commonDir)
    && sameFileIdentity(left.adminDir, right.adminDir)
    && sameFileIdentity(left.base, right.base);
}

async function canonicalGitDirectory(
  runner: ProcessRunner,
  path: string,
  args: readonly string[],
  limit: number,
): Promise<string | null> {
  try {
    const raw = (await runChecked(runner, {
      command: "git",
      args: ["-C", path, ...args],
      maxOutputBytes: limit,
    })).trim();
    if (!raw) return null;
    return await realpath(raw);
  } catch {
    return null;
  }
}

/**
 * Corroborate a record against live path/repo/common/admin/base directories
 * and git topology. Mirror of Git/VS Code: restore on canonical path + git
 * `worktree list`, NOT on ledger inode/file ID (see
 * docs/ledger-identity-align.md). The per-directory check requires the path to
 * still be a REAL non-symlink directory; inode/volume-serial changes from a
 * clone/restore are tolerated as long as git still lists the worktree.
 */
async function corroborateRecord(deps: ManagedWorktreesDeps, record: ManagedWorktreeRecord): Promise<Corroboration> {
  if (dirname(record.commonDir) !== record.repoRoot) return { status: "negative" };
  if (record.base !== `${record.repoRoot}-worktrees`) return { status: "negative" };
  if (!isWithin(record.base, record.path) || record.path === record.base) return { status: "negative" };
  if (!isWithin(record.commonDir, record.adminDir)) return { status: "negative" };

  const beforeProbe = await captureRecordIdentities(record);
  if (beforeProbe.status !== "confirmed") return { status: beforeProbe.status };
  const before = beforeProbe.identities;

  const runner = runnerFor(deps);
  const limit = maxOutput(deps);
  const listed = await listNonMainWorktreePaths(runner, record.repoRoot, limit);
  if (listed.status === "unavailable") return { status: "unavailable" };
  if (!listed.paths.has(record.path)) return { status: "negative" };

  // Verify from the checkout as well as from the repository list. This proves
  // that the current directory is a linked worktree of the expected repo/admin
  // topology; it is not treated as persistent creation provenance.
  const commonDir = await canonicalGitDirectory(
    runner,
    record.path,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    limit,
  );
  const adminDir = await canonicalGitDirectory(
    runner,
    record.path,
    ["rev-parse", "--path-format=absolute", "--absolute-git-dir"],
    limit,
  );
  if (commonDir === null || adminDir === null) return { status: "unavailable" };
  if (commonDir !== record.commonDir || adminDir !== record.adminDir) return { status: "negative" };

  const afterProbe = await captureRecordIdentities(record);
  if (afterProbe.status !== "confirmed") return { status: "unavailable" };
  const after = afterProbe.identities;
  if (!sameRecordIdentities(before, after)) return { status: "unavailable" };
  return { status: "confirmed", identity: after.path };
}

async function publishWorkspaceAccess(
  deps: ManagedWorktreesDeps,
  record: ManagedWorktreeRecord,
  checkedIdentity: FileIdentity,
): Promise<void> {
  if (!deps.allowedRoots) return;
  await registerManagedAuthorizedRoot(deps.allowedRoots, {
    worktreeId: record.worktreeId,
    path: record.path,
    identity: checkedIdentity,
  });
  const afterPublish = await corroborateRecord(deps, record);
  if (afterPublish.status === "confirmed" && sameFileIdentity(checkedIdentity, afterPublish.identity)) return;
  await unregisterManagedAuthorizedRoot(deps.allowedRoots, record.worktreeId, record.path);
  throw new HttpError(409, "WORKTREE_CORROBORATION_CHANGED", "Worktree changed before authorization publication");
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
  const corroboration = await corroborateRecord(deps, record);
  if (corroboration.status !== "confirmed") {
    throw new HttpError(409, "WORKTREE_CORROBORATION_CHANGED", "Worktree changed before authorization publication");
  }
  await publishWorkspaceAccess(deps, record, corroboration.identity);
  // Publish DELETE authority only after access publication and the post-
  // publication corroboration both checked the same runtime identity.
  ownedIdentitiesFor(deps).set(record.worktreeId, corroboration.identity);
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
  if (removed) {
    ownedIdentitiesFor(deps).delete(worktreeId);
  }
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
  const corroboration = await corroborateRecord(deps, record);
  if (corroboration.status === "negative") {
    ownedIdentitiesFor(deps).delete(record.worktreeId);
    return { record, live: false };
  }
  return { record, live: corroboration.status === "confirmed" && await isOwnedIdentityLive(deps, record) };
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
 * - Topology-confirmed records restore workspace access only. Destructive
 *   ownership remains false after restart until an explicit future reclaim
 *   flow is approved.
 * - Stale records (path/topology definitively absent) are dropped only as exact
 *   records. Unavailable Git evidence is preserved without authorization.
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
      // Repository authority could not be checked. Preserve exact evidence but
      // never authorize it; an unavailable policy seam is not "foreign" or
      // authoritative proof that the record is stale.
      survivors.push(record);
      continue;
    }
    if (!managed) {
      preservedForeign += 1;
      survivors.push(record);
      continue;
    }
    const corroboration = await corroborateRecord(deps, record);
    if (corroboration.status === "confirmed") {
      // Path+Git restores workspace access only. Destructive ownership is a
      // current-process runtime token and is intentionally not recreated after
      // Host restart from reusable path/topology evidence.
      survivors.push(record);
      restored += 1;
      await publishWorkspaceAccess(deps, record, corroboration.identity);
    } else if (corroboration.status === "unavailable") {
      // Evidence could not be checked: preserve exact durable evidence but do
      // not authorize it. A transient Git/tool failure is not authoritative
      // proof that ownership ceased to exist.
      survivors.push(record);
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
