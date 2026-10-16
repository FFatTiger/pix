import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/hooks/useI18n";
import type { TurnFileRow } from "@/lib/turn-written-files";
import { shownFileParentLabel, TurnWrittenFiles } from "./TurnWrittenFiles";

function mount(files: TurnFileRow[], onOpenFile = vi.fn(), cwd = "/proj") {
  render(
    <I18nProvider>
      <TurnWrittenFiles files={files} onOpenFile={onOpenFile} sessionId="s-1" cwd={cwd} />
    </I18nProvider>,
  );
  return onOpenFile;
}

describe("TurnWrittenFiles", () => {
  it("puts shown images in an album and other shown files in a list above written chips", () => {
    mount([
      { source: "written", filePath: "/proj/a.ts", additions: 2 },
      { source: "shown", filePath: "/proj/shot.png", kind: "image" },
      { source: "shown", filePath: "/proj/src/notes.md", kind: "file" },
    ]);
    const image = screen.getByRole("button", { name: "Open shot.png" });
    expect(image.className).toContain("turn-shown-shot");
    expect(image.querySelector("img")?.getAttribute("src")).toBe("/v1/files?path=%2Fproj%2Fshot.png&op=read&sessionId=s-1");
    const file = screen.getByRole("button", { name: "Open notes.md" });
    expect(file.className).toContain("turn-shown-row");
    expect(file.querySelector("img")).toBeNull();
    expect(file.textContent).toContain("notes.md");
    expect(file.querySelector(".turn-shown-dir")?.textContent).toBe("src");
    const shown = document.querySelector(".turn-shown-files");
    const written = screen.getByRole("button", { name: "Open a.ts" });
    expect(shown).toBeTruthy();
    expect(shown!.compareDocumentPosition(written) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("labels a cwd-root file ./ and shortens a parent outside the cwd", () => {
    expect(shownFileParentLabel("/proj/a.ts", "/proj")).toBe("./");
    expect(shownFileParentLabel("/proj/src/lib/a.ts", "/proj")).toBe("src/lib");
    vi.stubEnv("HOME", "/Users/me");
    expect(shownFileParentLabel("/Users/me/notes/a.ts", "/proj")).toBe("~/notes");
    vi.unstubAllEnvs();
  });

  it("opens a shown file without a diff and a written file as a diff", () => {
    const onOpenFile = mount([
      { source: "written", filePath: "/proj/a.ts", additions: 2 },
      { source: "shown", filePath: "/proj/shot.png", kind: "image" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Open a.ts" }));
    fireEvent.click(screen.getByRole("button", { name: "Open shot.png" }));
    expect(onOpenFile).toHaveBeenNthCalledWith(1, "/proj/a.ts", { source: "turn-files", initialDisplayMode: "diff" });
    expect(onOpenFile).toHaveBeenNthCalledWith(2, "/proj/shot.png", { source: "turn-files" });
  });
});
