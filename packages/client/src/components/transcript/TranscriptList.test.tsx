/**
 * TranscriptList — bottom-first viewport + local older-row reveal window.
 *
 * The DEFAULT view is the conversation bottom (the virtualizer's
 * stick-to-bottom owns the whole scroll lifecycle), one return-to-bottom click
 * lands on the real content bottom and survives late row measurements, a
 * scrolled-up user is never pulled down, and upward loading reveals 50 more
 * rows LOCALLY (no second request) with the visual position preserved.
 * Deferred (`deferred:true`) thinking blocks load through the typed
 * session-entry API via the wired DeferredThinkingLoader.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { TranscriptList } from "./TranscriptList";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { RuntimeProvider } from "@/runtime/runtime-provider";
import { I18nProvider } from "@/hooks/useI18n";
import { flush, lastFrame, snapshotPayload, FakeWebSocket } from "@/runtime/testing/harness";
import { CaptureTestRuntime } from "@/runtime/testing/capture-test-runtime";
import type { TestRuntimeStore } from "@/runtime/testing/test-runtime-store";
import type { RuntimeSocketDeps } from "@/runtime";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];
  readonly observed = new Set<Element>();
  private callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverStub.instances.push(this);
  }
  observe(el: Element): void { this.observed.add(el); }
  unobserve(el: Element): void { this.observed.delete(el); }
  disconnect(): void { this.observed.clear(); }
  /** Deliver one synthetic entry (content height in px) for a target. */
  fire(target: Element, height: number): void {
    this.callback(
      [{ target, contentRect: { height } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
}

/** The virtualizer's observer: the only one watching `[data-index]` rows. */
function virtualizerObserver(): ResizeObserverStub {
  const instance = ResizeObserverStub.instances.find((observer) =>
    Array.from(observer.observed).some((el) => (el as HTMLElement).dataset?.index !== undefined));
  if (!instance) throw new Error("virtualizer ResizeObserver not found");
  return instance;
}

/**
 * Layout-faithful geometry: scrollHeight derives from the virtualizer's own
 * inner height (+ container chrome), so content growth from row measurements
 * or reveals moves it exactly like a real browser.
 */
function bindVirtualGeometry(scrollEl: HTMLElement, viewport: number): void {
  Object.defineProperty(scrollEl, "clientHeight", { configurable: true, value: viewport });
  Object.defineProperty(scrollEl, "scrollHeight", {
    configurable: true,
    get: () => {
      const inner = scrollEl.querySelector<HTMLElement>(".transcript-inner");
      const content = inner === null ? 0 : Number.parseFloat(inner.style.height) || 0;
      return content + 53; // 20px top + 32px bottom padding + 1px top sentinel
    },
  });
  act(() => virtualizerObserver().fire(scrollEl, 0));
}

/** Deliver late ResizeObserver row measurements to every mounted row. */
function measureRows(el: HTMLElement, height: number): void {
  const rows = Array.from(el.querySelectorAll<HTMLElement>("[data-index]"));
  act(() => {
    for (const row of rows) virtualizerObserver().fire(row, height);
  });
}

/** The exact content bottom the virtualizer pins to (never rely on clamping). */
const contentBottom = (el: HTMLElement): number => Math.max(0, el.scrollHeight - el.clientHeight);

/** Controllable IntersectionObserver so the upward-load hint is deterministic. */
class IntersectionObserverStub {
  static instances: IntersectionObserverStub[] = [];
  private callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    IntersectionObserverStub.instances.push(this);
  }
  observe(): void { /* jsdom no-op */ }
  unobserve(): void { /* jsdom no-op */ }
  disconnect(): void { /* jsdom no-op */ }
  fire(isIntersecting: boolean): void {
    this.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

function fakeDeps(): RuntimeSocketDeps {
  return {
    createWebSocket: () => { throw new Error("no socket expected in this suite"); },
    now: () => Date.now(),
    setTimeout: (fn) => setTimeout(fn),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    random: () => 0.5,
    location: { href: "https://pix.local/app/" },
    identity: { shell: "web", platform: "mac" },
    onOnline: () => () => undefined,
    onVisible: () => () => undefined,
  };
}

function userEntry(entryId: string, text: string): { entryId: string; message: { role: "user"; content: string } } {
  return { entryId, message: { role: "user", content: text } };
}

function contextResponse(sessionId: string, entries: unknown[]): Response {
  return json({
    context: {
      sessionId,
      entries,
      settings: { model: null, thinkingLevel: "off" },
      pageInfo: { hasMore: false },
    },
  });
}

/** 80 user-message rows → the initial tail window hides the first 30. */
function eightyUserEntries(sessionId: string): { entryId: string; message: { role: "user"; content: string } }[] {
  return Array.from({ length: 80 }, (_, index) => userEntry(`${sessionId}-u${index + 1}`, `row ${index + 1} of ${sessionId}`));
}

function stubFetch(respond: (path: string) => Response | undefined): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const path = typeof input === "string"
      ? input
      : input instanceof URL
        ? `${input.pathname}${input.search}`
        : input.url;
    return respond(String(path)) ?? json({});
  }) as unknown as typeof fetch;
}

let previousFetch: typeof fetch;
let previousIntersectionObserver: (typeof globalThis)["IntersectionObserver"];

function Tree({ sessionId }: { sessionId: string }): ReactNode {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return (
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>
        <CapabilityProvider host={{ mode: "local", capabilities: ["agent", "sessions"] }}>
          <RuntimeProvider deps={fakeDeps()}>
            <I18nProvider>
              <TranscriptList sessionId={sessionId} live={false} />
            </I18nProvider>
          </RuntimeProvider>
        </CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>
  );
}

/** Flush microtasks AND fire React Query's setTimeout(0) notifications,
 * giving React a fresh act render between rounds (data → rows). */
async function settle(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await act(async () => {
      await flush(20);
      vi.advanceTimersByTime(0);
      await flush(20);
    });
  }
}

describe("TranscriptList — local reveal window (one complete history response)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    IntersectionObserverStub.instances = [];
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;
    previousFetch = globalThis.fetch;
    previousIntersectionObserver = globalThis.IntersectionObserver;
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
      IntersectionObserverStub as unknown as (typeof globalThis)["IntersectionObserver"];
    (globalThis as { matchMedia?: unknown }).matchMedia ??= (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    });
  });
  afterEach(() => {
    cleanup();
    globalThis.fetch = previousFetch;
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = previousIntersectionObserver;
    vi.useRealTimers();
  });

  it("initially renders only the final 50 rows; no second context request exists", async () => {
    const calls: string[] = [];
    globalThis.fetch = stubFetch((path) => {
      if (path.includes("/v1/sessions/s1/context")) {
        calls.push(path);
        return contextResponse("s1", eightyUserEntries("s1"));
      }
      return json({});
    });
    render(<Tree sessionId="s1" />);
    await settle();
    // ONE complete deferred request; NO limit and NO older-page follow-up.
    expect(calls).toEqual(["/v1/sessions/s1/context?deferThinking=1&deferMedia=1"]);
    // jsdom has no layout: give the scroll container a real viewport/content
    // height so the virtualizer takes its windowed path.
    const transcript = screen.getByRole("log");
    bindVirtualGeometry(transcript, 600);
    // Final-50 tail window: the first 30 chat rows are HIDDEN and the DEFAULT
    // view is pinned at the conversation BOTTOM — the latest rows are mounted
    // (with overscan), never the oldest ones and never latest-user-at-top.
    expect(transcript.scrollTop).toBe(contentBottom(transcript));
    expect(screen.queryByText("row 1 of s1")).toBeNull();
    expect(screen.queryByText("row 30 of s1")).toBeNull();
    expect(screen.queryByText("row 65 of s1")).toBeNull();
    expect(screen.getByText("row 66 of s1")).toBeTruthy();
    expect(screen.getByText("row 80 of s1")).toBeTruthy();
    // At the bottom: no jump affordance, no reveal hint.
    expect(screen.queryByTestId("transcript-jump-bottom")).toBeNull();
    expect(screen.queryByTestId("load-older-hint")).toBeNull();

    // Real row measurements settle AFTER the first paint — the bottom pin
    // follows the new layout instead of stranding the viewport.
    measureRows(transcript, 110);
    expect(transcript.scrollTop).toBe(contentBottom(transcript));
    expect(screen.getByText("row 80 of s1")).toBeTruthy();
    expect(screen.queryByTestId("transcript-jump-bottom")).toBeNull();

    // Move to the local window top, then reaching the sentinel surfaces the
    // reveal hint (no request fired yet). This explicit user scroll is
    // preserved — nothing re-pins it back to the bottom.
    act(() => {
      transcript.scrollTop = 0;
      fireEvent.scroll(transcript);
      IntersectionObserverStub.instances.forEach((observer) => observer.fire(true));
    });
    await settle();
    expect(screen.getByTestId("load-older-hint")).toBeTruthy();

    // Clicking it reveals 50 more rows LOCALLY — still exactly one request,
    // and the prepended height is compensated so the user's visual position
    // (the rows they were reading) is preserved instead of jumping.
    const beforeReveal = transcript.scrollHeight;
    fireEvent.click(within(screen.getByTestId("load-older-hint")).getByRole("button"));
    await settle();
    // A real browser emits the scroll event for the compensated offset itself.
    act(() => fireEvent.scroll(transcript));
    expect(calls).toEqual(["/v1/sessions/s1/context?deferThinking=1&deferMedia=1"]);
    expect(transcript.scrollTop).toBe(transcript.scrollHeight - beforeReveal);
    expect(screen.getByText("row 30 of s1")).toBeTruthy(); // revealed rows mount above
    expect(screen.queryByText("row 20 of s1")).toBeNull();
    // The hint disappears once nothing older remains.
    expect(screen.queryByTestId("load-older-hint")).toBeNull();
  });

  it("one return-to-bottom click lands on the content bottom and survives later measurements", async () => {
    globalThis.fetch = stubFetch((path) => {
      if (path.includes("/v1/sessions/s1/context")) return contextResponse("s1", eightyUserEntries("s1"));
      return json({});
    });
    render(<Tree sessionId="s1" />);
    await settle();
    const transcript = screen.getByRole("log");
    bindVirtualGeometry(transcript, 600);
    // At the bottom after the initial pin → no affordance.
    expect(screen.queryByTestId("transcript-jump-bottom")).toBeNull();

    // The user scrolls far up: the pin releases and the affordance appears.
    act(() => {
      transcript.scrollTop = 200;
      fireEvent.scroll(transcript);
    });
    const button = screen.getByTestId("transcript-jump-bottom");
    expect(button.getAttribute("aria-label")).toBeTruthy();

    // ONE click re-pins to the exact content bottom — no cached target, no
    // anchor-spacer arithmetic, no reliance on browser clamping — and the
    // affordance hides deterministically.
    fireEvent.click(button);
    expect(transcript.scrollTop).toBe(contentBottom(transcript));
    expect(screen.getByText("row 80 of s1")).toBeTruthy();
    expect(screen.queryByTestId("transcript-jump-bottom")).toBeNull();

    // Virtualizer/ResizeObserver work landing AFTER the click must not strand
    // the viewport above the bottom (the old bug needed several clicks).
    measureRows(transcript, 96);
    expect(transcript.scrollTop).toBe(contentBottom(transcript));
    expect(screen.queryByTestId("transcript-jump-bottom")).toBeNull();

    // Within the threshold of the bottom the affordance stays hidden; far
    // above it, it is offered again.
    act(() => {
      transcript.scrollTop = transcript.scrollHeight - transcript.clientHeight - 100;
      fireEvent.scroll(transcript);
    });
    expect(screen.queryByTestId("transcript-jump-bottom")).toBeNull();
    act(() => {
      transcript.scrollTop = 1000;
      fireEvent.scroll(transcript);
    });
    expect(screen.getByTestId("transcript-jump-bottom")).toBeTruthy();
  });

  it("releases the pin on a 1px upward move from the bottom; later growth never drags back", async () => {
    globalThis.fetch = stubFetch((path) => {
      if (path.includes("/v1/sessions/s1/context")) return contextResponse("s1", eightyUserEntries("s1"));
      return json({});
    });
    render(<Tree sessionId="s1" />);
    await settle();
    const transcript = screen.getByRole("log");
    bindVirtualGeometry(transcript, 600);
    const bottom = contentBottom(transcript);
    expect(transcript.scrollTop).toBe(bottom);

    // 1px up from the exact bottom: inside the affordance threshold and inside
    // the sticky tolerance, but the DIRECTION is upward → the pin is released.
    act(() => {
      transcript.scrollTop = bottom - 1;
      fireEvent.scroll(transcript);
    });
    measureRows(transcript, 120); // delayed virtualizer/row growth
    expect(transcript.scrollTop).toBe(bottom - 1); // never dragged back down
    // The growth moved the bottom away, so the affordance is (correctly) back.
    expect(screen.getByTestId("transcript-jump-bottom")).toBeTruthy();

    // Scrolling back DOWN to the exact bottom re-pins: growth follows again
    // and the affordance hides.
    act(() => {
      transcript.scrollTop = contentBottom(transcript);
      fireEvent.scroll(transcript);
    });
    measureRows(transcript, 96);
    expect(transcript.scrollTop).toBe(contentBottom(transcript));
    expect(screen.queryByTestId("transcript-jump-bottom")).toBeNull();
  });

  it("never pulls a scrolled-up user down while rows keep growing", async () => {
    globalThis.fetch = stubFetch((path) => {
      if (path.includes("/v1/sessions/s1/context")) return contextResponse("s1", eightyUserEntries("s1"));
      return json({});
    });
    render(<Tree sessionId="s1" />);
    await settle();
    const transcript = screen.getByRole("log");
    bindVirtualGeometry(transcript, 600);
    act(() => {
      transcript.scrollTop = 300;
      fireEvent.scroll(transcript);
    });
    // Content growth + late row measurements while the user reads above the
    // bottom: the scroll position is untouched.
    measureRows(transcript, 120);
    expect(transcript.scrollTop).toBe(300);
    expect(screen.getByTestId("transcript-jump-bottom")).toBeTruthy();
  });

  it("re-pins once per conversation switch and preserves an older-row reveal", async () => {
    globalThis.fetch = stubFetch((path) => {
      const match = path.match(/^\/v1\/sessions\/(s[12])\/context/);
      if (match) return contextResponse(match[1]!, eightyUserEntries(match[1]!));
      return json({});
    });
    const { rerender } = render(<Tree sessionId="s1" />);
    await settle();
    const transcript = screen.getByRole("log");
    bindVirtualGeometry(transcript, 600);
    // Reveal older rows on s1 while reading above the bottom: the prepended
    // height is compensated (scroll-height delta), so the user keeps their
    // visual position and is never auto-jumped to the bottom.
    act(() => {
      transcript.scrollTop = 0;
      fireEvent.scroll(transcript);
      IntersectionObserverStub.instances.forEach((observer) => observer.fire(true));
    });
    await settle();
    const beforeReveal = transcript.scrollHeight;
    fireEvent.click(within(screen.getByTestId("load-older-hint")).getByRole("button"));
    await settle();
    act(() => fireEvent.scroll(transcript)); // browser emits the compensated scroll
    expect(transcript.scrollTop).toBe(transcript.scrollHeight - beforeReveal);
    expect(screen.getByText("row 31 of s1")).toBeTruthy(); // still in view
    expect(screen.getByTestId("transcript-jump-bottom")).toBeTruthy(); // offered, not forced

    // Identity change (same mount, unkeyed): the window resets to the final 50
    // of the new session — never s1's revealed window, never s1's rows — and
    // the viewport repositions once to THAT session's bottom.
    rerender(<Tree sessionId="s2" />);
    await settle();
    expect(transcript.scrollTop).toBe(contentBottom(transcript));
    expect(screen.queryByText("row 1 of s1")).toBeNull();
    expect(screen.queryByText("row 30 of s2")).toBeNull();
    expect(screen.queryByText("row 65 of s2")).toBeNull();
    expect(screen.getByText("row 66 of s2")).toBeTruthy();
    expect(screen.getByText("row 80 of s2")).toBeTruthy();
    expect(screen.queryByTestId("transcript-jump-bottom")).toBeNull();
  });
});

describe("TranscriptList — deferred thinking wiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    IntersectionObserverStub.instances = [];
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;
    previousFetch = globalThis.fetch;
    previousIntersectionObserver = globalThis.IntersectionObserver;
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
      IntersectionObserverStub as unknown as (typeof globalThis)["IntersectionObserver"];
    (globalThis as { matchMedia?: unknown }).matchMedia ??= (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    });
  });
  afterEach(() => {
    cleanup();
    globalThis.fetch = previousFetch;
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = previousIntersectionObserver;
    vi.useRealTimers();
  });

  it("loads a deferred thinking block through the typed blockIndex route", async () => {
    const thinkingCalls: string[] = [];
    globalThis.fetch = stubFetch((path) => {
      if (path.includes("/v1/sessions/st1/context")) {
        return contextResponse("st1", [
          userEntry("st1-u1", "explain"),
          {
            entryId: "st1-a1",
            parentEntryId: "st1-u1",
            message: {
              role: "assistant",
              model: "m",
              provider: "p",
              content: [
                { type: "thinking", thinking: "", deferred: true },
                { type: "text", text: "the answer" },
              ],
            },
          },
        ]);
      }
      if (path.includes("/thinking")) {
        thinkingCalls.push(path);
        return json({ thinking: "the hidden reasoning", entryId: "st1-a1" });
      }
      return json({});
    });
    render(<Tree sessionId="st1" />);
    await settle();
    // Historical process details start collapsed, matching the source. Expanding
    // the group mounts the deferred block and loads it by exact blockIndex.
    const processToggle = document.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    expect(processToggle).not.toBeNull();
    fireEvent.click(processToggle!);
    await settle();
    expect(thinkingCalls).toEqual(["/v1/sessions/st1/entries/st1-a1/thinking?blockIndex=0"]);
    expect(screen.getByText("the hidden reasoning")).toBeTruthy();
    expect(screen.getByText("the answer")).toBeTruthy();
  });
});

/**
 * Live rebase safety — the committed history boundary.
 *
 * A turn-end leaf fence (`session_changed` with a new leafId) rebases the
 * history layer: generation++, new anchor, live tail cleared. The new context
 * response is pending for a moment; that pending window must NOT move the
 * viewport (no empty DOM, no scroll clamp, no bottom re-pin). Only when the
 * new history actually COMMITTED does the structural tail check run: the same
 * branch keeps the user's scrolled-up position, a different branch
 * repositions once to its bottom.
 */
describe("TranscriptList — live rebase keeps the user's scroll", () => {
  const SOCKETS: FakeWebSocket[] = [];
  let capturedStore: TestRuntimeStore | null = null;

  function liveDeps(): RuntimeSocketDeps {
    return {
      createWebSocket: (url) => { const ws = new FakeWebSocket(url); SOCKETS.push(ws); return ws; },
      now: () => Date.now(),
      setTimeout: (fn) => setTimeout(fn),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      random: () => 0.5,
      location: { href: "https://pix.local/app/" },
      identity: { shell: "web", platform: "mac" },
      onOnline: () => () => undefined,
      onVisible: () => () => undefined,
    };
  }

  function LiveTree(): ReactNode {
    const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    return (
      <QueryClientProvider client={queryClient}>
        <HttpClientProvider>
          <CapabilityProvider host={{ mode: "local", capabilities: ["agent", "sessions"] }}>
            <RuntimeProvider deps={liveDeps()}>
              <CaptureTestRuntime onStore={(store) => { capturedStore = store; }} />
              <I18nProvider>
                <TranscriptList sessionId="s1" live />
              </I18nProvider>
            </RuntimeProvider>
          </CapabilityProvider>
        </HttpClientProvider>
      </QueryClientProvider>
    );
  }

  /** Context responses per anchor leaf; `hold` leaves pend until committed. */
  function contextServer(): {
    fetch: typeof fetch;
    seed: (leaf: string, entries: unknown[]) => void;
    hold: (leaf: string) => void;
    commit: (leaf: string, entries: unknown[]) => Promise<void>;
  } {
    const byLeaf = new Map<string, unknown[]>();
    const held = new Map<string, ((response: Response) => void) | null>();
    return {
      seed: (leaf, entries) => { byLeaf.set(leaf, entries); },
      hold: (leaf) => { held.set(leaf, null); },
      commit: async (leaf, entries) => {
        byLeaf.set(leaf, entries);
        const resolve = held.get(leaf);
        held.delete(leaf);
        if (resolve) {
          resolve(contextResponse("s1", entries));
          await act(async () => { await flush(4); });
        }
      },
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const path = typeof input === "string"
          ? input
          : input instanceof URL
            ? `${input.pathname}${input.search}`
            : input.url;
        const match = path.match(/^\/v1\/sessions\/([^/]+)\/context/);
        if (match) {
          const leaf = new URLSearchParams(path.split("?")[1] ?? "").get("leafId") ?? "";
          if (held.has(leaf)) {
            if (held.get(leaf) === null) {
              return await new Promise<Response>((resolve) => { held.set(leaf, resolve); });
            }
          }
          return contextResponse(match[1]!, byLeaf.get(leaf) ?? []);
        }
        return json({});
      }) as unknown as typeof fetch,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    IntersectionObserverStub.instances = [];
    ResizeObserverStub.instances = [];
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;
    previousFetch = globalThis.fetch;
    previousIntersectionObserver = globalThis.IntersectionObserver;
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
      IntersectionObserverStub as unknown as (typeof globalThis)["IntersectionObserver"];
    (globalThis as { matchMedia?: unknown }).matchMedia ??= (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    });
    SOCKETS.length = 0;
    capturedStore = null;
  });
  afterEach(() => {
    cleanup();
    globalThis.fetch = previousFetch;
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = previousIntersectionObserver;
    vi.useRealTimers();
  });

  /** Connect the runtime, attach s1 and admit it with a leaf-less snapshot. */
  async function driveReady(): Promise<FakeWebSocket> {
    const store = capturedStore!;
    let ws: FakeWebSocket | undefined;
    await act(async () => {
      store.connect();
      ws = SOCKETS[SOCKETS.length - 1]!;
      ws.serverOpen();
      ws.serverSend({ type: "handshake_ack", payload: { protocolVersion: 2, host: { mode: "local", capabilities: ["agent"] }, limits: { maxUpload: 0, maxOpenSessions: 4 }, sessionSnapshotSupport: true } });
      await flush();
      void store.openSession("s1").catch(() => {});
      await flush();
      const attach = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string } }>(ws, "attach")!;
      expect(attach.payload.sessionId).toBe("s1");
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "s1" }) });
      await flush();
    });
    return ws!;
  }

  /** Committed session_changed leaf fence (turn end / cross-tab navigate). */
  async function fence(ws: FakeWebSocket, leafId: string, eventId: number): Promise<void> {
    await act(async () => {
      ws.serverSend({
        type: "event",
        payload: { type: "session_changed", sessionId: "s1", cwd: "/x", leafId, eventId, epoch: "e1" },
      });
      await flush();
    });
  }

  it("renders automatic and manual compaction as distinct muted live statuses", async () => {
    globalThis.fetch = stubFetch(() => json({}));
    render(<LiveTree />);
    const ws = await driveReady();

    await act(async () => {
      ws.serverSend({
        type: "event",
        payload: { type: "auto_compaction_start", sessionId: "s1", eventId: 1, epoch: "e1" },
      });
      await flush();
    });
    await settle();
    let status = screen.getByRole("status");
    expect(status.textContent).toBe("Automatically compacting context");
    expect(status.classList.contains("transcript-compaction-status")).toBe(true);
    expect(status.querySelector("svg")).not.toBeNull();

    await act(async () => {
      ws.serverSend({
        type: "event",
        payload: { type: "auto_compaction_end", sessionId: "s1", eventId: 2, epoch: "e1" },
      });
      ws.serverSend({
        type: "event",
        payload: { type: "compaction_start", sessionId: "s1", reason: "manual", eventId: 3, epoch: "e1" },
      });
      await flush();
    });
    await settle();
    status = screen.getByRole("status");
    expect(status.textContent).toBe("Compacting context");
  });

  it("keeps the scrolled-up user's position across a pending rebase and a same-branch commit", async () => {
    const server = contextServer();
    server.seed("L1", eightyUserEntries("s1"));
    globalThis.fetch = server.fetch;
    render(<LiveTree />);
    const ws = await driveReady();
    // First leaf fence establishes the history anchor → the context commits.
    await fence(ws, "L1", 1);
    await settle();
    const transcript = screen.getByRole("log");
    bindVirtualGeometry(transcript, 600);
    expect(transcript.scrollTop).toBe(contentBottom(transcript));
    expect(screen.getByText("row 80 of s1")).toBeTruthy();

    // The user scrolls up to read older rows.
    act(() => {
      transcript.scrollTop = 400;
      fireEvent.scroll(transcript);
    });

    // Turn-end fence moves the branch forward: generation++ → the new context
    // response is PENDING. The previously committed snapshot keeps rendering
    // (no empty DOM, no scroll clamp, no bottom re-pin) and the user's rows
    // stay exactly where they were.
    server.hold("L2");
    await fence(ws, "L2", 2);
    await settle();
    expect(screen.getByText("row 31 of s1")).toBeTruthy(); // retained rows
    expect(transcript.scrollTop).toBe(400);
    expect(screen.getByTestId("transcript-jump-bottom")).toBeTruthy();

    // The same branch commits as a SUPERSET (the 80 rows + 5 new ones): the
    // old tail row is still in the branch, so this is ordinary growth — the
    // user's position is preserved, never yanked to the bottom. The new rows
    // are below the viewport: one explicit return-to-bottom reaches them.
    await server.commit("L2", [
      ...eightyUserEntries("s1"),
      ...Array.from({ length: 5 }, (_, index) => userEntry(`s1-u${81 + index}`, `row ${81 + index} of s1`)),
    ]);
    await settle();
    expect(transcript.scrollTop).toBe(400);
    expect(screen.getByText("row 40 of s1")).toBeTruthy(); // still reading the same spot
    expect(screen.getByTestId("transcript-jump-bottom")).toBeTruthy(); // still offered
    fireEvent.click(screen.getByTestId("transcript-jump-bottom"));
    expect(transcript.scrollTop).toBe(contentBottom(transcript));
    expect(screen.getByText("row 85 of s1")).toBeTruthy(); // the committed growth
  });

  it("keeps a revealed older-row window across a same-branch commit (no reset to the final 50)", async () => {
    const server = contextServer();
    server.seed("L1", eightyUserEntries("s1"));
    globalThis.fetch = server.fetch;
    render(<LiveTree />);
    const ws = await driveReady();
    await fence(ws, "L1", 1);
    await settle();
    const transcript = screen.getByRole("log");
    bindVirtualGeometry(transcript, 600);

    // Reveal ALL older rows locally: the window opens from row 1, not the
    // final 50, and the scroll-height delta keeps the user at the top.
    act(() => {
      transcript.scrollTop = 0;
      fireEvent.scroll(transcript);
      IntersectionObserverStub.instances.forEach((observer) => observer.fire(true));
    });
    await settle();
    fireEvent.click(within(screen.getByTestId("load-older-hint")).getByRole("button"));
    await settle();
    act(() => fireEvent.scroll(transcript)); // browser emits the compensated scroll
    expect(screen.queryByTestId("load-older-hint")).toBeNull();
    // The user then reads from the very top of the revealed history.
    act(() => {
      transcript.scrollTop = 0;
      fireEvent.scroll(transcript);
    });
    await settle();
    expect(screen.getByText("row 1 of s1")).toBeTruthy();
    const revealedScrollTop = transcript.scrollTop;

    // Turn-end fence: the next revision pends — the revealed window and the
    // scroll position are part of the OLD view and must survive it.
    server.hold("L2");
    await fence(ws, "L2", 2);
    await settle();
    expect(screen.getByText("row 1 of s1")).toBeTruthy();
    expect(transcript.scrollTop).toBe(revealedScrollTop);

    // Same-branch superset commit: the reveal window must NOT reset to the
    // final 50 (that would unmount row 1 and shift the content under the
    // user); only a real conversation switch resets it.
    await server.commit("L2", [
      ...eightyUserEntries("s1"),
      ...Array.from({ length: 5 }, (_, index) => userEntry(`s1-u${81 + index}`, `row ${81 + index} of s1`)),
    ]);
    await settle();
    expect(screen.getByText("row 1 of s1")).toBeTruthy(); // window preserved
    expect(transcript.scrollTop).toBe(revealedScrollTop); // nothing moved
    expect(screen.getByTestId("transcript-jump-bottom")).toBeTruthy();
    // The committed growth is below the viewport: one click reaches it.
    fireEvent.click(screen.getByTestId("transcript-jump-bottom"));
    expect(transcript.scrollTop).toBe(contentBottom(transcript));
    expect(screen.getByText("row 85 of s1")).toBeTruthy();
  });

  it("a different-branch commit keeps the scroll owner (no auto return-to-bottom)", async () => {
    const server = contextServer();
    server.seed("L1", eightyUserEntries("s1"));
    globalThis.fetch = server.fetch;
    render(<LiveTree />);
    const ws = await driveReady();
    await fence(ws, "L1", 1);
    await settle();
    const transcript = screen.getByRole("log");
    bindVirtualGeometry(transcript, 600);
    act(() => {
      transcript.scrollTop = 400;
      fireEvent.scroll(transcript);
    });

    // Branch navigate: the committed branch contains NONE of s1's current rows.
    // The scroll owner is the session, not the branch — the user's position is
    // preserved and the return-to-bottom affordance stays the explicit way down.
    server.hold("L2");
    await fence(ws, "L2", 2);
    await settle();
    expect(screen.getByText("row 31 of s1")).toBeTruthy(); // pending keeps the old view
    expect(transcript.scrollTop).toBe(400);
    await server.commit("L2", Array.from({ length: 60 }, (_, index) => userEntry(`b2-u${index + 1}`, `branch row ${index + 1}`)));
    await settle();
    expect(transcript.scrollTop).toBe(400); // never auto-returned to the bottom
    expect(screen.queryByText("row 80 of s1")).toBeNull();
    // The viewport keeps its position in the (default tail) window of the new
    // branch — same scroll owner, same window, no reset.
    expect(screen.getByText("branch row 20")).toBeTruthy();
    expect(screen.queryByText("branch row 5")).toBeNull();
    expect(screen.getByTestId("transcript-jump-bottom")).toBeTruthy(); // offered, not forced
    fireEvent.click(screen.getByTestId("transcript-jump-bottom"));
    expect(transcript.scrollTop).toBe(contentBottom(transcript)); // one click reaches it
    expect(screen.getByText("branch row 60")).toBeTruthy();
  });

  it("an optimistic tail replaced by its authoritative entry never re-pins", async () => {
    const server = contextServer();
    // The tail entry is later REPLACED by a different (authoritative) entry id
    // — exactly the optimistic→committed swap the old tail heuristic misread
    // as a conversation switch.
    const withOptimisticTail = [
      ...Array.from({ length: 79 }, (_, index) => userEntry(`s1-u${index + 1}`, `row ${index + 1} of s1`)),
      userEntry("optimistic:tail", "pending send"),
    ];
    server.seed("L1", withOptimisticTail);
    globalThis.fetch = server.fetch;
    render(<LiveTree />);
    const ws = await driveReady();
    await fence(ws, "L1", 1);
    await settle();
    const transcript = screen.getByRole("log");
    bindVirtualGeometry(transcript, 600);
    expect(screen.getByText("pending send")).toBeTruthy();
    act(() => {
      transcript.scrollTop = 350;
      fireEvent.scroll(transcript);
    });

    server.hold("L2");
    await fence(ws, "L2", 2);
    await settle();
    // The placeholder keeps the previous snapshot rendering at the user's
    // position (the optimistic tail itself is virtualized away up here).
    expect(screen.getByText("row 40 of s1")).toBeTruthy();
    expect(transcript.scrollTop).toBe(350);

    // The authoritative entry replaces the optimistic tail (different entryId,
    // same turn): ordinary growth of the SAME conversation — no re-pin.
    await server.commit("L2", [
      ...Array.from({ length: 79 }, (_, index) => userEntry(`s1-u${index + 1}`, `row ${index + 1} of s1`)),
      userEntry("s1-u80", "committed send"),
    ]);
    await settle();
    expect(transcript.scrollTop).toBe(350); // no re-pin, no yank
    expect(screen.getByTestId("transcript-jump-bottom")).toBeTruthy();
    // The replacement really landed: one click reaches the new tail.
    fireEvent.click(screen.getByTestId("transcript-jump-bottom"));
    expect(transcript.scrollTop).toBe(contentBottom(transcript));
    expect(screen.getByText("committed send")).toBeTruthy();
    expect(screen.queryByText("pending send")).toBeNull();
  });
});
