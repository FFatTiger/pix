import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { WorkspaceSearch } from "@/lib/search-params";
import { formatCwdLabel } from "@/lib/search-params";
import { createQueryOptions } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { TrustBadge } from "@/features/catalog/TrustBadge";
import type { SessionHeader } from "@fffattiger/pix-protocol";

export interface SidebarProps { open: boolean; search: WorkspaceSearch }

/**
 * Resolve the most recent usable activity instant for a session.
 *
 * Preference order is `updatedAt → lastMessageAt → createdAt`. Each candidate
 * is only consumed when it is a finite number that maps to a representable
 * `Date`; an undefined or unrepresentable candidate is skipped so a later
 * candidate can still win, and so the row never renders `Invalid Date`.
 * Returns the ISO-8601 instant (for `<time dateTime>`) plus the source epoch-ms
 * (for the localized label), or `undefined` when no candidate is usable.
 */
function activityTime(session: SessionHeader): { iso: string; ms: number } | undefined {
  for (const value of [session.updatedAt, session.lastMessageAt, session.createdAt]) {
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const instant = new Date(value);
    const time = instant.getTime();
    // getTime() is NaN for out-of-range instants (e.g. 1e30); skip those.
    if (!Number.isFinite(time)) continue;
    return { iso: instant.toISOString(), ms: value };
  }
  return undefined;
}

export function Sidebar({ open, search }: SidebarProps) {
  const http = useHttpClient();
  const { canBrowseSessions } = useCapabilities();
  // The session list is only requested when the host actually serves it
  // (sessiond connected). M1 wires no session catalog, so this stays disabled
  // and avoids an unconditional 404 against the unimplemented /v1/sessions.
  const sessions = useQuery({ ...createQueryOptions(http).sessions.list(search.cwd), enabled: canBrowseSessions });
  // Honesty / fail-closed: when the sessions capability is retracted the visible
  // list is pinned empty regardless of cache state or any in-flight response.
  // The query is disabled so no request is issued; gating every derived flag on
  // the live capability additionally hides stale cache, stale loading/error and
  // late-arriving results — the sidebar can never display history it is no
  // longer entitled to.
  const visibleSessions = canBrowseSessions ? (sessions.data?.sessions ?? []) : [];
  const showLoading = canBrowseSessions && sessions.isLoading;
  const showError = canBrowseSessions && sessions.isError;
  const showEmpty =
    canBrowseSessions && !sessions.isLoading && !sessions.isError && (sessions.data?.sessions.length ?? 0) === 0;
  return (
    <aside className={`sidebar${open ? "" : " sidebar--collapsed"}`} aria-hidden={!open} aria-label="Sessions">
      <div className="sidebar-section">
        <div className="sidebar-section-title">Project</div>
        <div className="sidebar-cwd" title={search.cwd ?? ""}>{formatCwdLabel(search.cwd)}</div>
        <div className="sidebar-trust">
          <TrustBadge cwd={search.cwd} variant="badge" />
        </div>
      </div>
      <div className="sidebar-section sidebar-section--grow">
        <div className="sidebar-section-title">Sessions</div>
        <ul className="session-list">
          {visibleSessions.map((session) => {
            const active = search.session === session.sessionId;
            const activity = activityTime(session);
            const messages = session.messageCount;
            return (
              <li key={session.sessionId}>
                <Link
                  to="/"
                  search={{ session: session.sessionId, ...(search.cwd === undefined ? {} : { cwd: search.cwd }) }}
                  className={`session-row${active ? " session-row--active" : ""}`}
                  aria-current={active ? "page" : undefined}
                >
                  <span className="session-row-title">{session.title || "Untitled session"}</span>
                  <span className="session-row-id">{session.sessionId}</span>
                  <span className="session-row-id">{formatCwdLabel(session.cwd)}</span>
                  {activity === undefined ? null : (
                    <time className="session-row-id" dateTime={activity.iso}>
                      {new Date(activity.ms).toLocaleString()}
                    </time>
                  )}
                  {messages === undefined ? null : (
                    <span className="session-row-id">{messages} {messages === 1 ? "message" : "messages"}</span>
                  )}
                  {session.parentSessionId === undefined ? null : (
                    <span className="session-row-id">Fork</span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
        {showLoading ? <p className="sidebar-hint">Loading sessions…</p> : null}
        {showError ? <p className="sidebar-hint">Sessions unavailable. Read-only shell remains usable.</p> : null}
        {showEmpty ? <p className="sidebar-hint">No sessions</p> : null}
        {!canBrowseSessions ? <p className="sidebar-hint">Session history unavailable until the runtime connects.</p> : null}
      </div>
    </aside>
  );
}
