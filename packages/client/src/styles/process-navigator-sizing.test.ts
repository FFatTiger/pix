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

describe("process step navigator sizing", () => {
  it("caps the compact navigator but lets an expanded timeline fill the remaining transcript", () => {
    const stylesDir = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(stylesDir, "globals.css"), "utf8");
    const navigator = rule(css, '.group\\/process .process-step-nav');
    const fillNavigator = rule(css, '.group\\/process .process-step-nav--fill');
    const expanded = rule(css, '.group\\/process.process-group-shell--expanded');
    const source = readFileSync(join(stylesDir, "../components/chat/ProcessGroup.tsx"), "utf8");

    expect(navigator).toContain("max-height: 144px");
    expect(navigator).not.toMatch(/\n\s*height:\s*144px/);
    expect(fillNavigator).toContain("max-height: var(--process-group-max-height)");
    expect(expanded).toContain("max-height: var(--process-group-max-height)");
    expect(expanded).not.toMatch(/\n\s*height:/);
    expect(expanded).not.toMatch(/100(?:d|s|l)?vh/);
    expect(source).not.toContain("max-h-[280px]");
  });
});
