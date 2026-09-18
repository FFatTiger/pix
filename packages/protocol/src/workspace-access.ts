/**
 * Protocol v2 additive workspace-access projection (Lifecycle Repair Phase 6A).
 *
 * Dedicated wire module (`@fffattiger/pix-protocol/workspace-access`): Host
 * session list/detail MAY attach `workspaceAccess` to session headers.
 * Absence means an older same-major producer and MUST be treated as unknown —
 * never coerced to `authorized`, never filled from cwd string equality, and
 * never defaulted by this schema.
 *
 * Protocol cannot import runtime-core (architecture rule 7). The enums below
 * MIRROR `packages/runtime-core/src/workspace-access.ts`; cross-package
 * contract tests pin both sides. Host classifies from AllowedRoots and MUST
 * import this subpath rather than redeclare the vocabulary. This module only
 * validates the wire shape.
 *
 * Finite removal condition for optionality: Protocol v3 minimum version +
 * Phase 7 daemon/Host build-compatibility fence, after which the field is
 * required on session list/detail headers.
 */
import { z } from "zod";

export const WORKSPACE_ACCESS_STATES = [
  "authorized",
  "history_only",
  "unavailable",
] as const;

export const WorkspaceAccessStateSchema = z.enum(WORKSPACE_ACCESS_STATES);
export type WorkspaceAccessState = z.infer<typeof WorkspaceAccessStateSchema>;

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

export const WorkspaceAccessReasonSchema = z.enum(WORKSPACE_ACCESS_REASONS);
export type WorkspaceAccessReason = z.infer<typeof WorkspaceAccessReasonSchema>;

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
} as const;

export const WorkspaceAccessSchema = z
  .strictObject({
    state: WorkspaceAccessStateSchema,
    reason: WorkspaceAccessReasonSchema,
  })
  .superRefine((value, ctx) => {
    const allowed = WORKSPACE_ACCESS_REASONS_BY_STATE[value.state];
    if (!(allowed as readonly string[]).includes(value.reason)) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "workspaceAccess reason does not match state",
      });
    }
  });
export type WorkspaceAccess = z.infer<typeof WorkspaceAccessSchema>;

/**
 * Additive reader. Missing/undefined stays unknown. Present values must already
 * be a valid {@link WorkspaceAccess}; this never invents `authorized`.
 */
export function readWorkspaceAccess(
  header: { readonly workspaceAccess?: WorkspaceAccess | undefined },
): WorkspaceAccess | undefined {
  return header.workspaceAccess;
}
