import { describe, expect, it } from "vitest";
import { continueMarkdownList } from "./markdown-list";

// Ported verbatim from the legacy desktop source lib/markdown-list.test.mjs.
describe("continueMarkdownList", () => {
  it("continues unordered list markers", () => {
    expect(continueMarkdownList("- item", 6, 6)).toEqual({ value: "- item\n- ", caret: 9 });
    expect(continueMarkdownList("* item", 6, 6)).toEqual({ value: "* item\n* ", caret: 9 });
    expect(continueMarkdownList("+ item", 6, 6)).toEqual({ value: "+ item\n+ ", caret: 9 });
  });

  it("continues ordered lists by incrementing the number", () => {
    expect(continueMarkdownList("1. item", 7, 7)).toEqual({ value: "1. item\n2. ", caret: 11 });
    expect(continueMarkdownList("3) item", 7, 7)).toEqual({ value: "3) item\n4) ", caret: 11 });
    expect(continueMarkdownList("9. item", 7, 7)).toEqual({ value: "9. item\n10. ", caret: 12 });
  });

  it("continues task checkboxes as unchecked", () => {
    expect(continueMarkdownList("- [ ] task", 10, 10)).toEqual({ value: "- [ ] task\n- [ ] ", caret: 17 });
    expect(continueMarkdownList("- [x] task", 10, 10)).toEqual({ value: "- [x] task\n- [ ] ", caret: 17 });
  });

  it("continues blockquotes, nested and combined prefixes", () => {
    expect(continueMarkdownList("> line", 6, 6)).toEqual({ value: "> line\n> ", caret: 9 });
    expect(continueMarkdownList(">> line", 7, 7)).toEqual({ value: ">> line\n>> ", caret: 11 });
    expect(continueMarkdownList("  - item", 8, 8)).toEqual({ value: "  - item\n  - ", caret: 13 });
    expect(continueMarkdownList("> - [ ] item", 13, 13)).toEqual({ value: "> - [ ] item\n> - [ ] ", caret: 22 });
  });

  it("an empty item ends the structure by removing the marker", () => {
    expect(continueMarkdownList("- ", 2, 2)).toEqual({ value: "", caret: 0 });
    expect(continueMarkdownList("> item\n> ", 9, 9)).toEqual({ value: "> item\n", caret: 7 });
    expect(continueMarkdownList("1. ", 3, 3)).toEqual({ value: "", caret: 0 });
    expect(continueMarkdownList("- [ ] ", 6, 6)).toEqual({ value: "", caret: 0 });
    expect(continueMarkdownList("  - ", 4, 4)).toEqual({ value: "", caret: 0 });
  });

  it("handles a caret in the middle of the line and selections", () => {
    expect(continueMarkdownList("- item more", 4, 4)).toEqual({ value: "- it\n- em more", caret: 7 });
    // Selection is replaced first, then the line is continued (selecting "te"
    // leaves "- im", a non-empty item). Selecting the whole item content
    // instead leaves an empty item, which ends the list.
    expect(continueMarkdownList("- item", 3, 5)).toEqual({ value: "- i\n- m", caret: 6 });
    expect(continueMarkdownList("- item", 2, 5)).toEqual({ value: "m", caret: 0 });
  });

  it("returns null for lines without a structural prefix", () => {
    expect(continueMarkdownList("plain text", 10, 10)).toBeNull();
    expect(continueMarkdownList("# heading", 9, 9)).toBeNull();
    expect(continueMarkdownList("", 0, 0)).toBeNull();
    expect(continueMarkdownList("```", 3, 3)).toBeNull();
    expect(continueMarkdownList("  ", 2, 2)).toBeNull();
    expect(continueMarkdownList("-", 1, 1)).toBeNull(); // marker without trailing space
  });
});
