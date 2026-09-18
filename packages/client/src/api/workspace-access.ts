/**
 * Client workspace-access owner (Lifecycle Repair Phase 6B).
 *
 * Session catalog visibility is not live-workspace authorization. The Host
 * list/detail `workspaceAccess` field is the exact resource gate; this module
 * is the ONE Client reader. Missing/undefined is unknown legacy and MUST
 * never be guessed as `authorized`. Runtime snapshot / current holder / cwd
 * string equality are not authorities.
 *
 * Capabilities remain Host tokens. `workspaceAccess` is an additional exact
 * resource gate and MUST NOT be advertised as a new capability.
 */
import type { SessionHeader, WorkspaceAccess } from "@fffattiger/pix-protocol";

export type WorkspaceAccessDecision =
  | { kind: "authorized"; access: WorkspaceAccess }
  | { kind: "history_only"; access: WorkspaceAccess }
  | { kind: "unavailable"; access: WorkspaceAccess }
  | { kind: "unknown" };

export const WORKSPACE_ACCESS_MESSAGE_KEYS = {
  historyOnly: "desktop.workspaceAccess.historyOnly",
  symlinkEscape: "desktop.workspaceAccess.symlinkEscape",
  missing: "desktop.workspaceAccess.missing",
  deleted: "desktop.workspaceAccess.deleted",
  unreadable: "desktop.workspaceAccess.unreadable",
  unresolvable: "desktop.workspaceAccess.unresolvable",
  malformed: "desktop.workspaceAccess.malformed",
  unknown: "desktop.workspaceAccess.unknown",
} as const;

const ENGLISH_COPY: Readonly<Record<string, string>> = {
  [WORKSPACE_ACCESS_MESSAGE_KEYS.historyOnly]:
    "This session is history-only. Live workspace actions are unavailable.",
  [WORKSPACE_ACCESS_MESSAGE_KEYS.symlinkEscape]:
    "This session path is not a live workspace.",
  [WORKSPACE_ACCESS_MESSAGE_KEYS.missing]:
    "This session's workspace is no longer available.",
  [WORKSPACE_ACCESS_MESSAGE_KEYS.deleted]:
    "This session's workspace is no longer available.",
  [WORKSPACE_ACCESS_MESSAGE_KEYS.unreadable]:
    "This session's workspace cannot be opened.",
  [WORKSPACE_ACCESS_MESSAGE_KEYS.unresolvable]:
    "This session's workspace cannot be opened.",
  [WORKSPACE_ACCESS_MESSAGE_KEYS.malformed]:
    "This session's workspace cannot be opened.",
  [WORKSPACE_ACCESS_MESSAGE_KEYS.unknown]:
    "This session is history-only until workspace access is confirmed.",
};

/** Additive reader. Missing/undefined stays unknown. Never invents authorized. */
export function readSessionWorkspaceAccess(
  header: { readonly workspaceAccess?: WorkspaceAccess | undefined } | null | undefined,
): WorkspaceAccess | undefined {
  return header?.workspaceAccess;
}

/**
 * Resolve the exact Client decision from an HTTP session header/detail.
 * Absence is unknown legacy — never authorized, never inferred from cwd.
 */
export function resolveWorkspaceAccessDecision(
  header: { readonly workspaceAccess?: WorkspaceAccess | undefined } | null | undefined,
): WorkspaceAccessDecision {
  const access = header?.workspaceAccess;
  if (access === undefined) return { kind: "unknown" };
  if (access.state === "authorized") return { kind: "authorized", access };
  if (access.state === "history_only") return { kind: "history_only", access };
  return { kind: "unavailable", access };
}

/**
 * Pick the authoritative HTTP session record for a selected id: detail wins
 * over the catalog list row. Never a runtime snapshot / holder.
 */
export function selectAuthoritativeSessionHeader(
  sessionId: string | null | undefined,
  detail: SessionHeader | null | undefined,
  listed: readonly SessionHeader[] | null | undefined,
): SessionHeader | undefined {
  if (!sessionId) return undefined;
  if (detail && detail.sessionId === sessionId) return detail;
  return listed?.find((session) => session.sessionId === sessionId);
}

/** Live models/files/skills/send/controller admission only for authorized. */
export function isLiveWorkspaceAuthorized(
  header: { readonly workspaceAccess?: WorkspaceAccess | undefined } | null | undefined,
): boolean {
  return resolveWorkspaceAccessDecision(header).kind === "authorized";
}

/**
 * New-session home (no selected session) stays governed by AllowedRoots /
 * catalog route authority and MUST NOT inherit a history row. Existing
 * selected sessions are authorized only when the HTTP field says so.
 */
export function liveWorkspaceEnabledForSelection(
  sessionId: string | null | undefined,
  header: { readonly workspaceAccess?: WorkspaceAccess | undefined } | null | undefined,
): boolean {
  if (!sessionId) return true;
  return isLiveWorkspaceAuthorized(header);
}

export function workspaceAccessMessageKey(
  decision: WorkspaceAccessDecision,
): string | null {
  if (decision.kind === "authorized") return null;
  if (decision.kind === "unknown") return WORKSPACE_ACCESS_MESSAGE_KEYS.unknown;
  if (decision.kind === "history_only") {
    return decision.access.reason === "symlink_escape"
      ? WORKSPACE_ACCESS_MESSAGE_KEYS.symlinkEscape
      : WORKSPACE_ACCESS_MESSAGE_KEYS.historyOnly;
  }
  switch (decision.access.reason) {
    case "missing":
      return WORKSPACE_ACCESS_MESSAGE_KEYS.missing;
    case "deleted":
      return WORKSPACE_ACCESS_MESSAGE_KEYS.deleted;
    case "unreadable":
      return WORKSPACE_ACCESS_MESSAGE_KEYS.unreadable;
    case "unresolvable":
      return WORKSPACE_ACCESS_MESSAGE_KEYS.unresolvable;
    case "malformed":
      return WORKSPACE_ACCESS_MESSAGE_KEYS.malformed;
    default:
      return WORKSPACE_ACCESS_MESSAGE_KEYS.deleted;
  }
}

/**
 * Code-first fixed copy. Never interpolates paths, errno, or backend messages.
 * Optional `translate` maps the same keys used by en/zh i18n.
 */
export function describeWorkspaceAccess(
  decision: WorkspaceAccessDecision,
  translate?: (key: string) => string,
): string {
  const key = workspaceAccessMessageKey(decision);
  if (key === null) return "";
  if (translate) return translate(key);
  return ENGLISH_COPY[key] ?? ENGLISH_COPY[WORKSPACE_ACCESS_MESSAGE_KEYS.unknown]!;
}

export function workspaceAccessUnsupportedError(
  decision: WorkspaceAccessDecision,
): { code: "unsupported_capability"; message: string; retryable: false; phase: "activation" } {
  return {
    code: "unsupported_capability",
    message: describeWorkspaceAccess(decision),
    retryable: false,
    phase: "activation",
  };
}
