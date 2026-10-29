/**
 * Persisted open/collapsed state for the sidebar's top-level sections
 * (Pixie / Pinned / Projects).
 *
 * Same localStorage pattern as draft-store / file-explorer-state: the user's
 * section visibility survives reloads without blocking on failure.
 */

const PROJECTS_KEY = "pi-sidebar-projects-open";
const PINNED_KEY = "pi-sidebar-pinned-open";
const ASSISTANT_KEY = "pi-sidebar-assistant-open";
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

export function loadAssistantSectionOpen(): boolean {
  return readBool(ASSISTANT_KEY, true);
}

export function saveAssistantSectionOpen(open: boolean): void {
  writeBool(ASSISTANT_KEY, open);
}

export function loadProjectsSectionOpen(): boolean {
  return readBool(PROJECTS_KEY, true);
}

export function saveProjectsSectionOpen(open: boolean): void {
  writeBool(PROJECTS_KEY, open);
}

export function loadPinnedSectionOpen(): boolean {
  return readBool(PINNED_KEY, true);
}

export function savePinnedSectionOpen(open: boolean): void {
  writeBool(PINNED_KEY, open);
}
