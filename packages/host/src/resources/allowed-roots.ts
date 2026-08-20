import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createSecureStateBackend, type FileIdentity } from "@fffattiger/pix-local-authority/state";
import { HttpError } from "../errors.js";
import type { HostLogger, HostMode } from "../types.js";
import { AsyncMutex } from "./mutex.js";
import {
  TRUSTED_ROOTS_SOURCE,
  TrustedRootsLedgerError,
  type TrustedRootClaimRecord,
  type TrustedRootsLedger,
} from "./trusted-roots-ledger.js";

export interface AllowedRootPolicy {
  roots: readonly string[];
  allowLocalExpansion?: boolean;
  allowLanExpansion?: boolean;
  maxRoots?: number;
}
export interface AuthorizedPath { requestedPath: string; canonicalPath: string; root: string }
export interface RootExpansionResult { paths: readonly string[]; added: readonly string[] }
export interface RootExpansionPlan { readonly paths: readonly string[]; commit(): Promise<RootExpansionResult> }
export interface AllowedRootService {
  roots(): readonly string[];
  isAuthorized(target: string, kind?: "any" | "file" | "directory"): Promise<boolean>;
  authorizeExisting(target: string, kind?: "any" | "file" | "directory"): Promise<AuthorizedPath>;
  authorizeChild(parent: string, name: string): Promise<AuthorizedPath>;
  prepareExpansion(targets: readonly string[], mode: HostMode): Promise<RootExpansionPlan>;
  expandRoots(targets: readonly string[], mode: HostMode): Promise<RootExpansionResult>;
}
type RootIdentity = FileIdentity;
interface TrustedClaim {
  path: string;
  identity: RootIdentity;
  claimId: string;
  /** Present when claim carries durable worktree metadata (ledger-eligible). */
  repoRoot?: string;
  repoIdentity?: RootIdentity;
  base?: string;
  createdAt?: string;
  source?: typeof TRUSTED_ROOTS_SOURCE;
  branch?: string;
}
interface RootRecord { identity: RootIdentity }

/** Managed-worktree ownership claim (memory-only, published after disk commit). */
interface ManagedClaim {
  worktreeId: string;
  path: string;
  identity: RootIdentity;
}

interface RootState {
  /** Durable policy ownership, normalized so no path has a durable ancestor. */
  durableClaims: Map<string, RootIdentity>;
  /** Stable owner token → requested trusted-created root. Hidden claims are retained. */
  trustedClaims: Map<string, TrustedClaim>;
  /**
   * Managed-worktree ownership (worktreeId → claim). Memory-only publication
   * after the managed-worktrees ledger committed the record to disk; durable
   * root promotion must NOT erase managed ownership.
   */
  managedClaims: Map<string, ManagedClaim>;
  /** Minimal effective authorization projection derived from all claims. */
  records: Map<string, RootRecord>;
  maxRoots: number;
  policy: AllowedRootPolicy;
  mutation: AsyncMutex;
  /** Optional Host-owned ledger; when set, durable register/unregister await it. */
  ledger?: TrustedRootsLedger;
  logger?: HostLogger;
}
/**
 * Memory-only managed-worktree authorization input (already committed to the
 * managed-worktrees ledger on disk by the caller). `registerManagedAuthorizedRoot`
 * publishes it into the effective authorization projection without writing any
 * trusted-root ledger claim.
 */
export interface ManagedAuthorizedRootInput {
  worktreeId: string;
  path: string;
  /** Optional already-checked runtime identity; publication rechecks it. */
  identity?: RootIdentity;
}

export interface TrustedCreatedRootReceipt {
  canonicalPath: string;
  added: boolean;
  claimId?: string;
  rollback(): Promise<void>;
}

/** Durable registration input for Host-created linked worktrees. */
export interface TrustedCreatedRootInput {
  path: string;
  repoRoot: string;
  base: string;
  branch?: string;
  claimId?: string;
  createdAt?: string;
}

export interface TrustedClaimSnapshot {
  claimId: string;
  path: string;
  identity: RootIdentity;
  repoRoot?: string;
  repoIdentity?: RootIdentity;
  base?: string;
  createdAt?: string;
  branch?: string;
}

export interface RehydrateWorktreeEntry {
  path: string;
  isMain: boolean;
}

export interface RehydrateTrustedRootsOptions {
  /**
   * List non-prunable worktrees for a repository. Paths must be canonical real
   * directories. Used only as corroboration — never invents authorization.
   */
  listWorktrees(repoRoot: string): Promise<readonly RehydrateWorktreeEntry[]>;
}

export interface RehydrateTrustedRootsResult {
  restored: number;
  dropped: number;
  rewritten: boolean;
}

const states = new WeakMap<AllowedRootService, RootState>();

function isWithin(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}
function validateAbsolutePath(value: string): string {
  if (!value || value.includes("\0")) throw new HttpError(400, "INVALID_PATH", "Path is required and must not contain NUL bytes");
  if (!isAbsolute(value)) throw new HttpError(400, "INVALID_PATH", "Path must be absolute");
  return resolve(value);
}
function sameRootIdentity(left: RootIdentity, right: RootIdentity): boolean {
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

async function captureDirectoryIdentity(path: string): Promise<RootIdentity> {
  const backend = createSecureStateBackend();
  const identity = await backend.fileIdentity(path);
  if (!identity || !identity.isDirectory) throw new HttpError(400, "NOT_DIRECTORY", "Path is not a real directory");
  if (identity.kind === "posix" && identity.isSymbolicLink) throw new HttpError(400, "NOT_DIRECTORY", "Path is not a real directory");
  if (identity.kind === "windows" && identity.isReparsePoint) throw new HttpError(400, "NOT_DIRECTORY", "Path is not a real directory");
  return identity;
}

/** True when `path` is a real, non-symlink directory on the live filesystem. */
async function isRealDirectory(path: string): Promise<boolean> {
  try {
    if (await realpath(path) !== path) return false;
    // captureDirectoryIdentity additionally rejects a symlink/reparse leaf.
    await captureDirectoryIdentity(path);
    return true;
  } catch {
    return false;
  }
}

async function canonicalDirectoryWithIdentity(value: string): Promise<{ canonical: string; identity: RootIdentity }> {
  const normalized = validateAbsolutePath(value);
  let canonical: string;
  try { canonical = await realpath(normalized); }
  catch { throw new HttpError(404, "PATH_NOT_FOUND", "Directory not found"); }
  const identity = await captureDirectoryIdentity(canonical);
  return { canonical, identity };
}
async function identityStillMatches(path: string, expected: RootIdentity): Promise<boolean> {
  try {
    if (await realpath(path) !== path) return false;
    const current = await captureDirectoryIdentity(path);
    return sameRootIdentity(current, expected);
  } catch { return false; }
}
function validateChildName(name: string): void {
  if (!name || name === "." || name === ".." || name.includes("\0") || name.includes("/") || name.includes("\\")) throw new HttpError(400, "INVALID_FILE_NAME", "File name must be a single safe path segment");
}
function stateFor(service: AllowedRootService): RootState {
  const state = states.get(service);
  if (!state) throw new Error("Unknown AllowedRootService instance");
  return state;
}
function sortedClaimPaths(
  durable: Map<string, RootIdentity>,
  trusted: Map<string, TrustedClaim>,
  managed: Map<string, ManagedClaim> = new Map(),
): string[] {
  return [...new Set([
    ...durable.keys(),
    ...[...trusted.values()].map((claim) => claim.path),
    ...[...managed.values()].map((claim) => claim.path),
  ])]
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
}
function deriveRecords(
  durable: Map<string, RootIdentity>,
  trusted: Map<string, TrustedClaim>,
  managed: Map<string, ManagedClaim> = new Map(),
): Map<string, RootRecord> {
  const records = new Map<string, RootRecord>();
  for (const path of sortedClaimPaths(durable, trusted, managed)) {
    if ([...records.keys()].some((ancestor) => isWithin(ancestor, path))) continue;
    const identity = durable.get(path)
      ?? [...trusted.values()].find((claim) => claim.path === path)?.identity
      ?? [...managed.values()].find((claim) => claim.path === path)?.identity;
    if (identity) records.set(path, { identity });
  }
  return records;
}
function matchingRoot(records: Map<string, RootRecord>, canonical: string): string | null {
  let winner: string | null = null;
  for (const root of records.keys()) if (isWithin(root, canonical) && (!winner || root.length > winner.length)) winner = root;
  return winner;
}
async function verifyAllClaims(durable: Map<string, RootIdentity>, trusted: Map<string, TrustedClaim>): Promise<void> {
  for (const [path, identity] of durable) if (!(await identityStillMatches(path, identity))) throw new HttpError(403, "ROOT_REPLACED", "Allowed root was replaced after authorization");
  for (const claim of trusted.values()) if (!(await identityStillMatches(claim.path, claim.identity))) throw new HttpError(409, "ROOT_IDENTITY_CHANGED", "Trusted-created root changed identity");
}
function cloneDurable(source: Map<string, RootIdentity>): Map<string, RootIdentity> { return new Map(source); }
function cloneTrusted(source: Map<string, TrustedClaim>): Map<string, TrustedClaim> { return new Map(source); }

function hasDurableAncestor(durable: Map<string, RootIdentity>, path: string): boolean {
  return [...durable.keys()].some((ancestor) => isWithin(ancestor, path));
}

function claimToRecord(claim: TrustedClaim): TrustedRootClaimRecord | null {
  if (!claim.repoRoot || !claim.repoIdentity || !claim.base || !claim.createdAt || !claim.source) return null;
  const record: TrustedRootClaimRecord = {
    claimId: claim.claimId,
    path: claim.path,
    repoRoot: claim.repoRoot,
    base: claim.base,
    createdAt: claim.createdAt,
    source: TRUSTED_ROOTS_SOURCE,
  };
  // POSIX dev/ino remain bounded audit metadata. Windows volume/file identity
  // stays runtime-only and is intentionally not projected into the v1 ledger.
  if (process.platform !== "win32" && claim.identity.kind === "posix" && claim.repoIdentity.kind === "posix") {
    if (
      Number.isSafeInteger(claim.identity.dev) && claim.identity.dev > 0
      && Number.isSafeInteger(claim.identity.ino) && claim.identity.ino > 0
      && Number.isSafeInteger(claim.repoIdentity.dev) && claim.repoIdentity.dev > 0
      && Number.isSafeInteger(claim.repoIdentity.ino) && claim.repoIdentity.ino > 0
    ) {
      record.dev = claim.identity.dev;
      record.ino = claim.identity.ino;
      record.repoDev = claim.repoIdentity.dev;
      record.repoIno = claim.repoIdentity.ino;
    }
  }
  if (claim.branch !== undefined) record.branch = claim.branch;
  return record;
}

function recordsEqual(a: TrustedRootClaimRecord, b: TrustedRootClaimRecord): boolean {
  return a.claimId === b.claimId
    && a.path === b.path
    && a.dev === b.dev
    && a.ino === b.ino
    && a.repoRoot === b.repoRoot
    && a.repoDev === b.repoDev
    && a.repoIno === b.repoIno
    && a.base === b.base
    && a.createdAt === b.createdAt
    && a.source === b.source
    && a.branch === b.branch;
}

/**
 * Upsert exact new claim into the on-disk set under the ledger writer lock.
 * Preserves other Hosts' claims. Fail-closed on claimId/path collisions with
 * different content (never overwrite a foreign or divergent claim).
 */
function upsertLedgerClaim(
  disk: TrustedRootClaimRecord[],
  next: TrustedRootClaimRecord,
): TrustedRootClaimRecord[] {
  const byId = disk.find((item) => item.claimId === next.claimId);
  if (byId && !recordsEqual(byId, next)) {
    throw new HttpError(500, "TRUSTED_ROOT_PERSIST_FAILED", "Failed to persist trusted root claim");
  }
  const byPath = disk.find((item) => item.path === next.path && item.claimId !== next.claimId);
  if (byPath) {
    throw new HttpError(500, "TRUSTED_ROOT_PERSIST_FAILED", "Failed to persist trusted root claim");
  }
  if (byId) {
    return disk.map((item) => (item.claimId === next.claimId ? next : item));
  }
  return [...disk, next];
}

/** Remove only the exact owner claimId+path pair; retain every other disk claim. */
function removeExactLedgerClaim(
  disk: TrustedRootClaimRecord[],
  claimId: string,
  path: string,
): TrustedRootClaimRecord[] {
  return disk.filter((item) => !(item.claimId === claimId && item.path === path));
}

/** Remove all disk claims for a canonical path (stale owners); retain others. */
function removeLedgerClaimsByPath(
  disk: TrustedRootClaimRecord[],
  path: string,
): TrustedRootClaimRecord[] {
  return disk.filter((item) => item.path !== path);
}

/** Remove disk claims absorbed under newly durable roots; retain others. */
function removeLedgerClaimsUnderRoots(
  disk: TrustedRootClaimRecord[],
  roots: readonly string[],
): TrustedRootClaimRecord[] {
  return disk.filter((item) => !roots.some((root) => isWithin(root, item.path)));
}

/**
 * Rehydrate rewrite under ledger RMW lock.
 *
 * Input snapshot IDs bound the rewrite; concurrent unknown IDs stay on disk.
 * Survivors may only be written back when the same claimId still exists on
 * current disk with content exactly equal to the input snapshot (no resurrection
 * of concurrent deletes; no overwrite of concurrent content changes).
 * Dropped input IDs are removed only when current disk still exact-equals the
 * input record; if content changed, keep current and do not touch.
 * Returns the survivors that were actually committed (for memory authorization).
 */
function rewriteLedgerForRehydrate(
  disk: TrustedRootClaimRecord[],
  inputById: ReadonlyMap<string, TrustedRootClaimRecord>,
  candidateSurvivors: readonly TrustedRootClaimRecord[],
): { next: TrustedRootClaimRecord[]; committedSurvivors: TrustedRootClaimRecord[] } {
  const diskById = new Map(disk.map((item) => [item.claimId, item]));
  const candidateById = new Map(candidateSurvivors.map((item) => [item.claimId, item]));
  const committedSurvivors: TrustedRootClaimRecord[] = [];
  const dropExactIds = new Set<string>();

  for (const [claimId, input] of inputById) {
    const current = diskById.get(claimId);
    if (!current) {
      // Concurrent delete (or never present): never re-add, never authorize.
      continue;
    }
    if (!recordsEqual(current, input)) {
      // Content diverged under another Host: fail closed — keep current, do not authorize.
      throw new HttpError(500, "TRUSTED_ROOT_PERSIST_FAILED", "Failed to persist trusted root claim");
    }
    const survivor = candidateById.get(claimId);
    if (survivor) {
      // Exact match still on disk and gated: keep as committed survivor (no rewrite needed).
      committedSurvivors.push(current);
    } else {
      // Gated-drop: only remove when current still exact-equals the input snapshot.
      dropExactIds.add(claimId);
    }
  }

  const committedPaths = new Set(committedSurvivors.map((item) => item.path));
  const retained: TrustedRootClaimRecord[] = [];
  for (const item of disk) {
    if (dropExactIds.has(item.claimId)) continue;
    if (inputById.has(item.claimId)) {
      // Input ID still present and exact — keep the disk row (committed survivor).
      retained.push(item);
      continue;
    }
    // Concurrent unknown claim: keep, but fail closed on path clash with committed survivors.
    if (committedPaths.has(item.path)) {
      throw new HttpError(500, "TRUSTED_ROOT_PERSIST_FAILED", "Failed to persist trusted root claim");
    }
    retained.push(item);
  }
  return { next: retained, committedSurvivors };
}

/** Attach a Host-owned ledger for durable trusted claims. Internal composition only. */
export function attachTrustedRootsLedger(
  service: AllowedRootService,
  ledger: TrustedRootsLedger,
  logger?: HostLogger,
): void {
  const state = stateFor(service);
  state.ledger = ledger;
  if (logger) state.logger = logger;
}

/** Internal snapshot of in-memory trusted claims (not exported to Client). */
export function listTrustedCreatedRoots(service: AllowedRootService): readonly TrustedClaimSnapshot[] {
  const state = stateFor(service);
  return [...state.trustedClaims.values()].map((claim) => {
    const snap: TrustedClaimSnapshot = {
      claimId: claim.claimId,
      path: claim.path,
      identity: { ...claim.identity },
    };
    if (claim.repoRoot !== undefined) snap.repoRoot = claim.repoRoot;
    if (claim.repoIdentity !== undefined) snap.repoIdentity = { ...claim.repoIdentity };
    if (claim.base !== undefined) snap.base = claim.base;
    if (claim.createdAt !== undefined) snap.createdAt = claim.createdAt;
    if (claim.branch !== undefined) snap.branch = claim.branch;
    return snap;
  });
}

function normalizeRegisterInput(target: string | TrustedCreatedRootInput): TrustedCreatedRootInput {
  if (typeof target === "string") return { path: target, repoRoot: "", base: "" };
  return target;
}

/**
 * Internal managed-worktree seam. Publishes managed-worktree ownership into
 * memory ONLY (never writes a trusted-root ledger claim — no double-write).
 * The managed-worktrees ledger MUST have already committed the ownership
 * record to disk before this is called (disk before memory). Durable root
 * promotion never erases managed claims.
 */
export async function registerManagedAuthorizedRoot(
  service: AllowedRootService,
  input: ManagedAuthorizedRootInput,
): Promise<void> {
  const state = stateFor(service);
  const liveIdentity = await captureDirectoryIdentity(input.path);
  if (input.identity && !sameRootIdentity(input.identity, liveIdentity)) {
    throw new HttpError(409, "ROOT_IDENTITY_CHANGED", "Managed worktree changed identity before authorization");
  }
  await state.mutation.runExclusive(() => {
    state.managedClaims.set(input.worktreeId, {
      worktreeId: input.worktreeId,
      path: input.path,
      identity: liveIdentity,
    });
    state.records = deriveRecords(state.durableClaims, state.trustedClaims, state.managedClaims);
  });
}

/**
 * Internal managed-worktree seam. Removes only the exact managed claim
 * (worktreeId + path); a mismatched path is never removed. Memory-only — the
 * managed-worktrees ledger removal is the caller's disk step.
 */
export async function unregisterManagedAuthorizedRoot(
  service: AllowedRootService,
  worktreeId: string,
  path: string,
): Promise<void> {
  const state = stateFor(service);
  await state.mutation.runExclusive(() => {
    const existing = state.managedClaims.get(worktreeId);
    if (!existing || existing.path !== path) return;
    const proposed = new Map(state.managedClaims);
    proposed.delete(worktreeId);
    state.managedClaims = proposed;
    state.records = deriveRecords(state.durableClaims, state.trustedClaims, proposed);
  });
}

/** Internal-only. Worktree routes call this while holding repo lock (repo→roots). */
export async function registerTrustedCreatedRoot(
  service: AllowedRootService,
  target: string | TrustedCreatedRootInput,
): Promise<TrustedCreatedRootReceipt> {
  const input = normalizeRegisterInput(target);
  const candidate = await canonicalDirectoryWithIdentity(input.path);
  const state = stateFor(service);
  const owner = input.claimId ?? randomUUID();
  const durableMeta = input.repoRoot !== "" && input.base !== "";

  let repoCanonical: string | undefined;
  let repoIdentity: RootIdentity | undefined;
  let baseCanonical: string | undefined;
  if (durableMeta) {
    const repo = await canonicalDirectoryWithIdentity(input.repoRoot);
    repoCanonical = repo.canonical;
    repoIdentity = repo.identity;
    const base = await canonicalDirectoryWithIdentity(input.base);
    baseCanonical = base.canonical;
    const expectedBase = resolve(`${repoCanonical}-worktrees`);
    if (baseCanonical !== expectedBase) {
      throw new HttpError(409, "UNSAFE_WORKTREE_BASE", "Worktree base must be the repository-linked base");
    }
    if (!isWithin(baseCanonical, candidate.canonical) || candidate.canonical === baseCanonical) {
      throw new HttpError(409, "UNSAFE_WORKTREE_TARGET", "Worktree target must be strictly inside its base");
    }
  }

  return state.mutation.runExclusive(async () => {
    await verifyAllClaims(state.durableClaims, state.trustedClaims);
    if (!(await identityStillMatches(candidate.canonical, candidate.identity))) {
      throw new HttpError(409, "ROOT_IDENTITY_CHANGED", "Created root changed identity before registration");
    }
    // A durable ancestor already grants permanent access: no temporary owner is needed.
    const durableAncestor = hasDurableAncestor(state.durableClaims, candidate.canonical);
    if (!durableAncestor) {
      const proposedTrusted = cloneTrusted(state.trustedClaims);
      const claim: TrustedClaim = {
        path: candidate.canonical,
        identity: candidate.identity,
        claimId: owner,
      };
      if (durableMeta && repoCanonical && repoIdentity && baseCanonical) {
        claim.repoRoot = repoCanonical;
        claim.repoIdentity = repoIdentity;
        claim.base = baseCanonical;
        claim.createdAt = input.createdAt ?? new Date().toISOString();
        claim.source = TRUSTED_ROOTS_SOURCE;
        if (input.branch !== undefined) claim.branch = input.branch;
      }
      proposedTrusted.set(owner, claim);
      const proposedRecords = deriveRecords(state.durableClaims, proposedTrusted, state.managedClaims);
      if (proposedRecords.size > state.maxRoots) throw new HttpError(429, "ROOT_LIMIT", "Allowed-root limit reached");
      // Persist before publishing memory when a ledger is attached and the claim is ledger-eligible.
      // RMW under ledger lock: upsert only this claim; preserve other Hosts' disk claims.
      if (state.ledger && durableMeta) {
        const record = claimToRecord(claim);
        if (!record) {
          throw new HttpError(500, "TRUSTED_ROOT_PERSIST_FAILED", "Failed to persist trusted root claim");
        }
        try {
          await state.ledger.update((disk) => upsertLedgerClaim(disk, record));
        } catch (error) {
          state.logger?.warn?.("trusted-roots ledger", { code: "LEDGER_WRITE_FAILED" });
          if (error instanceof HttpError) throw error;
          throw new HttpError(500, "TRUSTED_ROOT_PERSIST_FAILED", "Failed to persist trusted root claim");
        }
      }
      state.trustedClaims = proposedTrusted;
      state.records = proposedRecords;
    }
    let rolledBack = false;
    const receipt: TrustedCreatedRootReceipt = {
      canonicalPath: candidate.canonical,
      added: !durableAncestor,
      async rollback() {
        if (rolledBack) return;
        rolledBack = true;
        await state.mutation.runExclusive(async () => {
          // Durable promotion invalidates/removes this token; stale receipts are no-op.
          if (!state.trustedClaims.has(owner)) return;
          const existing = state.trustedClaims.get(owner);
          const proposedTrusted = cloneTrusted(state.trustedClaims);
          proposedTrusted.delete(owner);
          // Remove only exact owner claimId+path from disk; never delete another Host's claim.
          if (state.ledger && durableMeta && existing) {
            try {
              await state.ledger.update((disk) => removeExactLedgerClaim(disk, owner, existing.path));
            } catch {
              state.logger?.warn?.("trusted-roots ledger", { code: "LEDGER_WRITE_FAILED" });
            }
          }
          state.trustedClaims = proposedTrusted;
          state.records = deriveRecords(state.durableClaims, proposedTrusted, state.managedClaims);
        });
      },
    };
    if (!durableAncestor) receipt.claimId = owner;
    return receipt;
  });
}

export async function unregisterTrustedCreatedRoot(service: AllowedRootService, target: string): Promise<void> {
  const state = stateFor(service);
  const canonical = resolve(target);
  await state.mutation.runExclusive(async () => {
    // Existing semantics: only drop when the path is already gone (ENOENT).
    // Worktree delete calls this after git remove succeeds, so the path is gone.
    try {
      await lstat(canonical);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    // Always strip local memory matches first (even if 0). Ledger RMW still runs
    // when attached so a remote Host can drop another Host's stale path claim.
    const proposedTrusted = cloneTrusted(state.trustedClaims);
    for (const [owner, claim] of proposedTrusted) {
      if (claim.path === canonical) proposedTrusted.delete(owner);
    }
    if (state.ledger) {
      try {
        // Drop every disk record for this path (stale owners), keep other Hosts' claims.
        await state.ledger.update((disk) => removeLedgerClaimsByPath(disk, canonical));
      } catch {
        // Memory must not keep the claim (git worktree is gone). Stale ledger
        // entries are dropped on rehydrate via git corroboration. Honest log only.
        state.logger?.warn?.("trusted-roots ledger", { code: "LEDGER_WRITE_FAILED" });
      }
    }
    state.trustedClaims = proposedTrusted;
    state.records = deriveRecords(state.durableClaims, proposedTrusted, state.managedClaims);
  });
}

/**
 * Rehydrate trusted claims from a fail-closed ledger snapshot.
 * Restores trusted claims only (never upgrades durable policy). sessiond-independent.
 *
 * Fail-closed: any ledger read/rewrite failure, capacity overflow (maxRoots
 * lowered below the on-disk claim count) or claim conflict THROWS so startup
 * fails with a fixed sanitized error and the on-disk evidence is preserved
 * (never destructively emptied). Foreign peer claims (repoRoot outside this
 * Host's durable policy) are preserved untouched and never authorized.
 */
export async function rehydrateTrustedCreatedRoots(
  service: AllowedRootService,
  stored: readonly TrustedRootClaimRecord[],
  options: RehydrateTrustedRootsOptions,
): Promise<RehydrateTrustedRootsResult> {
  const state = stateFor(service);
  const survivors: TrustedRootClaimRecord[] = [];
  let dropped = 0;

  // Corroboration cache per repoRoot.
  const listedByRepo = new Map<string, Promise<ReadonlySet<string>>>();

  async function listedPathsFor(repoRoot: string): Promise<ReadonlySet<string>> {
    const cached = listedByRepo.get(repoRoot);
    if (cached) return cached;
    // A failed Git corroboration is unavailable, not authoritative absence:
    // reject rehydrate so the startup path preserves the ledger unchanged and
    // publishes no new memory authorization.
    const pending = options.listWorktrees(repoRoot).then((entries) => {
      const set = new Set<string>();
      for (const entry of entries) {
        if (!entry.isMain) set.add(entry.path);
      }
      return set as ReadonlySet<string>;
    });
    listedByRepo.set(repoRoot, pending);
    return pending;
  }

  async function durableAuthorizes(path: string): Promise<boolean> {
    // Only durable policy may corroborate repoRoot — never pending trusted claims.
    for (const [root, identity] of state.durableClaims) {
      if (!isWithin(root, path)) continue;
      if (await identityStillMatches(root, identity)) return true;
    }
    return false;
  }

  async function gate(record: TrustedRootClaimRecord): Promise<boolean> {
    // Absolute canonical shapes (ledger parse already checks; re-check resolve identity).
    if (resolve(record.path) !== record.path || resolve(record.repoRoot) !== record.repoRoot || resolve(record.base) !== record.base) {
      return false;
    }
    // Path/repo/base must still be REAL non-symlink directories on the live fs.
    // We deliberately do NOT require their ledger inode/file ID to match: after
    // a clone/copy/restore the inode changes while the canonical path is the
    // same Git worktree, and mature tools restore on path + git topology, not
    // inode. See docs/ledger-identity-align.md.
    if (!(await isRealDirectory(record.path))) return false;
    if (!(await isRealDirectory(record.repoRoot))) return false;
    // repoRoot still in current durable policy
    if (!(await durableAuthorizes(record.repoRoot))) return false;
    // base exact `${repoRoot}-worktrees` canonical real dir non-symlink
    const expectedBase = resolve(`${record.repoRoot}-worktrees`);
    if (record.base !== expectedBase) return false;
    if (!(await isRealDirectory(record.base))) return false;
    // path strictly inside base
    if (!isWithin(record.base, record.path) || record.path === record.base) return false;
    // git worktree list contains path, non-main (prunable already filtered by list)
    const listed = await listedPathsFor(record.repoRoot);
    if (!listed.has(record.path)) return false;
    return true;
  }

  // Validate outside the mutation mutex (IO); memory commit only after RMW decides
  // committedSurvivors (never authorize a concurrent-deleted or content-changed claim).
  // Input snapshot IDs bound the rehydrate rewrite — concurrent unknown IDs stay on disk.
  const inputById = new Map(stored.map((record) => [record.claimId, record]));
  const acceptedById = new Map<string, TrustedClaim>();
  for (const record of stored) {
    if (!(await gate(record))) {
      dropped += 1;
      continue;
    }
    acceptedById.set(record.claimId, {
      path: record.path,
      identity: await captureDirectoryIdentity(record.path),
      claimId: record.claimId,
      repoRoot: record.repoRoot,
      repoIdentity: await captureDirectoryIdentity(record.repoRoot),
      base: record.base,
      createdAt: record.createdAt,
      source: TRUSTED_ROOTS_SOURCE,
      ...(record.branch !== undefined ? { branch: record.branch } : {}),
    });
    survivors.push(record);
  }

  let rewritten = false;
  let restored = 0;
  await state.mutation.runExclusive(async () => {
    // Durable ancestor absorbs a candidate: treat as drop (do not re-write as trusted claim).
    const candidateSurvivors: TrustedRootClaimRecord[] = [];
    for (const record of survivors) {
      if (hasDurableAncestor(state.durableClaims, record.path)) {
        dropped += 1;
        acceptedById.delete(record.claimId);
        continue;
      }
      candidateSurvivors.push(record);
    }
    survivors.length = 0;
    survivors.push(...candidateSurvivors);

    // Capacity gate on proposed projection (using candidate survivors) before any disk/memory publish.
    // A lowered maxRoots must FAIL, never destructively empty the on-disk evidence.
    const capacityProbe = cloneTrusted(state.trustedClaims);
    for (const claim of acceptedById.values()) capacityProbe.set(claim.claimId, claim);
    const capacityRecords = deriveRecords(state.durableClaims, capacityProbe, state.managedClaims);
    if (capacityRecords.size > state.maxRoots) {
      throw new TrustedRootsLedgerError("LEDGER_OVERSIZE", "Trusted-roots claim capacity exceeded");
    }

    let committedSurvivors: TrustedRootClaimRecord[] = [];
    if (state.ledger) {
      // Only claims whose repoRoot THIS Host durably authorizes (this Host is
      // the corroboration authority for that repo) bound the rehydrate rewrite.
      // Foreign peer claims (different repoRoot outside this Host's durable
      // policy) are preserved on disk untouched — another Host owns them, so
      // we neither authorize them in memory nor drop them. Without this guard,
      // one Host's boot would rewrite away another Host's durable claims from
      // the shared ledger (multi-Host disjoint-config data loss).
      const corroborableById = new Map<string, TrustedRootClaimRecord>();
      for (const [claimId, record] of inputById) {
        if (await durableAuthorizes(record.repoRoot)) corroborableById.set(claimId, record);
      }
      // RMW decides which survivors still exact-exist on current disk.
      // Memory authorization is deferred until after this decision. Any
      // read/rewrite failure (corrupt ledger, write failure, conflict) throws
      // so startup fails closed with the on-disk evidence untouched.
      await state.ledger.update((disk) => {
        const result = rewriteLedgerForRehydrate(disk, corroborableById, survivors);
        committedSurvivors = result.committedSurvivors;
        return result.next;
      });
      rewritten = true;
    } else {
      // No ledger attached: authorize gated candidates in memory only (legacy path).
      committedSurvivors = [...survivors];
    }

    // Publish only truly committed survivors into memory.
    const proposedTrusted = cloneTrusted(state.trustedClaims);
    for (const record of committedSurvivors) {
      const claim = acceptedById.get(record.claimId);
      if (claim) proposedTrusted.set(claim.claimId, claim);
    }
    state.trustedClaims = proposedTrusted;
    state.records = deriveRecords(state.durableClaims, proposedTrusted, state.managedClaims);
    survivors.length = 0;
    survivors.push(...committedSurvivors);
    restored = committedSurvivors.length;
  });

  return { restored, dropped, rewritten };
}

export async function createAllowedRootService(policy: AllowedRootPolicy): Promise<AllowedRootService> {
  const maxRoots = policy.maxRoots ?? 128;
  if (!Number.isInteger(maxRoots) || maxRoots < 1) throw new Error("maxRoots must be a positive integer");
  const durableClaims = new Map<string, RootIdentity>();
  for (const root of policy.roots) {
    const candidate = await canonicalDirectoryWithIdentity(root);
    // Configured roots are normalized parent-first too.
    if ([...durableClaims.keys()].some((ancestor) => isWithin(ancestor, candidate.canonical))) continue;
    for (const path of [...durableClaims.keys()]) if (isWithin(candidate.canonical, path)) durableClaims.delete(path);
    durableClaims.set(candidate.canonical, candidate.identity);
  }
  const initialRecords = deriveRecords(durableClaims, new Map(), new Map());
  if (initialRecords.size > maxRoots) throw new Error("Too many configured allowed roots");
  const state: RootState = { durableClaims, trustedClaims: new Map(), managedClaims: new Map(), records: initialRecords, maxRoots, policy, mutation: new AsyncMutex() };

  async function authorizeExisting(target: string, kind: "any" | "file" | "directory" = "any"): Promise<AuthorizedPath> {
    const requestedPath = validateAbsolutePath(target);
    // Workspace aliases (symlinks on POSIX, junctions/reparse points on
    // Windows) are allowed as long as their CANONICAL target is inside an
    // authorized root. Security is enforced here on the canonical path:
    //  - `realpath` resolves every alias to its true target;
    //  - `matchingRoot` rejects a canonical target outside all authorized roots
    //    (an alias that escapes is PATH_FORBIDDEN);
    //  - `identityStillMatches` rejects a root whose directory identity changed
    //    (including a reparse created at the root path);
    //  - callers operate on the returned canonicalPath with O_NOFOLLOW, so a
    //    later swap cannot redirect the actual file operation.
    // This makes Windows consistent with POSIX (which never rejected symlink
    // ancestors) and removes the platform overlay that误杀ed legal in-root
    // junctions/OneDrive aliases. Private Pix-owned secure-state still rejects
    // reparse/symlink ancestors in its own seam.
    let canonicalPath: string;
    try { canonicalPath = await realpath(requestedPath); } catch { throw new HttpError(404, "PATH_NOT_FOUND", "Path not found"); }
    const root = matchingRoot(state.records, canonicalPath);
    if (!root) throw new HttpError(403, "PATH_FORBIDDEN", "Path is outside the allowed roots");
    const record = state.records.get(root);
    if (!record || !(await identityStillMatches(root, record.identity))) throw new HttpError(403, "ROOT_REPLACED", "Allowed root was replaced after authorization");
    const info = await lstat(canonicalPath);
    if (kind === "file" && !info.isFile()) throw new HttpError(400, "NOT_FILE", "Path is not a file");
    if (kind === "directory" && !info.isDirectory()) throw new HttpError(400, "NOT_DIRECTORY", "Path is not a directory");
    return { requestedPath, canonicalPath, root };
  }

  async function authorizeChild(parent: string, name: string): Promise<AuthorizedPath> {
    validateChildName(name);
    const authorizedParent = await authorizeExisting(parent, "directory");
    const requestedPath = resolve(authorizedParent.canonicalPath, name);
    if (!isWithin(authorizedParent.root, requestedPath)) throw new HttpError(403, "PATH_FORBIDDEN", "Upload target escapes the allowed root");
    try {
      const info = await lstat(requestedPath);
      if (info.isSymbolicLink() || !info.isFile()) throw new HttpError(409, "UNSAFE_TARGET", "Only regular file targets can be replaced");
      const canonicalPath = await realpath(requestedPath);
      if (!isWithin(authorizedParent.root, canonicalPath)) throw new HttpError(403, "PATH_FORBIDDEN", "Upload target escapes the allowed root");
      return { requestedPath, canonicalPath, root: authorizedParent.root };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const canonicalParent = await realpath(dirname(requestedPath));
    if (canonicalParent !== authorizedParent.canonicalPath || !isWithin(authorizedParent.root, canonicalParent)) throw new HttpError(403, "PATH_FORBIDDEN", "Upload parent changed during authorization");
    return { requestedPath, canonicalPath: requestedPath, root: authorizedParent.root };
  }

  async function prepareExpansion(targets: readonly string[], mode: HostMode): Promise<RootExpansionPlan> {
    // Canonicalization occurs outside the mutation mutex by design.
    const candidates = await Promise.all(targets.map(canonicalDirectoryWithIdentity));
    let committed = false;
    return {
      paths: candidates.map((candidate) => candidate.canonical),
      async commit() {
        return state.mutation.runExclusive(async () => {
          if (committed) throw new HttpError(409, "EXPANSION_ALREADY_COMMITTED", "Root expansion was already committed");
          await verifyAllClaims(state.durableClaims, state.trustedClaims);
          for (const candidate of candidates) if (!(await identityStillMatches(candidate.canonical, candidate.identity))) throw new HttpError(409, "ROOT_IDENTITY_CHANGED", "Directory changed identity during root expansion");
          const proposedDurable = cloneDurable(state.durableClaims);
          const proposedTrusted = cloneTrusted(state.trustedClaims);
          let changed = false;
          for (const candidate of [...candidates].sort((a, b) => a.canonical.length - b.canonical.length || a.canonical.localeCompare(b.canonical))) {
            if ([...proposedDurable.keys()].some((ancestor) => isWithin(ancestor, candidate.canonical))) continue;
            changed = true;
            // Durable parent promotion removes redundant durable descendants.
            for (const path of [...proposedDurable.keys()]) if (isWithin(candidate.canonical, path)) proposedDurable.delete(path);
            proposedDurable.set(candidate.canonical, candidate.identity);
            // Durable parent permanently absorbs descendant trusted claims;
            // their old receipts become bounded no-op handles.
            for (const [owner, claim] of proposedTrusted) if (isWithin(candidate.canonical, claim.path)) proposedTrusted.delete(owner);
          }
          if (changed) {
            const permitted = mode === "local" ? policy.allowLocalExpansion === true : policy.allowLanExpansion === true;
            if (!permitted) throw new HttpError(403, "ROOT_EXPANSION_DISABLED", "Directory expansion is disabled by host policy");
          }
          const proposedRecords = deriveRecords(proposedDurable, proposedTrusted, state.managedClaims);
          if (proposedRecords.size > maxRoots) throw new HttpError(429, "ROOT_LIMIT", "Allowed-root limit reached");
          // Persist trusted-claim absorption when a ledger is attached.
          // RMW: remove only claims under newly durable roots; preserve other Hosts' claims.
          if (changed && state.ledger) {
            const absorbedRoots = candidates.map((candidate) => candidate.canonical);
            try {
              await state.ledger.update((disk) => removeLedgerClaimsUnderRoots(disk, absorbedRoots));
            } catch {
              state.logger?.warn?.("trusted-roots ledger", { code: "LEDGER_WRITE_FAILED" });
              throw new HttpError(500, "TRUSTED_ROOT_PERSIST_FAILED", "Failed to persist trusted root claim");
            }
          }
          const before = new Set(state.records.keys());
          const added = [...proposedRecords.keys()].filter((path) => !before.has(path));
          state.durableClaims = proposedDurable;
          state.trustedClaims = proposedTrusted;
          state.records = proposedRecords;
          committed = true;
          return { paths: candidates.map((candidate) => candidate.canonical), added };
        });
      },
    };
  }
  async function expandRoots(targets: readonly string[], mode: HostMode): Promise<RootExpansionResult> {
    if (targets.length === 0) return { paths: [], added: [] };
    return (await prepareExpansion(targets, mode)).commit();
  }
  const service: AllowedRootService = {
    roots: () => Object.freeze([...state.records.keys()].sort()),
    async isAuthorized(target, kind = "any") { try { await authorizeExisting(target, kind); return true; } catch { return false; } },
    authorizeExisting,
    authorizeChild,
    prepareExpansion,
    expandRoots,
  };
  states.set(service, state);
  return service;
}

export const pathContainment = { isWithin, validateAbsolutePath, validateChildName };
