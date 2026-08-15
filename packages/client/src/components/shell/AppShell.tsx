import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { formatCwdLabel, type WorkspaceSearch } from "@/lib/search-params";
import { TranscriptList } from "@/components/transcript/TranscriptList";
import { Composer } from "@/components/shell/Composer";
import { SessionActions } from "@/components/shell/SessionActions";
import { Sidebar } from "@/components/shell/Sidebar";
import { VisibleBranchExportButton } from "@/components/shell/VisibleBranchExportButton";
import { WorkspacePanel } from "@/features/workspace/WorkspacePanel";
import { CatalogPanel, hasCatalogCapability } from "@/features/catalog/CatalogPanel";
import { ExtensionRequests } from "@/features/extension-request/ExtensionRequests";
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

function describeError(cause: unknown): string {
  if (cause && typeof cause === "object" && "message" in cause) {
    const message = (cause as { message: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return String(cause);
}

export function AppShell({ search }: AppShellProps) {
  const { canAgent, mode, capabilities, unavailable } = useCapabilities();
  const runtime = useRuntime();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  // D2-P8: the composer textarea is the focus-return target when the final
  // extension request closes. Passed explicitly to both ExtensionRequests and
  // Composer (no document queries).
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [projectPath, setProjectPath] = useState("");
  const [projectError, setProjectError] = useState<string | null>(null);
  const [openingLive, setOpeningLive] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);

  // History/live coordination (D1A-2 phase 2 + history-switching fix).
  //
  // The selected session is `search.session`. The runtime may be attached to a
  // DIFFERENT session (e.g. the user was live on A and then clicked B in the
  // sidebar without going through Continue live).
  // D4: the currently attached/live session id is handed to the Sidebar so it
  // never offers a delete control for the live session (the server rejects live
  // deletes with 409 anyway). The page must then fail-closed
  // to the selected session's HISTORY view — never render A's live transcript,
  // never enable the Composer, never show SessionActions — and detach A so the
  // stale runtime stops streaming. The mismatch effect below owns that detach:
  // it fires once per (attached, selected) pair (no loops), is fire-and-forget
  // (errors are surfaced but the page stays fail-closed), and a generation
  // counter drops stale detach rejections so a quick B→C switch or a Continue
  // live takeover never lets an old promise clobber the new selection.
  const selectionMatchesLive =
    runtime.attached && (!search.session || search.session === runtime.sessionId);
  const isMismatched =
    runtime.attached && Boolean(search.session) && search.session !== runtime.sessionId;

  const mountedRef = useRef(true);
  const detachGenRef = useRef(0);
  const mismatchKeyRef = useRef<string | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const mismatched = runtime.attached && Boolean(search.session) && search.session !== runtime.sessionId;
    const key = mismatched ? `${runtime.sessionId ?? ""}:${search.session ?? ""}` : null;
    if (key === mismatchKeyRef.current) return; // same pair already handled
    mismatchKeyRef.current = key;
    if (!mismatched) return;
    setLiveError(null);
    const gen = ++detachGenRef.current;
    void runtime.detach().catch((error) => {
      // A newer detach (or a Continue-live takeover) superseded this one, or the
      // shell unmounted: never surface a stale error or touch a dead component.
      if (!mountedRef.current || gen !== detachGenRef.current) return;
      setLiveError(describeError(error));
    });
  }, [runtime.attached, runtime.sessionId, search.session]);

  // Read-only deep link (D1A-2 phase 2): a `?session=` link renders history via
  // the read-only context GET and NEVER auto-activates a Worker. The user must
  // explicitly Continue live (and only when the `agent` capability is present)
  // before openSession attaches a runtime. When the runtime is attached to a
  // DIFFERENT session, Continue live first awaits detach (never stop), then
  // opens the selected session; only an actual attach to the selection is live.
  const handleContinueLive = (): void => {
    if (!canAgent || !search.session || openingLive) return;
    const sessionId = search.session; // narrowed to string; stable for this action
    setLiveError(null);
    detachGenRef.current += 1; // hand error ownership to this explicit action
    setOpeningLive(true);
    void (async () => {
      try {
        // If a stale runtime is still attached to another session, fail-closed
        // detach it before opening the selected session (double-click/race safe:
        // detach() is idempotent and this runs under the openingLive guard).
        if (runtime.attached && runtime.sessionId && runtime.sessionId !== sessionId) {
          await runtime.detach();
        }
        await runtime.openSession(sessionId);
      } catch (error) {
        setLiveError(describeError(error));
      } finally {
        setOpeningLive(false);
      }
    })();
  };

  const connection = runtime.connection;
  const hasProject = Boolean(search.cwd);
  const canCreate = canAgent && hasProject && !runtime.attached && !runtime.sessionStopped;
  const hasWorkspaceCap =
    capabilities.includes("files") ||
    capabilities.includes("git") ||
    capabilities.includes("worktree");
  const hasCatalogCap = hasCatalogCapability((cap) => capabilities.includes(cap));

  // Cap revocation: hide Catalog button and close the dock so no stale UI stays open.
  // A later re-grant does NOT auto-reopen (same contract as Catalog).
  useEffect(() => {
    if (!hasCatalogCap && catalogOpen) setCatalogOpen(false);
  }, [hasCatalogCap, catalogOpen]);
  useEffect(() => {
    if (!hasWorkspaceCap && workspaceOpen) setWorkspaceOpen(false);
  }, [hasWorkspaceCap, workspaceOpen]);
  // Topbar always shows the SELECTED session (search.session first) so it never
  // claims live B while the runtime is still attached to A; a detached-to-history
  // view falls back to the live session id only when nothing is selected.
  const shownSessionId = search.session ?? runtime.sessionId;
  const connectionLabel = isMismatched ? "attached" : CONNECTION_LABEL[connection];
  const connectionTitle = isMismatched
    ? `Runtime attached to ${runtime.sessionId?.slice(0, 8) ?? "?"}…; detaching to show the selected session`
    : `Runtime connection: ${connection}`;

  // D4 session-history delete navigation. AppShell is the single navigation
  // owner: when the deleted session equals the URL-selected session it clears
  // ONLY the `session` param while preserving the current `cwd`. It never
  // detaches/stops a Runtime — deletion cannot succeed while a session is live
  // (sessiond rejects with 409), so no runtime coordination is needed.
  // Non-selected deletions leave the URL untouched (Sidebar only calls this for
  // the URL-selected row).
  const handleSessionDeleted = (deletedId: string): void => {
    if (search.session === deletedId) {
      void navigate({ to: "/", search: search.cwd === undefined ? {} : { cwd: search.cwd } });
    }
  };

  const handleCreate = (): void => {
    if (!search.cwd) return;
    // New session is an explicit create. Clear any stale ?session= selection so
    // the fresh live session becomes the page's session — otherwise the mismatch
    // effect would immediately detach the just-created session. navigate()
    // updates the router store synchronously, well before createSession's
    // attach round-trip completes, so no mismatch window opens.
    void navigate({ to: "/", search: { cwd: search.cwd } });
    // M2: the workspace cwd is treated as the project root. Worktree/project
    // selection (D3A) will refine this later; we never hardcode a fallback.
    void runtime.createSession({ cwd: search.cwd, projectRoot: search.cwd }).catch(() => undefined);
  };

  const handleOpenProject = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const cwd = projectPath;
    const absolute = cwd.startsWith("/") || /^[A-Za-z]:[\\/]/.test(cwd);
    if (!absolute) {
      setProjectError("Enter an absolute project path.");
      return;
    }
    setProjectError(null);
    // Open project ONLY sets the workspace cwd — it must never implicitly create
    // a session. Starting a runtime is an explicit New session / Continue live.
    void navigate({ to: "/", search: { cwd } });
  };

  // D3A managed-worktree switch/Open: Client URL cwd navigation ONLY. Never Git
  // checkout, never create/attach/stop/move a Session, never a server endpoint.
  // Navigating with a fresh `{ cwd: path }` search intentionally clears any old
  // `session` selection so a stale session is never displayed under the new
  // workspace; existing runtime sessions stay alive untouched.
  const handleOpenWorktree = (path: string): void => {
    void navigate({ to: "/", search: { cwd: path } });
  };

  const subtitle = !canAgent
    ? unavailable
      ? "Host runtime unavailable — no capability has been negotiated."
      : "Read-only shell — host has no agent capability."
    : runtime.fatal
      ? "Runtime handshake rejected — connection stopped."
      : isMismatched
        ? `Detaching live session ${runtime.sessionId?.slice(0, 8) ?? "?"}… — showing selected session history.`
        : runtime.attached
          ? "Live runtime attached — send a prompt to begin."
          : search.session
            ? openingLive
              ? `Opening live session ${search.session.slice(0, 8)}…`
              : "Read-only session history — Continue live to attach a runtime."
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
          <span className={`topbar-badge topbar-badge--${isMismatched ? "warn" : runtime.attached ? "ok" : connection === "unavailable" || runtime.fatal ? "warn" : "muted"}`} title={connectionTitle} aria-live="polite">
            rt:{connectionLabel}
          </span>
        </div>
        <div className="app-topbar-center">
          <span className="topbar-cwd" title={search.cwd ?? ""}>
            {formatCwdLabel(search.cwd)}
          </span>
          {shownSessionId ? (
            <span className="topbar-session" title={shownSessionId}>
              session:{shownSessionId.slice(0, 8)}
              {shownSessionId.length > 8 ? "…" : ""}
            </span>
          ) : (
            <span className="topbar-session topbar-session--muted">no session</span>
          )}
        </div>
        <div className="app-topbar-right">
          <span className="topbar-caps" title={capabilities.join(", ")}>
            caps:{capabilities.length}
          </span>
          {hasWorkspaceCap ? (
            <button
              type="button"
              className={`text-btn${workspaceOpen ? " text-btn--active" : ""}`}
              aria-pressed={workspaceOpen}
              aria-label={workspaceOpen ? "Hide workspace panel" : "Show workspace panel"}
              onClick={() => {
                setWorkspaceOpen((v) => {
                  const next = !v;
                  if (next) setCatalogOpen(false);
                  return next;
                });
              }}
            >
              Workspace
            </button>
          ) : null}
          {hasCatalogCap ? (
            <button
              type="button"
              className={`text-btn${catalogOpen ? " text-btn--active" : ""}`}
              aria-pressed={catalogOpen}
              aria-label={catalogOpen ? "Hide catalog panel" : "Show catalog panel"}
              onClick={() => {
                setCatalogOpen((v) => {
                  const next = !v;
                  if (next) setWorkspaceOpen(false);
                  return next;
                });
              }}
            >
              Catalog
            </button>
          ) : null}
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
        <Sidebar
          open={sidebarOpen}
          search={search}
          liveSessionId={runtime.attached ? runtime.sessionId : null}
          onSessionDeleted={handleSessionDeleted}
        />

        <main className="workspace">
          <div className="workspace-header">
            <h1 className="workspace-title">{runtime.attached ? "Session" : search.session ? "Session" : "Workstation"}</h1>
            <p className="workspace-subtitle">{subtitle}</p>
            {canAgent && !hasProject && !runtime.attached ? (
              <form className="project-open-form" onSubmit={handleOpenProject}>
                <label htmlFor="project-path">Project path</label>
                <div className="project-open-row">
                  <input
                    id="project-path"
                    type="text"
                    value={projectPath}
                    onChange={(event) => {
                      setProjectPath(event.target.value);
                      if (projectError) setProjectError(null);
                    }}
                    placeholder="/absolute/path/to/project"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button type="submit" className="text-btn" disabled={projectPath.length === 0}>
                    Open project
                  </button>
                </div>
                {projectError ? <p className="project-open-error" role="alert">{projectError}</p> : null}
              </form>
            ) : null}
            {canAgent && search.session && !selectionMatchesLive ? (
              <div className="continue-live">
                <button
                  type="button"
                  className="text-btn continue-live-btn"
                  onClick={handleContinueLive}
                  disabled={openingLive}
                  aria-busy={openingLive}
                >
                  {openingLive ? "Connecting…" : "Continue live"}
                </button>
                {liveError ? (
                  <p className="project-open-error" role="alert">{liveError}</p>
                ) : null}
              </div>
            ) : null}
            {search.session ? (
              <VisibleBranchExportButton
                sessionId={search.session}
                selectionMatchesLive={selectionMatchesLive}
              />
            ) : null}
          </div>

          <SessionActions live={selectionMatchesLive} />

          <TranscriptList
            live={selectionMatchesLive}
            {...(search.session === undefined ? {} : { sessionId: search.session })}
          />

          {selectionMatchesLive ? (
            <ExtensionRequests live composerTextareaRef={composerTextareaRef} />
          ) : null}

          <Composer live={selectionMatchesLive} textareaRef={composerTextareaRef} />
        </main>

        <WorkspacePanel
          cwd={search.cwd}
          open={workspaceOpen}
          onClose={() => setWorkspaceOpen(false)}
          onOpenWorktree={handleOpenWorktree}
        />
        <CatalogPanel cwd={search.cwd} open={catalogOpen} onClose={() => setCatalogOpen(false)} />
      </div>
    </div>
  );
}
