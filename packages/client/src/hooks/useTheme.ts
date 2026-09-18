import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  applyTheme,
  readThemeMode,
  resolveTheme,
  subscribeTheme,
  writeThemeMode,
  type ThemeMode,
  type ResolvedTheme,
} from "@/lib/theme";

/**
 * Dedicated Theme preference owner (provider-free, mirrors useUiScale).
 *
 * Applies the persisted `pi-theme-mode` to the document (html.dark class +
 * native color-scheme) on mount and on change, and follows the OS preference
 * while the mode is "system". The pre-React bootstrap already applies the
 * stored mode before first paint; this hook keeps runtime changes in sync and
 * lets components (e.g. DisplayConfig) read the effective value.
 */
export function useTheme(): {
  themeMode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  setThemeMode: (mode: ThemeMode) => void;
} {
  const themeMode = useSyncExternalStore(
    subscribeTheme,
    readThemeMode,
    () => "dark" as ThemeMode,
  );

  // Apply the mode on every change; while following system, also react to OS
  // preference flips.
  useEffect(() => {
    applyTheme(themeMode);
    if (themeMode !== "system") return;
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    if (!media.addEventListener) return;
    const onChange = () => applyTheme("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [themeMode]);

  const setThemeMode = useCallback((mode: ThemeMode) => writeThemeMode(mode), []);

  return { themeMode, resolvedTheme: resolveTheme(themeMode), setThemeMode };
}
