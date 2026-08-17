import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { createQueryOptions } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";
import {
  BUILTIN_THEME_SETS,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  getSystemPrefersDark,
  readBorderDepth,
  readFontScale,
  readThemeMode,
  readThemeName,
  resolveEffectiveMode,
  subscribeSystemColorScheme,
  writeBorderDepth,
  writeFontScale,
  writeThemeMode,
  writeThemeName,
  type ResolvedMode,
  type ThemeMode,
  type ThemeSetInfo,
} from "@/lib/theme";

/**
 * Single theme authority (replaces the former hook that owned a private
 * never-invalidated `themeCache`, a raw `fetch`, and per-consumer DOM apply
 * side effects).
 *
 * - Mounted ONCE by AppProviders with a route-level project scope (`cwd`)
 *   supplied from validated router search — never parsed from
 *   window.location.
 * - Resolve/list go through the react-query cache (one cache authority,
 *   keyed by `name::mode::cwd`), so consumers share state and switching scope
 *   never reads a stale entry.
 * - All DOM application happens here. Consumers read shared state/actions via
 *   `useTheme()` and never re-apply on their own mount.
 * - Latest user/OS intent wins: setTheme/setMode just set state (clicks are
 *   never dropped); react-query serves only the latest key's payload to this
 *   observer, so an older in-flight resolution can never overwrite a newer
 *   selection.
 * - Distinguishes boot state (no project / Default CSS theme) from remote
 *   errors: a resolve failure keeps the last applied CSS and surfaces the
 *   error; it never silently clears the theme.
 */

export type ThemeCatalogStatus = "idle" | "pending" | "success" | "error";
export type ThemeResolveStatus = "idle" | "pending" | "success" | "error";

export interface ThemeCatalog {
  /** idle = no project scope (boot state); pending/success/error = remote. */
  status: ThemeCatalogStatus;
  /** Remote theme-set list — null unless the remote list succeeded. */
  themeSets: ThemeSetInfo[] | null;
  /** Remote list error (null unless status === "error"). */
  error: unknown;
  /** Hardcoded built-in registry (boot fallback, never presented as remote). */
  builtinThemeSets: ThemeSetInfo[];
}

export interface ThemeContextValue {
  mode: ThemeMode;
  resolvedMode: ResolvedMode;
  /** Selected theme-set name ("" = Default / CSS-only theme). */
  themeName: string;
  isDark: boolean;
  borderDepth: number;
  fontScale: number;
  /** True when a project scope is active (cwd supplied from router search). */
  hasProject: boolean;
  catalog: ThemeCatalog;
  /** Pending/success/error for resolving the ACTIVE (themeName, mode, cwd). */
  resolveStatus: ThemeResolveStatus;
  setMode: (mode: ThemeMode) => void;
  setTheme: (name: string) => void;
  toggleTheme: (origin?: { x: number; y: number }) => void;
  setBorderDepth: (depth: number) => void;
  setFontScale: (scale: number) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

// ─── Initial state (seeded from the pre-React bootstrap attributes) ─────────

function readInitialMode(): ThemeMode {
  if (typeof document !== "undefined") {
    const dm = document.documentElement.dataset.themeMode as ThemeMode | undefined;
    if (dm === "light" || dm === "dark" || dm === "system") return dm;
  }
  return readThemeMode();
}

function readInitialTheme(): string {
  if (typeof document !== "undefined") {
    const dt = document.documentElement.dataset.theme;
    if (dt) return dt;
  }
  return readThemeName();
}

// ─── CSS var application (theme → DOM) ──────────────────────────────────────

const THEME_CSS_VARS = [
  "--bg", "--bg-panel", "--bg-secondary", "--bg-card", "--bg-hover",
  "--bg-selected", "--bg-card-hover", "--bg-subtle",
  "--border", "--border-hover",
  "--text", "--text-muted", "--text-dim",
  "--accent", "--accent-hover", "--accent-blue",
  "--accent-red", "--accent-green", "--accent-orange",
  "--git-status-added", "--git-status-modified", "--git-status-deleted",
  "--git-status-added-bg", "--git-status-modified-bg", "--git-status-deleted-bg",
  "--user-bg", "--assistant-bg", "--tool-bg",
  "--hatch-color",
];

/**
 * Preserve the raw theme border colors before any depth adjustment.
 * These stay untouched; `applyBorderDepth` reads them to derive
 * the active `--border` / `--border-hover` values.
 */
const BORDER_ORIG_VARS = ["--border-orig", "--border-hover-orig"] as const;

function applyCssVars(vars: Record<string, string>) {
  const el = document.documentElement;
  for (const k of THEME_CSS_VARS) {
    if (vars[k]) el.style.setProperty(k, vars[k]);
    else el.style.removeProperty(k);
  }
  if (vars["--border"]) el.style.setProperty("--border-orig", vars["--border"]);
  else el.style.removeProperty("--border-orig");
  if (vars["--border-hover"]) el.style.setProperty("--border-hover-orig", vars["--border-hover"]);
  else el.style.removeProperty("--border-hover-orig");
}

function clearCssVars() {
  const el = document.documentElement;
  for (const k of THEME_CSS_VARS) el.style.removeProperty(k);
  for (const k of BORDER_ORIG_VARS) el.style.removeProperty(k);
}

/** Ensure --border-orig / --border-hover-orig are populated (Default theme case). */
function ensureBorderOrig() {
  const el = document.documentElement;
  let orig = el.style.getPropertyValue("--border-orig").trim();
  let hover = el.style.getPropertyValue("--border-hover-orig").trim();

  if (!orig || !hover) {
    const cs = getComputedStyle(el);
    if (!orig) {
      orig = cs.getPropertyValue("--border").trim();
      if (orig) el.style.setProperty("--border-orig", orig);
    }
    if (!hover) {
      hover = cs.getPropertyValue("--border-hover").trim();
      if (hover) el.style.setProperty("--border-hover-orig", hover);
    }
  }
}

function applyBorderDepth(depth: number) {
  const el = document.documentElement;
  ensureBorderOrig();

  if (depth === 50) {
    const orig = el.style.getPropertyValue("--border-orig").trim();
    const hoverOrig = el.style.getPropertyValue("--border-hover-orig").trim();
    if (orig) el.style.setProperty("--border", orig);
    else el.style.removeProperty("--border");
    if (hoverOrig) el.style.setProperty("--border-hover", hoverOrig);
    else el.style.removeProperty("--border-hover");
    return;
  }

  const n = depth / 100;
  const expr = (origProp: string) => {
    if (n <= 0.5) {
      const origPct = Math.round(n * 2 * 100);
      return `color-mix(in srgb, var(${origProp}) ${origPct}%, var(--bg) ${100 - origPct}%)`;
    }
    const textPct = Math.round((n - 0.5) * 2 * 100);
    return `color-mix(in srgb, var(${origProp}) ${100 - textPct}%, var(--text) ${textPct}%)`;
  };

  el.style.setProperty("--border", expr("--border-orig"));
  el.style.setProperty("--border-hover", expr("--border-hover-orig"));
}

// ─── ThemeProvider ──────────────────────────────────────────────────────────

export interface ThemeProviderProps {
  /** Project scope from validated router search (null = no project open). */
  cwd?: string | null;
  children: ReactNode;
}

export function ThemeProvider({ cwd, children }: ThemeProviderProps) {
  const http = useHttpClient();

  const [mode, setModeState] = useState<ThemeMode>(readInitialMode);
  const [themeName, setThemeNameState] = useState<string>(readInitialTheme);
  const [borderDepth, setBorderDepthState] = useState<number>(readBorderDepth);
  const [fontScale, setFontScaleState] = useState<number>(readFontScale);
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(getSystemPrefersDark);

  useEffect(() => subscribeSystemColorScheme(() => setSystemPrefersDark(getSystemPrefersDark())), []);

  const resolvedMode: ResolvedMode = resolveEffectiveMode(mode, systemPrefersDark);

  const options = useMemo(() => createQueryOptions(http), [http]);

  // Single cache authority for the remote catalog + resolution.
  const listQuery = useQuery({
    ...options.themes.list(cwd ?? ""),
    enabled: Boolean(cwd),
  });
  const resolveQuery = useQuery({
    ...options.themes.resolve(themeName, resolvedMode, cwd ?? ""),
    enabled: Boolean(themeName) && Boolean(cwd),
  });

  // ── Actions: pure state writes — latest intent wins, clicks never dropped ──
  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    writeThemeMode(next);
  }, []);
  const setTheme = useCallback((name: string) => {
    setThemeNameState(name);
    writeThemeName(name);
  }, []);
  const setBorderDepth = useCallback((depth: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(depth)));
    setBorderDepthState(clamped);
    writeBorderDepth(clamped);
  }, []);
  const setFontScale = useCallback((scale: number) => {
    const clamped = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, Math.round(scale * 100) / 100));
    setFontScaleState(clamped);
    writeFontScale(clamped);
  }, []);

  const toggleTheme = useCallback((origin?: { x: number; y: number }) => {
    const nextMode: ThemeMode = mode === "system"
      ? (resolvedMode === "dark" ? "light" : "dark")
      : (mode === "dark" ? "light" : "dark");
    const apply = () => setMode(nextMode);

    const reduceMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const supportsVT = typeof document !== "undefined" && typeof document.startViewTransition === "function";
    if (!supportsVT || reduceMotion) { apply(); return; }

    const uiScale = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const x = (origin?.x ?? window.innerWidth / 2) / uiScale;
    const y = (origin?.y ?? window.innerHeight / 2) / uiScale;
    const cssViewportW = window.innerWidth / uiScale;
    const cssViewportH = window.innerHeight / uiScale;
    const endRadius = Math.hypot(Math.max(x, cssViewportW - x), Math.max(y, cssViewportH - y));

    const transition = document.startViewTransition(() => { apply(); });
    transition.ready.then(() => {
      document.documentElement.animate({
        clipPath: [
          `circle(0px at ${x}px ${y}px)`,
          `circle(${endRadius}px at ${x}px ${y}px)`,
        ],
      }, {
        duration: 450,
        easing: "cubic-bezier(0.22, 0.61, 0.36, 1)",
        pseudoElement: "::view-transition-new(root)",
      });
    }).catch(() => {});
  }, [mode, resolvedMode, setMode]);

  // ── DOM sync (the only place theme reaches the DOM) ────────────────────────
  useEffect(() => {
    const el = document.documentElement;
    el.dataset.themeMode = mode;
    el.dataset.themeResolvedMode = resolvedMode;
    if (resolvedMode === "dark") el.classList.add("dark");
    else el.classList.remove("dark");
  }, [mode, resolvedMode]);

  useEffect(() => {
    document.documentElement.style.setProperty("--app-ui-scale", String(fontScale));
  }, [fontScale]);

  useEffect(() => {
    applyBorderDepth(borderDepth);
  }, [borderDepth]);

  const lastAppliedRef = useRef<{ theme: string; mode: ResolvedMode; cwd: string | null } | null>(null);

  useEffect(() => {
    const el = document.documentElement;

    if (!themeName) {
      // Explicit Default selection: back to the CSS-only boot theme.
      delete el.dataset.theme;
      clearCssVars();
      lastAppliedRef.current = null;
      return;
    }

    // No project scope → nothing to resolve; keep whatever is applied
    // (default CSS or last good theme). Never clear on a missing scope.
    if (!cwd) return;

    const data = resolveQuery.data;
    if (resolveQuery.status === "success" && data) {
      // Latest-intent-wins guard: only apply a payload matching the current
      // intent; an older in-flight resolution must not overwrite a newer pick.
      if (data.name === themeName && data.isDark === (resolvedMode === "dark")) {
        lastAppliedRef.current = { theme: themeName, mode: resolvedMode, cwd };
        el.dataset.theme = themeName;
        applyCssVars(data.cssVars);
      }
    }
    // On error: leave CSS + dataset.theme untouched (last applied wins) —
    // never silently clear on a resolve failure.
  }, [resolveQuery.status, resolveQuery.data, themeName, resolvedMode, cwd]);

  const catalog: ThemeCatalog = useMemo(() => ({
    status: !cwd ? "idle" : (listQuery.status as ThemeCatalogStatus),
    themeSets: listQuery.data?.themeSets ?? null,
    error: listQuery.error ?? null,
    builtinThemeSets: BUILTIN_THEME_SETS,
  }), [cwd, listQuery.status, listQuery.data, listQuery.error]);

  const resolveStatus: ThemeResolveStatus = useMemo(() => {
    if (!themeName || !cwd) return "idle";
    return resolveQuery.status as ThemeResolveStatus;
  }, [themeName, cwd, resolveQuery.status]);

  const value = useMemo<ThemeContextValue>(() => ({
    mode,
    resolvedMode,
    themeName,
    isDark: resolvedMode === "dark",
    borderDepth,
    fontScale,
    hasProject: cwd !== null && cwd !== undefined,
    catalog,
    resolveStatus,
    setMode,
    setTheme,
    toggleTheme,
    setBorderDepth,
    setFontScale,
  }), [
    mode, resolvedMode, themeName, borderDepth, fontScale, cwd,
    catalog, resolveStatus, setMode, setTheme, toggleTheme, setBorderDepth, setFontScale,
  ]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Read shared theme state/actions — a pure consumer, never applies anything. */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return ctx;
}

export type { ThemeMode, ResolvedMode };
