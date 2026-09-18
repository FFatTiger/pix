/**
 * Top-level workspace tab state (unified session + file tabs).
 *
 * The tab strip mixes two kinds of tab behind a discriminated union:
 *  - session tabs: identity `session:<sessionId>`, remember their workspace
 *    cwd, and are labelled from the shared sessions-list query cache (never a
 *    stale snapshot stored on the tab).
 *  - file tabs: identity `file:<cwd>:<normalizedPath>` — file tabs are
 *    cwd-owned (a cwd switch is a new remote-state scope), carry the viewer
 *    state (mode/wrap/scroll) with the same revision guards the right-panel
 *    file tabs used (`saveFileViewerState`), and keep the source session id
 *    that scopes their reads when opened from a conversation.
 *
 * Tab state owns NO worker lifecycle: opening/closing/activating a tab never
 * attaches or stops a session. URL reconciliation and the runtime mismatch
 * effect (both in AppShell) are the only places that may detach, and only the
 * send path ever activates.
 */
import { getFileName, normalizeFilePathSlashes } from "@/lib/file-paths";
import { saveFileViewerState } from "../viewer/file-tab-state";
import type { Tab } from "../viewer/TabBar";
import type { FileViewerState } from "../viewer/file-viewer-state";

export const WORKSPACE_SESSION_TABS_STORAGE_KEY = "pi-workspace-session-tabs";
export const WORKSPACE_LAST_SESSION_STORAGE_KEY = "pi-workspace-last-session";
const WORKSPACE_SESSION_TABS_VERSION = 1;
const WORKSPACE_LAST_SESSION_VERSION = 1;
const MAX_PERSISTED_SESSION_TABS = 32;

export interface FileWorkspaceTab {
  readonly kind: "file";
  readonly id: string;
  /** Owning workspace cwd — file tabs are cwd-scoped and cleared on cwd change. */
  readonly cwd: string;
  readonly filePath: string;
  readonly label: string;
  /** Session that scopes this file's reads when opened from a conversation. */
  readonly sourceSessionId?: string | null | undefined;
  readonly initialDisplayMode?: "diff" | undefined;
  readonly viewerState?: FileViewerState | undefined;
  readonly viewerRevision?: number | undefined;
}

export interface SessionWorkspaceTab {
  readonly kind: "session";
  readonly id: string;
  readonly sessionId: string;
  /** Workspace cwd remembered at open time (used when re-activating the tab). */
  readonly cwd?: string | undefined;
}

export type WorkspaceTab = FileWorkspaceTab | SessionWorkspaceTab;

interface PersistedSessionTabs {
  readonly version: typeof WORKSPACE_SESSION_TABS_VERSION;
  readonly sessions: ReadonlyArray<{ readonly sessionId: string; readonly cwd?: string | undefined }>;
}

interface PersistedLastSession {
  readonly version: typeof WORKSPACE_LAST_SESSION_VERSION;
  readonly sessionId: string;
}

function isPersistedSession(value: unknown): value is { sessionId: string; cwd?: string | undefined } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { sessionId?: unknown; cwd?: unknown };
  if (typeof candidate.sessionId !== "string" || candidate.sessionId.length === 0 || candidate.sessionId.length > 512) return false;
  return candidate.cwd === undefined
    || (typeof candidate.cwd === "string" && candidate.cwd.length > 0 && candidate.cwd.length <= 4096);
}

/** Restore only session tabs. File tabs remain cwd-scoped, ephemeral views. */
export function loadWorkspaceSessionTabs(): SessionWorkspaceTab[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(WORKSPACE_SESSION_TABS_STORAGE_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as { version?: unknown; sessions?: unknown };
    if (parsed.version !== WORKSPACE_SESSION_TABS_VERSION || !Array.isArray(parsed.sessions)) return [];
    const seen = new Set<string>();
    const restored: SessionWorkspaceTab[] = [];
    for (const candidate of parsed.sessions.slice(-MAX_PERSISTED_SESSION_TABS)) {
      if (!isPersistedSession(candidate) || seen.has(candidate.sessionId)) continue;
      seen.add(candidate.sessionId);
      restored.push(minimalSessionTab(candidate.sessionId, candidate.cwd));
    }
    return restored;
  } catch {
    return [];
  }
}

/** Persist the open session identities without serializing file/runtime state. */
export function saveWorkspaceSessionTabs(tabs: readonly WorkspaceTab[]): void {
  if (typeof window === "undefined") return;
  const sessions = tabs
    .filter((tab): tab is SessionWorkspaceTab => tab.kind === "session")
    .slice(-MAX_PERSISTED_SESSION_TABS)
    .map((tab) => ({
      sessionId: tab.sessionId,
      ...(tab.cwd === undefined ? {} : { cwd: tab.cwd }),
    }));
  const payload: PersistedSessionTabs = { version: WORKSPACE_SESSION_TABS_VERSION, sessions };
  const serialized = JSON.stringify(payload);
  try {
    if (window.localStorage.getItem(WORKSPACE_SESSION_TABS_STORAGE_KEY) === serialized) return;
    window.localStorage.setItem(WORKSPACE_SESSION_TABS_STORAGE_KEY, serialized);
  } catch {
    // The tab strip remains usable for this mount when browser storage fails.
  }
}

/**
 * Restore the last active session only when it is still one of the durable
 * open tabs. This prevents a stale/deleted selection record from inventing a
 * tab or bypassing the normal exact-session fail-closed path.
 */
export function loadLastWorkspaceSession(): SessionWorkspaceTab | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(WORKSPACE_LAST_SESSION_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { version?: unknown; sessionId?: unknown };
    if (parsed.version !== WORKSPACE_LAST_SESSION_VERSION) return null;
    if (typeof parsed.sessionId !== "string" || parsed.sessionId.length === 0 || parsed.sessionId.length > 512) return null;
    return loadWorkspaceSessionTabs().find((tab) => tab.sessionId === parsed.sessionId) ?? null;
  } catch {
    return null;
  }
}

/** Persist the active session identity; null records an intentional home. */
export function saveLastWorkspaceSession(sessionId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (sessionId === null) {
      window.localStorage.removeItem(WORKSPACE_LAST_SESSION_STORAGE_KEY);
      return;
    }
    if (sessionId.length === 0 || sessionId.length > 512) return;
    const payload: PersistedLastSession = { version: WORKSPACE_LAST_SESSION_VERSION, sessionId };
    const serialized = JSON.stringify(payload);
    if (window.localStorage.getItem(WORKSPACE_LAST_SESSION_STORAGE_KEY) === serialized) return;
    window.localStorage.setItem(WORKSPACE_LAST_SESSION_STORAGE_KEY, serialized);
  } catch {
    // The current route remains authoritative when browser storage fails.
  }
}

/** Receive changes from another browser tab on the same device/profile. */
export function subscribeWorkspaceSessionTabs(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handleStorage = (event: StorageEvent) => {
    if (event.key === WORKSPACE_SESSION_TABS_STORAGE_KEY) onChange();
  };
  window.addEventListener("storage", handleStorage);
  return () => window.removeEventListener("storage", handleStorage);
}

function isFileTab(tab: WorkspaceTab): tab is FileWorkspaceTab {
  return tab.kind === "file";
}

export function sessionTabId(sessionId: string): string {
  return `session:${sessionId}`;
}

/** Canonical form of a file path used for tab identity + dedupe. */
export function normalizeFileTabPath(filePath: string): string {
  return normalizeFilePathSlashes(filePath).replace(/\/+$/, "");
}

export function fileTabId(cwd: string, filePath: string): string {
  const normalizedCwd = normalizeFilePathSlashes(cwd).replace(/\/+$/, "");
  return `file:${normalizedCwd}:${normalizeFileTabPath(filePath)}`;
}

/** A bare file tab used when the URL points at a file not yet materialized. */
export function minimalFileTab(cwd: string, filePath: string): FileWorkspaceTab {
  return {
    kind: "file",
    id: fileTabId(cwd, filePath),
    cwd,
    filePath,
    label: getFileName(filePath),
    viewerRevision: 0,
  };
}

/** A bare session tab used when the URL points at a session not yet materialized. */
export function minimalSessionTab(sessionId: string, cwd?: string | undefined): SessionWorkspaceTab {
  return {
    kind: "session",
    id: sessionTabId(sessionId),
    sessionId,
    ...(cwd === undefined ? {} : { cwd }),
  };
}

export interface OpenFileTabInput {
  cwd: string;
  filePath: string;
  fileName?: string | undefined;
  sourceSessionId?: string | null | undefined;
  initialDisplayMode?: "diff" | undefined;
}

/**
 * Open (or re-focus) a file tab, deduped by (cwd, normalized path). Re-opening
 * with a fresh diff mode or a changed source session bumps the viewer revision
 * exactly like the right-panel file tabs so a stale saved viewer state can
 * never overwrite newer content. Re-opening from the explorer with no source
 * session never erases an existing source session on the tab.
 */
export function openFileWorkspaceTab(
  tabs: readonly WorkspaceTab[],
  input: OpenFileTabInput,
): WorkspaceTab[] {
  const id = fileTabId(input.cwd, input.filePath);
  const existing = tabs.find((tab): tab is FileWorkspaceTab => isFileTab(tab) && tab.id === id);
  if (!existing) {
    const viewerState = input.initialDisplayMode
      ? { displayMode: input.initialDisplayMode, wrapLines: false, scrollTop: 0, scrollLeft: 0 }
      : undefined;
    return [...tabs, {
      kind: "file",
      id,
      cwd: input.cwd,
      filePath: input.filePath,
      label: input.fileName ?? getFileName(input.filePath),
      sourceSessionId: input.sourceSessionId ?? undefined,
      initialDisplayMode: input.initialDisplayMode,
      ...(viewerState === undefined ? {} : { viewerState }),
      viewerRevision: 0,
    }];
  }
  const sourceChanged = Boolean(
    input.sourceSessionId && existing.sourceSessionId !== input.sourceSessionId,
  );
  if (!sourceChanged && !input.initialDisplayMode) return [...tabs];
  return tabs.map((tab) => {
    if (tab.id !== id || tab.kind !== "file") return tab;
    const base: FileWorkspaceTab = {
      ...tab,
      ...(sourceChanged && input.sourceSessionId !== undefined && input.sourceSessionId !== null
        ? { sourceSessionId: input.sourceSessionId }
        : {}),
    };
    if (input.initialDisplayMode) {
      return {
        ...base,
        initialDisplayMode: input.initialDisplayMode,
        viewerState: {
          displayMode: input.initialDisplayMode,
          wrapLines: tab.viewerState?.wrapLines ?? false,
          scrollTop: 0,
          scrollLeft: 0,
        },
        viewerRevision: (tab.viewerRevision ?? 0) + 1,
      };
    }
    if (sourceChanged) {
      return { ...base, viewerRevision: (tab.viewerRevision ?? 0) + 1 };
    }
    return base;
  });
}

/**
 * Open (or re-focus) a session tab, deduped by sessionId. Creates the tab with
 * the workspace cwd it was opened under; an existing tab keeps its remembered
 * cwd (session tabs remember their workspace).
 */
export function openSessionWorkspaceTab(
  tabs: readonly WorkspaceTab[],
  sessionId: string,
  cwd?: string | undefined,
): WorkspaceTab[] {
  const id = sessionTabId(sessionId);
  const existing = tabs.find((tab) => tab.kind === "session" && tab.id === id);
  if (existing) return [...tabs];
  return [...tabs, {
    kind: "session",
    id,
    sessionId,
    ...(cwd === undefined ? {} : { cwd }),
  }];
}

/**
 * Remove a tab. Returns the new list plus the id to activate next:
 *  - closing a non-active tab keeps the active tab;
 *  - closing the active tab selects the right neighbor, then the left
 *    neighbor, then null (home).
 */
export function closeWorkspaceTab(
  tabs: readonly WorkspaceTab[],
  activeTabId: string | null,
  id: string,
): { tabs: WorkspaceTab[]; nextActiveTabId: string | null } {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return { tabs: [...tabs], nextActiveTabId: activeTabId };
  const next = tabs.filter((tab) => tab.id !== id);
  if (id !== activeTabId) return { tabs: next, nextActiveTabId: activeTabId };
  const right = index < next.length ? next[index] : undefined;
  const fallback = right ?? next[index - 1] ?? null;
  return { tabs: next, nextActiveTabId: fallback === null ? null : fallback.id };
}

/** Close every tab except `keepId` (the anchor always survives). */
export function closeOtherWorkspaceTabs(
  tabs: readonly WorkspaceTab[],
  keepId: string,
): WorkspaceTab[] {
  return tabs.filter((tab) => tab.id === keepId);
}

/** Close every tab AFTER `id` (the anchor and everything left of it survive). */
export function closeWorkspaceTabsToRight(
  tabs: readonly WorkspaceTab[],
  id: string,
): WorkspaceTab[] {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return [...tabs];
  return tabs.slice(0, index + 1);
}

/**
 * Cwd reconciliation: file tabs are cwd-owned, so a workspace switch is a new
 * remote-state scope — old file tabs (absolute paths from the previous cwd)
 * must never be reinterpreted under the new cwd. Session tabs are kept and
 * remember their own cwd.
 */
export function reconcileWorkspaceCwd(
  tabs: readonly WorkspaceTab[],
  cwd: string | undefined,
): WorkspaceTab[] {
  if (cwd === undefined) return tabs.filter((tab) => tab.kind !== "file");
  return tabs.filter((tab) => tab.kind !== "file" || tab.cwd === cwd);
}

/**
 * Revision-guarded viewer state save — delegates to the shared file-tab-state
 * helper so the workspace tabs reuse the exact right-panel semantics (bail on
 * revision mismatch or unchanged state, returning the same array reference)
 * instead of duplicating fragile logic.
 */
export function saveFileWorkspaceViewerState(
  tabs: readonly WorkspaceTab[],
  tabId: string,
  viewerRevision: number,
  viewerState: FileViewerState,
): WorkspaceTab[] {
  return saveFileViewerState(
    tabs as unknown as Tab[],
    tabId,
    viewerRevision,
    viewerState,
  ) as WorkspaceTab[];
}
