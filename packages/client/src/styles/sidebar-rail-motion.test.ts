/** @vitest-environment node */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("sidebar rail motion", () => {
  it("keeps row selection and press paint-only: no geometry motion, approved washes", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "pix-adapter.css"), "utf8");
    const listRow = css.slice(css.indexOf(".sidebar-list-row {"), css.indexOf(".sidebar-session-select {"));
    const sessionSelect = css.slice(css.indexOf(".sidebar-session-select {"), css.indexOf(".sidebar-list-row:hover .sidebar-row-title"));
    // High-frequency interactions fade paint properties only: no transforms,
    // no scale press feedback, nothing that moves row geometry.
    expect(listRow).toContain("transition: background-color 150ms ease, color 150ms ease, border-color 150ms ease, box-shadow 150ms ease;");
    expect(listRow).not.toContain("scale(");
    expect(listRow).not.toMatch(/transition:[^;]*\b(width|height|margin|padding|transform)\b/);
    expect(sessionSelect).toContain("transition: none");
    expect(sessionSelect).toContain("transform: none");
    // Neither press rule may move geometry (scoped to the rule body — later
    // unrelated rules may still scale, e.g. the minimap marker).
    expect(css).not.toMatch(/\.sidebar-list-row:active\s*\{[^}]*transform/);
    expect(css).not.toMatch(/\.sidebar-session-select:active\s*\{[^}]*transform/);
    // The 0.5px transparent border keeps the selected hairline from shifting
    // the row; the selected treatment is a raised surface-content card.
    expect(listRow).toContain("border: 0.5px solid transparent");
    expect(css).toContain('.sidebar-list-row[data-active="true"] {\n  background: var(--surface-content);');
    expect(css).toMatch(/\.sidebar-list-row:hover \{\s*\n?\s*background: color-mix\(in srgb, var\(--text\) 5%, transparent\)/);
    expect(css).toMatch(/\.sidebar-list-row:active \{\s*\n?\s*background: color-mix\(in srgb, var\(--text\) 8%, transparent\)/);
    // Hover swaps the trailing marker for the row actions (CSS only).
    expect(css).toContain(".sidebar-list-row:hover .sidebar-row-trailing > *");
    // Pin/archive buttons have NO resting background of their own: they are
    // plain icons on row hover and only inherit the standard icon-button
    // hover background on direct hover.
    expect(css).not.toMatch(/\.sidebar-row-actions \.sidebar-icon-btn \{[^}]*background/);
  });

  it("crossfades the busy marker and compact time in one trailing cell", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "pix-adapter.css"), "utf8");
    const trailing = css.slice(css.indexOf(".sidebar-row-trailing {"), css.indexOf(".sidebar-list-row:hover .sidebar-row-title"));
    expect(trailing).toContain("display: grid");
    expect(trailing).toContain("grid-area: 1 / 1");
    expect(trailing).toContain('.sidebar-row-trailing-status[data-on="true"]');
    // Compact time: 11px tabular numerals, no uppercase/letter-spacing.
    const meta = css.slice(css.indexOf(".sidebar-row-meta {"), css.indexOf("/* Trailing slot"));
    expect(meta).toContain("font-size: 11px");
    expect(meta).toContain("font-variant-numeric: tabular-nums");
    expect(meta).not.toContain("text-transform");
    expect(meta).not.toContain("letter-spacing");
  });

  it("animates disclosure height via grid rows, disabled under reduced motion", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "pix-adapter.css"), "utf8");
    const disclosure = css.slice(css.indexOf(".sidebar-project-sessions {"), css.indexOf(".sidebar-files {"));
    expect(disclosure).toContain("grid-template-rows: 1fr");
    expect(disclosure).toContain("grid-template-rows: 0fr");
    expect(disclosure).not.toContain("max-height");
    expect(disclosure).toContain("transition: grid-template-rows 200ms ease");
    // Fresh rows reuse the same grow-in keyframes.
    expect(disclosure).toContain("animation: sidebar-disclosure-grow 200ms ease forwards");
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain(".sidebar-project-sessions[data-motion=\"open\"]");
    expect(reduced).toContain(".sidebar-row-fresh");
  });

  it("aligns nested session titles with the project title", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "pix-adapter.css"), "utf8");
    const projectSessions = css.slice(
      css.indexOf(".sidebar-project-sessions {"),
      css.indexOf(".sidebar-files {"),
    );

    // Project title: 10px row inset + 16px icon + 8px gap = 34px.
    // Nested session title: 24px parent inset + 10px row inset = 34px.
    expect(projectSessions).toContain("padding: 2px 0 8px 24px;");
  });

  it("keeps every row at the same compact copy size", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "pix-adapter.css"), "utf8");
    const rows = css.slice(css.indexOf(".sidebar-list-row {"), css.indexOf("/* Liveness", css.indexOf(".sidebar-list-row {")));
    const projects = css.slice(css.indexOf(".sidebar-list-row--project {"), css.indexOf("/* Liveness", css.indexOf(".sidebar-list-row--project {")));

    expect(rows).toContain("font-size: 13px");
    expect(projects).not.toContain("font-size: 14px");
  });
});
