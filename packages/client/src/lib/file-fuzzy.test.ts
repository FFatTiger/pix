import { describe, expect, it } from "vitest";
import { buildAtMentionText, buildFileAtMentionsText, filterFileEntries } from "./file-fuzzy";

describe("buildAtMentionText / buildFileAtMentionsText — source lib/file-fuzzy.test.mjs", () => {
  it("builds closed file mentions and quotes paths containing spaces", () => {
    expect(buildAtMentionText("notes/todo.md", false)).toBe("@notes/todo.md ");
    expect(buildAtMentionText("project files/design brief.md", false)).toBe('@"project files/design brief.md" ');
    expect(
      buildFileAtMentionsText(["notes/todo.md", "project files/design brief.md"]),
    ).toBe('@notes/todo.md @"project files/design brief.md" ');
  });

  it("folds case only when the Host path flavor says so", () => {
    const entries = [{ path: "src/ChatInput.tsx", isDir: false }];
    expect(filterFileEntries(entries, "chatinput", 20, true).map((e) => e.path)).toEqual(["src/ChatInput.tsx"]);
    expect(filterFileEntries(entries, "chatinput", 20, false)).toEqual([]);
    expect(filterFileEntries(entries, "ChatInput", 20, false).map((e) => e.path)).toEqual(["src/ChatInput.tsx"]);
  });
});
