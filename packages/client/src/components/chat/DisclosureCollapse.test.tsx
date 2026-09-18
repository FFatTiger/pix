import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { DISCLOSURE_TRANSITION_MS, DisclosureCollapse } from "./DisclosureCollapse";

describe("DisclosureCollapse presence lifecycle", () => {
  let nextFrame = 1;
  let frames: Map<number, FrameRequestCallback>;

  beforeEach(() => {
    vi.useFakeTimers();
    frames = new Map();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function flushFrames(): void {
    const pending = [...frames.values()];
    frames.clear();
    act(() => pending.forEach((callback) => callback(0)));
  }

  it("cancels a stale exit timer when reopened and restores accessibility immediately", () => {
    const view = render(<DisclosureCollapse open>content</DisclosureCollapse>);
    view.rerender(<DisclosureCollapse open={false}>content</DisclosureCollapse>);

    const closing = view.container.querySelector<HTMLElement>(".disclosure-collapse")!;
    expect(closing.dataset.state).toBe("closed");
    expect(closing.getAttribute("aria-hidden")).toBe("true");
    expect(closing.hasAttribute("inert")).toBe(true);
    act(() => { vi.advanceTimersByTime(DISCLOSURE_TRANSITION_MS - 1); });

    view.rerender(<DisclosureCollapse open>content</DisclosureCollapse>);
    const reopened = view.container.querySelector<HTMLElement>(".disclosure-collapse")!;
    expect(reopened.getAttribute("aria-hidden")).toBe("false");
    expect(reopened.hasAttribute("inert")).toBe(false);
    flushFrames();
    expect(reopened.dataset.state).toBe("open");

    act(() => { vi.advanceTimersByTime(DISCLOSURE_TRANSITION_MS + 1); });
    expect(view.getByText("content")).toBeTruthy();
  });

  it("cancels a pending open frame when closed before the next paint", () => {
    const view = render(<DisclosureCollapse open={false}>content</DisclosureCollapse>);
    view.rerender(<DisclosureCollapse open>content</DisclosureCollapse>);
    expect(view.container.querySelector<HTMLElement>(".disclosure-collapse")?.dataset.state).toBe("closed");

    view.rerender(<DisclosureCollapse open={false}>content</DisclosureCollapse>);
    expect(frames.size).toBe(0);
    flushFrames();
    expect(view.container.querySelector<HTMLElement>(".disclosure-collapse")?.dataset.state).toBe("closed");

    act(() => { vi.advanceTimersByTime(DISCLOSURE_TRANSITION_MS); });
    expect(view.container.querySelector(".disclosure-collapse")).toBeNull();
  });

  it("clears pending frames and timers on unmount", () => {
    const opening = render(<DisclosureCollapse open={false}>content</DisclosureCollapse>);
    opening.rerender(<DisclosureCollapse open>content</DisclosureCollapse>);
    expect(frames.size).toBe(1);
    opening.unmount();
    expect(frames.size).toBe(0);

    const closing = render(<DisclosureCollapse open>content</DisclosureCollapse>);
    closing.rerender(<DisclosureCollapse open={false}>content</DisclosureCollapse>);
    expect(vi.getTimerCount()).toBe(1);
    closing.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
