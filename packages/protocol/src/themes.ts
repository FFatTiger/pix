import { z } from "zod";
import { NonEmptyStringSchema } from "./common.js";

/**
 * Read-only theme catalog DTOs (pix Host → Client).
 *
 * This is a frozen PROJECTION of the canonical theme vocabulary owned by
 * `packages/runtime-core/src/themes.ts` (rule 7 — Protocol and Runtime Port
 * share no types as a shortcut, so this module NEVER imports runtime-core).
 * The CSS variable key whitelist below and the safe-value format are declared
 * here as a wire projection of that canonical authority — same keys, same
 * order, same accept/reject behavior — and cross-package contract tests
 * (`packages/cross-package-contract-tests/src/theme-authority-contract.test.ts`)
 * enforce semantic parity, so no independent array or regex set may drift.
 */

/** Theme polarity requested by the client (default: dark). */
export const ThemeVariantSchema = z.enum(["dark", "light"]);
export type ThemeVariant = z.infer<typeof ThemeVariantSchema>;

/**
 * The complete whitelist of CSS custom property keys a resolved theme may
 * carry — the frozen web-client theme projection of the canonical
 * `runtime-core` THEME_CSS_VAR_KEYS (same keys, same order). Any other key —
 * an arbitrary CSS property, a `url()`/`expression()` carrier or an unknown
 * token — is rejected by the DTO.
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

/** The enum derived from the projected whitelist (single local declaration). */
export const ThemeCssVarKeySchema = z.enum(THEME_CSS_VAR_KEYS);
export type ThemeCssVarKey = z.infer<typeof ThemeCssVarKeySchema>;

/**
 * Safe theme color literal — projection of the canonical
 * `runtime-core` `isSafeThemeCssValue`: a lowercase 3- or 6-digit hex color,
 * or a decimal `rgba(r,g,b,a)` with octets 0-255 and alpha 0-1. Nothing else
 * is accepted — named colors, `rgb()`/`hsl()` notation, `url(...)`,
 * `expression(...)`, `var(...)` references, comments, semicolons and any
 * other CSS syntax fail the schema (fail-closed). The cross-package contract
 * test verifies this accepts exactly what the canonical predicate accepts.
 */
const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/;
const RGBA_COLOR_PATTERN =
  /^rgba\((\d{1,3}),(\d{1,3}),(\d{1,3}),(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)\)$/;

function isSafeThemeCssValue(value: string): boolean {
  if (HEX_COLOR_PATTERN.test(value)) return true;
  const match = RGBA_COLOR_PATTERN.exec(value);
  if (!match) return false;
  return [match[1], match[2], match[3]].every((octet) => Number(octet) <= 255);
}

export const ThemeCssValueSchema = z
  .string()
  .refine(isSafeThemeCssValue, {
    message: "theme CSS value must be a safe hex or rgba() color literal",
  });
export type ThemeCssValue = z.infer<typeof ThemeCssValueSchema>;

/**
 * CSS variable map: sparse coverage over the whitelisted keys — any subset
 * may be present, but every present key MUST be in the whitelisted-key enum
 * and every value a safe color literal. Unknown CSS keys (arbitrary
 * properties, `url()`/`expression()` carriers) and unsafe values fail the
 * schema (fail-closed) while sparse theme overrides stay valid.
 */
export const ThemeCssVarsSchema = z.partialRecord(
  ThemeCssVarKeySchema,
  ThemeCssValueSchema,
);
export type ThemeCssVars = z.infer<typeof ThemeCssVarsSchema>;

/** One theme set (a base name pairing dark and/or light variants). */
export const ThemeSetInfoSchema = z.strictObject({
  name: NonEmptyStringSchema,
  displayName: NonEmptyStringSchema,
  hasDark: z.boolean(),
  hasLight: z.boolean(),
  builtin: z.boolean(),
});
export type ThemeSetInfo = z.infer<typeof ThemeSetInfoSchema>;

/** GET /v1/themes response body. */
export const ThemeListResponseSchema = z.strictObject({
  themeSets: z.array(ThemeSetInfoSchema),
});
export type ThemeListResponse = z.infer<typeof ThemeListResponseSchema>;

/** GET /v1/themes/:name response body. */
export const ResolvedThemeResponseSchema = z.strictObject({
  name: NonEmptyStringSchema,
  isDark: z.boolean(),
  cssVars: ThemeCssVarsSchema,
});
export type ResolvedThemeResponse = z.infer<typeof ResolvedThemeResponseSchema>;
