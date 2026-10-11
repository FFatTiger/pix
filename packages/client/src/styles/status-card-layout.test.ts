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

  it("keeps the floating popup below Ask and workspace overlays", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const css = readFileSync(join(root, "styles/globals.css"), "utf8");
    const askCss = readFileSync(join(root, "components/chat/ExtensionQuestionnaire.css"), "utf8");
    const layer = (body: string): number => Number(body.match(/z-index:\s*(\d+)/)?.[1]);

    // Overlay sits in the conversation host; header/title-bar must not raise it.
    expect(rule(css, ".app-title-bar")).not.toContain("z-index");
    expect(rule(css, ".subagent-activity-card")).toContain("z-index: 30");
    expect(rule(css, ".subagent-activity-card")).toContain("pointer-events: none");
    expect(rule(css, ".status-card-shell")).toContain("pointer-events: auto");
    expect(layer(rule(css, ".subagent-activity-card"))).toBeLessThan(layer(rule(askCss, ".questionnaire-overlay")));
    const tablet = css.slice(css.indexOf("@media (min-width: 641px) and (max-width: 959px)"));
    expect(layer(rule(tablet, ".right-panel-container.right-panel-open"))).toBeGreaterThan(layer(rule(css, ".subagent-activity-card")));
  });

  it("uses the named conversation container instead of viewport JavaScript", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const css = readFileSync(join(root, "styles/globals.css"), "utf8");
    const adapter = readFileSync(join(root, "styles/pix-adapter.css"), "utf8");
    const shell = readFileSync(join(root, "components/shell/AppShell.tsx"), "utf8");
    const titleBar = readFileSync(join(root, "components/shell/AppTitleBar.tsx"), "utf8");
    const card = readFileSync(join(root, "components/chat/SubagentActivityCard.tsx"), "utf8");
    const conversationOpen = shell.indexOf('className="conversation-container"');
    const cardOpen = shell.indexOf("<SubagentActivityCard");

    expect(css).toContain("container-name: conversation");
    expect(css).toContain("container-type: inline-size");
    expect(shell).toContain('className="conversation-container"');
    expect(shell).toContain("key={activeSessionId}");
    expect(shell).not.toContain("ResizeObserver");
    expect(titleBar).not.toContain("trailing?: ReactNode");
    expect(titleBar).not.toContain("app-title-trailing");
    expect(css).not.toContain(".app-title-trailing");
    expect(shell).not.toContain("trailing={");
    expect(rule(css, ".subagent-activity-card")).toContain("position: absolute");
    expect(cardOpen).toBeGreaterThan(conversationOpen);
    expect(rule(css, ".subagent-activity-card")).toContain("top: 44px");
    expect(rule(css, ".subagent-activity-card")).toContain("right: 56px");
    const mobileStart = css.indexOf("@media (max-width: 640px)", css.indexOf(".subagent-transcript"));
    const mobile = css.slice(mobileStart, css.indexOf("}", css.indexOf(".status-card-panel", mobileStart)) + 1);
    expect(rule(mobile, ".subagent-activity-card")).toContain("right: 12px");
    expect(titleBar).toContain("paddingRight: 36");
    expect(css).not.toMatch(/@container conversation \(min-width: 1280px\)/);
    expect(card).not.toContain('"auto"');
    expect(css).toContain("top: calc(100% + 6px)");
    expect(css).toContain("max-height: min(64dvh, 32rem)");
    expect(rule(css, ".status-card-panel")).toContain("width: 280px");
    expect(rule(css, ".status-card-panel")).toContain("visibility 0s linear 160ms");
    expect(rule(css, '.subagent-activity-card[data-display-mode="panel"] .status-card-panel')).toContain("opacity: 1");
    expect(rule(css, ".subagent-activity-capsule")).toContain("max-width: 220px");
    expect(rule(css, ".subagent-activity-capsule")).toContain("border-radius: 999px");
    expect(css).not.toContain("data-display-mode=\"auto\"");
    expect(css).toContain(".right-pane-selector {");
    expect(css).toContain("padding: 0 40px 0 8px");
    expect(css).toContain(".right-pane-selector button {");
    expect(rule(css, ".right-pane-selector button")).toContain("flex: 1");
    expect(rule(css, ".right-pane-selector button")).toContain("border-radius: 0");
    expect(rule(css, ".right-pane-selector button")).not.toContain("border-radius: 999px");
    expect(css).toContain("border-bottom-color: color-mix(in srgb, var(--text) 28%, transparent)");
    expect(adapter).not.toContain("right: 38px");
    expect(adapter).toContain(".explorer-panel .sidebar-section-head {");
    expect(rule(adapter, ".explorer-panel .sidebar-section-head")).toContain("height: 28px");
    expect(rule(adapter, ".explorer-panel .sidebar-section-actions")).toContain("position: static");
  });
});
