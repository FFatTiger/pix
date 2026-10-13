/**
 * Canonical assistant-workspace identity.
 *
 * The pix Assistant is a project-less, evergreen conversation. Its identity is
 * ONE fixed working directory derived from the user's home (`<home>/.pi/pix/
 * assistant`, alongside the existing pix sessiond/host state dirs). Sessions
 * created in that directory ARE the assistant conversation:
 *
 *  - the Host resolves the directory (creating it 0700 and marking it project
 *    trusted at composition time) and exposes it via `GET /v1/assistant`;
 *  - the session catalog classifies the directory as `hidden` (never listed in
 *    sessions/projects pages, never searchable from the sidebar) while exact-id
 *    reads keep working;
 *  - the Pi SDK adapter registers the assistant-only tools (search_sessions /
 *    read_session) for sessions whose cwd IS this directory.
 *
 * All three consumers derive the same path from this single module — Host,
 * sessiond and the Worker never maintain independent copies. The helpers are
 * pure string operations (runtime-core stays a zero-dependency kernel: callers
 * pass `homedir()`/paths in, no `node:` imports here).
 */

/** Fixed path segments under the home directory (`<home>/.pi/pix/assistant`). */
export const ASSISTANT_WORKSPACE_SEGMENTS = [".pi", "pix", "assistant"] as const;

/**
 * Workspace-path suffix pattern for the assistant directory, matched against a
 * normalized workspace path (forward slashes, no trailing slash, lowercased —
 * see `normalizeAssistantWorkspacePath`). Used by catalog browse-kind
 * classification, which only sees a cwd string, never a home directory.
 */
export const ASSISTANT_WORKSPACE_PATH_PATTERN = /\/\.pi\/pix\/assistant(?:\/|$)/;

/**
 * Normalize a workspace path for identity comparison: forward slashes, no
 * trailing separators, lowercased (mirrors the catalog's workspace
 * normalization; macOS/Windows case-insensitive filesystems are the norm for
 * these homes).
 */
export function normalizeAssistantWorkspacePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Resolve the assistant working directory for a home directory. Pure string
 * join (no filesystem access); the caller owns creation/validation.
 */
export function resolveAssistantWorkspaceDir(home: string): string {
  const trimmed = home.replace(/[\\/]+$/, "");
  return `${trimmed}/${ASSISTANT_WORKSPACE_SEGMENTS.join("/")}`;
}

/**
 * True when `path` IS the assistant working directory for `home` (normalized
 * equality — no prefix/suffix tolerance, a sibling directory never matches).
 */
export function isAssistantWorkspacePath(path: string, home: string): boolean {
  return normalizeAssistantWorkspacePath(path) === normalizeAssistantWorkspacePath(resolveAssistantWorkspaceDir(home));
}

/**
 * True when a normalized workspace path sits inside the assistant directory
 * family (`<any-home>/.pi/pix/assistant`). The pattern form is for catalog
 * browse-kind classification, which classifies arbitrary cwds without knowing
 * the machine's home; exact identity checks should use
 * {@link isAssistantWorkspacePath} instead.
 */
export function matchesAssistantWorkspacePattern(normalizedPath: string): boolean {
  return ASSISTANT_WORKSPACE_PATH_PATTERN.test(normalizedPath);
}
