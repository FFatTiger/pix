import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { I18nProvider } from "@/hooks/useI18n";
import type { AssistantMessage, ToolResultMessage } from "@/lib/chat-view-model";
import { expandNestedToolBlocks, messageToProcessContentBlocks, type ProcessContentBlock } from "@/lib/process-content";
import { ProcessGroup } from "./ProcessGroup";
import { MessageView } from "./MessageView";

type ToolBlock = Extract<ProcessContentBlock, { type: "toolCall" }>;
const origin = { phase: "process", placement: "inline", sourceMessageIndex: 1 } as const;

/** Old-record shape: nested calls carry no adapter-collected results. */
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

/** Enriched shape: each child carries its own adapter-collected result. */
function parentWithResults(id = "batch"): ToolBlock {
  const base = parent(id);
  return {
    ...base,
    result: {
      ...base.result!,
      nestedCalls: {
        complete: true,
        calls: [
          { id: "same-child", name: "read", arguments: { path: "README.md" }, status: "ok", durationMs: 0, result: { text: "own output 0", truncated: false, imageCount: 2, isError: false } },
          { id: "child-2", name: "grep", arguments: {}, status: "error", error: "nested failure", result: { text: "own output 1", truncated: true, imageCount: 0, isError: true } },
          { id: "child-3", name: "bash", arguments: { command: "ls" }, status: "ok", durationMs: 10 },
        ],
      },
    },
  };
}

/** A completed all-ok batch whose children share a tone (grouping stress). */
function okBatch(id: string, shared: string): ToolBlock {
  return {
    id, type: "toolCall", toolCallId: id, toolName: "codemode", input: { code: `return ${id}();` }, status: "success", origin,
    result: {
      role: "toolResult", toolCallId: id, isError: false,
      content: [{ type: "text", text: shared }],
      nestedCalls: { complete: true, calls: [
        { id: `${id}/0`, name: "read", arguments: { path: "a" }, status: "ok", durationMs: 1 },
        { id: `${id}/1`, name: "read", arguments: { path: "b" }, status: "ok", durationMs: 1 },
      ] },
    },
  };
}

function blocks(root: ToolBlock = parent()): ProcessContentBlock[] {
  const ordinary = (id: string): ToolBlock => ({ id, type: "toolCall", toolCallId: id, toolName: "read", input: { path: id }, status: "success", origin });
  return [ordinary("before"), ...expandNestedToolBlocks(root), ordinary("after")];
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
    expect(items[0]!.durationMs).toBe(0);
    expect(items.every(item => item.result === undefined)).toBe(true);
    expect(items.slice(0, 2).every(item => item.sharedBatch === undefined)).toBe(true);
    expect(items[2]!.sharedBatch?.result).toBe(root.result);
    expect(items[2]!.sharedBatch?.input).toBe(root.input);
    expect(items[1]!.nested?.call.arguments).toEqual({});
    expect(items[2]!.nested?.call.arguments).toBeUndefined();
    expect(items.every(item => item.nested?.call.result === undefined)).toBe(true);
  });
  it("keeps adapter-collected child results attached to their own call only", () => {
    const items = expandNestedToolBlocks(parentWithResults());
    expect(items[0]!.nested?.call.result?.text).toBe("own output 0");
    expect(items[0]!.nested?.call.result?.imageCount).toBe(2);
    expect(items[1]!.nested?.call.result?.isError).toBe(true);
    expect(items[1]!.nested?.call.result?.truncated).toBe(true);
    expect(items[2]!.nested?.call.result).toBeUndefined();
  });
  it("keys children by root and real child identity across history rebases", () => {
    const first = parent("one");
    const next = { ...first, id: "different-entry", origin: { ...origin, sourceEntryId: "rebased" } };
    expect(expandNestedToolBlocks(first).map(item => item.toolCallId)).toEqual(expandNestedToolBlocks(next).map(item => item.toolCallId));
    expect(expandNestedToolBlocks(first)[0]!.toolCallId).not.toEqual(expandNestedToolBlocks(parent("two"))[0]!.toolCallId);
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
  it("shows only a child's own output in its details and the shared script output once per group", () => {
    const view = render(<I18nProvider><ProcessGroup blocks={blocks(parentWithResults())} isStreaming={false} /></I18nProvider>);
    fireEvent.click(view.container.querySelector<HTMLButtonElement>("button[aria-expanded]")!);
    const group = view.container.querySelector<HTMLButtonElement>(".codex-tool-group-trigger")!;
    fireEvent.click(group);
    const scriptRows = view.container.querySelectorAll(".codemode-script-output-row");
    expect(scriptRows).toHaveLength(1);
    const toolRows = Array.from(view.container.querySelectorAll<HTMLElement>(".codex-tool-row")).filter(row => !row.classList.contains("codemode-script-output-row"));
    expect(toolRows).toHaveLength(5);
    expect(view.container.querySelectorAll(".codemode-tool-badge")).toHaveLength(4);
    const rows = toolRows.map(row => row.querySelector<HTMLButtonElement>(".codex-tool-row-trigger")!);
    // Child with its own result: shows its own output, never the shared one.
    fireEvent.click(rows[1]!);
    const details = toolRows[1]!.querySelector(".nested-tool-details")!;
    expect(details.textContent).toContain("own output 0");
    expect(details.textContent).toContain("2 image(s) returned");
    expect(details.textContent).not.toContain("shared failure");
    expect(details.textContent).not.toContain("Script output");
    expect(details.textContent).not.toContain("own output 1");
    // Child without a collected result (over-budget/old): input + status only.
    fireEvent.click(rows[3]!);
    const bare = toolRows[3]!.querySelector(".nested-tool-details")!;
    expect(bare.textContent).toContain('"command": "ls"');
    expect(bare.textContent).not.toContain("own output");
    expect(bare.textContent).not.toContain("shared failure");
    // The shared script output belongs to the group, labeled as such.
    const scriptTrigger = scriptRows[0]!.querySelector<HTMLButtonElement>(".codex-tool-row-trigger")!;
    expect(scriptTrigger.textContent).toContain("Script output");
    fireEvent.click(scriptTrigger);
    const scriptDetails = scriptRows[0]!.querySelector(".codemode-script-output")!;
    expect(scriptDetails.textContent).toContain("shared failure");
    expect(scriptDetails.textContent).toContain('"batch": true');
    expect(scriptRows[0]!.querySelector('img[src="https://example.test/batch.png"]')).not.toBeNull();
  });
  it.each(["timeline", "tabs"])("retains child metadata and group script output in %s mode", (mode) => {
    window.localStorage.setItem("pi-process-display-mode", mode);
    const view = render(<I18nProvider><ProcessGroup blocks={blocks(parentWithResults())} isStreaming={false} /></I18nProvider>);
    fireEvent.click(view.container.querySelector<HTMLButtonElement>("button[aria-expanded]")!);
    // Walk every step/tab until the codemode group's script-output row is
    // visible, open it, and verify the child-only and shared payloads.
    let opened = false;
    for (const trigger of view.container.querySelectorAll<HTMLButtonElement>(".process-step-nav button")) {
      fireEvent.click(trigger);
      const child = view.container.querySelectorAll<HTMLButtonElement>(".tool-call-trigger")[1];
      if (child) {
        fireEvent.click(child);
        if (view.container.textContent?.includes("own output 0")) {
          expect(view.container.querySelectorAll(".nested-tool-details")[0]?.textContent).not.toContain("shared failure");
        }
      }
      const scriptTrigger = view.container.querySelector<HTMLButtonElement>(".codemode-script-output-row .codex-tool-row-trigger");
      if (scriptTrigger) {
        fireEvent.click(scriptTrigger);
        expect(view.container.textContent).toContain("Script output");
        expect(view.container.textContent).toContain("shared failure");
        opened = true;
        break;
      }
    }
    expect(opened).toBe(true);
  });
  it("uses the same expansion for a directly rendered assistant message", () => {
    const root = parentWithResults();
    const message: AssistantMessage = { role: "assistant", model: "test", provider: "test", content: [{ type: "toolCall", toolCallId: root.toolCallId, toolName: root.toolName, input: root.input }] };
    const view = render(<I18nProvider><MessageView message={message} toolResults={new Map<string, ToolResultMessage>([[root.toolCallId, root.result!]])} /></I18nProvider>);
    expect(view.container.querySelectorAll(".tool-call-block")).toHaveLength(3);
    expect(view.container.querySelectorAll(".codemode-tool-badge")).toHaveLength(4);
    expect(view.container.querySelectorAll(".codemode-script-output-row")).toHaveLength(1);
    const rows = view.container.querySelectorAll<HTMLButtonElement>(".tool-call-trigger");
    fireEvent.click(rows[0]!);
    expect(view.container.textContent).toContain("own output 0");
    expect(view.container.querySelectorAll(".nested-tool-details")[0]!.textContent).not.toContain("shared failure");
    fireEvent.click(rows[2]!);
    const bareDetails = Array.from(view.container.querySelectorAll(".nested-tool-details")).at(-1)!;
    expect(bareDetails.textContent).toContain('"command": "ls"');
    expect(bareDetails.textContent).not.toContain("shared failure");
    const scriptTrigger = view.container.querySelector<HTMLButtonElement>(".codemode-script-output-row .codex-tool-row-trigger")!;
    fireEvent.click(scriptTrigger);
    expect(view.container.textContent).toContain("shared failure");
  });
  it("renders one script-output row per codemode batch when batches share one group", () => {
    const blocks = [...expandNestedToolBlocks(okBatch("alpha", "SHARED_ALPHA")), ...expandNestedToolBlocks(okBatch("beta", "SHARED_BETA"))];
    const view = render(<I18nProvider><ProcessGroup blocks={blocks} isStreaming={false} /></I18nProvider>);
    fireEvent.click(view.container.querySelector<HTMLButtonElement>("button[aria-expanded]")!);
    fireEvent.click(view.container.querySelector<HTMLButtonElement>(".codex-tool-group-trigger")!);
    const scriptRows = view.container.querySelectorAll(".codemode-script-output-row");
    expect(scriptRows).toHaveLength(2);
    for (const [index, shared] of [[0, "SHARED_ALPHA"], [1, "SHARED_BETA"]] as const) {
      fireEvent.click(scriptRows[index]!.querySelector<HTMLButtonElement>(".codex-tool-row-trigger")!);
      expect(scriptRows[index]!.querySelector(".codemode-script-output")!.textContent).toContain(shared);
    }
  });
  it("keeps a long nested bash command on the native row and opens the full args in details", () => {
    const command = `node --input-type=module -e ${"x".repeat(620)}`;
    const root = parent();
    root.result = {
      ...root.result!,
      nestedCalls: {
        complete: true,
        calls: [
          { id: "same-child", name: "read", arguments: { path: "README.md" }, status: "ok", durationMs: 0 },
          { id: "long-bash", name: "bash", arguments: { command }, status: "ok", durationMs: 4000 },
          { id: "child-3", name: "grep", arguments: { pattern: "token" }, status: "ok", durationMs: 0 },
        ],
      },
    };
    const ordinary = (id: string): ToolBlock => ({ id, type: "toolCall", toolCallId: id, toolName: "read", input: { path: id }, status: "success", origin });
    const items = [ordinary("before"), ...expandNestedToolBlocks(root), ordinary("after")];
    expect(items).toHaveLength(5);
    expect(items.map(item => item.toolName)).toEqual(["read", "read", "bash", "grep", "read"]);
    expect(items.every(item => item.toolName !== "codemode")).toBe(true);
    expect(items[2]!.result).toBeUndefined();
    const view = render(<I18nProvider><ProcessGroup blocks={items} isStreaming={false} /></I18nProvider>);
    fireEvent.click(view.container.querySelector<HTMLButtonElement>("button[aria-expanded]")!);
    fireEvent.click(view.container.querySelector<HTMLButtonElement>(".codex-tool-group-trigger")!);
    const rows = Array.from(view.container.querySelectorAll<HTMLElement>(".codex-tool-row")).filter(row => !row.classList.contains("codemode-script-output-row"));
    expect(rows).toHaveLength(5);
    expect(view.container.querySelectorAll(".codemode-tool-badge")).toHaveLength(4);
    const nested = rows[2]!;
    const preview = `${command.slice(0, 117)}...`;
    expect(nested.querySelector(".codex-tool-row-label")?.textContent).toBe(`Ran ${preview} in 4s`);
    expect(nested.querySelector(".codex-tool-row-label")?.textContent).not.toContain(command);
    expect(nested.querySelector(".codemode-tool-badge")?.textContent).toBe("codemode");
    expect(nested.querySelector(".codex-tool-duration")).toBeNull();
    const triggers = rows.map(row => row.querySelector<HTMLButtonElement>(".codex-tool-row-trigger")!);
    expect(triggers.every(trigger => trigger.getAttribute("aria-expanded") === "false")).toBe(true);
    fireEvent.click(triggers[2]!);
    expect(triggers[2]!.getAttribute("aria-expanded")).toBe("true");
    expect(triggers.filter((_, index) => index !== 2).every(trigger => trigger.getAttribute("aria-expanded") === "false")).toBe(true);
    expect(nested.querySelector("pre")?.textContent).toBe(JSON.stringify({ command }, null, 2));
    expect(nested.querySelector(".nested-tool-details")?.textContent).not.toContain("shared failure");
  });
});
