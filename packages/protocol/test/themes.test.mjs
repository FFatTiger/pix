import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  THEME_CSS_VAR_KEYS,
  ThemeCssVarKeySchema,
  ThemeCssValueSchema,
  ThemeCssVarsSchema,
  ThemeListResponseSchema,
  ThemeSetInfoSchema,
  ThemeVariantSchema,
  ResolvedThemeResponseSchema,
} from "../dist/index.js";

/** A complete cssVars map (every whitelisted key from the enum, safe values). */
const FULL_CSS_VARS = Object.fromEntries(
  ThemeCssVarKeySchema.options.map((key, index) => [key, index === 0 ? "#282828" : "#3c3836"]),
);

describe("theme DTO strictness", () => {
  it("accepts the canonical theme set shape and rejects extra keys", () => {
    const set = {
      name: "gruvbox",
      displayName: "Gruvbox",
      hasDark: true,
      hasLight: true,
      builtin: false,
    };
    assert.deepEqual(ThemeSetInfoSchema.parse(set), set);
    assert.equal(
      ThemeSetInfoSchema.safeParse({ ...set, path: "/etc/passwd" }).success,
      false,
      "extra keys must be rejected (strictObject)",
    );
    assert.equal(ThemeSetInfoSchema.safeParse({ ...set, name: "" }).success, false);
  });

  it("list response is exactly { themeSets: [...] }", () => {
    const body = { themeSets: [] };
    assert.deepEqual(ThemeListResponseSchema.parse(body), body);
    assert.equal(
      ThemeListResponseSchema.safeParse({ themeSets: [], extra: 1 }).success,
      false,
    );
  });

  it("variant is exactly dark|light", () => {
    assert.equal(ThemeVariantSchema.parse("dark"), "dark");
    assert.equal(ThemeVariantSchema.parse("light"), "light");
    for (const bad of ["Dark", "DARK", "auto", "system", "", "dark "]) {
      assert.equal(ThemeVariantSchema.safeParse(bad).success, false, bad);
    }
  });

  it("resolved theme response allows sparse whitelisted cssVars coverage", () => {
    const body = {
      name: "gruvbox",
      isDark: true,
      cssVars: { ...FULL_CSS_VARS, "--bg": "#282828", "--hatch-color": "rgba(1,2,3,0.16)" },
    };
    assert.equal(ResolvedThemeResponseSchema.safeParse(body).success, true);
    // Sparse overrides are valid: any subset of the whitelisted keys.
    for (const sparse of [
      { "--bg": "#282828" },
      {},
      { "--accent": "#fb4934", "--text": "#ebdbb2" },
    ]) {
      assert.equal(
        ResolvedThemeResponseSchema.safeParse({ ...body, cssVars: sparse }).success,
        true,
        `sparse map ${JSON.stringify(sparse)} must be accepted`,
      );
    }
    // Unknown CSS property key → rejected (no arbitrary style injection).
    for (const badKey of [
      "--evil",
      "background-image",
      "behavior",
      "--BG",
      "url",
    ]) {
      assert.equal(
        ResolvedThemeResponseSchema.safeParse({
          ...body,
          cssVars: { ...FULL_CSS_VARS, [badKey]: "#282828" },
        }).success,
        false,
        `key ${badKey} must be rejected`,
      );
    }
    // Extra top-level key → rejected.
    assert.equal(
      ResolvedThemeResponseSchema.safeParse({ ...body, filePath: "/x" }).success,
      false,
    );
  });

  it("css var key enum is the projected whitelist vocabulary (single declaration)", () => {
    // The enum is derived from the exported projection array — one local
    // declaration, so the schema and the array can never drift apart.
    assert.deepEqual(ThemeCssVarKeySchema.options, [...THEME_CSS_VAR_KEYS]);
    // Semantic surface checks (no magic count): the whitelist is a non-empty
    // vocabulary of lowercase CSS custom properties with the key the client
    // looks up by convention plus the sentinel final key present, unique.
    assert.ok(THEME_CSS_VAR_KEYS.length > 0, "whitelist must not be empty");
    assert.ok(THEME_CSS_VAR_KEYS.includes("--bg"));
    assert.ok(THEME_CSS_VAR_KEYS.includes("--git-status-added-bg"));
    assert.ok(THEME_CSS_VAR_KEYS.includes("--hatch-color"));
    assert.equal(new Set(THEME_CSS_VAR_KEYS).size, THEME_CSS_VAR_KEYS.length);
    for (const key of THEME_CSS_VAR_KEYS) {
      assert.match(key, /^--[a-z-]+$/, `${key} must be a lowercase CSS custom property`);
    }
  });

  it("css values accept only safe hex/rgba color literals", () => {
    for (const good of [
      "#282828",
      "#fb4934",
      "#abc",
      "rgba(255,255,255,0.035)",
      "rgba(0,0,0,0)",
      "rgba(13,148,136,0.12)",
      "rgba(100,193,182,1)",
    ]) {
      assert.equal(ThemeCssValueSchema.safeParse(good).success, true, good);
    }
    for (const bad of [
      // CSS function/property injection carriers.
      "url(javascript:alert(1))",
      "url(https://evil.example/x.png)",
      "expression(alert(1))",
      "var(--bg)",
      "red",
      "rgb(255, 255, 255)",
      "hsl(0, 100%, 50%)",
      "#282828; } body { display: none",
      "#282828 url(x.png)",
      "javascript:alert(1)",
      "<script>alert(1)</script>",
      "inherit",
      "",
      "#28282", // 5 digits
      "#2828288", // 7 digits
      "#GGGGGG",
      "#282828 ", // trailing whitespace
      "RGBA(255,255,255,0.1)",
      "rgba(256,0,0,0.5)", // octet > 255
      "rgba(1,2,3)", // missing alpha
      "rgba(1,2,3,2)", // alpha > 1
      "rgba(1,2,3,-0.5)",
    ]) {
      assert.equal(ThemeCssValueSchema.safeParse(bad).success, false, bad);
    }
  });

  it("cssVars record schema: sparse whitelisted keys, safe values only", () => {
    assert.equal(ThemeCssVarsSchema.safeParse(FULL_CSS_VARS).success, true);
    // Sparse coverage is valid (partialRecord over the enum).
    const partial = { ...FULL_CSS_VARS };
    delete partial["--bg"];
    assert.equal(ThemeCssVarsSchema.safeParse(partial).success, true);
    assert.equal(ThemeCssVarsSchema.safeParse({ "--bg": "#282828" }).success, true);
    assert.equal(ThemeCssVarsSchema.safeParse({}).success, true);
    // Unknown key, unsafe value and non-record shapes still fail closed.
    assert.equal(ThemeCssVarsSchema.safeParse({ ...FULL_CSS_VARS, "--bg": "url(x)" }).success, false);
    assert.equal(ThemeCssVarsSchema.safeParse({ "--evil": "#282828" }).success, false);
    assert.equal(ThemeCssVarsSchema.safeParse(["--bg"]).success, false);
    assert.equal(ThemeCssVarsSchema.safeParse(null).success, false);
  });
});
