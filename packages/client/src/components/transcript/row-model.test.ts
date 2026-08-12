import { describe, expect, it } from "vitest";
import {
  buildTranscriptRows,
  estimateRowHeight,
  flattenTranscriptParts,
  getTranscriptRowKey,
  type TranscriptPart,
} from "./row-model";

describe("buildTranscriptRows", () => {
  it("maps messages to rows with stable ids", () => {
    const rows = buildTranscriptRows([
      { id: "m1", role: "user", text: "hi" },
      { id: "m2", role: "assistant", text: "hello" },
    ]);
    expect(rows.map((r) => r.id)).toEqual(["m1", "m2"]);
    expect(rows.map((r) => r.kind)).toEqual(["user", "assistant"]);
  });

  it("prepends readonly banner when requested", () => {
    const rows = buildTranscriptRows([{ id: "m1", role: "user", text: "x" }], {
      readonlyBanner: true,
    });
    expect(rows[0]?.id).toBe("row:system:readonly");
    expect(rows[0]?.kind).toBe("system");
    expect(rows).toHaveLength(2);
  });

  it("preserves structured parts on assistant rows without splitting into list rows", () => {
    const parts: TranscriptPart[] = [
      { type: "thinking", thinking: "plan" },
      { type: "text", text: "answer" },
      { type: "thinking", thinking: "more" },
      { type: "text", text: "done" },
    ];
    const rows = buildTranscriptRows([
      {
        id: "a1",
        role: "assistant",
        text: flattenTranscriptParts(parts),
        parts,
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("a1");
    expect(rows[0]?.parts).toEqual(parts);
    expect(rows[0]?.text).toBe("plan\nanswer\nmore\ndone");
  });
});

describe("estimateRowHeight", () => {
  it("uses explicit estimate when present", () => {
    expect(
      estimateRowHeight({ id: "a", kind: "user", text: "x", estimateHeight: 120 }),
    ).toBe(120);
  });

  it("grows with long text", () => {
    const short = estimateRowHeight({ id: "a", kind: "assistant", text: "hi" });
    const long = estimateRowHeight({
      id: "b",
      kind: "assistant",
      text: "word ".repeat(200),
    });
    expect(long).toBeGreaterThan(short);
  });
});

describe("getTranscriptRowKey", () => {
  it("uses row id", () => {
    expect(
      getTranscriptRowKey({ id: "row:1", kind: "user", text: "a" }),
    ).toBe("row:1");
  });
});

describe("flattenTranscriptParts", () => {
  it("joins part bodies in order", () => {
    expect(
      flattenTranscriptParts([
        { type: "thinking", thinking: "t1" },
        { type: "text", text: "a" },
        { type: "toolCall", text: "read({})" },
        { type: "image", text: "[image]" },
      ]),
    ).toBe("t1\na\nread({})\n[image]");
  });
});
