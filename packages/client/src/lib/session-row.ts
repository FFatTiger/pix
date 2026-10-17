import type { SessionHeader } from "@fffattiger/pix-protocol";

/**
 * Shared session-row presentation helpers — the ONE source for the row title,
 * the activity instant and the project label. Both the sidebar rows and the
 * ⌘K search panel render through these so the two surfaces can never disagree
 * about what a session is called or how fresh it is.
 */

/**
 * Resolve the most recent usable activity instant for a session.
 *
 * Preference order is `updatedAt → lastMessageAt → createdAt`. Each candidate
 * is only consumed when it is a finite number that maps to a representable
 * `Date`. Returns the epoch-ms instant, or `undefined` when no candidate is
 * usable.
 */
export function sessionActivityMs(session: SessionHeader): number | undefined {
  for (const value of [session.updatedAt, session.lastMessageAt, session.createdAt]) {
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const time = new Date(value).getTime();
    // getTime() is NaN for out-of-range instants (e.g. 1e30); skip those.
    if (!Number.isFinite(time)) continue;
    return value;
  }
  return undefined;
}

/**
 * The exact title a session row shows: explicit name, else the first user
 * message (bounded one-line summary), else a short id.
 */
export function sessionRowTitle(session: SessionHeader): string {
  if (session.title) return session.title;
  const first = session.firstMessage;
  if (typeof first === "string" && first.trim().length > 0) {
    const oneLine = first.replace(/[\r\n\t]+/g, " ").trim();
    return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
  }
  return session.sessionId.slice(0, 12);
}

/** Last non-empty path segment — the project label the sidebar shows. */
export function projectDisplayName(projectRoot: string): string {
  return projectRoot.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() ?? projectRoot;
}
