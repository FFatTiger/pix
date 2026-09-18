import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { I18nProvider } from "@/hooks/useI18n";
import type { ProcessContentBlock } from "@/lib/process-content";
import { ProcessGroup } from "./ProcessGroup";
import { DISCLOSURE_TRANSITION_MS } from "./DisclosureCollapse";

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function tool(status: "running" | "success", id = "tool-1", path = "/x/a.ts"): ProcessContentBlock {
  return {
    id,
    type: "toolCall",
    toolCallId: id,
    toolName: "read",
    input: { path },
    status,
    origin: { phase: "process", placement: "standalone", sourceMessageIndex: 1 },
  };
}

function namedTool(
  toolName: string,
  id: string,
  input: Record<string, unknown>,
  status: "running" | "success" | "error" = "success",
  duration?: number,
): ProcessContentBlock {
  return {
    id,
    type: "toolCall",
    toolCallId: id,
    toolName,
    input,
    status,
    ...(duration === undefined ? {} : { duration }),
    origin: { phase: "process", placement: "standalone", sourceMessageIndex: 1 },
  };
}

function imageResultTool(id: string, url: string): ProcessContentBlock {
  const block = namedTool("read", id, { path: `/tmp/${id}.png` });
  if (block.type !== "toolCall") throw new Error("expected tool block");
  block.result = {
    role: "toolResult",
    toolCallId: id,
    content: [{ type: "image", source: { type: "url", url } }],
    isError: false,
    timestamp: 1,
  };
  return block;
}

describe("ProcessGroup — expanded lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    window.localStorage.clear();
    window.localStorage.setItem("pi-locale", "en");
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("fills while expanded and auto-collapses after the same live group settles", () => {
    window.localStorage.setItem("pi-process-display-mode", "timeline");
    const view = render(
      <I18nProvider>
        <div className="transcript-scroll">
          <ProcessGroup blocks={[tool("running")]} isStreaming startedAt={95_000} />
        </div>
      </I18nProvider>,
    );
    const shell = view.container.querySelector<HTMLElement>(".process-group-shell")!;
    const summary = view.container.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(shell.getAttribute("data-expanded")).toBe("true");
    expect(shell.style.getPropertyValue("--process-group-max-height")).toBe("64px");
    expect(summary.textContent).toContain("Elapsed 5s");

    act(() => { vi.advanceTimersByTime(2_000); });
    expect(summary.textContent).toContain("Elapsed 7s");

    view.rerender(
      <I18nProvider>
        <div className="transcript-scroll">
          <ProcessGroup blocks={[tool("success")]} isStreaming={false} startedAt={95_000} completedAt={102_000} />
        </div>
      </I18nProvider>,
    );
    act(() => { vi.advanceTimersByTime(299); });
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    act(() => { vi.advanceTimersByTime(1); });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(shell.getAttribute("data-expanded")).toBe("false");
    expect(shell.classList.contains("process-group-shell--expanded")).toBe(true);
    expect(shell.style.getPropertyValue("--process-group-max-height")).toBe("64px");
    expect(summary.textContent).toContain("Worked for 7s");
    act(() => { vi.advanceTimersByTime(DISCLOSURE_TRANSITION_MS); });
    expect(shell.classList.contains("process-group-shell--expanded")).toBe(false);
    expect(shell.style.getPropertyValue("--process-group-max-height")).toBe("");
  });

  it("defaults to Codex mode as one flat raw block flow with only the outer collapse", () => {
    const blocks: ProcessContentBlock[] = [
      {
        id: "text-1",
        type: "text",
        text: "Inspect the source before changing it.",
        origin: { phase: "process", placement: "standalone", sourceMessageIndex: 1 },
      },
      tool("success", "tool-1", "/x/a.ts"),
      tool("success", "tool-2", "/x/b.ts"),
      {
        id: "settled-thinking",
        type: "thinking",
        thinking: "This settled thought must not remain in history.",
        origin: { phase: "process", placement: "standalone", sourceMessageIndex: 1 },
      },
      {
        id: "text-2",
        type: "text",
        text: "Now verify the result.",
        origin: { phase: "process", placement: "standalone", sourceMessageIndex: 2 },
      },
      tool("success", "tool-3", "/x/c.ts"),
    ];
    const view = render(
      <I18nProvider>
        <div className="transcript-scroll">
          <ProcessGroup blocks={blocks} isStreaming={false} startedAt={1_000} completedAt={66_000} />
        </div>
      </I18nProvider>,
    );

    const shell = view.container.querySelector<HTMLElement>(".process-group-shell")!;
    const summary = view.container.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    expect(shell.dataset.displayMode).toBe("codex");
    expect(summary.textContent).toContain("Worked for 1m 5s");
    expect(view.queryByText("Inspect the source before changing it.")).toBeNull();

    fireEvent.click(summary);

    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(shell.classList.contains("process-group-shell--expanded")).toBe(false);
    expect(shell.style.getPropertyValue("--process-group-max-height")).toBe("");
    expect(view.getByText("Inspect the source before changing it.")).toBeTruthy();
    expect(view.queryByText("This settled thought must not remain in history.")).toBeNull();
    expect(view.container.querySelector(".codex-thinking-status")).toBeNull();
    expect(view.container.querySelector(".codex-process-flow")).toBeTruthy();
    expect(view.container.querySelector(".process-group-layout")).toBeNull();
    expect(view.container.querySelector(".process-step-nav")).toBeNull();
    expect(view.container.querySelectorAll(".tool-call-block")).toHaveLength(0);
    expect(view.container.querySelectorAll(".thinking-block")).toHaveLength(0);
    expect(view.container.querySelectorAll(".process-file-tag")).toHaveLength(0);

    const toolGroups = view.container.querySelectorAll<HTMLElement>(".codex-tool-group");
    expect(toolGroups).toHaveLength(1);
    expect(toolGroups[0]!.dataset.toolCount).toBe("2");
    // A lone trailing tool never groups: it renders as one expandable row.
    const loneRows = view.container.querySelectorAll<HTMLElement>(".codex-process-flow > .codex-tool-row");
    expect(loneRows).toHaveLength(1);
    expect(loneRows[0]!.querySelector(".codex-tool-row-label")?.textContent).toBe("Read c.ts");
    expect(loneRows[0]!.querySelector<HTMLButtonElement>(".codex-tool-row-trigger")?.getAttribute("aria-expanded")).toBe("false");
    expect(toolGroups[0]!.querySelectorAll("[data-tool-id]")).toHaveLength(0);

    fireEvent.click(toolGroups[0]!.querySelector<HTMLButtonElement>(".codex-tool-group-trigger")!);
    expect(toolGroups[0]!.querySelectorAll("[data-tool-id]")).toHaveLength(2);
  });

  it("animates both Codex disclosure levels and unmounts only after the exit transition", () => {
    window.localStorage.setItem("pi-process-display-mode", "codex");
    const view = render(
      <I18nProvider>
        <div className="transcript-scroll">
          <ProcessGroup
            blocks={[
              tool("success", "tool-1", "/x/a.ts"),
              tool("success", "tool-2", "/x/b.ts"),
              tool("success", "tool-3", "/x/c.ts"),
            ]}
            isStreaming={false}
            startedAt={1_000}
            completedAt={2_000}
          />
        </div>
      </I18nProvider>,
    );

    const outerTrigger = view.container.querySelector<HTMLButtonElement>(".group\\/summary")!;
    expect(view.container.querySelector(".process-group-collapse")).toBeNull();
    fireEvent.click(outerTrigger);

    const outerCollapse = view.container.querySelector<HTMLElement>(".process-group-collapse")!;
    expect(outerCollapse).toBeTruthy();
    const group = view.container.querySelector<HTMLElement>(".codex-tool-group")!;
    const groupTrigger = group.querySelector<HTMLButtonElement>(".codex-tool-group-trigger")!;
    fireEvent.click(groupTrigger);

    const groupCollapse = group.querySelector<HTMLElement>(".codex-tool-group-collapse")!;
    expect(groupCollapse).toBeTruthy();
    expect(group.querySelector(".codex-tool-group-scroll")).toBeTruthy();
    expect(group.querySelectorAll("[data-tool-id]")).toHaveLength(3);

    fireEvent.click(groupTrigger);
    expect(groupTrigger.getAttribute("aria-expanded")).toBe("false");
    expect(group.querySelector<HTMLElement>(".codex-tool-group-collapse")?.dataset.state).toBe("closed");
    act(() => { vi.advanceTimersByTime(DISCLOSURE_TRANSITION_MS - 1); });
    expect(group.querySelector(".codex-tool-group-collapse")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1); });
    expect(group.querySelector(".codex-tool-group-collapse")).toBeNull();

    fireEvent.click(outerTrigger);
    expect(outerTrigger.getAttribute("aria-expanded")).toBe("false");
    expect(view.container.querySelector<HTMLElement>(".process-group-collapse")?.dataset.state).toBe("closed");
    act(() => { vi.advanceTimersByTime(DISCLOSURE_TRANSITION_MS); });
    expect(view.container.querySelector(".process-group-collapse")).toBeNull();
  });

  it("keeps a running Codex tool group collapsed and marked with is-running", () => {
    window.localStorage.setItem("pi-process-display-mode", "codex");
    const view = render(
      <I18nProvider>
        <div className="transcript-scroll">
          <ProcessGroup
            blocks={[tool("success", "tool-1", "/x/a.ts"), tool("running", "tool-2", "/x/b.ts")]}
            isStreaming={true}
            startedAt={1_000}
          />
        </div>
      </I18nProvider>,
    );

    // The outer 大分组 still opens while streaming, but the running 小分组
    // never auto-expands — it only carries the subtle highlight class.
    const group = view.container.querySelector<HTMLElement>(".codex-tool-group")!;
    expect(group.classList.contains("is-running")).toBe(true);
    const trigger = group.querySelector<HTMLButtonElement>(".codex-tool-group-trigger")!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(group.querySelector(".codex-tool-group-collapse")).toBeNull();

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(group.querySelectorAll("[data-tool-id]")).toHaveLength(2);
    // Inside the opened group, the completed tool row also stays collapsed by
    // default (no running auto-expand at the row level either).
    const row = group.querySelector<HTMLElement>("[data-tool-id=\"tool-1\"]")!;
    expect(row.querySelector(".codex-tool-details")).toBeNull();
  });

  it("uses only the live trailing thought as the next Codex group title", () => {
    window.localStorage.setItem("pi-process-display-mode", "codex");
    const blocks: ProcessContentBlock[] = [
      tool("success", "tool-1", "/x/a.ts"),
      {
        id: "thinking-live",
        type: "thinking",
        thinking: "Inspecting files\nUpdating tests for group boundaries",
        origin: { phase: "process", placement: "standalone", sourceMessageIndex: 2 },
      },
    ];
    const view = render(
      <I18nProvider>
        <div className="transcript-scroll">
          <ProcessGroup blocks={blocks} isStreaming />
        </div>
      </I18nProvider>,
    );

    expect(view.getByText("Updating tests for group boundaries")).toBeTruthy();
    expect(view.queryByText("Inspecting files")).toBeNull();
    expect(view.container.querySelectorAll(".codex-thinking-status")).toHaveLength(1);

    view.rerender(
      <I18nProvider>
        <div className="transcript-scroll">
          <ProcessGroup blocks={blocks} isStreaming isAnswerStreaming />
        </div>
      </I18nProvider>,
    );
    expect(view.queryByText("Updating tests for group boundaries")).toBeNull();
    expect(view.container.querySelector(".codex-thinking-status")).toBeNull();

    view.rerender(
      <I18nProvider>
        <div className="transcript-scroll">
          <ProcessGroup blocks={blocks} isStreaming={false} completedAt={100_000} />
        </div>
      </I18nProvider>,
    );
    expect(view.container.querySelector(".codex-thinking-status")).toBeNull();
  });

  it("renders a Chinese multi-action summary as one Codex sentence", () => {
    window.localStorage.setItem("pi-process-display-mode", "codex");
    window.localStorage.setItem("pi-locale", "zh-CN");
    const view = render(
      <I18nProvider>
        <div className="transcript-scroll">
          <ProcessGroup
            blocks={[
              namedTool("write", "edit", { path: "/x/a.ts", content: "changed" }),
              namedTool("read", "read", { path: "/x/a.ts" }),
              namedTool("bash", "command", { command: "npm test" }),
              namedTool("read", "read-again", { path: "/x/b.ts" }),
            ]}
            isStreaming={false}
          />
        </div>
      </I18nProvider>,
    );

    fireEvent.click(view.container.querySelector<HTMLButtonElement>('button[aria-expanded]')!);
    const label = view.container.querySelector<HTMLElement>(".codex-tool-group-label")!;
    expect(label.textContent).toBe("编辑了文件读取文件运行了命令");
    expect(label.querySelectorAll("span")).toHaveLength(0);
  });

  it("uses the screenshot copy when reads lead directly into commands", () => {
    window.localStorage.setItem("pi-process-display-mode", "codex");
    window.localStorage.setItem("pi-locale", "zh-CN");
    const view = render(
      <I18nProvider>
        <div className="transcript-scroll">
          <ProcessGroup
            blocks={[
              namedTool("read", "read", { path: "/x/a.ts" }),
              namedTool("bash", "command", { command: "npm test" }),
            ]}
            isStreaming={false}
          />
        </div>
      </I18nProvider>,
    );

    fireEvent.click(view.container.querySelector<HTMLButtonElement>('button[aria-expanded]')!);
    expect(view.container.querySelector(".codex-tool-group-label")?.textContent)
      .toBe("已读取文件运行了命令");
  });

  it("writes one grammatical Chinese sentence for named tools and mixed states", () => {
    window.localStorage.setItem("pi-process-display-mode", "codex");
    window.localStorage.setItem("pi-locale", "zh-CN");
    const view = render(
      <I18nProvider>
        <div className="transcript-scroll">
          <ProcessGroup
            blocks={[
              namedTool("Agent", "agent", { prompt: "review" }),
              namedTool("search", "search", { pattern: "token" }),
              namedTool("read", "read", { path: "/x/a.ts" }),
            ]}
            isStreaming={false}
          />
        </div>
      </I18nProvider>,
    );

    fireEvent.click(view.container.querySelector<HTMLButtonElement>('button[aria-expanded]')!);
    const label = view.container.querySelector<HTMLElement>(".codex-tool-group-label")!;
    expect(label.textContent).toBe("调用了 Agent搜索了内容读取文件");
    expect(label.textContent).not.toContain("调用了工具");

    view.rerender(
      <I18nProvider>
        <div className="transcript-scroll">
          <ProcessGroup
            blocks={[
              namedTool("search", "search", { pattern: "token" }),
              namedTool("read", "read", { path: "/x/a.ts" }, "running"),
              namedTool("write", "write", { path: "/x/b.ts", content: "x" }, "error"),
            ]}
            isStreaming
          />
        </div>
      </I18nProvider>,
    );
    expect(view.container.querySelector(".codex-tool-group-label")?.textContent).toBe("搜索了内容，正在读取文件，但有工具调用失败");
  });

  it("uses distinct Codex copy for a running command row and its completed label", () => {
    window.localStorage.setItem("pi-process-display-mode", "codex");
    window.localStorage.setItem("pi-locale", "zh-CN");
    const command = "npm run build --filter client";
    const view = render(
      <I18nProvider>
        <div className="transcript-scroll">
          <ProcessGroup blocks={[namedTool("bash", "command", { command }, "running")]} isStreaming />
        </div>
      </I18nProvider>,
    );

    const row = view.container.querySelector<HTMLElement>(".codex-process-flow > .codex-tool-row")!;
    expect(row.classList.contains("is-command")).toBe(true);
    expect(row.classList.contains("is-running")).toBe(true);
    expect(row.querySelector(".codex-tool-row-label")?.textContent).toBe(`正在运行 ${command}`);
    expect(row.querySelector<HTMLButtonElement>(".codex-tool-row-trigger")?.getAttribute("aria-expanded")).toBe("false");

    view.rerender(
      <I18nProvider>
        <div className="transcript-scroll">
          <ProcessGroup blocks={[namedTool("bash", "command", { command }, "success", 11)]} isStreaming />
        </div>
      </I18nProvider>,
    );

    expect(row.querySelector(".codex-tool-row-label")?.textContent).toBe(`已在 11s 内运行 ${command}`);
    expect(row.classList.contains("is-running")).toBe(false);
  });

  it("treats a command exit as execution rather than inventing a failure", () => {
    window.localStorage.setItem("pi-process-display-mode", "codex");
    window.localStorage.setItem("pi-locale", "zh-CN");
    const command = "rg missing-pattern src";
    const view = render(
      <I18nProvider>
        <div className="transcript-scroll">
          <ProcessGroup blocks={[namedTool("bash", "probe", { command }, "error", 2)]} isStreaming={false} />
        </div>
      </I18nProvider>,
    );

    fireEvent.click(view.container.querySelector<HTMLButtonElement>(".group\\/summary")!);
    const row = view.container.querySelector<HTMLElement>(".codex-process-flow > .codex-tool-row")!;
    expect(row.classList.contains("is-error")).toBe(false);
    expect(row.querySelector(".codex-tool-row-label")?.textContent).toBe("已搜索 missing-pattern");
    expect(row.textContent).not.toContain("失败");

    fireEvent.click(row.querySelector<HTMLButtonElement>(".codex-tool-row-trigger")!);
    act(() => { vi.advanceTimersByTime(20); });
    expect(row.querySelector(".codex-tool-details")?.classList.contains("is-error")).toBe(false);
  });

  it("caps a mixed group summary at three actions and keeps running work visible", () => {
    window.localStorage.setItem("pi-process-display-mode", "codex");
    window.localStorage.setItem("pi-locale", "zh-CN");
    const view = render(
      <I18nProvider>
        <div className="transcript-scroll">
          <ProcessGroup
            blocks={[
              namedTool("write", "edit", { path: "/x/a.ts", content: "changed" }),
              namedTool("delete", "delete", { path: "/x/old.ts", patchText: "*** Delete File: /x/old.ts" }),
              namedTool("search", "search", { pattern: "token" }),
              namedTool("read", "read", { path: "/x/a.ts" }),
              namedTool("bash", "command", { command: "npm test" }, "running"),
            ]}
            isStreaming
          />
        </div>
      </I18nProvider>,
    );

    const label = view.container.querySelector<HTMLElement>(".codex-tool-group-label")!;
    expect(label.textContent).toBe("编辑了文件删除了文件，正在运行命令");
    expect(label.textContent).not.toContain("搜索");
    expect(label.textContent).not.toContain("读取");
  });

  it("keeps each command in expanded rows when a small group contains multiple commands", () => {
    window.localStorage.setItem("pi-process-display-mode", "codex");
    window.localStorage.setItem("pi-locale", "zh-CN");
    const view = render(
      <I18nProvider>
        <div className="transcript-scroll">
          <ProcessGroup
            blocks={[
              namedTool("bash", "test", { command: "npm test" }, "success", 57),
              namedTool("bash", "script", { command: "node --input-type=module -" }),
              namedTool("bash", "checks", { command: "npm run check:architecture" }, "success", 1),
            ]}
            isStreaming={false}
          />
        </div>
      </I18nProvider>,
    );

    fireEvent.click(view.container.querySelector<HTMLButtonElement>('button[aria-expanded]')!);
    const group = view.container.querySelector<HTMLElement>(".codex-tool-group")!;
    expect(group.querySelector(".codex-tool-group-label")?.textContent).toBe("运行了命令");
    fireEvent.click(group.querySelector<HTMLButtonElement>(".codex-tool-group-trigger")!);
    expect(Array.from(group.querySelectorAll(".codex-tool-row-label"), (row) => row.textContent)).toEqual([
      "已在 57s 内运行 npm test",
      "已运行 node --input-type=module -",
      "已在 1s 内运行 npm run check:architecture",
    ]);
  });

  it("uses action summaries for ordinary reads and image copy for a production read result", () => {
    window.localStorage.setItem("pi-process-display-mode", "codex");
    window.localStorage.setItem("pi-locale", "zh-CN");
    const imageTool = namedTool("read", "image", { path: "/tmp/screenshot.png" });
    if (imageTool.type !== "toolCall") throw new Error("expected tool block");
    imageTool.result = {
      role: "toolResult",
      toolCallId: "image",
      content: [{ type: "image", source: { type: "url", url: "https://example.test/screenshot.png" } }],
      isError: false,
      timestamp: 1,
    };
    const view = render(
      <I18nProvider>
        <div className="transcript-scroll">
          <ProcessGroup
            blocks={[
              namedTool("read", "read", { path: "/x/a.ts" }),
              { id: "boundary", type: "text", text: "下一步", origin: { phase: "process", placement: "standalone", sourceMessageIndex: 1 } },
              imageTool,
            ]}
            isStreaming={false}
          />
        </div>
      </I18nProvider>,
    );

    fireEvent.click(view.container.querySelector<HTMLButtonElement>('button[aria-expanded]')!);
    const rows = view.container.querySelectorAll<HTMLElement>(".codex-process-flow > .codex-tool-row");
    expect(view.container.querySelectorAll(".codex-tool-group")).toHaveLength(0);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector(".codex-tool-row-label")?.textContent).toBe("已读取 a.ts");
    expect(rows[1]!.querySelector(".codex-tool-row-label")?.textContent).toBe("已查看 1 张图像");
  });

  it("renders a completed image-only group as one counted thumbnail strip", () => {
    window.localStorage.setItem("pi-process-display-mode", "codex");
    window.localStorage.setItem("pi-locale", "zh-CN");
    const urls = Array.from({ length: 5 }, (_, index) => `https://example.test/${index + 1}.png`);
    const view = render(
      <I18nProvider>
        <div className="transcript-scroll">
          <ProcessGroup
            blocks={urls.map((url, index) => imageResultTool(`image-${index + 1}`, url))}
            isStreaming={false}
          />
        </div>
      </I18nProvider>,
    );

    fireEvent.click(view.container.querySelector<HTMLButtonElement>('button[aria-expanded]')!);
    const group = view.container.querySelector<HTMLElement>(".codex-tool-group")!;
    expect(group.dataset.imageCount).toBe("5");
    expect(group.querySelector(".codex-tool-group-label")?.textContent).toBe("已查看 5 张图像");
    fireEvent.click(group.querySelector<HTMLButtonElement>(".codex-tool-group-trigger")!);
    expect(Array.from(group.querySelectorAll<HTMLImageElement>(".codex-image-strip img"), (image) => image.src)).toEqual(urls);
    expect(group.querySelector(".codex-tool-row")).toBeNull();
  });

  it("keeps mixed image and non-image calls in the ordinary tool-row structure", () => {
    window.localStorage.setItem("pi-process-display-mode", "codex");
    window.localStorage.setItem("pi-locale", "zh-CN");
    const view = render(
      <I18nProvider>
        <div className="transcript-scroll">
          <ProcessGroup
            blocks={[
              imageResultTool("image", "https://example.test/image.png"),
              namedTool("read", "read", { path: "/x/a.ts" }),
            ]}
            isStreaming={false}
          />
        </div>
      </I18nProvider>,
    );

    fireEvent.click(view.container.querySelector<HTMLButtonElement>('button[aria-expanded]')!);
    const group = view.container.querySelector<HTMLElement>(".codex-tool-group")!;
    expect(group.dataset.imageCount).toBeUndefined();
    expect(group.querySelector(".codex-tool-group-label")?.textContent).toBe("已查看图像读取文件");
    fireEvent.click(group.querySelector<HTMLButtonElement>(".codex-tool-group-trigger")!);
    expect(group.querySelectorAll(".codex-tool-row")).toHaveLength(2);
    expect(group.querySelector(".codex-image-strip")).toBeNull();
  });

  it("keeps custom and image entries in source order beside a single adjacent tool", () => {
    window.localStorage.setItem("pi-process-display-mode", "codex");
    const origin = { phase: "process", placement: "standalone", sourceMessageIndex: 1 } as const;
    const blocks: ProcessContentBlock[] = [
      tool("success", "tool-only", "/x/a.ts"),
      {
        id: "event",
        type: "custom",
        customType: "notice",
        message: { role: "custom", customType: "notice", content: "event", display: true },
        origin,
      },
      {
        id: "image",
        type: "image",
        source: { type: "url", url: "https://example.test/image.png" },
        origin,
      },
    ];
    const view = render(
      <I18nProvider>
        <div className="transcript-scroll">
          <ProcessGroup blocks={blocks} isStreaming={false} />
        </div>
      </I18nProvider>,
    );

    fireEvent.click(view.container.querySelector<HTMLButtonElement>('button[aria-expanded]')!);
    const group = view.container.querySelector<HTMLElement>(".codex-tool-group")!;
    expect(group.dataset.toolCount).toBe("1");
    fireEvent.click(group.querySelector<HTMLButtonElement>(".codex-tool-group-trigger")!);

    const items = group.querySelector<HTMLElement>(".codex-tool-group-items")!;
    expect(Array.from(items.children).map((element) => {
      if (element instanceof HTMLElement && element.dataset.toolId) return element.dataset.toolId;
      if (element.classList.contains("codex-custom-group")) return "event";
      if (element.classList.contains("codex-process-image")) return "image";
      return "unknown";
    })).toEqual(["tool-only", "event", "image"]);
    expect(items.querySelector(".codex-custom-group .codex-tool-group-label")?.textContent).toBe("Event updated");
  });
});
