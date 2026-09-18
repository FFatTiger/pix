import { describe, expect, it } from "vitest";
import type { ProcessContentBlock } from "@/lib/process-content";
import { buildCodexFlowItems } from "./CodexProcessContent";

const origin = { phase: "process", placement: "standalone", sourceMessageIndex: 1 } as const;

function tool(id: string): ProcessContentBlock {
  return {
    id,
    type: "toolCall",
    toolCallId: id,
    toolName: "read",
    input: { path: `/${id}.ts` },
    status: "success",
    origin,
  };
}

function custom(id: string): ProcessContentBlock {
  return {
    id,
    type: "custom",
    customType: "notice",
    message: { role: "custom", customType: "notice", content: id, display: true },
    origin,
  };
}

describe("buildCodexFlowItems", () => {
  it("keeps tool calls in one small group while the model emits no text", () => {
    const items = buildCodexFlowItems([tool("a"), tool("b"), tool("c")]);

    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("tools");
    if (items[0]!.kind === "tools") expect(items[0]!.blocks.map((block) => block.id)).toEqual(["a", "b", "c"]);
  });

  it("starts a new small group only after visible text; hidden thinking does not split tools", () => {
    const blocks: ProcessContentBlock[] = [
      tool("a"),
      tool("b"),
      { id: "text", type: "text", text: "checkpoint", origin },
      tool("c"),
      { id: "thinking", type: "thinking", thinking: "next step", origin },
      tool("d"),
      tool("e"),
    ];

    const items = buildCodexFlowItems(blocks);
    expect(items.map((item) => item.kind)).toEqual(["tools", "narrative", "tools"]);
    expect(items.filter((item) => item.kind === "tools").map((item) => item.blocks.length)).toEqual([2, 3]);
  });

  it("does not split a small group for whitespace-only model text", () => {
    const blocks: ProcessContentBlock[] = [
      tool("a"),
      { id: "whitespace", type: "text", text: " \n\t ", origin },
      tool("b"),
    ];

    const items = buildCodexFlowItems(blocks);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("tools");
    if (items[0]!.kind === "tools") expect(items[0]!.blocks.map((block) => block.id)).toEqual(["a", "b"]);
  });

  it("only exposes the current trailing thought as a transient streaming title", () => {
    const blocks: ProcessContentBlock[] = [
      { id: "old-thinking", type: "thinking", thinking: "old thought", origin },
      tool("a"),
      { id: "current-thinking", type: "thinking", thinking: "current thought", origin },
    ];

    expect(buildCodexFlowItems(blocks).map((item) => item.kind)).toEqual(["tools"]);
    expect(buildCodexFlowItems(blocks, true).map((item) => item.kind)).toEqual(["tools", "thinkingStatus"]);
    expect(buildCodexFlowItems(blocks, true, true).map((item) => item.kind)).toEqual(["tools"]);
  });

  it("does not create a title for empty trailing thinking", () => {
    const blocks: ProcessContentBlock[] = [
      tool("a"),
      { id: "empty-thinking", type: "thinking", thinking: " \n\t ", origin },
    ];

    expect(buildCodexFlowItems(blocks, true).map((item) => item.kind)).toEqual(["tools"]);
  });

  it("keeps tools in one group across non-text process entries while preserving entry order", () => {
    const blocks: ProcessContentBlock[] = [
      tool("a"),
      custom("event"),
      { id: "image", type: "image", source: { type: "url", url: "https://example.test/x.png" }, origin },
      tool("b"),
    ];

    const items = buildCodexFlowItems(blocks);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("tools");
    if (items[0]!.kind === "tools") {
      expect(items[0]!.blocks.map((block) => block.id)).toEqual(["a", "b"]);
      expect(items[0]!.entries.map((block) => block.id)).toEqual(["a", "event", "image", "b"]);
    }
  });
});
