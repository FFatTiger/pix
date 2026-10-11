import { reportPreferenceWrite } from "@/lib/preferences/preference-sync";

const STORAGE_KEY = "pi-status-card-display";

export type StatusCardDisplayMode = "mini" | "panel";

export function loadStatusCardDisplayMode(): StatusCardDisplayMode {
  if (typeof window === "undefined") return "mini";
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "panel" ? "panel" : "mini";
  } catch {
    return "mini";
  }
}

export function saveStatusCardDisplayMode(mode: StatusCardDisplayMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
    reportPreferenceWrite(STORAGE_KEY, mode);
  } catch {
    // Display persistence is a convenience; the in-memory choice still applies.
  }
}
