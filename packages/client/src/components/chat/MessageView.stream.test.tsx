import { describe, it, expect, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MessageView } from "./MessageView";
import { I18nProvider } from "@/hooks/useI18n";
import { STREAM_FADE_DURATION_MS } from "@/lib/rehype-stream-fade";

describe("MessageView streaming fade (UI-first)", () => {
  it("wraps newly streamed characters for fade-in", () => {
    render(
      <I18nProvider>
        <MessageView
          message={{ role: "assistant", content: [{ type: "text", text: "hello streaming" }], model: "m", provider: "p" } as never}
          isStreaming
          toolResults={new Map()}
          cwd="/x"
          onOpenFile={undefined}
        />
      </I18nProvider>,
    );
    expect(document.querySelectorAll(".stream-char").length).toBeGreaterThan(0);
    expect(document.querySelector(".markdown-body.is-streaming")).toBeTruthy();
  });

  it("settles the same assistant immediately and releases its markdown fade within the hold duration", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const message = { role: "assistant", content: [{ type: "text", text: "stream then settle" }], model: "m", provider: "p" } as const;
    const view = (isStreaming: boolean) => (
      <I18nProvider>
        <MessageView message={message as never} isStreaming={isStreaming} toolResults={new Map()} cwd="/x" />
      </I18nProvider>
    );
    const mounted = render(view(true));
    try {
      expect(mounted.container.querySelector(".chat-assistant-message.is-streaming")).toBeTruthy();
      mounted.rerender(view(false));
      expect(mounted.container.querySelector(".chat-assistant-message.is-streaming")).toBeNull();
      act(() => vi.advanceTimersByTime(STREAM_FADE_DURATION_MS));
      expect(mounted.container.querySelector(".markdown-body.is-streaming")).toBeNull();
    } finally {
      mounted.unmount();
      vi.useRealTimers();
    }
  });

  it("does NOT fade non-streaming text blocks", () => {
    render(
      <I18nProvider>
        <MessageView
          message={{ role: "assistant", content: [{ type: "text", text: "settled answer" }], model: "m", provider: "p" } as never}
          toolResults={new Map()}
          cwd="/x"
          onOpenFile={undefined}
        />
      </I18nProvider>,
    );
    expect(screen.getByText("settled answer")).toBeTruthy();
    expect(document.querySelector(".stream-char")).toBeNull();
    expect(document.querySelector(".markdown-body.is-streaming")).toBeNull();
  });
});
