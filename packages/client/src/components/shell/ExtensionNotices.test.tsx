/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ExtensionNotificationItem } from "@fffattiger/pix-protocol";
import { I18nProvider } from "@/hooks/useI18n";
import { ExtensionNotices } from "./ExtensionNotices";

const TOAST_AUTO_HIDE_MS = 4000;
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

  it("is a fixed one-line note that takes no input; links live in the bell history", () => {
    vi.useFakeTimers();
    const message = `Lore connected: https://api.loremem.com ${"continuity warning ".repeat(20)}`;
    mount([notice(message, 1, "warning")]);
    const toast = screen.getByTestId("extension-notices");
    expect(toast.getAttribute("aria-label")).toBe(message);
    expect(toast.querySelectorAll("button, a, [role=button]")).toHaveLength(0);
    act(() => { vi.advanceTimersByTime(TOAST_AUTO_HIDE_MS + TOAST_FADE_MS); });
    fireEvent.click(screen.getByTestId("extension-notices-dot"));
    const link = screen.getByTestId("extension-notices-list").querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://api.loremem.com");
  });

  it("renders the localized custom-panel notice instead of its wire marker line", () => {
    window.localStorage.setItem("pi-locale", "zh-CN");
    const withCommand = notice("[pix:ui-custom-unsupported] smart-compact", 1);
    const withoutCommand = notice("[pix:ui-custom-unsupported]", 2);
    mount([withCommand]);
    expect(screen.getByTestId("extension-notices").textContent).toBe(
      "/smart-compact：此插件功能需要终端界面，网页端不支持，可在终端 pi 中使用。",
    );
    cleanup();
    window.localStorage.setItem("pi-locale", "en");
    mount([withCommand]);
    expect(screen.getByTestId("extension-notices").textContent).toBe(
      "/smart-compact: this plugin feature needs a terminal UI, which the web app does not support. Use it in the terminal pi.",
    );
    cleanup();
    mount([withoutCommand]);
    expect(screen.getByTestId("extension-notices").textContent).toBe(
      "This plugin feature needs a terminal UI, which the web app does not support. Use it in the terminal pi.",
    );
    window.localStorage.removeItem("pi-locale");
  });

  it("renders nothing when there are no notices", () => {
    mount([]);
    expect(screen.queryByTestId("extension-notices")).toBeNull();
    expect(screen.queryByTestId("extension-notices-dot")).toBeNull();
  });
});
