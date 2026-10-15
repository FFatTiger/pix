/** @vitest-environment node */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cssRule } from "./css-rule";

function rule(css: string, selector: string): string {
  const found = cssRule(css, selector);
  expect(found, selector).toBeDefined();
  return found as string;
}

describe("composer footer alignment", () => {
  it("aligns the session stats edge with the expanded ChatInput shell", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "globals.css"), "utf8");
    const shell = rule(css, ".chat-input-shell");
    const wrap = rule(css, ".session-info-bar-wrap");
    const inner = rule(css, ".session-info-bar-inner");

    expect(shell).toContain("width: calc(100% + 20px)");
    expect(shell).toContain("margin-left: -10px");
    expect(wrap).toContain("padding: 0 6px");
    expect(inner).toContain("max-width: 840px");
  });
});
