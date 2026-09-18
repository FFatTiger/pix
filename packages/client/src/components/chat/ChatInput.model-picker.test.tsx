import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/hooks/useI18n";
import { ChatInput } from "./ChatInput";

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

describe("ChatInput mobile model picker", () => {
  const scrollIntoView = vi.fn();

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
      matches: true,
      media: "(max-width: 640px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
  });

  afterEach(() => {
    cleanup();
    scrollIntoView.mockReset();
    vi.unstubAllGlobals();
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("opens without focusing search and reveals the current model by default", () => {
    const onModelChange = vi.fn();
    const view = render(
      <I18nProvider>
        <ChatInput
          onSend={() => true}
          onAbort={() => {}}
          isStreaming={false}
          model={{ provider: "provider-b", modelId: "current" }}
          modelList={[
            { provider: "provider-a", id: "other", name: "Other model" },
            { provider: "provider-b", id: "current", name: "Current model" },
          ]}
          onModelChange={onModelChange}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByLabelText("Change model"));

    const search = screen.getByLabelText(/Search models/) as HTMLInputElement;
    const currentRow = view.container.querySelector<HTMLElement>('[data-current-model="true"]');
    expect(document.activeElement).not.toBe(search);
    expect(search.style.fontSize).toBe("16px");
    expect(currentRow?.textContent).toContain("Current model");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    expect(onModelChange).not.toHaveBeenCalled();
  });
});
