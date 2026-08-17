import { useCallback, useEffect, useRef, useState } from "react";
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
  // ── Session selection → live attach (desktop behavior) ─────────────────────
  // ONE owner coordinates the ENTIRE URL-session lifecycle: detaching a stale
  // attached session, attaching the selected one, superseding in-flight opens
  // when a newer selection wins, dropping late settles, and retrying
  // weak-network failures once the socket is ready again. There is deliberately
  // NO competing detach effect and no per-effect generation refs — a single
  // generation counter owns supersession, and the store's identity-scoped
  // attach settles any superseded open so no promise ever hangs. Selecting a
  // session (sidebar click or a ?session= deep link) opens it LIVE directly —
  // no separate "Continue live" step. Weak-network failures (retryable
  // transport errors) re-attempt once the socket is ready again — bounded to 3
  // retries per selection; the store's reconnect already resumes the intended
  // attach, so this is a safety net, not a polling loop. Hard failures fail
  // closed to the read-only history view with a transient notice.
  const [selectionNonce, setSelectionNonce] = useState(0);
  const [openAttempt, setOpenAttempt] = useState(0);
  const [liveError, setLiveError] = useState<string | null>(null);
  const openKeyRef = useRef<string | null>(null);
  const openGenRef = useRef(0);
  const openRetriesRef = useRef(0);
  const retryTargetRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const { connection, attached, sessionId: attachedSessionId } = runtime;
  useEffect(() => {
    const target = search.session;
    if (!canAgent || !target) return;
    if (attached && attachedSessionId === target) {
      // Already live on the selected session: clear any pending retry.
      retryTargetRef.current = null;
      return;
    }
    const key = `${selectionNonce}:${target}`;
    if (openKeyRef.current === key) return; // this selection already has a flow
    if (openRetriesRef.current >= 3) return; // retry budget exhausted
    openKeyRef.current = key;
    openRetriesRef.current = 0;
    retryTargetRef.current = null;
    const gen = ++openGenRef.current;
    setLiveError(null);
    void (async () => {
      try {
        // A stale runtime attached to another session is detached first
        // (idempotent; the worker is preserved server-side). This is the ONLY
        // detach in the shell — the fail-closed history view is just the
        // transient attached=false state while this flow runs.
        if (attached && attachedSessionId && attachedSessionId !== target) {
          await runtime.detach();
          if (!mountedRef.current || gen !== openGenRef.current) return; // superseded mid-detach
        }
        await runtime.openSession(target);
      } catch (error) {
        if (!mountedRef.current || gen !== openGenRef.current) return;
        const retryable =
          error !== null && typeof error === "object" && (error as { retryable?: unknown }).retryable === true;
        if (retryable) {
          // Weak-network/transport failure: stay SILENT and let the bounded
          // retry effect re-attempt once the socket is ready again (UI-first:
          // no "unavailable" banner on a flaky link).
          retryTargetRef.current = target;
          return;
        }
        // Definite failure (fatal/unsupported/auth): surface a transient notice.
        setLiveError(describeError(error));
      }
    })();
    // Deps are stable reactive values (never the whole `runtime` object, which
    // changes on every stream event) so a streaming session cannot re-trigger
    // this flow; `openAttempt` drives the bounded retry re-run. `runtime.detach`
    // / `runtime.openSession` are STABLE command references (see useRuntime), so
    // the captured `runtime` closure stays correct across renders.
  }, [canAgent, search.session, attached, attachedSessionId, connection, selectionNonce, openAttempt]);

  // Weak-network recovery: retry a retryable auto-open failure when the socket
  // becomes ready again (bounded; superseded selections never retry). Owned by
  // the same selection flow via openKeyRef/retryTargetRef — this is the bounded
  // safety net, not a competing lifecycle owner.
  useEffect(() => {
    if (connection !== "ready") return;
    const target = retryTargetRef.current;
    if (!target || !canAgent) return;
    if (attached && attachedSessionId === target) {
      retryTargetRef.current = null;
      return;
    }
    if (openRetriesRef.current >= 3) return;
    openRetriesRef.current += 1;
    retryTargetRef.current = null;
    openKeyRef.current = null; // allow the open effect to run again
    setLiveError(null);
    setOpenAttempt((n) => n + 1);
  }, [connection, canAgent, attached, attachedSessionId]);

  // Transient failure notice: auto-clears so a recovered session is not left
  // with a stale error banner.
  useEffect(() => {
    if (!liveError) return;
    const timer = window.setTimeout(() => setLiveError(null), 8000);
    return () => window.clearTimeout(timer);
  }, [liveError]);

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
  // deletes with 409 anyway). The page fails-closed to the selected session's
  // HISTORY view — never render A's live transcript, never enable the Composer,
  // never show runtime actions — while the single selection owner (above)
  // detaches A and opens B. The stale A stream stops as part of that one flow;
  // there is NO separate mismatch-detach effect.
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

  // Sidebar row selection: URL navigation (`?session=`) plus a selection
  // nonce. The nonce lets the auto-attach flow above re-run when the user
  // re-clicks the SAME row after a stop/failure (the URL alone would not
  // change). It never stops or creates anything by itself.
  const handleSelectSession = useCallback((sessionId: string): void => {
    setSelectionNonce((n) => n + 1);
    void navigate({
      to: "/",
      search: { session: sessionId, ...(search.cwd === undefined ? {} : { cwd: search.cwd }) },
    });
  }, [navigate, search.cwd]);

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
          {/* Transient auto-attach failure notice (weak network / stopped
              runtime): the session stays readable while the retry safety net
              runs; the notice auto-clears. */}
          {liveError ? (
            <div className="live-attach-notice" role="alert">{liveError}</div>
          ) : null}
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
