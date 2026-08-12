import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { WorkspaceSearch } from "@/lib/search-params";
import { formatCwdLabel } from "@/lib/search-params";
import { createQueryOptions } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { TrustBadge } from "@/features/catalog/TrustBadge";

export interface SidebarProps { open: boolean; search: WorkspaceSearch }

export function Sidebar({ open, search }: SidebarProps) {
  const http = useHttpClient();
  const { canBrowseSessions } = useCapabilities();
  // The session list is only requested when the host actually serves it
  // (sessiond connected). M1 wires no session catalog, so this stays disabled
  // and avoids an unconditional 404 against the unimplemented /v1/sessions.
  const sessions = useQuery({ ...createQueryOptions(http).sessions.list(search.cwd), enabled: canBrowseSessions });
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
          {(sessions.data?.sessions ?? []).map((session) => {
            const active = search.session === session.sessionId;
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
                </Link>
              </li>
            );
          })}
        </ul>
        {sessions.isLoading ? <p className="sidebar-hint">Loading sessions…</p> : null}
        {sessions.isError ? <p className="sidebar-hint">Sessions unavailable. Read-only shell remains usable.</p> : null}
        {!sessions.isLoading && !sessions.isError && sessions.data?.sessions.length === 0 ? <p className="sidebar-hint">No sessions</p> : null}
        {!canBrowseSessions ? <p className="sidebar-hint">Session history unavailable until the runtime connects.</p> : null}
      </div>
    </aside>
  );
}
