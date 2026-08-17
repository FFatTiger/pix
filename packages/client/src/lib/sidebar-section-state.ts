/**
 * Persisted open/collapsed state for the sidebar's Projects section.
 *
 * Same localStorage pattern as draft-store / file-explorer-state: the user's
 * section visibility survives reloads without blocking on failure.
 */

const STORAGE_KEY = "pi-sidebar-projects-open";

export function loadProjectsSectionOpen(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return true;
    return raw === "true";
  } catch {
    return true;
  }
}

export function saveProjectsSectionOpen(open: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, open ? "true" : "false");
  } catch {
    // Ignore quota/security errors — section state is a nicety, not critical.
  }
}
