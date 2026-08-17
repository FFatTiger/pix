/** @vitest-environment node */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("sidebar rail motion", () => {
  it("does not animate high-frequency list-row selection or press", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "pix-adapter.css"), "utf8");
    const listRow = css.slice(css.indexOf(".sidebar-list-row {"), css.indexOf(".sidebar-session-select {"));
    const sessionSelect = css.slice(css.indexOf(".sidebar-session-select {"), css.indexOf(".sidebar-list-row:hover .sidebar-row-title"));
    expect(listRow).toContain("transition: none");
    expect(listRow).toContain("transform: none");
    expect(listRow).not.toContain("scale(");
    expect(sessionSelect).toContain("transition: none");
    expect(sessionSelect).toContain("transform: none");
    expect(css).not.toMatch(/\.sidebar-list-row:active[^{]*\{[\s\S]*transform:\s*scale/);
    expect(css).not.toMatch(/\.sidebar-session-select:active[^{]*\{[\s\S]*transform:\s*scale/);
    expect(css).toContain(".sidebar-list-row:hover .sidebar-row-status");
    expect(css).toContain(".sidebar-row-actions .sidebar-icon-btn {");
    expect(css).toContain("background: var(--bg-panel);");
  });
});
