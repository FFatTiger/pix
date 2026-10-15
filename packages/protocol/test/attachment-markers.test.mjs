import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ATTACHED_FILE_MARKER_PREFIX,
  ATTACHED_IMAGE_MARKER_PREFIX,
  appendAttachedMarkerLines,
  formatAttachedFileMarkerLine,
  formatAttachedImageMarkerLine,
  splitAttachedMarkerLines,
} from "../dist/index.js";

describe("attachment marker line format", () => {
  it("formats image and file marker lines with the exact fixed prefixes", () => {
    assert.equal(formatAttachedImageMarkerLine("/home/u/.pi/pix/attachments/s1/abc.png"), "[Attached image saved at: /home/u/.pi/pix/attachments/s1/abc.png]");
    assert.equal(formatAttachedFileMarkerLine("/home/u/.pi/pix/attachments/s1/1-x-notes.md"), "[Attached file saved at: /home/u/.pi/pix/attachments/s1/1-x-notes.md]");
    assert.equal(ATTACHED_IMAGE_MARKER_PREFIX, "[Attached image saved at: ");
    assert.equal(ATTACHED_FILE_MARKER_PREFIX, "[Attached file saved at: ");
  });

  it("appends marker lines after a blank line, or alone for an empty prompt", () => {
    assert.equal(appendAttachedMarkerLines("hello", [formatAttachedImageMarkerLine("/a.png")]), "hello\n\n[Attached image saved at: /a.png]");
    assert.equal(appendAttachedMarkerLines("", [formatAttachedImageMarkerLine("/a.png")]), "[Attached image saved at: /a.png]");
    assert.equal(appendAttachedMarkerLines("hi", []), "hi");
    assert.equal(
      appendAttachedMarkerLines("", [formatAttachedImageMarkerLine("/a.png"), formatAttachedImageMarkerLine("/b.jpg")]),
      "[Attached image saved at: /a.png]\n[Attached image saved at: /b.jpg]",
    );
  });
});

describe("splitAttachedMarkerLines", () => {
  it("removes marker lines, keeps user text and collects ordered paths", () => {
    const text = [
      "please edit this",
      "",
      "[Attached image saved at: /att/s1/aa.png]",
      "[Attached file saved at: /att/s1/20260101-ab-notes.md]",
      "[Attached image saved at: /att/s1/bb.jpg]",
    ].join("\n");
    const split = splitAttachedMarkerLines(text);
    assert.deepEqual(split, {
      text: "please edit this",
      images: ["/att/s1/aa.png", "/att/s1/bb.jpg"],
      files: ["/att/s1/20260101-ab-notes.md"],
    });
  });

  it("accepts paths containing ] by matching up to the final ]", () => {
    const split = splitAttachedMarkerLines("[Attached file saved at: /tmp/we]ird name.txt]");
    assert.deepEqual(split.files, ["/tmp/we]ird name.txt"]);
    assert.equal(split.text, "");
  });

  it("never touches user prose that merely resembles a marker", () => {
    const prose = [
      "I typed [Attached image saved at: ",
      "and [Attached file saved at: ] is empty brackets",
      "also trailing [Attached image saved at: /x.png] inline suffix",
    ].join("\n");
    const split = splitAttachedMarkerLines(prose);
    assert.deepEqual(split.images, []);
    assert.deepEqual(split.files, []);
    assert.equal(split.text, prose);
  });

  it("keeps text untouched when no markers are present", () => {
    const text = "line1\n\nline2\n";
    assert.deepEqual(splitAttachedMarkerLines(text), { text, images: [], files: [] });
  });

  it("yields empty text for a message that is only marker lines", () => {
    const split = splitAttachedMarkerLines("[Attached image saved at: /a.png]\n[Attached file saved at: /b.txt]");
    assert.deepEqual(split, { text: "", images: ["/a.png"], files: ["/b.txt"] });
  });
});
