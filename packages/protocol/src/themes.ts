import { z } from "zod";
import { NonEmptyStringSchema } from "./common.js";

/**
 * Read-only theme catalog DTOs (pix Host → Client).
 *
 * Mirrors the runtime-core ThemeCatalogPort projection, but stays a frozen
 * wire contract: this module NEVER imports runtime-core (rule 7 — Protocol and
 * Runtime Port share no types as a shortcut). The CSS variable key whitelist
 * and safe-value format are therefore declared here independently and must
 * stay in sync with the canonical model.
 */

/** Theme polarity requested by the client (default: dark). */
export const ThemeVariantSchema = z.enum(["dark", "light"]);
export type ThemeVariant = z.infer<typeof ThemeVariantSchema>;

/**
 * The complete whitelist of CSS custom property keys a resolved theme may
 * carry (the frozen 29-key web-client theme projection). Any other key — an
 * arbitrary CSS property, a `url()`/`expression()` carrier or an unknown
 * token — is rejected by the DTO.
 */
export const ThemeCssVarKeySchema = z.enum([
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
export type ThemeCssVarKey = z.infer<typeof ThemeCssVarKeySchema>;

/**
 * Safe theme color literal: a lowercase 3- or 6-digit hex color, or a decimal
 * `rgba(r,g,b,a)` with octets 0-255 and alpha 0-1. Nothing else is accepted —
 * named colors, `rgb()`/`hsl()` notation, `url(...)`, `expression(...)`,
 * `var(...)` references, comments, semicolons and any other CSS syntax fail
 * the schema (fail-closed).
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
 * may be present, but every present key MUST be in the 29-key enum and every
 * value a safe color literal. Unknown CSS keys (arbitrary properties,
 * `url()`/`expression()` carriers) and unsafe values fail the schema
 * (fail-closed) while sparse theme overrides stay valid.
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
