import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { resolveSessionDisplayStatus, type SessionDisplayStatus } from "@/components/SessionStatusDot";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { createQueryOptions, queryKeys } from "@/api/query-keys";
import { WorkspaceFlagsDocumentSchema } from "@/api/schemas";
import { WORKSPACE_FLAGS_QUERY_KEY, migrateLocalOrganizationPrefsToServer } from "@/lib/workspace-flags";
import { PROJECT_PICKER_PAGE_SIZE, SESSION_PAGE_SIZE } from "@/api/session-list";
import { createMutationOptions } from "@/api/mutations";
import type { WorkspaceSearch } from "@/lib/search-params";
import { getFileName } from "@/lib/file-paths";
import { useI18n } from "@/hooks/useI18n";
import { TranscriptList } from "@/components/transcript/TranscriptList";
import { SubagentActivityCard } from "@/components/chat/SubagentActivityCard";
import { SubagentPanel } from "@/components/chat/SubagentPanel";
import { Composer, type ComposerHandle } from "@/components/shell/Composer";
import { toQueuedMessagesView, userQueuedMessagesView } from "@/components/chat/chat-runtime-view";
import { Sidebar } from "@/components/shell/Sidebar";
import { SessionSearchPalette } from "@/components/shell/SessionSearchPalette";
import { AppTitleBar, RightPaneToggle } from "@/components/shell/AppTitleBar";
import { SettingsModal, type SettingsTab } from "@/components/shell/SettingsModal";
import { LoginPage } from "@/components/shell/LoginPage";
import { ProjectTrustDialog } from "@/features/settings/ProjectTrustDialog";
import { ExtensionRequests } from "@/features/extension-request/ExtensionRequests";
import { registerChatOpenFileTarget } from "@/components/chat/chat-experience-bridge";
import { openSessionTarget, scanLiveToolEffects, showFilesOpenPath } from "@/lib/live-tool-effects";
import { FileViewer } from "@/features/workspace/viewer/FileViewer";
import { ExplorerPanel } from "@/features/workspace/explorer/ExplorerPanel";
import { SideChatPanel } from "@/features/side-chat/SideChatPanel";
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
  assistantTabId,
  minimalAssistantTab,
  openAssistantWorkspaceTab,
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
import { useSubagentActivity } from "@/features/subagents/use-subagent-activity";
import { useSessionTranscript } from "@/features/session-history/use-session-transcript";
import { selectTurnActivities, selectTurnStartedAt, shouldShowTodos, type SubagentActivity } from "@/lib/subagent-activity";
import { assistantPresentationKey, homePresentationKey, useRuntime, useRuntimeConnection, useRuntimeForegroundActivity, useRuntimeOwners, useSelectedRuntime, type PresentationProvenance } from "@/runtime";
import { describeRuntimeObservationError } from "@/runtime/observation-errors";
import { RUNTIME_OBSERVE_EXISTING_FEATURE } from "@fffattiger/pix-protocol";
import { ExtensionNotices } from "@/components/shell/ExtensionNotices";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useVisualViewportFrame } from "@/hooks/useVisualViewportHeight";
import { useGateStatus } from "@/features/gate/useGate";
import { useHttpClient } from "@/app/http-context";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import { ChatsCircleIcon, FilesIcon, RobotIcon, XIcon } from "@phosphor-icons/react";
import { AssistantEntryChip } from "@/components/shell/AssistantEntryChip";
import { setDraft } from "@/lib/draft-store";
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

type RightPane = "files" | "subagents" | "side_chat" | "preview" | null;

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
  // ── Cross-device session catalog sync + local-flag migration (round 5) ───
  // The Host pushes `sessions_changed` whenever session metadata changes
  // (rename, server-side pin/archive). Invalidate the list queries so every
  // open device refetches without user action.
  const sessionsChangedRevision = connection.sessionsChangedRevision;
  useEffect(() => {
    if (sessionsChangedRevision === 0) return;
    // Catalog-change notice: sessions AND workspace organization flags.
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.lists }),
      queryClient.invalidateQueries({ queryKey: WORKSPACE_FLAGS_QUERY_KEY }),
    ]);
  }, [queryClient, sessionsChangedRevision]);

  // One-time migration: legacy localStorage session AND project pins/archives
  // upload to the server (additive; server wins on conflict), then leave the
  // local key (only device-local project expansion remains).
  const migrationStarted = useRef(false);
  useEffect(() => {
    if (migrationStarted.current || !canBrowseSessions || !can("session.write")) return;
    migrationStarted.current = true;
    void migrateLocalOrganizationPrefsToServer({
      setFlags: (kind, key, flags) => http.patch("/v1/workspace-flags", { kind, key, ...flags }),
      getWorkspaceFlags: async () => http.get("/v1/workspace-flags", { schema: WorkspaceFlagsDocumentSchema }),
    });
  }, [can, canBrowseSessions, http]);

  // ── Assistant view (project-less evergreen conversation) ────────────────
  // `/?assistant=1` selects the assistant: the URL carries NO session id —
  // the binding (fixed Host-managed cwd + the latest session in it) is
  // server-authoritative via GET /v1/assistant. Capability-gated: without
  // the `assistant` token the flag degrades to the ordinary home view (the
  // sidebar entry is hidden, never a broken view). The query is read-only:
  // it never creates or activates anything; creation rides the normal
  // first-send transaction with the resolved cwd.
  const canAssistant = can("assistant");
  const isAssistantView = search.assistant === true && canAssistant;
  // The binding is also needed OUTSIDE the view (the sidebar entry and the
  // home composer's assistant chip both branch on "does the assistant
  // conversation exist yet"), so the query runs whenever the capability is
  // advertised — still read-only, never creating or activating anything.
  const assistantQuery = useQuery({ ...options.assistant.info(), enabled: canAssistant });
  const assistantInfo = canAssistant ? assistantQuery.data : undefined;
  /** Fixed assistant cwd once the binding resolved (undefined while loading/errored). */
  const assistantCwd = assistantInfo?.cwd;
  /** The assistant conversation session (null = not started yet). */
  const assistantSessionId = assistantInfo?.sessionId ?? null;
  // Exact runtime for the assistant's server-resolved session (the URL carries
  // no session id, so the provider-bound selection alone cannot see it). Null
  // outside the assistant view; `activeRuntime` below is the view-effective one.
  const assistantRuntime = useRuntime(isAssistantView ? assistantSessionId : null);
  const activeRuntime = isAssistantView ? assistantRuntime : selectedRuntime;
  const selectedWorkspace = useSelectedWorkspaceAccess(
    isAssistantView ? assistantSessionId : search.session ?? null,
    sessionsQuery.data?.sessions ?? null,
  );
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
      && search.assistant === undefined
      && search.assistantDraft === undefined
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
  // sessiond which workers are already live. Connecting the WebSocket does
  // NOT attach or activate a session: pure history stays 0-Worker. If a
  // selected URL names an ALREADY-LIVE Worker (busy or idle), the bounded
  // resume effect below reacquires observation only, so an in-flight stream
  // or child-task projection remains visible after re-entry/refresh without
  // creating or activating anything.
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
  const selectedSessionId = isAssistantView ? assistantSessionId : search.session ?? null;
  const presentationKey = search.file !== undefined && search.cwd !== undefined
    ? fileTabId(search.cwd, search.file)
    : selectedSessionId !== null
      ? sessionTabId(selectedSessionId)
      : isAssistantView
        ? assistantPresentationKey()
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
  // feature + exact HTTP workspace authorized + authoritative live baseline
  // known + the session already has a Worker in sessiond's live set + the
  // registry does not already hold/desire that observation lease.
  // Live includes idle Workers: a parent may be idle while children/todos
  // still need a fresh snapshot for the status card. Pure history (not in
  // liveSessionIds) still attaches NOTHING — never activate/createWorker,
  // never a failedExisting→activate fallback. Live/idle ≠ busy: this does
  // not mint runningSessionIds or render an idle Worker as working. A
  // live→absent transition does NOT cancel an eligible in-flight attach or
  // drop a terminal (this effect only ever ADDS observation); the acquired
  // idle subscription is kept until a transfer/release/stop. A missing
  // feature or a failed observation of a stale/inactive live baseline is
  // surfaced honestly and scoped to the exact controller — never an
  // activating fallback, never a silent catch, never stealing a previous
  // foreground lease. Settlement is gated by the registry-owned presentation
  // token captured BEFORE the call; a late A result cannot paint or clear B.
  const observeFeatureNegotiated = connection.acceptedFeatures.includes(RUNTIME_OBSERVE_EXISTING_FEATURE);
  const selectedLive = selectedSessionId !== null && connection.liveSessionIds.includes(selectedSessionId);
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
    // the lease while selectedLive stays true must not hammer-retry; a later
    // live-set / generation change is the recovery trigger. Registry
    // single-flight coalesces an already in-flight/held observe.
    const current = registry.leaseSnapshot;
    const observingSelected = current.holderSessionId === sessionId
      || current.desiredSessionId === sessionId
      || current.targetSessionId === sessionId;
    if (observingSelected) return;
    if (!observeFeatureNegotiated) {
      if (!selectedLive) return;
      applyObservationOutcome(registry.capturePresentation(), { code: "unsupported_capability", retryable: false });
      return;
    }
    if (!selectedLive) return;
    const token = registry.capturePresentation();
    void registry.observeExisting(sessionId).then(
      () => { applyObservationOutcome(token, null); },
      (cause: unknown) => { applyObservationOutcome(token, cause); },
    );
  }, [applyObservationOutcome, connection.generation, connection.liveSessionStateKnown, observeFeatureNegotiated, presentationAuthorized, registry, selectedLive, selectedSessionId]);

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
  // ⌘K session-search palette: the single global toggle (opens, closes, and
  // re-toggles while open). No other ⌘K/Ctrl+K shortcut exists in the app.
  const [searchPaletteOpen, setSearchPaletteOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const openSearchPalette = useCallback(() => setSearchPaletteOpen(true), []);
  const closeSearchPalette = useCallback(() => setSearchPaletteOpen(false), []);
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
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("providers");
  const [settingsOnPage, setSettingsOnPage] = useState(false);
  const openSettings = useCallback((tab: SettingsTab, onPage = false) => {
    setSettingsTab(tab);
    setSettingsOnPage(onPage);
    setSettingsOpen(true);
  }, []);

  // ── Shared right panel (Files, Agents, or Side chat) ─────────────────────
  const [rightPane, setRightPane] = useState<RightPane>(null);
  const [selectedChildSessionId, setSelectedChildSessionId] = useState<string | null>(null);
  /** File the preview pane shows (any allowed path, not only the workspace). Cleared when the pane closes. */
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [previewDisplayMode, setPreviewDisplayMode] = useState<"diff" | "preview" | undefined>(undefined);
  const rightPanelOpen = rightPane !== null;
  const fileBrowserOpen = rightPane === "files";
  const subagentPanelOpen = rightPane === "subagents";
  // The assistant's fixed directory is its workspace: the files pane browses
  // it like any project root.
  const filesCwd = isAssistantView ? assistantCwd : search.cwd;
  const canFiles = can("files") && liveWorkspaceEnabled && filesCwd !== undefined;
  const filesCwdRef = useRef(filesCwd);
  filesCwdRef.current = filesCwd;

  // ── Top-level workspace tabs (URL drives ACTIVE; session tabs are durable) ──
  const [tabs, setTabs] = useState<WorkspaceTab[]>(loadWorkspaceSessionTabs);
  // The active tab id is derived from the URL: cwd+file or cwd+session. The
  // active content is always derivable even before the tab is materialized
  // (deep links / back-forward), so the central area never flashes home.
  const activeTabId = search.file !== undefined && search.cwd !== undefined
    ? fileTabId(search.cwd, search.file)
    : search.session !== undefined
      ? sessionTabId(search.session)
      : isAssistantView
        ? assistantTabId()
        : null;
  const activeTab = useMemo<WorkspaceTab | null>(() => {
    if (activeTabId === null) return null;
    const inList = tabs.find((tab) => tab.id === activeTabId);
    if (inList) return inList;
    if (search.file !== undefined && search.cwd !== undefined) return minimalFileTab(search.cwd, search.file);
    if (search.session !== undefined) return minimalSessionTab(search.session, search.cwd);
    if (isAssistantView) return minimalAssistantTab();
    return null;
  }, [activeTabId, isAssistantView, tabs, search.file, search.cwd, search.session]);
  const activeSessionId = activeTab?.kind === "session" ? activeTab.sessionId : null;
  // View-effective session: the assistant conversation when the assistant view
  // is selected (the URL carries no session id), else the URL-selected tab.
  const viewSessionId = isAssistantView ? assistantSessionId : activeSessionId;

  // URL → tab reconciliation: keep the in-memory tab list in sync with the URL
  // and the current cwd. File tabs are cwd-owned (a cwd switch clears them);
  // session tabs remember their cwd; the Pixie tab is a cwd-less singleton.
  // This NEVER attaches — it only materializes the active content as a tab so
  // the strip stays populated. The Pixie tab materializes once the binding
  // resolved WITH a conversation (a null binding redirects to the draft entry,
  // so no dead tab would linger); until then the URL-derived minimal tab is
  // enough for the strip.
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
      } else if (isAssistantView && assistantSessionId !== null) {
        next = openAssistantWorkspaceTab(next);
      }
      return next;
    });
  }, [assistantSessionId, isAssistantView, search.cwd, search.session, search.file]);
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
    } else if (search.file === undefined && !isAssistantView && search.assistantDraft === undefined) {
      // A cwd-scoped new-session page is an intentional home. File tabs are
      // ephemeral, so viewing one preserves the previous session target; the
      // assistant view and the assistant draft state are NOT home declarations
      // — visiting them must not erase the cold-start restore target.
      saveLastWorkspaceSession(null);
    }
  }, [search.cwd, search.file, search.session, search.assistantDraft]);
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
  // activate/open a worker: a non-live selected session stays a read-only
  // history view while the Composer remains editable; sending is the
  // activation trigger through `sendPromptToSession`. The ONE observation-
  // only exception is a session already in sessiond's live set under the
  // full admission predicate (LC-02 auto-observe above): an observation-only
  // attach (`attachMode: existing_only`) with zero activation, applied to
  // EVERY entry point — initial URL, sidebar, tab, back/forward — so an
  // in-flight stream or live idle parent's task projection stays visible
  // across re-entry/refresh and A→B→A switches. Live/idle is not busy: the
  // Worker is not rendered as working. An acquired subscription is kept
  // across busy→idle until transfer/release; every visible surface stays
  // active-session identity-gated.

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

  // Session labels for the tab strip — resolve the initial catalog page first,
  // then fetch exact details for open tabs outside that page. Persisted tabs
  // can outlive the five-row sidebar page, so selection must not be required
  // before their titles become available.
  const tabSessionIds = useMemo(
    () => tabs.flatMap((tab) => tab.kind === "session" ? [tab.sessionId] : []),
    [tabs],
  );
  const tabSessionDetailQueries = useQueries({
    queries: tabSessionIds.map((sessionId) => ({
      ...options.sessions.detail(sessionId),
      enabled: canBrowseSessions
        && sessionsQuery.data !== undefined
        && !sessionsQuery.data.sessions.some((session) => session.sessionId === sessionId)
        && selectedWorkspace.header?.sessionId !== sessionId,
    })),
  });
  const catalogSessions = useMemo(() => {
    const sessionsById = new Map(
      (sessionsQuery.data?.sessions ?? []).map((session) => [session.sessionId, session]),
    );
    const selectedHeader = selectedWorkspace.header;
    if (selectedHeader !== undefined) sessionsById.set(selectedHeader.sessionId, selectedHeader);
    for (const query of tabSessionDetailQueries) {
      const session = query.data?.session;
      if (session !== undefined) sessionsById.set(session.sessionId, session);
    }
    return [...sessionsById.values()];
  }, [selectedWorkspace.header, sessionsQuery.data, tabSessionDetailQueries]);
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

  // Assistant entry: the SAME evergreen conversation. With an existing
  // assistant session the sidebar opens it directly; without one it routes to
  // the new-session page in assistant state (the draft entry) — the old
  // first-entry landing page is gone. Capability-gated by the Sidebar
  // (canAssistant); while the binding is unresolved (loading/error) the view
  // URL stays the honest fallback (its own degraded copy handles it).
  const handleOpenAssistant = useCallback(() => {
    if (isMobile) setSidebarOpen(false);
    if (liveSearchRef.current.assistant === true) return;
    if (liveSearchRef.current.assistantDraft === true) return;
    void navigate(
      assistantInfo !== undefined && assistantInfo.sessionId === null
        ? { to: "/", search: { assistantDraft: true } }
        : { to: "/", search: { assistant: true } },
    );
  }, [assistantInfo, isMobile, navigate]);

  // The assistant chip on the new-session page: with an existing assistant
  // conversation the draft text travels along (filled into the assistant
  // composer, never sent); without one the page enters assistant state.
  const handleAssistantChipActivate = useCallback(() => {
    const existing = assistantInfo?.sessionId;
    if (existing !== undefined && existing !== null) {
      const draftText = composerTextareaRef.current?.value ?? "";
      if (draftText.trim() !== "") setDraft(existing, { value: draftText, images: [] });
      if (isMobile) setSidebarOpen(false);
      void navigate({ to: "/", search: { assistant: true } });
      return;
    }
    void navigate({ to: "/", search: { assistantDraft: true } });
  }, [assistantInfo, isMobile, navigate]);

  const handleAssistantChipDismiss = useCallback(() => {
    void navigate({ to: "/", search: {} });
  }, [navigate]);

  // The assistant view renders the conversation branch even with no session
  // tab. The assistant DRAFT (`/?draft=assistant`) lives on the home stack:
  // the first assistant message is composed with the project picker hidden.
  const isHome = activeTab === null && !isAssistantView;
  const isAssistantDraft = isHome && search.assistantDraft === true && canAssistant;

  // A direct `?assistant=1` visit with no assistant conversation yet (old
  // bookmark / sidebar before the binding cached) lands on the draft entry
  // instead of the removed first-entry landing page. Runs only after the
  // binding resolved — while unresolved the view keeps its honest loading /
  // degraded copy.
  useEffect(() => {
    if (!isAssistantView || assistantInfo === undefined) return;
    if (assistantInfo.sessionId !== null) return;
    void navigate({ to: "/", search: { assistantDraft: true } });
  }, [assistantInfo, isAssistantView, navigate]);

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
  // Transport recovery keeps the frame live: the last admitted state stays on
  // screen and sends wait for the re-attach, instead of flipping to history
  // (which cannot load while the network is still coming back).
  const selectionMatchesLive = activeRuntime?.attached === true || activeRuntime?.resuming === true;
  const canAgents = canBrowseSessions && viewSessionId !== null;
  const canSideChat = selectionMatchesLive
    && activeRuntime?.capabilities?.capabilities.includes("runtime.side_chat") === true;
  const rightPaneAvailable = canFiles || canAgents || canSideChat;
  const composerRef = useRef<ComposerHandle>(null);
  const queuedMessages = useMemo(
    () => (selectionMatchesLive ? userQueuedMessagesView(toQueuedMessagesView(activeRuntime?.snapshot?.state.queuedMessages)) : null),
    [selectionMatchesLive, activeRuntime?.snapshot?.state.queuedMessages],
  );
  // --- queued-delivery type toggle (capsule rows) ----------------------------
  // The label flip is optimistic UI in its own transaction layer: it paints on
  // click, is removed when the runtime's switch_queued_delivery settles either
  // way, and NEVER writes into the authoritative queue projection — the next
  // queue_update remains the single source of truth for the queue.
  const [queuedSwitchOverlay, setQueuedSwitchOverlay] = useState<{ list: "steering" | "followUp"; message: string } | null>(null);
  const [queuedSwitchError, setQueuedSwitchError] = useState<string | null>(null);
  const queuedSwitchInFlight = useRef(false);
  const canSwitchQueued = selectionMatchesLive
    && activeRuntime?.capabilities?.capabilities.includes("runtime.queue") === true;
  const queuedMessagesView = useMemo(() => {
    if (queuedMessages === null || queuedSwitchOverlay === null) return queuedMessages;
    // Remove ONE occurrence (the first) of the message from its list and append
    // it to the other list: that is exactly what the runtime command does.
    const removeOne = (list: readonly string[], text: string): string[] => {
      const at = list.indexOf(text);
      return at === -1 ? [...list] : [...list.slice(0, at), ...list.slice(at + 1)];
    };
    const steering = queuedSwitchOverlay.list === "steering"
      ? removeOne(queuedMessages.steering, queuedSwitchOverlay.message)
      : [...queuedMessages.steering, queuedSwitchOverlay.message];
    const followUp = queuedSwitchOverlay.list === "followUp"
      ? removeOne(queuedMessages.followUp, queuedSwitchOverlay.message)
      : [...queuedMessages.followUp, queuedSwitchOverlay.message];
    return { steering, followUp };
  }, [queuedMessages, queuedSwitchOverlay]);
  const handleToggleQueuedDelivery = useCallback((index: number) => {
    if (!canSwitchQueued || queuedSwitchInFlight.current) return;
    const steering = queuedMessages?.steering ?? [];
    const followUp = queuedMessages?.followUp ?? [];
    const all = [...steering, ...followUp];
    const message = all[index];
    if (message === undefined) return;
    const list = index < steering.length ? "steering" : "followUp";
    queuedSwitchInFlight.current = true;
    setQueuedSwitchError(null);
    setQueuedSwitchOverlay({ list, message });
    const done = (): void => {
      queuedSwitchInFlight.current = false;
      setQueuedSwitchOverlay(null);
    };
    void Promise.resolve(composerRef.current?.toggleQueuedDelivery(index))
      .catch((cause: unknown) => {
        done();
        // Light, fixed copy (never raw error text): the label reverts to the
        // authoritative queue projection on the next queue_update.
        void cause;
        setQueuedSwitchError(t("desktop.queueSwitchFailed"));
        return undefined;
      })
      .then(done);
  }, [canSwitchQueued, queuedMessages, t]);
  const subagentActivity = useSubagentActivity({
    sessionId: viewSessionId,
    enabled: canBrowseSessions && viewSessionId !== null,
    live: selectionMatchesLive,
  });
  // The capsule shows THIS turn only: agents delegated before the user's latest
  // message left the capsule (the agents pane keeps the full history), and a
  // fully completed todo list drops out once the turn is over. The turn starts
  // at the newest user-authored message in the SAME merged transcript the chat
  // renders; Pixie's notices are user-role entries but never open a turn.
  const statusTranscript = useSessionTranscript({
    sessionId: viewSessionId,
    enabled: viewSessionId !== null,
    live: selectionMatchesLive,
  });
  const turnStartedAt = useMemo(
    () => selectTurnStartedAt(statusTranscript.entries.map((entry) => entry.message)),
    [statusTranscript.entries],
  );
  const runningAgentCount = useMemo(
    () => subagentActivity.activities.filter((activity) => activity.status === "running").length,
    [subagentActivity.activities],
  );
  // A child pane belongs to its selected parent session. Switching the URL
  // closes it instead of showing A's child conversation beside B.
  useEffect(() => {
    setRightPane((current) => current === "files" ? current : null);
    setSelectedChildSessionId(null);
  }, [viewSessionId]);
  // Global running authority = connection.runningSessionIds (sessiond busy
  // baseline) UNION the registry foreground optimistic/turn owner (background
  // or mid-transfer send cue) UNION the selected exact session while it is
  // attached and busy/pending. Foreground activity is indicator-only — never
  // selected snapshot, never a lifecycle owner.
  const runningSessionIds = useMemo<ReadonlySet<string>>(() => {
    const ids = new Set<string>(connection.runningSessionIds);
    if (foregroundActivity.optimisticRunningSessionId) ids.add(foregroundActivity.optimisticRunningSessionId);
    if (activeRuntime?.attached === true) {
      const state = activeRuntime.snapshot?.state;
      const authoritativeBusy = activeRuntime.streaming
        || state?.isPromptRunning === true
        || state?.isStreaming === true
        || state?.isBashRunning === true
        || state?.isCompacting === true;
      if (activeRuntime.promptPending || authoritativeBusy) ids.add(activeRuntime.sessionId);
    }
    return ids;
  }, [connection.runningSessionIds, foregroundActivity.optimisticRunningSessionId, activeRuntime]);
  // Capsule payload for the turn in progress: the turn is over once its session
  // is no longer in the authoritative running set.
  const turnRunning = useMemo(
    () => runningSessionIds.has(viewSessionId ?? ""),
    [runningSessionIds, viewSessionId],
  );
  const capsuleActivities = useMemo(
    () => selectTurnActivities(subagentActivity.activities, turnStartedAt),
    [subagentActivity.activities, turnStartedAt],
  );
  const capsuleTodos = useMemo(() => {
    // Without a dated user message the turn boundary is unknown (history still
    // loading, older producer): keep the unfiltered list instead of guessing.
    if (turnStartedAt === null || shouldShowTodos(subagentActivity.todos, turnRunning)) {
      return subagentActivity.todos;
    }
    return [];
  }, [subagentActivity.todos, turnRunning, turnStartedAt]);

  // ── Global liveness for sidebar/tab indicators ──
  // connection.liveSessionIds is the authoritative list of session ids with a
  // live Worker (busy OR idle) from sessiond; the selected exact session is
  // additionally live while it is attached (its exact controller holds the
  // observation lease). This feeds indicators. The resume effect may also
  // observe an already-live selected Worker (idle included) for a fresh
  // snapshot; it never activates inactive history or creates a Worker.
  const liveSessionIds = useMemo<ReadonlySet<string>>(() => {
    const ids = new Set<string>(connection.liveSessionIds);
    if (activeRuntime?.attached === true) ids.add(activeRuntime.sessionId);
    return ids;
  }, [connection.liveSessionIds, activeRuntime]);
  // Waiting-for-user projection from the same authoritative watch (pending
  // extension UI). Never client-inferred: an older sessiond without the
  // field projects nothing and no waiting markers appear.
  const waitingSessionIds = useMemo<ReadonlySet<string>>(
    () => new Set(connection.waitingSessionIds),
    [connection.waitingSessionIds],
  );
  // The liveness baseline is KNOWN once the socket received it (connection
  // truth); selection never fabricates knowledge.
  const liveKnown = connection.liveSessionStateKnown;

  // Pixie entry/tab marker, resolved through the SAME shared rule as ordinary
  // sessions: error while residency is failing/restarting (restart backoff),
  // else waiting/running of its conversation. Online/starting residency
  // states are deliberately NOT shown — Pixie is always-on by design.
  const assistantStatus = useMemo<SessionDisplayStatus | undefined>(() => {
    const residencyError = connection.assistantPresence?.status === "restarting";
    if (assistantSessionId === null) {
      return residencyError ? "error" : undefined;
    }
    return resolveSessionDisplayStatus({
      error: residencyError,
      waiting: waitingSessionIds.has(assistantSessionId),
      running: runningSessionIds.has(assistantSessionId),
    });
  }, [assistantSessionId, connection.assistantPresence, runningSessionIds, waitingSessionIds]);

  const runningProjectRoots = useMemo<ReadonlySet<string>>(() => {
    const roots = new Set<string>();
    for (const session of catalogSessions) {
      if (runningSessionIds.has(session.sessionId)) roots.add(session.projectRoot || session.cwd);
    }
    for (const tab of tabs) {
      if (tab.kind === "session" && runningSessionIds.has(tab.sessionId) && tab.cwd) roots.add(tab.cwd);
    }
    if (activeRuntime?.attached === true && runningSessionIds.has(activeRuntime.sessionId)) {
      const root = activeRuntime.snapshot?.projectRoot ?? activeRuntime.snapshot?.cwd;
      if (root) roots.add(root);
    }
    return roots;
  }, [runningSessionIds, activeRuntime, catalogSessions, tabs]);

  // D4 session-history delete navigation. AppShell is the single navigation
  // owner: when the deleted session equals the URL-selected session it clears
  // Multi-tab session creation remains available while another session is
  // attached (Host agent capability gate for the sidebar New Session action).

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

  // Assistant first-send create: the fixed server-resolved cwd replaces the
  // draft's project selection (the assistant composer has no project picker).
  // Fails closed while the binding has not resolved (invalid_input).
  const handleCreateAssistantSession = useCallback(async (): Promise<{ sessionId: string; cwd: string }> => {
    if (assistantCwd === undefined) {
      return Promise.reject({
        code: "invalid_input",
        message: "assistant workspace is not resolved",
        retryable: false,
        phase: "activation",
      });
    }
    const result = await createSession({ cwd: assistantCwd, projectRoot: assistantCwd });
    return { sessionId: result.sessionId, cwd: assistantCwd };
  }, [assistantCwd, createSession]);

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
      if (isAssistantView || isAssistantDraft) {
        // The assistant URL carries no session id: publish the binding so the
        // view switches from the draft/loading state to the conversation. A
        // draft-originated create also navigates from the home page to the
        // assistant conversation (the sidebar's assistant URL).
        queryClient.setQueryData(queryKeys.assistant.info(), { cwd: created.cwd, sessionId: created.sessionId });
        if (isAssistantDraft) {
          void navigate({ to: "/", search: { assistant: true } });
        }
      } else {
        void navigate({ to: "/", search: { cwd: created.cwd, session: created.sessionId } });
      }
    }
  }, [isAssistantDraft, isAssistantView, navigate, primeMissingSession, queryClient, registry]);

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
  // Clicking a tab navigates the URL to that tab's content (cwd+file,
  // cwd+session, or the assistant selector). This NEVER attaches: session
  // tabs activate a read-only history view; sending remains the activation
  // trigger. Back/forward and deep links are handled by the same derivation
  // (the active tab is read from the URL), so a route change activates or
  // recreates the matching tab.
  const navigateToTab = useCallback((tab: WorkspaceTab): void => {
    if (tab.kind === "assistant") {
      void navigate({ to: "/", search: { assistant: true } });
      return;
    }
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

  const closeRightPane = useCallback(() => {
    setRightPane(null);
    setPreviewFile(null);
    setPreviewDisplayMode(undefined);
    setSelectedChildSessionId(null);
  }, []);

  // ── File open ────────────────────────────────────────────────────────────
  // Opening a file (file browser, chat file links, written-file rows,
  // linked files) creates/activates ONE file tab owned by the current
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
    const cwd = liveSearchRef.current.cwd ?? filesCwdRef.current;
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
    if (isMobile) closeRightPane();
  }, [canFiles, closeRightPane, navigate, isMobile]);

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
      // The chip row under an answer stays in the conversation: it previews
      // in the right pane. Every other chat link still opens a main-area tab.
      if (options?.source === "turn-files") {
        setPreviewFile(filePath);
        // A file handed over in the answer opens rendered (openfile); the
        // explicit diff action keeps its diff.
        setPreviewDisplayMode(options.initialDisplayMode ?? "preview");
        setRightPane("preview");
        return;
      }
      handleOpenFile(filePath, getFileName(filePath), {
        ...options,
        sourceSessionId: activeSessionId,
      });
    });
  }, [canFiles, handleOpenFile, activeSessionId]);

  // Chips under an answer open in the right pane instead of taking over the
  // main area, so the conversation (and the assistant view) stays put.
  const handlePreviewFile = useCallback((filePath: string): void => {
    if (!canFiles) return;
    setPreviewFile(filePath);
    setPreviewDisplayMode(undefined);
    setRightPane("preview");
  }, [canFiles]);

  // Live tool results of the session the user is looking at. The first scan
  // after mount (and after every session switch) only records what is already
  // there, so history, resync and refresh never reopen a pane or a tab.
  const liveEffectSeenRef = useRef(new Set<string>());
  const liveEffectPrimedRef = useRef(false);
  useEffect(() => {
    liveEffectSeenRef.current = new Set();
    liveEffectPrimedRef.current = false;
  }, [viewSessionId]);
  const liveEntries = activeRuntime?.liveEntries;
  useEffect(() => {
    if (viewSessionId === null || liveEntries === undefined) return;
    const scan = scanLiveToolEffects(liveEntries.map((entry) => entry.message), liveEffectSeenRef.current, liveEffectPrimedRef.current);
    for (const id of scan.seen) liveEffectSeenRef.current.add(id);
    liveEffectPrimedRef.current = true;
    for (const effect of scan.fresh) {
      if (effect.isError) continue;
      if (effect.toolName === "show_files") {
        const open = showFilesOpenPath(effect.details);
        if (open !== null && canFiles) {
          setPreviewFile(open);
          setPreviewDisplayMode("preview");
          setRightPane("preview");
        }
      } else if (effect.toolName === "open_session" && isAssistantView) {
        const target = openSessionTarget(effect.details);
        if (target !== null) {
          setTabs((prev) => openSessionWorkspaceTab(prev, target.sessionId, target.cwd));
        }
      }
    }
  }, [canFiles, isAssistantView, liveEntries, viewSessionId]);

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
    ariaLabel: t("desktop.resizeRightPanel"),
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
    if (!rightPanelOpen) return;
    reclampSidebarWidth();
    reclampRightPanelWidth();
  }, [reclampRightPanelWidth, reclampSidebarWidth, rightPanelOpen]);

  // ── Shared right-panel toggling ──────────────────────────────────────────
  const dismissMobileSidebar = useCallback(() => {
    if (!isMobile) return;
    const wasOpening = mobileSidebarOpeningRef.current;
    mobileSidebarOpeningRef.current = false;
    if (mobileSidebarOpenFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileSidebarOpenFrameRef.current);
      mobileSidebarOpenFrameRef.current = null;
    }
    setSidebarOpen(false);
    if (wasOpening) setMobileSidebarMounted(false);
  }, [isMobile]);

  const selectRightPane = useCallback((pane: Exclude<RightPane, null>) => {
    if ((pane === "files" && !canFiles) || (pane === "subagents" && !canAgents) || (pane === "side_chat" && !canSideChat)) return;
    setRightPane(pane);
    if (pane !== "subagents") setSelectedChildSessionId(null);
    dismissMobileSidebar();
  }, [canAgents, canFiles, canSideChat, dismissMobileSidebar]);

  // Desktop rail: clicking the open pane's icon closes the panel; clicking
  // another icon switches panes. Mobile has no rail — it keeps the
  // RightPaneToggle plus the in-panel tab selector.
  const handleRailSelect = useCallback((pane: Exclude<RightPane, null>) => {
    if (rightPane === pane) {
      closeRightPane();
      return;
    }
    selectRightPane(pane);
  }, [closeRightPane, rightPane, selectRightPane]);

  const handleToggleRightPane = useCallback(() => {
    if (rightPane !== null) {
      closeRightPane();
      return;
    }
    if (canFiles) selectRightPane("files");
    else if (canAgents) selectRightPane("subagents");
    else if (canSideChat) selectRightPane("side_chat");
  }, [canAgents, canFiles, canSideChat, closeRightPane, rightPane, selectRightPane]);

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
      closeRightPane();
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
    setSidebarOpen((prev) => !prev);
  }, [closeRightPane, isMobile, sidebarOpen, sidebarPanel.panelRef]);

  const handleMobileSidebarClose = useCallback(() => {
    mobileSidebarOpeningRef.current = false;
    if (mobileSidebarOpenFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileSidebarOpenFrameRef.current);
      mobileSidebarOpenFrameRef.current = null;
    }
    setSidebarOpen(false);
  }, []);

  const openSubagentPanel = useCallback((childSessionId: string | null) => {
    if (!canAgents) return;
    setSelectedChildSessionId(childSessionId);
    setRightPane("subagents");
    if (isMobile) handleMobileSidebarClose();
  }, [canAgents, handleMobileSidebarClose, isMobile]);
  const handleOpenSubagentActivity = useCallback((activity: SubagentActivity) => {
    if (activity.childSessionId === undefined) return;
    openSubagentPanel(activity.childSessionId);
  }, [openSubagentPanel]);
  const handleCloseSubagentPanel = useCallback(() => {
    closeRightPane();
  }, [closeRightPane]);

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
          background: "var(--surface-frame)",
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
          waitingSessionIds={waitingSessionIds}
          runningProjectRoots={runningProjectRoots}
          onSessionDeleted={handleSessionDeleted}
          onSelectSession={handleSelectSession}
          onNewSession={handleOpenNewSessionPage}
          canNewSession={canAgent}
          onOpenSearch={openSearchPalette}
          onOpenSettings={openSettings}
          onNewSessionInProject={handleOpenHomeForProject}
          onOpenAssistant={handleOpenAssistant}
          assistantActive={isAssistantView}
          canAssistant={canAssistant}
          assistantStatus={assistantStatus}
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
      <div className="chat-column" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "visible", minWidth: 0 }}>
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
          waitingSessionIds={waitingSessionIds}
          assistantStatus={assistantStatus}
        />
        <div className="conversation-container" style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          <main className={`workspace${isHome ? " workspace--home" : ""}`}>
            {isHome ? (
              <div className="home-stack" data-testid="home-stack">
                <div className="transcript-home" data-testid="transcript-home">
                  <div className="transcript-home-logo" aria-hidden="true" />
                  <h1 className="transcript-home-title">{t("desktop.startConversation")}</h1>
                </div>
                {canAssistant ? (
                  <AssistantEntryChip
                    state={
                      isAssistantDraft
                        ? "selected"
                        : search.cwd === undefined ? "idle" : "hidden"
                    }
                    onActivate={handleAssistantChipActivate}
                    onDismiss={handleAssistantChipDismiss}
                  />
                ) : null}
                <Composer
                  live={false}
                  textareaRef={composerTextareaRef}
                  onCreateSession={isAssistantDraft ? handleCreateAssistantSession : handleCreateSession}
                  onCreatedSessionDispatched={handleCreatedSessionDispatched}
                  onSessionActivitySettled={handleSessionActivitySettled}
                  {...(isAssistantDraft ? {} : {
                    projectRoots: knownProjectRoots,
                    onProjectChange: handleOpenHomeForProject,
                  })}
                  {...(isAssistantDraft ? { placeholder: t("desktop.assistantDraftPlaceholder") } : {})}
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
                <ExtensionNotices
                  notices={selectionMatchesLive
                    ? activeRuntime?.snapshot?.state.extensionNotifications ?? []
                    : []}
                />
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
                {isAssistantView && assistantInfo === undefined ? (
                  // First entry before the binding resolves: an honest loading
                  // state, or the fixed degraded copy when the Host cannot
                  // answer (the capability retracted mid-view / sessiond down).
                  <div
                    className="transcript-empty"
                    role={assistantQuery.isError ? "alert" : "status"}
                    aria-busy={assistantQuery.isError ? undefined : true}
                    data-testid="assistant-binding-state"
                  >
                    {assistantQuery.isError ? null : <span className="transcript-loading-dot" aria-hidden="true" />}
                    {assistantQuery.isError ? t("desktop.assistantUnavailable") : t("desktop.loadingSession")}
                  </div>
                ) : (
                  <TranscriptList
                    key={viewSessionId ?? (isAssistantView ? "assistant" : "home")}
                    live={selectionMatchesLive}
                    overscan={12}
                    {...(viewSessionId === null ? {} : { sessionId: viewSessionId })}
                  />
                )}
                {selectionMatchesLive ? (
                  <ExtensionRequests live runtime={activeRuntime} composerTextareaRef={composerTextareaRef} />
                ) : null}
                {viewSessionId === null ? null : (
                  <SubagentActivityCard
                    key={`status:${viewSessionId}`}
                    activities={capsuleActivities}
                    todos={capsuleTodos}
                    queuedMessages={queuedMessagesView}
                    {...(canSwitchQueued ? { onToggleQueuedDelivery: handleToggleQueuedDelivery, queueSwitchError: queuedSwitchError } : {})}
                    onRecallQueue={() => composerRef.current?.recallQueue()}
                    onOpenActivity={handleOpenSubagentActivity}
                  />
                )}
                {isAssistantView && assistantInfo === undefined ? null : (
                  <Composer
                    ref={composerRef}
                    live={selectionMatchesLive}
                    textareaRef={composerTextareaRef}
                    onCreateSession={isAssistantView ? handleCreateAssistantSession : handleCreateSession}
                    onCreatedSessionDispatched={handleCreatedSessionDispatched}
                    onSessionActivitySettled={handleSessionActivitySettled}
                    selectedSessionHasTitle={isAssistantView ? false : selectedSessionHasTitle}
                    {...(isAssistantView ? { placeholder: t("desktop.assistantPlaceholder") } : {})}
                    {...(search.cwd === undefined ? {} : { cwd: search.cwd })}
                    {...(viewSessionId === null ? {} : { sessionId: viewSessionId })}
                  />
                )}
              </>
            )}
          </main>
        </div>
      </div>

      {/* Files, Agents, and Side chat share the existing responsive pane. */}
      {rightPanelOpen && (
        <div
          {...rightPanel.separatorProps}
          className="workspace-panel-splitter right-panel-splitter"
        />
      )}
      <div
        ref={rightPanel.panelRef}
        className={`right-panel-container ${rightPanelOpen ? "right-panel-open" : "right-panel-closed"}${rightPanel.isResizing ? " panel-is-resizing" : ""}`}
        aria-hidden={!rightPanelOpen}
        inert={!rightPanelOpen}
        style={{
          display: "flex",
          flexDirection: "column",
          background: "var(--surface-frame)",
        }}
      >
        {isMobile ? (
          <div className="right-pane-selector-wrap">
            <div className="right-pane-selector" role="group" aria-label={t("desktop.rightPane")}>
              <button type="button" aria-pressed={rightPane === "files"} disabled={!canFiles} onClick={() => selectRightPane("files")}>
                <FilesIcon size={14} aria-hidden="true" />{t("desktop.files")}
              </button>
              <button type="button" aria-pressed={rightPane === "subagents"} disabled={!canAgents} onClick={() => selectRightPane("subagents")}>
                <RobotIcon size={14} aria-hidden="true" />{t("desktop.agents")}
              </button>
              <button type="button" aria-pressed={rightPane === "side_chat"} disabled={!canSideChat} title={!canSideChat ? t("desktop.sideChatUnavailable") : undefined} onClick={() => selectRightPane("side_chat")}>
                <ChatsCircleIcon size={14} aria-hidden="true" />{t("desktop.sideChat")}
              </button>
            </div>
            {rightPane === "side_chat" && !canSideChat ? <div className="right-pane-selector-hint" role="status">{t("desktop.sideChatUnavailable")}</div> : null}
          </div>
        ) : null}
        <div className="right-panel-content">
          <div className="right-panel-surface" hidden={!fileBrowserOpen}>
            <ExplorerPanel
              cwd={filesCwd}
              canFiles={canFiles}
              visible={fileBrowserOpen}
              onOpenFile={handleOpenFile}
            />
          </div>
          {rightPane === "preview" && previewFile !== null && filesCwd !== undefined ? (
            <section className="subagent-panel" aria-label={t("desktop.previewFile", { file: getFileName(previewFile) })}>
              <header className="subagent-panel-head">
                <span className="subagent-panel-heading" title={previewFile}>{getFileName(previewFile)}</span>
                <span className="subagent-panel-head-spacer" />
                <button
                  type="button"
                  className="subagent-icon-button"
                  onClick={closeRightPane}
                  title={t("desktop.close")}
                  aria-label={t("desktop.close")}
                >
                  <XIcon size={15} aria-hidden="true" />
                </button>
              </header>
              <FileViewer
                key={`${previewFile}:${previewDisplayMode ?? "source"}`}
                filePath={previewFile}
                cwd={filesCwd}
                sourceSessionId={viewSessionId}
                {...(previewDisplayMode === undefined ? {} : { initialDisplayMode: previewDisplayMode })}
                onOpenFile={handlePreviewFile}
              />
            </section>
          ) : null}
          {subagentPanelOpen && viewSessionId !== null ? (
            <SubagentPanel
              activities={subagentActivity.activities}
              error={subagentActivity.error}
              loading={subagentActivity.loading}
              refreshing={subagentActivity.refreshing}
              parentSessionId={viewSessionId}
              parentEpoch={subagentActivity.epoch}
              subagentsRevision={subagentActivity.revision}
              selectedChildSessionId={selectedChildSessionId}
              onSelectActivity={handleOpenSubagentActivity}
              onBack={() => setSelectedChildSessionId(null)}
              onClose={handleCloseSubagentPanel}
              onRefresh={subagentActivity.refresh}
              closable={isMobile}
              childStream={subagentActivity.childStream(selectedChildSessionId)}
            />
          ) : null}
          {rightPane === "side_chat" && canSideChat && activeRuntime !== null ? (
            <SideChatPanel
              runtime={activeRuntime}
              cwd={search.cwd ?? (isAssistantView ? assistantInfo?.cwd : undefined)}
              onOpenFile={(filePath) => handleOpenFile(filePath, getFileName(filePath), { sourceSessionId: activeSessionId })}
            />
          ) : null}
        </div>
      </div>

      {/* Desktop: vertical icon rail selects/closes the shared right panel. */}
      {!isMobile && rightPaneAvailable ? (
        <nav className="right-pane-rail" aria-label={t("desktop.rightPane")} data-testid="right-pane-rail">
          <button
            type="button"
            aria-pressed={rightPane === "files"}
            disabled={!canFiles}
            title={t("desktop.files")}
            aria-label={t("desktop.files")}
            onClick={() => handleRailSelect("files")}
          >
            <FilesIcon size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-pressed={rightPane === "subagents"}
            disabled={!canAgents}
            title={t("desktop.agents")}
            aria-label={t("desktop.agents")}
            onClick={() => handleRailSelect("subagents")}
          >
            <RobotIcon size={18} aria-hidden="true" />
            {runningAgentCount > 0 ? <span className="right-pane-rail-badge">{runningAgentCount}</span> : null}
          </button>
          <button
            type="button"
            aria-pressed={rightPane === "side_chat"}
            disabled={!canSideChat}
            title={canSideChat ? t("desktop.sideChat") : t("desktop.sideChatUnavailable")}
            aria-label={t("desktop.sideChat")}
            onClick={() => handleRailSelect("side_chat")}
          >
            <ChatsCircleIcon size={18} aria-hidden="true" />
          </button>
        </nav>
      ) : null}

      {/* Mobile keeps the corner toggle for the shared right panel. */}
      {isMobile ? (
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
          <RightPaneToggle
            open={rightPanelOpen}
            available={rightPanelOpen || rightPaneAvailable}
            onToggle={handleToggleRightPane}
          />
        </div>
      ) : null}
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
        openOnPage={settingsOnPage}
        onCloseAction={() => setSettingsOpen(false)}
      />
    ) : null}
    <SessionSearchPalette
      open={searchPaletteOpen}
      onClose={closeSearchPalette}
      onOpenSession={handleSelectSession}
      runningSessionIds={runningSessionIds}
      waitingSessionIds={waitingSessionIds}
    />
    </div>
    </>
  );
}
