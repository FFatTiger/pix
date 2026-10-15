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
    // The tab grows into the card: same spot and material, open bottom; the
    // closed clip is the tab footprint (measured width), the open clip is full.
    expect(rule(css, ".status-card-panel")).toContain("bottom: 0");
    // Panel and capsule share the shell's left edge, so the card grows out
    // of the tab without a horizontal jump.
    expect(rule(css, ".status-card-panel")).toContain("left: 0");
    expect(rule(css, ".status-card-panel")).toContain("border-bottom: 0");
    expect(rule(css, ".status-card-panel")).toContain("border-radius: 10px 10px 0 0");
    expect(rule(css, ".status-card-panel")).toContain("background: var(--bg-secondary)");
    expect(rule(css, ".status-card-panel")).toContain("clip-path: inset(calc(100% - 28px) calc(100% - var(--status-tab-width, 120px)) 0 0");
    expect(rule(css, '.subagent-activity-card[data-open="true"] .status-card-panel')).toContain("clip-path: inset(0 0 0 0");
    expect(rule(css, '.subagent-activity-card[data-open="true"] .subagent-activity-capsule')).toContain("opacity: 0");
    expect(card).toContain("--status-tab-width");
    expect(card).toContain("status-card-header");
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
    expect(rule(css, ".subagent-activity-capsule")).toContain("height: 28px");
    expect(rule(css, ".subagent-activity-capsule")).toContain("border-radius: 10px 10px 0 0");
    expect(rule(css, ".subagent-activity-capsule")).toContain("border-bottom: 0");
    expect(rule(css, ".subagent-activity-capsule")).toContain("border: 1px solid var(--border)");
    expect(rule(css, ".subagent-activity-capsule")).toContain("background: var(--bg-secondary)");
    expect(rule(css, ".subagent-activity-capsule")).toContain("box-shadow: 0 -3px 8px -4px");
    expect(rule(css, ".subagent-activity-capsule")).toContain("margin-left: 0");
    // The tab sits inset on the composer's straight top edge (past the 12px
    // corner plus the 8px fillet) and fillets on both sides; the composer
    // keeps all four rounded corners.
    expect(rule(css, ".subagent-activity-capsule::before,\n.subagent-activity-capsule::after")).toBeDefined();
    expect(rule(css, ".status-card-shell")).toContain("margin-left: 20px");
    expect(css).not.toContain("border-top-left-radius: 0");
    // Rest / hover / focus all come from the composer variables, so the tab
    // never paints its own fill or focus color.
    expect(rule(css, ".subagent-activity-capsule,\n.subagent-activity-capsule:hover")).toContain("background: var(--composer-bg)");
    expect(rule(css, ".subagent-activity-capsule,\n.subagent-activity-capsule:hover")).toContain("border-color: var(--composer-ring)");
    // Focus: the ring is a border (not an outer box-shadow), so the tab, which
    // overlaps the shell's top border by 1px, hides it exactly at the seam.
    expect(css).toContain(".chat-input-shell:focus-within,\n.chat-input-shell.is-streaming:focus-within {\n  border-color: var(--composer-ring);\n  box-shadow: 0 8px 28px -12px");
    // Long titles ellipsize inside the label span.
    expect(rule(css, ".status-capsule-label")).toContain("text-overflow: ellipsis");
    expect(rule(css, ".status-capsule-count,\n.status-capsule-agents,\n.status-capsule-queue")).toContain("font-variant-numeric: tabular-nums");
    expect(card).toContain("status-capsule-count");
    expect(card).toContain("status-capsule-agents");
    expect(card).toContain("status-capsule-queue");
    // Mounted directly above the composer inside the session column.
    expect(shell.indexOf("<SubagentActivityCard")).toBeGreaterThan(shell.indexOf("<Composer"));
    expect(shell).toContain("key={`status:${viewSessionId}`}");
  });

  it("reserves the composer's top-right floating controls so the pill never overlaps them", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const css = readFileSync(join(root, "styles/globals.css"), "utf8");
    const chatInput = readFileSync(join(root, "components/chat/ChatInput.tsx"), "utf8");

    // One shared variable sizes the reserve (footprint derivation lives next
    // to its definition); the pill row consumes exactly that variable.
    expect(css).toContain("--composer-floating-controls-reserve: 72px");
    expect(rule(css, ".status-card-shell")).toContain("padding-right: var(--composer-floating-controls-reserve)");
    // The floating group really sits at the composer's top-right (ChatInput),
    // so the reserve is the single knob keeping the two apart.
    expect(chatInput).toContain("top: -22");
    expect(chatInput).toContain("right: isMobile ? 12 : 20");
    // Attachment previews render inside the input box, so nothing can sit
    // between the status tab and the composer top edge.
    expect(chatInput.indexOf('className="chat-input-attachments"')).toBeGreaterThan(chatInput.indexOf("ref={inputShellRef}"));
    // The pill itself can only shrink within the reserved row.
    expect(rule(css, ".subagent-activity-capsule")).toContain("max-width: 100%");
  });

  it("caps the mobile card at min(340px, viewport - 92px)", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const css = readFileSync(join(root, "styles/globals.css"), "utf8");
    const mobileStart = css.indexOf("@media (max-width: 640px)", css.indexOf(".subagent-transcript"));
    expect(mobileStart).toBeGreaterThanOrEqual(0);
    const mobile = css.slice(mobileStart, css.indexOf("}", css.indexOf(".status-card-panel", mobileStart)) + 1);
    expect(rule(mobile, ".status-card-panel")).toContain("width: min(340px, calc(100vw - 92px))");
    expect(rule(mobile, ".status-card-panel")).toContain("max-width: calc(100vw - 92px)");
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
    expect(shell).toMatch(/\{isMobile \? \(\s*<div className="right-pane-selector-wrap">/);
    expect(shell.replace(/\r\n/g, "\n")).toContain("{isMobile ? (\n        <div\n          style={{\n            position: \"absolute\",");
    expect(shell.match(/<RightPaneToggle/g)?.length).toBe(1);
  });
});
