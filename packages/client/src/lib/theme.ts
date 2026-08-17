/**
 * Client-side theme shared types + single authority for theme settings
 * persistence. Ported from the upstream desktop theme module.
 *
 * The source module is a Node implementation (fs scan of
 * `~/.pi/agent/themes/` + `<cwd>/.pi/themes/`, pi CLI JSON parsing, color
 * mapping). pix keeps that server-side: the Host themes slice serves
 * `GET /v1/themes?cwd=` and `GET /v1/themes/:name?mode=&cwd=` and the Client
 * consumes them through `@/api/themes`. Only the shared type surface below,
 * the built-in registry metadata (pre-Host fallback), and the theme settings
 * serialization live here.
 *
 * THIS MODULE IS THE SINGLE RUNTIME OWNER of the theme setting keys and their
 * serialization. `ThemeProvider` reads/writes exclusively through these
 * helpers; consumers never touch the keys or the DOM directly. The only other
 * place that reads these keys is the pre-React anti-flash bootstrap inline
 * script in index.html (it cannot import a module and must apply before first
 * paint) — keep the two key spellings in sync here.
 */

/** Represents the user's stored color-mode preference (never "system" once resolved). */
export type ThemeMode = "light" | "dark" | "system";
/** The actually-rendered mode (never "system"). */
export type ResolvedMode = "light" | "dark";

export interface PiTheme {
  name: string;
  vars?: Record<string, string | number>;
  colors: Record<string, string | number>;
}

/** Represents a paired theme set (e.g. "gruvbox" with dark + light variants). */
export interface ThemeSetInfo {
  /** Base name (e.g. "gruvbox") — used as the stable identifier. */
  name: string;
  /** Human-readable display name. */
  displayName: string;
  /** Whether this set has a dark variant. */
  hasDark: boolean;
  /** Whether this set has a light variant. */
  hasLight: boolean;
  /** True for the built-in default theme (no JSON files). */
  builtin: boolean;
}

/** A resolved, ready-to-use theme (one variant of a set). */
export interface ResolvedTheme {
  /** Base theme-set name. */
  name: string;
  /** Whether this specific variant is dark. */
  isDark: boolean;
  /** CSS variable name → hex value (e.g. "--bg" → "#282828") */
  cssVars: Record<string, string>;
}

export type ThemeVariant = "dark" | "light";

/**
 * Metadata mirror of the source `lib/themes/index.ts` BUILTIN_THEMES registry
 * (all five sets ship both variants). The theme JSON payloads themselves stay
 * server-side. These are the hardcoded boot-state fallback for the theme
 * picker when no project is open or the remote catalog is unavailable — they
 * are ALWAYS presented as built-in defaults, never as successful remote data.
 */
export const BUILTIN_THEME_SETS: ThemeSetInfo[] = [
  { name: "gruvbox", displayName: "Gruvbox", hasDark: true, hasLight: true, builtin: true },
  { name: "miku-aqua", displayName: "Miku Aqua", hasDark: true, hasLight: true, builtin: true },
  { name: "orbital-rose", displayName: "Orbital Rose", hasDark: true, hasLight: true, builtin: true },
  { name: "scarlet-tether", displayName: "Scarlet Tether", hasDark: true, hasLight: true, builtin: true },
  { name: "solarized", displayName: "Solarized", hasDark: true, hasLight: true, builtin: true },
];

// ─── Theme settings persistence (single runtime owner) ──────────────────────

/** localStorage keys — keep spellings in sync with the index.html bootstrap. */
export const THEME_MODE_KEY = "pi-theme-mode";
export const THEME_NAME_KEY = "pi-theme";
export const THEME_LEGACY_DARK_KEY = "pi-theme-dark";
export const THEME_LEGACY_LIGHT_KEY = "pi-theme-light";
export const BORDER_DEPTH_KEY = "pi-border-depth";
export const FONT_SCALE_KEY = "pi-font-scale";

export const BORDER_DEPTH_DEFAULT = 25;
export const FONT_SCALE_MIN = 0.8;
export const FONT_SCALE_MAX = 1.5;

export function readThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_MODE_KEY);
    if (v === "dark" || v === "light" || v === "system") return v;
  } catch {}
  return "dark";
}

export function writeThemeMode(mode: ThemeMode): void {
  try { localStorage.setItem(THEME_MODE_KEY, mode); } catch {}
}

/**
 * One-time migration from the legacy per-mode keys (e.g. "gruvbox-dark" →
 * "gruvbox"). The pre-React bootstrap also performs this before first paint;
 * this copy is a defensive fallback for environments where the inline script
 * did not run (tests, embedders). Returns the migrated base name or null.
 */
export function migrateLegacyThemeName(): string | null {
  try {
    const oldDark = localStorage.getItem(THEME_LEGACY_DARK_KEY);
    const oldLight = localStorage.getItem(THEME_LEGACY_LIGHT_KEY);
    for (const old of [oldDark, oldLight]) {
      if (!old || old === "dark" || old === "light") continue;
      const base = old.replace(/-dark$/i, "").replace(/-light$/i, "");
      if (base && base !== old) {
        localStorage.setItem(THEME_NAME_KEY, base);
        localStorage.removeItem(THEME_LEGACY_DARK_KEY);
        localStorage.removeItem(THEME_LEGACY_LIGHT_KEY);
        return base;
      }
    }
    const v = oldDark || oldLight;
    if (v && v !== "dark" && v !== "light") {
      localStorage.setItem(THEME_NAME_KEY, v);
      localStorage.removeItem(THEME_LEGACY_DARK_KEY);
      localStorage.removeItem(THEME_LEGACY_LIGHT_KEY);
      return v;
    }
  } catch {}
  return null;
}

/** Stored theme-set name ("" = Default / CSS-only theme). */
export function readThemeName(): string {
  try {
    if (localStorage.getItem(THEME_NAME_KEY) === null) {
      const migrated = migrateLegacyThemeName();
      if (migrated) return migrated;
    }
    const v = localStorage.getItem(THEME_NAME_KEY);
    if (v) return v;
  } catch {}
  return "";
}

export function writeThemeName(name: string): void {
  try {
    if (name) localStorage.setItem(THEME_NAME_KEY, name);
    else localStorage.removeItem(THEME_NAME_KEY);
  } catch {}
}

export function readBorderDepth(): number {
  try {
    const v = localStorage.getItem(BORDER_DEPTH_KEY);
    if (v !== null) {
      const n = parseInt(v, 10);
      if (!isNaN(n) && n >= 0 && n <= 100) return n;
    }
  } catch {}
  return BORDER_DEPTH_DEFAULT;
}

export function writeBorderDepth(depth: number): void {
  try { localStorage.setItem(BORDER_DEPTH_KEY, String(depth)); } catch {}
}

export function readFontScale(): number {
  try {
    const v = localStorage.getItem(FONT_SCALE_KEY);
    if (v !== null) {
      const n = parseFloat(v);
      if (!isNaN(n) && n >= FONT_SCALE_MIN && n <= FONT_SCALE_MAX) return n;
    }
  } catch {}
  return 1;
}

export function writeFontScale(scale: number): void {
  try { localStorage.setItem(FONT_SCALE_KEY, String(scale)); } catch {}
}

// ─── System preference ──────────────────────────────────────────────────────

export function getSystemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveEffectiveMode(stored: ThemeMode, systemPrefersDark: boolean): ResolvedMode {
  if (stored === "system") return systemPrefersDark ? "dark" : "light";
  return stored;
}

/** Subscribe to OS-level color scheme changes. */
export function subscribeSystemColorScheme(cb: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
