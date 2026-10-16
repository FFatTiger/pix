import { describe, expect, it } from "vitest";
import type { AssistantContentBlock, ToolResultMessage } from "./chat-view-model";
import { extractTurnShownFiles, mergeTurnFileRows } from "./turn-written-files";

function call(toolCallId: string, files: string[]): AssistantContentBlock {
  return { type: "toolCall", toolCallId, toolName: "show_files", input: { files } } as AssistantContentBlock;
}

function result(toolCallId: string, details: unknown, isError = false): ToolResultMessage {
  return { role: "toolResult", toolCallId, toolName: "show_files", content: [{ type: "text", text: "ok" }], isError, details } as ToolResultMessage;
}

describe("shown files", () => {
  it("collects show_files results in order, deduped, with image kinds", () => {
    const content = [
      call("a", ["notes.md"]),
      call("b", ["shot.png", "notes.md"]),
    ];
    const results = new Map<string, ToolResultMessage>([
      ["a", result("a", { files: [{ path: "/x/notes.md", name: "notes.md", kind: "file" }] })],
      ["b", result("b", { files: [
        { path: "/x/shot.png", name: "shot.png", kind: "image" },
        { path: "/x/notes.md", name: "notes.md", kind: "file" },
      ] })],
    ]);
    expect(extractTurnShownFiles(content, results, "/x")).toEqual([
      { filePath: "/x/notes.md", kind: "file" },
      { filePath: "/x/shot.png", kind: "image" },
    ]);
  });

  it("skips a failed call and falls back to the call input when details were dropped", () => {
    const content = [call("bad", ["missing.md"]), call("bare", ["photo.PNG"])];
    const results = new Map<string, ToolResultMessage>([
      ["bad", result("bad", undefined, true)],
      ["bare", result("bare", undefined)],
    ]);
    expect(extractTurnShownFiles(content, results, "/x")).toEqual([
      { filePath: "/x/photo.PNG", kind: "image" },
    ]);
  });

  it("puts written files before shown files and drops a path that was both", () => {
    const rows = mergeTurnFileRows(
      [{ filePath: "/x/a.ts", additions: 2 }],
      [{ filePath: "/x/a.ts", kind: "file" }, { filePath: "/x/b.png", kind: "image" }],
    );
    expect(rows).toEqual([
      { source: "written", filePath: "/x/a.ts", additions: 2 },
      { source: "shown", filePath: "/x/b.png", kind: "image" },
    ]);
  });
});
