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

/** Select B from the sidebar (read-only history), acking the fail-closed detach of A. */
async function selectDetachedB(ws: FakeWebSocket, rerender: (s: WorkspaceSearch) => void): Promise<void> {
  rerender({ cwd: "/x", session: "B" });
  await act(async () => {
    await flush();
    const detach = lastFrame<{ type: string; id: string }>(ws, "detach")!;
    ws.serverSend({ type: "response", id: detach.id, payload: { ok: true, result: { sessionId: "A", detached: true } } });
    await flush();
  });
  // Let B's transcript + model catalog queries settle.
  await act(async () => { await flush(); });
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
    const { rerender } = mountApp({ cwd: "/x" });
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

    // No command before attach.
    const attach = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    expect(attach.payload.sessionId).toBe("B");
    expect(countType(ws, "command")).toBe(0);
    await act(async () => {
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "B" }) });
      await flush();
    });
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
    const { } = mountApp({ cwd: "/x" });
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
    globalThis.fetch = controllableStubFetch({ sessions: PROJECT_SESSIONS });
  });
  afterEach(() => { cleanup(); globalThis.fetch = previousFetch; vi.useRealTimers(); });

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
      "sidebar-files",
      "sidebar-nav-settings",
    ].filter((id) => document.querySelector(`[data-testid="${id}"]`));
  }

  const catalogCaps: HostInfo["capabilities"] = ["agent", "sessions", "files", "models", "plugins", "skills"];

  it("renders the source hierarchy: Pix, New Session, Plugins, Resources, Projects, Sessions, Files, Settings", async () => {
    mountApp({ cwd: "/x" }, { capabilities: catalogCaps });
    await settle();
    expect(screen.getByTestId("sidebar-brand").textContent).toBe("Pix");
    expect(screen.getByTestId("sidebar-new-session").textContent).toContain("New Session");
    expect(screen.getByTestId("sidebar-nav-plugins").textContent).toBe("Plugins");
    expect(screen.getByTestId("sidebar-nav-resources").textContent).toBe("Resources");
    expect(screen.getByTestId("sidebar-projects")).toBeTruthy();
    expect(screen.getByTestId("sidebar-sessions")).toBeTruthy();
    expect(screen.getByTestId("sidebar-files")).toBeTruthy();
    expect(screen.getByTestId("sidebar-nav-settings").textContent).toBe("Settings");
    expect(railOrder()).toEqual([
      "sidebar-home-header",
      "sidebar-new-session",
      "sidebar-nav-plugins",
      "sidebar-nav-resources",
      "sidebar-projects",
      "sidebar-sessions",
      "sidebar-files",
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
  });

  it("New Session uses the existing create path and invents no extra catalog chrome", async () => {
    mountApp({ cwd: "/x" }, { capabilities: catalogCaps });
    await settle();
    fireEvent.click(screen.getByTestId("sidebar-new-session"));
    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ to: "/", search: { cwd: "/x" } }));
    expect(screen.getByTestId("sidebar-nav-plugins").textContent).toBe("Plugins");
    expect(screen.getByTestId("sidebar-nav-resources").textContent).toBe("Resources");
  });

  it("selects a project via existing worktree navigation and keeps the file section", async () => {
    mountApp({ cwd: "/x" });
    await settle();
    const rows = screen.getAllByTestId("sidebar-project-row");
    expect(rows.some((row) => row.textContent === "x" && row.getAttribute("data-active") === "true")).toBe(true);
    const other = rows.find((row) => row.textContent === "y");
    expect(other).toBeTruthy();
    fireEvent.click(other!);
    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ to: "/", search: { cwd: "/y" } }));
    expect(screen.getByTestId("sidebar-files")).toBeTruthy();
    expect(screen.getByLabelText("Files")).toBeTruthy();
  });

  it("keeps no-flicker latest-intent session authority and a pending cue", async () => {
    const contextDeferreds = new Map<string, Deferred>();
    globalThis.fetch = controllableStubFetch({ sessions: PROJECT_SESSIONS, contextDeferreds });
    mountApp({ cwd: "/x" });
    await settle();
    fireEvent.click(screen.getByText("Session B"));
    await act(async () => { await flush(6); });
    fireEvent.click(screen.getByText("Session C"));
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
    mountApp({ cwd: "/x" });
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
    expect(screen.getByLabelText("Agent running")).toBeTruthy();
    expect(document.querySelector('[data-running="true"]')?.textContent).toContain("Session A");
    expect(screen.queryByTestId("sidebar-update-btn")).toBeNull();
    const prompt = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string } } }>(ws, "command")!;
    await act(async () => {
      ws.serverSend({ type: "response", id: prompt.id, payload: { ok: true, result: { commandId: prompt.payload.command.commandId, result: { ok: true, type: "prompt" } } } });
      await flush();
    });
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
    expect(within(actions as HTMLElement).getByLabelText("Rename").tagName).toBe("BUTTON");
    expect(within(actions as HTMLElement).getByLabelText("Delete").tagName).toBe("BUTTON");
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
});
