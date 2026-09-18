import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSmoothStream } from "./useSmoothStream";

/**
 * The smoother reveals chars from a rAF loop whose clock references are
 * performance.now(). Drive everything deterministically: fake setTimeout AND
 * performance, and route requestAnimationFrame through the faked timer.
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  vi.stubGlobal(
    "requestAnimationFrame",
    (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as unknown as number,
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useSmoothStream", () => {
  it("shows the initial content immediately (no smoothing on first paint)", () => {
    const { result } = renderHook(() => useSmoothStream("hello", true));
    expect(result.current).toBe("hello");
  });

  it("reveals appended characters gradually and completes after the input settles", () => {
    const { result, rerender } = renderHook(({ text }: { text: string }) => useSmoothStream(text, true), {
      initialProps: { text: "ab" },
    });
    rerender({ text: "abcdef" });

    // First frames only establish the frame baseline; the reveal is held back
    // while input is considered active (target buffer of a few chars).
    act(() => { vi.advanceTimersByTime(64); });
    expect(result.current.length).toBeGreaterThanOrEqual(2);
    expect(result.current.length).toBeLessThan(6);

    // Input has now been idle well past the settle window: the backlog drains.
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(result.current).toBe("abcdef");
  });

  it("flushes instantly when the stream content is rewritten (not append-only)", () => {
    const { result, rerender } = renderHook(({ text }: { text: string }) => useSmoothStream(text, true), {
      initialProps: { text: "old text" },
    });
    rerender({ text: "brand new" });
    expect(result.current).toBe("brand new");
  });

  it("passes through immediately when disabled", () => {
    const { result, rerender } = renderHook(({ text }: { text: string }) => useSmoothStream(text, false), {
      initialProps: { text: "ab" },
    });
    rerender({ text: "abcdef" });
    expect(result.current).toBe("abcdef");
  });

  it("caps mobile React publishes while leaving the animation frame loop running", () => {
    const target = `a${"b".repeat(39)}`;
    const { result, rerender } = renderHook(
      ({ text }: { text: string }) => useSmoothStream(text, true, { minFrameIntervalMs: 32 }),
      { initialProps: { text: "a" } },
    );

    rerender({ text: target });
    act(() => { vi.advanceTimersByTime(32); });
    expect(result.current).toBe("a");

    act(() => { vi.advanceTimersByTime(16); });
    expect(result.current.length).toBeGreaterThan(1);
    expect(target.startsWith(result.current)).toBe(true);
  });
});
