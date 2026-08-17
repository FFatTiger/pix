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
