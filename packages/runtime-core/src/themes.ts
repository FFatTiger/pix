/**
 * Canonical theme catalog models for {@link ThemeCatalogPort}.
 *
 * Themes are read-only presentation data: paired dark/light theme *sets*
 * discovered from pi theme JSON files (agent-dir global themes, trusted
 * project `.pi/themes`, plus a fixed built-in registry) resolved into a fixed
 * whitelist of CSS custom properties. The models below are canonical pix
 * types; the Pi-format JSON schema, filename pairing conventions and color
 * parsing semantics live entirely in the adapter.
 */

/** Theme polarity. */
export type ThemeVariant = "dark" | "light";

/**
 * A theme set: one base name pairing a dark and/or light variant
 * (e.g. "gruvbox" → gruvbox-dark.json + gruvbox-light.json).
 */
export interface ThemeSetInfo {
  /** Base name (e.g. "gruvbox") — the stable resolve identifier. */
  readonly name: string;
  /** Human-readable display name. */
  readonly displayName: string;
  /** Whether this set has a dark variant. */
  readonly hasDark: boolean;
  /** Whether this set has a light variant. */
  readonly hasLight: boolean;
  /** True for the built-in registry (no user JSON file). */
  readonly builtin: boolean;
}

/**
 * The fixed whitelist of CSS custom property names a resolved theme may
 * carry. This is the complete web-client theme projection surface — a resolved
 * theme NEVER introduces arbitrary CSS properties (no `url()`, `expression()`
 * or any style key outside this list can reach a client).
 */
export const THEME_CSS_VAR_KEYS = [
  "--bg",
  "--bg-panel",
  "--bg-secondary",
  "--bg-card",
  "--bg-hover",
  "--bg-selected",
  "--bg-card-hover",
  "--bg-subtle",
  "--border",
  "--border-hover",
  "--text",
  "--text-muted",
  "--text-dim",
  "--accent",
  "--accent-hover",
  "--accent-blue",
  "--accent-red",
  "--accent-green",
  "--accent-orange",
  "--git-status-added",
  "--git-status-modified",
  "--git-status-deleted",
  "--git-status-added-bg",
  "--git-status-modified-bg",
  "--git-status-deleted-bg",
  "--user-bg",
  "--assistant-bg",
  "--tool-bg",
  "--hatch-color",
] as const;

export type ThemeCssVarKey = (typeof THEME_CSS_VAR_KEYS)[number];

/**
 * A resolved, ready-to-use theme (one variant of a set). `cssVars` carries
 * every whitelisted key; values are sanitized color literals only.
 */
export interface ResolvedTheme {
  /** Base theme-set name. */
  readonly name: string;
  /** Whether this specific variant is dark (inferred from the palette). */
  readonly isDark: boolean;
  /** Whitelisted CSS variable name → safe color literal value. */
  readonly cssVars: Readonly<Record<ThemeCssVarKey, string>>;
}
