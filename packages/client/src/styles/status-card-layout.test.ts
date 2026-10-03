/** @vitest-environment node */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("status card responsive layout", () => {
  it("keeps the expanded status card floating without shifting the transcript", () => {
    const stylesDir = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(stylesDir, "globals.css"), "utf8");
    const shell = readFileSync(join(stylesDir, "../components/shell/AppShell.tsx"), "utf8");

    expect(css).not.toContain("translateX(-168px)");
    expect(css).not.toContain("workspace--status-present");
    expect(shell).not.toContain("workspace--status-present");
    expect(shell).not.toContain("workspace--status-panel-shift");
  });

  it("uses the named conversation container instead of viewport JavaScript", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const css = readFileSync(join(root, "styles/globals.css"), "utf8");
    const shell = readFileSync(join(root, "components/shell/AppShell.tsx"), "utf8");

    expect(css).toContain("container-name: conversation");
    expect(css).toContain("container-type: inline-size");
    expect(shell).toContain('className="conversation-container"');
    expect(shell).toContain("key={activeSessionId}");
    expect(shell).not.toContain("ResizeObserver");
  });
});
