import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { formatCwdLabel, type WorkspaceSearch } from "@/lib/search-params";
import { TranscriptList } from "@/components/transcript/TranscriptList";
import { Composer } from "@/components/shell/Composer";
import { Sidebar } from "@/components/shell/Sidebar";

export interface AppShellProps {
  search: WorkspaceSearch;
}

export function AppShell({ search }: AppShellProps) {
  const { isReadonly, canAgent, mode, capabilities, unavailable, canBrowseSessions } = useCapabilities();
  const [sidebarOpen, setSidebarOpen] = useState(true);

  return (
    <div className={`app-shell${sidebarOpen ? "" : " app-shell--sidebar-collapsed"}`}>
      <header className="app-topbar">
        <div className="app-topbar-left">
          <button
            type="button"
            className="icon-btn"
            aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
            aria-pressed={sidebarOpen}
            onClick={() => setSidebarOpen((v) => !v)}
          >
            ☰
          </button>
          <Link to="/" className="brand" search={{}}>
            Pi Web
          </Link>
          <span className="topbar-badge" title={`Host mode: ${mode}`}>
            {mode}
          </span>
          {isReadonly ? (
            <span className="topbar-badge topbar-badge--warn" title="No agent capability">
              readonly
            </span>
          ) : (
            <span className="topbar-badge topbar-badge--ok">agent</span>
          )}
        </div>
        <div className="app-topbar-center">
          <span className="topbar-cwd" title={search.cwd ?? ""}>
            {formatCwdLabel(search.cwd)}
          </span>
          {search.session ? (
            <span className="topbar-session" title={search.session}>
              session:{search.session.slice(0, 8)}
              {search.session.length > 8 ? "…" : ""}
            </span>
          ) : (
            <span className="topbar-session topbar-session--muted">no session</span>
          )}
        </div>
        <div className="app-topbar-right">
          <span className="topbar-caps" title={capabilities.join(", ")}>
            caps:{capabilities.length}
          </span>
          <Link to="/login" className="text-btn" search={{ next: "/" }}>
            Gate
          </Link>
        </div>
      </header>

      <div className="app-body">
        <Sidebar open={sidebarOpen} search={search} />

        <main className="workspace">
          <div className="workspace-header">
            <h1 className="workspace-title">
              {search.session ? "Session" : "Workstation"}
            </h1>
            <p className="workspace-subtitle">
              {canAgent
                ? "Agent capability available — runtime attach arrives in C2."
                : unavailable
                  ? "Host runtime unavailable — no capability has been negotiated."
                  : canBrowseSessions
                    ? "Read-only shell — browse history without an agent worker."
                    : "Read-only shell — no runtime connected yet."}
            </p>
          </div>

          <TranscriptList
            {...(search.session === undefined
              ? {}
              : { sessionId: search.session })}
          />

          <Composer disabled={!canAgent} readonly={isReadonly} />
        </main>
      </div>
    </div>
  );
}
