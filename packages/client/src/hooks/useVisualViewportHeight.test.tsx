import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCurrentVisualViewportFrame,
  getCurrentVisualViewportHeight,
  useVisualViewportFrame,
} from "./useVisualViewportHeight";

class VisualViewportStub extends EventTarget {
  height: number;
  offsetTop: number;

  constructor(height: number, offsetTop = 0) {
    super();
    this.height = height;
    this.offsetTop = offsetTop;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty("zoom");
});

describe("visual viewport height", () => {
  it("uses the software-keyboard viewport and converts it into pre-zoom CSS pixels", () => {
    const viewport = new VisualViewportStub(600, 125);
    vi.stubGlobal("visualViewport", viewport as unknown as VisualViewport);
    vi.spyOn(window, "getComputedStyle").mockReturnValue({ zoom: "1.25" } as CSSStyleDeclaration);

    expect(getCurrentVisualViewportHeight()).toBe(480);
    expect(getCurrentVisualViewportFrame()).toEqual({ height: 480, offsetTop: 100, keyboardOpen: false });
  });

  it("updates when the mobile visual viewport resizes or pans", () => {
    const viewport = new VisualViewportStub(700);
    vi.stubGlobal("visualViewport", viewport as unknown as VisualViewport);
    const { result } = renderHook(() => useVisualViewportFrame());
    expect(result.current).toEqual({ height: 700, offsetTop: 0, keyboardOpen: false });

    act(() => {
      viewport.height = 420;
      viewport.offsetTop = 180;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toEqual({ height: 420, offsetTop: 180, keyboardOpen: false });

    act(() => {
      viewport.offsetTop = 220;
      viewport.dispatchEvent(new Event("scroll"));
    });
    expect(result.current).toEqual({ height: 420, offsetTop: 220, keyboardOpen: false });
  });

  it("reports the keyboard only when an editable is focused and the viewport is materially occluded", () => {
    const viewport = new VisualViewportStub(420);
    vi.stubGlobal("visualViewport", viewport as unknown as VisualViewport);
    vi.stubGlobal("innerHeight", 800);
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    const { result } = renderHook(() => useVisualViewportFrame());

    act(() => textarea.focus());
    expect(result.current).toEqual({ height: 420, offsetTop: 0, keyboardOpen: true });

    act(() => textarea.blur());
    expect(result.current).toEqual({ height: 420, offsetTop: 0, keyboardOpen: false });
    textarea.remove();
  });
});
