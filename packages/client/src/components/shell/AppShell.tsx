import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { createQueryOptions } from "@/api/query-keys";
import { createSessionHistoryQueryOptions } from "@/api/session-history";
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

/**
 * Desktop shell v3 — the upstream desktop app's AppShell DOM (title bar,
 * wallpaper-backed sidebar / chat / right-panel row, resizable panels,
 * settings modal, project-trust dialog) with the pix runtime wired in:
 * URL-driven workspace/session selection, honest capability gates and the
 * read-only/live session center (TranscriptList + Composer stay in place).
 */
export function AppShell({ search }: AppShellProps) {
  const { canAgent, canBrowseSessions, can } = useCapabilities();
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
  // ── Session selection is READ-ONLY (0-Worker history invariant) ───────────
  // Selecting/browsing a session in the sidebar or via a ?session= deep link
  // MUST NOT activate/open a worker: the selected session stays a read-only
  // history view while the Composer remains editable; sending is the activation
  // trigger through `sendPromptToSession`. Explicit non-history runtime actions
  // such as create keep their own lifecycle. If the runtime is attached to a
  // DIFFERENT session, detach only its browser subscription/live stream (the
  // Worker remains owned by sessiond); the selected history session is NEVER
  // attached here. Detach is single-flight in the store, so a concurrent
  // send-time transition cannot emit duplicate detach frames.
  useEffect(() => {
    if (!runtime.attached || !search.session) return;
    if (search.session === runtime.sessionId) return;
    // Mismatch: fail-closed — detach the currently attached (non-selected)
    // session. Never attach the selected one.
    void runtime.detach().catch(() => undefined);
  }, [runtime.attached, runtime.sessionId, search.session]);

  // ── No-flicker session navigation (prepare → atomic commit) ──────────────
  // Sidebar selection no longer navigates the URL directly: it first prepares
  // the target's exact first history page (the SAME centralized infinite-query
  // key the detail frame consumes) and only commits the `?session=` navigation
  // once that page has settled (data present, or an honest prefetch error). The
  // current detail frame stays mounted and correct the whole time — never an
  // intermediate empty/loading frame, never A's messages relabeled as B.
  //
  // `pendingSessionId` drives a lightweight pending cue ONLY on the target
  // sidebar row. `selectionGenerationRef` implements latest-intent-wins: rapid
  // B→C bumps the generation so a late B completion never navigates back. The
  // fingerprint check (prepared-from URL vs the currently presented URL) makes
  // external navigation (back / deep link / worktree switch) invalidate any
  // in-flight prepare so it never clobbers the user's new destination.
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const selectionGenerationRef = useRef(0);
  // Latest presented URL search (synced every render; the async prepare reads
  // it at commit time, never a stale closure).
  const liveSearchRef = useRef(search);
  liveSearchRef.current = search;
  // Currently URL-selected session (fresh every render for the no-op guard).
  const selectedSessionRef = useRef(search.session ?? null);
  selectedSessionRef.current = search.session ?? null;
  // Any external/navigation change to the selected session clears a stale
  // pending cue (a pending prepare that gets superseded must not linger).
  useEffect(() => {
    setPendingSessionId(null);
  }, [search.session]);

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
  // The selected session is `search.session`. The runtime may still be attached
  // to a DIFFERENT session (for example, the user was live on A and selected B).
  // D4: the currently attached/live session id is handed to the Sidebar so it
  // never offers a delete control for the live session (the server rejects live
  // deletes with 409 anyway). The page fails closed to B's HISTORY view: never
  // render A's live transcript or runtime actions, but keep the Composer
  // editable. The single selection effect above detaches A and does NOT open B;
  // sending from B performs the only activation transition.
  const selectionMatchesLive =
    runtime.attached && (!search.session || search.session === runtime.sessionId);

  const hasProject = Boolean(search.cwd);
  const canCreate = canAgent && hasProject && !runtime.attached && !runtime.sessionStopped;

  // D4 session-history delete navigation. AppShell is the single navigation
  // owner: when the deleted session equals the URL-selected session it clears
  // ONLY the `session` param while preserving the current `cwd`. It never
  // detaches/stops a Runtime — deletion cannot succeed while a session is live
  // (sessiond rejects with 409), so no runtime coordination is needed.
  // Non-selected deletions leave the URL untouched (Sidebar only calls this for
  // the URL-selected row). An in-flight prepare is invalidated (it must never
  // re-open a session the user just moved away from).
  const handleSessionDeleted = (deletedId: string): void => {
    if (search.session === deletedId) {
      selectionGenerationRef.current += 1;
      setPendingSessionId(null);
      void navigate({ to: "/", search: search.cwd === undefined ? {} : { cwd: search.cwd } });
    }
  };

  const handleCreate = (): void => {
    if (!search.cwd) return;
    // New session is an explicit create. Clear any stale ?session= selection so
    // the fresh live session becomes the page's session — otherwise the mismatch
    // effect would immediately detach the just-created session. navigate()
    // updates the router store synchronously, well before createSession's
    // attach round-trip completes, so no mismatch window opens. The generation
    // bump invalidates any in-flight prepare so it can never detach the
    // just-created live session by committing its navigation afterwards.
    selectionGenerationRef.current += 1;
    setPendingSessionId(null);
    void navigate({ to: "/", search: { cwd: search.cwd } });
    // M2: the workspace cwd is treated as the project root. Worktree/project
    // selection (D3A) will refine this later; we never hardcode a fallback.
    void runtime.createSession({ cwd: search.cwd, projectRoot: search.cwd }).catch(() => undefined);
  };

  /**
   * Atomic commit of a prepared session selection. Reads the CURRENT cwd from
   * the live search ref (the prepare has already verified the URL did not move
   * in the meantime). Never attaches/activates — URL navigation only.
   */
  const commitSessionNavigation = useCallback((sessionId: string): void => {
    const cwd = liveSearchRef.current.cwd;
    void navigate({
      to: "/",
      search: { session: sessionId, ...(cwd === undefined ? {} : { cwd }) },
    });
  }, [navigate]);

  // Sidebar row selection: prepare-then-commit (no-flicker). It never
  // attaches/activates, never stops, never creates; the Composer's send is the
  // sole activation trigger. The URL only changes once the target's exact first
  // history page has settled in the shared cache (or an honest prefetch error
  // committed) — so the detail frame never renders an empty/loading swap and
  // never labels A's messages as B. Rapid B→C is latest-intent-wins; a late
  // completion (external URL move, newer selection) never navigates.
  const handleSelectSession = useCallback((sessionId: string): void => {
    // Already showing this session — no-op (never re-prepare / re-navigate).
    if (sessionId === selectedSessionRef.current) return;
    const preparedFrom = liveSearchRef.current;
    const generation = ++selectionGenerationRef.current;
    setPendingSessionId(sessionId);
    // The target IS the attached live session (e.g. live via create with no
    // explicit ?session): the live frame is already mounted and correct, so
    // commit the explicit selection immediately — there is no history frame to
    // prepare and a history prepare would be wasted (the live detail key is
    // different).
    if (runtime.attached && runtime.sessionId === sessionId) {
      setPendingSessionId(null);
      commitSessionNavigation(sessionId);
      return;
    }
    // No history capability: direct navigation keeps the existing degraded
    // semantics (the detail frame shows the honest "history unavailable" state).
    if (!canBrowseSessions) {
      setPendingSessionId(null);
      commitSessionNavigation(sessionId);
      return;
    }
    // Prepare the EXACT first history page with the same centralized options
    // useSessionTranscript will mount against (generation 0 / no anchor = a
    // read-only history session). ensureInfiniteQueryData resolves immediately
    // from a warm cache, fetches the first page on a cold cache, and rejects on
    // a prefetch error — in every case we commit so the target's real state
    // (data or honest error surface) renders.
    const options = createSessionHistoryQueryOptions({
      http,
      sessionId,
      generation: 0,
      anchor: null,
      enabled: true,
    });
    void (async () => {
      try {
        await queryClient.ensureInfiniteQueryData(options);
      } catch {
        // Prefetch error: commit anyway so the target's honest error surface
        // renders instead of leaving the old frame indefinitely.
      }
      // Latest-intent-wins: superseded by a newer selection → never navigate.
      if (selectionGenerationRef.current !== generation) return;
      // External navigation (back / deep link / cwd switch) during prepare →
      // never clobber the user's new destination.
      const presented = liveSearchRef.current;
      if (presented.session !== preparedFrom.session || presented.cwd !== preparedFrom.cwd) return;
      setPendingSessionId(null);
      commitSessionNavigation(sessionId);
    })();
  }, [queryClient, http, canBrowseSessions, runtime.attached, runtime.sessionId, commitSessionNavigation]);

  // D3A managed-worktree switch/Open: Client URL cwd navigation ONLY. Never Git
  // checkout, never create/attach/stop/move a Session, never a server endpoint.
  // Navigating with a fresh `{ cwd: path }` search intentionally clears any old
  // `session` selection so a stale session is never displayed under the new
  // workspace; existing runtime sessions stay alive untouched. The generation
  // bump invalidates any in-flight prepare (its prepared-from cwd is gone).
  const handleOpenWorktree = (path: string): void => {
    selectionGenerationRef.current += 1;
    setPendingSessionId(null);
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
          pendingSessionId={pendingSessionId}
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
            <TranscriptList
              live={selectionMatchesLive}
              {...(search.session === undefined ? {} : { sessionId: search.session })}
            />

            {selectionMatchesLive ? (
              <ExtensionRequests live composerTextareaRef={composerTextareaRef} />
            ) : null}

            <Composer
              live={selectionMatchesLive}
              textareaRef={composerTextareaRef}
              {...(search.session === undefined ? {} : { sessionId: search.session })}
            />
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
