/** @vitest-environment node */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("mobile chrome", () => {
  it("uses an opaque flat title bar without a blur or shadow mask", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "globals.css"), "utf8");
    const marker = "/* Mobile: the header must blend with the page";
    const start = css.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const block = css.slice(start, css.indexOf("@media (min-width: 641px)", start));

    expect(block).toContain(".app-title-bar");
    expect(block).toContain("backdrop-filter: none");
    expect(block).toContain("-webkit-backdrop-filter: none");
    expect(block).toContain("box-shadow: none");
    expect(block).toContain("border-bottom: 0");
  });

  it("animates the mobile drawer without applying backdrop blur", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "globals.css"), "utf8");
    const drawerStart = css.indexOf("/* Mobile sidebar: slide in/out as overlay */");
    const drawerBlock = css.slice(drawerStart);
    const closedStart = drawerBlock.indexOf(".sidebar-container.sidebar-closed {");
    const closedRule = drawerBlock.slice(closedStart, drawerBlock.indexOf("}", closedStart) + 1);
    const overlayStart = css.indexOf(".sidebar-overlay-backdrop {");
    const overlayBlock = css.slice(overlayStart, css.indexOf("/* Mobile: the header", overlayStart));

    expect(drawerStart).toBeGreaterThanOrEqual(0);
    expect(drawerBlock).toContain("transform: translate3d(-100%, 0, 0)");
    expect(closedRule).not.toContain("display: none");
    expect(overlayBlock).toContain("backdrop-filter: none");
  });

  it("removes keyboard-only bottom chrome instead of lifting the composer", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "pix-adapter.css"), "utf8");
    const keyboardRule = css.slice(
      css.indexOf('.app-shell[data-visual-keyboard="open"] .chat-composer-region'),
      css.indexOf(".workspace--home", css.indexOf('.app-shell[data-visual-keyboard="open"]')),
    );

    expect(keyboardRule).toContain("padding-bottom: 0");
    expect(keyboardRule).toContain('.app-shell[data-visual-keyboard="open"] .session-info-bar-wrap');
    expect(keyboardRule).toContain("display: none");
  });

  it("does not add a mobile overflow button to session rows", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "pix-adapter.css"), "utf8");
    expect(css).toContain("-webkit-touch-callout: none");
    expect(css).not.toContain("sidebar-session-more");
  });
});
