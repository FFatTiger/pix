/**
 * Canonical theme catalog models for {@link ThemeCatalogPort}.
 *
 * Themes are read-only presentation data: paired dark/light theme *sets*
 * discovered from pi theme JSON files (agent-dir global themes, trusted
 * project `.pi/themes`, plus a fixed built-in registry) resolved into a fixed
 * whitelist of CSS custom properties. The models below are canonical pix
 * types; the Pi-format JSON schema, filename pairing conventions and color
 * parsing semantics live entirely in the adapter.
 *
 * ## Single vocabulary authority
 *
 * This module is the ONE canonical authority for the theme domain vocabulary:
 *
 *   - {@link THEME_CSS_VAR_KEYS} — the fixed whitelist of CSS custom property
 *     keys a resolved theme may carry, and
 *   - {@link isSafeThemeCssValue} — the fail-closed safe color/value predicate.
 *
 * The wire contract (`@fffattiger/pix-protocol`) and Host sanitization
 * (`packages/host`) cannot import this package (architecture rules 4/7 and the
 * host boundary gate), so they keep frozen PROJECTIONS of this vocabulary and
 * cross-package contract tests (`packages/runtime-contract-tests` and the host
 * theme route tests) enforce semantic parity. Do not extend the vocabulary
 * here without updating those projections and their parity tests.
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
 * or any style key outside this list can reach a client). This array is the
 * canonical authority: Protocol and Host project it (same keys, same order)
 * and contract tests enforce parity, so no independent array may drift.
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
 * Canonical fail-closed safe theme CSS value predicate.
 *
 * Accepts ONLY a lowercase 3- or 6-digit hex color, or a decimal
 * `rgba(r,g,b,a)` with octets 0-255 and alpha 0-1. Nothing else is safe —
 * named colors, `rgb()`/`hsl()` notation, `url(...)`, `expression(...)`,
 * `var(...)` references, comments, semicolons and any other CSS syntax are
 * rejected. This is the canonical validator: Protocol's `ThemeCssValueSchema`
 * and Host's sanitization are projections of it, and cross-package contract
 * tests enforce that a value is accepted here exactly when the projections
 * accept it (no independent regex set may drift).
 */
const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/;
const RGBA_COLOR_PATTERN =
  /^rgba\((\d{1,3}),(\d{1,3}),(\d{1,3}),(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)\)$/;

export function isSafeThemeCssValue(value: string): boolean {
  if (HEX_COLOR_PATTERN.test(value)) return true;
  const match = RGBA_COLOR_PATTERN.exec(value);
  if (!match) return false;
  return [match[1], match[2], match[3]].every((octet) => Number(octet) <= 255);
}

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
