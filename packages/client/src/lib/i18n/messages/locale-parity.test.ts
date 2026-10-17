import { describe, expect, it } from "vitest";
import { enLocale } from "./en";
import { zhCNLocale } from "./zh-CN";

type MessageTable = Record<string, string>;
const en = enLocale.messages as MessageTable;
const zh = zhCNLocale.messages as MessageTable;

/**
 * Built-in locales must stay in key parity: a key that exists in en but not
 * zh-CN silently falls back to English in the Chinese UI (the MCP settings
 * page header shipped that way). Every new key lands in both files in the
 * same change.
 */
describe("locale key parity", () => {
  it("en and zh-CN define the exact same message keys", () => {
    const missingInZh = Object.keys(en).filter((key) => !(key in zh));
    const missingInEn = Object.keys(zh).filter((key) => !(key in en));
    expect(missingInZh, "keys missing from zh-CN (Chinese UI would show English)").toEqual([]);
    expect(missingInEn, "keys missing from en (fallback locale would warn)").toEqual([]);
  });

  it("zh-CN never interpolates a placeholder en lacks (fallback would leak raw tokens)", () => {
    const placeholder = /\{(\w+)\}/g;
    for (const [key, enValue] of Object.entries(en)) {
      const zhValue = zh[key];
      if (zhValue === undefined) continue;
      const enParams = new Set([...enValue.matchAll(placeholder)].map((m) => m[1]!));
      const extra = [...zhValue.matchAll(placeholder)].map((m) => m[1]!).filter((name) => !enParams.has(name));
      // The reverse direction is fine: a translation may drop a param it
      // does not need (zh has no plural "{suffix}").
      expect(extra, `zh-only placeholders for "${key}"`).toEqual([]);
    }
  });
});
