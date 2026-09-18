import { useSyncExternalStore } from "react";
import { getUiScale } from "@/lib/ui-scale";

export interface VisualViewportFrame {
  height: number;
  offsetTop: number;
  keyboardOpen: boolean;
}

let cachedFrameKey = "";
let cachedFrame: VisualViewportFrame | null = null;

const KEYBOARD_OCCLUSION_THRESHOLD = 120;

function isEditableElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  return element.matches("input, textarea, [contenteditable='true']");
}

function normalizedFrame(
  height: number,
  offsetTop: number,
  scale: number,
  layoutHeight: number,
  editableFocused: boolean,
): VisualViewportFrame | null {
  if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(scale) || scale <= 0) return null;
  const normalizedHeight = Math.max(1, Math.round(height / scale));
  const normalizedOffsetTop = Number.isFinite(offsetTop) ? Math.max(0, Math.round(offsetTop / scale)) : 0;
  const occludedHeight = Number.isFinite(layoutHeight)
    ? layoutHeight - (height + Math.max(0, offsetTop))
    : 0;
  const keyboardOpen = editableFocused && occludedHeight >= KEYBOARD_OCCLUSION_THRESHOLD;
  const key = `${normalizedHeight}:${normalizedOffsetTop}:${keyboardOpen ? 1 : 0}`;
  if (key === cachedFrameKey) return cachedFrame;
  cachedFrameKey = key;
  cachedFrame = { height: normalizedHeight, offsetTop: normalizedOffsetTop, keyboardOpen };
  return cachedFrame;
}

/** Current visible viewport frame in the app's pre-zoom CSS coordinate space. */
export function getCurrentVisualViewportFrame(): VisualViewportFrame | null {
  if (typeof window === "undefined") return null;
  const viewport = window.visualViewport;
  return normalizedFrame(
    viewport?.height ?? window.innerHeight,
    viewport?.offsetTop ?? 0,
    getUiScale(),
    window.innerHeight,
    isEditableElement(document.activeElement),
  );
}

/** Current visible viewport height in the app's pre-zoom CSS coordinate space. */
export function getCurrentVisualViewportHeight(): number | null {
  return getCurrentVisualViewportFrame()?.height ?? null;
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const viewport = window.visualViewport;
  window.addEventListener("resize", onChange);
  document.addEventListener("focusin", onChange);
  document.addEventListener("focusout", onChange);
  viewport?.addEventListener("resize", onChange);
  viewport?.addEventListener("scroll", onChange);
  return () => {
    window.removeEventListener("resize", onChange);
    document.removeEventListener("focusin", onChange);
    document.removeEventListener("focusout", onChange);
    viewport?.removeEventListener("resize", onChange);
    viewport?.removeEventListener("scroll", onChange);
  };
}

function getServerSnapshot(): null {
  return null;
}

/**
 * Tracks the iOS/Android visual viewport so the app occupies the exact visible
 * frame while the software keyboard is open. `offsetTop` is required on iOS:
 * Safari can pan the visual viewport as it shrinks, and sizing from layout top
 * would otherwise move the composer upward a second time.
 */
export function useVisualViewportFrame(): VisualViewportFrame | null {
  return useSyncExternalStore(subscribe, getCurrentVisualViewportFrame, getServerSnapshot);
}
