import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { formatCwdLabel, type WorkspaceSearch } from "@/lib/search-params";
import { TranscriptList } from "@/components/transcript/TranscriptList";
import { Composer } from "@/components/shell/Composer";
import { Sidebar } from "@/components/shell/Sidebar";
import { useRuntime } from "@/runtime";
import type { ConnectionState } from "@/runtime";

export interface AppShellProps {
  search: WorkspaceSearch;
}

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  idle: "offline",
  connecting: "connecting",
  handshaking: "handshake",
  ready: "ready",
  attaching: "attaching",
  attached: "live",
  reconnecting: "reconnecting",
  unavailable: "unavailable",
  stopped: "stopped",
};

export function AppShell({ search }: AppShellProps) {
  const { canAgent, mode, capabilities, unavailable } = useCapabilities();
  const runtime = useRuntime();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const initiatedRef = useRef<string | null>(null);

  // Deep-link open: when a session id is present and the agent capability is
  // available, cold-open it once (H1 activates the worker).
  useEffect(() => {
    if (!canAgent || !search.session) return;
    if (initiatedRef.current === `open:${search.session}`) return;
    initiatedRef.current = `open:${search.session}`;
    void runtime.openSession(search.session).catch(() => undefined);
  }, [canAgent, search.session, runtime]);

  const connection = runtime.connection;
  const hasProject = Boolean(search.cwd);
  const canCreate = canAgent && hasProject && !runtime.attached && !runtime.sessionStopped;

  const handleCreate = (): void => {
    if (!search.cwd) return;
    // M2: the workspace cwd is treated as the project root. Worktree/project
    // selection (D3A) will refine this later; we never hardcode a fallback.
    void runtime.createSession({ cwd: search.cwd, projectRoot: search.cwd }).catch(() => undefined);
  };

  const subtitle = !canAgent
    ? unavailable
      ? "Host runtime unavailable — no capability has been negotiated."
      : "Read-only shell — host has no agent capability."
    : runtime.fatal
      ? "Runtime handshake rejected — connection stopped."
      : runtime.attached
        ? "Live runtime attached — send a prompt to begin."
        : search.session
          ? `Opening session ${search.session.slice(0, 8)}…`
          : hasProject
            ? "Select a project to start a runtime session."
            : "Open a project to start a runtime session.";

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
            pix
          </Link>
          <span className="topbar-badge" title={`Host mode: ${mode}`}>
            {mode}
          </span>
          <span className={`topbar-badge topbar-badge--${runtime.attached ? "ok" : connection === "unavailable" || runtime.fatal ? "warn" : "muted"}`} title={`Runtime connection: ${connection}`} aria-live="polite">
            rt:{CONNECTION_LABEL[connection]}
          </span>
        </div>
        <div className="app-topbar-center">
          <span className="topbar-cwd" title={search.cwd ?? ""}>
            {formatCwdLabel(search.cwd)}
          </span>
          {runtime.sessionId ? (
            <span className="topbar-session" title={runtime.sessionId}>
              session:{runtime.sessionId.slice(0, 8)}
              {runtime.sessionId.length > 8 ? "…" : ""}
            </span>
          ) : search.session ? (
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
          {canCreate ? (
            <button type="button" className="text-btn" onClick={handleCreate}>
              New session
            </button>
          ) : null}
          <Link to="/login" className="text-btn" search={{ next: "/" }}>
            Gate
          </Link>
        </div>
      </header>

      <div className="app-body">
        <Sidebar open={sidebarOpen} search={search} />

        <main className="workspace">
          <div className="workspace-header">
            <h1 className="workspace-title">{runtime.attached ? "Session" : search.session ? "Session" : "Workstation"}</h1>
            <p className="workspace-subtitle">{subtitle}</p>
          </div>

          <TranscriptList
            {...(search.session === undefined ? {} : { sessionId: search.session })}
          />

          <Composer />
        </main>
      </div>
    </div>
  );
}
