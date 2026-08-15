/**
 * Hand-rolled virtualization (UX1 Wave 4) — zero runtime dependencies.
 *
 * Strategy:
 * - Fixed-height estimate + dynamic ResizeObserver measurement. Measured sizes
 *   are keyed by STABLE ITEM IDENTITY (never index), so a background refetch
 *   that preserves item keys keeps measured sizes and total height — no scroll
 *   jump on background invalidate.
 * - Absolute positioning: an inner spacer provides the full scroll height
 *   (`totalSize`); each rendered row is absolutely positioned at
 *   `translateY(start)` inside a `position: relative` scroll container.
 * - Overscan renders extra rows above/below the visible window so keyboard
 *   focus can move across the edge before a row would unmount.
 * - Pinned rows (inline editors, focused rows) stay mounted even when they
 *   scroll outside the window — required by the D4 rename/delete editors.
 * - Render-all fallback: when ResizeObserver is unavailable (jsdom tests, SSR)
 *   the list degrades to rendering every row in normal flow. This keeps
 *   small-list component tests fully compatible with the pre-virtualization DOM.
 *   (A hidden container that still has ResizeObserver windows with viewport 0,
 *   rendering a cheap minimal top window until it becomes measurable.)
 * - Optional stick-to-bottom for streaming transcripts (bottom-pinned while the
 *   user is at the bottom; scrolling up releases the pin).
 */

import { useCallback, useLayoutEffect, useRef, useState } from "react";

export interface VirtualItem<K> {
  key: K;
  index: number;
  start: number;
  size: number;
}

/**
 * Pure window computation, exported for deterministic unit tests. Computes the
 * total content height and the exact set of rows that must be mounted for a
 * given scroll position and viewport.
 */
export interface VirtualWindowOptions {
  count: number;
  /** Per-index row height (measured size or estimate). Must be finite/positive. */
  sizeAt: (index: number) => number;
  scrollTop: number;
  viewport: number;
  overscan: number;
  /** Indexes that must stay mounted even when outside the visible window. */
  pinned: ReadonlySet<number>;
}

export interface VirtualWindow {
  totalSize: number;
  items: Array<{ index: number; start: number; size: number }>;
}

export function computeVirtualWindow(options: VirtualWindowOptions): VirtualWindow {
  const { count, sizeAt, scrollTop, viewport, overscan, pinned } = options;
  if (count <= 0) return { totalSize: 0, items: [] };

  const offsets = new Array<number>(count + 1);
  offsets[0] = 0;
  for (let index = 0; index < count; index++) {
    offsets[index + 1] = offsets[index]! + sizeAt(index);
  }
  const totalSize = offsets[count]!;

  let from: number;
  let to: number;
  if (viewport <= 0) {
    // Viewport not measured yet (first render in a browser before layout, or a
    // hidden container). Render a cheap minimal top window — the layout effect
    // measures the real viewport before the browser paints.
    from = 0;
    to = Math.min(count - 1, overscan);
  } else {
    // First visible index: smallest i whose row end (offsets[i+1]) is past scrollTop.
    let startIndex = count - 1;
    if (totalSize > 0 && scrollTop < totalSize) {
      let lo = 0;
      let hi = count - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (offsets[mid + 1]! > scrollTop) {
          startIndex = mid;
          hi = mid - 1;
        } else {
          lo = mid + 1;
        }
      }
    }
    // Last visible index: largest i whose row start (offsets[i]) is above the bottom edge.
    const bottom = scrollTop + viewport;
    let endIndex = count - 1;
    {
      let lo = startIndex;
      let hi = count - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (offsets[mid]! < bottom) {
          endIndex = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
    }
    from = Math.max(0, startIndex - overscan);
    to = Math.min(count - 1, endIndex + overscan);
  }

  const items: Array<{ index: number; start: number; size: number }> = [];
  const present = new Set<number>();
  for (let index = from; index <= to; index++) {
    items.push({ index, start: offsets[index]!, size: sizeAt(index) });
    present.add(index);
  }
  if (pinned.size > 0) {
    for (const index of pinned) {
      if (index >= 0 && index < count && !present.has(index)) {
        items.push({ index, start: offsets[index]!, size: sizeAt(index) });
      }
    }
    items.sort((a, b) => a.index - b.index);
  }
  return { totalSize, items };
}

/** Rows within this many pixels of the bottom count as "at bottom". */
const STICKY_TOLERANCE_PX = 8;

export interface UseVirtualListOptions<K> {
  count: number;
  getScrollElement: () => HTMLElement | null;
  getItemKey: (index: number) => K;
  estimateSize: (index: number) => number;
  overscan?: number;
  /** Rows that must remain mounted even when outside the window (by key). */
  pinnedKeys?: readonly K[];
  /** When true, auto-scroll to bottom on content growth while pinned at bottom. */
  stickToBottom?: boolean;
  /** When this value changes, re-pin to bottom (session/live switch). */
  stickToBottomKey?: unknown;
}

export interface UseVirtualListResult<K> {
  /** True when windowing is active; false means render-all (measurement unavailable). */
  windowed: boolean;
  /** Full content height (only meaningful when windowed). */
  totalSize: number;
  /** Rows to render (all rows when not windowed). */
  items: VirtualItem<K>[];
  /** Ref callback for each rendered row. No-op when not windowed. */
  measureElement: (el: Element | null) => void | (() => void);
}

export function useVirtualList<K>(options: UseVirtualListOptions<K>): UseVirtualListResult<K> {
  const {
    count,
    getScrollElement,
    getItemKey,
    estimateSize,
    overscan = 8,
    pinnedKeys = [],
    stickToBottom = false,
    stickToBottomKey,
  } = options;

  // Latest-value refs so observers/effects never close over stale props.
  const getScrollElementRef = useRef(getScrollElement);
  const getItemKeyRef = useRef(getItemKey);
  const estimateSizeRef = useRef(estimateSize);
  const stickToBottomRef = useRef(stickToBottom);
  getScrollElementRef.current = getScrollElement;
  getItemKeyRef.current = getItemKey;
  estimateSizeRef.current = estimateSize;
  stickToBottomRef.current = stickToBottom;

  // Measured sizes by stable item key (identity, not index).
  const sizesRef = useRef<Map<K, number>>(new Map());
  // Mounted row elements by index (needed to observe rows that mount before the
  // ResizeObserver exists, and to keep cleanup stable across renders).
  const elementsRef = useRef<Map<number, HTMLElement>>(new Map());
  const [, setVersion] = useState(0);
  // Browser: window from the very first render so mount never renders all rows.
  // jsdom/SSR: no ResizeObserver => render-all fallback (see requirement 5).
  const [windowed, setWindowed] = useState(() => typeof ResizeObserver !== "undefined");
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);

  const scrollElRef = useRef<HTMLElement | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  // Stick-to-bottom bookkeeping.
  const atBottomRef = useRef(true);
  const lastTotalRef = useRef(0);
  const stickToBottomKeyRef = useRef(stickToBottomKey);

  /** Record a measured row height, bumping version only when it actually changed. */
  const recordSize = (index: number, height: number): void => {
    if (!Number.isFinite(height) || height <= 0) return;
    const key = getItemKeyRef.current(index);
    const current = sizesRef.current.get(key);
    if (current !== undefined && Math.abs(current - height) < 0.5) return;
    sizesRef.current.set(key, height);
    setVersion((version) => version + 1);
  };

  // Attach the scroll listener + ResizeObserver once the scroll element mounts.
  useLayoutEffect(() => {
    const el = getScrollElementRef.current();
    if (!el) return;
    scrollElRef.current = el;

    const onScroll = (): void => {
      setScrollTop(el.scrollTop);
      if (stickToBottomRef.current) {
        atBottomRef.current =
          el.scrollHeight - el.scrollTop - el.clientHeight <= STICKY_TOLERANCE_PX;
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });

    const measurementAvailable = typeof ResizeObserver !== "undefined";
    if (measurementAvailable) {
      setWindowed(true);
      setViewport(el.clientHeight);
      const ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const target = entry.target as HTMLElement;
          const indexAttr = target.dataset.index;
          if (indexAttr !== undefined) {
            const index = Number(indexAttr);
            if (Number.isFinite(index)) {
              // Border-box height (content + padding) so rows with padding
              // (e.g. .transcript-row padding-bottom) are spaced exactly.
              const box = entry.borderBoxSize?.[0];
              const height = box ? box.blockSize : entry.contentRect.height;
              recordSize(index, height);
            }
          } else {
            // The scroll container itself reports viewport height changes.
            setViewport(target.clientHeight);
          }
        }
      });
      ro.observe(el);
      roRef.current = ro;
      // Rows that mounted before the observer existed (first render) must be
      // observed now so their dynamic heights are tracked.
      for (const [index, rowEl] of elementsRef.current) {
        ro.observe(rowEl);
        const height = rowEl.getBoundingClientRect().height;
        if (height > 0) recordSize(index, height);
      }
    } else {
      setWindowed(false);
    }

    return () => {
      el.removeEventListener("scroll", onScroll);
      roRef.current?.disconnect();
      roRef.current = null;
      scrollElRef.current = null;
    };
  }, []);

  // Pinned indexes derived from pinned identity keys (small sets; O(pinned×count)).
  const pinned = new Set<number>();
  if (pinnedKeys.length > 0 && count > 0) {
    for (const key of pinnedKeys) {
      for (let index = 0; index < count; index++) {
        if (getItemKeyRef.current(index) === key) {
          pinned.add(index);
          break;
        }
      }
    }
  }

  const sizeAt = (index: number): number => {
    const key = getItemKeyRef.current(index);
    const measured = sizesRef.current.get(key);
    if (measured !== undefined) return measured;
    const estimated = estimateSizeRef.current(index);
    return Number.isFinite(estimated) && estimated > 0 ? estimated : 1;
  };

  const window = windowed
    ? computeVirtualWindow({
        count,
        sizeAt,
        scrollTop,
        viewport,
        overscan,
        pinned,
      })
    : {
        totalSize: 0,
        items: Array.from({ length: count }, (_, index) => ({
          index,
          start: 0,
          size: sizeAt(index),
        })),
      };
  const totalSize = window.totalSize;

  // Re-pin to bottom when the reset key changes (session/live switch).
  useLayoutEffect(() => {
    if (stickToBottomKey === stickToBottomKeyRef.current) return;
    stickToBottomKeyRef.current = stickToBottomKey;
    atBottomRef.current = true;
    lastTotalRef.current = 0;
    const el = scrollElRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      setScrollTop(el.scrollTop);
    }
  }, [stickToBottomKey]);

  // Stick-to-bottom: when content grows while pinned, keep the bottom edge in view.
  useLayoutEffect(() => {
    const el = scrollElRef.current;
    if (!el || !windowed || !stickToBottomRef.current) return;
    if (totalSize > lastTotalRef.current && atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      setScrollTop(el.scrollTop);
    }
    lastTotalRef.current = totalSize;
  }, [totalSize, windowed]);

  /** Stable ref callback: observe + measure a mounted row; cleanup on unmount. */
  const measureElement = useCallback((el: Element | null): void | (() => void) => {
    if (!el) return;
    const index = Number((el as HTMLElement).dataset.index);
    if (!Number.isFinite(index)) return;
    const rowEl = el as HTMLElement;
    elementsRef.current.set(index, rowEl);
    const ro = roRef.current;
    if (!ro) return; // observer not created yet — the mount effect catches up.
    ro.observe(rowEl);
    const height = rowEl.getBoundingClientRect().height;
    if (height > 0) recordSize(index, height);
    return () => {
      roRef.current?.unobserve(rowEl);
      elementsRef.current.delete(index);
    };
  }, []);

  return {
    windowed,
    totalSize,
    items: window.items.map((item) => ({
      key: getItemKeyRef.current(item.index),
      index: item.index,
      start: item.start,
      size: item.size,
    })),
    measureElement,
  };
}

/** SSR/jsdom-safe feature probe used by tests and documentation. */
export function isVirtualizationAvailable(): boolean {
  return typeof ResizeObserver !== "undefined";
}
