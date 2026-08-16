import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { createQueryOptions } from "@/api/query-keys";
import { createMutationOptions } from "@/api/mutations";
import type { WorkspaceSearch } from "@/lib/search-params";
import { TranscriptList } from "@/components/transcript/TranscriptList";
import { Composer } from "@/components/shell/Composer";
import { Sidebar } from "@/components/shell/Sidebar";
import { registerChatOpenFileTarget } from "@/components/chat/chat-experience-bridge";
import { AppTitleBar } from "@/components/shell/AppTitleBar";
import { SettingsModal, type SettingsTab } from "@/components/shell/SettingsModal";
import { WallpaperLayer } from "@/components/WallpaperLayer";
import { LoginPage } from "@/components/shell/LoginPage";
import { FileViewerPanel, type FileViewerPanelHandle } from "@/features/workspace/viewer/FileViewerPanel";
import { ProjectTrustDialog } from "@/features/settings/ProjectTrustDialog";
import { ExtensionRequests } from "@/features/extension-request/ExtensionRequests";
import { useRuntime } from "@/runtime";
import { useTheme } from "@/hooks/useTheme";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useGateStatus } from "@/features/gate/useGate";
import { useHttpClient } from "@/app/http-context";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import {
  getDefaultRightPanelWidth,
  getRightPanelMaxWidth,
  getSidebarMaxWidth,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "@/lib/panel-layout";

export interface AppShellProps {
  search: WorkspaceSearch;
}

function describeError(cause: unknown): string {
  if (cause && typeof cause === "object" && "message" in cause) {
    const message = (cause as { message: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return String(cause);
}

/**
 * Desktop shell v3 — the upstream desktop app's AppShell DOM (title bar,
 * wallpaper-backed sidebar / chat / right-panel row, resizable panels,
 * settings modal, project-trust dialog) with the pix runtime wired in:
 * URL-driven workspace/session selection, honest capability gates and the
 * read-only/live session center (TranscriptList + Composer stay in place).
 */
export function AppShell({ search }: AppShellProps) {
  const { canAgent, canBrowseSessions, unavailable, can } = useCapabilities();
  const runtime = useRuntime();
  const navigate = useNavigate();
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const { isDark, toggleTheme } = useTheme();
  const isMobile = useIsMobile();
  const gate = useGateStatus();

  // ── Gate guard: an unauthenticated user gets a full-screen wallpaper + gate
  // (no desktop shell, no unauthorized API surface). The /login route stays
  // available for direct links.
  const gateRequired = gate.data?.required === true && gate.data.authenticated !== true;
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileSidebarReady, setMobileSidebarReady] = useState(false);
  // On mobile the sidebar is an overlay drawer; hide it by default so the chat
  // is visible on load. Runs once the breakpoint resolves after hydration.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);
  useEffect(() => {
    setMobileSidebarReady(true);
  }, []);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("models");
  const openSettings = useCallback((tab: SettingsTab) => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }, []);

  // D2-P8: the composer textarea is the focus-return target when the final
  // extension request closes. Passed explicitly to both ExtensionRequests and
  // Composer (no document queries).
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [projectPath, setProjectPath] = useState("");
  const [projectError, setProjectError] = useState<string | null>(null);
  const [openingLive, setOpeningLive] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);

  // Title-bar workspace-controls portal host (Sidebar portals its project +
  // worktree controls in here; the sidebar fallback renders while null).
  const [titleWorkspaceControlsHost, setTitleWorkspaceControlsHost] = useState<HTMLDivElement | null>(null);

  // Session title for the top bar — resolved from the shared sessions-list
  // cache (same key the Sidebar queries), never a separate request.
  const options = createQueryOptions(http);
  const sessionsQuery = useQuery({ ...options.sessions.list(), enabled: canBrowseSessions });
  const titleSessionId = search.session ?? runtime.sessionId ?? null;
  const titleSession = titleSessionId === null
    ? null
    : (sessionsQuery.data?.sessions ?? []).find((session) => session.sessionId === titleSessionId) ?? null;
  const sessionTitle = titleSession
    ? (titleSession.title || titleSession.sessionId.slice(0, 12))
    : titleSessionId === null
      ? null
      : titleSessionId.slice(0, 12);

  // ── Project trust ─────────────────────────────────────────────────────────
  // Read and write stay independently capability-gated. The dialog only shows
  // its confirm action when the Host advertises the real mutation seam.
  const trustQuery = useQuery({
    ...options.trust.get(search.cwd ?? ""),
    enabled: search.cwd !== undefined,
  });
  const trustMutation = useMutation(createMutationOptions(http, queryClient).trust.setTrusted());
  const canTrustProject = can("project.trust");
  const [projectTrustDialogOpen, setProjectTrustDialogOpen] = useState(false);
  const showTrustWarning = Boolean(search.cwd) && trustQuery.data !== undefined && trustQuery.data.trusted === false;
  const trustMutationError = trustMutation.error === null ? null : "Unable to trust this project.";
  const closeProjectTrustDialog = useCallback(() => {
    if (trustMutation.isPending) return;
    trustMutation.reset();
    setProjectTrustDialogOpen(false);
  }, [trustMutation]);
  const confirmProjectTrust = useCallback(() => {
    if (!search.cwd || !canTrustProject || trustMutation.isPending) return;
    trustMutation.mutate(
      { cwd: search.cwd },
      { onSuccess: () => setProjectTrustDialogOpen(false) },
    );
  }, [canTrustProject, search.cwd, trustMutation]);

  // History/live coordination (D1A-2 phase 2 + history-switching fix).
  //
  // The selected session is `search.session`. The runtime may be attached to a
  // DIFFERENT session (e.g. the user was live on A and then clicked B in the
  // sidebar without going through Continue live).
  // D4: the currently attached/live session id is handed to the Sidebar so it
  // never offers a delete control for the live session (the server rejects live
  // deletes with 409 anyway). The page must then fail-closed
  // to the selected session's HISTORY view — never render A's live transcript,
  // never enable the Composer, never show runtime actions — and detach A so the
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

  const hasProject = Boolean(search.cwd);
  const canCreate = canAgent && hasProject && !runtime.attached && !runtime.sessionStopped;

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

  // Sidebar row selection: URL navigation only (`?session=`); the runtime is
  // never implicitly attached or detached by a list click.
  const handleSelectSession = useCallback((sessionId: string): void => {
    void navigate({
      to: "/",
      search: { session: sessionId, ...(search.cwd === undefined ? {} : { cwd: search.cwd }) },
    });
  }, [navigate, search.cwd]);

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

  // ── Right panel (file viewer) ────────────────────────────────────────────
  const fileViewerRef = useRef<FileViewerPanelHandle>(null);
  const handleOpenFile = useCallback((filePath: string, fileName: string, openOptions?: { initialDisplayMode?: "diff" }): void => {
    fileViewerRef.current?.openFile(filePath, fileName, null, openOptions);
    setRightPanelOpen(true);
    // On mobile the file panel is full-screen; close the drawer so it shows.
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);

  // Chat → file-viewer bridge (F2): while the viewer is mounted, register the
  // exact components' chat file-open receiver (MessageView links, written-file
  // rows) onto the AppShell file-open handler. The adapter derives the basename
  // the source handler expects; unregister on unmount/change so a dead shell
  // never holds a target.
  useEffect(() => {
    return registerChatOpenFileTarget((filePath, options) => {
      handleOpenFile(filePath, filePath.split("/").pop() ?? filePath, options);
    });
  }, [handleOpenFile]);

  // ── Resizable panels (source layout semantics) ───────────────────────────
  const sidebarWidthRef = useRef(SIDEBAR_DEFAULT_WIDTH);
  const rightPanelWidthRef = useRef(getDefaultRightPanelWidth(1366));
  const getResponsiveRightPanelWidth = useCallback(
    () => getDefaultRightPanelWidth(window.innerWidth),
    [],
  );
  const getResponsiveSidebarMaxWidth = useCallback(
    () => getSidebarMaxWidth({
      viewportWidth: window.innerWidth,
      rightPanelOpen,
      rightPanelWidth: rightPanelWidthRef.current,
    }),
    [rightPanelOpen],
  );
  const getResponsiveRightPanelMaxWidth = useCallback(
    () => getRightPanelMaxWidth({
      viewportWidth: window.innerWidth,
      sidebarOpen,
      sidebarWidth: sidebarWidthRef.current,
    }),
    [sidebarOpen],
  );
  const sidebarPanel = useResizablePanel({
    ariaLabel: "Resize sidebar",
    cssVariable: "--sidebar-width",
    defaultWidth: SIDEBAR_DEFAULT_WIDTH,
    getMaxWidth: getResponsiveSidebarMaxWidth,
    growthDirection: "right",
    maxWidth: SIDEBAR_MAX_WIDTH,
    minWidth: SIDEBAR_MIN_WIDTH,
    storageKey: "pi-sidebar-width",
    widthRef: sidebarWidthRef,
  });
  const rightPanel = useResizablePanel({
    ariaLabel: "Resize file panel",
    cssVariable: "--right-panel-width",
    defaultWidth: getDefaultRightPanelWidth(1366),
    getDefaultWidth: getResponsiveRightPanelWidth,
    getMaxWidth: getResponsiveRightPanelMaxWidth,
    growthDirection: "left",
    maxWidth: RIGHT_PANEL_MAX_WIDTH,
    minWidth: RIGHT_PANEL_MIN_WIDTH,
    storageKey: "pi-right-panel-width",
    widthRef: rightPanelWidthRef,
  });
  const reclampSidebarWidth = sidebarPanel.reclampWidth;
  const reclampRightPanelWidth = rightPanel.reclampWidth;
  useEffect(() => {
    if (!rightPanelOpen) return;
    reclampSidebarWidth();
    reclampRightPanelWidth();
  }, [reclampRightPanelWidth, reclampSidebarWidth, rightPanelOpen]);

  const handleSidebarToggle = useCallback(() => {
    setSidebarOpen((open) => !open);
  }, []);

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
              ? "Select a session or start a new one."
              : "Open a project to start a runtime session.";

  // ── Unauthenticated: full-screen wallpaper + gate ────────────────────────
  if (gateRequired) {
    return (
      <div style={{ position: "fixed", inset: 0, overflow: "hidden", background: "var(--bg)" }}>
        <WallpaperLayer />
        <LoginPage next="/" />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100dvh / var(--app-ui-scale, 1))", overflow: "hidden", background: "var(--bg)" }}>
      <AppTitleBar
        sidebarOpen={sidebarOpen}
        onSidebarToggle={handleSidebarToggle}
        isDark={isDark}
        toggleTheme={toggleTheme}
        rightPanelOpen={rightPanelOpen}
        onToggleFilePanel={() => setRightPanelOpen((v) => !v)}
        onOpenSettings={() => openSettings("models")}
        sessionTitle={sessionTitle}
        onWorkspaceControlsHostChange={setTitleWorkspaceControlsHost}
      />
      {showTrustWarning && (
        <button
          type="button"
          onClick={() => {
            trustMutation.reset();
            setProjectTrustDialogOpen(true);
          }}
          title="Project resources are restricted"
          aria-label="Project resources are restricted — trust project"
          style={{
            position: "fixed",
            top: 48,
            right: isMobile ? 12 : 20,
            zIndex: 700,
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            padding: "8px 11px",
            border: "1px solid color-mix(in srgb, var(--accent-orange) 52%, var(--border))",
            borderRadius: 7,
            background: "color-mix(in srgb, var(--accent-orange) 11%, var(--bg-panel))",
            color: "var(--accent-orange)",
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.16)",
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          <span aria-hidden="true">⚠</span>
          Trust project
        </button>
      )}
      <div
        style={{
          "--sidebar-width": `${sidebarPanel.width}px`,
          "--right-panel-width": `${rightPanel.width}px`,
          flex: 1,
          display: "flex",
          overflow: "hidden",
          minWidth: 0,
          position: "relative",
        } as React.CSSProperties}
      >
      {/* Full-window wallpaper behind sidebar, chat and right panel — see
          components/WallpaperLayer.tsx and styles/wallpaper.css. First child
          of the workspace row so every later sibling paints above it. */}
      <WallpaperLayer />
      {/* Mobile overlay backdrop */}
      <div
        className={`sidebar-overlay-backdrop${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
        onClick={() => setSidebarOpen(false)}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 199,
          background: "rgba(0,0,0,0.4)",
          opacity: sidebarOpen ? 1 : 0,
          pointerEvents: sidebarOpen ? "auto" : "none",
          transition: "opacity 0.25s ease",
        }}
      />

      {/* Left sidebar */}
      <div
        ref={sidebarPanel.panelRef}
        className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}${mobileSidebarReady ? "" : " sidebar-mobile-pending"}${sidebarPanel.isResizing ? " panel-is-resizing" : ""}`}
        style={{
          "--sidebar-width": `${sidebarPanel.width}px`,
          background: "var(--bg-panel)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          zIndex: 200,
        } as React.CSSProperties}
      >
        <Sidebar
          search={search}
          liveSessionId={runtime.attached ? runtime.sessionId : null}
          liveStreaming={runtime.attached && runtime.streaming}
          onSessionDeleted={handleSessionDeleted}
          onSelectSession={handleSelectSession}
          onOpenWorktree={handleOpenWorktree}
          onNewSession={handleCreate}
          canNewSession={canCreate}
          onOpenFile={handleOpenFile}
          workspaceControlsHosts={{ title: titleWorkspaceControlsHost }}
        />
      </div>
      {sidebarOpen && (
        <div
          {...sidebarPanel.separatorProps}
          className="workspace-panel-splitter sidebar-panel-splitter"
        />
      )}

      {/* Center: chat */}
      <div className="chat-column" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
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
            </div>

            <TranscriptList
              live={selectionMatchesLive}
              {...(search.session === undefined ? {} : { sessionId: search.session })}
            />

            {selectionMatchesLive ? (
              <ExtensionRequests live composerTextareaRef={composerTextareaRef} />
            ) : null}

            <Composer live={selectionMatchesLive} textareaRef={composerTextareaRef} />
          </main>
        </div>
      </div>

      {/* Right panel: file viewer — always mounted, width animated via CSS */}
      {rightPanelOpen && (
        <div
          {...rightPanel.separatorProps}
          className="workspace-panel-splitter right-panel-splitter"
        />
      )}
      <div
        ref={rightPanel.panelRef}
        className={`right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}${rightPanel.isResizing ? " panel-is-resizing" : ""}`}
        style={{
          display: "flex",
          flexDirection: "column",
          background: "var(--bg)",
        }}
      >
        <FileViewerPanel
          ref={fileViewerRef}
          {...(search.cwd === undefined ? {} : { cwd: search.cwd })}
          onOpenLinkedFile={(filePath) => handleOpenFile(filePath, filePath.split("/").pop() ?? filePath)}
        />
      </div>
    </div>
    {projectTrustDialogOpen && search.cwd ? (
      <ProjectTrustDialog
        cwd={search.cwd}
        busy={trustMutation.isPending}
        error={trustMutationError}
        onCancelAction={closeProjectTrustDialog}
        {...(canTrustProject ? { onConfirmAction: confirmProjectTrust } : {})}
      />
    ) : null}
    {settingsOpen ? (
      <SettingsModal
        initialTab={settingsTab}
        cwd={search.cwd ?? null}
        onCloseAction={() => setSettingsOpen(false)}
      />
    ) : null}
    </div>
  );
}
