/**
 * Paths that must never appear as Projects in the sidebar rail, and whose
 * sessions must not surface as top-level conversations.
 *
 * Agent-home / subagent / scratch / ephemeral directories are real on disk
 * (sessiond and workers use them as cwd), but they are not user projects.
 */

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Temp, CI, and local scratch trees that are not durable user projects. */
export function isEphemeralWorkspacePath(path: string): boolean {
  const normalized = normalizePath(path).toLowerCase();
  return (
    normalized.includes("/tmp/") ||
    normalized.includes("/var/folders/") ||
    normalized.includes("/pix-e2e-") ||
    normalized.includes("/pix-fake-") ||
    normalized.includes("/pix-test-") ||
    /\/t\/pix-/.test(normalized)
  );
}

/**
 * Worker / subagent / session-store homes. These show up as session cwd or
 * projectRoot because the worker process lives there — they are not projects.
 */
export function isAgentHomeWorkspacePath(path: string): boolean {
  const normalized = normalizePath(path).toLowerCase();
  return (
    /\/pi-claude-subagents(?:\/|$)/.test(normalized) ||
    /\/pi-subagents(?:\/|$)/.test(normalized) ||
    normalized.includes("/.pi/agent/sessions") ||
    normalized.includes("/.pi/agent/pi-claude-subagents") ||
    normalized.includes("/.pi/pix/sessiond") ||
    /\/pix\/conversations(?:\/|$)/.test(normalized)
  );
}

/** Paths that must never appear as Projects, and whose sessions stay off the rail. */
export function isNonProjectWorkspacePath(path: string): boolean {
  return isEphemeralWorkspacePath(path) || isAgentHomeWorkspacePath(path);
}

/** True when a session header belongs to a hidden agent-home / scratch tree. */
export function isHiddenRailSession(session: { cwd?: string | undefined; projectRoot?: string | undefined }): boolean {
  if (session.cwd && isNonProjectWorkspacePath(session.cwd)) return true;
  if (session.projectRoot && isNonProjectWorkspacePath(session.projectRoot)) return true;
  return false;
}

/** Most recently active real project from a session list, if any. */
export function latestRealProjectPath(
  sessions: readonly {
    cwd?: string | undefined;
    projectRoot?: string | undefined;
    updatedAt?: number | undefined;
    lastMessageAt?: number | undefined;
    createdAt?: number | undefined;
  }[],
): string | null {
  let bestPath: string | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const session of sessions) {
    if (isHiddenRailSession(session)) continue;
    const path = session.projectRoot || session.cwd;
    if (!path || isNonProjectWorkspacePath(path)) continue;
    const at = [session.updatedAt, session.lastMessageAt, session.createdAt]
      .find((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (at === undefined || at < bestAt) continue;
    bestAt = at;
    bestPath = path;
  }
  return bestPath;
}
