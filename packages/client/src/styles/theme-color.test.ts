/** @vitest-environment node */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The browser/PWA title bar (meta theme-color) must match the frame surface,
// otherwise a strip of a different colour sits above the tab bar.
describe("browser theme-color follows the frame surface", () => {
  it("uses --surface-frame in every place that sets theme-color", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "..");
    const css = readFileSync(join(src, "styles/globals.css"), "utf8");
    const light = css.match(/--surface-frame:\s*(#[0-9a-f]{6})/i)?.[1];
    const dark = [...css.matchAll(/--surface-frame:\s*(#[0-9a-f]{6})/gi)][1]?.[1];
    expect(light).toBeTruthy();
    expect(dark).toBeTruthy();
    const sources = [
      readFileSync(join(src, "lib/theme.ts"), "utf8"),
      readFileSync(join(src, "app/AppProviders.tsx"), "utf8"),
      readFileSync(join(src, "../index.html"), "utf8"),
    ];
    for (const source of sources) {
      expect(source).toContain(`"${dark}"`);
      expect(source).toContain(`"${light}"`);
    }
  });
});
