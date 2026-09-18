/**
 * Compatible workspace search params for the root route.
 * Mirrors the existing app's `session` + `cwd` query contract so deep links survive migration.
 */

export interface WorkspaceSearch {
  /** Selected session (a session tab active selector). Mutually exclusive with `file`. */
  session?: string;
  /** Workspace project root. Required to represent a file selector. */
  cwd?: string;
  /** Selected file absolute path (a file tab active selector). Mutually exclusive with `session`. */
  file?: string;
  /** Optional return path used by login redirect. */
  next?: string;
}

export function parseWorkspaceSearch(
  search: Record<string, unknown>,
): WorkspaceSearch {
  const out: WorkspaceSearch = {};
  const cwd = typeof search.cwd === "string" && search.cwd.length > 0 ? search.cwd : undefined;
  const session = typeof search.session === "string" && search.session.length > 0 ? search.session : undefined;
  const file = typeof search.file === "string" && search.file.length > 0 ? search.file : undefined;
  const next = typeof search.next === "string" && search.next.length > 0 ? search.next : undefined;
  if (cwd !== undefined) out.cwd = cwd;
  // Active selectors are mutually exclusive. When both are present the file
  // wins (the file tab is the more specific active content). A file selector
  // is meaningless without a workspace cwd, so it is dropped when cwd is
  // absent (an invalid file never shadows a valid session selector).
  if (file !== undefined && cwd !== undefined) {
    out.file = file;
  } else if (session !== undefined) {
    out.session = session;
  }
  if (next !== undefined) out.next = next;
  return out;
}

/** TanStack Router validateSearch helper. */
export function validateWorkspaceSearch(
  search: Record<string, unknown>,
): WorkspaceSearch {
  return parseWorkspaceSearch(search);
}

export function workspaceSearchToParams(
  search: WorkspaceSearch,
): URLSearchParams {
  const params = new URLSearchParams();
  if (search.cwd) params.set("cwd", search.cwd);
  // Serialization includes only ONE valid active selector: a file wins only
  // when its required cwd is present; otherwise preserve a valid session.
  if (search.file && search.cwd) params.set("file", search.file);
  else if (search.session) params.set("session", search.session);
  if (search.next) params.set("next", search.next);
  return params;
}

export function formatCwdLabel(cwd: string | undefined): string {
  if (!cwd) return "No project";
  // Show a short trailing path for chrome labels.
  const normalized = cwd.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 2) return normalized.startsWith("/") ? normalized : cwd;
  return `…/${parts.slice(-2).join("/")}`;
}
