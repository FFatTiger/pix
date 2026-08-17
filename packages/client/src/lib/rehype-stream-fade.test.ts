import { describe, expect, it } from "vitest";
import { extendStreamBirths, sliceStreamBirths } from "./rehype-stream-fade";

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
