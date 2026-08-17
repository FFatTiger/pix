import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { createQueryOptions } from "@/api/query-keys";
import { createSessionHistoryQueryOptions } from "@/api/session-history";
import { createMutationOptions } from "@/api/mutations";
import type { WorkspaceSearch } from "@/lib/search-params";
import { isHiddenRailSession, primaryRealProjectPath } from "@/lib/workspace-paths";
import { getFileName } from "@/lib/file-paths";
import { SidebarSimple } from "@phosphor-icons/react";
import { useI18n } from "@/hooks/useI18n";
import { TranscriptList } from "@/components/transcript/TranscriptList";
import { Composer } from "@/components/shell/Composer";
import { Sidebar } from "@/components/shell/Sidebar";
import { AppTitleBar } from "@/components/shell/AppTitleBar";
import { SettingsModal, type SettingsTab } from "@/components/shell/SettingsModal";
import { LoginPage } from "@/components/shell/LoginPage";
import { ProjectTrustDialog } from "@/features/settings/ProjectTrustDialog";
import { ExtensionRequests } from "@/features/extension-request/ExtensionRequests";
import { registerChatOpenFileTarget } from "@/components/chat/chat-experience-bridge";
import { FileViewer } from "@/features/workspace/viewer/FileViewer";
import { ExplorerPanel } from "@/features/workspace/explorer/ExplorerPanel";
import {
  closeWorkspaceTab,
  fileTabId,
  minimalFileTab,
  minimalSessionTab,
  openFileWorkspaceTab,
  openSessionWorkspaceTab,
  reconcileWorkspaceCwd,
  saveFileWorkspaceViewerState,
  sessionTabId,
  type WorkspaceTab,
} from "@/features/workspace/tabs/workspace-tab-state";
import type { FileViewerState } from "@/features/workspace/viewer/file-viewer-state";
import { useRuntime } from "@/runtime";
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

/** Shared session-label fallback: explicit title → first message → short id. */
function sessionLabelFor(session: { title?: string | undefined; firstMessage?: string | undefined; sessionId: string }): string {
  if (session.title) return session.title;
  const first = session.firstMessage;
  if (typeof first === "string" && first.trim().length > 0) {
    const oneLine = first.replace(/[\r\n\t]+/g, " ").trim();
    return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
  }
  return session.sessionId.slice(0, 12);
}

/**
 * Desktop shell v3 — the upstream desktop app's AppShell DOM (title bar,
 * sidebar / chat / right-panel row, resizable panels,
 * settings modal, project-trust dialog) with the pix runtime wired in:
 *
 * Top-level unified workspace tabs live in the title bar (session + file
 * tabs). The URL is the source of truth for the ACTIVE content
 * (cwd+session or cwd+file); the in-memory tab list holds every open tab and
 * the active tab is derived from the URL (back/forward/deep links activate or
 * recreate a tab without ever attaching). Sending stays the only activation
 * trigger. A prior attachment may remain as a background event subscription;
 * every visible runtime surface is active-session identity-gated.
 */
export function AppShell({ search }: AppShellProps) {
  const { canAgent, canBrowseSessions, can } = useCapabilities();
  const runtime = useRuntime();
  const connectRuntime = runtime.connect;
  const { t } = useI18n();
  const navigate = useNavigate();
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const gate = useGateStatus();

  // ── Gate guard: an unauthenticated user gets a full-screen gate (no
  // desktop shell, no unauthorized API surface). The /login route stays
  // available for direct links.
  const gateRequired = gate.data?.required === true && gate.data.authenticated !== true;
  const gateAllowsRuntime = gate.data !== undefined && !gateRequired;

  // Connect the control plane at shell startup so a refreshed page can ask
  // sessiond which workers are already running. Connecting the WebSocket does
  // NOT attach or activate a session: idle history stays 0-Worker. Once the
  // listRunning baseline arrives, the live-takeover effect below attaches only
  // when the selected URL session is already busy server-side.
  useEffect(() => {
    if (canAgent && gateAllowsRuntime) connectRuntime();
  }, [canAgent, connectRuntime, gateAllowsRuntime]);
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("models");
  const openSettings = useCallback((tab: SettingsTab) => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }, []);

  // ── Right file-browser panel (top-right button) ──────────────────────────
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const canFiles = can("files");
  const canGit = can("git");

  // ── Top-level workspace tabs (in-memory only; the URL drives the ACTIVE tab) ──
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  // The active tab id is derived from the URL: cwd+file or cwd+session. The
  // active content is always derivable even before the tab is materialized
  // (deep links / back-forward), so the central area never flashes home.
  const activeTabId = search.file !== undefined && search.cwd !== undefined
    ? fileTabId(search.cwd, search.file)
    : search.session !== undefined
      ? sessionTabId(search.session)
      : null;
  const activeTab = useMemo<WorkspaceTab | null>(() => {
    if (activeTabId === null) return null;
    const inList = tabs.find((tab) => tab.id === activeTabId);
    if (inList) return inList;
    if (search.file !== undefined && search.cwd !== undefined) return minimalFileTab(search.cwd, search.file);
    if (search.session !== undefined) return minimalSessionTab(search.session, search.cwd);
    return null;
  }, [activeTabId, tabs, search.file, search.cwd, search.session]);
  const activeSessionId = activeTab?.kind === "session" ? activeTab.sessionId : null;

  // URL → tab reconciliation: keep the in-memory tab list in sync with the URL
  // and the current cwd. File tabs are cwd-owned (a cwd switch clears them);
  // session tabs remember their cwd. This NEVER attaches — it only materializes
  // the active content as a tab so the strip stays populated.
  useEffect(() => {
    setTabs((prev) => {
      let next = reconcileWorkspaceCwd(prev, search.cwd);
      if (search.file !== undefined && search.cwd !== undefined) {
        next = openFileWorkspaceTab(next, {
          cwd: search.cwd,
          filePath: search.file,
          fileName: getFileName(search.file),
        });
      } else if (search.session !== undefined) {
        next = openSessionWorkspaceTab(next, search.session, search.cwd);
      }
      return next;
    });
  }, [search.cwd, search.session, search.file]);

  // D2-P8: the composer textarea is the focus-return target when the final
  // extension request closes. Passed explicitly to both ExtensionRequests and
  // Composer (no document queries).
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // ── Session selection is READ-ONLY (0-Worker history invariant) ───────────
  // Selecting/browsing a session (sidebar row OR a session tab) MUST NOT
  // activate/open a worker: the selected session stays a read-only history
  // view while the Composer remains editable; sending is the activation
  // trigger through `sendPromptToSession`. An existing attachment may remain
  // subscribed in the background so its authoritative running/completion
  // events continue feeding the shared runtime owner. Every visible surface is
  // identity-gated by activeSessionId, so background live state can never leak
  // into the selected transcript/composer.

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
  }, [search.cwd, search.session, search.file]);

  // Session labels for the tab strip — resolved from the shared sessions-list
  // cache (same key the Sidebar queries) so renames update tab labels live;
  // tabs never store a stale label as authority.
  const options = createQueryOptions(http);
  const sessionsQuery = useQuery({ ...options.sessions.list(), enabled: canBrowseSessions });
  const sessionLabels = useMemo(() => {
    const map: Record<string, string> = {};
    for (const session of sessionsQuery.data?.sessions ?? []) {
      map[session.sessionId] = sessionLabelFor(session);
    }
    return map;
  }, [sessionsQuery.data]);
  const catalogCwd = search.cwd
    ?? primaryRealProjectPath(
      (sessionsQuery.data?.sessions ?? []).filter((session) => !isHiddenRailSession(session)),
    );
  const isHome = activeTab === null;

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

  // History/live coordination. The active session is `activeSessionId`. The
  // runtime may still be attached to a DIFFERENT session (for example, the
  // user was live on A and selected B): the page fails closed to B's HISTORY
  // view — never A's live transcript — while the Composer stays editable;
  // sending from B performs the only activation transition. A may remain a
  // background subscription, but its live state never enters B's view.
  const selectionMatchesLive = runtime.attached && activeSessionId === runtime.sessionId;
  const runningSessionIds = useMemo<ReadonlySet<string>>(() => {
    const ids = new Set<string>(runtime.runningSessionIds);
    if (runtime.optimisticRunningSessionId) ids.add(runtime.optimisticRunningSessionId);
    const state = runtime.snapshot?.state;
    const authoritativeBusy = runtime.attached && (
      runtime.streaming
      || state?.isPromptRunning === true
      || state?.isStreaming === true
      || state?.isBashRunning === true
      || state?.isCompacting === true
    );
    if (authoritativeBusy && runtime.sessionId) ids.add(runtime.sessionId);
    return ids;
  }, [runtime.attached, runtime.optimisticRunningSessionId, runtime.runningSessionIds, runtime.sessionId, runtime.snapshot, runtime.streaming]);

  // ── Live takeover for a BUSY selected session (refresh mid-stream) ──
  // Read-only history browsing stays 0-Worker by design, but a session whose
  // worker is currently RUNNING is not history: attaching re-subscribes to its
  // live stream — the attach snapshot carries state.isStreaming/isPromptRunning
  // plus streaming.partialMessage, and live message_update events resume — so a
  // refreshed page continues the in-flight turn instead of freezing on a stale
  // settled view. Sending remains the ONLY activation trigger for idle sessions.
  // Bounded retries: a session that fails takeover twice is left as history.
  const liveTakeoverRef = useRef<{ sessionId: string; attempts: number } | null>(null);
  useEffect(() => {
    if (activeSessionId === null || selectionMatchesLive) return;
    if (!runningSessionIds.has(activeSessionId)) return;
    const prior = liveTakeoverRef.current;
    if (prior?.sessionId === activeSessionId && prior.attempts >= 2) return;
    liveTakeoverRef.current = {
      sessionId: activeSessionId,
      attempts: prior?.sessionId === activeSessionId ? prior.attempts + 1 : 1,
    };
    runtime.openSession(activeSessionId).catch(() => undefined);
  }, [activeSessionId, runtime, runningSessionIds, selectionMatchesLive]);

  const runningProjectRoots = useMemo<ReadonlySet<string>>(() => {
    const roots = new Set<string>();
    for (const session of sessionsQuery.data?.sessions ?? []) {
      if (runningSessionIds.has(session.sessionId)) roots.add(session.projectRoot || session.cwd);
    }
    for (const tab of tabs) {
      if (tab.kind === "session" && runningSessionIds.has(tab.sessionId) && tab.cwd) roots.add(tab.cwd);
    }
    if (runtime.sessionId && runningSessionIds.has(runtime.sessionId)) {
      const root = runtime.snapshot?.projectRoot ?? runtime.snapshot?.cwd;
      if (root) roots.add(root);
    }
    return roots;
  }, [runningSessionIds, runtime.sessionId, runtime.snapshot, sessionsQuery.data, tabs]);

  const hasProject = Boolean(search.cwd);
  // Multi-tab session creation remains available while another session is
  // attached. SessionStore.createSession supersedes the browser attach but
  // preserves the previous sessiond-owned worker; tab creation never stops it.
  const canCreate = canAgent && hasProject;

  // D4 session-history delete navigation. AppShell is the single navigation
  // owner: when the deleted session equals the URL-selected session it clears
  // ONLY the `session` param while preserving the current `cwd`. It never
  // detaches/stops a Runtime. The deleted session's tab is removed; if it was
  // active the URL navigation falls back to home. An in-flight prepare is
  // invalidated (it must never re-open a session the user just moved away from).
  const handleSessionDeleted = (deletedId: string): void => {
    setTabs((prev) => prev.filter((tab) => tab.kind !== "session" || tab.sessionId !== deletedId));
    if (search.session === deletedId) {
      selectionGenerationRef.current += 1;
      setPendingSessionId(null);
      void navigate({ to: "/", search: search.cwd === undefined ? {} : { cwd: search.cwd } });
    }
  };

  const handleCreateSession = useCallback(async (settings?: {
    model?: { provider: string; modelId: string };
    thinkingLevel?: import("@fffattiger/pix-protocol").ThinkingLevel;
  }): Promise<string> => {
    if (!search.cwd) {
      return Promise.reject({
        code: "invalid_input",
        message: "no project selected",
        retryable: false,
        phase: "activation",
      });
    }
    selectionGenerationRef.current += 1;
    setPendingSessionId(null);
    // Clear a stale active selector before create. On the empty home the URL
    // already is cwd-only, so navigating to the same route would needlessly
    // remount the composer during the first send.
    if (search.session !== undefined || search.file !== undefined) {
      await navigate({ to: "/", search: { cwd: search.cwd } });
    }
    const result = await runtime.createSession({
      cwd: search.cwd,
      projectRoot: search.cwd,
      ...(settings?.model === undefined ? {} : { model: settings.model }),
      ...(settings?.thinkingLevel === undefined ? {} : { thinkingLevel: settings.thinkingLevel }),
    });
    await navigate({ to: "/", search: { cwd: search.cwd, session: result.sessionId } });
    return result.sessionId;
  }, [navigate, runtime, search.cwd]);

  const handleCreate = (): void => {
    void handleCreateSession().catch(() => undefined);
  };

  /**
   * Atomic commit of a prepared session selection. Reads the CURRENT cwd from
   * the live search ref (the prepare has already verified the URL did not move
   * in the meantime). Never attaches/activates — URL navigation only. The
   * URL → tab reconciliation then opens/activates the session tab.
   */
  const commitSessionNavigation = useCallback((sessionId: string, targetCwd?: string): void => {
    const cwd = targetCwd ?? liveSearchRef.current.cwd;
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
  const handleSelectSession = useCallback((sessionId: string, targetCwd?: string): void => {
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
      commitSessionNavigation(sessionId, targetCwd);
      return;
    }
    // No history capability: direct navigation keeps the existing degraded
    // semantics (the detail frame shows the honest "history unavailable" state).
    if (!canBrowseSessions) {
      setPendingSessionId(null);
      commitSessionNavigation(sessionId, targetCwd);
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
      if (
        presented.session !== preparedFrom.session
        || presented.file !== preparedFrom.file
        || presented.cwd !== preparedFrom.cwd
      ) return;
      setPendingSessionId(null);
      commitSessionNavigation(sessionId, targetCwd);
    })();
  }, [queryClient, http, canBrowseSessions, runtime.attached, runtime.sessionId, commitSessionNavigation]);

  // ── Tab activation / navigation (URL is the active-content source of truth) ──
  // Clicking a tab navigates the URL to that tab's content (cwd+file or
  // cwd+session). This NEVER attaches: session tabs activate a read-only
  // history view; sending remains the activation trigger. Back/forward and
  // deep links are handled by the same derivation (the active tab is read from
  // the URL), so a route change activates or recreates the matching tab.
  const navigateToTab = useCallback((tab: WorkspaceTab): void => {
    if (tab.kind === "file") {
      void navigate({ to: "/", search: { cwd: tab.cwd, file: tab.filePath } });
      return;
    }
    void navigate({
      to: "/",
      search: tab.cwd === undefined ? { session: tab.sessionId } : { cwd: tab.cwd, session: tab.sessionId },
    });
  }, [navigate]);

  const handleSelectTab = useCallback((id: string): void => {
    const tab = tabs.find((candidate) => candidate.id === id) ?? (activeTab !== null && activeTab.id === id ? activeTab : null);
    if (tab) navigateToTab(tab);
  }, [tabs, activeTab, navigateToTab]);

  // Close a tab. Closing a session tab NEVER stops/deletes its session; an
  // existing subscription may remain in the shared running-state owner.
  // Closing the active tab selects the
  // right neighbor, then the left, then home.
  const handleCloseTab = useCallback((id: string): void => {
    const closedIsActive = id === activeTabId;
    const result = closeWorkspaceTab(tabs, activeTabId, id);
    setTabs(result.tabs);
    if (!closedIsActive) return;
    const nextActive = result.nextActiveTabId === null
      ? null
      : (result.tabs.find((tab) => tab.id === result.nextActiveTabId) ?? null);
    if (nextActive) {
      navigateToTab(nextActive);
    } else {
      void navigate({ to: "/", search: search.cwd === undefined ? {} : { cwd: search.cwd } });
    }
  }, [activeTabId, navigate, navigateToTab, search.cwd, tabs]);

  // ── File open ────────────────────────────────────────────────────────────
  // Opening a file (file browser, chat file links, written-file rows, quick
  // changes, linked files) creates/activates ONE file tab owned by the current
  // cwd and navigates the URL to cwd+file (the active-content source of truth).
  // On mobile the file browser is closed so the central file viewer is visible.
  const handleOpenFile = useCallback((
    filePath: string,
    fileName: string,
    options?: { initialDisplayMode?: "diff"; sourceSessionId?: string | null | undefined },
  ): void => {
    const cwd = liveSearchRef.current.cwd;
    if (cwd === undefined) return;
    const openOptions = options ?? {};
    setTabs((prev) => openFileWorkspaceTab(prev, {
      cwd,
      filePath,
      fileName,
      sourceSessionId: openOptions.sourceSessionId,
      initialDisplayMode: openOptions.initialDisplayMode,
    }));
    void navigate({ to: "/", search: { cwd, file: filePath } });
    if (isMobile) setFileBrowserOpen(false);
  }, [navigate, isMobile]);

  // Linked files inside the viewer open a new file tab carrying the active
  // file tab's source session (the file that linked it).
  const handleOpenLinkedFile = useCallback((filePath: string): void => {
    const sourceSessionId = activeTab?.kind === "file" ? activeTab.sourceSessionId : undefined;
    handleOpenFile(filePath, getFileName(filePath), { sourceSessionId });
  }, [activeTab, handleOpenFile]);

  // Chat → file-viewer bridge: register the chat file-open receiver (MessageView
  // links, written-file rows, process groups) onto the file-tab open handler,
  // carrying the ACTIVE session's source so reads are session-scoped. Unregister
  // on unmount/change so a dead shell never holds a target.
  useEffect(() => {
    return registerChatOpenFileTarget((filePath, options) => {
      handleOpenFile(filePath, getFileName(filePath), {
        ...options,
        sourceSessionId: activeSessionId,
      });
    });
  }, [handleOpenFile, activeSessionId]);

  // Revision-guarded viewer state save (shared file-tab semantics).
  const handleFileViewerStateChange = useCallback((tabId: string, viewerRevision: number, viewerState: FileViewerState): void => {
    setTabs((prev) => saveFileWorkspaceViewerState(prev, tabId, viewerRevision, viewerState));
  }, []);

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
      rightPanelOpen: fileBrowserOpen,
      rightPanelWidth: rightPanelWidthRef.current,
    }),
    [fileBrowserOpen],
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
    ariaLabel: "Resize file browser",
    cssVariable: "--right-panel-width",
    defaultWidth: getDefaultRightPanelWidth(1366),
    getDefaultWidth: getResponsiveRightPanelWidth,
    getMaxWidth: getResponsiveRightPanelMaxWidth,
    growthDirection: "left",
    maxWidth: RIGHT_PANEL_MAX_WIDTH,
    minWidth: RIGHT_PANEL_MIN_WIDTH,
    storageKey: "pi-file-browser-width",
    widthRef: rightPanelWidthRef,
  });
  const reclampSidebarWidth = sidebarPanel.reclampWidth;
  const reclampRightPanelWidth = rightPanel.reclampWidth;
  useEffect(() => {
    if (!fileBrowserOpen) return;
    reclampSidebarWidth();
    reclampRightPanelWidth();
  }, [reclampRightPanelWidth, reclampSidebarWidth, fileBrowserOpen]);

  // ── Right file-browser panel toggling ────────────────────────────────────
  // The top-right button toggles a resizable right-side panel containing the
  // single ExplorerPanel instance. On mobile the file browser and the sidebar
  // drawer are mutually exclusive.
  const handleToggleFileBrowser = useCallback(() => {
    setFileBrowserOpen((prev) => {
      const next = !prev;
      if (isMobile && next) setSidebarOpen(false);
      return next;
    });
  }, [isMobile]);

  const handleSidebarToggle = useCallback(() => {
    setSidebarOpen((prev) => {
      const next = !prev;
      if (isMobile && next) setFileBrowserOpen(false);
      return next;
    });
  }, [isMobile]);

  // ── Unauthenticated: full-screen gate ────────────────────────────────────
  if (gateRequired) {
    return (
      <div style={{ position: "fixed", inset: 0, overflow: "hidden", background: "var(--bg)" }}>
        <LoginPage next="/" />
      </div>
    );
  }

  return (
    <div className="app-shell" style={{ display: "flex", height: "calc(100dvh / var(--app-ui-scale, 1))", overflow: "hidden", background: "var(--bg)" }}>
      {/* Left sidebar occupies the full viewport height. The title bar / tabs
          sit to its right so the rail is never cropped by the 36px chrome. */}
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
        className="app-shell-body"
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
        {sidebarOpen ? (
          <Sidebar
            cwd={search.cwd}
            selectedSessionId={search.session ?? null}
            liveSessionId={runtime.attached ? runtime.sessionId : null}
            runningSessionIds={runningSessionIds}
            runningProjectRoots={runningProjectRoots}
            pendingSessionId={pendingSessionId}
            onSessionDeleted={handleSessionDeleted}
            onSelectSession={handleSelectSession}
            onNewSession={handleCreate}
            canNewSession={canCreate}
            onOpenSettings={openSettings}
            onCollapseSidebar={handleSidebarToggle}
          />
        ) : (
          <div className="sidebar-collapsed-rail" data-testid="sidebar-collapsed-rail">
            <button
              type="button"
              className="sidebar-icon-btn"
              data-testid="sidebar-expand"
              title={t("desktop.showSidebar")}
              aria-label={t("desktop.showSidebar")}
              onClick={handleSidebarToggle}
            >
              <SidebarSimple size={16} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
      {sidebarOpen && (
        <div
          {...sidebarPanel.separatorProps}
          className="workspace-panel-splitter sidebar-panel-splitter"
        />
      )}

      {/* Center: title bar + active content. Tabs sit to the right of the
          full-height sidebar instead of spanning the whole window. */}
      <div className="chat-column" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        <AppTitleBar
          tabs={tabs}
          activeTabId={activeTabId}
          onSelectTab={handleSelectTab}
          onCloseTab={handleCloseTab}
          sessionLabels={sessionLabels}
          runningSessionIds={runningSessionIds}
        />
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          <main className={`workspace${isHome ? " workspace--home" : ""}`}>
            {isHome ? (
              <div className="home-stack" data-testid="home-stack">
                <div className="transcript-home" data-testid="transcript-home">
                  <div className="transcript-home-logo" aria-hidden="true" />
                  <h1 className="transcript-home-title">{t("desktop.startConversation")}</h1>
                </div>
                <Composer
                  live={false}
                  textareaRef={composerTextareaRef}
                  onCreateSession={handleCreateSession}
                  {...(search.cwd === undefined ? {} : { cwd: search.cwd })}
                  {...(catalogCwd === null ? {} : { catalogCwd })}
                />
              </div>
            ) : activeTab?.kind === "file" ? (
              <FileViewer
                key={`${activeTab.id}:${activeTab.viewerRevision ?? 0}`}
                filePath={activeTab.filePath}
                cwd={activeTab.cwd}
                sourceSessionId={activeTab.sourceSessionId}
                initialDisplayMode={activeTab.initialDisplayMode}
                initialState={activeTab.viewerState}
                onStateChange={(viewerState) => handleFileViewerStateChange(
                  activeTab.id,
                  activeTab.viewerRevision ?? 0,
                  viewerState,
                )}
                onOpenFile={handleOpenLinkedFile}
              />
            ) : (
              <>
                <TranscriptList
                  live={selectionMatchesLive}
                  {...(activeSessionId === null ? {} : { sessionId: activeSessionId })}
                />
                {selectionMatchesLive ? (
                  <ExtensionRequests live composerTextareaRef={composerTextareaRef} />
                ) : null}
                <Composer
                  live={selectionMatchesLive}
                  textareaRef={composerTextareaRef}
                  onCreateSession={handleCreateSession}
                  {...(search.cwd === undefined ? {} : { cwd: search.cwd })}
                  {...(activeSessionId === null ? {} : { sessionId: activeSessionId })}
                  {...(catalogCwd === null ? {} : { catalogCwd })}
                />
              </>
            )}
          </main>
        </div>
      </div>

      {/* Right file rail: the toggle stays on the window's right edge. The
          explorer expands left from that button and never covers it. */}
      {fileBrowserOpen && (
        <div
          {...rightPanel.separatorProps}
          className="workspace-panel-splitter right-panel-splitter"
        />
      )}
      {fileBrowserOpen ? (
        <div
          ref={rightPanel.panelRef}
          className={`right-panel-container right-panel-open${rightPanel.isResizing ? " panel-is-resizing" : ""}`}
          style={{
            display: "flex",
            flexDirection: "column",
            background: "var(--bg)",
          }}
        >
          <ExplorerPanel
            cwd={search.cwd}
            canFiles={canFiles}
            canGit={canGit}
            onOpenFile={handleOpenFile}
            headerAction={
              <button
                type="button"
                className="sidebar-icon-btn"
                data-testid="file-browser-toggle"
                disabled={!canFiles}
                title={t("desktop.hideFileBrowser")}
                aria-label={t("desktop.hideFileBrowser")}
                aria-pressed="true"
                onClick={handleToggleFileBrowser}
              >
                <SidebarSimple size={16} aria-hidden="true" style={{ transform: "scaleX(-1)" }} />
              </button>
            }
          />
        </div>
      ) : (
      <div className="file-browser-rail" data-testid="file-browser-rail">
        <button
          type="button"
          className="sidebar-icon-btn"
          data-testid="file-browser-toggle"
          disabled={!canFiles}
          title={t("desktop.showFileBrowser")}
          aria-label={t("desktop.showFileBrowser")}
          aria-pressed={false}
          onClick={handleToggleFileBrowser}
        >
          <SidebarSimple size={16} aria-hidden="true" style={{ transform: "scaleX(-1)" }} />
        </button>
      </div>
      )}
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
