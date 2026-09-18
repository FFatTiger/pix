import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { createQueryOptions, queryKeys } from "@/api/query-keys";
import { PROJECT_PICKER_PAGE_SIZE, SESSION_PAGE_SIZE } from "@/api/session-list";
import { createMutationOptions } from "@/api/mutations";
import type { WorkspaceSearch } from "@/lib/search-params";
import { getFileName } from "@/lib/file-paths";
import { useI18n } from "@/hooks/useI18n";
import { TranscriptList } from "@/components/transcript/TranscriptList";
import { Composer } from "@/components/shell/Composer";
import { Sidebar } from "@/components/shell/Sidebar";
import { AppTitleBar, FileBrowserToggle } from "@/components/shell/AppTitleBar";
import { SettingsModal, type SettingsTab } from "@/components/shell/SettingsModal";
import { LoginPage } from "@/components/shell/LoginPage";
import { ProjectTrustDialog } from "@/features/settings/ProjectTrustDialog";
import { ExtensionRequests } from "@/features/extension-request/ExtensionRequests";
import { registerChatOpenFileTarget } from "@/components/chat/chat-experience-bridge";
import { FileViewer } from "@/features/workspace/viewer/FileViewer";
import { ExplorerPanel } from "@/features/workspace/explorer/ExplorerPanel";
import {
  closeWorkspaceTab,
  closeOtherWorkspaceTabs,
  closeWorkspaceTabsToRight,
  fileTabId,
  minimalFileTab,
  minimalSessionTab,
  loadLastWorkspaceSession,
  loadWorkspaceSessionTabs,
  openFileWorkspaceTab,
  openSessionWorkspaceTab,
  reconcileWorkspaceCwd,
  saveLastWorkspaceSession,
  saveWorkspaceSessionTabs,
  saveFileWorkspaceViewerState,
  sessionTabId,
  subscribeWorkspaceSessionTabs,
  type WorkspaceTab,
} from "@/features/workspace/tabs/workspace-tab-state";
import type { FileViewerState } from "@/features/workspace/viewer/file-viewer-state";
import { useSelectedWorkspaceAccess } from "@/features/session-history/use-selected-workspace-access";
import { homePresentationKey, useRuntimeConnection, useRuntimeForegroundActivity, useRuntimeOwners, useSelectedRuntime, type PresentationProvenance } from "@/runtime";
import { describeRuntimeObservationError } from "@/runtime/observation-errors";
import { RUNTIME_OBSERVE_EXISTING_FEATURE } from "@fffattiger/pix-protocol";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useVisualViewportFrame } from "@/hooks/useVisualViewportHeight";
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
  // Connection-global transport/running/live/create surface (the provider-owned
  // RuntimeConnection; stable connect/create method refs) + the EXACT runtime
  // for the URL-selected session (attached/snapshot/streaming/promptPending/
  // optimism). AppShell never reads a facade "current holder": the exact
  // selected runtime is authoritative for the selected frame and the global
  // connection list is authoritative for background liveness/running.
  const connection = useRuntimeConnection();
  const connectRuntime = connection.connect;
  const createSession = connection.createSession;
  const { registry } = useRuntimeOwners();
  const selectedRuntime = useSelectedRuntime();
  const { t } = useI18n();
  const navigate = useNavigate();
  const http = useHttpClient();
  const queryClient = useQueryClient();
  // Shared catalog queries live early: the exact HTTP workspace gate for the
  // selected session resolves detail-over-list-row (same owner helper), and
  // the presentation/observation block below consumes the same rows.
  const options = createQueryOptions(http);
  const sessionsQuery = useQuery(options.sessions.page(1, SESSION_PAGE_SIZE, { enabled: canBrowseSessions }));
  const projectsQuery = useQuery(options.projects.page(1, PROJECT_PICKER_PAGE_SIZE, canBrowseSessions));
  const selectedWorkspace = useSelectedWorkspaceAccess(search.session ?? null, sessionsQuery.data?.sessions ?? null);
  const liveWorkspaceEnabled = selectedWorkspace.liveWorkspaceEnabled;
  const foregroundActivity = useRuntimeForegroundActivity();
  const isMobile = useIsMobile();
  const visualViewportFrame = useVisualViewportFrame();
  const gate = useGateStatus();

  // Installed PWAs commonly relaunch their manifest start_url (`/`) instead
  // of the URL that was visible when the process was killed. Restore exactly
  // once for that empty cold-start route. Explicit session/file/cwd links are
  // authoritative, and later in-app navigation to home must stay on home.
  const coldStartSessionRef = useRef<ReturnType<typeof loadLastWorkspaceSession> | undefined>(undefined);
  if (coldStartSessionRef.current === undefined) {
    const emptyStartupRoute = search.session === undefined
      && search.file === undefined
      && search.cwd === undefined
      && search.next === undefined;
    coldStartSessionRef.current = emptyStartupRoute ? loadLastWorkspaceSession() : null;
  }
  const coldStartRestorePendingRef = useRef(coldStartSessionRef.current !== null);
  const coldStartRestoreStartedRef = useRef(false);
  useLayoutEffect(() => {
    const target = coldStartSessionRef.current;
    if (target === undefined || target === null || coldStartRestoreStartedRef.current) return;
    coldStartRestoreStartedRef.current = true;
    void Promise.resolve(navigate({
      to: "/",
      replace: true,
      search: target.cwd === undefined
        ? { session: target.sessionId }
        : { cwd: target.cwd, session: target.sessionId },
    })).catch(() => {
      coldStartRestorePendingRef.current = false;
    });
  }, [navigate]);

  // ── Gate guard: an unauthenticated user gets a full-screen gate (no
  // desktop shell, no unauthorized API surface). The /login route stays
  // available for direct links.
  const gateRequired = gate.data?.required === true && gate.data.authenticated !== true;
  const gateAllowsRuntime = gate.data !== undefined && !gateRequired;

  // Connect the control plane at shell startup so a refreshed page can ask
  // sessiond which workers are already running. Connecting the WebSocket does
  // NOT attach or activate a session: idle history stays 0-Worker. If the
  // a selected URL names a BUSY live Worker, the bounded resume effect below
  // reacquires observation only, so an in-flight stream remains visible after
  // re-entry/refresh without creating or activating anything.
  useEffect(() => {
    if (canAgent && gateAllowsRuntime) connectRuntime();
  }, [canAgent, connectRuntime, gateAllowsRuntime]);

  // ── LC-02 presentation truth + admission-gated auto-observation ────────────
  // The route stays the selection source of truth: every VALIDATED selection
  // (session tab, file tab, or home draft incl. its cwd) is declared to the
  // registry with its exact HTTP workspace authorization. The declaration is
  // idempotent for an unchanged key+authorization (StrictMode/rerenders never
  // invent newer intent); the registry's monotonic presentationRevision — not
  // callback arrival order — decides which late admission/activation may take
  // foreground observation.
  const selectedSessionId = search.session ?? null;
  const presentationKey = search.file !== undefined && search.cwd !== undefined
    ? fileTabId(search.cwd, search.file)
    : selectedSessionId !== null
      ? sessionTabId(selectedSessionId)
      : homePresentationKey(search.cwd);
  // Exact HTTP workspace authorization for the selected session (home/file is
  // cwd/catalog-route governed — no history-row inference), AND the live
  // gate/agent admission rights. Busy/feature are NOT admission rights: busy
  // changes must not mint a presentation revision, and a Host that never
  // negotiated observe-existing is not a revoke of an in-flight v2 first-send.
  const workspaceAuthorized = selectedSessionId === null
    ? true
    : selectedWorkspace.decision.kind === "authorized";
  // Pending HTTP metadata is not a confirmed deny: NEW admission still requires
  // an authorized header, but workspace revoke of an already-held observer waits
  // for a resolved deny/unknown/error. Global gate/agent/feature loss always
  // releases regardless of this pending bit.
  const presentationAuthorized = workspaceAuthorized && gateAllowsRuntime && canAgent;
  useEffect(() => {
    registry.declarePresentation(presentationKey, presentationAuthorized);
  }, [registry, presentationKey, presentationAuthorized]);

  // Auto-observe the selected session ONLY when the full admission predicate
  // holds: gate allowed + Host agent capability + negotiated observe-existing
  // feature + exact HTTP workspace authorized + authoritative busy baseline
  // known + the session is in sessiond's busy set + not already attached.
  // Initial idle/inactive selections attach NOTHING (0-Worker history). A
  // busy→idle transition does NOT cancel an eligible in-flight attach or drop
  // a terminal (this effect only ever ADDS observation); the acquired idle
  // subscription is kept until a transfer/release/stop. A missing feature or
  // a failed observation is surfaced honestly — never an activating fallback,
  // never a silent catch. Settlement is gated by the registry-owned
  // presentation token captured BEFORE the call; a late A result cannot paint
  // or clear B.
  const observeFeatureNegotiated = connection.acceptedFeatures.includes(RUNTIME_OBSERVE_EXISTING_FEATURE);
  const selectedBusy = selectedSessionId !== null && connection.runningSessionIds.includes(selectedSessionId);
  const [observationError, setObservationError] = useState<string | null>(null);
  useEffect(() => {
    setObservationError(null);
  }, [presentationKey]);
  const applyObservationOutcome = useCallback((token: PresentationProvenance, cause: unknown | null): void => {
    if (!registry.isPresentationCurrent(token)) return;
    setObservationError(cause === null ? null : describeRuntimeObservationError(cause, t));
  }, [registry, t]);
  useEffect(() => {
    const sessionId = selectedSessionId;
    if (sessionId === null || !presentationAuthorized || !connection.liveSessionStateKnown) return;
    // Lease/attached are guards only — not effect deps. An error that vacates
    // the lease while selectedBusy stays true must not hammer-retry; idle→busy
    // or a later transport generation is the recovery trigger. Registry
    // single-flight coalesces an already in-flight/held observe.
    const current = registry.leaseSnapshot;
    const observingSelected = current.holderSessionId === sessionId
      || current.desiredSessionId === sessionId
      || current.targetSessionId === sessionId;
    if (observingSelected) return;
    if (!observeFeatureNegotiated) {
      if (!selectedBusy) return;
      applyObservationOutcome(registry.capturePresentation(), { code: "unsupported_capability", retryable: false });
      return;
    }
    if (!selectedBusy) return;
    const token = registry.capturePresentation();
    void registry.observeExisting(sessionId).then(
      () => { applyObservationOutcome(token, null); },
      (cause: unknown) => { applyObservationOutcome(token, cause); },
    );
  }, [applyObservationOutcome, connection.generation, connection.liveSessionStateKnown, observeFeatureNegotiated, presentationAuthorized, registry, selectedBusy, selectedSessionId]);

  // Workspace revoke is exact-selected. Global gate/agent revoke (and a genuine
  // observe-feature true→false edge) releases ANY held/pending browser observer,
  // including a background A while the user is on home/file/idle C. A Host that
  // NEVER negotiated observe-existing is not a revoke of an in-flight first-send
  // / legacy v2 acquire.
  const [observeFeatureWasNegotiated, setObserveFeatureWasNegotiated] = useState(observeFeatureNegotiated);
  const observeFeatureLost = observeFeatureWasNegotiated && !observeFeatureNegotiated;
  useEffect(() => {
    setObserveFeatureWasNegotiated(observeFeatureNegotiated);
  }, [observeFeatureNegotiated]);
  useEffect(() => {
    const globalRevoked = !gateAllowsRuntime || !canAgent || observeFeatureLost;
    const workspaceRevoked = selectedSessionId !== null
      && !workspaceAuthorized
      && !selectedWorkspace.accessLookupPending;
    if (!globalRevoked && !workspaceRevoked) return;
    const current = registry.leaseSnapshot;
    const hasObserver = current.holderSessionId !== null
      || current.desiredSessionId !== null
      || current.targetSessionId !== null;
    if (!hasObserver) return;
    if (!globalRevoked) {
      const observingSelected = selectedSessionId !== null && (
        current.holderSessionId === selectedSessionId
        || current.desiredSessionId === selectedSessionId
        || current.targetSessionId === selectedSessionId
      );
      if (!observingSelected) return;
    }
    const token = registry.capturePresentation();
    void registry.release().then(
      () => { applyObservationOutcome(token, null); },
      (cause: unknown) => { applyObservationOutcome(token, cause); },
    );
  }, [applyObservationOutcome, canAgent, gateAllowsRuntime, observeFeatureLost, registry, selectedSessionId, selectedWorkspace.accessLookupPending, workspaceAuthorized]);
  const [sidebarOpen, setSidebarOpen] = useState(() => !isMobile);
  const [mobileSidebarMounted, setMobileSidebarMounted] = useState(false);
  const mobileSidebarOpeningRef = useRef(false);
  const mobileSidebarOpenFrameRef = useRef<number | null>(null);
  // On mobile the sidebar is an overlay drawer; hide it by default so the chat
  // is visible on load. Runs once the breakpoint resolves after hydration.
  useEffect(() => {
    if (!isMobile) {
      setMobileSidebarMounted(false);
      return;
    }
    mobileSidebarOpeningRef.current = false;
    if (mobileSidebarOpenFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileSidebarOpenFrameRef.current);
      mobileSidebarOpenFrameRef.current = null;
    }
    setSidebarOpen(false);
    setMobileSidebarMounted(false);
  }, [isMobile]);
  useEffect(() => {
    return () => {
      if (mobileSidebarOpenFrameRef.current !== null) {
        window.cancelAnimationFrame(mobileSidebarOpenFrameRef.current);
      }
    };
  }, []);
  // Keep the drawer mounted only for its exit transition. The bounded fallback
  // handles interrupted/missing transitionend delivery without retaining a
  // hidden full-screen fixed compositor layer in WebKit.
  useEffect(() => {
    if (!isMobile || !mobileSidebarMounted || sidebarOpen || mobileSidebarOpeningRef.current) return;
    const timeout = window.setTimeout(() => setMobileSidebarMounted(false), 340);
    return () => window.clearTimeout(timeout);
  }, [isMobile, mobileSidebarMounted, sidebarOpen]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("models");
  const openSettings = useCallback((tab: SettingsTab) => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }, []);

  // ── Right file-browser panel (top-right button) ──────────────────────────
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const canFiles = can("files") && liveWorkspaceEnabled;
  const canGit = can("git") && liveWorkspaceEnabled;

  // ── Top-level workspace tabs (URL drives ACTIVE; session tabs are durable) ──
  const [tabs, setTabs] = useState<WorkspaceTab[]>(loadWorkspaceSessionTabs);
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
  useEffect(() => {
    saveWorkspaceSessionTabs(tabs);
  }, [tabs]);
  useEffect(() => {
    const coldStartTarget = coldStartSessionRef.current;
    if (coldStartRestorePendingRef.current) {
      if (search.session === coldStartTarget?.sessionId) {
        coldStartRestorePendingRef.current = false;
      } else if (search.session === undefined && search.file === undefined && search.cwd === undefined) {
        // Do not erase the restore target while the initial replace navigation
        // is still moving the cold-start route away from `/`.
        return;
      } else {
        coldStartRestorePendingRef.current = false;
      }
    }
    if (search.session !== undefined) {
      saveLastWorkspaceSession(search.session);
    } else if (search.file === undefined) {
      // A cwd-scoped new-session page is an intentional home. File tabs are
      // ephemeral, so viewing one preserves the previous session target.
      saveLastWorkspaceSession(null);
    }
  }, [search.cwd, search.file, search.session]);
  useEffect(() => subscribeWorkspaceSessionTabs(() => {
    setTabs((current) => [
      ...loadWorkspaceSessionTabs(),
      ...current.filter((tab) => tab.kind === "file"),
    ]);
  }), []);

  // D2-P8: the composer textarea is the focus-return target when the final
  // extension request closes. Passed explicitly to both ExtensionRequests and
  // Composer (no document queries).
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // ── Session selection is READ-ONLY (0-Worker history invariant) ───────────
  // Selecting/browsing a session (sidebar row OR a session tab) MUST NOT
  // activate/open a worker: the selected session stays a read-only history
  // view while the Composer remains editable; sending is the activation
  // trigger through `sendPromptToSession`. The ONE observation-only exception
  // is a session in sessiond's busy set under the full admission predicate
  // (LC-02 auto-observe above): an observation-only attach
  // (`attachMode: existing_only`) with zero activation, applied to EVERY
  // entry point — initial URL, sidebar, tab, back/forward — so an in-flight
  // stream stays visible across re-entry/refresh and A→B→A switches. An
  // acquired subscription is kept across busy→idle until transfer/release;
  // every visible surface stays active-session identity-gated.

  // ── Immediate session navigation ──────────────────────────────────────────
  // Sidebar selection navigates the URL IMMEDIATELY: the selected session's
  // TranscriptList is keyed by session id (fresh mount per selection), the
  // shared history cache serves a warm complete-branch response instantly, and
  // a cold cache renders the target's own loading/error surface. There is no
  // prepare/pending stage — the old prepare-then-commit flow existed to keep a
  // paginated first page flicker-free; the single complete history response
  // makes the swap atomic without it. Selection still never attaches.
  const liveSearchRef = useRef(search);
  liveSearchRef.current = search;

  // Session labels for the tab strip — resolved from the shared sessions-list
  // cache (same key the Sidebar queries) so renames update tab labels live;
  // tabs never store a stale label as authority.
  const catalogSessions = useMemo(() => {
    const loaded = sessionsQuery.data?.sessions ?? [];
    const selectedHeader = selectedWorkspace.header;
    return selectedHeader !== undefined
      && !loaded.some((session) => session.sessionId === selectedHeader.sessionId)
      ? [selectedHeader, ...loaded]
      : loaded;
  }, [selectedWorkspace.header, sessionsQuery.data]);
  const sessionLabels = useMemo(() => {
    const map: Record<string, string> = {};
    for (const session of catalogSessions) {
      map[session.sessionId] = sessionLabelFor(session);
    }
    return map;
  }, [catalogSessions]);
  // Authoritative "already titled?" for auto title generation: the catalog
  // row's own title field (never a display-label fallback, which invents a
  // label from firstMessage). Undefined row / field = untitled → auto-eligible.
  const selectedSessionHasTitle = useMemo(() => {
    const id = search.session;
    if (!id) return false;
    return catalogSessions.some(
      (session) => session.sessionId === id && session.title !== undefined && session.title !== "",
    );
  }, [catalogSessions, search.session]);
  // First-class Projects resource; never infer project pages from a session page.
  const knownProjectRoots = useMemo(
    () => (projectsQuery.data?.projects ?? []).map((project) => project.projectRoot),
    [projectsQuery.data],
  );

  const handleOpenHomeForProject = useCallback((projectRoot: string) => {
    void navigate({ to: "/", search: { cwd: projectRoot } });
  }, [navigate]);

  // Sidebar new-session button: same new-session page, but defaulting to NO
  // project (empty project folder) — the user picks the project in the
  // composer's project dropdown instead of being silently bound to the
  // previously selected project.
  const handleOpenNewSessionPage = useCallback(() => {
    void navigate({ to: "/", search: {} });
  }, [navigate]);

  const isHome = activeTab === null;

  // ── Project trust ─────────────────────────────────────────────────────────
  // Read and write stay independently capability-gated. The dialog only shows
  // its confirm action when the Host advertises the real mutation seam.
  const trustQuery = useQuery({
    ...options.trust.get(search.cwd ?? ""),
    enabled: liveWorkspaceEnabled && search.cwd !== undefined,
  });
  const trustMutation = useMutation(createMutationOptions(http, queryClient).trust.setTrusted());
  const canTrustProject = can("project.trust") && liveWorkspaceEnabled;
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
  // The selected frame is LIVE only when the exact URL-selected runtime is
  // actually attached. A background holder (any other session) never makes the
  // selected frame live — the selected session fails closed to its HISTORY
  // view while the Composer stays editable; sending performs the only
  // activation transition.
  const selectionMatchesLive = selectedRuntime?.attached === true;
  // Global running authority = connection.runningSessionIds (sessiond busy
  // baseline) UNION the registry foreground optimistic/turn owner (background
  // or mid-transfer send cue) UNION the selected exact session while it is
  // attached and busy/pending. Foreground activity is indicator-only — never
  // selected snapshot, never a lifecycle owner.
  const runningSessionIds = useMemo<ReadonlySet<string>>(() => {
    const ids = new Set<string>(connection.runningSessionIds);
    if (foregroundActivity.optimisticRunningSessionId) ids.add(foregroundActivity.optimisticRunningSessionId);
    if (selectedRuntime?.attached === true) {
      const state = selectedRuntime.snapshot?.state;
      const authoritativeBusy = selectedRuntime.streaming
        || state?.isPromptRunning === true
        || state?.isStreaming === true
        || state?.isBashRunning === true
        || state?.isCompacting === true;
      if (selectedRuntime.promptPending || authoritativeBusy) ids.add(selectedRuntime.sessionId);
    }
    return ids;
  }, [connection.runningSessionIds, foregroundActivity.optimisticRunningSessionId, selectedRuntime]);

  // ── Global liveness for sidebar/tab indicators ──
  // connection.liveSessionIds is the authoritative list of session ids with a
  // live Worker (busy OR idle) from sessiond; the selected exact session is
  // additionally live while it is attached (its exact controller holds the
  // observation lease). This feeds indicators; the resume effect may reacquire
  // an already-busy Worker for the selected session, never activate an idle
  // one or create a Worker.
  const liveSessionIds = useMemo<ReadonlySet<string>>(() => {
    const ids = new Set<string>(connection.liveSessionIds);
    if (selectedRuntime?.attached === true) ids.add(selectedRuntime.sessionId);
    return ids;
  }, [connection.liveSessionIds, selectedRuntime]);
  // The liveness baseline is KNOWN once the socket received it (connection
  // truth); selection never fabricates knowledge.
  const liveKnown = connection.liveSessionStateKnown;

  const runningProjectRoots = useMemo<ReadonlySet<string>>(() => {
    const roots = new Set<string>();
    for (const session of catalogSessions) {
      if (runningSessionIds.has(session.sessionId)) roots.add(session.projectRoot || session.cwd);
    }
    for (const tab of tabs) {
      if (tab.kind === "session" && runningSessionIds.has(tab.sessionId) && tab.cwd) roots.add(tab.cwd);
    }
    if (selectedRuntime?.attached === true && runningSessionIds.has(selectedRuntime.sessionId)) {
      const root = selectedRuntime.snapshot?.projectRoot ?? selectedRuntime.snapshot?.cwd;
      if (root) roots.add(root);
    }
    return roots;
  }, [runningSessionIds, selectedRuntime, catalogSessions, tabs]);

  // D4 session-history delete navigation. AppShell is the single navigation
  // owner: when the deleted session equals the URL-selected session it clears
  // Multi-tab session creation remains available while another session is
  // attached (capability + cwd gate for the sidebar New Session action).
  const hasProject = Boolean(search.cwd);
  const canCreate = canAgent && hasProject;

  // ONLY the `session` param while preserving the current `cwd`. It never
  // detaches/stops a Runtime. The deleted session's tab is removed; if it was
  // active the URL navigation falls back to home.
  const handleSessionDeleted = (deletedId: string): void => {
    setTabs((prev) => prev.filter((tab) => tab.kind !== "session" || tab.sessionId !== deletedId));
    if (search.session === deletedId) {
      void navigate({ to: "/", search: search.cwd === undefined ? {} : { cwd: search.cwd } });
    }
  };

  // New-session creation is owned by the FIRST SEND transaction, matching the
  // source lifecycle. Buttons only open a cwd-scoped transient draft; this
  // callback creates B's identity while that draft remains mounted. It never
  // navigates or exposes a half-created session ID — Composer starts B's prompt
  // transaction first, then calls handleCreatedSessionDispatched to promote it.
  const handleCreateSession = useCallback(async (): Promise<{ sessionId: string; cwd: string }> => {
    // New-session home stays cwd/catalog-route governed. Never infer from a
    // history row, even if a previous selected session was history-only.
    const cwd = liveSearchRef.current.cwd;
    if (!cwd) {
      return Promise.reject({
        code: "invalid_input",
        message: "no project selected",
        retryable: false,
        phase: "activation",
      });
    }
    // Phase 3: create allocates the session identity only. The first prompt's
    // staged model/thinking travel atomically in submitTurn.activationOverrides.
    const result = await createSession({ cwd, projectRoot: cwd });
    return { sessionId: result.sessionId, cwd };
  }, [createSession]);

  const primeMissingSession = useCallback((activity: { sessionId: string; cwd: string; firstMessage: string }): void => {
    const now = Date.now();
    const provisional = {
      sessionId: activity.sessionId,
      cwd: activity.cwd,
      projectRoot: activity.cwd,
      firstMessage: activity.firstMessage,
      createdAt: now,
      updatedAt: now,
      messageCount: 1,
      // Create already passed Host cwd/AllowedRoots. This is not a history-row
      // guess: the HTTP detail refresh replaces it with Host classification.
      workspaceAccess: { state: "authorized" as const, reason: "allowed_root" as const },
    };
    // Provisional identity stays out-of-band from authoritative pages/totals.
    queryClient.setQueryData(queryKeys.sessions.detail(activity.sessionId), { session: provisional });
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
  }, [queryClient]);

  // Promotion boundary for a brand-new session: called synchronously AFTER
  // sendPromptToSession has reserved B's prompt transaction. Runtime info reads
  // therefore observe promptPending and cannot steal the ordinary command slot.
  const handleCreatedSessionDispatched = useCallback((created: { sessionId: string; cwd: string; firstMessage: string }): void => {
    // Source parity: promote a transient session row immediately when its first
    // prompt is dispatched. The persisted JSONL catalog may still be hidden by
    // the adapter's bounded negative cache; a later exact-id refresh replaces
    // this provisional header with authority-derived metadata.
    primeMissingSession(created);
    // LC-02: navigate ONLY while the initiating draft presentation is still
    // current. The registry verifies under the revision captured at create
    // start and coherently promotes the draft key to the created session's key
    // BEFORE the navigation/observation. A late create that landed after the
    // user switched to another draft/cwd/file/session stays background — no
    // navigation, no lease steal (the turn itself keeps running and settles on
    // its own controller).
    if (registry.promoteCreatedPresentation(created.sessionId)) {
      void navigate({ to: "/", search: { cwd: created.cwd, session: created.sessionId } });
    }
  }, [navigate, primeMissingSession, registry]);

  // runtime.create may return before Pi has persisted the JSONL catalog entry.
  // The prompt command settlement is the persistence boundary; refresh the HTTP
  // list there so the new session appears in the sidebar without a page reload.
  const handleSessionActivitySettled = useCallback((activity: { sessionId: string; cwd: string | null; firstMessage: string }): void => {
    // Also repairs pre-fix half-created sessions opened by URL: once their first
    // prompt succeeds, they receive the same provisional sidebar promotion.
    if (activity.cwd) primeMissingSession({ sessionId: activity.sessionId, cwd: activity.cwd, firstMessage: activity.firstMessage });
    void (async () => {
      try {
        // Exact-id reads bypass a warm-list miss through the adapter's
        // scanOnce path, updating its authoritative list cache with a newly
        // persisted JSONL before the broad list refetch runs.
        await queryClient.fetchQuery(createQueryOptions(http).sessions.detail(activity.sessionId));
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.sessions.lists }),
          queryClient.invalidateQueries({ queryKey: queryKeys.projects.all }),
        ]);
      } catch {
        // The adapter may still hold a bounded negative for this just-created
        // ID. Keep the provisional row instead of overwriting it with the stale
        // broad list; a later successful exact read/resume replaces it.
      }
    })();
  }, [http, primeMissingSession, queryClient]);

  /**
   * Immediate session navigation. Reads the CURRENT cwd from the live search
   * ref. Never attaches/activates — URL navigation only. The URL → tab
   * reconciliation then opens/activates the session tab, and the keyed
   * TranscriptList mounts the target's own history surface.
   */
  const commitSessionNavigation = useCallback((sessionId: string, targetCwd?: string): void => {
    const cwd = targetCwd ?? liveSearchRef.current.cwd;
    void navigate({
      to: "/",
      search: { session: sessionId, ...(cwd === undefined ? {} : { cwd }) },
    });
  }, [navigate]);

  // Sidebar row selection: navigate immediately (read-only). It never
  // attaches/activates, never stops, never creates; the Composer's send is the
  // sole activation trigger.
  const handleSelectSession = useCallback((sessionId: string, targetCwd?: string): void => {
    if (isMobile) setSidebarOpen(false);
    // Already showing this session — no-op (never re-navigate).
    if (sessionId === liveSearchRef.current.session) return;
    commitSessionNavigation(sessionId, targetCwd);
  }, [commitSessionNavigation, isMobile]);

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

  // Bulk tab close (right-click menu). Closing NEVER stops/deletes sessions;
  // if the ACTIVE tab is removed, the anchor tab takes over, else home.
  const handleCloseOtherTabs = useCallback((keepId: string): void => {
    const next = closeOtherWorkspaceTabs(tabs, keepId);
    setTabs(next);
    if (activeTabId !== null && activeTabId !== keepId) {
      const target = next.find((tab) => tab.id === keepId) ?? null;
      if (target) navigateToTab(target);
    }
  }, [activeTabId, navigateToTab, tabs]);

  const handleCloseTabsToRight = useCallback((id: string): void => {
    const next = closeWorkspaceTabsToRight(tabs, id);
    setTabs(next);
    if (activeTabId !== null && !next.some((tab) => tab.id === activeTabId)) {
      const anchor = next[next.length - 1] ?? null;
      if (anchor) navigateToTab(anchor);
      else void navigate({ to: "/", search: search.cwd === undefined ? {} : { cwd: search.cwd } });
    }
  }, [activeTabId, navigate, navigateToTab, search.cwd, tabs]);

  const handleCloseAllTabs = useCallback((): void => {
    setTabs([]);
    void navigate({ to: "/", search: search.cwd === undefined ? {} : { cwd: search.cwd } });
  }, [navigate, search.cwd]);

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
    // An in-app file open originating from an existing session is a live
    // workspace action. Keep it pre-wire gated by that exact session's HTTP
    // workspace authority. A direct cwd+file URL has no selected session and
    // remains governed independently by the Host's AllowedRoots checks.
    if (!canFiles) return;
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
  }, [canFiles, navigate, isMobile]);

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
    if (!canFiles) return registerChatOpenFileTarget(null);
    return registerChatOpenFileTarget((filePath, options) => {
      handleOpenFile(filePath, getFileName(filePath), {
        ...options,
        sourceSessionId: activeSessionId,
      });
    });
  }, [canFiles, handleOpenFile, activeSessionId]);

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
      if (isMobile && next) {
        const wasOpening = mobileSidebarOpeningRef.current;
        mobileSidebarOpeningRef.current = false;
        if (mobileSidebarOpenFrameRef.current !== null) {
          window.cancelAnimationFrame(mobileSidebarOpenFrameRef.current);
          mobileSidebarOpenFrameRef.current = null;
        }
        setSidebarOpen(false);
        if (wasOpening) setMobileSidebarMounted(false);
      }
      return next;
    });
  }, [isMobile]);

  const handleSidebarToggle = useCallback(() => {
    if (isMobile) {
      if (sidebarOpen || mobileSidebarOpeningRef.current) {
        const wasOpening = mobileSidebarOpeningRef.current;
        mobileSidebarOpeningRef.current = false;
        if (mobileSidebarOpenFrameRef.current !== null) {
          window.cancelAnimationFrame(mobileSidebarOpenFrameRef.current);
          mobileSidebarOpenFrameRef.current = null;
        }
        setSidebarOpen(false);
        if (wasOpening) setMobileSidebarMounted(false);
        return;
      }
      setFileBrowserOpen(false);
      mobileSidebarOpeningRef.current = true;
      setMobileSidebarMounted(true);
      mobileSidebarOpenFrameRef.current = window.requestAnimationFrame(() => {
        mobileSidebarOpenFrameRef.current = null;
        // Establish the translated start frame before switching to open.
        sidebarPanel.panelRef.current?.getBoundingClientRect();
        mobileSidebarOpeningRef.current = false;
        setSidebarOpen(true);
      });
      return;
    }
    setSidebarOpen((prev) => {
      const next = !prev;
      return next;
    });
  }, [isMobile, sidebarOpen, sidebarPanel.panelRef]);

  const handleMobileSidebarClose = useCallback(() => {
    mobileSidebarOpeningRef.current = false;
    if (mobileSidebarOpenFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileSidebarOpenFrameRef.current);
      mobileSidebarOpenFrameRef.current = null;
    }
    setSidebarOpen(false);
  }, []);

  const handleMobileSidebarTransitionEnd = useCallback((event: React.TransitionEvent<HTMLDivElement>) => {
    if (!isMobile || sidebarOpen || event.target !== event.currentTarget) return;
    if (event.propertyName !== "transform" && event.propertyName !== "opacity") return;
    setMobileSidebarMounted(false);
  }, [isMobile, sidebarOpen]);

  // ── Unauthenticated: full-screen gate ────────────────────────────────────
  if (gateRequired) {
    return (
      <div style={{ position: "fixed", inset: 0, overflow: "hidden", background: "var(--bg)" }}>
        <LoginPage next="/" />
      </div>
    );
  }

  return (
    <>
    <div
      className="app-shell"
      data-visual-keyboard={isMobile && visualViewportFrame?.keyboardOpen ? "open" : undefined}
      style={{
        display: "flex",
        position: isMobile ? "fixed" : undefined,
        top: isMobile ? `${visualViewportFrame?.offsetTop ?? 0}px` : undefined,
        left: isMobile ? 0 : undefined,
        right: isMobile ? 0 : undefined,
        height: visualViewportFrame === null
          ? "calc(100dvh / var(--app-ui-scale, 1))"
          : `${visualViewportFrame.height}px`,
        overflow: "hidden",
        background: "var(--bg)",
      }}
    >
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
      {/* Do not retain a transparent full-screen fixed layer after the mobile
          drawer closes. WebKit can keep that compositor surface visible as a
          stale veil even when its CSS opacity reaches zero. */}
      {isMobile && sidebarOpen && mobileSidebarMounted ? (
        <div
          aria-hidden="true"
          className="sidebar-overlay-backdrop is-open"
          onClick={handleMobileSidebarClose}
        />
      ) : null}

      {/* Left sidebar: no floating toggle and no collapsed rail — the toggle
          lives in the title bar, left of the tab strip, on desktop and mobile. */}
      {!isMobile || mobileSidebarMounted ? <div
        ref={sidebarPanel.panelRef}
        className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}${sidebarPanel.isResizing ? " panel-is-resizing" : ""}`}
        aria-hidden={!sidebarOpen}
        inert={!sidebarOpen}
        onTransitionEnd={handleMobileSidebarTransitionEnd}
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
          cwd={search.cwd}
          selectedSessionId={search.session ?? null}
          // No holder/guessed current: the sidebar derives per-node
          // destructive-action gating from global liveSessionIds membership.
          liveSessionId={null}
          liveSessionIds={liveSessionIds}
          liveKnown={liveKnown}
          runningSessionIds={runningSessionIds}
          runningProjectRoots={runningProjectRoots}
          onSessionDeleted={handleSessionDeleted}
          onSelectSession={handleSelectSession}
          onNewSession={handleOpenNewSessionPage}
          canNewSession={canCreate}
          onOpenSettings={openSettings}
          onNewSessionInProject={handleOpenHomeForProject}
        />
      </div> : null}
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
          sidebarOpen={sidebarOpen}
          onSidebarToggle={handleSidebarToggle}
          tabs={tabs}
          activeTabId={activeTabId}
          onSelectTab={handleSelectTab}
          onCloseTab={handleCloseTab}
          onCloseOtherTabs={handleCloseOtherTabs}
          onCloseTabsToRight={handleCloseTabsToRight}
          onCloseAllTabs={handleCloseAllTabs}
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
                  onCreatedSessionDispatched={handleCreatedSessionDispatched}
                  onSessionActivitySettled={handleSessionActivitySettled}
                  projectRoots={knownProjectRoots}
                  onProjectChange={handleOpenHomeForProject}
                  {...(search.cwd === undefined ? {} : { cwd: search.cwd })}
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
                {/* Keyed by the selected session: a selection swap remounts the
                    transcript (local reveal window, scroll pin, minimap refs all
                    reset per identity) instead of reconciling A's rows into B. */}
                {observationError ? (
                  <div
                    role="alert"
                    data-testid="observation-error"
                    style={{
                      padding: "6px 14px",
                      fontSize: 12,
                      color: "var(--accent-orange)",
                      background: "color-mix(in srgb, var(--accent-orange) 10%, var(--bg-panel))",
                      borderBottom: "1px solid color-mix(in srgb, var(--accent-orange) 35%, var(--border))",
                    }}
                  >
                    {observationError}
                  </div>
                ) : null}
                <TranscriptList
                  key={activeSessionId ?? "home"}
                  live={selectionMatchesLive}
                  overscan={12}
                  {...(activeSessionId === null ? {} : { sessionId: activeSessionId })}
                />
                {selectionMatchesLive ? (
                  <ExtensionRequests live composerTextareaRef={composerTextareaRef} />
                ) : null}
                <Composer
                  live={selectionMatchesLive}
                  textareaRef={composerTextareaRef}
                  onCreateSession={handleCreateSession}
                  onCreatedSessionDispatched={handleCreatedSessionDispatched}
                  onSessionActivitySettled={handleSessionActivitySettled}
                  selectedSessionHasTitle={selectedSessionHasTitle}
                  {...(search.cwd === undefined ? {} : { cwd: search.cwd })}
                  {...(activeSessionId === null ? {} : { sessionId: activeSessionId })}
                />
              </>
            )}
          </main>
        </div>
      </div>

      {/* Right file panel: no rail strip — the toggle is pinned to the window's
          top-right (see below) on desktop and mobile. The panel closes to zero
          width. */}
      {fileBrowserOpen && (
        <div
          {...rightPanel.separatorProps}
          className="workspace-panel-splitter right-panel-splitter"
        />
      )}
      <div
        ref={rightPanel.panelRef}
        className={`right-panel-container ${fileBrowserOpen ? "right-panel-open" : "right-panel-closed"}${rightPanel.isResizing ? " panel-is-resizing" : ""}`}
        style={{
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-panel)",
        }}
      >
        <ExplorerPanel
          cwd={search.cwd}
          canFiles={canFiles}
          canGit={canGit}
          visible={fileBrowserOpen}
          onOpenFile={handleOpenFile}
        />
      </div>

      {/* File-browser toggle pinned to the window's top-right corner, OUTSIDE
          the chat column: the panel animates its width out of the right edge
          (right → left), and an in-flow title-bar button would slide left with
          the shrinking chat column instead of staying under the pointer. The
          explorer header reserves the same 36px slot, so opening the panel
          does not move the button. */}
      <div
        style={{
          position: "absolute",
          top: "env(safe-area-inset-top, 0px)",
          right: 0,
          zIndex: 605,
          display: "flex",
          alignItems: "center",
          height: 36,
        }}
      >
        <FileBrowserToggle
          open={fileBrowserOpen}
          canFiles={canFiles}
          onToggle={handleToggleFileBrowser}
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
        liveWorkspaceEnabled={liveWorkspaceEnabled}
        onCloseAction={() => setSettingsOpen(false)}
      />
    ) : null}
    </div>
    </>
  );
}
