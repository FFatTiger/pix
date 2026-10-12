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

  it("anchors the pill row to the composer column and opens the card upward", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const css = readFileSync(join(root, "styles/globals.css"), "utf8");
    const shell = readFileSync(join(root, "components/shell/AppShell.tsx"), "utf8");
    const card = readFileSync(join(root, "components/chat/SubagentActivityCard.tsx"), "utf8");

    // Row: in-flow above the composer, aligned to its 820px content column;
    // the tab overlaps the composer's top border by exactly 1px.
    expect(rule(css, ".subagent-activity-card")).toContain("position: relative");
    expect(rule(css, ".subagent-activity-card")).toContain("max-width: 852px");
    expect(rule(css, ".subagent-activity-card")).toContain("margin: 0 auto -1px");
    expect(rule(css, ".subagent-activity-card")).toContain("padding: 0 16px;");
    // Card grows up out of the tab (joined along the tab top, same surface),
    // never downward over the composer.
    expect(rule(css, ".status-card-panel")).toContain("bottom: calc(100% - 1px)");
    expect(rule(css, ".status-card-panel")).toContain("left: 12px");
    expect(rule(css, ".status-card-panel")).toContain("border-radius: 10px 10px 10px 0");
    expect(rule(css, ".status-card-panel")).toContain("background: var(--bg-secondary)");
    expect(rule(css, '.subagent-activity-card[data-open="true"] .subagent-activity-capsule')).toContain("border-top-color: transparent");
    expect(rule(css, '.subagent-activity-card[data-open="true"] .status-capsule-joint')).toContain("radial-gradient");
    expect(card).toContain("status-capsule-joint");
    expect(rule(css, ".status-card-panel")).toContain("transform-origin: bottom left");
    expect(rule(css, ".status-card-panel")).toContain("max-height: min(64dvh, 32rem)");
    expect(rule(css, '.subagent-activity-card[data-open="true"] .status-card-panel')).toContain("opacity: 1");
    expect(css).not.toContain('data-display-mode="panel"');
    // Expansion is transient internal state: no persisted display mode remains.
    expect(shell).not.toContain("statusCardDisplayMode");
    expect(shell).not.toContain("StatusCardDisplayMode");
    expect(card).not.toContain("displayMode");
    // Capsule: content-width tab growing out of the composer — composer
    // surface and border, rounded top corners, open bottom, concave fillets,
    // a soft upward shadow, and it follows the composer's focus border.
    expect(rule(css, ".subagent-activity-capsule")).not.toMatch(/^\s*width: 100%;/m);
    expect(rule(css, ".subagent-activity-capsule")).toContain("min-height: 28px");
    expect(rule(css, ".subagent-activity-capsule")).toContain("border-radius: 10px 10px 0 0");
    expect(rule(css, ".subagent-activity-capsule")).toContain("border-bottom: 0");
    expect(rule(css, ".subagent-activity-capsule")).toContain("border: 1px solid var(--border)");
    expect(rule(css, ".subagent-activity-capsule")).toContain("background: var(--bg-secondary)");
    expect(rule(css, ".subagent-activity-capsule")).toContain("box-shadow: 0 -3px 8px -4px");
    expect(css).toContain(".subagent-activity-capsule::before,\n.subagent-activity-capsule::after {");
    expect(rule(css, ".workspace:has(.chat-input-shell:focus-within) .subagent-activity-capsule")).toContain("border-color: var(--accent-blue)");
    expect(rule(css, ".subagent-activity-capsule:hover")).toContain("background: var(--bg-secondary)");
    // Long titles ellipsize inside the label span.
    expect(rule(css, ".status-capsule-label")).toContain("text-overflow: ellipsis");
    expect(rule(css, ".status-capsule-count,\n.status-capsule-agents")).toContain("font-variant-numeric: tabular-nums");
    expect(card).toContain("status-capsule-count");
    expect(card).toContain("status-capsule-agents");
    // Mounted directly above the composer inside the session column.
    expect(shell.indexOf("<SubagentActivityCard")).toBeGreaterThan(shell.indexOf("<Composer"));
    expect(shell).toContain("key={`status:${activeSessionId}`}");
  });

  it("reserves the composer's top-right floating controls so the pill never overlaps them", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const css = readFileSync(join(root, "styles/globals.css"), "utf8");
    const chatInput = readFileSync(join(root, "components/chat/ChatInput.tsx"), "utf8");

    // One shared variable sizes the reserve (footprint derivation lives next
    // to its definition); the pill row consumes exactly that variable.
    expect(css).toContain("--composer-floating-controls-reserve: 160px");
    expect(rule(css, ".status-card-shell")).toContain("padding-right: var(--composer-floating-controls-reserve)");
    // The floating group really sits at the composer's top-right (ChatInput),
    // so the reserve is the single knob keeping the two apart.
    expect(chatInput).toContain("top: -22");
    expect(chatInput).toContain("right: isMobile ? 12 : 20");
    // The pill itself can only shrink within the reserved row.
    expect(rule(css, ".subagent-activity-capsule")).toContain("max-width: 100%");
  });

  it("caps the mobile card at min(340px, viewport - 44px)", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const css = readFileSync(join(root, "styles/globals.css"), "utf8");
    const mobileStart = css.indexOf("@media (max-width: 640px)", css.indexOf(".subagent-transcript"));
    expect(mobileStart).toBeGreaterThanOrEqual(0);
    const mobile = css.slice(mobileStart, css.indexOf("}", css.indexOf(".status-card-panel", mobileStart)) + 1);
    expect(rule(mobile, ".status-card-panel")).toContain("width: min(340px, calc(100vw - 44px))");
    expect(rule(mobile, ".status-card-panel")).toContain("max-width: calc(100vw - 44px)");
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
