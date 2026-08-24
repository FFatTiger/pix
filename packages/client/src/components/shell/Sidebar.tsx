import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArrowClockwise,
  CaretRight,
  Check,
  DotsThree,
  Folder,
  FolderOpen,
  GearSix,
  GitBranch,
  MagnifyingGlass,
  NotePencil,
  PencilSimple,
  Plugs,
  Plus,
  PushPin,
  SidebarSimple,
  Stack,
  Trash,
  X,
} from "@phosphor-icons/react";
import type { SessionHeader } from "@fffattiger/pix-protocol";
import { createQueryOptions } from "@/api/query-keys";
import { createMutationOptions } from "@/api/mutations";
import { urls } from "@/api/urls";
import { SessionContextResponseSchema } from "@/api/schemas";
import { HttpError } from "@/api/http-client";
import { useHttpClient } from "@/app/http-context";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { useI18n } from "@/hooks/useI18n";
import { useContextMenu, type ContextMenuEntry } from "@/components/ContextMenu";
import { loadForkCollapsed, saveForkCollapsed } from "@/lib/fork-collapse-state";
import { downloadVisibleBranch } from "@/lib/visible-branch-export";
import { loadPinnedSectionOpen, loadProjectsSectionOpen, loadSessionsSectionOpen, savePinnedSectionOpen, saveProjectsSectionOpen, saveSessionsSectionOpen } from "@/lib/sidebar-section-state";
import { useSidebarItemState } from "@/lib/sidebar-item-state";
import { SIDEBAR_VISIBLE_LIMIT, splitLimitedList } from "@/lib/sidebar-list-limit";
import { isHiddenRailSession, isNonProjectWorkspacePath } from "@/lib/workspace-paths";
import type { SettingsTab } from "@/components/shell/SettingsModal";

export interface SidebarProps {
  /** Current workspace cwd (AppShell is the URL owner). */
  cwd: string | undefined;
  /** The currently selected session id (the URL-selected session, AppShell-owned). */
  selectedSessionId: string | null;
  /**
   * The currently attached/live runtime session id. The running indicator
   * renders for this row while the runtime streams; the D4 delete control is
   * never shown for it (the server rejects live deletes with 409 anyway).
   */
  liveSessionId: string | null;
  /**
   * All session ids with a live worker process (busy OR idle-ready) per the
   * shared runtime owner. Dead sessions (JSONL only, no worker) are grayed out.
   */
  liveSessionIds: ReadonlySet<string>;
  /**
   * True only when the runtime connection is authoritative (ready/attached).
   * When the connection is idle/connecting (sessiond down), the live set is
   * empty and NOT trustworthy — rows are never grayed from an unknown state.
   */
  liveKnown: boolean;
  /** Session ids currently running according to the shared runtime owner. */
  runningSessionIds: ReadonlySet<string>;
  /** Project roots with at least one running session (covers fresh tabs before list refresh). */
  runningProjectRoots: ReadonlySet<string>;
  /**
   * Session currently being prepared by the AppShell no-flicker selection flow
   * (data settling in the shared history cache, URL not yet committed). The
   * row gets a lightweight pending cue only — the detail frame stays mounted
   * on the currently selected session until the atomic commit.
   */
  pendingSessionId?: string | null;
  /**
   * D4 delete-navigation callback. AppShell is the single navigation owner: it
   * clears only the `session` search param (preserving `cwd`) when the deleted
   * session equals the URL-selected session.
   */
  onSessionDeleted?: (sessionId: string) => void;
  /** Select a session row with its owning workspace cwd. */
  onSelectSession: (sessionId: string, cwd?: string) => void;
  /** Start a new session in the current workspace (AppShell-owned). */
  onNewSession: () => void;
  /** Honest gate for the new-session action (capability + cwd). */
  canNewSession: boolean;
  /** Open the existing SettingsModal on a specific tab (plugins / skills / settings). */
  onOpenSettings?: (tab: SettingsTab) => void;
  /** Collapse the sidebar from inside the rail (the toggle lives here, not in the title bar). */
  onCollapseSidebar?: () => void;
  /** Open the new-session page scoped to a project root (no immediate create). */
  onNewSessionInProject?: (projectRoot: string) => void | Promise<void>;
  /** Visible authorize failure from opening a project (AppShell-owned). */
  openProjectError?: string | null;
  /**
   * Host-authorized project roots (from `/v1/cwd/roots`) that should show in
   * the project list even before any session exists. The sidebar keeps using
   * session-derived projects as its primary source; this augments it.
   */
  authorizedProjectRoots?: readonly string[];
}

/**
 * Resolve the most recent usable activity instant for a session.
 *
 * Preference order is `updatedAt → lastMessageAt → createdAt`. Each candidate
 * is only consumed when it is a finite number that maps to a representable
 * `Date`. Returns the epoch-ms instant, or `undefined` when no candidate is
 * usable.
 */
function activityMs(session: SessionHeader): number | undefined {
  for (const value of [session.updatedAt, session.lastMessageAt, session.createdAt]) {
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const time = new Date(value).getTime();
    // getTime() is NaN for out-of-range instants (e.g. 1e30); skip those.
    if (!Number.isFinite(time)) continue;
    return value;
  }
  return undefined;
}

function formatRelativeTime(
  ms: number,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const compact = formatCompactActivity(ms);
  if (compact === "NOW") return t("desktop.justNow");
  if (compact.endsWith("M")) return t("desktop.minutesAgo", { count: Number(compact.slice(0, -1)) });
  if (compact.endsWith("H")) return t("desktop.hoursAgo", { count: Number(compact.slice(0, -1)) });
  if (compact.endsWith("D")) return t("desktop.daysAgo", { count: Number(compact.slice(0, -1)) });
  return compact;
}

/** Compact idle-time chip: NOW / 3M / 1H / 2D / 12-24. */
export function formatCompactActivity(ms: number, now = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return "NOW";
  if (mins < 60) return `${mins}M`;
  if (hours < 24) return `${hours}H`;
  if (days < 7) return `${days}D`;
  return new Date(ms).toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
}

/**
 * Fixed D4 delete error copy. Code/status-first, transport-kind fallback; NEVER
 * renders the Host raw message/title/path/JSON. Unknown codes collapse to a
 * fixed fallback sentence.
 */
export function describeSessionDeleteError(error: unknown): string {
  if (error instanceof HttpError) {
    if (error.isUnauthorized) return "You are not authorized for this action.";
    switch (error.code) {
      case "SESSION_IN_USE":
        return "This session is currently in use.";
      case "SESSION_NOT_FOUND":
        return "This session no longer exists.";
      case "SESSIONS_UNAVAILABLE":
      case "MUTATION_UNAVAILABLE":
        return "Session deletion is temporarily unavailable.";
      default:
        break;
    }
    if (error.kind === "network") return "Network error — unable to reach the host.";
    if (error.kind === "timeout") return "Request timed out — try again.";
    if (error.kind === "aborted") return "The action was cancelled.";
  }
  return "Unable to delete this session.";
}

/**
 * Fixed D4 rename error copy. Code/status-first, transport-kind fallback; NEVER
 * renders the Host raw message, the submitted name, or any id/path/secret.
 */
export function describeSessionRenameError(error: unknown): string {
  if (error instanceof HttpError) {
    if (error.isUnauthorized) return "You are not authorized for this action.";
    switch (error.code) {
      // §52 Host contract: PATCH /v1/sessions/:id fixed codes.
      case "SESSION_CHANGED":
        return "This session changed while renaming — try again.";
      case "SESSION_NOT_FOUND":
        return "This session no longer exists.";
      case "INVALID_SESSION_NAME":
        return "That session name is not allowed.";
      case "SESSION_RENAME_UNAVAILABLE":
      case "SESSIONS_UNAVAILABLE":
      case "MUTATION_UNAVAILABLE":
        return "Session renaming is temporarily unavailable.";
      default:
        break;
    }
    if (error.kind === "network") return "Network error — unable to reach the host.";
    if (error.kind === "timeout") return "Request timed out — try again.";
    if (error.kind === "aborted") return "The action was cancelled.";
  }
  return "Unable to rename this session.";
}

/**
 * Client-side validation that mirrors the Host canonicalize rule (§44/§51):
 * outer whitespace trimmed, blank rejected, at most 200 UTF-16 JS code units,
 * and NUL / C0 (U+0000–U+001F) / DEL (U+007F) rejected. Internal spaces,
 * Unicode and emoji are allowed. Returns the canonical trimmed name on success
 * or a fixed row-local error message — no request is issued on invalid input.
 */
export function validateSessionName(
  raw: string,
): { ok: true; name: string } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, message: "Enter a session name." };
  if (trimmed.length > 200) return { ok: false, message: "Session names are limited to 200 characters." };
  for (let index = 0; index < trimmed.length; index++) {
    const code = trimmed.charCodeAt(index);
    if (code === 0 || code < 0x20 || code === 0x7f) {
      return { ok: false, message: "Session names cannot contain control characters." };
    }
  }
  return { ok: true, name: trimmed };
}

/**
 * Return all projects (deduped by projectRoot so worktrees collapse into their
 * main repo) sorted by most recent session activity.
 */
function getRecentProjects(sessions: readonly SessionHeader[]): string[] {
  const latestByRoot = new Map<string, number>(); // projectRoot -> most recent activity
  for (const s of sessions) {
    if (isHiddenRailSession(s)) continue;
    const root = s.projectRoot || s.cwd;
    if (!root || isNonProjectWorkspacePath(root)) continue;
    const activity = activityMs(s);
    if (activity === undefined) continue;
    const prev = latestByRoot.get(root);
    if (prev === undefined || activity > prev) {
      latestByRoot.set(root, activity);
    }
  }
  return [...latestByRoot.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([root]) => root);
}

function pathBaseName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * Path label that ellipsizes on the LEFT, keeping the (most relevant) trailing
 * segments visible: "…orkspace/my-project". Shows as much of the path as fits
 * instead of a fixed number of segments. The rtl container moves the ellipsis
 * to the left edge; the inner plaintext bidi isolation keeps the path itself
 * rendered strictly left-to-right (no punctuation reordering).
 */
interface SessionTreeNode {
  session: SessionHeader;
  children: SessionTreeNode[];
}

function buildSessionTree(sessions: readonly SessionHeader[]): SessionTreeNode[] {
  const byId = new Map<string, SessionTreeNode>();
  for (const s of sessions) {
    byId.set(s.sessionId, { session: s, children: [] });
  }

  // Build a map of parentSessionId chains so we can resolve missing ancestors
  const parentOf = new Map<string, string>();
  for (const s of sessions) {
    if (s.parentSessionId) parentOf.set(s.sessionId, s.parentSessionId);
  }

  // Walk up the parentSessionId chain to find the nearest ancestor that exists in byId
  function resolveAncestor(id: string): string | null {
    let cur = parentOf.get(id);
    const visited = new Set<string>();
    while (cur) {
      if (visited.has(cur)) return null; // cycle guard
      visited.add(cur);
      if (byId.has(cur)) return cur;
      cur = parentOf.get(cur);
    }
    return null;
  }

  const roots: SessionTreeNode[] = [];
  for (const node of byId.values()) {
    const ancestor = resolveAncestor(node.session.sessionId);
    if (ancestor) {
      byId.get(ancestor)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort each level by activity desc
  const activity = (s: SessionHeader): number => activityMs(s) ?? 0;
  const sort = (nodes: SessionTreeNode[]) => {
    nodes.sort((a, b) => activity(b.session) - activity(a.session));
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

export function Sidebar({
  cwd,
  selectedSessionId,
  liveSessionId,
  liveSessionIds,
  liveKnown,
  runningSessionIds,
  runningProjectRoots,
  pendingSessionId,
  onSessionDeleted,
  onSelectSession,
  onNewSession,
  canNewSession,
  onOpenSettings,
  onCollapseSidebar,
  onNewSessionInProject,
  openProjectError,
  authorizedProjectRoots = [],
}: SidebarProps) {
  const { t } = useI18n();
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const options = createQueryOptions(http);
  const { can, canBrowseSessions, canDeleteSessions, canWriteSessions } = useCapabilities();
  const canWorktree = can("worktree");
  const canPlugins = can("plugins");
  const canSkills = can("skills");

  // Full (all-project) session list; the sidebar filters per project
  // client-side (worktrees of one repo share a projectRoot and are shown
  // together). The query is disabled when the host does not serve history.
  const sessions = useQuery({ ...options.sessions.list(), enabled: canBrowseSessions });

  // Worktree topology for the current workspace — needed to resolve the
  // selected cwd to its project root (shared with the WorktreeSelector via
  // the query key).
  const worktrees = useQuery({
    ...options.worktrees.list(cwd ?? ""),
    enabled: canWorktree && cwd !== undefined,
  });

  // D4 delete + rename mutations: existing options own the standard list+byId
  // invalidation (rename additionally primes the cached titles first).
  const removeMutation = useMutation(createMutationOptions(http, queryClient).sessions.remove());
  const renameMutation = useMutation(createMutationOptions(http, queryClient).sessions.rename());

  const [sessionsOpen, setSessionsOpen] = useState<boolean>(() => loadSessionsSectionOpen());
  const toggleSessions = useCallback(() => {
    setSessionsOpen((open) => {
      saveSessionsSectionOpen(!open);
      return !open;
    });
  }, []);
  const [pinnedOpen, setPinnedOpen] = useState<boolean>(() => loadPinnedSectionOpen());
  const togglePinned = useCallback(() => {
    setPinnedOpen((open) => {
      savePinnedSectionOpen(!open);
      return !open;
    });
  }, []);
  const [projectsOpen, setProjectsOpen] = useState<boolean>(() => loadProjectsSectionOpen());
  const toggleProjects = useCallback(() => {
    setProjectsOpen((open) => {
      saveProjectsSectionOpen(!open);
      return !open;
    });
  }, []);
  const [expandedProjects, setExpandedProjects] = useState<ReadonlySet<string>>(() => new Set());
  // Session-list quick-search: searchOpen swaps the header for a filter box,
  // and sessionSearch drives live filtering of the visible session rows.
  const [searchOpen, setSearchOpen] = useState(false);
  const [sessionSearch, setSessionSearch] = useState("");
  const [sessionsExpanded, setSessionsExpanded] = useState(false);
  const [projectsExpanded, setProjectsExpanded] = useState(false);
  const [expandedNestedProjects, setExpandedNestedProjects] = useState<ReadonlySet<string>>(() => new Set());
  const {
    state: itemState,
    pinSession,
    archiveSession,
    pinProject,
    archiveProject,
  } = useSidebarItemState();
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
    };
  }, []);

  const handleRefreshSessions = useCallback(() => {
    void sessions.refetch();
    setSessionRefreshDone(true);
    if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
    sessionRefreshTimerRef.current = setTimeout(() => setSessionRefreshDone(false), 2000);
  }, [sessions]);

  // Honesty / fail-closed: when the sessions capability is retracted the visible
  // list is pinned empty regardless of cache state or any in-flight response.
  const visibleSessions = canBrowseSessions
    ? (sessions.data?.sessions ?? []).filter((session) => !isHiddenRailSession(session))
    : [];
  const showLoading = canBrowseSessions && sessions.isLoading;
  const showError = canBrowseSessions && sessions.isError;

  /** Resolve the project root for a cwd from the freshest data available. */
  const projectRootFor = useCallback((cwd: string | null | undefined): string | null => {
    if (!cwd) return null;
    const data = worktrees.data;
    if (data && data.worktrees.some((w) => w.path === cwd)) return data.projectRoot;
    const match = visibleSessions.find((s) => s.cwd === cwd);
    return match?.projectRoot ?? cwd;
  }, [worktrees.data, visibleSessions]);

  const recentProjects = getRecentProjects(visibleSessions);
  // Authorized roots augment the session-derived project list: a just-
  // authorized project (no session yet) must still be selectable. Session-
  // derived projects stay first (most recently used order); authorized roots
  // are appended once, deduplicated.
  const knownProjectRoots = useMemo(() => {
    const roots = [...recentProjects];
    for (const root of authorizedProjectRoots) {
      if (!roots.includes(root)) roots.push(root);
    }
    return roots;
  }, [recentProjects, authorizedProjectRoots]);
  const selectedProject = projectRootFor(cwd);
  const toggleProjectExpanded = useCallback((project: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(project)) next.delete(project);
      else next.add(project);
      return next;
    });
  }, []);

  // Direct session URLs reveal their owning project (and the session row's
  // ancestor chain) without any click.
  useEffect(() => {
    if (!selectedSessionId) return;
    const session = visibleSessions.find((item) => item.sessionId === selectedSessionId);
    if (!session) return;
    const root = session.projectRoot || session.cwd;
    if (!root) return;
    setExpandedProjects((prev) => {
      if (prev.has(root)) return prev;
      const next = new Set(prev);
      next.add(root);
      return next;
    });
  }, [selectedSessionId, visibleSessions]);

  // Recent is the FULL session list (minus hidden agent-home/scratch rows).
  // Expanding a project only reveals that project's sessions in place; it
  // never filters this list and never changes cwd.
  const projectSessions = visibleSessions;

  // Live quick-search: filters against the exact title shown in the list
  // (a user-set name, else a short id). Applied after the project scope so
  // search only ever narrows the currently visible project's sessions.
  const searchQuery = sessionSearch.trim().toLowerCase();
  const searchScopedSessions = searchQuery
    ? projectSessions.filter((s) => sessionRowTitle(s).toLowerCase().includes(searchQuery))
    : projectSessions;

  const archivedSessionIds = new Set(itemState.archivedSessions);
  const archivedProjectRoots = new Set(itemState.archivedProjects);
  const pinnedSessionIds = new Set(itemState.pinnedSessions);
  const pinnedProjectRoots = new Set(itemState.pinnedProjects);

  const recentSessionPool = searchScopedSessions.filter((session) => !archivedSessionIds.has(session.sessionId));
  const sessionTree = buildSessionTree(recentSessionPool);
  const pinnedSessionNodes = itemState.pinnedSessions
    .map((sessionId) => sessionTree.find((node) => node.session.sessionId === sessionId))
    .filter((node): node is SessionTreeNode => node !== undefined);
  const recentSessionNodes = sessionTree.filter((node) => !pinnedSessionIds.has(node.session.sessionId));
  const isFilteredView = Boolean(searchQuery);
  const recentSessionSplit = splitLimitedList(recentSessionNodes, isFilteredView || sessionsExpanded);

  const visibleProjectRoots = knownProjectRoots.filter((project) => !archivedProjectRoots.has(project));
  const pinnedProjects = itemState.pinnedProjects.filter((project) => visibleProjectRoots.includes(project));
  const recentProjectRoots = visibleProjectRoots.filter((project) => !pinnedProjectRoots.has(project));
  const recentProjectSplit = splitLimitedList(recentProjectRoots, projectsExpanded);
  const showPinnedSection = pinnedSessionNodes.length > 0 || pinnedProjects.length > 0;

  const renderTreeItem = (node: SessionTreeNode) => (
    <SessionTreeItem
      key={node.session.sessionId}
      node={node}
      selectedSessionId={selectedSessionId}
      pendingSessionId={pendingSessionId ?? null}
      runningSessionIds={runningSessionIds}
      liveSessionId={liveSessionId}
      liveSessionIds={liveSessionIds}
      liveKnown={liveKnown}
      canRename={canWriteSessions}
      canDelete={canDeleteSessions}
      canExport={canBrowseSessions}
      isPinned={(sessionId) => pinnedSessionIds.has(sessionId)}
      isArchived={(sessionId) => archivedSessionIds.has(sessionId)}
      onPin={pinSession}
      onArchive={archiveSession}
      renameMutation={renameMutation}
      removeMutation={removeMutation}
      onSessionDeleted={onSessionDeleted}
      onSelectSession={onSelectSession}
      depth={0}
    />
  );

  const renderProjectCard = (project: string) => {
    const selected = project === selectedProject;
    const expanded = expandedProjects.has(project);
    const nestedSessions = visibleSessions.filter((session) => {
      const root = session.projectRoot || session.cwd;
      return root === project && !isHiddenRailSession(session) && !archivedSessionIds.has(session.sessionId);
    });
    const nestedTree = buildSessionTree(nestedSessions);
    const nestedSplit = splitLimitedList(nestedTree, expandedNestedProjects.has(project));
    const projectRunning = runningProjectRoots.has(project)
      || nestedSessions.some((session) => runningSessionIds.has(session.sessionId));
    const pinned = pinnedProjectRoots.has(project);
    return (
      <div key={project} data-testid="sidebar-project-card" data-expanded={expanded ? "true" : "false"}>
        <ProjectRow
          project={project}
          selected={selected}
          expanded={expanded}
          running={projectRunning}
          pinned={pinned}
          onToggle={() => toggleProjectExpanded(project)}
          onPin={(nextPinned) => pinProject(project, nextPinned)}
          onArchive={(archived) => archiveProject(project, archived)}
          onNewSession={() => {
            void Promise.resolve(onNewSessionInProject?.(project)).catch(() => undefined);
          }}
        />
        {expanded ? (
          <div className="sidebar-project-sessions" data-testid="sidebar-project-sessions">
            {nestedTree.length === 0 ? (
              <div className="sidebar-status">{t("desktop.noSessionsFound")}</div>
            ) : (
              <>
                {nestedSplit.visible.map((node) => renderTreeItem(node))}
                {nestedSplit.hiddenCount > 0 || (expandedNestedProjects.has(project) && nestedTree.length > SIDEBAR_VISIBLE_LIMIT) ? (
                  <ShowMoreButton
                    hiddenCount={nestedSplit.hiddenCount}
                    expanded={expandedNestedProjects.has(project)}
                    onToggle={() => setExpandedNestedProjects((prev) => {
                      const next = new Set(prev);
                      if (next.has(project)) next.delete(project);
                      else next.add(project);
                      return next;
                    })}
                  />
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="sidebar-rail" data-testid="sidebar">
      <div className="sidebar-rail-chrome">
        <div className="sidebar-home-header" data-testid="sidebar-home-header">
          <span className="sidebar-brand" data-testid="sidebar-brand">{t("desktop.appName")}</span>
          <div className="sidebar-home-actions">
            <button
              type="button"
              className="sidebar-icon-btn"
              data-testid="sidebar-search"
              title={t("desktop.searchSessions")}
              aria-label={t("desktop.searchSessions")}
              onClick={() => {
                setSessionsOpen(true);
                setSearchOpen((open) => !open);
                if (searchOpen) setSessionSearch("");
              }}
            >
              <MagnifyingGlass size={16} weight="regular" aria-hidden="true" />
            </button>
            {onCollapseSidebar ? (
              <button
                type="button"
                className="sidebar-icon-btn"
                data-testid="sidebar-collapse"
                title={t("desktop.hideSidebar")}
                aria-label={t("desktop.hideSidebar")}
                onClick={onCollapseSidebar}
              >
                <SidebarSimple size={16} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>

        <nav className="sidebar-primary-nav" aria-label={t("desktop.primaryNav")}>
          <button
            type="button"
            className="sidebar-nav-item"
            data-testid="sidebar-new-session"
            disabled={!canNewSession}
            title={cwd ? t("desktop.newSessionIn", { cwd }) : t("desktop.selectProjectFirst")}
            aria-label={t("desktop.newSession")}
            onClick={onNewSession}
          >
            <NotePencil size={16} weight="regular" aria-hidden="true" />
            <span className="sidebar-nav-item-label sidebar-title-fade">{t("desktop.newSession")}</span>
          </button>
          {canPlugins ? (
            <button
              type="button"
              className="sidebar-nav-item"
              data-testid="sidebar-nav-plugins"
              title={t("desktop.plugins")}
              aria-label={t("desktop.plugins")}
              onClick={() => onOpenSettings?.("plugins")}
            >
              <Plugs size={16} weight="regular" aria-hidden="true" />
              <span className="sidebar-nav-item-label sidebar-title-fade">{t("desktop.plugins")}</span>
            </button>
          ) : null}
          {canSkills ? (
            <button
              type="button"
              className="sidebar-nav-item"
              data-testid="sidebar-nav-resources"
              title={t("desktop.resources")}
              aria-label={t("desktop.resources")}
              onClick={() => onOpenSettings?.("skills")}
            >
              <Stack size={16} weight="regular" aria-hidden="true" />
              <span className="sidebar-nav-item-label sidebar-title-fade">{t("desktop.resources")}</span>
            </button>
          ) : null}
        </nav>
      </div>

      <div className="sidebar-rail-scroll">
        {showPinnedSection ? (
          <section className="sidebar-section" data-testid="sidebar-pinned">
            <div className="sidebar-section-head" data-expanded={pinnedOpen ? "true" : "false"}>
              <button
                type="button"
                className="sidebar-section-toggle"
                data-testid="pinned-section-toggle"
                aria-expanded={pinnedOpen}
                onClick={togglePinned}
              >
                <span className="sidebar-section-label-text">{t("desktop.pinned")}</span>
                <CaretRight
                  className="sidebar-section-chevron"
                  size={14}
                  weight="bold"
                  style={{ transform: pinnedOpen ? "rotate(90deg)" : "none" }}
                  aria-hidden="true"
                />
              </button>
            </div>
            {pinnedOpen ? (
              <div data-testid="sidebar-pinned-list">
                {pinnedProjects.map((project) => renderProjectCard(project))}
                {pinnedSessionNodes.map((node) => renderTreeItem(node))}
              </div>
            ) : null}
          </section>
        ) : null}

        <section className="sidebar-section" data-testid="sidebar-projects">
          <div className="sidebar-section-head" data-expanded={projectsOpen ? "true" : "false"}>
            <button
              type="button"
              className="sidebar-section-toggle"
              data-testid="projects-section-toggle"
              aria-expanded={projectsOpen}
              onClick={toggleProjects}
            >
              <span className="sidebar-section-label-text">{t("desktop.projects")}</span>
              <CaretRight
                className="sidebar-section-chevron"
                size={14}
                weight="bold"
                style={{ transform: projectsOpen ? "rotate(90deg)" : "none" }}
                aria-hidden="true"
              />
            </button>
          </div>
          {projectsOpen ? (
          <div data-testid="sidebar-project-list">
            {recentProjectRoots.length === 0 && pinnedProjects.length === 0 ? (
              <div className="sidebar-empty">{t("desktop.noProjectsYet")}</div>
            ) : (
              <>
                {recentProjectSplit.visible.map((project) => renderProjectCard(project))}
                {recentProjectSplit.hiddenCount > 0 || (projectsExpanded && recentProjectRoots.length > SIDEBAR_VISIBLE_LIMIT) ? (
                  <ShowMoreButton
                    hiddenCount={recentProjectSplit.hiddenCount}
                    expanded={projectsExpanded}
                    onToggle={() => setProjectsExpanded((open) => !open)}
                  />
                ) : null}
              </>
            )}
            {openProjectError ? (
              <div role="alert" data-testid="sidebar-open-project-error" className="sidebar-status" style={{ color: "var(--status-danger)", overflowWrap: "anywhere" }}>
                {openProjectError}
              </div>
            ) : null}
          </div>
          ) : null}
        </section>

        <section className="sidebar-section sidebar-section-sessions" data-testid="sidebar-sessions">
          <div className="sidebar-section-head" data-expanded={sessionsOpen ? "true" : "false"}>
            <button
              type="button"
              className="sidebar-section-toggle"
              data-testid="sessions-section-toggle"
              aria-expanded={sessionsOpen}
              onClick={toggleSessions}
            >
              <span className="sidebar-section-label-text">{t("desktop.sessions")}</span>
              <CaretRight
                className="sidebar-section-chevron"
                size={14}
                weight="bold"
                style={{ transform: sessionsOpen ? "rotate(90deg)" : "none" }}
                aria-hidden="true"
              />
            </button>
            <div className="sidebar-section-actions">
              <button
                type="button"
                className="sidebar-icon-btn"
                title={t("desktop.searchSessions")}
                aria-label={t("desktop.searchSessions")}
                onClick={() => {
                  setSessionsOpen(true);
                  setSearchOpen(true);
                }}
              >
                <MagnifyingGlass size={14} weight="regular" aria-hidden="true" />
              </button>
              <button
                type="button"
                className="sidebar-icon-btn"
                title={t("desktop.refresh")}
                aria-label={t("desktop.refresh")}
                onClick={handleRefreshSessions}
              >
                {sessionRefreshDone ? (
                  <Check size={14} color="#4ade80" weight="regular" aria-hidden="true" />
                ) : (
                  <ArrowClockwise size={14} weight="regular" aria-hidden="true" />
                )}
              </button>
            </div>
          </div>

          {searchOpen && (
            <div className="sidebar-search-field">
              <div className="sidebar-search-wrap">
                <MagnifyingGlass size={13} className="sidebar-search-icon" aria-hidden="true" />
                <input
                  value={sessionSearch}
                  onChange={(e) => setSessionSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      if (sessionSearch) setSessionSearch("");
                      else setSearchOpen(false);
                    }
                  }}
                  placeholder={t("desktop.searchSessionsPlaceholder")}
                  aria-label={t("desktop.searchSessions")}
                  autoFocus
                />
              </div>
              <button
                type="button"
                className="sidebar-icon-btn"
                onClick={() => { setSearchOpen(false); setSessionSearch(""); }}
                title={t("desktop.exitSearch")}
                aria-label={t("desktop.exitSearch")}
              >
                <X size={13} weight="regular" aria-hidden="true" />
              </button>
            </div>
          )}

          {sessionsOpen && (
            <div className="sidebar-session-list">
              {showLoading && <div className="sidebar-status">{t("desktop.loading")}</div>}
              {showError && <div className="sidebar-status sidebar-status--error">{t("desktop.noSessionsFound")}</div>}
              {!canBrowseSessions && (
                <div className="sidebar-status">Session history unavailable until the runtime connects.</div>
              )}
              {canBrowseSessions && !showLoading && !showError && recentSessionPool.length === 0 && (
                <div className="sidebar-status">
                  {searchQuery ? t("desktop.noMatchingSessions") : t("desktop.noSessionsFound")}
                </div>
              )}
              {recentSessionSplit.visible.map((node) => renderTreeItem(node))}
              {recentSessionSplit.hiddenCount > 0 || (sessionsExpanded && recentSessionNodes.length > SIDEBAR_VISIBLE_LIMIT) ? (
                <ShowMoreButton
                  hiddenCount={recentSessionSplit.hiddenCount}
                  expanded={isFilteredView || sessionsExpanded}
                  onToggle={() => setSessionsExpanded((open) => !open)}
                />
              ) : null}
            </div>
          )}
        </section>
      </div>

      <div className="sidebar-footer">
        <button
          type="button"
          className="sidebar-nav-item"
          data-testid="sidebar-nav-settings"
          title={t("desktop.settings")}
          aria-label={t("desktop.settings")}
          onClick={() => onOpenSettings?.("display")}
        >
          <GearSix size={16} weight="regular" aria-hidden="true" />
          <span className="sidebar-nav-item-label sidebar-title-fade">{t("desktop.settings")}</span>
        </button>
      </div>
    </div>
  );
}

/**
 * The exact title a session row shows: explicit name, else the first user
 * message (bounded one-line summary), else a short id.
 */
function sessionRowTitle(session: SessionHeader): string {
  if (session.title) return session.title;
  const first = session.firstMessage;
  if (typeof first === "string" && first.trim().length > 0) {
    const oneLine = first.replace(/[\r\n\t]+/g, " ").trim();
    return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
  }
  return session.sessionId.slice(0, 12);
}

function ShowMoreButton({
  hiddenCount,
  expanded,
  onToggle,
}: {
  hiddenCount: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="sidebar-show-more"
      data-testid="sidebar-show-more"
      onClick={onToggle}
    >
      {expanded ? t("desktop.showLess") : t("desktop.viewMore", { count: hiddenCount })}
    </button>
  );
}

function ProjectRow({
  project,
  selected,
  expanded,
  running,
  pinned,
  onToggle,
  onPin,
  onArchive,
  onNewSession,
}: {
  project: string;
  selected: boolean;
  expanded: boolean;
  running: boolean;
  pinned: boolean;
  onToggle: () => void;
  onPin: (pinned: boolean) => void;
  onArchive: (archived: boolean) => void;
  onNewSession: () => void;
}) {
  const { t } = useI18n();
  const { openMenu } = useContextMenu();
  const moreMenu = (x: number, y: number) => {
    openMenu(x, y, [
      {
        label: pinned ? t("desktop.unpin") : t("desktop.pin"),
        icon: <PushPin size={13} weight={pinned ? "fill" : "regular"} aria-hidden="true" />,
        onSelect: () => onPin(!pinned),
      },
      {
        label: t("desktop.archive"),
        icon: <Archive size={13} weight="regular" aria-hidden="true" />,
        onSelect: () => onArchive(true),
      },
    ]);
  };
  const handleContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    moreMenu(event.clientX, event.clientY);
  };
  return (
    <div
      className="sidebar-list-row"
      data-active={selected ? "true" : "false"}
      data-running={running ? "true" : undefined}
      onContextMenu={handleContextMenu}
    >
      <button
        type="button"
        className="sidebar-session-select"
        data-testid="sidebar-project-row"
        title={project}
        aria-pressed={selected}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        {expanded ? (
          <FolderOpen size={16} weight="regular" aria-hidden="true" />
        ) : (
          <Folder size={16} weight="regular" aria-hidden="true" />
        )}
        <span className="sidebar-row-title sidebar-title-fade">{pathBaseName(project)}</span>
        {running ? <RunningSessionIndicator /> : null}
      </button>
      <div className="sidebar-row-actions">
        <button
          type="button"
          className="sidebar-icon-btn"
          title={t("desktop.moreOptions")}
          aria-label={t("desktop.moreOptions")}
          onClick={(event) => {
            event.stopPropagation();
            const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
            moreMenu(rect.left, rect.bottom + 4);
          }}
        >
          <DotsThree size={14} weight="bold" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="sidebar-icon-btn"
          title={t("desktop.newSession")}
          aria-label={t("desktop.newSession")}
          onClick={(event) => { event.stopPropagation(); onNewSession(); }}
        >
          <Plus size={14} weight="bold" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function SessionTreeItem({
  node,
  selectedSessionId,
  pendingSessionId,
  runningSessionIds,
  liveSessionId,
  liveSessionIds,
  liveKnown,
  canRename,
  canDelete,
  canExport,
  isPinned,
  isArchived,
  onPin,
  onArchive,
  renameMutation,
  removeMutation,
  onSessionDeleted,
  onSelectSession,
  depth,
}: {
  node: SessionTreeNode;
  selectedSessionId: string | null;
  pendingSessionId: string | null;
  runningSessionIds: ReadonlySet<string>;
  liveSessionId: string | null;
  liveSessionIds: ReadonlySet<string>;
  liveKnown: boolean;
  canRename: boolean;
  canDelete: boolean;
  canExport: boolean;
  isPinned: (sessionId: string) => boolean;
  isArchived: (sessionId: string) => boolean;
  onPin: (sessionId: string, pinned: boolean) => void;
  onArchive: (sessionId: string, archived: boolean) => void;
  renameMutation: ReturnType<typeof useMutation<unknown, unknown, { id: string; name: string }>>;
  removeMutation: ReturnType<typeof useMutation<unknown, unknown, string>>;
  onSessionDeleted?: ((sessionId: string) => void) | undefined;
  onSelectSession: (sessionId: string, cwd?: string) => void;
  depth: number;
}) {
  // A subtree that contains the SELECTED session starts expanded so a
  // directly-opened session URL reveals its whole ancestor chain; everything
  // else defaults collapsed (a stored value always wins).
  const subtreeContains = (current: SessionTreeNode, targetId: string): boolean => {
    if (current.session.sessionId === targetId) return true;
    return current.children.some((child) => subtreeContains(child, targetId));
  };
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    const stored = loadForkCollapsed(node.session.sessionId);
    if (stored !== undefined) return stored;
    return !subtreeContains(node, selectedSessionId ?? "");
  });
  const hasChildren = node.children.length > 0;
  const toggleChildren = () => {
    if (!hasChildren) return;
    setCollapsed((current) => {
      const next = !current;
      saveForkCollapsed(node.session.sessionId, next);
      return next;
    });
  };

  const isSelected = node.session.sessionId === selectedSessionId;

  return (
    <div>
      <div style={{ position: "relative" }}>
        {/* Indent line for child sessions */}
        {depth > 0 && (
          <div style={{
            position: "absolute",
            left: depth * 12 + 6,
            top: 0, bottom: 0,
            width: 1,
            background: "var(--border)",
            pointerEvents: "none",
          }} />
        )}
        <SessionItem
          session={node.session}
          isSelected={isSelected}
          isPending={node.session.sessionId === pendingSessionId}
          isRunning={runningSessionIds.has(node.session.sessionId)}
          liveSessionId={liveSessionId}
          isDead={liveKnown && !liveSessionIds.has(node.session.sessionId)}
          canRename={canRename}
          canDelete={canDelete}
          canExport={canExport}
          pinned={isPinned(node.session.sessionId)}
          archived={isArchived(node.session.sessionId)}
          onPin={(nextPinned) => onPin(node.session.sessionId, nextPinned)}
          onArchive={(nextArchived) => onArchive(node.session.sessionId, nextArchived)}
          renameMutation={renameMutation}
          removeMutation={removeMutation}
          onSessionDeleted={onSessionDeleted}
          onSelectSession={(sessionId, cwd) => {
            // First click only opens/selects the session. Subagents expand or
            // collapse only when the ALREADY-selected session is clicked again.
            if (isSelected) toggleChildren();
            onSelectSession(sessionId, cwd);
          }}
          depth={depth}
        />
      </div>
      {hasChildren && !collapsed && (
        <LimitedChildList nodes={node.children} renderChild={(child) => (
            <SessionTreeItem
              key={child.session.sessionId}
              node={child}
              selectedSessionId={selectedSessionId}
              pendingSessionId={pendingSessionId}
              runningSessionIds={runningSessionIds}
              liveSessionId={liveSessionId}
              liveSessionIds={liveSessionIds}
              liveKnown={liveKnown}
              canRename={canRename}
              canDelete={canDelete}
              canExport={canExport}
              isPinned={isPinned}
              isArchived={isArchived}
              onPin={onPin}
              onArchive={onArchive}
              renameMutation={renameMutation}
              removeMutation={removeMutation}
              onSessionDeleted={onSessionDeleted}
              onSelectSession={onSelectSession}
              depth={depth + 1}
            />
          )} />
      )}
    </div>
  );
}

function RunningSessionIndicator() {
  const { t } = useI18n();

  return (
    <span
      className="sidebar-row-status"
      title={t("desktop.agentRunning")}
      aria-label={t("desktop.agentRunningLabel")}
      style={{
        width: 14,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "var(--accent)",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <g>
          <path
            d="M21 12a9 9 0 1 1-3.8-7.4"
            stroke="currentColor"
            strokeWidth="2.8"
            strokeLinecap="round"
          />
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 12 12"
            to="360 12 12"
            dur="0.9s"
            repeatCount="indefinite"
          />
        </g>
      </svg>
    </span>
  );
}

/**
 * Lightweight pending cue for the sidebar row the no-flicker selection flow is
 * currently preparing (first history page settling, URL not yet committed).
 * Reuses the exact running-spinner markup/animation and existing tokens — only
 * the color is muted (`--text-dim`) so it can never be mistaken for a live
 * running session (`--accent`). No new animation is introduced.
 */
function PendingSessionIndicator() {
  const { t } = useI18n();

  return (
    <span
      className="sidebar-row-status"
      title={t("desktop.openingSession")}
      aria-label={t("desktop.openingSession")}
      style={{
        width: 14,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "var(--text-dim)",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <g>
          <path
            d="M21 12a9 9 0 1 1-3.8-7.4"
            stroke="currentColor"
            strokeWidth="2.8"
            strokeLinecap="round"
          />
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 12 12"
            to="360 12 12"
            dur="0.9s"
            repeatCount="indefinite"
          />
        </g>
      </svg>
    </span>
  );
}

function LimitedChildList({
  nodes,
  renderChild,
}: {
  nodes: SessionTreeNode[];
  renderChild: (node: SessionTreeNode) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const split = splitLimitedList(nodes, expanded);
  return (
    <div>
      {split.visible.map((node) => renderChild(node))}
      {split.hiddenCount > 0 || (expanded && nodes.length > SIDEBAR_VISIBLE_LIMIT) ? (
        <ShowMoreButton
          hiddenCount={split.hiddenCount}
          expanded={expanded}
          onToggle={() => setExpanded((open) => !open)}
        />
      ) : null}
    </div>
  );
}

function SessionItem({
  session,
  isSelected,
  isPending,
  isRunning,
  liveSessionId,
  isDead = false,
  canRename,
  canDelete,
  canExport,
  pinned,
  archived,
  onPin,
  onArchive,
  renameMutation,
  removeMutation,
  onSessionDeleted,
  onSelectSession,
  depth = 0,
}: {
  session: SessionHeader;
  isSelected: boolean;
  /** Row is being prepared by the no-flicker selection flow (lightweight cue only). */
  isPending: boolean;
  isRunning?: boolean;
  liveSessionId: string | null;
  /** No live worker process (dead session, JSONL only). Grayed out in the sidebar. */
  isDead?: boolean;
  canRename: boolean;
  canDelete: boolean;
  canExport: boolean;
  pinned: boolean;
  archived: boolean;
  onPin: (pinned: boolean) => void;
  onArchive: (archived: boolean) => void;
  renameMutation: ReturnType<typeof useMutation<unknown, unknown, { id: string; name: string }>>;
  removeMutation: ReturnType<typeof useMutation<unknown, unknown, string>>;
  onSessionDeleted?: ((sessionId: string) => void) | undefined;
  onSelectSession: (sessionId: string, cwd?: string) => void;
  depth?: number;
}) {
  const { t } = useI18n();
  const http = useHttpClient();
  const { openMenu } = useContextMenu();
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // In-flight visible-branch export walk (aborted on a new export / unmount).
  const exportControllerRef = useRef<AbortController | null>(null);

  const title = sessionRowTitle(session);
  // One row mutation (rename OR delete) at a time.
  const busy = renaming || deleting || renameMutation.isPending || removeMutation.isPending;

  const startRename = useCallback((e?: React.MouseEvent) => {
    e?.stopPropagation();
    setRenameValue(session.title ?? title);
    setRenameError(null);
    setRenaming(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }, [session.title, title]);

  const commitRename = useCallback(() => {
    const validation = validateSessionName(renameValue);
    if (!validation.ok) {
      setRenameError(validation.message);
      return;
    }
    const name = validation.name;
    setRenaming(false);
    setRenameError(null);
    // Unchanged canonical title is a safe no-op: never issue a request.
    if (name === (session.title ?? "")) return;
    setDeleting(false);
    void renameMutation
      .mutateAsync({ id: session.sessionId, name })
      .catch(() => {
        // Row-local fixed copy only; the mutation owns cache invalidation.
        setRenameError(describeSessionRenameError(renameMutation.error ?? "rename failed"));
      });
  }, [renameValue, session.sessionId, session.title, renameMutation]);

  const handleDeleteClick = useCallback((e?: React.MouseEvent) => {
    e?.stopPropagation();
    setConfirmDelete(true);
  }, []);

  const handleDeleteConfirm = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
    setDeleting(true);
    void removeMutation
      .mutateAsync(session.sessionId)
      .then(() => {
        onSessionDeleted?.(session.sessionId);
      })
      .catch(() => {
        setDeleting(false);
      });
  }, [session.sessionId, removeMutation, onSessionDeleted]);

  const handleDeleteCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  }, []);

  /**
   * Export the selected history session's visible branch as normalized JSON
   * (D1B-3, moved from the old workspace-header button into the row context
   * menu). Protocol v2: walks ALL persisted pages sequentially — the newest
   * page resolves the branch leafId, then older pages use the pinned leaf +
   * exclusive cursor. Accumulates the full history ONLY for explicit export;
   * dedupes by persisted entryId. Supports abort / session-generation: a new
   * export (or a row unmount) aborts the previous in-flight walk.
   */
  const exportVisibleBranch = useCallback(() => {
    setExportError(null);
    const controller = new AbortController();
    // Abort any prior in-flight export for this row.
    if (exportControllerRef.current !== null) exportControllerRef.current.abort();
    exportControllerRef.current = controller;
    const sessionId = session.sessionId;
    void (async () => {
      try {
        const entries: import("@fffattiger/pix-protocol").SessionEntry[] = [];
        const seen = new Set<string>();
        let before: string | undefined;
        let pinnedLeaf: string | undefined;
        let hasMore = true;
        let guard = 0;
        // Defensive hard cap: a pathological/corrupt page chain can never loop forever.
        const MAX_PAGES = 100_000;
        while (hasMore && guard < MAX_PAGES) {
          guard += 1;
          const page = await http.get(urls.sessions.context(sessionId, {
            ...(pinnedLeaf === undefined ? {} : { leafId: pinnedLeaf }),
            ...(before === undefined ? {} : { before }),
            limit: 200,
          }), {
            schema: SessionContextResponseSchema,
            signal: controller.signal,
          });
          const ctx = page.context;
          if (pinnedLeaf === undefined && ctx.leafId !== undefined) pinnedLeaf = ctx.leafId;
          for (const entry of ctx.entries) {
            if (seen.has(entry.entryId)) continue;
            seen.add(entry.entryId);
            entries.push(entry);
          }
          hasMore = ctx.pageInfo.hasMore;
          if (hasMore && ctx.pageInfo.nextCursor === undefined) {
            // Fail-safe: hasMore without a cursor cannot be advanced.
            hasMore = false;
          }
          before = ctx.pageInfo.nextCursor;
        }
        if (controller.signal.aborted) return;
        downloadVisibleBranch({
          sessionId,
          ...(pinnedLeaf === undefined ? {} : { leafId: pinnedLeaf }),
          entries,
          pageInfo: { hasMore: false },
        });
      } catch {
        if (controller.signal.aborted) return;
        setExportError("Could not export visible branch.");
      } finally {
        if (exportControllerRef.current === controller) exportControllerRef.current = null;
      }
    })();
  }, [http, session.sessionId]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Inline rename / delete-confirm / delete-in-flight take over the row:
    // don't let a stray right-click open a menu on top of them.
    if (confirmDelete || renaming || deleting) return;
    const items: ContextMenuEntry[] = [
      {
        label: pinned ? t("desktop.unpin") : t("desktop.pin"),
        icon: <PushPin size={13} weight={pinned ? "fill" : "regular"} aria-hidden="true" />,
        onSelect: () => onPin(!pinned),
      },
      {
        label: archived ? t("desktop.unarchive") : t("desktop.archive"),
        icon: <Archive size={13} weight="regular" aria-hidden="true" />,
        onSelect: () => onArchive(!archived),
      },
    ];
    if (canRename) {
      items.push({
        label: t("desktop.rename"),
        icon: <PencilSimple size={13} weight="regular" aria-hidden="true" />,
        onSelect: () => startRename(),
      });
    }
    if (canExport) {
      if (items.length > 0) items.push({ type: "separator" });
      items.push({
        label: t("desktop.exportVisibleBranch"),
        // Live sessions are not exportable (persisted history branch only).
        disabled: session.sessionId === liveSessionId,
        onSelect: () => exportVisibleBranch(),
      });
    }
    // D4 delete: capability-gated, hidden for the attached/live session.
    if (canDelete && session.sessionId !== liveSessionId) {
      if (items.length > 0) items.push({ type: "separator" });
      items.push({
        label: t("desktop.delete"),
        icon: <Trash size={13} weight="regular" aria-hidden="true" />,
        danger: true,
        onSelect: () => handleDeleteClick(),
      });
    }
    if (items.length === 0) return;
    openMenu(e.clientX, e.clientY, items);
  }, [confirmDelete, renaming, deleting, openMenu, session.sessionId, liveSessionId, canRename, canDelete, canExport, startRename, handleDeleteClick, exportVisibleBranch, pinned, archived, onPin, onArchive, t]);

  const rowTitle = isRunning
    ? `${title} · ${t("desktop.agentRunning")}`
    : isPending
      ? `${title} · ${t("desktop.openingSession")}`
      : (() => {
          const activity = activityMs(session);
          return activity === undefined ? title : `${title} · ${formatRelativeTime(activity, t)}`;
        })();

  return (
    <div
      className={`sidebar-list-row${confirmDelete ? " sidebar-list-row--confirm" : ""}`}
      data-active={isSelected ? "true" : "false"}
      data-pending={isPending ? "true" : undefined}
      data-running={isRunning ? "true" : undefined}
      data-dead={isDead && !isPending && !isRunning ? "true" : undefined}
      onContextMenu={handleContextMenu}
      onClick={(event) => {
        if (confirmDelete || renaming || deleting) return;
        if ((event.target as HTMLElement).closest("button")) return;
        onSelectSession(session.sessionId, session.cwd);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); }}
      style={{
        paddingLeft: depth > 0 ? depth * 12 + 10 : 10,
        cursor: confirmDelete || renaming ? "default" : undefined,
        opacity: deleting ? 0.5 : 1,
      }}
    >
      {/* Left accent line overlay: delete-confirm red, otherwise none. */}
      {confirmDelete && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: 4,
            borderLeft: `solid 4px #ef4444`,
            transform: `scaleX(${isSelected || hovered ? 1 : 0.5})`,
            transformOrigin: "left center",
            transition: "transform 0.15s ease",
            pointerEvents: "none",
          }}
        />
      )}
      {confirmDelete ? (
        <>
          <div className="sidebar-row-title sidebar-title-fade">
            {t("desktop.deleteSession", { title: `“${title.slice(0, 22)}${title.length > 22 ? "…" : ""}”` })}
          </div>
          <div className="sidebar-row-actions" style={{ opacity: 1, pointerEvents: "auto" }}>
            <button type="button" className="sidebar-icon-btn" onClick={handleDeleteConfirm} title={t("desktop.delete")} aria-label={t("desktop.delete")}>
              <Trash size={14} weight="regular" aria-hidden="true" />
            </button>
            <button type="button" className="sidebar-icon-btn" onClick={handleDeleteCancel} title={t("desktop.cancel")} aria-label={t("desktop.cancel")}>
              <X size={14} weight="regular" aria-hidden="true" />
            </button>
          </div>
        </>
      ) : renaming ? (
        <>
          {depth > 0 && <GitBranch size={14} weight="regular" aria-hidden="true" />}
          {isRunning ? <RunningSessionIndicator /> : isPending ? <PendingSessionIndicator /> : null}
          <input
            ref={inputRef}
            value={renameValue}
            onChange={(e) => { setRenameValue(e.target.value); setRenameError(null); }}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitRename();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setRenaming(false);
                setRenameError(null);
              }
            }}
            aria-label={t("desktop.rename")}
            autoFocus
            className="sidebar-row-title"
            style={{ height: 22, border: 0, outline: "none", background: "color-mix(in srgb, var(--accent) 16%, transparent)", borderRadius: 4, color: "inherit", font: "inherit" }}
          />
        </>
      ) : (
        <>
          <button
            type="button"
            className="sidebar-session-select"
            data-testid={`session-select-${session.sessionId}`}
            aria-current={isSelected ? "true" : undefined}
            title={rowTitle}
            onClick={() => onSelectSession(session.sessionId, session.cwd)}
          >
            {depth > 0 && <GitBranch size={14} weight="regular" aria-hidden="true" />}
            <span className="sidebar-row-title sidebar-title-fade">{title}</span>
          </button>
          {isRunning ? <RunningSessionIndicator /> : isPending ? <PendingSessionIndicator /> : null}
          {!isRunning && !isPending ? (() => {
            const activity = activityMs(session);
            return activity === undefined ? null : (
              <span className="sidebar-row-meta" aria-hidden="true">{formatCompactActivity(activity)}</span>
            );
          })() : null}
          {!busy && (
            <div className="sidebar-row-actions">
              <button type="button" className="sidebar-icon-btn" onClick={(event) => { event.stopPropagation(); onPin(!pinned); }} title={pinned ? t("desktop.unpin") : t("desktop.pin")} aria-label={pinned ? t("desktop.unpin") : t("desktop.pin")}>
                <PushPin size={14} weight={pinned ? "fill" : "regular"} aria-hidden="true" />
              </button>
              <button type="button" className="sidebar-icon-btn" onClick={(event) => { event.stopPropagation(); onArchive(!archived); }} title={archived ? t("desktop.unarchive") : t("desktop.archive")} aria-label={archived ? t("desktop.unarchive") : t("desktop.archive")}>
                <Archive size={14} weight="regular" aria-hidden="true" />
              </button>
            </div>
          )}
        </>
      )}
      {renameError !== null && (
        <p className="session-rename-error" role="alert" style={{ position: "absolute", left: 14, right: 8, bottom: 2, margin: 0, fontSize: 11, color: "var(--danger)", overflowWrap: "anywhere" }}>
          {renameError}
        </p>
      )}
      {exportError !== null && (
        <p className="session-export-error" role="alert" style={{ position: "absolute", left: 14, right: 8, bottom: 2, margin: 0, fontSize: 11, color: "var(--danger)", overflowWrap: "anywhere" }}>
          {exportError}
        </p>
      )}
    </div>
  );
}
