import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/hooks/useI18n";
import { setStreamingSendMode } from "@/lib/chat-input-preferences";
import { ChatInput } from "./ChatInput";

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function renderStreamingInput() {
  return render(
    <I18nProvider>
      <ChatInput onSend={() => true} onAbort={() => {}} isStreaming />
    </I18nProvider>,
  );
}

function placeholderText(): string {
  return (screen.getByRole("textbox") as HTMLTextAreaElement).placeholder;
}

describe("ChatInput streaming placeholder", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("pi-locale", "en");
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("describes queuing when Enter is set to queue", () => {
    window.localStorage.setItem("pi-streaming-send-mode", "follow-up");
    renderStreamingInput();
    expect(placeholderText()).toBe("Add a message; it sends when this turn ends");
  });

  it("describes steering when Enter is set to steer", () => {
    window.localStorage.setItem("pi-streaming-send-mode", "steer");
    renderStreamingInput();
    expect(placeholderText()).toBe("Add a message — inserted after the current step");
  });

  it("follows a setting change made elsewhere on the page", () => {
    window.localStorage.setItem("pi-streaming-send-mode", "follow-up");
    renderStreamingInput();
    expect(placeholderText()).toBe("Add a message; it sends when this turn ends");

    act(() => setStreamingSendMode("steer"));
    expect(placeholderText()).toBe("Add a message — inserted after the current step");
  });
});
