/**
 * Test-only helpers to exercise the hand-rolled virtualizer in jsdom.
 *
 * jsdom has no ResizeObserver and no layout (clientHeight/scrollHeight are 0),
 * so the real hook falls back to render-all. These helpers install a
 * controllable mock ResizeObserver and let tests drive the viewport/scroll
 * position deterministically so the windowed path is fully testable (bounded
 * node counts, correct window for a given scrollTop, auto-scroll, pinning).
 */

interface ResizeObserverCallback {
  (entries: Array<{ target: Element; contentRect: { height: number } }>): void;
}

interface MockResizeObserver {
  callback: ResizeObserverCallback;
  observed: Set<Element>;
  observe: (el: Element) => void;
  unobserve: (el: Element) => void;
  disconnect: () => void;
}

export interface VirtualizationEnv {
  /** The single ResizeObserver the hook creates (observes scroll el + rows). */
  ro: MockResizeObserver;
  /** Force the scroll container's reported clientHeight (viewport). */
  setClientHeight(el: Element, height: number): void;
  /** Set the container's reported scrollTop (must also dispatch a scroll event). */
  setScrollTop(el: Element, top: number): void;
  /** Set the container's reported scrollHeight (used by auto-scroll assertions). */
  setScrollHeight(el: Element, height: number): void;
  /** Trigger the observer for a single row with the given measured height. */
  measureRow(el: Element, height: number): void;
  /** Trigger the observer for the scroll container (reads overridden clientHeight). */
  fireViewport(el: Element): void;
}

const previousResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;

export function installVirtualization(): VirtualizationEnv {
  let ro: MockResizeObserver | undefined;
  class MockResizeObserverImpl implements MockResizeObserver {
    callback: ResizeObserverCallback;
    observed = new Set<Element>();
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      if (ro) throw new Error("installVirtualization: expected a single ResizeObserver");
      ro = this;
    }
    observe(el: Element): void {
      this.observed.add(el);
    }
    unobserve(el: Element): void {
      this.observed.delete(el);
    }
    disconnect(): void {
      this.observed.clear();
    }
  }
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserverImpl;

  return {
    get ro(): MockResizeObserver {
      if (!ro) throw new Error("installVirtualization: hook never created a ResizeObserver");
      return ro;
    },
    setClientHeight(el: Element, height: number): void {
      Object.defineProperty(el, "clientHeight", { value: height, configurable: true });
    },
    setScrollTop(el: Element, top: number): void {
      Object.defineProperty(el, "scrollTop", { value: top, configurable: true, writable: true });
      el.dispatchEvent(new Event("scroll"));
    },
    setScrollHeight(el: Element, height: number): void {
      Object.defineProperty(el, "scrollHeight", { value: height, configurable: true });
    },
    measureRow(el: Element, height: number): void {
      ro?.callback([{ target: el, contentRect: { height } }]);
    },
    fireViewport(el: Element): void {
      ro?.callback([{ target: el, contentRect: { height: 0 } }]);
    },
  };
}

export function restoreVirtualization(): void {
  if (previousResizeObserver === undefined) {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  } else {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = previousResizeObserver;
  }
}
