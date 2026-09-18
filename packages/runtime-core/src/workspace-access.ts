/**
 * Canonical workspace-access read model (Lifecycle Repair Phase 6A).
 *
 * Session catalog visibility is not authorization. A JSONL row may be listed
 * while the recorded cwd/projectRoot is outside the current Host AllowedRoots,
 * missing, or otherwise unusable as a live workspace. The exact tri-state
 * below is the ONE domain authority for that distinction:
 *
 *   authorized    — cwd and projectRoot are live, canonical, identity-stable
 *                   directories inside the current AllowedRoots
 *   history_only  — history may be readable, but the workspace is not a live
 *                   authorized root (outside roots or symlink escape)
 *   unavailable   — the workspace cannot be resolved as a live or history path
 *                   (missing, deleted, unreadable, unresolvable, malformed)
 *
 * SINGLE DOMAIN AUTHORITY: this module owns the state/reason vocabularies.
 * `packages/protocol/src/workspace-access.ts` mirrors them as a wire zod
 * schema (protocol must stay runtime-core-free). Host classifies; Protocol
 * projects; Client degrades. Absence of the additive Protocol v2 field is
 * unknown legacy and MUST NEVER be guessed as `authorized`.
 *
 * Reasons are a closed vocabulary. They never carry raw paths, errno text,
 * or backend identifiers.
 */

export const WORKSPACE_ACCESS_STATES = [
  "authorized",
  "history_only",
  "unavailable",
] as const;

export type WorkspaceAccessState = (typeof WORKSPACE_ACCESS_STATES)[number];

export const WORKSPACE_ACCESS_REASONS = [
  "allowed_root",
  "outside_allowed_roots",
  "symlink_escape",
  "missing",
  "deleted",
  "unreadable",
  "unresolvable",
  "malformed",
] as const;

export type WorkspaceAccessReason = (typeof WORKSPACE_ACCESS_REASONS)[number];

/**
 * Closed reason sets per state. A producer MUST pick a reason from the
 * matching set; Protocol rejects cross-state combinations. Host classification
 * is fail-closed: `unavailable` dominates `history_only` dominates `authorized`.
 */
export const WORKSPACE_ACCESS_REASONS_BY_STATE = {
  authorized: ["allowed_root"],
  history_only: ["outside_allowed_roots", "symlink_escape"],
  unavailable: [
    "missing",
    "deleted",
    "unreadable",
    "unresolvable",
    "malformed",
  ],
} as const satisfies Record<WorkspaceAccessState, readonly WorkspaceAccessReason[]>;

export interface WorkspaceAccess {
  state: WorkspaceAccessState;
  reason: WorkspaceAccessReason;
}

/** Rank used to combine cwd and projectRoot classifications (fail closed). */
export const WORKSPACE_ACCESS_STATE_RANK: Readonly<
  Record<WorkspaceAccessState, number>
> = {
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

/**
 * Combine two independent path classifications. `unavailable` wins over
 * `history_only` wins over `authorized`. Equal-state ties prefer the more
 * specific fail-closed reason (symlink escape over merely outside; malformed
 * over missing).
 */
export function combineWorkspaceAccess(
  left: WorkspaceAccess,
  right: WorkspaceAccess,
): WorkspaceAccess {
  if (left.state !== right.state) {
    return WORKSPACE_ACCESS_STATE_RANK[left.state] >=
      WORKSPACE_ACCESS_STATE_RANK[right.state]
      ? left
      : right;
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
