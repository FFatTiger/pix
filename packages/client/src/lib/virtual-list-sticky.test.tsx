/**
 * useVirtualList — stick-to-bottom lifecycle (the transcript's ONLY scroll
 * owner).
 *
 * The default transcript view is the conversation bottom: the first layout
 * pass pins the bottom edge, content growth / viewport changes keep it pinned
 * while the user is at it, an upward scroll releases the pin, and
 * `scrollToBottom()` (return-to-bottom affordance) re-pins it so a single
 * click survives later row measurements.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { installVirtualization, restoreVirtualization, type VirtualizationEnv } from "./testing/virtualization";
import { useVirtualList } from "./virtual-list";

const VIEWPORT = 600;

function keys(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `row-${index}`);
}

function Probe({
  count,
  resetKey,
  stick = true,
  onReady,
}: {
  count: number;
  resetKey?: string;
  stick?: boolean;
  onReady?: (api: { scrollToBottom: () => void }) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const items = keys(count);
  const virtualizer = useVirtualList({
    count,
    getScrollElement: () => parentRef.current,
    getItemKey: (index) => items[index]!,
    estimateSize: () => 100,
    overscan: 0,
    stickToBottom: stick,
    ...(resetKey === undefined ? {} : { stickToBottomKey: resetKey }),
  });
  onReady?.({ scrollToBottom: virtualizer.scrollToBottom });
  return (
    <div ref={parentRef} data-testid="scroll">
      <div style={{ height: virtualizer.totalSize }}>
        {virtualizer.items.map((item) => (
          <div key={item.key} data-index={item.index} ref={virtualizer.measureElement} />
        ))}
      </div>
    </div>
  );
}

/** Fixed 100px rows → scrollHeight for a given row count. */
const heightOf = (count: number): number => count * 100;

/** The exact clamped content bottom the hook must write (never rely on the
 * browser clamping scrollTop). */
const bottomOf = (height: number): number => Math.max(0, height - VIEWPORT);

describe("useVirtualList — stick to bottom", () => {
  let env: VirtualizationEnv;
  let api: { scrollToBottom: () => void };

  afterEach(() => {
    cleanup();
    restoreVirtualization();
  });

  /** Mount a probe with a synthetic viewport and matching content height. */
  function mount(count: number, resetKey = "s1"): ReturnType<typeof render> {
    const view = render(
      <Probe count={count} resetKey={resetKey} onReady={(next) => { api = next; }} />,
    );
    const scroll = view.getByTestId("scroll") as HTMLDivElement;
    env.setClientHeight(scroll, VIEWPORT);
    env.setScrollHeight(scroll, heightOf(count));
    act(() => env.fireViewport(scroll));
    return view;
  }

  /** Re-render with a new row count AND its content height in one commit. */
  function grow(view: ReturnType<typeof render>, count: number, resetKey = "s1"): void {
    const scroll = view.getByTestId("scroll") as HTMLDivElement;
    env.setScrollHeight(scroll, heightOf(count));
    view.rerender(<Probe count={count} resetKey={resetKey} onReady={(next) => { api = next; }} />);
  }

  /** Simulate a late ResizeObserver measurement landing on mounted rows. */
  function measure(view: ReturnType<typeof render>, rowHeight: number): void {
    const scroll = view.getByTestId("scroll") as HTMLDivElement;
    const rows = Array.from(scroll.querySelectorAll<HTMLElement>("[data-index]"));
    act(() => {
      for (const row of rows) env.measureRow(row, rowHeight);
    });
  }

  it("pins the bottom on first layout and keeps it through row measurement settling", () => {
    env = installVirtualization();
    const view = mount(20);
    const scroll = view.getByTestId("scroll") as HTMLDivElement;
    // Default view: the bottom edge, not the top rows.
    expect(scroll.scrollTop).toBe(bottomOf(heightOf(20)));

    // A late real measurement changes every mounted row height (totalSize
    // shifts) — the pin must follow the new bottom, not strand the viewport.
    env.setScrollHeight(scroll, heightOf(20) + 400);
    measure(view, 120);
    expect(scroll.scrollTop).toBe(bottomOf(heightOf(20) + 400));
  });

  it("keeps the bottom pinned while content grows at the bottom", () => {
    env = installVirtualization();
    const view = mount(20);
    grow(view, 22);
    expect(view.getByTestId("scroll").scrollTop).toBe(bottomOf(heightOf(22)));
  });

  it("keeps the pin when a streaming row grows before its measurement settles", () => {
    env = installVirtualization();
    const view = mount(20);
    const scroll = view.getByTestId("scroll") as HTMLDivElement;
    const previousBottom = scroll.scrollTop;

    // Mobile WebKit can dispatch a stationary scroll event after the DOM row
    // grows: scrollHeight is already live, while ResizeObserver has not yet
    // updated the virtual size. This is layout movement, not a user scroll-up.
    env.setScrollHeight(scroll, heightOf(20) + 300);
    act(() => env.setScrollTop(scroll, previousBottom));
    measure(view, 115);

    expect(scroll.scrollTop).toBe(bottomOf(heightOf(20) + 300));
  });

  it("never pulls the viewport down once the user scrolls up", () => {
    env = installVirtualization();
    const view = mount(20);
    const scroll = view.getByTestId("scroll") as HTMLDivElement;
    act(() => env.setScrollTop(scroll, 500)); // user scroll → releases the pin
    grow(view, 24);
    expect(scroll.scrollTop).toBe(500);
  });

  it("scrollToBottom re-pins from anywhere and survives a follow-up layout change (one click)", () => {
    env = installVirtualization();
    const view = mount(20);
    const scroll = view.getByTestId("scroll") as HTMLDivElement;
    act(() => env.setScrollTop(scroll, 120)); // user is far above the bottom
    act(() => api.scrollToBottom());
    expect(scroll.scrollTop).toBe(bottomOf(heightOf(20)));

    // Virtualizer/ResizeObserver work lands AFTER the click — the viewport
    // stays at the real content bottom, no second click needed.
    env.setScrollHeight(scroll, heightOf(20) + 300);
    measure(view, 115);
    expect(scroll.scrollTop).toBe(bottomOf(heightOf(20) + 300));
  });

  it("re-pins once when the transcript identity changes, and not when it only grows", () => {
    env = installVirtualization();
    const view = mount(20);
    const scroll = view.getByTestId("scroll") as HTMLDivElement;
    act(() => env.setScrollTop(scroll, 400)); // user is reading above the bottom

    // Same conversation growing: the user's position is preserved.
    grow(view, 21);
    expect(scroll.scrollTop).toBe(400);

    // Identity switch (session/branch): reposition once to the new bottom.
    view.rerender(<Probe count={21} resetKey="s2" onReady={(next) => { api = next; }} />);
    expect(scroll.scrollTop).toBe(bottomOf(heightOf(21)));
    act(() => env.setScrollTop(scroll, 100));
    view.rerender(<Probe count={21} resetKey="s2" onReady={(next) => { api = next; }} />);
    expect(scroll.scrollTop).toBe(100); // same key never re-pins again
  });

  it("releases the pin on a 1px upward move: later growth never drags the user back", () => {
    env = installVirtualization();
    const view = mount(20);
    const scroll = view.getByTestId("scroll") as HTMLDivElement;
    const bottom = bottomOf(heightOf(20));
    expect(scroll.scrollTop).toBe(bottom);

    // 1px up from the exact bottom: distance is inside the 8px tolerance, but
    // the DIRECTION is upward → the pin is released immediately.
    act(() => env.setScrollTop(scroll, bottom - 1));
    grow(view, 24); // delayed growth must not pull the user back down
    expect(scroll.scrollTop).toBe(bottom - 1);

    // ...and a further small upward move inside the tolerance stays released.
    act(() => env.setScrollTop(scroll, bottom - 6));
    grow(view, 26);
    expect(scroll.scrollTop).toBe(bottom - 6);

    // Scrolling back DOWN to the exact bottom re-pins: growth follows again.
    grow(view, 20);
    act(() => env.setScrollTop(scroll, bottomOf(heightOf(20))));
    grow(view, 22);
    expect(scroll.scrollTop).toBe(bottomOf(heightOf(22)));
  });

  it("releases the pin when stickiness is disabled (other list types)", () => {
    env = installVirtualization();
    const view = render(
      <Probe stick={false} count={20} onReady={(next) => { api = next; }} />,
    );
    const scroll = view.getByTestId("scroll") as HTMLDivElement;
    env.setClientHeight(scroll, VIEWPORT);
    env.setScrollHeight(scroll, heightOf(20));
    act(() => env.fireViewport(scroll));
    expect(scroll.scrollTop).toBe(0); // never auto-scrolled
  });
});
