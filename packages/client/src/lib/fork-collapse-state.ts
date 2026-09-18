/**
 * Persisted collapsed state of sidebar fork-tree nodes (sessions with child
 * sessions). Mirrors time-group-state semantics: stored in localStorage so the
 * user's collapse habits survive reloads.
 *
 * Default (no stored value): COLLAPSED. Clicking a parent session expands
 * its children; the expand/collapse caret is hover-hidden so pin/archive
 * stay the only row actions.
 */

const STORAGE_KEY = "pi-fork-tree-collapsed";
import { reportPreferenceWrite } from "@/lib/preferences/preference-sync";

function loadMap(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "boolean") result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

/** Stored collapse state for a fork-tree node, or undefined when never toggled. */
export function loadForkCollapsed(sessionId: string): boolean | undefined {
  return loadMap()[sessionId];
}

/** Persist one node's collapse state (read-modify-write; map stays small). */
export function saveForkCollapsed(sessionId: string, collapsed: boolean): void {
  if (typeof window === "undefined") return;
  try {
    const map = loadMap();
    map[sessionId] = collapsed;
    const serialized = JSON.stringify(map);
    window.localStorage.setItem(STORAGE_KEY, serialized);
    reportPreferenceWrite(STORAGE_KEY, serialized);
  } catch {
    // Ignore quota/security errors — collapse state is a nicety, not critical.
  }
}
