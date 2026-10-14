import { useCallback, useSyncExternalStore } from "react";
import { useSessionFlags } from "@/lib/session-flags";

/**
 * Sidebar rail pin / archive state (round 5 split).
 *
 * SESSION pin/archive is SERVER state (`SessionHeader.pinned/archived`,
 * written via PATCH /v1/sessions/:id — see lib/session-flags.ts). PROJECT
 * pin/archive and project expansion stay browser-local: projects are derived
 * aggregates with no per-project server record. The localStorage document now
 * carries only the project fields; legacy session arrays are migrated to the
 * server once (migrateLocalSessionFlagsToServer). Components keep consuming
 * the SAME hook shape — the merge is invisible to callers.
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
  const sessionFlags = useSessionFlags();

  const commit = useCallback((patch: Parameters<typeof applySidebarItemPatch>[1]) => {
    saveSidebarItemState(applySidebarItemPatch(loadSidebarItemState(), patch));
  }, []);

  // Session sets come from the SERVER projection; project sets stay local.
  // Pin/archive mutual exclusion for sessions is enforced server-side by the
  // write path (the optimistic patch sets both fields explicitly).
  const state: SidebarItemState = {
    pinnedSessions: sessionFlags.pinnedSessions,
    archivedSessions: sessionFlags.archivedSessions,
    pinnedProjects: local.pinnedProjects,
    archivedProjects: local.archivedProjects,
    expandedProjects: local.expandedProjects,
  };

  return {
    state,
    pinSession: useCallback((sessionId, pinned) => sessionFlags.setSessionFlags(sessionId, { pinned, ...(pinned ? { archived: false } : {}) }), [sessionFlags]),
    archiveSession: useCallback((sessionId, archived) => sessionFlags.setSessionFlags(sessionId, { archived, ...(archived ? { pinned: false } : {}) }), [sessionFlags]),
    pinProject: useCallback((projectRoot, pinned) => commit({ projectRoot, pinned }), [commit]),
    archiveProject: useCallback((projectRoot, archived) => commit({ projectRoot, archived }), [commit]),
    setProjectExpanded: useCallback((projectRoot, expanded) => commit({ projectRoot, expanded }), [commit]),
    flagError: sessionFlags.flagError,
  };
}
