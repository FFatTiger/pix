/**
 * Theme mode preference (dark / light / follow system).
 *
 * - `pi-theme-mode` persistence + resolution + DOM application live here
 *   (single runtime authority). Components never touch the key or the class
 *   directly.
 * - The pre-React bootstrap in index.html already applies the stored mode
 *   before first paint; `useTheme` keeps the `html.dark` class (and native
 *   `color-scheme`) in sync for runtime changes and while following system.
 * - Cross-component sync uses the same custom-event + storage pattern as
 *   useProcessDisplayMode: every consumer observes the persisted value.
 */
export type ThemeMode = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

export const THEME_STORAGE_KEY = "pi-theme-mode";
const CHANGE_EVENT = "pi-theme-mode-change";
const DEFAULT_MODE: ThemeMode = "dark";

export function readThemeMode(): ThemeMode {
  if (typeof window === "undefined") return DEFAULT_MODE;
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : DEFAULT_MODE;
}

export function writeThemeMode(mode: ThemeMode): void {
  window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Resolve the effective theme, honoring the system preference for "system". */
export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === "light") return "light";
  if (mode === "dark") return "dark";
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "dark";
}

/** Apply a theme mode to the document (html.dark + native color-scheme). */
export function applyTheme(mode: ThemeMode): void {
  const resolved = resolveTheme(mode);
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", resolved === "dark" ? "#1a1a1a" : "#ffffff");
}

/** Observe mode changes (custom event + cross-tab storage). */
export function subscribeTheme(onChange: () => void): () => void {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY) onChange();
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", handleStorage);
  };
}
