/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ExtensionNotificationItem } from "@fffattiger/pix-protocol";
import { I18nProvider } from "@/hooks/useI18n";
import { ExtensionNotices } from "./ExtensionNotices";

const TOAST_AUTO_HIDE_MS = 6000;
const TOAST_FADE_MS = 200;

function notice(message: string, at: number, level: ExtensionNotificationItem["level"] = "info"): ExtensionNotificationItem {
  return { level, message, at };
}

function mount(notices: readonly ExtensionNotificationItem[]) {
  return render(
    <I18nProvider>
      <ExtensionNotices notices={notices} />
    </I18nProvider>,
  );
}

describe("ExtensionNotices", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows only the latest notice, then fades to a quiet re-entry", () => {
    vi.useFakeTimers();
    const view = mount([
      notice("older", 1),
      notice("Ponytail loaded: full", 2),
    ]);

    const toast = screen.getByTestId("extension-notices");
    expect(toast.textContent).toContain("Ponytail loaded: full");
    expect(toast.textContent).not.toContain("older");
    expect(screen.queryByTestId("extension-notices-dot")).toBeNull();

    act(() => { vi.advanceTimersByTime(TOAST_AUTO_HIDE_MS); });
    expect(screen.getByTestId("extension-notices").getAttribute("data-phase")).toBe("fading");
    act(() => { vi.advanceTimersByTime(TOAST_FADE_MS); });
    expect(screen.queryByTestId("extension-notices")).toBeNull();
    expect(screen.getByTestId("extension-notices-dot")).toBeTruthy();

    fireEvent.click(screen.getByTestId("extension-notices-dot"));
    const list = screen.getByTestId("extension-notices-list");
    expect(list.textContent).toContain("Ponytail loaded: full");
    expect(list.textContent).toContain("older");
    const text = list.textContent ?? "";
    expect(text.indexOf("Ponytail loaded: full")).toBeLessThan(text.indexOf("older"));

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("extension-notices-list")).toBeNull();
    expect(screen.getByTestId("extension-notices-dot")).toBeTruthy();

    view.rerender(
      <I18nProvider>
        <ExtensionNotices notices={[notice("older", 1), notice("Ponytail loaded: full", 2), notice("next", 3, "warning")]} />
      </I18nProvider>,
    );
    expect(screen.getByTestId("extension-notices").getAttribute("data-level")).toBe("warning");
    expect(screen.getByTestId("extension-notices").textContent).toContain("next");
  });

  it("keeps long notices visually compact while preserving the full message for accessibility", () => {
    const message = `Smart Compact: ${"continuity warning ".repeat(40)}`;
    mount([notice(message, 1, "warning")]);

    const toast = screen.getByTestId("extension-notices");
    const text = toast.querySelector(".extension-notice-message");
    expect(text).toBeTruthy();
    expect(toast.getAttribute("aria-label")).toBe(message);
    expect(text?.textContent).toBe(message);
    expect(text?.getAttribute("title")).toBe(message);
    // Collapsed = clamped to two lines (visual only; the full text stays in the DOM).
    expect(toast.getAttribute("data-expanded")).toBeNull();
    expect(text?.getAttribute("aria-expanded")).toBe("false");
  });

  it("expands the full message on tap and pauses auto-hide until collapsed", () => {
    vi.useFakeTimers();
    const message = `Smart Compact: ${"continuity warning ".repeat(40)}`;
    mount([notice(message, 1)]);

    const toast = screen.getByTestId("extension-notices");
    const text = toast.querySelector(".extension-notice-message");
    fireEvent.click(text!);
    expect(toast.getAttribute("data-expanded")).toBe("true");
    expect(text?.getAttribute("aria-expanded")).toBe("true");
    expect(text?.textContent).toBe(message);

    // Expanded pauses the fade: the full auto-hide window passes, still visible.
    act(() => { vi.advanceTimersByTime(TOAST_AUTO_HIDE_MS + TOAST_FADE_MS); });
    expect(screen.getByTestId("extension-notices").getAttribute("data-phase")).toBe("visible");

    // Collapsing re-arms the timer.
    fireEvent.click(text!);
    expect(toast.getAttribute("data-expanded")).toBeNull();
    act(() => { vi.advanceTimersByTime(TOAST_AUTO_HIDE_MS); });
    expect(screen.getByTestId("extension-notices").getAttribute("data-phase")).toBe("fading");
    act(() => { vi.advanceTimersByTime(TOAST_FADE_MS); });
    expect(screen.queryByTestId("extension-notices")).toBeNull();
  });

  it("toggles expansion from the keyboard too", () => {
    mount([notice("short notice", 1)]);
    const text = screen.getByTestId("extension-notices").querySelector(".extension-notice-message");
    fireEvent.keyDown(text!, { key: "Enter" });
    expect(screen.getByTestId("extension-notices").getAttribute("data-expanded")).toBe("true");
    fireEvent.keyDown(text!, { key: " " });
    expect(screen.getByTestId("extension-notices").getAttribute("data-expanded")).toBeNull();
  });

  it("copies a notice url and dismisses immediately", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    mount([notice("authorize https://example.test/oauth", 1)]);

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await act(async () => { await Promise.resolve(); });
    expect(writeText).toHaveBeenCalledWith("https://example.test/oauth");
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    act(() => { vi.advanceTimersByTime(TOAST_FADE_MS); });
    expect(screen.queryByTestId("extension-notices")).toBeNull();
    expect(screen.getByTestId("extension-notices-dot")).toBeTruthy();
  });

  it("renders nothing when there are no notices", () => {
    mount([]);
    expect(screen.queryByTestId("extension-notices")).toBeNull();
    expect(screen.queryByTestId("extension-notices-dot")).toBeNull();
  });
});
