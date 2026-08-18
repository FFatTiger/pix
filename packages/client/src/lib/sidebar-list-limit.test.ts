import { describe, expect, it } from "vitest";
import { splitLimitedList } from "./sidebar-list-limit";

describe("splitLimitedList", () => {
  it("keeps at most five items until expanded", () => {
    const items = ["a", "b", "c", "d", "e", "f", "g"];
    expect(splitLimitedList(items, false)).toEqual({ visible: ["a", "b", "c", "d", "e"], hiddenCount: 2 });
    expect(splitLimitedList(items, true)).toEqual({ visible: items, hiddenCount: 0 });
  });

  it("does not hide a list that already fits", () => {
    expect(splitLimitedList(["a", "b"], false)).toEqual({ visible: ["a", "b"], hiddenCount: 0 });
  });
});
