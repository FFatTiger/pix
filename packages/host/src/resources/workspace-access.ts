/**
 * Host-owned workspace-access classifier (Lifecycle Repair Phase 6A).
 *
 * AllowedRoots is the path-safety authority. Session catalog visibility is
 * NOT authorization: listing a JSONL row never grants live models/files/
 * skills/send, never expands roots, and never mutates the root set.
 *
 * Classification is exact over cwd AND projectRoot:
 *   authorized    — both resolve to real, identity-stable directories inside
 *                   the current AllowedRoots (canonical path + root identity)
 *   history_only  — both paths are resolvable live directories, but at least
 *                   one is outside the current roots or is a symlink escape
 *   unavailable   — malformed, missing, deleted, unreadable, unresolvable,
 *                   or a fail-closed identity race (ROOT_REPLACED, including
 *                   an exact registered root replaced by a symlink). Ordinary
 *                   leaf symlink escape stays history_only.
 *
 * Fail-closed lattice: unavailable > history_only > authorized. The
 * classifier reuses {@link pathContainment} and {@link AllowedRootService}
 * authorizeExisting; it never calls expandRoots/prepareExpansion and never
 * follows a symlink as a live root. Adapter-supplied `workspaceAccess` is
 * ignored — Host always overwrites from this classifier.
 *
 * Vocabulary owner is Runtime Core; Protocol is the wire projection. Host
 * consumes `@fffattiger/pix-protocol/workspace-access` and MUST NOT redeclare
 * the state/reason arrays or DTO. Cross-package tests pin core↔protocol.
 */
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  WORKSPACE_ACCESS_REASONS,
  WORKSPACE_ACCESS_STATES,
  type WorkspaceAccess,
  type WorkspaceAccessReason,
  type WorkspaceAccessState,
} from "@fffattiger/pix-protocol/workspace-access";
import { HttpError } from "../errors.js";
import {
  pathContainment,
  type AllowedRootService,
} from "./allowed-roots.js";

export {
  WORKSPACE_ACCESS_REASONS,
  WORKSPACE_ACCESS_STATES,
};
export type {
  WorkspaceAccess,
  WorkspaceAccessReason,
  WorkspaceAccessState,
};

const STATE_RANK: Readonly<Record<WorkspaceAccessState, number>> = {
  authorized: 0,
  history_only: 1,
  unavailable: 2,
};

const UNAVAILABLE_REASON_RANK: Readonly<Record<string, number>> = {
  missing: 0,
  deleted: 1,
  unreadable: 2,
  unresolvable: 3,
  malformed: 4,
};

function combine(left: WorkspaceAccess, right: WorkspaceAccess): WorkspaceAccess {
  if (left.state !== right.state) {
    return STATE_RANK[left.state] >= STATE_RANK[right.state] ? left : right;
  }
  if (left.state === "history_only") {
    if (left.reason === "symlink_escape" || right.reason === "symlink_escape") {
      return { state: "history_only", reason: "symlink_escape" };
    }
    return left;
  }
  if (left.state === "unavailable") {
    const leftRank = UNAVAILABLE_REASON_RANK[left.reason] ?? 0;
    const rightRank = UNAVAILABLE_REASON_RANK[right.reason] ?? 0;
    return rightRank > leftRank ? right : left;
  }
  return left;
}

function errnoCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const value = (error as { code?: unknown }).code;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function normalizeAbsolute(value: unknown): { ok: true; path: string } | { ok: false; access: WorkspaceAccess } {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    return { ok: false, access: { state: "unavailable", reason: "malformed" } };
  }
  try {
    return { ok: true, path: pathContainment.validateAbsolutePath(value) };
  } catch {
    return { ok: false, access: { state: "unavailable", reason: "malformed" } };
  }
}

function mapStatFailure(error: unknown, afterObserve: boolean): WorkspaceAccess {
  const code = errnoCode(error);
  if (code === "ENOENT") {
    return { state: "unavailable", reason: afterObserve ? "deleted" : "missing" };
  }
  if (code === "EACCES" || code === "EPERM") {
    return { state: "unavailable", reason: "unreadable" };
  }
  return { state: "unavailable", reason: "unresolvable" };
}

async function resolveLiveDirectory(
  normalized: string,
): Promise<{ ok: true; canonical: string } | { ok: false; access: WorkspaceAccess }> {
  let canonical: string;
  try {
    canonical = await realpath(normalized);
  } catch (error) {
    return { ok: false, access: mapStatFailure(error, false) };
  }
  try {
    const info = await lstat(canonical);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      return { ok: false, access: { state: "unavailable", reason: "unresolvable" } };
    }
  } catch (error) {
    return { ok: false, access: mapStatFailure(error, true) };
  }
  return { ok: true, canonical };
}

function isSymlinkEscape(
  roots: AllowedRootService,
  requested: string,
  canonical: string,
): boolean {
  const resolvedRequested = resolve(requested);
  for (const root of roots.roots()) {
    const lexicalInside = pathContainment.isWithin(root, resolvedRequested);
    const canonicalInside = pathContainment.isWithin(root, canonical);
    if (lexicalInside && !canonicalInside) return true;
  }
  return false;
}

async function classifyResolvedDirectory(
  roots: AllowedRootService | undefined,
  requested: string,
  canonical: string,
): Promise<WorkspaceAccess> {
  if (!roots) {
    // No AllowedRoots seam: never guess authorized. History remains readable
    // via the session catalog, so this is history_only, not a live workspace.
    return { state: "history_only", reason: "outside_allowed_roots" };
  }
  try {
    const authorized = await roots.authorizeExisting(requested, "directory");
    if (authorized.canonicalPath !== canonical) {
      return { state: "unavailable", reason: "deleted" };
    }
    return { state: "authorized", reason: "allowed_root" };
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.code === "ROOT_REPLACED") {
        return { state: "unavailable", reason: "deleted" };
      }
      if (error.code === "PATH_NOT_FOUND") {
        return { state: "unavailable", reason: "missing" };
      }
      if (error.code === "NOT_DIRECTORY" || error.code === "NOT_FILE") {
        return { state: "unavailable", reason: "unresolvable" };
      }
      if (error.code === "INVALID_PATH") {
        return { state: "unavailable", reason: "malformed" };
      }
      if (error.code === "PATH_FORBIDDEN") {
        // Exact registered-root identity replacement (root path is now a
        // symlink / different canonical) is unavailable, never history_only.
        // Leaf symlink escape under a still-live root stays history_only.
        const resolvedRequested = resolve(requested);
        if (roots.roots().some((root) => root === resolvedRequested && canonical !== root)) {
          return { state: "unavailable", reason: "deleted" };
        }
        return {
          state: "history_only",
          reason: isSymlinkEscape(roots, requested, canonical)
            ? "symlink_escape"
            : "outside_allowed_roots",
        };
      }
    }
    return { state: "unavailable", reason: "unresolvable" };
  }
}

async function classifyOnePath(
  roots: AllowedRootService | undefined,
  value: unknown,
): Promise<WorkspaceAccess> {
  const normalized = normalizeAbsolute(value);
  if (!normalized.ok) return normalized.access;
  const resolved = await resolveLiveDirectory(normalized.path);
  if (!resolved.ok) return resolved.access;
  return classifyResolvedDirectory(roots, normalized.path, resolved.canonical);
}

/**
 * Classify a session workspace from its recorded cwd and projectRoot.
 *
 * Never mutates AllowedRoots. Never throws: every input maps onto the
 * closed tri-state (fail closed to unavailable on races / unknown errors).
 */
export async function classifyWorkspaceAccess(
  roots: AllowedRootService | undefined,
  input: { readonly cwd: unknown; readonly projectRoot: unknown },
): Promise<WorkspaceAccess> {
  const [cwdAccess, projectAccess] = await Promise.all([
    classifyOnePath(roots, input.cwd),
    classifyOnePath(roots, input.projectRoot),
  ]);
  return combine(cwdAccess, projectAccess);
}
