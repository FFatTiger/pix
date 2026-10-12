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

describe("status card composer-strip layout", () => {
  it("keeps the expanded status card from shifting the transcript", () => {
    const stylesDir = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(stylesDir, "globals.css"), "utf8");
    const shell = readFileSync(join(stylesDir, "../components/shell/AppShell.tsx"), "utf8");

    expect(css).not.toContain("translateX(-168px)");
    expect(css).not.toContain("workspace--status-present");
    expect(shell).not.toContain("workspace--status-present");
    expect(shell).not.toContain("workspace--status-panel-shift");
    expect(css).not.toContain("calc(100% - 306px)");
  });

  it("keeps the expanded card below Ask and workspace overlays", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const css = readFileSync(join(root, "styles/globals.css"), "utf8");
    const askCss = readFileSync(join(root, "components/chat/ExtensionQuestionnaire.css"), "utf8");
    const layer = (body: string): number => Number(body.match(/z-index:\s*(\d+)/)?.[1]);

    // Overlay sits in the conversation host; header/title-bar must not raise it.
    expect(rule(css, ".app-title-bar")).not.toContain("z-index");
    expect(rule(css, ".subagent-activity-card")).toContain("z-index: 30");
    expect(layer(rule(css, ".subagent-activity-card"))).toBeLessThan(layer(rule(askCss, ".questionnaire-overlay")));
    const tablet = css.slice(css.indexOf("@media (min-width: 641px) and (max-width: 959px)"));
    expect(layer(rule(tablet, ".right-panel-container.right-panel-open"))).toBeGreaterThan(layer(rule(css, ".subagent-activity-card")));
  });

  it("anchors the strip to the composer column and opens the card upward", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const css = readFileSync(join(root, "styles/globals.css"), "utf8");
    const shell = readFileSync(join(root, "components/shell/AppShell.tsx"), "utf8");
    const card = readFileSync(join(root, "components/chat/SubagentActivityCard.tsx"), "utf8");

    // Strip: in-flow above the composer, aligned to its 820px content column.
    expect(rule(css, ".subagent-activity-card")).toContain("position: relative");
    expect(rule(css, ".subagent-activity-card")).toContain("max-width: 852px");
    expect(rule(css, ".subagent-activity-card")).toContain("margin: 0 auto -6px");
    expect(rule(css, ".subagent-activity-card")).toContain("padding: 0 16px");
    // Card expands upward from the strip, never downward over the composer.
    expect(rule(css, ".status-card-panel")).toContain("bottom: calc(100% + 6px)");
    expect(rule(css, ".status-card-panel")).toContain("left: 0");
    expect(rule(css, ".status-card-panel")).toContain("transform-origin: bottom left");
    expect(rule(css, ".status-card-panel")).toContain("max-height: min(64dvh, 32rem)");
    expect(rule(css, '.subagent-activity-card[data-open="true"] .status-card-panel')).toContain("opacity: 1");
    expect(css).not.toContain('data-display-mode="panel"');
    // Expansion is transient internal state: no persisted display mode remains.
    expect(shell).not.toContain("statusCardDisplayMode");
    expect(shell).not.toContain("StatusCardDisplayMode");
    expect(card).not.toContain("displayMode");
    // Capsule spans the strip width and carries the completion/agent counts.
    expect(rule(css, ".subagent-activity-capsule")).toContain("width: 100%");
    expect(rule(css, ".subagent-activity-capsule")).not.toContain("max-width: 220px");
    expect(rule(css, ".subagent-activity-capsule")).toContain("border-radius: 8px 8px 0 0");
    expect(rule(css, ".status-capsule-count,\n.status-capsule-agents")).toContain("font-variant-numeric: tabular-nums");
    expect(card).toContain("status-capsule-count");
    expect(card).toContain("status-capsule-agents");
    // Mounted directly above the composer inside the session column.
    expect(shell.indexOf("<SubagentActivityCard")).toBeGreaterThan(shell.indexOf("<Composer"));
    expect(shell).toContain("key={`status:${activeSessionId}`}");
  });

  it("caps the mobile card at min(320px, viewport - 16px)", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const css = readFileSync(join(root, "styles/globals.css"), "utf8");
    const mobileStart = css.indexOf("@media (max-width: 640px)", css.indexOf(".subagent-transcript"));
    expect(mobileStart).toBeGreaterThanOrEqual(0);
    const mobile = css.slice(mobileStart, css.indexOf("}", css.indexOf(".status-card-panel", mobileStart)) + 1);
    expect(rule(mobile, ".status-card-panel")).toContain("width: min(320px, calc(100vw - 16px))");
    expect(rule(mobile, ".status-card-panel")).toContain("max-width: calc(100vw - 16px)");
  });

  it("replaces the desktop pane tabs with the icon rail (mobile keeps tabs)", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const css = readFileSync(join(root, "styles/globals.css"), "utf8");
    const shell = readFileSync(join(root, "components/shell/AppShell.tsx"), "utf8");

    // Desktop rail: vertical icon column with a running-agent badge.
    expect(css).toContain(".right-pane-rail {");
    expect(rule(css, ".right-pane-rail")).toContain("flex-direction: column");
    expect(rule(css, ".right-pane-rail-badge")).toContain("border-radius: 999px");
    expect(shell).toContain('data-testid="right-pane-rail"');
    expect(shell).toContain("right-pane-rail-badge");
    expect(shell).toContain("handleRailSelect");
    // The rail is desktop-only; the tab row and corner toggle stay mobile-only.
    expect(shell).toMatch(/\{isMobile \? \(\s*\n\s*<div className="right-pane-selector-wrap">/);
    expect(shell).toContain("{isMobile ? (\n        <div\n          style={{\n            position: \"absolute\",");
    expect(shell.match(/<RightPaneToggle/g)?.length).toBe(1);
  });
});
