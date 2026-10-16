import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/hooks/useI18n";
import type { TurnFileRow } from "@/lib/turn-written-files";
import { TurnWrittenFiles } from "./TurnWrittenFiles";

function mount(files: TurnFileRow[], onOpenFile = vi.fn()) {
  render(
    <I18nProvider>
      <TurnWrittenFiles files={files} onOpenFile={onOpenFile} sessionId="s-1" />
    </I18nProvider>,
  );
  return onOpenFile;
}

describe("TurnWrittenFiles", () => {
  it("renders an image thumbnail from the files read URL and a chip for other files", () => {
    mount([
      { source: "shown", filePath: "/x/shot.png", kind: "image" },
      { source: "shown", filePath: "/x/notes.md", kind: "file" },
    ]);
    const image = screen.getByRole("button", { name: "Open shot.png" }).querySelector("img");
    expect(image?.getAttribute("src")).toBe("/v1/files?path=%2Fx%2Fshot.png&op=read&sessionId=s-1");
    expect(image?.style.height).toBe("64px");
    expect(screen.getByRole("button", { name: "Open notes.md" }).querySelector("img")).toBeNull();
  });

  it("opens a shown file in the right pane and a written file as a diff", () => {
    const onOpenFile = mount([
      { source: "written", filePath: "/x/a.ts", additions: 2 },
      { source: "shown", filePath: "/x/shot.png", kind: "image" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Open a.ts" }));
    fireEvent.click(screen.getByRole("button", { name: "Open shot.png" }));
    expect(onOpenFile).toHaveBeenNthCalledWith(1, "/x/a.ts", { source: "turn-files", initialDisplayMode: "diff" });
    expect(onOpenFile).toHaveBeenNthCalledWith(2, "/x/shot.png", { source: "turn-files" });
  });
});
