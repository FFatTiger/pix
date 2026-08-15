import { describe, expect, it } from "vitest";
import { computeVirtualWindow, isVirtualizationAvailable } from "./virtual-list";

const FIXED = (size: number) => () => size;

describe("computeVirtualWindow — deterministic window content for a given scrollTop", () => {
  it("empty list → empty window, zero total", () => {
    const w = computeVirtualWindow({
      count: 0,
      sizeAt: FIXED(40),
      scrollTop: 0,
      viewport: 600,
      overscan: 8,
      pinned: new Set(),
    });
    expect(w.totalSize).toBe(0);
    expect(w.items).toEqual([]);
  });

  it("total size is the exact sum of per-row sizes", () => {
    const w = computeVirtualWindow({
      count: 4,
      sizeAt: (i) => (i === 1 ? 200 : 40),
      scrollTop: 0,
      viewport: 600,
      overscan: 0,
      pinned: new Set(),
    });
    expect(w.totalSize).toBe(40 + 200 + 40 + 40);
  });

  it("at scrollTop 0 renders rows from the top with correct starts", () => {
    const w = computeVirtualWindow({
      count: 100,
      sizeAt: FIXED(40),
      scrollTop: 0,
      viewport: 120,
      overscan: 0,
      pinned: new Set(),
    });
    // Visible rows 0..2 (120px / 40px), no overscan.
    expect(w.items.map((i) => i.index)).toEqual([0, 1, 2]);
    expect(w.items.map((i) => i.start)).toEqual([0, 40, 80]);
  });

  it("applies overscan symmetrically around the visible window", () => {
    const w = computeVirtualWindow({
      count: 100,
      sizeAt: FIXED(40),
      scrollTop: 40,
      viewport: 120,
      overscan: 3,
      pinned: new Set(),
    });
    // Visible 1..3, overscan 3 → 0..6.
    expect(w.items.map((i) => i.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("window content for a mid-list scrollTop is exactly the rows covering that range", () => {
    const w = computeVirtualWindow({
      count: 2000,
      sizeAt: FIXED(48),
      scrollTop: 48 * 1000,
      viewport: 600,
      overscan: 4,
      pinned: new Set(),
    });
    // 48*1000 → first row with end > 48000 is row 1000 (offset 48000, end 48048).
    const first = w.items[0]!.index;
    const last = w.items[w.items.length - 1]!.index;
    expect(first).toBe(1000 - 4);
    expect(last).toBe(1000 + Math.floor(600 / 48) + 4);
    expect(w.items[4]!.start).toBe(48 * 1000); // the exact row containing scrollTop
    expect(w.totalSize).toBe(48 * 2000);
  });

  it("scrollTop beyond the end clamps to the last rows (no index overflow)", () => {
    const w = computeVirtualWindow({
      count: 100,
      sizeAt: FIXED(40),
      scrollTop: 1_000_000,
      viewport: 600,
      overscan: 5,
      pinned: new Set(),
    });
    const indexes = w.items.map((i) => i.index);
    expect(indexes[0]).toBeGreaterThan(0);
    expect(indexes[indexes.length - 1]).toBe(99);
    expect(Math.max(...indexes)).toBeLessThan(100);
    expect(Math.min(...indexes)).toBeGreaterThanOrEqual(0);
  });

  it("viewport <= 0 renders a minimal top window, not all rows", () => {
    const w = computeVirtualWindow({
      count: 2000,
      sizeAt: FIXED(48),
      scrollTop: 0,
      viewport: 0,
      overscan: 8,
      pinned: new Set(),
    });
    expect(w.items.length).toBeLessThanOrEqual(9);
    expect(w.items.map((i) => i.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(w.totalSize).toBe(48 * 2000);
  });

  it("pinned rows far outside the window stay mounted and sorted by index", () => {
    const w = computeVirtualWindow({
      count: 100,
      sizeAt: FIXED(40),
      scrollTop: 0,
      viewport: 120,
      overscan: 0,
      pinned: new Set([2, 75, 99]),
    });
    const indexes = w.items.map((i) => i.index);
    expect(indexes).toEqual([0, 1, 2, 75, 99]);
    // Pinned row start uses its true offset.
    expect(w.items.find((i) => i.index === 75)?.start).toBe(75 * 40);
  });

  it("varying heights shift the visible window correctly", () => {
    // Row 0 is huge; remaining rows are 20px.
    const w = computeVirtualWindow({
      count: 10,
      sizeAt: (i) => (i === 0 ? 1000 : 20),
      scrollTop: 1000,
      viewport: 100,
      overscan: 0,
      pinned: new Set(),
    });
    // scrollTop 1000 lands at row 1 (offset 1000). Visible 100px → rows 1..5.
    expect(w.items.map((i) => i.index)).toEqual([1, 2, 3, 4, 5]);
    expect(w.items[0]!.start).toBe(1000);
  });

  it("measured/estimated sizes drive the window identically (pure)", () => {
    const sizeAt = (i: number) => (i % 3 === 0 ? 90 : 30);
    const scrollTop = 3000;
    const viewport = 450;
    const w = computeVirtualWindow({
      count: 1000,
      sizeAt,
      scrollTop,
      viewport,
      overscan: 2,
      pinned: new Set(),
    });
    // Independent recomputation via cumulative offsets.
    const offsets = [0];
    for (let i = 0; i < 1000; i++) offsets.push(offsets[i]! + sizeAt(i));
    const total = offsets[1000]!;
    expect(w.totalSize).toBe(total);
    for (const item of w.items) {
      expect(item.start).toBe(offsets[item.index]);
      expect(item.size).toBe(sizeAt(item.index));
    }
    // Every item is within the scrolled range (+overscan).
    for (const item of w.items) {
      const rowBottom = item.start + item.size;
      const within =
        rowBottom >= scrollTop - 2 * 90 &&
        item.start <= scrollTop + viewport + 2 * 90;
      expect(within).toBe(true);
    }
  });
});

describe("isVirtualizationAvailable", () => {
  it("reports false when ResizeObserver is absent (jsdom)", () => {
    const original = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = undefined;
    expect(isVirtualizationAvailable()).toBe(false);
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = original;
  });
});
