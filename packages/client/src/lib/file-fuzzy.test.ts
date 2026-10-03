import { describe, expect, it } from "vitest";
import { buildAtMentionText, buildFileAtMentionsText } from "./file-fuzzy";

describe("buildAtMentionText / buildFileAtMentionsText — source lib/file-fuzzy.test.mjs", () => {
  it("builds closed file mentions and quotes paths containing spaces", () => {
    expect(buildAtMentionText("notes/todo.md", false)).toBe("@notes/todo.md ");
    expect(buildAtMentionText("project files/design brief.md", false)).toBe('@"project files/design brief.md" ');
    expect(
      buildFileAtMentionsText(["notes/todo.md", "project files/design brief.md"]),
    ).toBe('@notes/todo.md @"project files/design brief.md" ');
  });

  it("preserves exact Unicode path bytes without NFC normalization", () => {
    const nfdName = "\u00b0u\u0301_,.txt";
    expect(nfdName).not.toBe(nfdName.normalize("NFC"));
    expect(buildFileAtMentionsText([nfdName])).toBe(`@${nfdName} `);
    expect(buildFileAtMentionsText([nfdName])).not.toBe(`@${nfdName.normalize("NFC")} `);
  });
});
