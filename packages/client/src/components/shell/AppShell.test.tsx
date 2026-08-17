import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, act, screen, fireEvent } from "@testing-library/react";
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
import { ThemeProvider } from "@/hooks/useTheme";
import { HttpClientProvider } from "@/app/http-context";
import { ContextMenuProvider } from "@/components/ContextMenu";
import { FakeWebSocket, flush, lastFrame, snapshotPayload } from "@/runtime/testing/harness";
import type { RuntimeSocketDeps } from "@/runtime/socket";
import type { HostInfo } from "@fffattiger/pix-protocol";
import type { SessionStore } from "@/runtime/session-store";

// AppShell is the single owner of URL-session → runtime lifecycle; this suite
// drives it through rapid A→B→C selection (supersession) and reordered detach
// settles to prove the ONE coordinated flow (no competing detach effect, no
// hung opens, no late clobber).

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
    if (p.includes("/v1/themes")) return json({ themeSets: [] });
    if (p.includes("/v1/models")) return json({ models: [], defaultModel: null });
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
    if (p.includes("/v1/themes")) return json({ themeSets: [] });
    if (p.includes("/v1/models")) return json({ models: [], defaultModel: null });
    if (p.includes("/v1/files/") && p.includes("/index")) return json({ files: [], truncated: false });
    if (p.includes("/v1/skills")) return json({ skills: [] });
    return json({});
  }) as unknown as typeof fetch;
}

let capturedStore: SessionStore | null = null;
function Capture(): null {
  const store = useRuntimeStore();
  useEffect(() => { capturedStore = store; }, [store]);
  return null;
}

let previousFetch: typeof fetch;
function mountApp(search: WorkspaceSearch, opts: { queryClient?: QueryClient } = {}) {
  const qc = opts.queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host: Partial<HostInfo> = { mode: "local", capabilities: ["agent", "sessions", "files"] };
  const Tree = ({ search: s }: { search: WorkspaceSearch }): ReactNode => (
    <QueryClientProvider client={qc}>
      <HttpClientProvider>
        <CapabilityProvider host={host}>
          <RuntimeProvider deps={fakeDeps()}>
            <I18nProvider>
              <ThemeProvider cwd={s.cwd ?? null}>
                <ContextMenuProvider>
                  <Capture />
                  <AppShell search={s} />
                </ContextMenuProvider>
              </ThemeProvider>
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

  it("selecting a session is read-only: NEVER attaches it; a mismatched attached session is fail-closed detached once", async () => {
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
    // Select B → read-only history: NO attach/open for B.
    rerender({ cwd: "/x", session: "B" });
    await flush();
    // Exactly ONE fail-closed detach for the mismatched A (single-flight)…
    const detachFrames = ws.sent.filter((f) => (f as { type: string }).type === "detach") as { type: string; id: string; payload: { sessionId: string } }[];
    expect(detachFrames).toHaveLength(1);
    expect(detachFrames[0]!.payload.sessionId).toBe("A");
    await act(async () => {
      ws.serverSend({ type: "response", id: detachFrames[0]!.id, payload: { ok: true, result: { sessionId: "A", detached: true } } });
      await flush();
    });
    // …and NO attach frame for the selected B (0-Worker history invariant).
    expect(countType(ws, "attach")).toBe(attachCountBefore);
    expect(capturedStore!.getSnapshot().attached).toBe(false);
    expect(capturedStore!.getSnapshot().sessionId).not.toBe("B");
  });

  it("rapid selection B→C while attached: only fail-closed detaches (single-flight, one frame), never any attach", async () => {
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
    // Select B, then C before the detach resolves — both mismatch A.
    rerender({ cwd: "/x", session: "B" });
    await flush();
    rerender({ cwd: "/x", session: "C" });
    await flush();
    // The two selection effects coalesce into ONE single-flight detach for A.
    const detachFrames = ws.sent.filter((f) => (f as { type: string }).type === "detach") as { type: string; id: string; payload: { sessionId: string } }[];
    expect(detachFrames).toHaveLength(1);
    expect(detachFrames[0]!.payload.sessionId).toBe("A");
    await act(async () => {
      ws.serverSend({ type: "response", id: detachFrames[0]!.id, payload: { ok: true, result: { sessionId: "A", detached: true } } });
      await flush();
    });
    // No session (B or C) was ever attached by selection.
    expect(countType(ws, "attach")).toBe(attachCountBefore);
    expect(capturedStore!.getSnapshot().attached).toBe(false);
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
    expect(screen.getByText("Session B")).toBeTruthy();
    // Click B → prepare starts; its first page is in flight (deferred).
    fireEvent.click(screen.getByText("Session B"));
    await act(async () => { await flush(8); });
    // BEFORE the first page settles: no URL/navigation, no session swap, and
    // the current frame is untouched (still the select hint, not a loading B).
    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Select a session/)).toBeTruthy();
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
    fireEvent.click(screen.getByText("Session B"));
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
    fireEvent.click(screen.getByText("Session B"));
    await act(async () => { await flush(6); });
    fireEvent.click(screen.getByText("Session C"));
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
    fireEvent.click(screen.getByText("Session B"));
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
    fireEvent.click(screen.getByText("Session B"));
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
