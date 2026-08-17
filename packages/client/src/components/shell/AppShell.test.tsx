import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, act, screen, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { AppShell } from "./AppShell";
import type { WorkspaceSearch } from "@/lib/search-params";
import { queryKeys } from "@/api/query-keys";
import type { SessionHeader } from "@fffattiger/pix-protocol";
import { RuntimeProvider, useRuntimeStore } from "@/runtime/runtime-provider";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { I18nProvider } from "@/hooks/useI18n";
import { HttpClientProvider } from "@/app/http-context";
import { ContextMenuProvider } from "@/components/ContextMenu";
import { FakeWebSocket, flush, lastFrame, snapshotPayload } from "@/runtime/testing/harness";
import { setWatchSessionFactory, type WatchConnectionState, type WatchSession } from "@/api/files-watch";
import type { RuntimeSocketDeps } from "@/runtime/socket";
import type { HostInfo } from "@fffattiger/pix-protocol";
import type { SessionStore } from "@/runtime/session-store";

// AppShell is the single owner of URL-session → runtime lifecycle; this suite
// proves read-only selection never activates a target, background subscriptions
// remain identity-gated, and send-time supersession has no hung/late clobber.

const navigateMock = vi.fn();
vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-router")>(
    "@tanstack/react-router",
  );
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

class ResizeObserverStub {
  observe(): void { /* jsdom no-op */ }
  unobserve(): void { /* jsdom no-op */ }
  disconnect(): void { /* jsdom no-op */ }
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};
// jsdom has no matchMedia; the theme/shell hooks need a permissive stub.
(globalThis as { matchMedia?: unknown }).matchMedia ??= (query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  addListener: () => undefined,
  removeListener: () => undefined,
  dispatchEvent: () => false,
});

const SOCKETS: FakeWebSocket[] = [];
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

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function jsonStatus(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Manual promise the test resolves/rejects to deterministically control /context fetches. */
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type Deferred = ReturnType<typeof createDeferred<Response>>;

// Timestamps are the real wall clock so the rows land in the default-expanded
// "today" group (the "earlier" group is collapsed by default and would not
// render rows in jsdom).
const SESSION_HEADERS: readonly SessionHeader[] = [
  { sessionId: "A", cwd: "/x", projectRoot: "/x", title: "Session A", createdAt: 1000, updatedAt: Date.now(), messageCount: 1 },
  { sessionId: "B", cwd: "/x", projectRoot: "/x", title: "Session B", createdAt: 1000, updatedAt: Date.now(), messageCount: 1 },
  { sessionId: "C", cwd: "/x", projectRoot: "/x", title: "Session C", createdAt: 1000, updatedAt: Date.now(), messageCount: 1 },
];

/**
 * Host HTTP stub whose /context responses are test-controlled per session id
 * (deferred), so the prepare→commit boundary is observable: before the first
 * page settles the URL must NOT change. `contextCalls` records every context
 * request (to prove warm-cache commits issue none).
 */
function controllableStubFetch(opts: {
  sessions?: readonly SessionHeader[];
  contextDeferreds?: Map<string, Deferred>;
  contextCalls?: string[];
  contextError?: { body: unknown; status: number };
}): typeof fetch {
  const sessions = opts.sessions ?? [];
  return vi.fn(async (input: RequestInfo | URL) => {
    const path = typeof input === "string"
      ? input
      : input instanceof URL
        ? `${input.pathname}${input.search}`
        : input.url;
    const p = String(path);
    if (p.includes("/v1/gate/status")) return json({ status: "enabled", required: false, authenticated: false, mode: "local" });
    if (p.includes("/v1/sessions/") && p.includes("/context")) {
      const id = decodeURIComponent(p.split("/v1/sessions/")[1]!.split("/")[0]!);
      opts.contextCalls?.push(id);
      if (opts.contextError !== undefined) return jsonStatus(opts.contextError.body, opts.contextError.status);
      const deferred = createDeferred<Response>();
      opts.contextDeferreds?.set(id, deferred);
      return deferred.promise;
    }
    if (p.includes("/v1/sessions/") && p.includes("/tree")) {
      const id = decodeURIComponent(p.split("/v1/sessions/")[1]!.split("/")[0]!);
      return json({ tree: { sessionId: id, roots: [], entryCount: 0 } });
    }
    if (p.includes("/v1/sessions")) return json({ sessions, revision: 0 });
    if (p.includes("/v1/worktrees")) return json({ projectRoot: "/x", isGit: true, isTopLevel: true, worktrees: [] });
    if (p.includes("/v1/models")) return json(modelsCatalog);
    if (p.includes("/v1/files/") && p.includes("/index")) return json({ files: [], truncated: false });
    if (p.includes("/v1/skills")) return json({ skills: [] });
    return json({});
  }) as unknown as typeof fetch;
}

function contextResponse(sessionId: string): Response {
  return json({ context: { sessionId, entries: [], pageInfo: { hasMore: false } } });
}

/** Host HTTP stub: valid empty payloads for the endpoints the shell tree queries. */
function stubFetch(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const path = typeof input === "string"
      ? input
      : input instanceof URL
        ? `${input.pathname}${input.search}`
        : input.url;
    const p = String(path);
    if (p.includes("/v1/gate/status")) return json({ status: "enabled", required: false, authenticated: false, mode: "local" });
    if (p.includes("/v1/sessions/") && p.includes("/context")) {
      const id = decodeURIComponent(p.split("/v1/sessions/")[1]!.split("/")[0]!);
      return json({ context: { sessionId: id, entries: [], pageInfo: { hasMore: false } } });
    }
    if (p.includes("/v1/sessions/") && p.includes("/tree")) {
      const id = decodeURIComponent(p.split("/v1/sessions/")[1]!.split("/")[0]!);
      return json({ tree: { sessionId: id, roots: [], entryCount: 0 } });
    }
    if (p.includes("/v1/sessions")) return json({ sessions: [], revision: 0 });
    if (p.includes("/v1/worktrees")) return json({ projectRoot: "/x", isGit: true, isTopLevel: true, worktrees: [] });
    if (p.includes("/v1/models")) return json(modelsCatalog);
    if (p.includes("/v1/files/") && p.includes("/index")) return json({ files: [], truncated: false });
    if (p.includes("/v1/skills")) return json({ skills: [] });
    return json({});
  }) as unknown as typeof fetch;
}

/** Configurable /v1/models response (reset by suites that exercise Composer controls). */
let modelsCatalog: { models: { id: string; provider: string; displayName?: string }[]; defaultModel: { id: string; provider: string } | null } = {
  models: [],
  defaultModel: null,
};

let capturedStore: SessionStore | null = null;
function Capture(): null {
  const store = useRuntimeStore();
  useEffect(() => { capturedStore = store; }, [store]);
  return null;
}

let previousFetch: typeof fetch;
function authenticatedQueryClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.gate.status(), { status: "enabled", required: false, authenticated: false, mode: "local" });
  return client;
}

function mountApp(search: WorkspaceSearch, opts: { queryClient?: QueryClient; capabilities?: HostInfo["capabilities"] } = {}) {
  const qc = opts.queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host: Partial<HostInfo> = {
    mode: "local",
    capabilities: opts.capabilities ?? ["agent", "sessions", "files", "models"],
  };
  const Tree = ({ search: s }: { search: WorkspaceSearch }): ReactNode => (
    <QueryClientProvider client={qc}>
      <HttpClientProvider>
        <CapabilityProvider host={host}>
          <RuntimeProvider deps={fakeDeps()}>
            <I18nProvider>
              <ContextMenuProvider>
                <Capture />
                <AppShell search={s} />
              </ContextMenuProvider>
            </I18nProvider>
          </RuntimeProvider>
        </CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>
  );
  const view = render(<Tree search={search} />);
  return {
    rerender: (s: WorkspaceSearch) => view.rerender(<Tree search={s} />),
    queryClient: qc,
  };
}

function ack(): unknown {
  return { type: "handshake_ack", payload: { protocolVersion: 2, host: { mode: "local", capabilities: ["agent"] }, limits: { maxUpload: 0, maxOpenSessions: 4 }, sessionSnapshotSupport: true } };
}

async function connectReady(): Promise<FakeWebSocket> {
  let ws: FakeWebSocket | undefined;
  await act(async () => {
    capturedStore!.connect();
    ws = SOCKETS[SOCKETS.length - 1]!;
    ws.serverOpen();
    ws.serverSend(ack());
    await flush();
  });
  return ws!;
}

/** Accept the socket that AppShell opens automatically on mount. */
async function acceptAutomaticConnection(): Promise<FakeWebSocket> {
  await act(async () => {
    // Gate status resolves through React Query before AppShell is allowed to
    // open the control-plane socket.
    for (let i = 0; i < 12 && SOCKETS.length === 0; i += 1) await flush();
  });
  expect(SOCKETS).toHaveLength(1);
  const ws = SOCKETS[0]!;
  await act(async () => {
    ws.serverOpen();
    ws.serverSend(ack());
    await flush();
  });
  return ws;
}

function countType(ws: FakeWebSocket, type: string): number {
  return ws.sent.filter((f) => (f as { type: string }).type === type).length;
}

describe("AppShell — read-only session selection (0-Worker history; send is the only activation)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    SOCKETS.length = 0;
    capturedStore = null;
    navigateMock.mockReset();
    previousFetch = globalThis.fetch;
    globalThis.fetch = stubFetch();
  });
  afterEach(() => { cleanup(); globalThis.fetch = previousFetch; vi.useRealTimers(); });

  it("selecting a session is read-only and preserves the existing background subscription", async () => {
    const { rerender } = mountApp({ cwd: "/x" });
    const ws = await connectReady();
    // Attach fully to A (live).
    await act(async () => {
      void capturedStore!.openSession("A");
      await flush();
      const attach = lastFrame<{ type: string; id: string }>(ws, "attach")!;
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A" }) });
      await flush();
    });
    expect(capturedStore!.getSnapshot().sessionId).toBe("A");
    expect(capturedStore!.getSnapshot().attached).toBe(true);
    const attachCountBefore = countType(ws, "attach");
    // Select B → read-only history: NO attach/open for B and no teardown of A.
    // A stays subscribed in the background so its running/completion events can
    // update the shared sidebar/project/tab state without leaking into B's UI.
    rerender({ cwd: "/x", session: "B" });
    await flush();
    expect(ws.sent.filter((frame) => (frame as { type: string }).type === "detach")).toHaveLength(0);
    expect(countType(ws, "attach")).toBe(attachCountBefore);
    expect(capturedStore!.getSnapshot().attached).toBe(true);
    expect(capturedStore!.getSnapshot().sessionId).toBe("A");
  });

  it("auto-attaches a BUSY selected session after refresh and resumes the live stream", async () => {
    // Refresh mid-stream: the URL session's worker is still running server-side
    // (listRunning reports busy). The read-only rule covers IDLE history only —
    // a running session must be taken over live: attach, restore the in-flight
    // partial from the snapshot, and keep receiving message_update events.
    mountApp({ cwd: "/x", session: "A" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection();
    const list = lastFrame<{ type: string; id: string }>(ws, "listRunning")!;
    await act(async () => {
      ws.serverSend({
        type: "response",
        id: list.id,
        payload: {
          ok: true,
          result: { sessions: [{ sessionId: "A", cwd: "/x", projectRoot: "/x", workerStatus: "busy", epoch: "e1" }] },
        },
      });
      await flush();
    });
    // The busy baseline alone must trigger the takeover attach for A.
    const attach = lastFrame<{ type: string; id: string; payload?: { sessionId?: string } }>(ws, "attach")!;
    expect(attach.payload?.sessionId ?? undefined).toBe("A");
    const base = snapshotPayload({ sessionId: "A", model: { provider: "openai", id: "gpt-5" }, capabilities: ["runtime.prompt", "runtime.abort"] });
    const baseSnapshot = base.snapshot as {
      state: Record<string, unknown>;
      streaming: Record<string, unknown>;
    };
    await act(async () => {
      ws.serverSend({
        type: "snapshot",
        id: attach.id,
        payload: {
          ...base,
          snapshot: {
            ...baseSnapshot,
            state: { ...baseSnapshot.state, isStreaming: true, isPromptRunning: true },
            streaming: {
              active: true,
              streamId: "st1",
              messageId: "m1",
              phase: "streaming",
              partialMessage: {
                role: "assistant",
                content: [{ type: "text", text: "partial so far" }],
                model: "gpt-5",
                provider: "openai",
              },
            },
          },
        },
      });
      await flush();
    });
    expect(capturedStore!.getSnapshot().attached).toBe(true);
    expect(capturedStore!.getSnapshot().sessionId).toBe("A");
    // The streaming partial publishes on a ~90ms throttle: advance the fake
    // clock and let a benign event recompute the view.
    await act(async () => {
      vi.advanceTimersByTime(200);
      ws.serverSend({ type: "event", payload: { type: "queue_update", sessionId: "A", steering: [], followUp: [], eventId: 1, epoch: "e1" } });
      await flush();
    });
    // Live view active: the running turn shows the recovered partial (each
    // char is wrapped in a fade span, so assert on the composite text) and the
    // composer offers Stop (the session reads as in-progress again).
    expect(document.body.textContent).toContain("partial so far");
    expect(screen.getByLabelText("Stop agent")).toBeTruthy();
    // A later delta continues the stream on the wire.
    await act(async () => {
      ws.serverSend({
        type: "event",
        payload: {
          type: "message_update",
          sessionId: "A",
          streamId: "st1",
          messageId: "m1",
          delta: { role: "assistant", content: [{ type: "text", text: " …continued" }] },
          eventId: 2,
          epoch: "e1",
        },
      });
      await flush();
      // Publish throttle for the streaming partial: advance past the interval.
      vi.advanceTimersByTime(200);
      await flush();
    });
    expect(capturedStore!.getSnapshot().streamingPartial?.role).toBe("assistant");
  });

  it("does NOT attach an idle selected session (read-only history invariant)", async () => {
    mountApp({ cwd: "/x", session: "B" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection();
    const list = lastFrame<{ type: string; id: string }>(ws, "listRunning")!;
    await act(async () => {
      ws.serverSend({
        type: "response",
        id: list.id,
        payload: {
          ok: true,
          result: { sessions: [{ sessionId: "A", cwd: "/x", projectRoot: "/x", workerStatus: "busy", epoch: "e1" }] },
        },
      });
      await flush();
    });
    expect(lastFrame(ws, "attach")).toBeUndefined();
  });

  it("keeps New Session available while another session tab is attached", async () => {
    mountApp({ cwd: "/x", session: "A" });
    const ws = await connectReady();
    await act(async () => {
      void capturedStore!.openSession("A");
      await flush();
      const attach = lastFrame<{ type: string; id: string }>(ws, "attach")!;
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A" }) });
      await flush();
    });

    expect(screen.getByTestId("sidebar-new-session").hasAttribute("disabled")).toBe(false);
  });

  it("rapid read-only selection B→C keeps the background subscription and never attaches either target", async () => {
    const { rerender } = mountApp({ cwd: "/x" });
    const ws = await connectReady();
    await act(async () => {
      void capturedStore!.openSession("A");
      await flush();
      const attach = lastFrame<{ type: string; id: string }>(ws, "attach")!;
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A" }) });
      await flush();
    });
    const attachCountBefore = countType(ws, "attach");
    rerender({ cwd: "/x", session: "B" });
    await flush();
    rerender({ cwd: "/x", session: "C" });
    await flush();
    expect(ws.sent.filter((frame) => (frame as { type: string }).type === "detach")).toHaveLength(0);
    expect(countType(ws, "attach")).toBe(attachCountBefore);
    expect(capturedStore!.getSnapshot().attached).toBe(true);
    expect(capturedStore!.getSnapshot().sessionId).toBe("A");
    expect(capturedStore!.getSnapshot().error).toBeNull();
  });
});

describe("AppShell — no-flicker session navigation (prepare → atomic commit)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    SOCKETS.length = 0;
    capturedStore = null;
    navigateMock.mockReset();
    previousFetch = globalThis.fetch;
  });
  afterEach(() => { cleanup(); globalThis.fetch = previousFetch; vi.useRealTimers(); });

  /**
   * Flush microtasks AND advance the fake timer so React Query's
   * `setTimeout(0)` observer notifications fire (query data → sidebar rows).
   * Never advances beyond 0ms so the HttpClient's 15s abort signal stays quiet.
   */
  async function settle(): Promise<void> {
    await act(async () => {
      for (let round = 0; round < 3; round += 1) {
        await flush(20);
        vi.advanceTimersByTime(0);
      }
      await flush(20);
    });
  }

  it("never swaps the URL/session before the first history page settles; only the target row shows pending; commits atomically", async () => {
    const contextDeferreds = new Map<string, Deferred>();
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS, contextDeferreds });
    mountApp({ cwd: "/x" });
    // Wait for the sessions list so the sidebar rows render.
    await settle();
    expect(screen.getByTestId("session-select-B")).toBeTruthy();
    // Click B → prepare starts; its first page is in flight (deferred).
    fireEvent.click(screen.getByTestId("session-select-B"));
    await act(async () => { await flush(8); });
    // BEFORE the first page settles: no URL/navigation, no session swap, and
    // the current frame is untouched (still the select hint, not a loading B).
    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("transcript-home")).toBeTruthy();
    // Immediate lightweight pending cue ONLY on the target row.
    expect(screen.getByLabelText("Opening session…")).toBeTruthy();
    const bDeferred = contextDeferreds.get("B");
    expect(bDeferred).toBeDefined();
    // First page settles → ATOMIC commit (single navigation, cwd preserved).
    await act(async () => {
      bDeferred!.resolve(contextResponse("B"));
      await flush(12);
    });
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ to: "/", search: { session: "B", cwd: "/x" } }));
    // Pending cue cleared after commit.
    expect(screen.queryByLabelText("Opening session…")).toBeNull();
  });

  it("commits immediately from a warm cache without issuing a context fetch", async () => {
    const contextCalls: string[] = [];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Pre-seed B's exact first history page — the SAME key the prepare uses
    // (centralized cache authority), so ensureInfiniteQueryData resolves from
    // the cache and never hits the network.
    qc.setQueryData(queryKeys.sessions.history("B", 0, null), {
      pages: [{ context: { sessionId: "B", entries: [], pageInfo: { hasMore: false } } }],
      pageParams: [{}],
    });
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS, contextCalls });
    mountApp({ cwd: "/x" }, { queryClient: qc });
    await settle();
    fireEvent.click(screen.getByTestId("session-select-B"));
    await act(async () => { await flush(8); });
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ search: { session: "B", cwd: "/x" } }));
    // Warm cache → zero context requests issued.
    expect(contextCalls).toEqual([]);
  });

  it("rapid B→C: latest intent wins; a late B completion never navigates back", async () => {
    const contextDeferreds = new Map<string, Deferred>();
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS, contextDeferreds });
    mountApp({ cwd: "/x" });
    await settle();
    // Click B, then C before B's first page settles.
    fireEvent.click(screen.getByTestId("session-select-B"));
    await act(async () => { await flush(6); });
    fireEvent.click(screen.getByTestId("session-select-C"));
    await act(async () => { await flush(6); });
    const bDeferred = contextDeferreds.get("B");
    const cDeferred = contextDeferreds.get("C");
    expect(bDeferred).toBeDefined();
    expect(cDeferred).toBeDefined();
    // B settles AFTER C was clicked → superseded, must NOT navigate.
    await act(async () => {
      bDeferred!.resolve(contextResponse("B"));
      await flush(12);
    });
    expect(navigateMock).not.toHaveBeenCalled();
    // C settles → latest intent commits exactly once.
    await act(async () => {
      cDeferred!.resolve(contextResponse("C"));
      await flush(12);
    });
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ search: { session: "C", cwd: "/x" } }));
  });

  it("a prefetch error still commits so the target's honest error surface renders", async () => {
    globalThis.fetch = controllableStubFetch({
      sessions: SESSION_HEADERS,
      contextError: { body: { message: "not found", code: "SESSION_NOT_FOUND" }, status: 404 },
    });
    const { queryClient } = mountApp({ cwd: "/x" });
    await settle();
    fireEvent.click(screen.getByTestId("session-select-B"));
    await act(async () => { await flush(12); });
    // Error commits navigation so the detail frame can render B's honest error.
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ search: { session: "B", cwd: "/x" } }));
    // The error is in the shared cache under the exact key the detail frame
    // mounts against (retryOnMount:false → no refetch-spinner before the error).
    const state = queryClient.getQueryState(queryKeys.sessions.history("B", 0, null));
    expect(state?.status).toBe("error");
    expect(screen.queryByLabelText("Opening session…")).toBeNull();
  });

  it("zero runtime attach frames during prepare+commit (0-Worker history)", async () => {
    const contextDeferreds = new Map<string, Deferred>();
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS, contextDeferreds });
    mountApp({ cwd: "/x" });
    const ws = await connectReady();
    // Attach fully to A (live).
    await act(async () => {
      void capturedStore!.openSession("A");
      await flush();
      const attach = lastFrame<{ type: string; id: string }>(ws, "attach")!;
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A" }) });
      await flush();
    });
    expect(capturedStore!.getSnapshot().attached).toBe(true);
    const attachCountBefore = countType(ws, "attach");
    await settle(); // sessions list renders rows
    // Click B (history) → prepare; the live A frame stays mounted + correct.
    fireEvent.click(screen.getByTestId("session-select-B"));
    await act(async () => { await flush(6); });
    expect(capturedStore!.getSnapshot().attached).toBe(true);
    expect(capturedStore!.getSnapshot().sessionId).toBe("A");
    // Commit B once its first page settles.
    await act(async () => {
      contextDeferreds.get("B")!.resolve(contextResponse("B"));
      await flush(12);
    });
    expect(navigateMock).toHaveBeenCalledTimes(1);
    // Selection never activates a worker: zero attach frames across the whole
    // prepare+commit flow.
    expect(countType(ws, "attach")).toBe(attachCountBefore);
    expect(capturedStore!.getSnapshot().attached).toBe(true);
    expect(capturedStore!.getSnapshot().sessionId).toBe("A");
  });
});

// Runtime capabilities the LIVE test snapshots advertise so the composer's
// model/thinking controls are offered (immediate live commands), matching a
// real agent runtime.
const LIVE_CAPS = ["runtime.prompt", "runtime.abort", "runtime.model.set", "runtime.thinking.set"];

async function mountLiveA(ws: FakeWebSocket): Promise<void> {
  // Assumes mountApp({ cwd: "/x" }) + connectReady() already ran.
  await act(async () => {
    void capturedStore!.openSession("A");
    await flush();
    const attach = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A", model: { provider: "openai", id: "gpt-5" }, capabilities: LIVE_CAPS }) });
    await flush();
  });
  // Let the React Query /v1/models catalog settle so the model selector renders.
  await act(async () => { await flush(); });
}

/** Select B as read-only history while A remains the background subscription. */
async function selectDetachedB(_ws: FakeWebSocket, rerender: (s: WorkspaceSearch) => void): Promise<void> {
  rerender({ cwd: "/x", session: "B" });
  await act(async () => { await flush(); });
  // Let B's transcript + model catalog queries settle.
  await act(async () => { await flush(); });
}

async function ackBackgroundDetach(ws: FakeWebSocket, sessionId = "A"): Promise<void> {
  const detach = lastFrame<{ type: string; id: string }>(ws, "detach")!;
  await act(async () => {
    ws.serverSend({ type: "response", id: detach.id, payload: { ok: true, result: { sessionId, detached: true } } });
    await flush();
  });
}

/** Open the model dropdown, search a name, click the matching row (stages or issues, per state). */
async function pickModel(name: string): Promise<void> {
  await act(async () => { fireEvent.click(screen.getByLabelText("Change model")); await flush(); });
  const search = screen.getByLabelText("Search models…");
  await act(async () => { fireEvent.change(search, { target: { value: name } }); await flush(); });
  const row = [...document.querySelectorAll<HTMLButtonElement>(".model-row button")]
    .find((b) => b.textContent?.includes(name));
  if (!row) throw new Error(`model row not found: ${name}`);
  await act(async () => { fireEvent.click(row); await flush(); });
}

/** Open the reasoning dropdown and click the exact level option. */
async function pickThinking(level: string): Promise<void> {
  await act(async () => { fireEvent.click(screen.getByLabelText("Change reasoning level")); await flush(); });
  const panel = [...document.querySelectorAll<HTMLDivElement>(".chat-input-menu-panel")]
    .find((el) => el.textContent?.includes(level));
  const btn = [...(panel?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
    .find((b) => b.textContent === level);
  if (!btn) throw new Error(`thinking option not found: ${level}`);
  await act(async () => { fireEvent.click(btn); await flush(); });
}

describe("Composer — staged activation controls across A→B (stable toolbar, honest baselines)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    SOCKETS.length = 0;
    capturedStore = null;
    navigateMock.mockReset();
    previousFetch = globalThis.fetch;
    modelsCatalog = {
      models: [
        { id: "gpt-5", provider: "openai", displayName: "GPT-5" },
        { id: "claude-opus-4", provider: "anthropic", displayName: "Claude Opus 4" },
        { id: "claude-sonnet-4", provider: "anthropic", displayName: "Claude Sonnet 4" },
      ],
      defaultModel: { id: "claude-opus-4", provider: "anthropic" },
    };
    globalThis.fetch = stubFetch();
  });
  afterEach(() => { cleanup(); globalThis.fetch = previousFetch; vi.useRealTimers(); });

  it("detached B renders model + reasoning selectors; picking options emits ZERO attach/command frames; A values never shown as B", async () => {
    const { rerender } = mountApp({ cwd: "/x", session: "A" });
    const ws = await connectReady();
    await mountLiveA(ws);
    // LIVE A: model + reasoning selectors present, showing A's runtime model.
    expect(screen.getByLabelText("Change model").textContent).toContain("GPT-5");
    expect(screen.getByLabelText("Change reasoning level")).toBeTruthy();

    // Select B → DETACHED: toolbar structure stays stable (both selectors remain).
    await selectDetachedB(ws, rerender);
    const modelBtnB = screen.getByLabelText("Change model");
    const thinkingBtnB = screen.getByLabelText("Change reasoning level");
    expect(modelBtnB).toBeTruthy();
    expect(thinkingBtnB).toBeTruthy();

    // Honest B baseline: Host defaultModel (never A's gpt-5), thinking neutral auto.
    expect(modelBtnB.textContent).toContain("Claude Opus 4");
    expect(modelBtnB.textContent).not.toContain("GPT-5");
    expect(thinkingBtnB.textContent).toContain("auto");

    // Picking a model + a thinking level while detached: ZERO attach/command frames.
    const attachBefore = countType(ws, "attach");
    const commandBefore = countType(ws, "command");
    await pickModel("Claude Sonnet 4");
    await pickThinking("high");
    expect(countType(ws, "attach")).toBe(attachBefore);
    expect(countType(ws, "command")).toBe(commandBefore);
    // The staged values now display on B (still never A's).
    expect(screen.getByLabelText("Change model").textContent).toContain("Claude Sonnet 4");
    expect(screen.getByLabelText("Change model").textContent).not.toContain("GPT-5");
    expect(screen.getByLabelText("Change reasoning level").textContent).toContain("high");
  });

  it("sending from detached B applies staged model THEN thinking THEN prompt exactly once after attach", async () => {
    const { rerender } = mountApp({ cwd: "/x" });
    const ws = await connectReady();
    await mountLiveA(ws);
    await selectDetachedB(ws, rerender);
    await pickModel("Claude Sonnet 4");
    await pickThinking("high");

    const textarea = document.querySelector<HTMLTextAreaElement>(".chat-input-textarea")!;
    await act(async () => { fireEvent.change(textarea, { target: { value: "hello staged" } }); await flush(); });
    await act(async () => { fireEvent.click(screen.getByLabelText("Send message")); await flush(); });
    // UI-first: B's bubble and running indicators are visible before A detach /
    // B attach settles. The overlay belongs only to B, never the still-attached A.
    expect(screen.getByText("hello staged")).toBeTruthy();
    expect(document.querySelector('[data-tab-id="session:B"]')?.getAttribute("data-running")).toBe("true");
    expect(capturedStore!.getSnapshot().optimisticRunningSessionId).toBe("B");
    expect(capturedStore!.getSnapshot().snapshot?.state.isPromptRunning).toBe(false);

    // Sending B supersedes the retained background A subscription.
    expect(countType(ws, "command")).toBe(0);
    await ackBackgroundDetach(ws);
    const attach = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    expect(attach.payload.sessionId).toBe("B");
    expect(countType(ws, "command")).toBe(0);
    await act(async () => {
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "B" }) });
      await flush();
    });
    expect(screen.getByText("hello staged")).toBeTruthy();
    // 1) set_model (staged, deterministic first).
    const modelCmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; provider: string; modelId: string } } }>(ws, "command")!;
    expect(modelCmd.payload.command.type).toBe("set_model");
    expect(modelCmd.payload.command.provider).toBe("anthropic");
    expect(modelCmd.payload.command.modelId).toBe("claude-sonnet-4");
    await act(async () => {
      ws.serverSend({ type: "response", id: modelCmd.id, payload: { ok: true, result: { commandId: modelCmd.payload.command.commandId, result: { ok: true, type: "set_model" } } } });
      await flush();
    });
    // 2) set_thinking_level after model resolved.
    const thinkingCmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; level: string } } }>(ws, "command")!;
    expect(thinkingCmd.payload.command.type).toBe("set_thinking_level");
    expect(thinkingCmd.payload.command.level).toBe("high");
    await act(async () => {
      ws.serverSend({ type: "response", id: thinkingCmd.id, payload: { ok: true, result: { commandId: thinkingCmd.payload.command.commandId, result: { ok: true, type: "set_thinking_level" } } } });
      await flush();
    });
    // 3) prompt exactly once.
    const promptFrames = ws.sent.filter((f) => (f as { payload?: { command?: { type?: string } } }).payload?.command?.type === "prompt");
    expect(promptFrames).toHaveLength(1);
    const promptCmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; message: string } } }>(ws, "command")!;
    expect(promptCmd.payload.command.type).toBe("prompt");
    expect(promptCmd.payload.command.message).toBe("hello staged");
    await act(async () => {
      ws.serverSend({ type: "response", id: promptCmd.id, payload: { ok: true, result: { commandId: promptCmd.payload.command.commandId, result: { ok: true, type: "prompt" } } } });
      await flush();
    });
    expect(capturedStore!.getSnapshot().promptPending).toBe(false);
    expect(capturedStore!.getSnapshot().sessionId).toBe("B");
    expect(capturedStore!.getSnapshot().attached).toBe(true);
  });

  it("staged settings failure on send: NO prompt, draft restored (message back in the composer)", async () => {
    const { rerender } = mountApp({ cwd: "/x" });
    const ws = await connectReady();
    await mountLiveA(ws);
    await selectDetachedB(ws, rerender);
    await pickModel("Claude Sonnet 4");

    const textarea = document.querySelector<HTMLTextAreaElement>(".chat-input-textarea")!;
    await act(async () => { fireEvent.change(textarea, { target: { value: "do not deliver" } }); await flush(); });
    await act(async () => { fireEvent.click(screen.getByLabelText("Send message")); await flush(); });

    await ackBackgroundDetach(ws);
    const attach = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    await act(async () => {
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "B" }) });
      await flush();
    });
    const modelCmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; provider: string; modelId: string } } }>(ws, "command")!;
    expect(modelCmd.payload.command.type).toBe("set_model");
    // Runtime rejects the staged model (unsupported) → proven non-delivery.
    await act(async () => {
      ws.serverSend({ type: "response", id: modelCmd.id, payload: { ok: true, result: { commandId: modelCmd.payload.command.commandId, result: { ok: false, type: "set_model", error: { code: "unsupported_capability", message: "runtime.model.set not available", retryable: false } } } } });
      await flush();
    });
    expect(ws.sent.some((f) => (f as { payload?: { command?: { type?: string } } }).payload?.command?.type === "prompt")).toBe(false);
    expect(capturedStore!.getSnapshot().promptPending).toBe(false);
    // The draft was restored into the composer.
    expect(document.querySelector<HTMLTextAreaElement>(".chat-input-textarea")?.value).toBe("do not deliver");
  });

  it("LIVE selected session: model/thinking controls still issue immediate commands (no staging)", async () => {
    const { } = mountApp({ cwd: "/x", session: "A" });
    const ws = await connectReady();
    await mountLiveA(ws);
    const commandBefore = countType(ws, "command");
    await pickModel("Claude Sonnet 4");
    // Immediate set_model command frame (not staged, no attach).
    const modelCmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; provider: string; modelId: string } } }>(ws, "command")!;
    expect(modelCmd.payload.command.type).toBe("set_model");
    expect(modelCmd.payload.command.provider).toBe("anthropic");
    expect(modelCmd.payload.command.modelId).toBe("claude-sonnet-4");
    expect(countType(ws, "attach")).toBe(1);
    expect(countType(ws, "command")).toBe(commandBefore + 1);
    await act(async () => {
      ws.serverSend({ type: "response", id: modelCmd.id, payload: { ok: true, result: { commandId: modelCmd.payload.command.commandId, result: { ok: true, type: "set_model" } } } });
      await flush();
    });
    await pickThinking("high");
    const thinkingCmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; level: string } } }>(ws, "command")!;
    expect(thinkingCmd.payload.command.type).toBe("set_thinking_level");
    expect(thinkingCmd.payload.command.level).toBe("high");
    await act(async () => {
      ws.serverSend({ type: "response", id: thinkingCmd.id, payload: { ok: true, result: { commandId: thinkingCmd.payload.command.commandId, result: { ok: true, type: "set_thinking_level" } } } });
      await flush();
    });
    // No prompt was sent by the control interactions alone.
    expect(ws.sent.some((f) => (f as { payload?: { command?: { type?: string } } }).payload?.command?.type === "prompt")).toBe(false);
  });
});

const PROJECT_SESSIONS: readonly SessionHeader[] = [
  ...SESSION_HEADERS,
  { sessionId: "D", cwd: "/y", projectRoot: "/y", title: "Session D", createdAt: 1000, updatedAt: Date.now(), messageCount: 1 },
];

describe("AppShell — source-like sidebar rail", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    SOCKETS.length = 0;
    capturedStore = null;
    navigateMock.mockReset();
    previousFetch = globalThis.fetch;
    modelsCatalog = { models: [], defaultModel: null };
    globalThis.fetch = controllableStubFetch({ sessions: PROJECT_SESSIONS });
  });
  afterEach(() => {
    cleanup();
    globalThis.fetch = previousFetch;
    window.localStorage.removeItem("pi-fork-tree-collapsed");
    window.localStorage.removeItem("pi-sidebar-item-state");
    vi.useRealTimers();
  });

  async function settle(): Promise<void> {
    await act(async () => {
      for (let round = 0; round < 3; round += 1) {
        await flush(20);
        vi.advanceTimersByTime(0);
      }
      await flush(20);
    });
  }

  function railOrder(): string[] {
    return [
      "sidebar-home-header",
      "sidebar-new-session",
      "sidebar-nav-plugins",
      "sidebar-nav-resources",
      "sidebar-projects",
      "sidebar-sessions",
      "sidebar-nav-settings",
    ].filter((id) => document.querySelector(`[data-testid="${id}"]`));
  }

  const catalogCaps: HostInfo["capabilities"] = ["agent", "sessions", "files", "models", "plugins", "skills"];

  it("renders the source hierarchy: Pix, New Session, Plugins, Resources, Projects, Sessions, Settings + title-bar file browser", async () => {
    mountApp({ cwd: "/x" }, { capabilities: catalogCaps });
    await settle();
    expect(screen.getByTestId("sidebar-brand").textContent).toBe("Pix");
    expect(screen.getByTestId("sidebar-new-session").textContent).toContain("New Session");
    expect(screen.getByTestId("sidebar-nav-plugins").textContent).toBe("Plugins");
    expect(screen.getByTestId("sidebar-nav-resources").textContent).toBe("Resources");
    expect(screen.getByTestId("sidebar-projects")).toBeTruthy();
    expect(screen.getByTestId("sidebar-sessions")).toBeTruthy();
    expect(screen.queryByTestId("sidebar-files")).toBeNull();
    expect(screen.getByTestId("sidebar-nav-settings").textContent).toBe("Settings");
    // The file browser toggle stays on the window's right edge so the panel
    // expands left from that button.
    expect(screen.getByTestId("file-browser-toggle")).toBeTruthy();
    expect(screen.getByTestId("file-browser-rail")).toBeTruthy();
    expect(railOrder()).toEqual([
      "sidebar-home-header",
      "sidebar-new-session",
      "sidebar-nav-plugins",
      "sidebar-nav-resources",
      "sidebar-projects",
      "sidebar-sessions",
      "sidebar-nav-settings",
    ]);
  });

  it("maps Plugins/Resources/Settings onto existing SettingsModal tabs and invents no counts", async () => {
    mountApp({ cwd: "/x" }, { capabilities: catalogCaps });
    await settle();
    expect(screen.queryByTestId("nav-packages-badge")).toBeNull();
    expect(screen.queryByTestId("sidebar-update-btn")).toBeNull();
    expect(screen.queryByTestId("crash-host")).toBeNull();
    expect(screen.queryByTestId("stop-host")).toBeNull();
    expect(screen.queryByTestId("fork-thread")).toBeNull();
    expect(screen.getByTestId("sidebar-nav-plugins").textContent).toBe("Plugins");
    expect(screen.getByTestId("sidebar-nav-resources").textContent).toBe("Resources");

    fireEvent.click(screen.getByTestId("sidebar-nav-plugins"));
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog).toBeTruthy();
    expect(dialog.querySelector('[aria-current="page"]')?.textContent).toBe("Plugins");

    fireEvent.click(screen.getByTestId("sidebar-nav-resources"));
    expect(dialog.querySelector('[aria-current="page"]')?.textContent).toBe("Skills");

    fireEvent.click(screen.getByTestId("sidebar-nav-settings"));
    expect(dialog.querySelector('[aria-current="page"]')?.textContent).toBe("Display");
    expect(screen.getByTestId("settings-tab-archive")).toBeTruthy();
  });

  it("restores an archived session from the settings archive tab", async () => {
    mountApp({ cwd: "/x" }, { capabilities: catalogCaps });
    await settle();
    const sessionRow = screen.getByTestId("session-select-A").closest(".sidebar-list-row") as HTMLElement;
    fireEvent.click(within(sessionRow).getByLabelText("Archive"));
    expect(screen.queryByTestId("session-select-A")).toBeNull();
    fireEvent.click(screen.getByTestId("sidebar-nav-settings"));
    fireEvent.click(screen.getByTestId("settings-tab-archive"));
    expect(screen.getByTestId("archive-row")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(screen.getByTestId("session-select-A")).toBeTruthy();
  });

  it("New Session starts create without a redundant home navigation or extra catalog chrome", async () => {
    mountApp({ cwd: "/x" }, { capabilities: catalogCaps });
    const ws = await connectReady();
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByTestId("sidebar-new-session"));
      await flush();
    });
    expect(lastFrame(ws, "create")).toBeTruthy();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("sidebar-nav-plugins").textContent).toBe("Plugins");
    expect(screen.getByTestId("sidebar-nav-resources").textContent).toBe("Resources");
  });

  it("sends the first home prompt after create even when URL navigation remounts the composer", async () => {
    const view = mountApp({ cwd: "/x" });
    navigateMock.mockImplementation(async (options: { search: WorkspaceSearch }) => {
      view.rerender(options.search);
      await flush();
    });
    const ws = await connectReady();
    await settle();

    const textarea = document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "first from home" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    await act(async () => { await flush(8); });

    // Empty-home send must not navigate to the same cwd before create; that
    // redundant route commit was the visible first-Enter refresh.
    expect(navigateMock).not.toHaveBeenCalled();
    const create = lastFrame<{ type: string; id: string }>(ws, "create")!;
    expect(create).toBeTruthy();
    await act(async () => {
      ws.serverSend({
        type: "response",
        id: create.id,
        payload: { ok: true, result: { sessionId: "new-home", epoch: "e1", created: true, cwd: "/x", projectRoot: "/x", snapshot: snapshotPayload({ sessionId: "new-home" }).snapshot } },
      });
      await flush();
      const attach = lastFrame<{ type: string; id: string }>(ws, "attach")!;
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "new-home", capabilities: ["runtime.prompt", "runtime.abort"] }) });
      await flush(12);
    });

    const prompts = ws.sent.filter((frame) => (frame as { type?: string; payload?: { command?: { type?: string } } }).type === "command" && (frame as { payload?: { command?: { type?: string } } }).payload?.command?.type === "prompt") as Array<{ payload: { command: { message: string } } }>;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.payload.command.message).toBe("first from home");
  });

  it("expands a project in place without changing cwd or filtering Recent", async () => {
    mountApp({ cwd: "/x" });
    await settle();
    const rows = screen.getAllByTestId("sidebar-project-row");
    const current = rows.find((row) => row.textContent === "x");
    const other = rows.find((row) => row.textContent === "y");
    expect(current).toBeTruthy();
    expect(other).toBeTruthy();
    fireEvent.click(other!);
    expect(navigateMock).not.toHaveBeenCalled();
    expect(other!.getAttribute("aria-expanded")).toBe("true");
    const otherCard = other!.closest("[data-testid=sidebar-project-card]") as HTMLElement;
    expect(within(otherCard).getByText("Session D")).toBeTruthy();
    expect(screen.getByTestId("sidebar-sessions")).toBeTruthy();
    expect(screen.getAllByTestId("session-select-A").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("session-select-D").length).toBeGreaterThan(1);
    expect(screen.getByTestId("file-browser-toggle")).toBeTruthy();
  });

  it("collapses and expands the Projects section via its toggle", async () => {
    mountApp({ cwd: "/x" });
    await settle();
    const toggle = screen.getByTestId("projects-section-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("sidebar-project-list")).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("sidebar-project-list")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("sidebar-project-list")).toBeTruthy();
  });

  it("keeps no-flicker latest-intent session authority and a pending cue", async () => {
    const contextDeferreds = new Map<string, Deferred>();
    globalThis.fetch = controllableStubFetch({ sessions: PROJECT_SESSIONS, contextDeferreds });
    mountApp({ cwd: "/x" });
    await settle();
    fireEvent.click(screen.getByTestId("session-select-B"));
    await act(async () => { await flush(6); });
    fireEvent.click(screen.getByTestId("session-select-C"));
    await act(async () => { await flush(6); });
    expect(screen.getByLabelText("Opening session…")).toBeTruthy();
    expect(document.querySelector('[data-pending="true"]')?.textContent).toContain("Session C");
    await act(async () => {
      contextDeferreds.get("B")!.resolve(contextResponse("B"));
      await flush(12);
    });
    expect(navigateMock).not.toHaveBeenCalled();
    await act(async () => {
      contextDeferreds.get("C")!.resolve(contextResponse("C"));
      await flush(12);
    });
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ search: { session: "C", cwd: "/x" } }));
    expect(screen.queryByLabelText("Opening session…")).toBeNull();
  });

  it("shows a running cue on the live attached session without extra chrome", async () => {
    globalThis.fetch = controllableStubFetch({ sessions: PROJECT_SESSIONS });
    const { rerender } = mountApp({ cwd: "/x", session: "A" });
    const ws = await connectReady();
    await act(async () => {
      void capturedStore!.openSession("A");
      await flush();
      const attach = lastFrame<{ type: string; id: string }>(ws, "attach")!;
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A" }) });
      await flush();
      void capturedStore!.sendPrompt("hi");
      await flush();
    });
    await settle();
    expect(capturedStore!.getSnapshot().streaming).toBe(true);
    expect(screen.getAllByLabelText("Agent running").length).toBeGreaterThan(0);
    expect(screen.getByTestId("session-select-A").closest('[data-running="true"]')).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Session A" }).getAttribute("data-running")).toBe("true");
    const projectRunning = () => screen.getAllByTestId("sidebar-project-row").find((row) => row.getAttribute("title") === "/x")?.closest(".sidebar-list-row")?.getAttribute("data-running");
    expect(projectRunning()).toBe("true");
    expect(screen.queryByTestId("sidebar-update-btn")).toBeNull();

    // Switching to B history keeps A's background subscription and all three
    // running indicators; A's state never leaks into B's transcript/composer.
    rerender({ cwd: "/x", session: "B" });
    await settle();
    expect(ws.sent.filter((frame) => (frame as { type: string }).type === "detach")).toHaveLength(0);
    expect(screen.getByRole("tab", { name: "Session A" }).getAttribute("data-running")).toBe("true");
    expect(screen.getByTestId("session-select-A").closest('[data-running="true"]')).toBeTruthy();
    expect(projectRunning()).toBe("true");

    const prompt = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string } } }>(ws, "command")!;
    await act(async () => {
      ws.serverSend({ type: "response", id: prompt.id, payload: { ok: true, result: { commandId: prompt.payload.command.commandId, result: { ok: true, type: "prompt" } } } });
      await flush();
    });
    // Transport ack is not a terminal state: indicators stay running until an
    // authoritative event takes ownership, so there is no ack→agent_start blink.
    expect(screen.getByRole("tab", { name: "Session A" }).getAttribute("data-running")).toBe("true");
  });

  it("selects a session from a real button via keyboard and keeps sibling actions reachable", async () => {
    const contextDeferreds = new Map<string, Deferred>();
    globalThis.fetch = controllableStubFetch({ sessions: PROJECT_SESSIONS, contextDeferreds });
    mountApp({ cwd: "/x" }, { capabilities: ["agent", "sessions", "files", "models", "session.write", "session.delete"] });
    await settle();
    const select = screen.getByTestId("session-select-B");
    expect(select.tagName).toBe("BUTTON");
    expect(select.getAttribute("type")).toBe("button");
    expect(select.closest(".sidebar-list-row")?.tagName).toBe("DIV");
    expect(select.querySelector("button")).toBeNull();
    select.focus();
    fireEvent.keyDown(select, { key: "Enter" });
    fireEvent.click(select);
    await act(async () => { await flush(8); });
    expect(screen.getByLabelText("Opening session…")).toBeTruthy();
    const row = select.closest(".sidebar-list-row");
    expect(row).toBeTruthy();
    const actions = row!.querySelector(".sidebar-row-actions");
    expect(actions).toBeTruthy();
    expect(within(actions as HTMLElement).getByLabelText("Pin to top").tagName).toBe("BUTTON");
    expect(within(actions as HTMLElement).getByLabelText("Archive").tagName).toBe("BUTTON");
    (actions as HTMLElement).querySelectorAll("button").forEach((button) => {
      expect((button as HTMLButtonElement).disabled).toBe(false);
    });
    await act(async () => {
      contextDeferreds.get("B")!.resolve(contextResponse("B"));
      await flush(12);
    });
    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ search: { session: "B", cwd: "/x" } }));
  });

  it("omits Plugins and Resources when those capabilities are absent", async () => {
    mountApp({ cwd: "/x" });
    await settle();
    expect(screen.queryByTestId("sidebar-nav-plugins")).toBeNull();
    expect(screen.queryByTestId("sidebar-nav-resources")).toBeNull();
    expect(screen.getByTestId("sidebar-new-session")).toBeTruthy();
    expect(screen.getByTestId("sidebar-nav-settings")).toBeTruthy();
  });

  it("hides subagent/agent-home folders from Projects and Sessions", async () => {
    const mixed: readonly SessionHeader[] = [
      ...PROJECT_SESSIONS,
      {
        sessionId: "sub",
        cwd: "/Users/proxy/.pi/agent/pi-claude-subagents/019fef69",
        projectRoot: "/Users/proxy/.pi/agent/pi-claude-subagents/019fef69",
        title: "Subagent leak",
        createdAt: 1000,
        updatedAt: Date.now(),
        messageCount: 1,
      },
    ];
    globalThis.fetch = controllableStubFetch({ sessions: mixed });
    mountApp({ cwd: "/x" });
    await settle();
    const rows = screen.getAllByTestId("sidebar-project-row").map((row) => row.textContent);
    expect(rows).toContain("x");
    expect(rows).toContain("y");
    expect(rows.join(" ")).not.toContain("019fef69");
    expect(screen.queryByText("Subagent leak")).toBeNull();
  });

  it("empty home shows a centered Pix start surface and a usable model selector", async () => {
    modelsCatalog = {
      models: [
        { id: "gpt-5", provider: "openai", displayName: "GPT-5" },
        { id: "claude-sonnet-4", provider: "anthropic", displayName: "Claude Sonnet 4" },
      ],
      defaultModel: { id: "claude-sonnet-4", provider: "anthropic" },
    };
    globalThis.fetch = controllableStubFetch({ sessions: PROJECT_SESSIONS });
    mountApp({});
    await settle();
    const stack = screen.getByTestId("home-stack");
    expect(stack.contains(screen.getByTestId("transcript-home"))).toBe(true);
    expect(stack.contains(screen.getByLabelText("Change model"))).toBe(true);
    expect(screen.getByText("Start a conversation")).toBeTruthy();
    expect(document.querySelector(".composer--disabled")).toBeNull();
    expect(screen.getByLabelText("Change model").textContent).toContain("Claude Sonnet 4");
  });

  it("hides the pinned section until a session is pinned, then shows pin/archive actions", async () => {
    globalThis.fetch = controllableStubFetch({ sessions: PROJECT_SESSIONS });
    mountApp({ cwd: "/x" });
    await settle();
    expect(screen.queryByTestId("sidebar-pinned")).toBeNull();
    expect(screen.queryByText("Today")).toBeNull();
    const sessionRow = screen.getByTestId("session-select-A").closest(".sidebar-list-row") as HTMLElement;
    fireEvent.click(within(sessionRow).getByLabelText("Pin to top"));
    expect(screen.getByTestId("sidebar-pinned")).toBeTruthy();
    expect(within(screen.getByTestId("sidebar-pinned")).getByTestId("session-select-A")).toBeTruthy();
    fireEvent.click(within(screen.getByTestId("sidebar-pinned")).getByLabelText("Archive"));
    expect(screen.queryByTestId("sidebar-pinned")).toBeNull();
    expect(screen.queryByTestId("session-select-A")).toBeNull();
  });

  it("keeps subagent sessions collapsed until the parent session is clicked", async () => {
    const now = Date.now();
    globalThis.fetch = controllableStubFetch({
      sessions: [
        { sessionId: "parent", cwd: "/x", projectRoot: "/x", title: "Parent session", createdAt: 1000, updatedAt: now, messageCount: 1 },
        { sessionId: "child", cwd: "/x", projectRoot: "/x", title: "Child session", parentSessionId: "parent", createdAt: 1000, updatedAt: now, messageCount: 1 },
      ],
    });
    const { rerender } = mountApp({ cwd: "/x", session: "parent" });
    await settle();
    expect(screen.getByTestId("session-select-parent")).toBeTruthy();
    expect(screen.queryByTestId("session-select-child")).toBeNull();
    fireEvent.click(screen.getByTestId("session-select-parent"));
    expect(screen.getByTestId("session-select-child")).toBeTruthy();
    fireEvent.click(screen.getByTestId("session-select-parent"));
    expect(screen.queryByTestId("session-select-child")).toBeNull();
    fireEvent.click(screen.getByTestId("session-select-parent"));
    expect(screen.getByTestId("session-select-child")).toBeTruthy();
    rerender({ cwd: "/x", session: "parent" });
    await settle();
    expect(screen.getByTestId("session-select-child")).toBeTruthy();
  });

  it("caps recent sessions at five and reveals the rest from View more", async () => {
    const now = Date.now();
    const many: SessionHeader[] = Array.from({ length: 7 }, (_, index) => ({
      sessionId: `S${index + 1}`,
      cwd: "/x",
      projectRoot: "/x",
      title: `Session ${index + 1}`,
      createdAt: 1000,
      updatedAt: now - index * 1000,
      messageCount: 1,
    }));
    globalThis.fetch = controllableStubFetch({ sessions: many });
    mountApp({ cwd: "/x" });
    await settle();
    const recent = screen.getByTestId("sidebar-sessions");
    expect(within(recent).getByTestId("session-select-S1")).toBeTruthy();
    expect(within(recent).getByTestId("session-select-S5")).toBeTruthy();
    expect(within(recent).queryByTestId("session-select-S6")).toBeNull();
    fireEvent.click(within(recent).getByTestId("sidebar-show-more"));
    expect(within(recent).getByTestId("session-select-S6")).toBeTruthy();
    expect(within(recent).getByTestId("session-select-S7")).toBeTruthy();
  });

  it("keeps project pin/archive actions separate from the expand caret", async () => {
    mountApp({ cwd: "/x" });
    await settle();
    const projectButton = screen.getAllByTestId("sidebar-project-row").find((row) => row.getAttribute("title") === "/x");
    expect(projectButton).toBeTruthy();
    const row = projectButton!.closest(".sidebar-list-row") as HTMLElement;
    expect(within(row).getByLabelText("Pin to top")).toBeTruthy();
    expect(within(row).getByLabelText("Archive")).toBeTruthy();
    expect(within(row).getByText("NOW")).toBeTruthy();
    expect(row.querySelector(".sidebar-fork-caret")).toBeNull();
  });

  it("keeps the title bar to the right of the full-height sidebar", async () => {
    mountApp({ cwd: "/x" }, { capabilities: catalogCaps });
    await settle();
    const sidebar = document.querySelector(".sidebar-container") as HTMLElement;
    const titleBar = document.querySelector(".app-title-bar") as HTMLElement;
    expect(sidebar.compareDocumentPosition(titleBar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(titleBar.closest(".chat-column")).toBeTruthy();
    expect(sidebar.closest(".chat-column")).toBeNull();
    // The sidebar toggle lives INSIDE the rail (header collapse button); the
    // title bar carries only tabs. Collapsed, the rail keeps the expand button.
    expect(screen.getByTestId("sidebar-collapse")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Hide sidebar" })?.closest(".app-title-bar")).toBeNull();
    expect(screen.getByTestId("sidebar-brand")).toBeTruthy();
  });
});

describe("AppShell — unified top-level workspace tabs + right file browser", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    SOCKETS.length = 0;
    capturedStore = null;
    navigateMock.mockReset();
    previousFetch = globalThis.fetch;
  });
  afterEach(() => {
    cleanup();
    globalThis.fetch = previousFetch;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function settle(): Promise<void> {
    await act(async () => {
      for (let round = 0; round < 3; round += 1) {
        await flush(20);
        vi.advanceTimersByTime(0);
      }
      await flush(20);
    });
  }

  /** Fake watch session so the central FileViewer can mount without SSE. */
  function fakeWatchSession() {
    const change = new Set<() => void>();
    const resync = new Set<() => void>();
    const stateListeners = new Set<(state: WatchConnectionState) => void>();
    let state: WatchConnectionState = "connected";
    const session: WatchSession = {
      get state() { return state; },
      get lastError() { return undefined; },
      addEventListener(type, listener) {
        if (type === "change") { const l = listener as () => void; change.add(l); return () => change.delete(l); }
        if (type === "resync") { const l = listener as () => void; resync.add(l); return () => resync.delete(l); }
        const l = listener as (state: WatchConnectionState) => void;
        stateListeners.add(l);
        return () => stateListeners.delete(l);
      },
      close() {
        state = "closed";
        change.clear();
        resync.clear();
        stateListeners.clear();
      },
    };
    return session;
  }

  /** Host stub that also serves file reads + git diff for the central viewer. */
  function fileFetch(): typeof fetch {
    return vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : input instanceof URL ? `${input.pathname}${input.search}` : input.url;
      const p = String(path);
      if (p.includes("/v1/gate/status")) return json({ status: "enabled", required: false, authenticated: false, mode: "local" });
      if (p.includes("op=read")) return json({ content: "AAAA", language: "text", size: 4 });
      if (p.includes("/v1/git/diff")) return json({ supported: false });
      if (p.includes("/v1/sessions")) return json({ sessions: [], revision: 0 });
      if (p.includes("/v1/worktrees")) return json({ projectRoot: "/x", isGit: true, isTopLevel: true, worktrees: [] });
      if (p.includes("/v1/models")) return json({ models: [], defaultModel: null });
      if (p.includes("/v1/files/") && p.includes("/index")) return json({ files: [], truncated: false });
      if (p.includes("/v1/skills")) return json({ skills: [] });
      return json({});
    }) as unknown as typeof fetch;
  }

  it("selecting a session from the sidebar opens/activates ONE session tab after prepare commits", async () => {
    const contextDeferreds = new Map<string, Deferred>();
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS, contextDeferreds });
    const { rerender } = mountApp({ cwd: "/x" });
    await settle();
    fireEvent.click(screen.getByTestId("session-select-B"));
    await act(async () => { await flush(6); });
    // Before the first page settles the session tab must NOT materialize.
    expect(screen.queryByRole("tab", { name: "Session B" })).toBeNull();
    await act(async () => {
      contextDeferreds.get("B")!.resolve(contextResponse("B"));
      await flush(12);
    });
    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ search: { session: "B", cwd: "/x" } }));
    // Simulate the router applying the committed navigation: the session tab
    // then materializes in the title bar, deduped to exactly one.
    rerender({ cwd: "/x", session: "B" });
    await settle();
    expect(screen.getAllByRole("tab", { name: "Session B" })).toHaveLength(1);
  });

  it("selecting a session from another project activates its owning cwd", async () => {
    const contextDeferreds = new Map<string, Deferred>();
    globalThis.fetch = controllableStubFetch({ sessions: PROJECT_SESSIONS, contextDeferreds });
    mountApp({ cwd: "/x" });
    await settle();

    fireEvent.click(screen.getAllByTestId("session-select-D")[0]!);
    await act(async () => { await flush(6); });
    await act(async () => {
      contextDeferreds.get("D")!.resolve(contextResponse("D"));
      await flush(12);
    });

    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ search: { session: "D", cwd: "/y" } }));
  });

  it("a deep-linked file renders centrally in a file tab and duplicate opens dedupe", async () => {
    setWatchSessionFactory(() => fakeWatchSession());
    globalThis.fetch = fileFetch();
    const { rerender } = mountApp({ cwd: "/x", file: "/x/a.ts" });
    await settle();
    // The file tab appears in the title bar and the content renders centrally.
    expect(screen.getAllByRole("tab").some((tab) => tab.textContent?.includes("a.ts"))).toBe(true);
    expect(screen.getByText("AAAA")).toBeTruthy();
    // Re-opening the same cwd+path dedupes: still exactly one a.ts tab.
    rerender({ cwd: "/x", file: "/x/a.ts" });
    await settle();
    expect(screen.getAllByRole("tab").filter((tab) => tab.textContent?.includes("a.ts"))).toHaveLength(1);
  });

  it("the right-edge file browser button toggles the FILE BROWSER panel", async () => {
    globalThis.fetch = fileFetch();
    mountApp({ cwd: "/x" });
    await settle();
    const panel = document.querySelector(".right-panel-container");
    expect(panel?.className).toContain("right-panel-closed");
    expect(screen.getByTestId("file-browser-rail")).toBeTruthy();
    fireEvent.click(screen.getByTestId("file-browser-toggle"));
    expect(document.querySelector(".right-panel-container")?.className).toContain("right-panel-open");
    expect(screen.getByRole("button", { name: "Hide file browser" })).toBeTruthy();
    expect(screen.queryByTestId("file-browser-rail")).toBeNull();
    fireEvent.click(screen.getByTestId("file-browser-toggle"));
    expect(document.querySelector(".right-panel-container")?.className).toContain("right-panel-closed");
    expect(screen.getByTestId("file-browser-rail")).toBeTruthy();
  });
});
