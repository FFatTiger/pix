import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { I18nProvider } from "@/hooks/useI18n";
import type { ToolResultMessage } from "@/lib/chat-view-model";
import { expandNestedToolBlocks, type ProcessContentBlock } from "@/lib/process-content";
import { displayMcpToolName, mcpToolArgSummary, parseMcpToolName } from "@/lib/tool-names";
import { CodexProcessContent } from "./CodexProcessContent";
import { MessageView } from "./MessageView";
import { ProcessGroup } from "./ProcessGroup";

type ToolBlock = Extract<ProcessContentBlock, { type: "toolCall" }>;
const origin = { phase: "process" as const, placement: "inline" as const, sourceMessageIndex: 1 };

function mcpBlock(
  toolName: string,
  input: Record<string, unknown>,
  status: ToolBlock["status"] = "success",
): ToolBlock {
  const id = toolName;
  return {
    id,
    type: "toolCall",
    toolCallId: id,
    toolName,
    input,
    durationMs: 820,
    status,
    origin,
    result: {
      role: "toolResult",
      toolCallId: id,
      isError: status === "error",
      content: [{ type: "text", text: "ok" }],
    },
  };
}

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem("pi-locale", "en");
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
});
afterEach(cleanup);

describe("parseMcpToolName", () => {
  it("splits server at the first __ and keeps the whole rest as the tool", () => {
    expect(parseMcpToolName("mcp__github__search_issues")).toEqual({ server: "github", tool: "search_issues" });
    expect(parseMcpToolName("mcp__my_server__deep__nested_tool")).toEqual({ server: "my_server", tool: "deep__nested_tool" });
    expect(parseMcpToolName("mcp__dev-radius__list__abc123")).toEqual({ server: "dev-radius", tool: "list__abc123" });
  });
  it("rejects non-MCP names", () => {
    for (const name of ["read", "mcp_search", "mcp__github", "__github__tool", "mcp___tool", "codemode"]) {
      expect(parseMcpToolName(name)).toBeNull();
    }
  });
  it("renders the display name and the bounded argument summary", () => {
    expect(displayMcpToolName("search_issues")).toBe("search issues");
    expect(displayMcpToolName("get-file_contents")).toBe("get file contents");
    expect(mcpToolArgSummary({ a: " is:open label:bug ", b: "second" })).toBe("is:open label:bug");
    expect(mcpToolArgSummary({ a: "", b: "second" })).toBe("second");
    expect(mcpToolArgSummary({ n: 42, b: undefined, o: { x: 1 } })).toBe("");
    expect(mcpToolArgSummary({ a: "x".repeat(200) })).toHaveLength(120);
    expect(mcpToolArgSummary({ a: "x".repeat(200) }).endsWith("...")).toBe(true);
  });
});

describe("MCP tool rows", () => {
  it("codex path: generic verb + display name + arg + server badge (never a search row)", () => {
    const blocks = [mcpBlock("mcp__github__search_issues", { query: "is:open label:bug repo:x/y" })];
    const view = render(<I18nProvider><CodexProcessContent blocks={blocks} isStreaming={false} isAnswerStreaming={false} /></I18nProvider>);
    const row = view.container.querySelector(".codex-tool-row")!;
    expect(row.querySelector(".codex-tool-row-label")!.textContent).toBe("Used search issues is:open label:bug repo:x/y");
    const badge = row.querySelector(".codemode-tool-badge")!;
    expect(badge.textContent).toBe("github");
    expect(badge.getAttribute("data-mcp-server")).toBe("github");
    // The raw prefixed id never reaches the row label.
    expect(row.querySelector(".codex-tool-row-label")!.textContent).not.toContain("mcp__github");
  });

  it("codex path: a failed MCP row shows the display name, not the raw id", () => {
    const blocks = [mcpBlock("mcp__postgres__query", { sql: "select 1" }, "error")];
    const view = render(<I18nProvider><CodexProcessContent blocks={blocks} isStreaming={false} isAnswerStreaming={false} /></I18nProvider>);
    const row = view.container.querySelector(".codex-tool-row")!;
    expect(row.classList.contains("is-error")).toBe(true);
    expect(row.querySelector(".codex-tool-row-label")!.textContent).toContain("query");
    expect(row.querySelector(".codex-tool-row-label")!.textContent).not.toContain("mcp__postgres__query");
    expect(row.querySelector(".codemode-tool-badge")!.textContent).toBe("postgres");
  });

  it("codex path: nested MCP child calls of a codemode batch carry the server badge", () => {
    const parent: ToolBlock = {
      id: "batch", type: "toolCall", toolCallId: "batch", toolName: "codemode", input: { code: "…" }, status: "success", origin,
      result: {
        role: "toolResult", toolCallId: "batch", isError: false, content: [{ type: "text", text: "done" }],
        nestedCalls: {
          complete: true,
          calls: [
            { id: "c1", name: "mcp__github__get_issue", arguments: { number: 42 }, status: "ok", durationMs: 5 },
            { id: "c2", name: "mcp__github__add_comment", arguments: { number: 42, body: "noted" }, status: "ok", durationMs: 5 },
            { id: "c3", name: "read", arguments: { path: "README.md" }, status: "ok", durationMs: 1 },
          ],
        },
      },
    };
    const blocks = expandNestedToolBlocks(parent);
    const view = render(<I18nProvider><CodexProcessContent blocks={blocks} isStreaming={false} isAnswerStreaming={false} /></I18nProvider>);
    fireEvent.click(view.container.querySelector<HTMLButtonElement>(".codex-tool-group-trigger")!);
    const rows = view.container.querySelectorAll(".codex-tool-row");
    const githubRow = Array.from(rows).find((row) => row.textContent!.includes("get issue"))!;
    // A number-only argument produces no string summary; a string one does.
    expect(githubRow.querySelector(".codex-tool-row-label")!.textContent).toBe("Used get issue");
    expect(githubRow.querySelector(".codemode-tool-badge")!.textContent).toBe("github");
    const commentRow = Array.from(rows).find((row) => row.textContent!.includes("add comment"))!;
    expect(commentRow.querySelector(".codex-tool-row-label")!.textContent).toBe("Used add comment noted");
    expect(commentRow.querySelector(".codemode-tool-badge")!.textContent).toBe("github");
    // A plain nested read stays the codemode-badged row.
    const readRow = Array.from(rows).find((row) => row.textContent!.toLowerCase().includes("read"))!;
    expect(readRow.querySelector(".codemode-tool-badge")!.textContent).toBe("codemode");
  });

  it.each(["timeline", "tabs"])("%s path: label carries display name + arg and the server badge", (mode) => {
    window.localStorage.setItem("pi-process-display-mode", mode);
    const blocks = [mcpBlock("mcp__filesystem__read_file", { path: "/tmp/notes.md" })];
    const view = render(<I18nProvider><ProcessGroup blocks={blocks} isStreaming={false} /></I18nProvider>);
    fireEvent.click(view.container.querySelector<HTMLButtonElement>("button[aria-expanded]")!);
    const badge = view.container.querySelector(".codemode-tool-badge")!;
    expect(badge.textContent).toBe("filesystem");
    expect(view.container.textContent).toContain("read file /tmp/notes.md");
    expect(view.container.textContent).not.toContain("mcp__filesystem__read_file");
  });

  it("inline MessageView path: display name + preview + server badge", () => {
    const block = mcpBlock("mcp__github__search_issues", { query: "is:open" });
    const view = render(
      <I18nProvider>
        <MessageView
          message={{
            role: "assistant",
            model: "test",
            provider: "test",
            content: [{ type: "toolCall", toolCallId: block.toolCallId, toolName: block.toolName, input: block.input }],
          }}
          toolResults={new Map<string, ToolResultMessage>([[block.toolCallId, block.result!]])}
        />
      </I18nProvider>,
    );
    const trigger = view.container.querySelector(".tool-call-trigger")!;
    expect(trigger.querySelector(".tool-call-name")!.textContent).toBe("search issues");
    expect(trigger.querySelector(".tool-call-preview")!.textContent).toContain("is:open");
    const badge = trigger.querySelector(".codemode-tool-badge")!;
    expect(badge.textContent).toBe("github");
    expect(trigger.textContent).not.toContain("mcp__github__search_issues");
  });
});
