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
 * - Stick-to-bottom for transcripts: the bottom edge is the default view, it
 *   stays pinned while the user is at it (content growth, viewport resize),
 *   and scrolling up releases the pin until `scrollToBottom()` or a new
 *   `stickToBottomKey` re-pins it. This is the single scroll-position owner —
 *   callers must not run a second alignment effect against the same element.
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
  // Before a ResizeObserver reports the real viewport, an explicit non-zero
  // scroll (for example the initial stick-to-bottom pin) still needs a window
  // around that target (not the oldest rows). A conservative synthetic
  // viewport is replaced by the measured one before/at first paint; scrollTop=0
  // keeps the cheap top-window fallback.
  const effectiveViewport = viewport <= 0 && scrollTop > 0 ? 600 : viewport;
  if (effectiveViewport <= 0) {
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
    const bottom = scrollTop + effectiveViewport;
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

/**
 * Sub-pixel/rounding slack: this far from the bottom still counts as "at
 * bottom" ONLY while the scroll is not moving up (see the direction-aware
 * scroll listener); an upward move releases the pin at any distance > 0.
 */
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
  /**
   * When this value changes, re-pin to bottom (generic list API — e.g. a
   * session switch; the transcript keys it on session + live/history mode,
   * never on a history revision or branch).
   */
  stickToBottomKey?: unknown;
}

export interface UseVirtualListResult<K> {
  /** True when windowing is active; false means render-all (measurement unavailable). */
  windowed: boolean;
  /** Full content height (only meaningful when windowed). */
  totalSize: number;
  /** Current measured scroll viewport height. */
  viewportSize: number;
  /** Latest scroll offset (drives viewport-dependent affordances). */
  scrollTop: number;
  /** Rows to render (all rows when not windowed). */
  items: VirtualItem<K>[];
  /** Ref callback for each rendered row. No-op when not windowed. */
  measureElement: (el: Element | null) => void | (() => void);
  /**
   * Re-pin to the CONTENT bottom and restore stickiness (return-to-bottom
   * affordance). Reads the live scroll element — never a cached scrollHeight —
   * and the sticky layout effect re-pins again when later row measurements or
   * row growth change the layout, so one click survives measurement settling.
   */
  scrollToBottom: () => void;
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
  // Baseline for direction detection: updated by the scroll listener AND by
  // the hook's own programmatic pin, so the next user move is compared against
  // the pinned position rather than a stale pre-pin value.
  const lastScrollTopRef = useRef(0);
  const lastTotalRef = useRef(0);
  const lastViewportRef = useRef(0);
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

    // Direction-aware "at bottom": distance alone is not enough — a user who
    // scrolls up 1px from the exact bottom would still read as pinned and the
    // next growth would drag them back down. Exact-bottom (distance <= 0,
    // including the programmatic pin and a user scrolling back down) is
    // always pinned; within the tolerance it stays pinned only while NOT
    // moving up; any upward move with distance > 0 releases immediately.
    lastScrollTopRef.current = el.scrollTop;
    const onScroll = (): void => {
      const current = el.scrollTop;
      const previous = lastScrollTopRef.current;
      lastScrollTopRef.current = current;
      setScrollTop(current);
      if (!stickToBottomRef.current) return;
      const distanceFromBottom = el.scrollHeight - current - el.clientHeight;
      if (distanceFromBottom <= 0) {
        atBottomRef.current = true;
        return;
      }
      if (current < previous) {
        // Upward move that actually left the exact bottom: release now.
        atBottomRef.current = false;
        return;
      }
      // A layout-driven scroll event can fire after a streaming row grows but
      // before ResizeObserver reports its new height. scrollTop is unchanged
      // in that window while scrollHeight has already increased; treating the
      // new distance as user intent releases the pin and strands mobile streams.
      // Only an actual downward move may update the distance-based state.
      if (current > previous) {
        atBottomRef.current = distanceFromBottom <= STICKY_TOLERANCE_PX;
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

  /** Clamp to the exact content bottom (never rely on the browser clamping). */
  const pinToBottom = useCallback((el: HTMLElement): void => {
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    // The pin is the new direction baseline: a following 1px upward move must
    // read as upward, not as "down from a stale pre-pin offset".
    lastScrollTopRef.current = el.scrollTop;
    setScrollTop(el.scrollTop);
  }, []);

  /** Re-pin stickiness and push the scroll element to its live content bottom. */
  const scrollToBottom = useCallback((): void => {
    atBottomRef.current = true;
    const el = scrollElRef.current;
    if (!el) return;
    pinToBottom(el);
  }, [pinToBottom]);

  // Re-pin to bottom when the reset key changes (see the option doc).
  useLayoutEffect(() => {
    if (stickToBottomKey === stickToBottomKeyRef.current) return;
    stickToBottomKeyRef.current = stickToBottomKey;
    if (!stickToBottomRef.current) return;
    scrollToBottom();
  }, [stickToBottomKey, scrollToBottom]);

  // Stick-to-bottom: while the user is AT the bottom, keep the bottom edge in
  // view when the layout changes (content growth/shrink, row measurement
  // settling, viewport resize). The first run mounts pinned (atBottom starts
  // true), which makes the transcript's DEFAULT view the conversation bottom.
  // Once a scroll event reports the user left the bottom, nothing pulls them
  // back down — only scrollToBottom() or a new stickToBottomKey can re-pin.
  useLayoutEffect(() => {
    const el = scrollElRef.current;
    if (!el || !windowed || !stickToBottomRef.current) return;
    const layoutChanged =
      totalSize !== lastTotalRef.current || viewport !== lastViewportRef.current;
    lastTotalRef.current = totalSize;
    lastViewportRef.current = viewport;
    if (!layoutChanged || !atBottomRef.current) return;
    pinToBottom(el);
  }, [totalSize, viewport, windowed]);

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
    viewportSize: viewport,
    scrollTop,
    items: window.items.map((item) => ({
      key: getItemKeyRef.current(item.index),
      index: item.index,
      start: item.start,
      size: item.size,
    })),
    measureElement,
    scrollToBottom,
  };
}

/** SSR/jsdom-safe feature probe used by tests and documentation. */
export function isVirtualizationAvailable(): boolean {
  return typeof ResizeObserver !== "undefined";
}
