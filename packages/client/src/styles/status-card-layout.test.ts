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

describe("status card responsive layout", () => {
  it("keeps the expanded status card floating without shifting the transcript", () => {
    const stylesDir = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(stylesDir, "globals.css"), "utf8");
    const shell = readFileSync(join(stylesDir, "../components/shell/AppShell.tsx"), "utf8");

    expect(css).not.toContain("translateX(-168px)");
    expect(css).not.toContain("workspace--status-present");
    expect(shell).not.toContain("workspace--status-present");
    expect(shell).not.toContain("workspace--status-panel-shift");
    expect(css).not.toContain("calc(100% - 306px)");
  });

  it("keeps the title-bar popup below Ask and workspace overlays", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const css = readFileSync(join(root, "styles/globals.css"), "utf8");
    const askCss = readFileSync(join(root, "components/chat/ExtensionQuestionnaire.css"), "utf8");
    const layer = (body: string): number => Number(body.match(/z-index:\s*(\d+)/)?.[1]);

    // A raised header would trap its entire popup above the modal and tablet tabs.
    expect(rule(css, ".app-title-bar")).not.toContain("z-index");
    expect(layer(rule(css, ".subagent-activity-card"))).toBeLessThan(layer(rule(askCss, ".questionnaire-overlay")));
    const tablet = css.slice(css.indexOf("@media (min-width: 641px) and (max-width: 959px)"));
    expect(layer(rule(tablet, ".right-panel-container.right-panel-open"))).toBeGreaterThan(layer(rule(css, ".subagent-activity-card")));
  });

  it("uses the named conversation container instead of viewport JavaScript", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const css = readFileSync(join(root, "styles/globals.css"), "utf8");
    const shell = readFileSync(join(root, "components/shell/AppShell.tsx"), "utf8");
    const titleBar = readFileSync(join(root, "components/shell/AppTitleBar.tsx"), "utf8");
    const card = readFileSync(join(root, "components/chat/SubagentActivityCard.tsx"), "utf8");

    expect(css).toContain("container-name: conversation");
    expect(css).toContain("container-type: inline-size");
    expect(shell).toContain('className="conversation-container"');
    expect(shell).toContain("key={activeSessionId}");
    expect(shell).not.toContain("ResizeObserver");
    expect(titleBar).toContain("trailing?: ReactNode");
    expect(shell).toContain("trailing={activeSessionId === null ? undefined : (");
    expect(shell).toContain("<SubagentActivityCard");
    expect(css).not.toMatch(/@container conversation \(min-width: 1280px\)/);
    expect(card).not.toContain('"auto"');
    expect(css).toContain("top: calc(100% + 6px)");
    expect(css).toContain("max-height: min(64dvh, 32rem)");
    expect(rule(css, ".status-card-panel")).toContain("width: 280px");
    expect(rule(css, ".subagent-activity-capsule")).toContain("max-width: 220px");
    expect(css).not.toContain("data-display-mode=\"auto\"");
  });
});
