import { type ComponentPropsWithRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@/hooks/useI18n";
import { ChatInput } from "./ChatInput";
import { getDraft, clearDraft } from "@/lib/draft-store";

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

type InputProps = Partial<ComponentPropsWithRef<typeof ChatInput>>;

function inputTree(props: InputProps = {}) {
  return (
    <I18nProvider>
      <ChatInput
        onSend={() => true}
        onAbort={() => {}}
        isStreaming={false}
        {...props}
      />
    </I18nProvider>
  );
}

function renderInput(props: InputProps = {}) {
  return render(inputTree(props));
}

function textarea(): HTMLTextAreaElement {
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

describe("ChatInput draft identity", () => {
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
    // The draft store keeps an in-memory map next to localStorage.
    for (const key of ["new:/project", "new:/a", "new:/b"]) clearDraft(key);
  });

  it("keeps the typed text when the composer gains a draft key", async () => {
    // The new-session composer has no draft key until a project is picked.
    // The typed text is then the ONLY copy of that draft and must survive the
    // identity change instead of being replaced by the new key's empty draft.
    const view = renderInput({});
    fireEvent.change(textarea(), { target: { value: "keep this draft" } });

    view.rerender(inputTree({ draftKey: "new:/project", cwd: "/project" }));

    await waitFor(() => expect(textarea().value).toBe("keep this draft"));
    // The carried draft is persisted under its new key, so a remount keeps it.
    await waitFor(() => expect(getDraft("new:/project")?.value).toBe("keep this draft"));
  });

  it("restores the stored draft when the composer was already identified", async () => {
    const view = renderInput({ draftKey: "new:/a" });
    fireEvent.change(textarea(), { target: { value: "draft for a" } });
    await waitFor(() => expect(getDraft("new:/a")?.value).toBe("draft for a"));

    view.rerender(inputTree({ draftKey: "new:/b", cwd: "/b" }));

    // Two identified drafts are two surfaces: the target's own draft wins.
    await waitFor(() => expect(textarea().value).toBe(""));
    expect(getDraft("new:/a")?.value).toBe("draft for a");
  });

  it("restores a stored draft when the composer had nothing typed", async () => {
    const view = renderInput({});
    view.rerender(inputTree({ draftKey: "new:/project", cwd: "/project" }));
    await waitFor(() => expect(textarea().value).toBe(""));
    expect(getDraft("new:/project")).toBeNull();
  });
});
