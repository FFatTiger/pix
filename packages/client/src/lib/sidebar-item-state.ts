import { useCallback, useSyncExternalStore } from "react";
import { useWorkspaceFlags } from "@/lib/workspace-flags";

/**
 * Sidebar rail pin / archive state (round 5 split).
 *
 * SESSION and PROJECT pin/archive are SERVER state (sessiond-owned workspace
 * state, written via PATCH /v1/workspace-flags — see lib/workspace-flags.ts).
 * Only project EXPANSION stays device-local (each device's own view). The
 * localStorage document now carries only expandedProjects; legacy pin/archive
 * arrays are migrated to the server once (migrateLocalOrganizationPrefsToServer).
 * Components keep consuming the SAME hook shape.
 */

const STORAGE_KEY = "pi-sidebar-item-state";
import { reportPreferenceWrite } from "@/lib/preferences/preference-sync";
const CHANGE_EVENT = "pi-sidebar-item-state-change";

export interface SidebarItemState {
  pinnedSessions: string[];
  pinnedProjects: string[];
  archivedSessions: string[];
  archivedProjects: string[];
  expandedProjects: string[];
}

const EMPTY_STATE: SidebarItemState = {
  pinnedSessions: [],
  pinnedProjects: [],
  archivedSessions: [],
  archivedProjects: [],
  expandedProjects: [],
};

function uniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  return next;
}

function normalizeState(value: unknown): SidebarItemState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...EMPTY_STATE };
  const record = value as Record<string, unknown>;
  return {
    pinnedSessions: Array.isArray(record.pinnedSessions) ? uniqueIds(record.pinnedSessions.filter((id): id is string => typeof id === "string")) : [],
    pinnedProjects: Array.isArray(record.pinnedProjects) ? uniqueIds(record.pinnedProjects.filter((id): id is string => typeof id === "string")) : [],
    archivedSessions: Array.isArray(record.archivedSessions) ? uniqueIds(record.archivedSessions.filter((id): id is string => typeof id === "string")) : [],
    archivedProjects: Array.isArray(record.archivedProjects) ? uniqueIds(record.archivedProjects.filter((id): id is string => typeof id === "string")) : [],
    expandedProjects: Array.isArray(record.expandedProjects) ? uniqueIds(record.expandedProjects.filter((id): id is string => typeof id === "string")) : [],
  };
}

let cachedSnapshot: SidebarItemState = EMPTY_STATE;
let cachedRaw: string | null = null;

function sameState(left: SidebarItemState, right: SidebarItemState): boolean {
  return left.pinnedSessions.join("\0") === right.pinnedSessions.join("\0")
    && left.pinnedProjects.join("\0") === right.pinnedProjects.join("\0")
    && left.archivedSessions.join("\0") === right.archivedSessions.join("\0")
    && left.archivedProjects.join("\0") === right.archivedProjects.join("\0")
    && left.expandedProjects.join("\0") === right.expandedProjects.join("\0");
}

export function loadSidebarItemState(): SidebarItemState {
  if (typeof window === "undefined") return EMPTY_STATE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === cachedRaw) return cachedSnapshot;
    const next = raw === null ? EMPTY_STATE : normalizeState(JSON.parse(raw));
    cachedRaw = raw;
    cachedSnapshot = sameState(cachedSnapshot, next) ? cachedSnapshot : next;
    return cachedSnapshot;
  } catch {
    cachedRaw = null;
    cachedSnapshot = EMPTY_STATE;
    return EMPTY_STATE;
  }
}

export function saveSidebarItemState(state: SidebarItemState): void {
  if (typeof window === "undefined") return;
  try {
    const serialized = JSON.stringify(normalizeState(state));
    window.localStorage.setItem(STORAGE_KEY, serialized);
    reportPreferenceWrite(STORAGE_KEY, serialized);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // Preference write failures stay silent — pin/archive is a nicety.
  }
}

function toggleMembership(ids: readonly string[], id: string, nextPinned: boolean): string[] {
  if (nextPinned) return uniqueIds([id, ...ids]);
  return ids.filter((item) => item !== id);
}

export function applySidebarItemPatch(
  state: SidebarItemState,
  patch: {
    sessionId?: string;
    projectRoot?: string;
    pinned?: boolean;
    archived?: boolean;
    expanded?: boolean;
  },
): SidebarItemState {
  const next: SidebarItemState = {
    pinnedSessions: [...state.pinnedSessions],
    pinnedProjects: [...state.pinnedProjects],
    archivedSessions: [...state.archivedSessions],
    archivedProjects: [...state.archivedProjects],
    expandedProjects: [...state.expandedProjects],
  };
  if (patch.sessionId !== undefined) {
    if (patch.archived !== undefined) {
      next.archivedSessions = toggleMembership(next.archivedSessions, patch.sessionId, patch.archived);
      if (patch.archived) next.pinnedSessions = toggleMembership(next.pinnedSessions, patch.sessionId, false);
    }
    if (patch.pinned !== undefined) {
      next.pinnedSessions = toggleMembership(next.pinnedSessions, patch.sessionId, patch.pinned);
      if (patch.pinned) next.archivedSessions = toggleMembership(next.archivedSessions, patch.sessionId, false);
    }
  }
  if (patch.projectRoot !== undefined) {
    if (patch.archived !== undefined) {
      next.archivedProjects = toggleMembership(next.archivedProjects, patch.projectRoot, patch.archived);
      if (patch.archived) {
        next.pinnedProjects = toggleMembership(next.pinnedProjects, patch.projectRoot, false);
        next.expandedProjects = toggleMembership(next.expandedProjects, patch.projectRoot, false);
      }
    }
    if (patch.pinned !== undefined) {
      next.pinnedProjects = toggleMembership(next.pinnedProjects, patch.projectRoot, patch.pinned);
      if (patch.pinned) next.archivedProjects = toggleMembership(next.archivedProjects, patch.projectRoot, false);
    }
    if (patch.expanded !== undefined) {
      next.expandedProjects = toggleMembership(next.expandedProjects, patch.projectRoot, patch.expanded);
    }
  }
  return next;
}

function subscribe(onStoreChange: () => void): () => void {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) onStoreChange();
  };
  window.addEventListener(CHANGE_EVENT, onStoreChange);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onStoreChange);
    window.removeEventListener("storage", handleStorage);
  };
}

export function useSidebarItemState(): {
  state: SidebarItemState;
  pinSession: (sessionId: string, pinned: boolean) => void;
  archiveSession: (sessionId: string, archived: boolean) => void;
  pinProject: (projectRoot: string, pinned: boolean) => void;
  archiveProject: (projectRoot: string, archived: boolean) => void;
  setProjectExpanded: (projectRoot: string, expanded: boolean) => void;
  flagError: string | null;
} {
  const local = useSyncExternalStore(subscribe, loadSidebarItemState, () => EMPTY_STATE);
  const workspace = useWorkspaceFlags();

  const commit = useCallback((patch: Parameters<typeof applySidebarItemPatch>[1]) => {
    saveSidebarItemState(applySidebarItemPatch(loadSidebarItemState(), patch));
  }, []);

  // Session AND project pin/archive come from the SERVER workspace state;
  // only project expansion stays device-local. Pin/archive mutual exclusion
  // is enforced by the write path (the optimistic patch sets both fields).
  const state: SidebarItemState = {
    pinnedSessions: workspace.pinnedSessions,
    archivedSessions: workspace.archivedSessions,
    pinnedProjects: workspace.pinnedProjects,
    archivedProjects: workspace.archivedProjects,
    expandedProjects: local.expandedProjects,
  };

  return {
    state,
    pinSession: useCallback((sessionId, pinned) => workspace.setSessionFlags(sessionId, { pinned, ...(pinned ? { archived: false } : {}) }), [workspace]),
    archiveSession: useCallback((sessionId, archived) => workspace.setSessionFlags(sessionId, { archived, ...(archived ? { pinned: false } : {}) }), [workspace]),
    pinProject: useCallback((projectRoot, pinned) => workspace.setProjectFlags(projectRoot, { pinned, ...(pinned ? { archived: false } : {}) }), [workspace]),
    archiveProject: useCallback((projectRoot, archived) => workspace.setProjectFlags(projectRoot, { archived, ...(archived ? { pinned: false } : {}) }), [workspace]),
    setProjectExpanded: useCallback((projectRoot, expanded) => commit({ projectRoot, expanded }), [commit]),
    flagError: workspace.flagError,
  };
}
