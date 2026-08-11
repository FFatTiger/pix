/**
 * Compatible workspace search params for the root route.
 * Mirrors the existing app's `session` + `cwd` query contract so deep links survive migration.
 */

export interface WorkspaceSearch {
  session?: string;
  cwd?: string;
  /** Optional return path used by login redirect. */
  next?: string;
}

export function parseWorkspaceSearch(
  search: Record<string, unknown>,
): WorkspaceSearch {
  const out: WorkspaceSearch = {};
  if (typeof search.session === "string" && search.session.length > 0) {
    out.session = search.session;
  }
  if (typeof search.cwd === "string" && search.cwd.length > 0) {
    out.cwd = search.cwd;
  }
  if (typeof search.next === "string" && search.next.length > 0) {
    out.next = search.next;
  }
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
  if (search.session) params.set("session", search.session);
  if (search.cwd) params.set("cwd", search.cwd);
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
