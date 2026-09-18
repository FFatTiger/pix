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
    // Pin/archive buttons have NO resting background of their own: they are
    // plain icons on row hover and only inherit the standard icon-button
    // hover background on direct hover.
    expect(css).not.toMatch(/\.sidebar-row-actions \.sidebar-icon-btn \{[^}]*background/);
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

  it("keeps sidebar copy compact while giving project titles one larger step", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "pix-adapter.css"), "utf8");
    const rows = css.slice(css.indexOf(".sidebar-list-row {"), css.indexOf("/* Liveness", css.indexOf(".sidebar-list-row {")));
    const projects = css.slice(css.indexOf(".sidebar-list-row--project {"), css.indexOf("/* Liveness", css.indexOf(".sidebar-list-row--project {")));

    expect(rows).toContain("font-size: 13px");
    expect(projects).toContain("font-size: 14px");
  });
});
