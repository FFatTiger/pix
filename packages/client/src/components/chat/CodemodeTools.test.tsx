import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { I18nProvider } from "@/hooks/useI18n";
import type { AssistantMessage, ToolResultMessage } from "@/lib/chat-view-model";
import { expandNestedToolBlocks, messageToProcessContentBlocks, type ProcessContentBlock } from "@/lib/process-content";
import { ProcessGroup } from "./ProcessGroup";
import { MessageView } from "./MessageView";

type ToolBlock = Extract<ProcessContentBlock, { type: "toolCall" }>;
const origin = { phase: "process", placement: "inline", sourceMessageIndex: 1 } as const;
function parent(id = "batch"): ToolBlock {
  return {
    id, type: "toolCall", toolCallId: id, toolName: "codemode", input: { code: "return shared();" }, status: "error", origin,
    result: {
      role: "toolResult", toolCallId: id, isError: true,
      content: [{ type: "text", text: "shared failure" }, { type: "image", source: { type: "url", url: "https://example.test/batch.png" } }],
      structuredContent: { batch: true },
      nestedCalls: { complete: false, calls: [
        { id: "same-child", name: "read", arguments: { path: "README.md" }, status: "ok", durationMs: 0 },
        { id: "child-2", name: "grep", arguments: {}, status: "error", error: "nested failure" },
        { id: "child-3", name: "bash", status: "unfinished", argumentsBytes: 9000 },
      ] },
    },
  };
}
function blocks(): ProcessContentBlock[] {
  const ordinary = (id: string): ToolBlock => ({ id, type: "toolCall", toolCallId: id, toolName: "read", input: { path: id }, status: "success", origin });
  return [ordinary("before"), ...expandNestedToolBlocks(parent()), ordinary("after")];
}
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem("pi-locale", "en");
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
});
afterEach(cleanup);

describe("canonical codemode display", () => {
  it("expands real calls in order without inventing child results", () => {
    const root = parent();
    const items = expandNestedToolBlocks(root);
    expect(items.map(item => item.toolName)).toEqual(["read", "grep", "bash"]);
    expect(items.map(item => item.status)).toEqual(["success", "error", "unfinished"]);
    expect(items[0]!.duration).toBe(0);
    expect(items.every(item => item.result === undefined)).toBe(true);
    expect(items.slice(0, 2).every(item => item.sharedBatch === undefined)).toBe(true);
    expect(items[2]!.sharedBatch?.result).toBe(root.result);
    expect(items[2]!.sharedBatch?.input).toBe(root.input);
    expect(items[1]!.nested?.call.arguments).toEqual({});
    expect(items[2]!.nested?.call.arguments).toBeUndefined();
  });
  it("keys children by root and real child identity across history rebases", () => {
    const first = parent("one");
    const next = { ...first, id: "different-entry", origin: { ...origin, sourceEntryId: "rebased" } };
    expect(expandNestedToolBlocks(first).map(item => item.toolCallId)).toEqual(expandNestedToolBlocks(next).map(item => item.toolCallId));
    expect(expandNestedToolBlocks(first)[0]!.toolCallId).not.toBe(expandNestedToolBlocks(parent("two"))[0]!.toolCallId);
  });
  it("keeps the real parent when metadata is absent, empty, or belongs to another tool", () => {
    const root = parent();
    for (const value of [undefined, { calls: [], complete: false }]) {
      const item = { ...root, result: { ...root.result!, nestedCalls: value } };
      expect(expandNestedToolBlocks(item)).toEqual([item]);
    }
    const other = { ...root, toolName: "other" };
    expect(expandNestedToolBlocks(other)).toEqual([other]);
  });
  it("expands through the message conversion used by real transcripts", () => {
    const root = parent();
    const message: AssistantMessage = { role: "assistant", model: "test", provider: "test", content: [{ type: "toolCall", toolCallId: root.toolCallId, toolName: root.toolName, input: root.input }] };
    const converted = messageToProcessContentBlocks(message, { phase: "process", messageIndex: 1, toolResults: new Map([[root.toolCallId, root.result!]]) });
    expect(converted).toHaveLength(3);
    expect(converted.map(item => item.id)).toEqual(expandNestedToolBlocks(root).map(item => item.id));
  });
  it("puts children and ordinary calls in the same native group with independent disclosure", () => {
    const view = render(<I18nProvider><ProcessGroup blocks={blocks()} isStreaming={false} /></I18nProvider>);
    fireEvent.click(view.container.querySelector<HTMLButtonElement>("button[aria-expanded]")!);
    const group = view.container.querySelector<HTMLButtonElement>(".codex-tool-group-trigger")!;
    expect(view.container.querySelectorAll(".codex-tool-group-trigger")).toHaveLength(1);
    expect(group.textContent).toContain("Batch failed");
    fireEvent.click(group);
    expect(view.container.querySelectorAll(".codex-tool-row")).toHaveLength(5);
    expect(view.container.querySelectorAll(".codemode-tool-badge")).toHaveLength(3);
    expect(Array.from(view.container.querySelectorAll(".codemode-tool-badge")).every(node => node.textContent === "codemode")).toBe(true);
    const rows = view.container.querySelectorAll<HTMLButtonElement>(".codex-tool-row-trigger");
    fireEvent.click(rows[1]!);
    expect(rows[1]!.getAttribute("aria-expanded")).toBe("true");
    expect(rows[2]!.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(rows[3]!);
    expect(view.container.textContent).toContain("Arguments were not recorded.");
    expect(view.container.textContent).toContain("Shared codemode output");
    expect(view.container.textContent).toContain("shared failure");
    expect(view.container.textContent).toContain('"batch": true');
    expect(view.container.querySelector('img[src="https://example.test/batch.png"]')).not.toBeNull();
  });
  it.each(["timeline", "tabs"])("retains child metadata and shared output in %s mode", (mode) => {
    window.localStorage.setItem("pi-process-display-mode", mode);
    const view = render(<I18nProvider><ProcessGroup blocks={blocks()} isStreaming={false} /></I18nProvider>);
    fireEvent.click(view.container.querySelector<HTMLButtonElement>("button[aria-expanded]")!);
    if (mode === "timeline") {
      for (const trigger of view.container.querySelectorAll<HTMLButtonElement>(".process-step-nav button")) fireEvent.click(trigger);
      expect(view.container.querySelectorAll(".codemode-tool-badge")).toHaveLength(3);
      const child = view.container.querySelectorAll<HTMLButtonElement>(".tool-call-trigger")[3]!;
      fireEvent.click(child);
      expect(view.container.textContent).toContain("Shared codemode output");
      expect(view.container.textContent).toContain("shared failure");
    } else {
      for (const trigger of view.container.querySelectorAll<HTMLButtonElement>(".process-step-nav button")) {
        fireEvent.click(trigger);
        const child = view.container.querySelector<HTMLButtonElement>(".tool-call-trigger");
        if (child?.textContent?.includes("Batch failed")) {
          fireEvent.click(child);
          expect(view.container.textContent).toContain("shared failure");
          return;
        }
      }
      throw new Error("shared batch result was not reachable in tabs");
    }
  });
  it("uses the same expansion for a directly rendered assistant message", () => {
    const root = parent();
    const message: AssistantMessage = { role: "assistant", model: "test", provider: "test", content: [{ type: "toolCall", toolCallId: root.toolCallId, toolName: root.toolName, input: root.input }] };
    const view = render(<I18nProvider><MessageView message={message} toolResults={new Map<string, ToolResultMessage>([[root.toolCallId, root.result!]])} /></I18nProvider>);
    expect(view.container.querySelectorAll(".tool-call-block")).toHaveLength(3);
    expect(view.container.querySelectorAll(".codemode-tool-badge")).toHaveLength(3);
    fireEvent.click(view.container.querySelectorAll<HTMLButtonElement>(".tool-call-trigger")[2]!);
    expect(view.container.textContent).toContain("Arguments were not recorded.");
    expect(view.container.textContent).toContain("shared failure");
  });
});
