import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, cleanup, act } from "@testing-library/react";
import { RuntimeProvider, useRuntimeStore } from "./runtime-provider";
import { ResumeRefetch } from "./use-resume-refetch";
import { FakeWebSocket, flush, lastFrame, snapshotPayload } from "./testing/harness";
import { queryKeys } from "@/api/query-keys";
import type { RuntimeSocketDeps } from "./socket";
import type { SessionStore } from "./session-store";
import { useEffect } from "react";

// ResumeRefetch mounts below RuntimeProvider + QueryClientProvider and
// revalidates the HTTP boot surface when the PWA resumes (visibility / online /
// runtime WS reconnect). Tests drive the runtime through a FakeWebSocket and
// dispatch real DOM events, exactly like the runtime-provider tests.

let SOCKETS: FakeWebSocket[] = [];
function fakeDeps(): RuntimeSocketDeps {
  return {
    createWebSocket: (url) => { const ws = new FakeWebSocket(url); SOCKETS.push(ws); return ws; },
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    random: () => 0.5,
    location: { href: "https://pix.local/app/" },
    identity: { shell: "web", platform: "mac" },
    onOnline: () => () => undefined,
    onVisible: () => () => undefined,
  };
}

let capturedStore: SessionStore | null = null;
function Capture(): null {
  const store = useRuntimeStore();
  useEffect(() => { capturedStore = store; }, [store]);
  return null;
}

function mount(): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <RuntimeProvider deps={fakeDeps()}>
        <Capture />
        <ResumeRefetch />
      </RuntimeProvider>
    </QueryClientProvider>,
  );
  return qc;
}

function ack() {
  return { type: "handshake_ack", payload: { protocolVersion: 2, host: { mode: "local", capabilities: ["agent"] }, limits: { maxUpload: 0, maxOpenSessions: 4 }, sessionSnapshotSupport: true } };
}

async function driveReady(): Promise<FakeWebSocket> {
  const store = capturedStore!;
  let ws: FakeWebSocket | undefined;
  await act(async () => {
    store.connect();
    ws = SOCKETS[SOCKETS.length - 1]!;
    ws.serverOpen();
    ws.serverSend(ack());
    await flush();
  });
  return ws!;
}

/** The exact boot-surface query keys ResumeRefetch must revalidate. */
const RESUME_KEYS: readonly (readonly unknown[])[] = [
  queryKeys.capabilities.all,
  queryKeys.capabilities.bootstrap(),
  queryKeys.gate.status(),
  queryKeys.sessions.lists,
];

type InvalidateSpy = MockInstance;
function expectInvalidated(spy: InvalidateSpy, keys: readonly (readonly unknown[])[]): void {
  for (const key of keys) {
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: key }));
  }
}

describe("useResumeRefetch — boot surface revalidation on resume", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("does NOT refetch on initial mount / first connect (idle → ready)", async () => {
    const qc = mount();
    const spy = vi.spyOn(qc, "invalidateQueries");
    await driveReady();
    vi.advanceTimersByTime(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it("revalidates the boot surface on visibility resume (background → foreground)", () => {
    const qc = mount();
    const spy = vi.spyOn(qc, "invalidateQueries");
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(1);
    expectInvalidated(spy, RESUME_KEYS);
  });

  it("revalidates the boot surface on network recovery (online)", () => {
    const qc = mount();
    const spy = vi.spyOn(qc, "invalidateQueries");
    window.dispatchEvent(new Event("online"));
    vi.advanceTimersByTime(1);
    expectInvalidated(spy, RESUME_KEYS);
  });

  it("revalidates the boot surface when the runtime WS reconnects (unavailable → ready)", async () => {
    const qc = mount();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const ws = await driveReady();
    // Drop the connection → unavailable (observed by the hook).
    await act(async () => {
      ws.serverClose(1006);
      await flush();
    });
    expect(capturedStore!.getSnapshot().connection).toBe("unavailable");
    // Backoff timer fires → a fresh reconnect socket is created.
    await act(async () => {
      vi.advanceTimersByTime(250);
      await flush();
    });
    const ws2 = SOCKETS[SOCKETS.length - 1]!;
    expect(ws2).not.toBe(ws);
    // Re-handshake → ready (observed by the hook).
    await act(async () => {
      ws2.serverOpen();
      ws2.serverSend(ack());
      await flush();
    });
    expect(capturedStore!.getSnapshot().connection).toBe("ready");
    vi.advanceTimersByTime(1); // the coalesced invalidation burst
    expectInvalidated(spy, RESUME_KEYS);
  });

  it("coalesces same-tick resume triggers into ONE invalidation burst", async () => {
    const qc = mount();
    const spy = vi.spyOn(qc, "invalidateQueries");
    // A single resume event fires visibility + online together; both must map
    // to one invalidate pass (one call per query-key group, never a second).
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("online"));
      await flush();
    });
    vi.advanceTimersByTime(1); // the single coalesced invalidation burst
    expect(spy).toHaveBeenCalledTimes(RESUME_KEYS.length);
    expectInvalidated(spy, RESUME_KEYS);
  });

  it("does not refetch on a transient non-disconnected transition", async () => {
    const qc = mount();
    const spy = vi.spyOn(qc, "invalidateQueries");
    // attach (connecting → handshaking → ready) never passes through
    // unavailable/reconnecting, so no resume refetch fires.
    const ws = await driveReady();
    await act(async () => {
      void capturedStore!.openSession("s1");
      await flush();
      const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
      ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1" }) });
      await flush();
    });
    vi.advanceTimersByTime(1);
    expect(spy).not.toHaveBeenCalled();
  });
});
