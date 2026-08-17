/**
 * Read-only theme catalog routes (D3B-R6).
 *
 * GET /v1/themes?cwd=          → { themeSets: ThemeSetInfo[] }
 * GET /v1/themes/:name?mode=&cwd= → { name, isDark, cssVars }
 *
 * Project-scoped: `?cwd=` is REQUIRED and must be an absolute authorized
 * existing directory (same AllowedRoots policy as every other catalog route —
 * no process.cwd fallback). Project `.pi/themes` contribute themes only while
 * the project is trusted; global (agent-dir) and built-in themes stay readable
 * for any authorized cwd. `mode` is exactly `light` | `dark` (default `dark`,
 * the source default); `:name` is validated against a strict slug pattern
 * before any catalog call, so a theme name can never traverse out of a theme
 * directory (the source's direct-path fallback is deliberately not ported).
 *
 * This module is protocol-independent (no runtime-core / pi-sdk-adapter /
 * protocol imports): the seam returns `unknown` and Host-side projectors emit
 * only plain JSON primitives. The cssVars whitelist below and the safe-value
 * predicate are a frozen PROJECTION of the canonical theme vocabulary owned by
 * `packages/runtime-core/src/themes.ts` (this module cannot import
 * runtime-core — the host boundary gate) — same keys, same accept/reject
 * behavior — and the host theme route tests enforce semantic parity against
 * the protocol projection (which the runtime-contract-tests seam pins to
 * runtime-core). No arbitrary CSS property, `url()`, `expression()` or other
 * style syntax ever reaches the wire. Errors are fixed sanitized 400/404/503
 * bodies; paths, raw JSON content and stacks are never forwarded.
 */
import type { Hono } from "hono";
import type { HostEnv } from "../env.js";
import { HttpError } from "../errors.js";
import { mapCatalogError, requireAuthorizedCwd } from "./catalogs.js";
import type { CatalogDeps } from "../types.js";

/** Fixed sanitized theme-unavailable body (shared CATALOG_UNAVAILABLE message). */
export const THEME_UNAVAILABLE_MESSAGE = "Catalog is unavailable";

/**
 * Theme names must be plain ASCII slugs (leading alphanumeric, then
 * alphanumerics/`.`/`_`/`-`, ≤64 chars). No path separators, no `..`, no NUL,
 * no percent-encoding leftovers — a name can never escape a theme directory.
 */
export const THEME_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The complete CSS custom property whitelist — frozen projection of the
 * canonical `runtime-core` THEME_CSS_VAR_KEYS (this module stays
 * dependency-free, so the list is declared here and the host theme route
 * tests enforce semantic parity with the protocol projection).
 */
export const THEME_CSS_VAR_KEYS: ReadonlySet<string> = new Set([
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
]);

/**
 * Safe theme color literal — projection of the canonical `runtime-core`
 * `isSafeThemeCssValue`: lowercase 3/6-digit hex or decimal rgba()
 * (octets 0-255, alpha 0-1). Any other CSS syntax fails closed.
 */
const SAFE_HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/;
const SAFE_RGBA_COLOR =
  /^rgba\((\d{1,3}),(\d{1,3}),(\d{1,3}),(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)\)$/;

export function isSafeThemeCssValue(value: string): boolean {
  if (SAFE_HEX_COLOR.test(value)) return true;
  const match = SAFE_RGBA_COLOR.exec(value);
  if (!match) return false;
  return [match[1], match[2], match[3]].every((octet) => Number(octet) <= 255);
}

function themeUnavailable(): HttpError {
  return new HttpError(503, "CATALOG_UNAVAILABLE", THEME_UNAVAILABLE_MESSAGE);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readField(raw: Record<string, unknown>, key: string): unknown {
  try {
    return raw[key];
  } catch {
    throw themeUnavailable();
  }
}

function requireNonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw themeUnavailable();
  return value;
}

// ---------------------------------------------------------------------------
// Strict Host-side projectors — plain primitives only
// ---------------------------------------------------------------------------

export function projectThemeSetInfo(raw: unknown): {
  name: string;
  displayName: string;
  hasDark: boolean;
  hasLight: boolean;
  builtin: boolean;
} {
  if (!isPlainObject(raw)) throw themeUnavailable();
  const hasDark = readField(raw, "hasDark");
  const hasLight = readField(raw, "hasLight");
  const builtin = readField(raw, "builtin");
  if (typeof hasDark !== "boolean") throw themeUnavailable();
  if (typeof hasLight !== "boolean") throw themeUnavailable();
  if (typeof builtin !== "boolean") throw themeUnavailable();
  return {
    name: requireNonEmptyString(readField(raw, "name")),
    displayName: requireNonEmptyString(readField(raw, "displayName")),
    hasDark,
    hasLight,
    builtin,
  };
}

/**
 * Project a resolved theme. Every cssVars key must be whitelisted and every
 * value a safe color literal — an unknown key or unsafe value fails closed as
 * a fixed 503 (never forwarded, never partially emitted).
 */
export function projectResolvedTheme(raw: unknown): {
  name: string;
  isDark: boolean;
  cssVars: Record<string, string>;
} {
  if (!isPlainObject(raw)) throw themeUnavailable();
  const isDark = readField(raw, "isDark");
  if (typeof isDark !== "boolean") throw themeUnavailable();
  const cssVarsRaw = readField(raw, "cssVars");
  if (!isPlainObject(cssVarsRaw)) throw themeUnavailable();
  const cssVars: Record<string, string> = {};
  for (const key of Object.keys(cssVarsRaw)) {
    if (!THEME_CSS_VAR_KEYS.has(key)) throw themeUnavailable();
    const value = readField(cssVarsRaw, key);
    if (typeof value !== "string" || !isSafeThemeCssValue(value)) {
      throw themeUnavailable();
    }
    cssVars[key] = value;
  }
  return {
    name: requireNonEmptyString(readField(raw, "name")),
    isDark,
    cssVars,
  };
}

function projectArray<T>(raw: unknown, project: (item: unknown) => T): T[] {
  if (!Array.isArray(raw)) throw themeUnavailable();
  const projected: T[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(raw, index)) {
      throw themeUnavailable();
    }
    projected.push(project(raw[index]));
  }
  return projected;
}

/** Validate the `:name` route parameter; fixed sanitized 400 on any violation. */
export function requireValidThemeName(raw: unknown): string {
  if (typeof raw !== "string" || !THEME_NAME_PATTERN.test(raw)) {
    throw new HttpError(400, "INVALID_THEME_NAME", "Invalid theme name");
  }
  return raw;
}

/** Validate `?mode=`: absent/empty → "dark" (source default); anything else → 400. */
export function requireValidThemeMode(raw: string | undefined): "dark" | "light" {
  if (raw === undefined || raw === "") return "dark";
  if (raw === "light" || raw === "dark") return raw;
  throw new HttpError(400, "INVALID_THEME_MODE", "mode must be light or dark");
}

/**
 * Register the read-only theme catalog routes for the mounted themes seam.
 * No-op when the seam is absent (route + capability token both unmounted).
 */
export function registerThemeRoutes(app: Hono<HostEnv>, deps: CatalogDeps): void {
  const seam = deps.themes;
  if (!seam) return;

  app.get("/v1/themes", async (c) => {
    c.header("Cache-Control", "no-store");
    const cwd = await requireAuthorizedCwd(deps, c.req.query("cwd"));
    const trusted = deps.trust ? await deps.trust.isTrusted(cwd) : false;
    try {
      const catalog = seam.forCwd(cwd, trusted === true);
      const themeSets = projectArray(await catalog.listThemeSets(), projectThemeSetInfo);
      return c.json({ themeSets });
    } catch (error) {
      throw mapCatalogError(error, "theme");
    }
  });

  app.get("/v1/themes/:name", async (c) => {
    c.header("Cache-Control", "no-store");
    const name = requireValidThemeName(c.req.param("name"));
    const mode = requireValidThemeMode(c.req.query("mode"));
    const cwd = await requireAuthorizedCwd(deps, c.req.query("cwd"));
    const trusted = deps.trust ? await deps.trust.isTrusted(cwd) : false;
    try {
      const catalog = seam.forCwd(cwd, trusted === true);
      const theme = projectResolvedTheme(await catalog.resolveTheme(name, mode));
      return c.json(theme);
    } catch (error) {
      throw mapCatalogError(error, "theme");
    }
  });
}
