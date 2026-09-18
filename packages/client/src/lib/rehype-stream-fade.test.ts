import { describe, expect, it } from "vitest";
import type { Root } from "hast";
import { extendStreamBirths, rehypeStreamFade, sliceStreamBirths } from "./rehype-stream-fade";

describe("extendStreamBirths", () => {
  it("keeps previous births and stamps only newly appended characters", () => {
    const first = extendStreamBirths("", "ab", [], 100);
    expect(first).toEqual([100, 100]);
    const next = extendStreamBirths("ab", "abcd", first, 140);
    expect(next).toEqual([100, 100, 140, 140]);
  });

  it("restarts births when the streamed text is replaced", () => {
    expect(extendStreamBirths("old", "new", [1, 2, 3], 50)).toEqual([50, 50, 50]);
  });
});

describe("sliceStreamBirths", () => {
  it("keeps the tail-aligned births for a later markdown part", () => {
    expect(sliceStreamBirths("ab\n\ncd", "cd", [1, 1, 1, 1, 2, 2])).toEqual([2, 2]);
  });
});

describe("rehypeStreamFade", () => {
  it("keeps already-revealed text compact and wraps only characters still fading", () => {
    const tree: Root = {
      type: "root",
      children: [{
        type: "element",
        tagName: "p",
        properties: {},
        children: [{ type: "text", value: "abcd" }],
      }],
    };

    rehypeStreamFade({ births: [100, 100, 900, 900], nowMs: 1_000, fadeDuration: 280 })(tree);

    const paragraph = tree.children[0];
    expect(paragraph?.type).toBe("element");
    if (paragraph?.type !== "element") throw new Error("expected paragraph");
    expect(paragraph.children[0]).toEqual({ type: "text", value: "ab" });
    expect(paragraph.children.slice(1)).toHaveLength(2);
    expect(paragraph.children.slice(1).every((node) => node.type === "element")).toBe(true);
  });
});
