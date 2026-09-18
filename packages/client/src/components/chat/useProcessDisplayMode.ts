import { useCallback, useSyncExternalStore } from "react";

export type ProcessDisplayMode = "timeline" | "tabs" | "codex";

const STORAGE_KEY = "pi-process-display-mode";
const DEFAULT_MODE: ProcessDisplayMode = "timeline";
const CHANGE_EVENT = "pi-process-display-mode-change";
import { reportPreferenceWrite } from "@/lib/preferences/preference-sync";

function getStoredMode(): ProcessDisplayMode {
  if (typeof window === "undefined") return DEFAULT_MODE;

  const storedMode = window.localStorage.getItem(STORAGE_KEY);
  return storedMode === "timeline" || storedMode === "tabs" || storedMode === "codex"
    ? storedMode
    : DEFAULT_MODE;
}

function subscribe(onStoreChange: () => void) {
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

function getServerSnapshot(): ProcessDisplayMode {
  return DEFAULT_MODE;
}

export function useProcessDisplayMode() {
  const displayMode = useSyncExternalStore(subscribe, getStoredMode, getServerSnapshot);

  const setDisplayMode = useCallback((mode: ProcessDisplayMode) => {
    window.localStorage.setItem(STORAGE_KEY, mode);
    reportPreferenceWrite(STORAGE_KEY, mode);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return { displayMode, setDisplayMode };
}
