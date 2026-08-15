/**
 * Client-side theme shared types, ported from pi-web-desktop `lib/theme.ts`.
 *
 * The source module is a Node implementation (fs scan of
 * `~/.pi/agent/themes/` + `<cwd>/.pi/themes/`, pi CLI JSON parsing, color
 * mapping). pix keeps that server-side: the Host themes slice serves
 * `GET /v1/themes` and `GET /v1/themes/:name?mode=` and the Client consumes
 * them through `@/api/themes`. Only the shared type surface below (and the
 * built-in registry metadata used as the pre-Host fallback) lives here.
 */

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
 * server-side; until the Host themes routes land, the Display settings use
 * this list so the built-in themes (plus Default) remain selectable and the
 * picker never renders empty. Selecting a set before the routes exist is
 * safe: `useTheme` falls back to the default CSS theme when resolution fails.
 */
export const BUILTIN_THEME_SETS: ThemeSetInfo[] = [
  { name: "gruvbox", displayName: "Gruvbox", hasDark: true, hasLight: true, builtin: true },
  { name: "miku-aqua", displayName: "Miku Aqua", hasDark: true, hasLight: true, builtin: true },
  { name: "orbital-rose", displayName: "Orbital Rose", hasDark: true, hasLight: true, builtin: true },
  { name: "scarlet-tether", displayName: "Scarlet Tether", hasDark: true, hasLight: true, builtin: true },
  { name: "solarized", displayName: "Solarized", hasDark: true, hasLight: true, builtin: true },
];
