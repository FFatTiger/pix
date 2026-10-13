/** @vitest-environment node */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = css.indexOf("}", start);
  expect(end).toBeGreaterThan(start);
  return css.slice(start, end + 1);
}

function themeBlock(css: string, marker: string): string {
  const start = css.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = css.indexOf("}", start);
  return css.slice(start, end);
}

describe("two-surface chrome", () => {
  const stylesDir = dirname(fileURLToPath(import.meta.url));
  const css = readFileSync(join(stylesDir, "globals.css"), "utf8");

  it("defines the frame and content surfaces for both themes", () => {
    const light = themeBlock(css, ":root {");
    const dark = themeBlock(css, "html.dark {");
    expect(light).toContain("--surface-frame: #f5f5f5");
    expect(light).toContain("--surface-content: #ffffff");
    expect(light).toContain("--surface-hairline:");
    expect(dark).toContain("--surface-frame: #242424");
    expect(dark).toContain("--surface-content: #1a1a1a");
  });

  it("paints the title bar, tabs, and icon rail as one frame around the content", () => {
    expect(rule(css, ".app-title-bar")).toContain("background: var(--surface-frame)");
    expect(rule(css, ".app-title-bar")).not.toContain("border-bottom");
    expect(rule(css, ".workspace-tab")).toContain("background: transparent");
    expect(rule(css, ".workspace-tab")).not.toContain("border-right");
    expect(rule(css, ".workspace-tab--active,\n.workspace-tab--active:hover")).toContain("background: var(--surface-content)");
    expect(rule(css, ".right-pane-rail")).toContain("background: var(--surface-frame)");
    expect(rule(css, ".right-pane-rail")).not.toContain("border-left");
    expect(rule(css, '.right-pane-rail button[aria-pressed="true"]')).toContain("background: var(--surface-content)");
  });

  it("keeps panel dividers on the single hairline", () => {
    const desktop = css.slice(css.indexOf("@media (min-width: 641px)"));
    expect(rule(desktop, ".workspace-panel-splitter::before")).toContain("background: var(--surface-hairline)");
    expect(rule(css, ".side-chat-toolbar")).toContain("border-bottom: 1px solid var(--surface-hairline)");
  });
});
