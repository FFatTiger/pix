/**
 * Persisted open/collapsed state for the sidebar's top-level sections
 * (Recent sessions / Pinned / Projects).
 *
 * Same localStorage pattern as draft-store / file-explorer-state: the user's
 * section visibility survives reloads without blocking on failure.
 */

const PROJECTS_KEY = "pi-sidebar-projects-open";
const SESSIONS_KEY = "pi-sidebar-sessions-open";
const PINNED_KEY = "pi-sidebar-pinned-open";
import { reportPreferenceWrite } from "@/lib/preferences/preference-sync";

function readBool(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === "true";
  } catch {
    return fallback;
  }
}

function writeBool(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value ? "true" : "false");
    reportPreferenceWrite(key, value ? "true" : "false");
  } catch {
    // Ignore quota/security errors — section state is a nicety, not critical.
  }
}

export function loadProjectsSectionOpen(): boolean {
  return readBool(PROJECTS_KEY, true);
}

export function saveProjectsSectionOpen(open: boolean): void {
  writeBool(PROJECTS_KEY, open);
}

export function loadSessionsSectionOpen(): boolean {
  return readBool(SESSIONS_KEY, true);
}

export function saveSessionsSectionOpen(open: boolean): void {
  writeBool(SESSIONS_KEY, open);
}

export function loadPinnedSectionOpen(): boolean {
  return readBool(PINNED_KEY, true);
}

export function savePinnedSectionOpen(open: boolean): void {
  writeBool(PINNED_KEY, open);
}
