/**
 * Cross-package theme vocabulary contract — the dedicated single-authority
 * seam for theme grammar.
 *
 * `packages/runtime-core/src/themes.ts` owns the ONE canonical theme domain
 * vocabulary: the CSS variable key whitelist (`THEME_CSS_VAR_KEYS`) and the
 * fail-closed safe color/value predicate (`isSafeThemeCssValue`). Protocol
 * cannot import runtime-core (architecture rule 7 — Protocol and Runtime Port
 * share no types as a shortcut) and Host cannot import runtime-core (host
 * boundary gate), so both keep frozen PROJECTIONS of that vocabulary.
 *
 * This test-only package is the seam that pins the protocol projection to the
 * canonical authority by SEMANTIC parity — key-for-key and accept-for-accept —
 * never by a magic count that could drift while the two lists diverge. The
 * host theme route tests then pin the host projection to the protocol
 * projection (host's real peer), so any drift in either projection fails a
 * test instead of silently diverging the sanitizers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  THEME_CSS_VAR_KEYS as CANONICAL_THEME_CSS_VAR_KEYS,
  isSafeThemeCssValue as canonicalIsSafeThemeCssValue,
} from "@fffattiger/pix-runtime-core";
import {
  THEME_CSS_VAR_KEYS as PROTOCOL_THEME_CSS_VAR_KEYS,
  ThemeCssVarKeySchema,
  ThemeCssValueSchema,
} from "@fffattiger/pix-protocol";

/** Values the canonical predicate must accept (and every projection must too). */
const SAFE_PROBES = [
  "#282828",
  "#fb4934",
  "#abc",
  "rgba(255,255,255,0.035)",
  "rgba(0,0,0,0)",
  "rgba(13,148,136,0.12)",
  "rgba(100,193,182,1)",
];

/** Values the canonical predicate must reject (and every projection must too). */
const UNSAFE_PROBES = [
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
  "#28282",
  "#2828288",
  "#GGGGGG",
  "#282828 ",
  "RGBA(255,255,255,0.1)",
  "rgba(256,0,0,0.5)",
  "rgba(1,2,3)",
  "rgba(1,2,3,2)",
  "rgba(1,2,3,-0.5)",
];

test("protocol theme css var keys are semantically identical to the canonical runtime-core whitelist", () => {
  // Same keys, same order, same length — derived by comparison against the
  // canonical authority, never by a hardcoded count that could drift while
  // the two lists diverge.
  assert.deepEqual(
    [...PROTOCOL_THEME_CSS_VAR_KEYS],
    [...CANONICAL_THEME_CSS_VAR_KEYS],
    "protocol projection must match the canonical runtime-core whitelist",
  );
  // The protocol zod enum derives from its own single projection array, so
  // the schema and the exported array cannot drift apart either.
  assert.deepEqual(ThemeCssVarKeySchema.options, [...PROTOCOL_THEME_CSS_VAR_KEYS]);
  // Semantic surface sanity: every key is a lowercase CSS custom property.
  for (const key of CANONICAL_THEME_CSS_VAR_KEYS) {
    assert.match(key, /^--[a-z-]+$/, `${key} must be a lowercase CSS custom property`);
  }
});

test("protocol safe-value schema accepts exactly what the canonical runtime-core predicate accepts", () => {
  for (const value of [...SAFE_PROBES, ...UNSAFE_PROBES]) {
    const canonical = canonicalIsSafeThemeCssValue(value);
    const protocol = ThemeCssValueSchema.safeParse(value).success;
    assert.equal(
      protocol,
      canonical,
      `value ${JSON.stringify(value)}: protocol=${protocol} canonical=${canonical}`,
    );
  }
});
