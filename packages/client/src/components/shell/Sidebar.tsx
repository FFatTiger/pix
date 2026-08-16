import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowClockwise,
  CaretRight,
  Check,
  FolderOpen,
  GitBranch,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  Trash,
  X,
} from "@phosphor-icons/react";
import type { SessionHeader } from "@fffattiger/pix-protocol";
import type { WorkspaceSearch } from "@/lib/search-params";
import { createQueryOptions } from "@/api/query-keys";
import { createMutationOptions } from "@/api/mutations";
import { HttpError } from "@/api/http-client";
import { useHttpClient } from "@/app/http-context";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { useI18n } from "@/hooks/useI18n";
import { useContextMenu, type ContextMenuEntry } from "@/components/ContextMenu";
import { ExplorerPanel } from "@/features/workspace/explorer/ExplorerPanel";
import { WorktreeSelector } from "@/features/workspace/worktree/WorktreeSelector";
import { bucketOf, timeBucketKey, TIME_BUCKET_ORDER, type TimeBucket } from "@/lib/time-groups";
import {
  loadCollapsedTimeGroups,
  saveCollapsedTimeGroups,
  type CollapsedTimeGroups,
} from "@/lib/time-group-state";
import { downloadVisibleBranch } from "@/lib/visible-branch-export";

export interface SidebarProps {
  /** Current URL workspace/session search state (AppShell is the owner). */
  search: WorkspaceSearch;
  /**
   * The currently attached/live runtime session id. The running indicator
   * renders for this row while the runtime streams; the D4 delete control is
   * never shown for it (the server rejects live deletes with 409 anyway).
   */
  liveSessionId: string | null;
  /** True while the attached runtime is streaming (drives the row spinner). */
  liveStreaming: boolean;
  /**
   * D4 delete-navigation callback. AppShell is the single navigation owner: it
   * clears only the `session` search param (preserving `cwd`) when the deleted
   * session equals the URL-selected session.
   */
  onSessionDeleted?: (sessionId: string) => void;
  /** Select a session row (AppShell-owned URL navigation to `?session=`). */
  onSelectSession: (sessionId: string) => void;
  /** Client URL cwd navigation (project/worktree switch; AppShell-owned). */
  onOpenWorktree: (path: string) => void;
  /** Start a new session in the current workspace (AppShell-owned). */
  onNewSession: () => void;
  /** Honest gate for the new-session action (capability + cwd + not attached). */
  canNewSession: boolean;
  /** Portal hosts for the workspace (project/worktree) controls. */
  workspaceControlsHosts?: {
    title?: HTMLElement | null;
  };
  /** Open a file in the right panel (viewer tab ownership stays with the shell). */
  onOpenFile: (filePath: string, fileName: string, options?: { initialDisplayMode?: "diff" }) => void;
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
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return t("desktop.justNow");
  if (mins < 60) return t("desktop.minutesAgo", { count: mins });
  if (hours < 24) return t("desktop.hoursAgo", { count: hours });
  if (days < 7) return t("desktop.daysAgo", { count: days });
  return new Date(ms).toLocaleDateString();
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
    const root = s.projectRoot || s.cwd;
    if (!root) continue;
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
function PathLabel({ text, style }: { text: string; style?: CSSProperties }) {
  return (
    <span
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        display: "block",
        minWidth: 0,
        lineHeight: 1.35,
        direction: "rtl",
        textAlign: "left",
        ...style,
      }}
    >
      <span style={{ unicodeBidi: "plaintext" }}>{text}</span>
    </span>
  );
}

const DROPDOWN_ANIMATION_MS = 140;

function AnimatedDropdown({ open, children, style }: { open: boolean; children: ReactNode; style: CSSProperties }) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    let frame: number | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    if (open) {
      setMounted(true);
      setVisible(false);
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => setVisible(true));
      });
    } else {
      setVisible(false);
      timeout = setTimeout(() => setMounted(false), DROPDOWN_ANIMATION_MS);
    }

    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      if (timeout) clearTimeout(timeout);
    };
  }, [open]);

  if (!mounted) return null;

  return (
    <div
      style={{
        ...style,
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0) scale(1)" : "translateY(-8px) scale(0.96)",
        transformOrigin: "top center",
        transition: `opacity ${DROPDOWN_ANIMATION_MS}ms ease, transform ${DROPDOWN_ANIMATION_MS}ms ease`,
        pointerEvents: open ? "auto" : "none",
      }}
    >
      {children}
    </div>
  );
}

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
  search,
  liveSessionId,
  liveStreaming,
  onSessionDeleted,
  onSelectSession,
  onOpenWorktree,
  onNewSession,
  canNewSession,
  workspaceControlsHosts,
  onOpenFile,
}: SidebarProps) {
  const { t } = useI18n();
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const options = createQueryOptions(http);
  const { can, canBrowseSessions, canDeleteSessions, canWriteSessions } = useCapabilities();
  const canWorktree = can("worktree");
  const canWorktreeWrite = can("worktree.write");
  const canFiles = can("files");
  const canGit = can("git");

  // Full (all-project) session list; the sidebar filters per project
  // client-side (worktrees of one repo share a projectRoot and are shown
  // together). The query is disabled when the host does not serve history.
  const sessions = useQuery({ ...options.sessions.list(), enabled: canBrowseSessions });

  // Worktree topology for the current workspace — needed to resolve the
  // selected cwd to its project root (shared with the WorktreeSelector via
  // the query key).
  const worktrees = useQuery({
    ...options.worktrees.list(search.cwd ?? ""),
    enabled: canWorktree && search.cwd !== undefined,
  });

  // D4 delete + rename mutations: existing options own the standard list+byId
  // invalidation (rename additionally primes the cached titles first).
  const removeMutation = useMutation(createMutationOptions(http, queryClient).sessions.remove());
  const renameMutation = useMutation(createMutationOptions(http, queryClient).sessions.rename());

  const [sessionsOpen, setSessionsOpen] = useState(true);
  // Session-list quick-search: searchOpen swaps the header for a filter box,
  // and sessionSearch drives live filtering of the visible session rows.
  const [searchOpen, setSearchOpen] = useState(false);
  const [sessionSearch, setSessionSearch] = useState("");
  // Collapsed state of the session-list time-group headers. "earlier" starts
  // collapsed (its rows are not rendered until the user expands it) and the
  // whole set persists across reloads.
  const [collapsedGroups, setCollapsedGroups] = useState<CollapsedTimeGroups>(() => loadCollapsedTimeGroups());
  const toggleGroup = useCallback((bucket: TimeBucket) => {
    setCollapsedGroups((prev) => {
      const next = { ...prev, [bucket]: !prev[bucket] };
      saveCollapsedTimeGroups(next);
      return next;
    });
  }, []);
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
  const visibleSessions = canBrowseSessions ? (sessions.data?.sessions ?? []) : [];
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
  const selectedProject = projectRootFor(search.cwd);

  // Sessions of every worktree in the selected project are shown together.
  const projectSessions = selectedProject
    ? visibleSessions.filter((s) => (s.projectRoot || s.cwd) === selectedProject)
    : visibleSessions;

  // Live quick-search: filters against the exact title shown in the list
  // (a user-set name, else a short id). Applied after the project scope so
  // search only ever narrows the currently visible project's sessions.
  const searchQuery = sessionSearch.trim().toLowerCase();
  const searchScopedSessions = searchQuery
    ? projectSessions.filter((s) => sessionRowTitle(s).toLowerCase().includes(searchQuery))
    : projectSessions;

  // Build parent-child tree within the filtered set, then time-group the
  // roots. Fork children always stay inside their parent's group so a tree
  // never splits across headers; search keeps the grouped view with the
  // groups force-expanded so the narrowed results stay visible.
  const sessionTree = buildSessionTree(searchScopedSessions);
  const isFilteredView = Boolean(searchQuery);
  const sessionGroups = (() => {
    const byBucket = new Map<TimeBucket, SessionTreeNode[]>();
    for (const bucket of TIME_BUCKET_ORDER) byBucket.set(bucket, []);
    for (const node of sessionTree) {
      const activity = activityMs(node.session);
      byBucket.get(activity === undefined ? "earlier" : bucketOf(activity))!.push(node);
    }
    return TIME_BUCKET_ORDER
      .filter((bucket) => byBucket.get(bucket)!.length > 0)
      .map((bucket) => ({ bucket, nodes: byBucket.get(bucket)! }));
  })();

  const runningSessionIds = liveStreaming && liveSessionId ? new Set([liveSessionId]) : new Set<string>();

  // ── Workspace controls (project picker + worktree switcher) ──────────────
  // Portaled into the title bar when a host element exists; otherwise the
  // sidebar renders the same controls inline (source fallback rule).
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [projectFilter, setProjectFilter] = useState("");
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState("");
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const customPathInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const hasWorkspaceControlsHosts = Boolean(workspaceControlsHosts?.title);

  const visibleProjects = projectFilter.trim()
    ? recentProjects.filter((p) => p.toLowerCase().includes(projectFilter.trim().toLowerCase()))
    : recentProjects;

  const selectProject = (project: string) => {
    setProjectFilter("");
    setCustomPathOpen(false);
    setCustomPathValue("");
    setCustomPathError(null);
    setDropdownOpen(false);
    onOpenWorktree(project);
  };

  /** Client-side path validation (mirrors the AppShell project-open rule):
   *  only absolute paths are accepted; no server endpoint is implied. */
  const commitCustomPath = () => {
    const path = customPathValue.trim();
    if (!path) return;
    const absolute = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
    if (!absolute) {
      setCustomPathError("Enter an absolute project path.");
      return;
    }
    setCustomPathError(null);
    setCustomPathOpen(false);
    setCustomPathValue("");
    setDropdownOpen(false);
    onOpenWorktree(path);
  };

  // Close dropdowns on outside click (source rule, scoped to this control).
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current?.contains(e.target as Node)) return;
      setDropdownOpen(false);
      setProjectFilter("");
      setCustomPathOpen(false);
      setCustomPathValue("");
      setCustomPathError(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdownOpen]);

  const projectSearch = (
    <div style={{ borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
      <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
        <MagnifyingGlass size={13} color="var(--text-dim)" style={{ position: "absolute", left: 12, pointerEvents: "none" }} aria-hidden="true" />
        <input
          value={projectFilter}
          onChange={(e) => setProjectFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              if (projectFilter) setProjectFilter("");
              else setDropdownOpen(false);
            }
          }}
          placeholder={t("desktop.searchProjects")}
          aria-label={t("desktop.searchProjects")}
          autoFocus
          style={{ width: "100%", padding: "8px 12px 8px 34px", background: "transparent", border: "none", outline: "none", color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)", boxSizing: "border-box" }}
        />
      </div>
    </div>
  );
  const projectItem = (project: string) => {
    const isSelected = project === selectedProject;
    return (
      <button key={project} onClick={() => selectProject(project)} title={project} style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", padding: "3px 8px", background: isSelected ? "var(--bg-selected)" : "transparent", border: "none", borderRadius: 5, color: isSelected ? "var(--accent)" : "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 12, fontFamily: "var(--font-mono)", minWidth: 0 }} onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)"; }} onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}>
        {isSelected ? (
          <Check size={12} color="var(--accent)" weight="bold" style={{ flexShrink: 0 }} aria-hidden="true" />
        ) : (
          <span style={{ width: 12, flexShrink: 0 }} />
        )}
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pathBaseName(project)}</span>
      </button>
    );
  };
  const projectList = (
    <div style={{ maxHeight: "min(calc(32vh / var(--app-ui-scale, 1)), 240px)", overflowY: "auto", flex: 1, minHeight: 0, padding: "4px" }}>
      {visibleProjects.length > 0 && (
        <>
          <div style={{ padding: "5px 8px 3px", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em" }}>{t("desktop.recentProjects")}</div>
          {visibleProjects.map(projectItem)}
        </>
      )}
      {visibleProjects.length === 0 && <div style={{ padding: "8px", fontSize: 12, color: "var(--text-dim)" }}>{projectFilter.trim() ? t("desktop.noMatchingProjects") : t("desktop.noProjectsYet")}</div>}
    </div>
  );
  const projectActions = (
    <div style={{ borderTop: "1px solid var(--border)", padding: "4px", flexShrink: 0 }}>
      {!customPathOpen ? (
        <button onClick={(e) => { e.stopPropagation(); setCustomPathOpen(true); setCustomPathError(null); setTimeout(() => customPathInputRef.current?.focus(), 0); }} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 8px", background: "transparent", border: "none", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer", textAlign: "left", fontSize: 12 }} onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }} onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}>
          <FolderOpen size={14} weight="regular" style={{ flexShrink: 0 }} aria-hidden="true" />
          <span>{t("desktop.selectFolder")}</span>
        </button>
      ) : (
        <div style={{ padding: "6px 4px 4px" }}>
          <input ref={customPathInputRef} value={customPathValue} onChange={(e) => { setCustomPathValue(e.target.value); setCustomPathError(null); }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitCustomPath(); } if (e.key === "Escape") { setCustomPathOpen(false); setCustomPathValue(""); setCustomPathError(null); } }} placeholder={t("desktop.projectPathPlaceholder")} style={{ width: "100%", fontSize: 11, fontFamily: "var(--font-mono)", padding: "5px 8px", border: "1px solid var(--accent)", borderRadius: 5, outline: "none", background: "var(--bg)", color: "var(--text)", boxSizing: "border-box" }} />
          {customPathError && <div style={{ marginTop: 5, color: "#dc2626", fontSize: 11, lineHeight: 1.35, overflowWrap: "anywhere" }}>{customPathError}</div>}
          <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
            <button onClick={commitCustomPath} disabled={!customPathValue.trim()} style={{ flex: 1, padding: "4px 0", background: "var(--accent)", border: "none", borderRadius: 5, color: "#fff", fontSize: 11, fontWeight: 600, cursor: !customPathValue.trim() ? "not-allowed" : "pointer", opacity: !customPathValue.trim() ? 0.65 : 1 }}>{t("desktop.open")}</button>
            <button onClick={() => { setCustomPathOpen(false); setCustomPathValue(""); setCustomPathError(null); }} style={{ flex: 1, padding: "4px 0", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", fontSize: 11, cursor: "pointer" }}>{t("desktop.cancel")}</button>
          </div>
        </div>
      )}
    </div>
  );

  const compactProjectLabel = search.cwd
    ? pathBaseName(selectedProject ?? search.cwd)
    : `${t("desktop.selectProject")}…`;

  const worktreeControl = (
    <WorktreeSelector
      cwd={search.cwd}
      canWorktree={canWorktree}
      {...(canWorktreeWrite ? { canWorktreeWrite } : {})}
      onSelectWorktree={onOpenWorktree}
    />
  );

  const workspaceControls = (
    <div style={{ display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "flex-start", height: "100%", minWidth: 0 }}>
      <div ref={dropdownRef} style={{ position: "relative", minWidth: 0 }}>
        <button
          className="app-no-drag app-titlebar-context-control"
          onClick={() => setDropdownOpen((v) => !v)}
          title={selectedProject ?? search.cwd ?? t("desktop.selectProject")}
          aria-label={t("desktop.selectProject")}
          aria-expanded={dropdownOpen}
          style={{
            height: 36,
            maxWidth: 260,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "0 8px",
            background: dropdownOpen ? "var(--bg-selected)" : "none",
            border: "none",
            color: dropdownOpen ? "var(--text)" : search.cwd ? "var(--text-muted)" : "var(--text-dim)",
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 500,
            fontFamily: "var(--font-mono)",
            lineHeight: 1,
            letterSpacing: 0,
            textAlign: "left",
            transition: "background 0.12s, color 0.12s, border-color 0.12s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--bg-hover)";
            e.currentTarget.style.color = search.cwd ? "var(--text)" : "var(--text-muted)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = dropdownOpen ? "var(--bg-selected)" : "none";
            e.currentTarget.style.color = dropdownOpen ? "var(--text)" : search.cwd ? "var(--text-muted)" : "var(--text-dim)";
          }}
        >
          <PathLabel text={compactProjectLabel} style={{ flex: 1, minWidth: 0, color: "inherit", direction: "ltr", fontFamily: "inherit" }} />
          <CaretRight size={12} weight="regular" style={{ flexShrink: 0, transition: "transform 0.12s", transform: dropdownOpen ? "rotate(90deg)" : "none" }} aria-hidden="true" />
        </button>
        <AnimatedDropdown open={dropdownOpen} style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, width: 320, zIndex: 1000, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "0 6px 20px rgba(0,0,0,0.16)", overflow: "hidden", display: "flex", flexDirection: "column", maxHeight: "min(calc(38vh / var(--app-ui-scale, 1)), 300px)" }}>
          {projectSearch}
          {projectList}
          {projectActions}
        </AnimatedDropdown>
      </div>
      {worktreeControl}
    </div>
  );

  // Shared row renderer for every session row in a time group.
  const renderTreeItem = (node: SessionTreeNode) => (
    <SessionTreeItem
      key={node.session.sessionId}
      node={node}
      selectedSessionId={search.session ?? null}
      runningSessionIds={runningSessionIds}
      liveSessionId={liveSessionId}
      canRename={canWriteSessions}
      canDelete={canDeleteSessions}
      canExport={canBrowseSessions}
      renameMutation={renameMutation}
      removeMutation={removeMutation}
      onSessionDeleted={onSessionDeleted}
      onSelectSession={onSelectSession}
      depth={0}
    />
  );

  return (
    <>
      {(Object.entries({ title: workspaceControlsHosts?.title }) as Array<["title", HTMLElement | null | undefined]>).map(([location, host]) => host && createPortal(
        <div>{workspaceControls}</div>,
        host,
        location,
      ))}
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div style={{ flexShrink: 0 }}>
        {searchOpen ? (
          /* ── Search mode: the header becomes a quick-filter box ── */
          /* height matches the natural section-header row (11px text at the
             inherited line-height 1.5 + 6px padding) so toggling does not jump. */
          <div style={{ display: "flex", alignItems: "center", gap: 4, height: 28.5, boxSizing: "border-box", padding: "0 8px" }}>
            <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
              <MagnifyingGlass size={13} color="var(--text-dim)" style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} aria-hidden="true" />
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
                style={{
                  width: "100%", height: 24, boxSizing: "border-box",
                  padding: "0 8px 0 27px", background: "var(--bg-hover)",
                  border: "1px solid var(--accent)", borderRadius: 6,
                  outline: "none", color: "var(--text)", fontSize: 12,
                  fontFamily: "var(--font-mono)",
                }}
              />
            </div>
            <button
              onClick={() => { setSearchOpen(false); setSessionSearch(""); }}
              title={t("desktop.exitSearch")}
              aria-label={t("desktop.exitSearch")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 24, height: 24, padding: 0,
                background: "none", border: "none",
                color: "var(--text-dim)", cursor: "pointer",
                borderRadius: 5, flexShrink: 0,
                transition: "color 0.12s, background 0.12s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
            >
              <X size={13} weight="regular" aria-hidden="true" />
            </button>
          </div>
        ) : (
        <div style={{ display: "flex", alignItems: "center" }}>
          <button
            onClick={() => setSessionsOpen((v) => !v)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              flex: 1,
              padding: "6px 10px",
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              textAlign: "left",
            }}
          >
            <CaretRight size={9} weight="regular" style={{ transform: sessionsOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }} aria-hidden="true" />
            {t("desktop.sessions")}
          </button>
          <button
            onClick={() => {
              setSessionsOpen(true);
              setSearchOpen(true);
            }}
            title={t("desktop.searchSessions")}
            aria-label={t("desktop.searchSessions")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 26, height: 26, padding: 0,
              background: "none",
              border: "none",
              color: "var(--text-dim)",
              cursor: "pointer",
              borderRadius: 5,
              flexShrink: 0,
              transition: "color 0.3s, background 0.3s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
          >
            <MagnifyingGlass size={13} weight="regular" aria-hidden="true" />
          </button>
          <button
            onClick={onNewSession}
            disabled={!canNewSession}
            title={search.cwd ? t("desktop.newSessionIn", { cwd: search.cwd }) : t("desktop.selectProjectFirst")}
            aria-label={t("desktop.newSession")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 26, height: 26, padding: 0,
              background: "none",
              border: "none",
              color: "var(--text-dim)",
              cursor: canNewSession ? "pointer" : "default",
              borderRadius: 5,
              flexShrink: 0,
              opacity: canNewSession ? 1 : 0.6,
              transition: "color 0.3s, background 0.3s",
            }}
            onMouseEnter={(e) => { if (canNewSession) { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-hover)"; } }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
          >
            <Plus size={13} weight="regular" aria-hidden="true" />
          </button>
          <button
            onClick={handleRefreshSessions}
            title={t("desktop.refresh")}
            aria-label={t("desktop.refresh")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 26, height: 26, padding: 0, marginRight: 6,
              background: sessionRefreshDone ? "rgba(74,222,128,0.18)" : "none",
              border: "none",
              color: sessionRefreshDone ? "#4ade80" : "var(--text-dim)",
              cursor: "pointer",
              borderRadius: 5,
              flexShrink: 0,
              transition: "color 0.3s, background 0.3s",
            }}
            onMouseEnter={(e) => { if (!sessionRefreshDone) { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-hover)"; } }}
            onMouseLeave={(e) => { if (!sessionRefreshDone) { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; } }}
          >
            {sessionRefreshDone ? (
              <Check size={13} color="#4ade80" weight="regular" aria-hidden="true" />
            ) : (
              <ArrowClockwise size={13} weight="regular" aria-hidden="true" />
            )}
          </button>
        </div>
        )}

        {/* CWD picker — sidebar fallback when no workspace-controls portal
            host is mounted (the portal in the title bar takes priority). */}
        {!hasWorkspaceControlsHosts && (
          <div style={{ position: "relative", marginTop: 2 }}>
            <button
              onClick={() => setDropdownOpen((v) => !v)}
              title={selectedProject ?? search.cwd ?? ""}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                padding: "6px 10px",
                background: search.cwd ? "var(--bg-hover)" : "rgba(37,99,235,0.06)",
                border: search.cwd ? "1px solid var(--border)" : "1px solid rgba(37,99,235,0.4)",
                borderRadius: 7,
                cursor: "pointer",
                fontSize: 12,
                color: "var(--text)",
                textAlign: "left",
                transition: "border-color 0.15s, background 0.15s",
              }}
            >
              {search.cwd ? (
                <PathLabel
                  text={selectedProject ?? search.cwd}
                  style={{
                    flex: 1,
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    color: "var(--text)",
                  }}
                />
              ) : (
                <span
                  style={{
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    color: "var(--text-dim)",
                  }}
                >
                  {t("desktop.selectProject")}…
                </span>
              )}
            </button>

            <AnimatedDropdown
              open={dropdownOpen}
              style={{
                position: "absolute",
                top: "calc(100% + 4px)",
                left: 0,
                right: 0,
                zIndex: 100,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
                maxHeight: "min(calc(38vh / var(--app-ui-scale, 1)), 300px)",
              }}
            >
              {projectSearch}
              {projectList}
              {projectActions}
            </AnimatedDropdown>
          </div>
        )}
        {/* Worktree switcher — same portal-priority rule as the CWD picker. */}
        {!hasWorkspaceControlsHosts && (
          <div style={{ padding: "0 10px", marginTop: 6 }}>
            {worktreeControl}
          </div>
        )}
      </div>

      {/* Session list */}
      {sessionsOpen && (
        <div style={{ flex: search.cwd ? "0 1 auto" : "1 1 0", overflowY: "auto", padding: "0", minHeight: 0, maxHeight: search.cwd ? "min(40%, 360px)" : "none" }}>
          {showLoading && (
            <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
              {t("desktop.loading")}
            </div>
          )}
          {showError && (
            <div style={{ padding: "12px 14px", color: "#f87171", fontSize: 12 }}>
              {t("desktop.noSessionsFound")}
            </div>
          )}
          {!canBrowseSessions && (
            <div style={{ padding: "12px 14px", color: "var(--text-muted)", fontSize: 12 }}>
              Session history unavailable until the runtime connects.
            </div>
          )}
          {canBrowseSessions && !showLoading && !showError && searchScopedSessions.length === 0 && (
            <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
              {searchQuery ? t("desktop.noMatchingSessions") : t("desktop.noSessionsFound")}
            </div>
          )}
          {sessionGroups.map(({ bucket, nodes }) => (
            <div key={bucket}>
              <TimeGroupHeader
                bucket={bucket}
                count={countSessionRows(nodes)}
                collapsed={isFilteredView ? false : collapsedGroups[bucket]}
                onToggle={() => toggleGroup(bucket)}
              />
              {(isFilteredView || !collapsedGroups[bucket]) && nodes.map((node) => renderTreeItem(node))}
            </div>
          ))}
        </div>
      )}

      {/* File workspace (explorer + quick changes) */}
      {search.cwd ? (
        <ExplorerPanel
          cwd={search.cwd}
          canFiles={canFiles}
          canGit={canGit}
          onOpenFile={onOpenFile}
        />
      ) : null}
    </div>
    </>
  );
}

/** The exact title a session row shows (name, else a short id). */
function sessionRowTitle(session: SessionHeader): string {
  return session.title || session.sessionId.slice(0, 12);
}

/** Total number of session rows in a tree, including fork children. */
function countSessionRows(nodes: SessionTreeNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count += 1 + countSessionRows(node.children);
  }
  return count;
}

/**
 * Sticky, collapsible header for a session-list time group (source DOM).
 */
function TimeGroupHeader({
  bucket,
  count,
  collapsed,
  onToggle,
}: {
  bucket: TimeBucket;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const [stuck, setStuck] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Detect the sticky state via a 1px sentinel right above the header in
  // the same scroll container (source rule).
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const scroll = sentinel.closest('[style*="overflow-y"], .overflow-y-auto, [class*="overflow-y-auto"]');
    if (!scroll) return;
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) setStuck(!entry.isIntersecting);
      },
      { root: scroll, threshold: 0 }
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, []);

  return (
    <>
      <div ref={sentinelRef} aria-hidden="true" style={{ height: 1 }} />
      <div
        className="sidebar-time-group-header"
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        aria-expanded={!collapsed}
        title={collapsed ? t("desktop.expandGroup") : t("desktop.collapseGroup")}
      style={{
        position: "sticky",
        top: 0,
        zIndex: 1,
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 8px 3px",
        cursor: "pointer",
        userSelect: "none",
        fontSize: 10,
        fontWeight: 600,
        color: "var(--text-dim)",
        textTransform: "uppercase",
        letterSpacing: "0.07em",
        background: stuck ? "var(--bg-panel)" : "transparent",
        transition: "background 0.15s",
      }}
    >
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {t(timeBucketKey(bucket), { count })}
      </span>
    </div>
    </>
  );
}

function SessionTreeItem({
  node,
  selectedSessionId,
  runningSessionIds,
  liveSessionId,
  canRename,
  canDelete,
  canExport,
  renameMutation,
  removeMutation,
  onSessionDeleted,
  onSelectSession,
  depth,
}: {
  node: SessionTreeNode;
  selectedSessionId: string | null;
  runningSessionIds: ReadonlySet<string>;
  liveSessionId: string | null;
  canRename: boolean;
  canDelete: boolean;
  canExport: boolean;
  renameMutation: ReturnType<typeof useMutation<unknown, unknown, { id: string; name: string }>>;
  removeMutation: ReturnType<typeof useMutation<unknown, unknown, string>>;
  onSessionDeleted?: ((sessionId: string) => void) | undefined;
  onSelectSession: (sessionId: string) => void;
  depth: number;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const hasChildren = node.children.length > 0;

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
          isRunning={runningSessionIds.has(node.session.sessionId)}
          liveSessionId={liveSessionId}
          canRename={canRename}
          canDelete={canDelete}
          canExport={canExport}
          renameMutation={renameMutation}
          removeMutation={removeMutation}
          onSessionDeleted={onSessionDeleted}
          onSelectSession={onSelectSession}
          depth={depth}
          hasChildren={hasChildren}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((v) => !v)}
        />
      </div>
      {hasChildren && !collapsed && (
        <div>
          {node.children.map((child) => (
            <SessionTreeItem
              key={child.session.sessionId}
              node={child}
              selectedSessionId={selectedSessionId}
              runningSessionIds={runningSessionIds}
              liveSessionId={liveSessionId}
              canRename={canRename}
              canDelete={canDelete}
              canExport={canExport}
              renameMutation={renameMutation}
              removeMutation={removeMutation}
              onSessionDeleted={onSessionDeleted}
              onSelectSession={onSelectSession}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RunningSessionIndicator() {
  const { t } = useI18n();

  return (
    <span
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

function SessionItem({
  session,
  isSelected,
  isRunning,
  liveSessionId,
  canRename,
  canDelete,
  canExport,
  renameMutation,
  removeMutation,
  onSessionDeleted,
  onSelectSession,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  onToggleCollapse,
}: {
  session: SessionHeader;
  isSelected: boolean;
  isRunning?: boolean;
  liveSessionId: string | null;
  canRename: boolean;
  canDelete: boolean;
  canExport: boolean;
  renameMutation: ReturnType<typeof useMutation<unknown, unknown, { id: string; name: string }>>;
  removeMutation: ReturnType<typeof useMutation<unknown, unknown, string>>;
  onSessionDeleted?: ((sessionId: string) => void) | undefined;
  onSelectSession: (sessionId: string) => void;
  depth?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const { t } = useI18n();
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const { openMenu } = useContextMenu();
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
   * menu). Shares the TranscriptList context cache key; live sessions are not
   * exportable (v1 exports the persisted context branch only).
   */
  const exportVisibleBranch = useCallback(() => {
    const options = createQueryOptions(http);
    setExportError(null);
    void queryClient
      .fetchQuery({ ...options.sessions.context(session.sessionId) })
      .then((data) => {
        const context = data.context;
        if (!context) {
          setExportError("Could not export visible branch.");
          return;
        }
        try {
          downloadVisibleBranch(context);
        } catch {
          setExportError("Could not export visible branch.");
        }
      })
      .catch(() => {
        setExportError("Could not export visible branch.");
      });
  }, [http, queryClient, session.sessionId]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Inline rename / delete-confirm / delete-in-flight take over the row:
    // don't let a stray right-click open a menu on top of them.
    if (confirmDelete || renaming || deleting) return;
    const items: ContextMenuEntry[] = [];
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
  }, [confirmDelete, renaming, deleting, openMenu, session.sessionId, liveSessionId, canRename, canDelete, canExport, startRename, handleDeleteClick, exportVisibleBranch, t]);

  // Fixed-height outer wrapper — content swaps in place so the list never reflows
  const ITEM_HEIGHT = 50;

  return (
    <div
      onClick={confirmDelete || renaming ? undefined : () => onSelectSession(session.sessionId)}
      onContextMenu={handleContextMenu}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); }}
      style={{
        height: ITEM_HEIGHT,
        display: "flex",
        alignItems: "center",
        paddingLeft: depth > 0 ? depth * 12 + 14 : 14,
        paddingRight: 8,
        cursor: confirmDelete || renaming ? "default" : "pointer",
        background: confirmDelete
          ? "rgba(239,68,68,0.06)"
          : isSelected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
        borderLeft: "none",
        transition: "background 0.1s",
        position: "relative",
        opacity: deleting ? 0.5 : 1,
        gap: 6,
        overflow: "hidden",
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
        /* ── Delete confirmation: same height, two flat buttons ── */
        <>
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("desktop.deleteSession", { title: `“${title.slice(0, 22)}${title.length > 22 ? "…" : ""}”` })}
          </div>
          <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
            <button
              onClick={handleDeleteConfirm}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                height: 30, padding: "0 11px",
                background: "#ef4444", border: "none",
                borderRadius: 6, color: "#fff",
                cursor: "pointer", fontSize: 12, fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              <Trash size={12} weight="regular" aria-hidden="true" />
              {t("desktop.delete")}
            </button>
            <button
              onClick={handleDeleteCancel}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                height: 30, padding: "0 11px",
                background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: 6, color: "var(--text-muted)",
                cursor: "pointer", fontSize: 12, fontWeight: 500,
                whiteSpace: "nowrap",
              }}
            >
              {t("desktop.cancel")}
            </button>
          </div>
        </>
      ) : (
        /* ── Session content; renaming swaps only the title text in place ── */
        <>
          {/* Fork indicator for child sessions */}
          {depth > 0 && (
            <GitBranch size={10} color="var(--text-dim)" weight="regular" style={{ flexShrink: 0 }} aria-hidden="true" />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* Title row: indicator + text + collapse + action buttons — all inline, same height */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                minWidth: 0,
                height: 20,
                fontSize: 12,
                fontWeight: isSelected ? 500 : 400,
                lineHeight: "20px",
                color: "var(--text)",
              }}
              title={isRunning ? `${title} · ${t("desktop.agentRunning")}` : title}
            >
              {isRunning ? <RunningSessionIndicator /> : null}
              {renaming ? (
                <div
                  style={{
                    position: "relative",
                    flex: "1 1 0",
                    alignSelf: "stretch",
                    width: "100%",
                    minWidth: 0,
                    height: 20,
                    background: "color-mix(in srgb, var(--accent) 18%, var(--bg))",
                    borderRadius: 3,
                  }}
                >
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
                  style={{
                    width: "100%",
                    minWidth: 0,
                    height: 20,
                    margin: 0,
                    padding: 0,
                    border: "none",
                    outline: "none",
                    background: "transparent",
                    borderRadius: "inherit",
                    color: "inherit",
                    font: "inherit",
                    lineHeight: "inherit",
                    caretColor: "var(--text)",
                  }}
                  />
                </div>
              ) : (
                <span
                  style={{
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1,
                  }}
                >
                  {title}
                </span>
              )}
              {/* Collapse toggle — always visible when has children */}
              {hasChildren && (
                <button
                  onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(); }}
                  title={collapsed ? t("desktop.expandForks") : t("desktop.collapseForks")}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 20, height: 20, padding: 0, flexShrink: 0,
                    background: "none", border: "none",
                    color: "var(--text-dim)", cursor: "pointer",
                    transform: collapsed ? "rotate(-90deg)" : "none",
                    transition: "transform 0.15s",
                  }}
                >
                  <CaretRight size={10} weight="regular" aria-hidden="true" />
                </button>
              )}
              {/* Action buttons — shown on hover */}
              {hovered && !renaming && !busy && (
                <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                  {canRename ? (
                    <button
                      onClick={startRename}
                      title={t("desktop.rename")}
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "center",
                        width: 20, height: 20, padding: 0,
                        background: "none", border: "none",
                        borderRadius: 4, color: "var(--text-dim)",
                        cursor: "pointer", flexShrink: 0,
                        transition: "color 0.12s",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = "var(--accent)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = "var(--text-dim)";
                      }}
                    >
                      <PencilSimple size={13} weight="regular" aria-hidden="true" />
                    </button>
                  ) : null}
                  {canDelete && session.sessionId !== liveSessionId ? (
                    <button
                      onClick={handleDeleteClick}
                      title={t("desktop.delete")}
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "center",
                        width: 20, height: 20, padding: 0,
                        background: "none", border: "none",
                        borderRadius: 4, color: "var(--text-dim)",
                        cursor: "pointer", flexShrink: 0,
                        transition: "color 0.12s",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = "#ef4444";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = "var(--text-dim)";
                      }}
                    >
                      <Trash size={13} weight="regular" aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              )}
            </div>
            {/* Metadata row */}
            <div style={{ marginTop: 2, display: "flex", gap: 8, color: "var(--text-dim)", fontSize: 11, minWidth: 0 }}>
              {(() => {
                const activity = activityMs(session);
                return activity === undefined ? null : (
                  <span title={new Date(activity).toLocaleString()}>{formatRelativeTime(activity, t)}</span>
                );
              })()}
              {session.messageCount === undefined ? null : (
                <span>{t("desktop.messagesCount", { count: session.messageCount })}</span>
              )}
            </div>
          </div>
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
