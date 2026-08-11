import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { HttpError } from "../errors.js";
import type { HostMode } from "../types.js";
import { AsyncMutex } from "./mutex.js";

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
interface RootIdentity { dev: number; ino: number }
interface TrustedClaim { path: string; identity: RootIdentity }
interface RootRecord { identity: RootIdentity }
interface RootState {
  /** Durable policy ownership, normalized so no path has a durable ancestor. */
  durableClaims: Map<string, RootIdentity>;
  /** Stable owner token → requested trusted-created root. Hidden claims are retained. */
  trustedClaims: Map<string, TrustedClaim>;
  /** Minimal effective authorization projection derived from all claims. */
  records: Map<string, RootRecord>;
  maxRoots: number;
  policy: AllowedRootPolicy;
  mutation: AsyncMutex;
}
export interface TrustedCreatedRootReceipt {
  canonicalPath: string;
  added: boolean;
  rollback(): Promise<void>;
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
async function canonicalDirectoryWithIdentity(value: string): Promise<{ canonical: string; identity: RootIdentity }> {
  const normalized = validateAbsolutePath(value);
  let canonical: string;
  try { canonical = await realpath(normalized); }
  catch { throw new HttpError(404, "PATH_NOT_FOUND", "Directory not found"); }
  const info = await lstat(canonical);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new HttpError(400, "NOT_DIRECTORY", "Path is not a real directory");
  return { canonical, identity: { dev: info.dev, ino: info.ino } };
}
async function identityStillMatches(path: string, expected: RootIdentity): Promise<boolean> {
  try {
    if (await realpath(path) !== path) return false;
    const current = await lstat(path);
    return current.isDirectory() && !current.isSymbolicLink() && current.dev === expected.dev && current.ino === expected.ino;
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
function sortedClaimPaths(durable: Map<string, RootIdentity>, trusted: Map<string, TrustedClaim>): string[] {
  return [...new Set([...durable.keys(), ...[...trusted.values()].map((claim) => claim.path)])]
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
}
function deriveRecords(durable: Map<string, RootIdentity>, trusted: Map<string, TrustedClaim>): Map<string, RootRecord> {
  const records = new Map<string, RootRecord>();
  for (const path of sortedClaimPaths(durable, trusted)) {
    if ([...records.keys()].some((ancestor) => isWithin(ancestor, path))) continue;
    const identity = durable.get(path) ?? [...trusted.values()].find((claim) => claim.path === path)?.identity;
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

/** Internal-only. Worktree routes call this while holding repo lock (repo→roots). */
export async function registerTrustedCreatedRoot(service: AllowedRootService, target: string): Promise<TrustedCreatedRootReceipt> {
  const candidate = await canonicalDirectoryWithIdentity(target);
  const state = stateFor(service);
  const owner = randomUUID();
  return state.mutation.runExclusive(async () => {
    await verifyAllClaims(state.durableClaims, state.trustedClaims);
    if (!(await identityStillMatches(candidate.canonical, candidate.identity))) throw new HttpError(409, "ROOT_IDENTITY_CHANGED", "Created root changed identity before registration");
    // A durable ancestor already grants permanent access: no temporary owner is needed.
    const durableAncestor = [...state.durableClaims.keys()].some((path) => isWithin(path, candidate.canonical));
    if (!durableAncestor) {
      const proposedTrusted = cloneTrusted(state.trustedClaims);
      proposedTrusted.set(owner, { path: candidate.canonical, identity: candidate.identity });
      const proposedRecords = deriveRecords(state.durableClaims, proposedTrusted);
      if (proposedRecords.size > state.maxRoots) throw new HttpError(429, "ROOT_LIMIT", "Allowed-root limit reached");
      state.trustedClaims = proposedTrusted;
      state.records = proposedRecords;
    }
    let rolledBack = false;
    return {
      canonicalPath: candidate.canonical,
      added: !durableAncestor,
      async rollback() {
        if (rolledBack) return;
        rolledBack = true;
        await state.mutation.runExclusive(async () => {
          // Durable promotion invalidates/removes this token; stale receipts are no-op.
          if (!state.trustedClaims.has(owner)) return;
          const proposedTrusted = cloneTrusted(state.trustedClaims);
          proposedTrusted.delete(owner);
          state.trustedClaims = proposedTrusted;
          state.records = deriveRecords(state.durableClaims, proposedTrusted);
        });
      },
    };
  });
}

export async function unregisterTrustedCreatedRoot(service: AllowedRootService, target: string): Promise<void> {
  const state = stateFor(service);
  const canonical = resolve(target);
  await state.mutation.runExclusive(async () => {
    try { await lstat(canonical); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return; }
    const proposedTrusted = cloneTrusted(state.trustedClaims);
    for (const [owner, claim] of proposedTrusted) if (claim.path === canonical) proposedTrusted.delete(owner);
    state.trustedClaims = proposedTrusted;
    state.records = deriveRecords(state.durableClaims, proposedTrusted);
  });
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
  const initialRecords = deriveRecords(durableClaims, new Map());
  if (initialRecords.size > maxRoots) throw new Error("Too many configured allowed roots");
  const state: RootState = { durableClaims, trustedClaims: new Map(), records: initialRecords, maxRoots, policy, mutation: new AsyncMutex() };

  async function authorizeExisting(target: string, kind: "any" | "file" | "directory" = "any"): Promise<AuthorizedPath> {
    const requestedPath = validateAbsolutePath(target);
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
          const proposedRecords = deriveRecords(proposedDurable, proposedTrusted);
          if (proposedRecords.size > maxRoots) throw new HttpError(429, "ROOT_LIMIT", "Allowed-root limit reached");
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
