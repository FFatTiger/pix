/** @vitest-environment node */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesDir = dirname(fileURLToPath(import.meta.url));

function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = css.indexOf("}", start);
  expect(end).toBeGreaterThan(start);
  return css.slice(start, end + 1);
}

describe("message hover chrome ownership and accessibility", () => {
  it("lives in globals, reveals on keyboard focus, and stays out of pix adapter overrides", () => {
    const globals = readFileSync(join(stylesDir, "globals.css"), "utf8");
    const adapter = readFileSync(join(stylesDir, "pix-adapter.css"), "utf8");

    expect(globals).toContain(".chat-message-hover-actions,");
    expect(globals).toContain(".chat-user-message:focus-within .chat-message-hover-actions");
    expect(globals).toContain(".chat-user-message:focus-within .chat-message-time");
    expect(globals).toContain(".chat-assistant-message:focus-within .chat-message-time");
    expect(globals).toContain("@media (hover: none)");
    expect(adapter).not.toContain(".chat-message-hover-actions");
    expect(adapter).not.toContain(".chat-message-time");
  });

  it("keeps process disclosure carets hidden until pointer hover or keyboard focus", () => {
    const globals = readFileSync(join(stylesDir, "globals.css"), "utf8");
    const processCaret = rule(globals, String.raw`.group\/process .process-group-caret`);
    const toolCaret = rule(globals, String.raw`.group\/process .codex-tool-caret`);

    expect(processCaret).toContain("opacity: 0;");
    expect(globals).toContain(".group\\/summary:hover .process-group-caret,");
    expect(globals).toContain(".group\\/summary:focus-visible .process-group-caret {");
    expect(toolCaret).toContain("opacity: 0;");
    expect(globals).toContain(".codex-tool-group-trigger:hover .codex-tool-caret,");
    expect(globals).toContain(".codex-tool-row-trigger:focus-visible .codex-tool-caret {");
  });

  it("does not locally retune Codex narrative typography or tool emphasis", () => {
    const globals = readFileSync(join(stylesDir, "globals.css"), "utf8");
    const adapter = readFileSync(join(stylesDir, "pix-adapter.css"), "utf8");
    const shell = rule(globals, String.raw`.group\/process.process-group-shell--codex`);
    const markdown = rule(globals, ".markdown-body");
    const trigger = rule(globals, String.raw`.group\/process .codex-tool-group-trigger,
.group\/process .codex-tool-row-trigger`);
    const icon = rule(globals, String.raw`.group\/process .codex-tool-icon`);

    expect(shell).not.toContain("font-family:");
    expect(globals).not.toContain(String.raw`.group\/process .codex-process-narrative`);
    expect(markdown).not.toContain("font-family:");
    expect(markdown).toContain("font-size: 14px;");
    expect(markdown).toContain("font-weight: var(--text-weight-regular);");
    expect(markdown).toContain("line-height: 1.72;");
    expect(trigger).toContain("color: var(--text-dim);");
    expect(trigger).not.toContain("font-weight:");
    expect(icon).toContain("color: var(--text-dim);");
    expect(globals).not.toContain(".codex-process-narrative");
    expect(adapter).not.toContain(".codex-process-narrative");
    expect(adapter).not.toContain(".codex-tool-group-trigger");
  });

  it("owns one global system-font weight scale without adapter overrides", () => {
    const globals = readFileSync(join(stylesDir, "globals.css"), "utf8");
    const adapter = readFileSync(join(stylesDir, "pix-adapter.css"), "utf8");
    const main = readFileSync(join(stylesDir, "..", "main.tsx"), "utf8");
    const packageJson = readFileSync(join(stylesDir, "..", "..", "package.json"), "utf8");
    const theme = rule(globals, "@theme");
    const root = rule(globals, ":root");
    const document = rule(globals, "html, body");

    expect(root).toContain('--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;');
    expect(root).toContain("--text-weight-regular: 500;");
    expect(root).toContain("--text-weight-medium: 600;");
    expect(root).toContain("--text-weight-strong: 700;");
    expect(theme).toContain("--font-weight-normal: var(--text-weight-regular);");
    expect(theme).toContain("--font-weight-medium: var(--text-weight-medium);");
    expect(theme).toContain("--font-weight-semibold: var(--text-weight-strong);");
    expect(theme).toContain("--font-weight-bold: var(--text-weight-strong);");
    expect(document).toContain("font-family: var(--font-sans);");
    expect(document).toContain("font-weight: var(--text-weight-regular);");
    expect(adapter).not.toContain("--font-sans:");
    expect(main).not.toContain("ia-writer-quattro");
    expect(packageJson).not.toContain("ia-writer-quattro");
    expect(globals).not.toMatch(/font-weight:\s*(?:400|500|600|650|700);/);
    expect(adapter).not.toMatch(/font-weight:\s*(?:400|500|600|650|700);/);
  });

  it("owns interruptible disclosure motion and a bounded scroll region for Codex groups", () => {
    const globals = readFileSync(join(stylesDir, "globals.css"), "utf8");
    const collapse = rule(globals, String.raw`.group\/process .disclosure-collapse`);
    const scrollRegion = rule(globals, String.raw`.group\/process .codex-tool-group-scroll`);

    expect(collapse).toContain("grid-template-rows: 0fr;");
    expect(collapse).toContain("grid-template-rows 180ms cubic-bezier(0.23, 1, 0.32, 1)");
    expect(collapse).not.toContain("transition: all");
    expect(globals).toContain('.disclosure-collapse[data-state="open"] {');
    expect(scrollRegion).toContain("max-height: min(320px, 42vh);");
    expect(scrollRegion).toContain("overflow-y: auto;");
    expect(scrollRegion).toContain("overscroll-behavior: contain;");
    expect(globals).toContain("@media (prefers-reduced-motion: reduce)");
    expect(globals).toContain(".group\\/process .disclosure-collapse,");
  });

  it("keeps every process title on one line and fades only its trailing edge", () => {
    const globals = readFileSync(join(stylesDir, "globals.css"), "utf8");
    const outer = rule(globals, String.raw`.group\/process .process-group-summary-label`);
    const labels = rule(globals, String.raw`.group\/process .codex-tool-group-label,
.group\/process .codex-tool-row-label`);
    const thinking = rule(globals, String.raw`.group\/process .codex-thinking-status-label`);

    for (const title of [outer, labels, thinking]) {
      expect(title).toContain("white-space: nowrap;");
      expect(title).toContain("overflow: hidden;");
      expect(title).toContain("mask-image: linear-gradient(to right");
      expect(title).not.toContain("text-overflow: ellipsis;");
    }
    expect(globals).not.toContain(".codex-tool-group.is-command-group .codex-tool-group-label");
  });
});
