import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, act, screen, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { AppShell } from "./AppShell";
import type { WorkspaceSearch } from "@/lib/search-params";
import { queryKeys } from "@/api/query-keys";
import type { SessionHeader } from "@fffattiger/pix-protocol";
import { RuntimeProvider, SelectedSessionProvider } from "@/runtime/runtime-provider";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { I18nProvider } from "@/hooks/useI18n";
import { HttpClientProvider } from "@/app/http-context";
import { ContextMenuProvider } from "@/components/ContextMenu";
import { SessionStagingProvider } from "@/features/composer/session-staging-provider";
import { FakeWebSocket, flush, lastFrame, snapshotPayload } from "@/runtime/testing/harness";
import { CaptureTestRuntime } from "@/runtime/testing/capture-test-runtime";
import { describeRuntimeObservationError } from "@/runtime/observation-errors";
import { WORKSPACE_LAST_SESSION_STORAGE_KEY, WORKSPACE_SESSION_TABS_STORAGE_KEY } from "@/features/workspace/tabs/workspace-tab-state";
import type { TestRuntimeStore } from "@/runtime/testing/test-runtime-store";
import { setWatchSessionFactory, type WatchConnectionState, type WatchSession } from "@/api/files-watch";
import type { RuntimeSocketDeps } from "@/runtime/socket";
import type { HostInfo } from "@fffattiger/pix-protocol";

// AppShell is the single owner of URL-session selection intent; this suite
// proves idle/history selection never activates a target, authorized busy
// selection uses observation-only attachment, background runtime state remains
// identity-gated, and send-time supersession has no hung/late clobber.

const navigateMock = vi.fn();
vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-router")>(
    "@tanstack/react-router",
  );
  return {
    ...actual,
    useNavigate: () => navigateMock,
    Link: ({ children, ...props }: { children?: ReactNode; to?: string }) => <a href={typeof props.to === "string" ? props.to : "/"}>{children}</a>,
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
const AUTHORIZED = { state: "authorized" as const, reason: "allowed_root" as const };
const SESSION_HEADERS: readonly SessionHeader[] = [
  { sessionId: "A", cwd: "/x", projectRoot: "/x", title: "Session A", createdAt: 1000, updatedAt: Date.now(), messageCount: 1, workspaceAccess: AUTHORIZED },
  { sessionId: "B", cwd: "/x", projectRoot: "/x", title: "Session B", createdAt: 1000, updatedAt: Date.now(), messageCount: 1, workspaceAccess: AUTHORIZED },
  { sessionId: "C", cwd: "/x", projectRoot: "/x", title: "Session C", createdAt: 1000, updatedAt: Date.now(), messageCount: 1, workspaceAccess: AUTHORIZED },
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
  projectsError?: { body: unknown; status: number };
  projectSessionsError?: { body: unknown; status: number };
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
    const exactSession = p.match(/\/v1\/sessions\/([^/?]+)(?:\?.*)?$/);
    if (exactSession) {
      const id = decodeURIComponent(exactSession[1]!);
      const listed = sessions.find((session) => session.sessionId === id);
      return json({ session: listed ?? { sessionId: id, cwd: "/x", projectRoot: "/x", workspaceAccess: AUTHORIZED } });
    }
    if (p.includes("/v1/projects")) {
      if (opts.projectsError !== undefined) return jsonStatus(opts.projectsError.body, opts.projectsError.status);
      const url = new URL(p, "http://pix.local");
      const page = Number(url.searchParams.get("page") ?? 1);
      const pageSize = Number(url.searchParams.get("pageSize") ?? 10);
      const grouped = new Map<string, { representativeCwd: string; sessionCount: number; latestActivity: number }>();
      for (const session of sessions) {
        if (session.parentSessionId !== undefined || /pi-(?:claude-)?subagents|\/tmp\//.test(session.projectRoot)) continue;
        const current = grouped.get(session.projectRoot);
        const activity = session.updatedAt ?? session.lastMessageAt ?? session.createdAt ?? 0;
        if (!current) grouped.set(session.projectRoot, { representativeCwd: session.cwd, sessionCount: 1, latestActivity: activity });
        else { current.sessionCount += 1; current.latestActivity = Math.max(current.latestActivity, activity); }
      }
      const projects = [...grouped.entries()].map(([projectRoot, value]) => ({ projectRoot, ...value }));
      const offset = (page - 1) * pageSize;
      return json({ projects: projects.slice(offset, offset + pageSize), page, pageSize, total: projects.length, totalPages: projects.length === 0 ? 0 : Math.ceil(projects.length / pageSize), catalogRevision: 0 });
    }
    if (p.includes("/v1/sessions")) {
      const url = new URL(p, "http://pix.local");
      const page = Number(url.searchParams.get("page") ?? 1);
      const pageSize = Number(url.searchParams.get("pageSize") ?? 50);
      const projectRoot = url.searchParams.get("projectRoot");
      if (projectRoot !== null && opts.projectSessionsError !== undefined) {
        return jsonStatus(opts.projectSessionsError.body, opts.projectSessionsError.status);
      }
      const visible = sessions.filter((session) => session.parentSessionId === undefined && !/pi-(?:claude-)?subagents/.test(session.projectRoot));
      const filtered = projectRoot === null ? visible : visible.filter((session) => session.projectRoot === projectRoot);
      const offset = (page - 1) * pageSize;
      return json({ sessions: filtered.slice(offset, offset + pageSize), page, pageSize, total: filtered.length, totalPages: filtered.length === 0 ? 0 : Math.ceil(filtered.length / pageSize), catalogRevision: 0 });
    }
    if (p.includes("/v1/worktrees")) return json({ projectRoot: "/x", isGit: true, isTopLevel: true, worktrees: [] });
    if (p.includes("/v1/models")) return json(modelsCatalog);
    if (p.includes("/v1/files/") && p.includes("/index")) return json({ files: [], truncated: false });
    if (p.includes("/v1/skills")) return json({ skills: [] });
    return json({});
  }) as unknown as typeof fetch;
}

function countMockFetchCalls(fetchImpl: typeof fetch, needle: string): number {
  const calls = (fetchImpl as typeof fetch & {
    mock: { calls: Array<[RequestInfo | URL, RequestInit?]> };
  }).mock.calls;
  return calls.filter((call) => String(call[0]).includes(needle)).length;
}

function contextResponse(sessionId: string): Response {
  return json({
    context: {
      sessionId,
      entries: [],
      settings: { model: { provider: "anthropic", modelId: "claude-opus-4" }, thinkingLevel: "off" },
      pageInfo: { hasMore: false },
    },
  });
}

let stubContextSettings: {
  model: { provider: string; modelId: string } | null;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
} | undefined = {
  model: { provider: "anthropic", modelId: "claude-opus-4" },
  thinkingLevel: "off",
};

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
      return json({
        context: {
          sessionId: id,
          entries: [],
          ...(stubContextSettings === undefined ? {} : { settings: stubContextSettings }),
          pageInfo: { hasMore: false },
        },
      });
    }
    if (p.includes("/v1/sessions/") && p.includes("/tree")) {
      const id = decodeURIComponent(p.split("/v1/sessions/")[1]!.split("/")[0]!);
      return json({ tree: { sessionId: id, roots: [], entryCount: 0 } });
    }
    const exactSession = p.match(/\/v1\/sessions\/([^/?]+)(?:\?.*)?$/);
    if (exactSession) {
      const id = decodeURIComponent(exactSession[1]!);
      return json({ session: { sessionId: id, cwd: "/x", projectRoot: "/x", workspaceAccess: AUTHORIZED } });
    }
    if (p.includes("/v1/projects")) return json({ projects: [], page: 1, pageSize: 10, total: 0, totalPages: 0, catalogRevision: 0 });
    if (p.includes("/v1/sessions")) return json({ sessions: [], page: 1, pageSize: 50, total: 0, totalPages: 0, catalogRevision: 0 });
    if (p.includes("/v1/worktrees")) return json({ projectRoot: "/x", isGit: true, isTopLevel: true, worktrees: [] });
    if (p.includes("/v1/models")) return json(modelsCatalog);
    if (p.includes("/v1/files/") && p.includes("/index")) return json({ files: [], truncated: false });
    if (p.includes("/v1/skills")) return json({ skills: [] });
    return json({});
  }) as unknown as typeof fetch;
}

/** Configurable /v1/models response (reset by suites that exercise Composer controls). */
let modelsCatalog: { models: { id: string; provider: string; displayName?: string; contextWindow?: number }[]; defaultModel: { id: string; provider: string } | null } = {
  models: [],
  defaultModel: null,
};

let capturedStore: TestRuntimeStore | null = null;

let previousFetch: typeof fetch;

// Sidebar pin/archive/expanded state is intentionally durable in production;
// each test still starts from an isolated browser preference baseline unless
// it explicitly seeds localStorage after this hook.
beforeEach(() => {
  window.localStorage.removeItem("pi-sidebar-item-state");
  window.localStorage.removeItem("pi-sidebar-projects-open");
  window.localStorage.removeItem("pi-sidebar-sessions-open");
  window.localStorage.removeItem("pi-sidebar-pinned-open");
  window.localStorage.removeItem(WORKSPACE_SESSION_TABS_STORAGE_KEY);
  window.localStorage.removeItem(WORKSPACE_LAST_SESSION_STORAGE_KEY);
});

function authenticatedQueryClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.gate.status(), { status: "enabled", required: false, authenticated: false, mode: "local" });
  return client;
}

function mountApp(search: WorkspaceSearch, opts: { queryClient?: QueryClient; capabilities?: HostInfo["capabilities"] } = {}) {
  const qc = opts.queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const defaultCapabilities: HostInfo["capabilities"] = opts.capabilities ?? ["agent", "sessions", "files", "models"];
  const Tree = ({ search: s, capabilities }: { search: WorkspaceSearch; capabilities: HostInfo["capabilities"] }): ReactNode => (
    <QueryClientProvider client={qc}>
      <HttpClientProvider>
        <CapabilityProvider host={{ mode: "local", capabilities }}>
          <RuntimeProvider deps={fakeDeps()}>
            <SessionStagingProvider>
            <SelectedSessionProvider sessionId={s.session ?? null}>
            <I18nProvider>
              <ContextMenuProvider>
                <CaptureTestRuntime onStore={(store) => { capturedStore = store; }} />
                <AppShell search={s} />
              </ContextMenuProvider>
            </I18nProvider>
            </SelectedSessionProvider>
            </SessionStagingProvider>
          </RuntimeProvider>
        </CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>
  );
  const view = render(<Tree search={search} capabilities={defaultCapabilities} />);
  return {
    rerender: (s: WorkspaceSearch, next?: { capabilities?: HostInfo["capabilities"] }) =>
      view.rerender(<Tree search={s} capabilities={next?.capabilities ?? defaultCapabilities} />),
    queryClient: qc,
  };
}

function ack(): unknown {
  return { type: "handshake_ack", payload: { protocolVersion: 2, host: { mode: "local", capabilities: ["agent"] }, limits: { maxUpload: 0, maxOpenSessions: 4 }, sessionSnapshotSupport: true, acceptedFeatures: [] } };
}

function watchAck(): unknown {
  const frame = ack() as { type: string; payload: Record<string, unknown> };
  return { ...frame, payload: { ...frame.payload, acceptedFeatures: ["runtime.running-watch.v1"] } };
}

function lifecycleAck(): unknown {
  const frame = ack() as { type: string; payload: Record<string, unknown> };
  return {
    ...frame,
    payload: {
      ...frame.payload,
      acceptedFeatures: ["runtime.running-watch.v1", "runtime.observe-existing.v1"],
    },
  };
}

/** Negotiated atomic submit-turn seam: the Composer's sends route through submit_turn. */
function submitTurnAck(): unknown {
  const frame = ack() as { type: string; payload: Record<string, unknown> };
  return {
    ...frame,
    payload: {
      ...frame.payload,
      acceptedFeatures: ["runtime.running-watch.v1", "runtime.observe-existing.v1", "runtime.submit-turn.v1"],
    },
  };
}

/** Accept the ONE socket AppShell opens automatically on mount. */
async function acceptAutomaticConnection(handshake: unknown = ack()): Promise<FakeWebSocket> {
  await act(async () => {
    // Gate status resolves through React Query before AppShell is allowed to
    // open the control-plane socket.
    for (let i = 0; i < 12 && SOCKETS.length === 0; i += 1) await flush();
  });
  expect(SOCKETS).toHaveLength(1);
  const ws = SOCKETS[0]!;
  await act(async () => {
    if (ws.readyState !== 1) {
      ws.serverOpen();
      ws.serverSend(handshake);
      await flush();
    }
  });
  expect(SOCKETS).toHaveLength(1);
  return ws;
}

/**
 * Event-controlled one-socket handshake. Prefer AppShell's automatic socket
 * when the gate allows it; otherwise open exactly one store socket. Never a
 * second connect after handshake (ACK and later create/attach share that socket).
 */
async function connectReady(): Promise<FakeWebSocket> {
  await act(async () => {
    for (let i = 0; i < 12 && SOCKETS.length === 0; i += 1) await flush();
  });
  if (SOCKETS.length === 0) {
    await act(async () => {
      capturedStore!.connect();
      await flush();
    });
  }
  expect(SOCKETS.length).toBeGreaterThanOrEqual(1);
  const ws = SOCKETS[0]!;
  await act(async () => {
    if (ws.readyState !== 1) {
      ws.serverOpen();
      ws.serverSend(ack());
      await flush();
    }
  });
  expect(SOCKETS).toHaveLength(1);
  return ws;
}

function countType(ws: FakeWebSocket, type: string): number {
  return ws.sent.filter((f) => (f as { type: string }).type === type).length;
}

async function waitForAttach(ws: FakeWebSocket, sessionId?: string): Promise<{ type: string; id: string; payload?: { sessionId?: string } }> {
  for (let i = 0; i < 16; i += 1) {
    const frames = ws.sent.filter((frame) => (frame as { type?: string }).type === "attach") as Array<{ type: string; id: string; payload?: { sessionId?: string } }>;
    const match = sessionId === undefined
      ? frames.at(-1)
      : [...frames].reverse().find((frame) => frame.payload?.sessionId === sessionId);
    if (match) return match;
    await flush();
  }
  const frames = ws.sent.filter((frame) => (frame as { type?: string }).type === "attach");
  throw new Error(`timed out waiting for attach${sessionId ? ` of ${sessionId}` : ""}; saw ${JSON.stringify(frames)}`);
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
  afterEach(() => {
    cleanup();
    globalThis.fetch = previousFetch;
    window.localStorage.removeItem("pi-title-model");
    vi.useRealTimers();
  });

  it("selecting a session is read-only and preserves the existing background subscription", async () => {
    const { rerender } = mountApp({ cwd: "/x" });
    const ws = await connectReady();
    // Attach fully to A (live).
    await act(async () => {
      void capturedStore!.openSession("A").catch(() => undefined);
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

  it("clears the sidebar running cue from the global watch while home stays unattached", async () => {
    globalThis.fetch = controllableStubFetch({ sessions: PROJECT_SESSIONS });
    mountApp({ cwd: "/x" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(watchAck());
    await act(async () => {
      // A and B both have Workers, but only A is turning. The sidebar must
      // never render every live session as active/running.
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A", "B"], busySessionIds: ["A"] } });
      await flush();
    });
    await act(async () => {
      for (let round = 0; round < 3; round += 1) {
        await flush(20);
        vi.advanceTimersByTime(0);
      }
      await flush(20);
    });
    expect(countType(ws, "attach")).toBe(0);
    expect(screen.getAllByTestId("session-select-A")[0]!.closest('[data-running="true"]')).toBeTruthy();
    expect(screen.getAllByTestId("session-select-B")[0]!.closest('[data-running="true"]')).toBeNull();
    // Liveness is independent of busy: B is idle but live; C has no Worker
    // in the authoritative baseline, so only C is muted rather than falsely
    // treating every non-busy session as dead.
    expect(screen.getAllByTestId("session-select-B")[0]!.closest('[data-dead="true"]')).toBeNull();
    expect(screen.getAllByTestId("session-select-C")[0]!.closest('[data-dead="true"]')).toBeTruthy();

    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 2, sessionIds: ["A"], busySessionIds: [] } });
      await flush();
    });
    expect(countType(ws, "attach")).toBe(0);
    expect(screen.getAllByTestId("session-select-A")[0]!.closest('[data-running="true"]')).toBeNull();
  });

  it("keeps a selected dead history session active-but-muted after the liveness baseline", async () => {
    globalThis.fetch = controllableStubFetch({ sessions: PROJECT_SESSIONS });
    mountApp({ cwd: "/x", session: "A" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(watchAck());
    await act(async () => {
      // B is live but idle; A has no Worker. Selection must not fabricate A's
      // liveness and a missing baseline must never be treated as dead earlier.
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["B"], busySessionIds: [] } });
      await flush();
    });
    expect(countType(ws, "attach")).toBe(0);
    expect(screen.getAllByTestId("session-select-A")[0]!.closest('.sidebar-list-row')?.getAttribute("data-active")).toBe("true");
    expect(screen.getAllByTestId("session-select-A")[0]!.closest('.sidebar-list-row')?.getAttribute("data-dead")).toBe("true");
    expect(screen.getAllByTestId("session-select-B")[0]!.closest('.sidebar-list-row')?.getAttribute("data-dead")).toBeNull();
  });

  it("disables destructive sidebar actions for ANY global live id, including a background holder", async () => {
    globalThis.fetch = controllableStubFetch({ sessions: PROJECT_SESSIONS });
    const { rerender } = mountApp(
      { cwd: "/x", session: "A" },
      { queryClient: authenticatedQueryClient(), capabilities: ["agent", "sessions", "files", "models", "session.write", "session.delete"] },
    );
    const ws = await acceptAutomaticConnection(watchAck());
    await act(async () => {
      void capturedStore!.openSession("A").catch(() => undefined);
      await flush();
      const attach = lastFrame<{ type: string; id: string }>(ws, "attach")!;
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A" }) });
      await flush();
    });
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A", "B"], busySessionIds: ["A"] } });
      await flush();
    });
    rerender({ cwd: "/x", session: "C" });
    await act(async () => { await flush(); });
    expect(countType(ws, "detach")).toBe(0);
    expect(capturedStore!.registry.leaseSnapshot.holderSessionId).toBe("A");

    fireEvent.contextMenu(screen.getAllByTestId("session-select-A")[0]!);
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
    const exportA = screen.getByRole("menuitem", { name: /export/i });
    expect(exportA.getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });

    fireEvent.contextMenu(screen.getAllByTestId("session-select-B")[0]!);
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
    const exportB = screen.getByRole("menuitem", { name: /export/i });
    expect(exportB.getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });

    fireEvent.contextMenu(screen.getAllByTestId("session-select-C")[0]!);
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
  });

  it("smart-renames a globally live session without attaching the browser or activating history", async () => {
    globalThis.fetch = controllableStubFetch({ sessions: PROJECT_SESSIONS });
    mountApp(
      { cwd: "/x", session: "A" },
      { queryClient: authenticatedQueryClient(), capabilities: ["agent", "sessions", "files", "models", "session.write"] },
    );
    const ws = await acceptAutomaticConnection(watchAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A"], busySessionIds: [] } });
      await flush();
    });
    expect(countType(ws, "attach")).toBe(0);

    const rowA = screen.getAllByTestId("session-select-A")[0]!.closest<HTMLElement>(".sidebar-list-row")!;
    fireEvent.contextMenu(rowA);
    const smartRenameItem = screen.getByRole("menuitem", { name: "Smart rename" });
    expect(smartRenameItem.getAttribute("aria-disabled")).not.toBe("true");
    expect(smartRenameItem.getAttribute("title")).toBeNull();
    fireEvent.click(smartRenameItem);
    await act(async () => {
      for (let index = 0; index < 4 && lastFrame(ws, "listRunning") === undefined; index += 1) await flush();
    });

    const listFrame = lastFrame<{ type: "listRunning"; id: string }>(ws, "listRunning");
    expect(screen.queryAllByRole("alert").map((node) => node.textContent)).toEqual([]);
    expect(ws.sent.map((frame) => (frame as { type?: string }).type)).toContain("listRunning");
    expect(listFrame).toEqual(expect.objectContaining({ id: expect.any(String) }));
    await act(async () => {
      ws.serverSend({
        type: "response",
        id: listFrame!.id,
        payload: {
          ok: true,
          result: { sessions: [{ sessionId: "A", cwd: "/x", projectRoot: "/x", workerStatus: "ready", epoch: "epoch-A" }] },
        },
      });
      await flush();
    });

    const titleFrame = ws.sent.find((frame) => (
      frame as { payload?: { command?: { type?: string } } }
    ).payload?.command?.type === "generate_session_title") as {
      id: string;
      payload: { command: { commandId: string; model?: { provider: string; modelId: string } } };
    } | undefined;
    expect(titleFrame).toBeDefined();
    expect(titleFrame!.payload.command.model).toBeUndefined();
    expect((titleFrame as { payload: { epoch?: string } }).payload.epoch).toBe("epoch-A");
    expect(countType(ws, "attach")).toBe(0);

    await act(async () => {
      ws.serverSend({
        type: "response",
        id: titleFrame!.id,
        payload: {
          ok: true,
          result: {
            commandId: titleFrame!.payload.command.commandId,
            result: { ok: true, type: "generate_session_title", title: "Generated title" },
          },
        },
      });
      await flush();
    });

    const rowB = screen.getAllByTestId("session-select-B")[0]!.closest<HTMLElement>(".sidebar-list-row")!;
    fireEvent.contextMenu(rowB);
    const inactiveSmartRename = screen.getByRole("menuitem", { name: "Smart rename" });
    expect(inactiveSmartRename.getAttribute("aria-disabled")).toBe("true");
    expect(inactiveSmartRename.getAttribute("title")).toContain("Start this session");
    expect(countType(ws, "attach")).toBe(0);
  });

  it("resumes observation of a busy live session when its URL is re-entered", async () => {
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS });
    mountApp({ cwd: "/x", session: "A" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(lifecycleAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A"], busySessionIds: ["A"] } });
      await flush();
    });
    const attach = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string; attachMode?: string } }>(ws, "attach");
    expect(attach?.payload).toEqual({ sessionId: "A", attachMode: "existing_only" });
    expect(countType(ws, "detach")).toBe(0);
    expect(countType(ws, "stop")).toBe(0);
    expect(ws.sent.filter((frame) => ["activate", "create", "submit_turn"].includes((frame as { type?: string }).type ?? ""))).toHaveLength(0);
    await act(async () => {
      ws.serverSend({ type: "snapshot", id: attach!.id, payload: snapshotPayload({ sessionId: "A" }) });
      await flush();
    });
    expect(screen.queryByText("Opening session…")).toBeNull();
    expect(screen.queryByTestId("home-stack")).toBeNull();
    expect(screen.getByRole("log")).toBeTruthy();
    expect(capturedStore!.registry.leaseSnapshot.holderSessionId).toBe("A");
    expect(capturedStore!.getSnapshot().attached).toBe(true);
  });

  it("does not auto-observe a busy session when observe-existing was not negotiated", async () => {
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS });
    mountApp({ cwd: "/x", session: "A" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(watchAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A"], busySessionIds: ["A"] } });
      await flush();
    });
    expect(lastFrame(ws, "attach")).toBeUndefined();
    expect(countType(ws, "activate")).toBe(0);
    expect(countType(ws, "stop")).toBe(0);
    expect(screen.getByTestId("observation-error").textContent).toBe(
      describeRuntimeObservationError({ code: "unsupported_capability", retryable: false }),
    );
    expect(screen.queryByText("Opening session…")).toBeNull();
    expect(capturedStore!.registry.leaseSnapshot.holderSessionId).not.toBe("A");
    expect(capturedStore!.getSnapshot().attached).toBe(false);
  });

  it("observes a later-selected busy session without activating a Worker", async () => {
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS });
    const { rerender } = mountApp({ cwd: "/x" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(lifecycleAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["B"], busySessionIds: ["B"] } });
      await flush();
    });

    rerender({ cwd: "/x", session: "B" });
    await act(async () => { await flush(); });

    const observation = lastFrame<{ type: "attach"; payload: { sessionId: string; attachMode?: string } }>(ws, "attach");
    expect(observation?.payload).toEqual({ sessionId: "B", attachMode: "existing_only" });
    expect(ws.sent.filter((frame) => ["activate", "create", "submit_turn", "stop"].includes((frame as { type?: string }).type ?? ""))).toHaveLength(0);
  });

  it("busy A→B→A follows every presentation with observation-only attach and zero activation", async () => {
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS });
    const { rerender } = mountApp(
      { cwd: "/x", session: "A" },
      { queryClient: authenticatedQueryClient() },
    );
    const ws = await acceptAutomaticConnection(lifecycleAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A", "B"], busySessionIds: ["A", "B"] } });
      await flush();
    });

    const initialA = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    await act(async () => {
      ws.serverSend({ type: "snapshot", id: initialA.id, payload: snapshotPayload({ sessionId: "A" }) });
      await flush();
    });
    const openSpy = vi.spyOn(capturedStore!, "openSession");

    rerender({ cwd: "/x", session: "B" });
    await act(async () => { await flush(); });
    const detachA = lastFrame<{ type: "detach"; id: string; payload: { sessionId: string } }>(ws, "detach");
    if (detachA?.payload.sessionId === "A") {
      await act(async () => {
        ws.serverSend({ type: "response", id: detachA.id, payload: { ok: true, result: { sessionId: "A", detached: true } } });
        await flush();
      });
      const attachB = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string } }>(ws, "attach");
      if (attachB?.payload.sessionId === "B") {
        await act(async () => {
          ws.serverSend({ type: "snapshot", id: attachB.id, payload: snapshotPayload({ sessionId: "B", epoch: "eB" }) });
          await flush();
        });
      }
    }

    rerender({ cwd: "/x", session: "A" });
    await act(async () => { await flush(); });
    const detachB = lastFrame<{ type: "detach"; id: string; payload: { sessionId: string } }>(ws, "detach");
    if (detachB?.payload.sessionId === "B") {
      await act(async () => {
        ws.serverSend({ type: "response", id: detachB.id, payload: { ok: true, result: { sessionId: "B", detached: true } } });
        await flush();
      });
      const attachA = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string } }>(ws, "attach");
      if (attachA?.payload.sessionId === "A" && attachA.id !== initialA.id) {
        await act(async () => {
          ws.serverSend({ type: "snapshot", id: attachA.id, payload: snapshotPayload({ sessionId: "A" }) });
          await flush();
        });
      }
    }

    const observations = ws.sent.filter((frame) => (frame as { type?: string }).type === "attach") as Array<{
      payload: { sessionId: string; attachMode?: string; epoch?: string; lastEventId?: number };
    }>;
    expect(observations.map((frame) => frame.payload)).toEqual([
      { sessionId: "A", attachMode: "existing_only" },
      { sessionId: "B", attachMode: "existing_only" },
      { sessionId: "A", attachMode: "existing_only", epoch: "e1", lastEventId: 0 },
    ]);
    expect(ws.sent.filter((frame) => ["activate", "create", "submit_turn", "stop"].includes((frame as { type?: string }).type ?? ""))).toHaveLength(0);
    expect(openSpy).not.toHaveBeenCalled();
    expect(capturedStore!.registry.leaseSnapshot.holderSessionId).toBe("A");
    expect(screen.queryByText("Opening session…")).toBeNull();
    openSpy.mockRestore();
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

  it("does NOT attach an idle-but-live selected session (selection remains history until send)", async () => {
    mountApp({ cwd: "/x", session: "B" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection();
    const list = lastFrame<{ type: string; id: string }>(ws, "listRunning")!;
    await act(async () => {
      ws.serverSend({
        type: "response",
        id: list.id,
        payload: {
          ok: true,
          result: { sessions: [{ sessionId: "B", cwd: "/x", projectRoot: "/x", workerStatus: "ready", epoch: "e1" }] },
        },
      });
      await flush();
    });
    expect(lastFrame(ws, "attach")).toBeUndefined();
    expect(countType(ws, "detach")).toBe(0);
    expect(countType(ws, "stop")).toBe(0);
    expect(capturedStore!.getSnapshot().attached).toBe(false);
    expect(screen.queryByText("Opening session…")).toBeNull();
  });

  it("busy=false before an in-flight observation snapshot does not detach or send stop", async () => {
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS });
    mountApp({ cwd: "/x", session: "A" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(lifecycleAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A"], busySessionIds: ["A"] } });
      await flush();
    });
    const attach = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string; attachMode?: string } }>(ws, "attach")!;
    expect(attach.payload).toEqual({ sessionId: "A", attachMode: "existing_only" });
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 2, sessionIds: ["A"], busySessionIds: [] } });
      await flush();
    });
    expect(countType(ws, "detach")).toBe(0);
    expect(countType(ws, "stop")).toBe(0);
    await act(async () => {
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A" }) });
      await flush();
    });
    expect(capturedStore!.registry.leaseSnapshot.holderSessionId).toBe("A");
    expect(capturedStore!.getSnapshot().attached).toBe(true);
    expect(countType(ws, "stop")).toBe(0);
  });

  it("catalog authorized→history_only detaches the selected observer through UI without stop or navigation", async () => {
    const fetchImpl = controllableStubFetch({ sessions: SESSION_HEADERS });
    globalThis.fetch = fetchImpl;
    const { queryClient } = mountApp({ cwd: "/x", session: "A" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(lifecycleAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A"], busySessionIds: ["A"] } });
      await flush();
    });
    const attach = lastFrame<{ type: "attach"; id: string }>(ws, "attach")!;
    await act(async () => {
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A" }) });
      await flush();
    });
    expect(capturedStore!.registry.leaseSnapshot.holderSessionId).toBe("A");
    const presentationRevision = capturedStore!.registry.getSnapshot().presentationRevision;
    await act(async () => {
      queryClient.setQueryData(queryKeys.sessions.detail("A"), {
        session: { ...SESSION_HEADERS[0]!, workspaceAccess: { state: "history_only", reason: "outside_allowed_roots" } },
      });
      vi.advanceTimersByTime(0);
      await flush();
    });
    const detach = lastFrame<{ type: "detach"; id: string; payload: { sessionId: string } }>(ws, "detach");
    expect(detach?.payload.sessionId).toBe("A");
    await act(async () => {
      ws.serverSend({ type: "response", id: detach!.id, payload: { ok: true, result: { sessionId: "A", detached: true } } });
      await flush();
    });
    expect(countType(ws, "stop")).toBe(0);
    expect(ws.sent.filter((frame) => ["activate", "create", "submit_turn"].includes((frame as { type?: string }).type ?? ""))).toHaveLength(0);
    expect(navigateMock).not.toHaveBeenCalled();
    expect(capturedStore!.registry.getSnapshot().presentationKey).toBe("session:A");
    expect(capturedStore!.registry.getSnapshot().presentationAuthorized).toBe(false);
    expect(capturedStore!.registry.getSnapshot().presentationRevision).toBeGreaterThan(presentationRevision);
    expect(capturedStore!.registry.leaseSnapshot.holderSessionId).toBeNull();
    expect(capturedStore!.registry.peek("A")?.getSnapshot().attached).toBe(false);
    expect(screen.getAllByText("This session is history-only. Live workspace actions are unavailable.").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("home-stack")).toBeNull();
  });

  it("gate logout through UI releases this browser lease without stop or navigation", async () => {
    const { queryClient } = mountApp({ cwd: "/x", session: "A" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(lifecycleAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A"], busySessionIds: ["A"] } });
      await flush();
    });
    const attach = lastFrame<{ type: "attach"; id: string }>(ws, "attach")!;
    await act(async () => {
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A" }) });
      await flush();
    });
    expect(capturedStore!.registry.leaseSnapshot.holderSessionId).toBe("A");
    await act(async () => {
      queryClient.setQueryData(queryKeys.gate.status(), { status: "enabled", required: true, authenticated: false, mode: "local" });
      vi.advanceTimersByTime(0);
      await flush();
    });
    const detach = lastFrame<{ type: "detach"; id: string; payload: { sessionId: string } }>(ws, "detach");
    expect(detach?.payload.sessionId).toBe("A");
    await act(async () => {
      ws.serverSend({ type: "response", id: detach!.id, payload: { ok: true, result: { sessionId: "A", detached: true } } });
      await flush();
    });
    expect(countType(ws, "stop")).toBe(0);
    expect(navigateMock).not.toHaveBeenCalled();
    expect(document.querySelector(".login-page")).toBeTruthy();
    expect(capturedStore!.registry.leaseSnapshot.holderSessionId).toBeNull();
    expect(capturedStore!.registry.peek("A")?.getSnapshot().attached).toBe(false);
  });

  it("agent capability loss through UI releases this browser lease without stop", async () => {
    const { rerender } = mountApp({ cwd: "/x", session: "A" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(lifecycleAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A"], busySessionIds: ["A"] } });
      await flush();
    });
    const attach = lastFrame<{ type: "attach"; id: string }>(ws, "attach")!;
    await act(async () => {
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A" }) });
      await flush();
    });
    expect(capturedStore!.registry.leaseSnapshot.holderSessionId).toBe("A");
    rerender({ cwd: "/x", session: "A" }, { capabilities: ["sessions", "files", "models"] });
    await act(async () => { await flush(); });
    const detach = lastFrame<{ type: "detach"; id: string; payload: { sessionId: string } }>(ws, "detach");
    expect(detach?.payload.sessionId).toBe("A");
    await act(async () => {
      ws.serverSend({ type: "response", id: detach!.id, payload: { ok: true, result: { sessionId: "A", detached: true } } });
      await flush();
    });
    expect(countType(ws, "stop")).toBe(0);
    expect(navigateMock).not.toHaveBeenCalled();
    expect(capturedStore!.registry.getSnapshot().presentationKey).toBe("session:A");
    expect(capturedStore!.registry.leaseSnapshot.holderSessionId).toBeNull();
    expect(capturedStore!.registry.peek("A")?.getSnapshot().attached).toBe(false);
  });

  it("history_only revoke with a failed detach shows the current-presentation error; A cannot paint C", async () => {
    const { queryClient, rerender } = mountApp({ cwd: "/x", session: "A" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(lifecycleAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A", "C"], busySessionIds: ["A", "C"] } });
      await flush();
    });
    const attachA = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    await act(async () => {
      ws.serverSend({ type: "snapshot", id: attachA.id, payload: snapshotPayload({ sessionId: "A" }) });
      await flush();
    });
    expect(capturedStore!.registry.peek("A")?.getSnapshot().attached).toBe(true);
    await act(async () => {
      queryClient.setQueryData(queryKeys.sessions.detail("A"), {
        session: { ...SESSION_HEADERS[0]!, workspaceAccess: { state: "history_only", reason: "outside_allowed_roots" } },
      });
      vi.advanceTimersByTime(0);
      await flush();
    });
    const detachA = lastFrame<{ type: "detach"; id: string; payload: { sessionId: string } }>(ws, "detach");
    expect(detachA?.payload.sessionId).toBe("A");
    await act(async () => {
      ws.serverSend({ type: "response", id: detachA!.id, payload: { ok: false, error: { code: "timeout", message: "detach timed out", retryable: true } } });
      await flush();
    });
    const releaseCopy = describeRuntimeObservationError({ code: "timeout", retryable: true });
    expect(screen.getByTestId("observation-error").textContent).toBe(releaseCopy);
    expect(countType(ws, "stop")).toBe(0);
    expect(capturedStore!.registry.leaseSnapshot.phase).toBe("vacant");
    expect(capturedStore!.registry.getSnapshot().presentationKey).toBe("session:A");
    rerender({ cwd: "/x", session: "C" });
    await act(async () => { await flush(); });
    expect(capturedStore!.registry.getSnapshot().presentationKey).toBe("session:C");
    await act(async () => {
      ws.serverSend({ type: "response", id: detachA!.id, payload: { ok: false, error: { code: "timeout", message: "late A detach", retryable: true } } });
      await flush();
    });
    expect(screen.queryByTestId("observation-error")).toBeNull();
    expect(countType(ws, "stop")).toBe(0);
  });

  it("file/home cwd key changes mint a revision; busy changes do not", async () => {
    const { rerender } = mountApp({ cwd: "/x" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(lifecycleAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A"], busySessionIds: [] } });
      await flush();
    });
    const homeRevision = capturedStore!.registry.getSnapshot().presentationRevision;
    expect(capturedStore!.registry.getSnapshot().presentationKey).toBe("home:/x");
    rerender({ cwd: "/y" });
    await act(async () => { await flush(); });
    expect(capturedStore!.registry.getSnapshot().presentationKey).toBe("home:/y");
    expect(capturedStore!.registry.getSnapshot().presentationRevision).toBeGreaterThan(homeRevision);
    const yRevision = capturedStore!.registry.getSnapshot().presentationRevision;
    rerender({ cwd: "/y", file: "/y/a.ts" });
    await act(async () => { await flush(); });
    expect(capturedStore!.registry.getSnapshot().presentationKey).toBe("file:/y:/y/a.ts");
    expect(capturedStore!.registry.getSnapshot().presentationRevision).toBeGreaterThan(yRevision);
    const fileRevision = capturedStore!.registry.getSnapshot().presentationRevision;
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 2, sessionIds: ["A"], busySessionIds: ["A"] } });
      await flush();
    });
    expect(capturedStore!.registry.getSnapshot().presentationRevision).toBe(fileRevision);
    expect(countType(ws, "attach")).toBe(0);
  });

  it("A late observation error after B selection cannot paint B or clear B's error", async () => {
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS });
    const { rerender } = mountApp({ cwd: "/x", session: "A" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(lifecycleAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A", "B"], busySessionIds: ["A", "B"] } });
      await flush();
    });
    const attachA = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    expect(attachA.payload.sessionId).toBe("A");
    rerender({ cwd: "/x", session: "B" });
    await act(async () => { await flush(); });
    const detachA = lastFrame<{ type: "detach"; id: string; payload: { sessionId: string } }>(ws, "detach");
    if (detachA?.payload.sessionId === "A") {
      await act(async () => {
        ws.serverSend({ type: "response", id: detachA.id, payload: { ok: true, result: { sessionId: "A", detached: true } } });
        await flush();
      });
    }
    const attachB = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    expect(attachB.payload.sessionId).toBe("B");
    await act(async () => {
      ws.serverSend({ type: "response", id: attachB.id, payload: { ok: false, error: { code: "unavailable", message: "B live view failed", retryable: true } } });
      await flush();
    });
    const bannerB = describeRuntimeObservationError({ code: "unavailable", retryable: true });
    expect(screen.getByTestId("observation-error").textContent).toBe(bannerB);
    await act(async () => {
      ws.serverSend({ type: "response", id: attachA.id, payload: { ok: false, error: { code: "timeout", message: "A late", retryable: true } } });
      await flush();
    });
    expect(screen.getByTestId("observation-error").textContent).toBe(bannerB);
    expect(countType(ws, "stop")).toBe(0);
    expect(capturedStore!.registry.getSnapshot().presentationKey).toBe("session:B");
  });

  it("busy=false while an eligible in-flight observation is attaching still consumes the snapshot", async () => {
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS });
    mountApp({ cwd: "/x", session: "A" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(lifecycleAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A"], busySessionIds: ["A"] } });
      await flush();
    });
    const attach = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string; attachMode?: string } }>(ws, "attach")!;
    expect(attach.payload).toEqual({ sessionId: "A", attachMode: "existing_only" });
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 2, sessionIds: ["A"], busySessionIds: [] } });
      await flush();
    });
    expect(countType(ws, "attach")).toBe(1);
    expect(countType(ws, "detach")).toBe(0);
    await act(async () => {
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A" }) });
      await flush();
    });
    expect(capturedStore!.registry.leaseSnapshot.holderSessionId).toBe("A");
    expect(capturedStore!.getSnapshot().attached).toBe(true);
  });

  it("gate revoke then a failed detach shows the current-presentation error and ignores later A frames", async () => {
    const { queryClient } = mountApp({ cwd: "/x", session: "A" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(lifecycleAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A"], busySessionIds: ["A"] } });
      await flush();
    });
    const attach = lastFrame<{ type: "attach"; id: string }>(ws, "attach")!;
    await act(async () => {
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A" }) });
      await flush();
    });
    await act(async () => {
      queryClient.setQueryData(queryKeys.gate.status(), { status: "enabled", required: true, authenticated: false, mode: "local" });
      vi.advanceTimersByTime(0);
      await flush();
    });
    const detach = lastFrame<{ type: "detach"; id: string; payload: { sessionId: string } }>(ws, "detach");
    expect(detach?.payload.sessionId).toBe("A");
    await act(async () => {
      ws.serverSend({ type: "response", id: detach!.id, payload: { ok: false, error: { code: "timeout", message: "detach timed out", retryable: true } } });
      await flush();
    });
    expect(countType(ws, "stop")).toBe(0);
    expect(capturedStore!.registry.leaseSnapshot.phase).toBe("vacant");
    expect(document.querySelector(".login-page")).toBeTruthy();
  });

  it("re-observes selected A after lease/runtime loss when it becomes busy again without a route change", async () => {
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS });
    mountApp({ cwd: "/x", session: "A" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(lifecycleAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A"], busySessionIds: ["A"] } });
      await flush();
    });
    const first = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string; attachMode?: string } }>(ws, "attach")!;
    expect(first.payload).toEqual({ sessionId: "A", attachMode: "existing_only" });
    await act(async () => {
      ws.serverSend({ type: "snapshot", id: first.id, payload: snapshotPayload({ sessionId: "A" }) });
      await flush();
    });
    expect(capturedStore!.registry.leaseSnapshot.holderSessionId).toBe("A");
    await act(async () => {
      ws.serverClose(1006, "runtime loss");
      await flush();
      vi.advanceTimersByTime(250);
      await flush();
    });
    const ws2 = SOCKETS.at(-1)!;
    expect(ws2).not.toBe(ws);
    await act(async () => {
      if (ws2.readyState !== 1) ws2.serverOpen();
      ws2.serverSend(lifecycleAck());
      await flush();
      ws2.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A"], busySessionIds: ["A"] } });
      await flush();
    });
    const second = lastFrame<{ type: "attach"; payload: { sessionId: string; attachMode?: string } }>(ws2, "attach");
    expect(second?.payload.sessionId).toBe("A");
    expect(second?.payload.attachMode).toBe("existing_only");
    expect(countType(ws2, "stop")).toBe(0);
    expect(capturedStore!.registry.getSnapshot().presentationKey).toBe("session:A");
  });

  it("an observation error does not hammer-loop, but a later busy authority recovers", async () => {
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS });
    mountApp({ cwd: "/x", session: "A" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(lifecycleAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A"], busySessionIds: ["A"] } });
      await flush();
    });
    const first = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    await act(async () => {
      ws.serverSend({ type: "response", id: first.id, payload: { ok: false, error: { code: "unavailable", message: "A live view failed", retryable: true } } });
      await flush();
    });
    expect(screen.getByTestId("observation-error").textContent).toBe(
      describeRuntimeObservationError({ code: "unavailable", retryable: true }),
    );
    const attachCountAfterError = countType(ws, "attach");
    await act(async () => { await flush(); });
    expect(countType(ws, "attach")).toBe(attachCountAfterError);
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 2, sessionIds: ["A"], busySessionIds: [] } });
      await flush();
    });
    expect(countType(ws, "attach")).toBe(attachCountAfterError);
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 3, sessionIds: ["A"], busySessionIds: ["A"] } });
      await flush();
    });
    expect(countType(ws, "attach")).toBeGreaterThan(attachCountAfterError);
    const recovered = lastFrame<{ type: "attach"; payload: { sessionId: string; attachMode?: string } }>(ws, "attach");
    expect(recovered?.payload).toEqual({ sessionId: "A", attachMode: "existing_only" });
    expect(countType(ws, "stop")).toBe(0);
  });

  it("observe-feature true→false releases once; later never-negotiated v2 pre-send is not cancelled", async () => {
    const { rerender } = mountApp({ cwd: "/x", session: "A" }, { queryClient: authenticatedQueryClient() });
    navigateMock.mockImplementation(async (options: { search: WorkspaceSearch }) => {
      rerender(options.search);
      await flush();
    });
    const ws = await acceptAutomaticConnection(lifecycleAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A"], busySessionIds: ["A"] } });
      await flush();
    });
    const attach = lastFrame<{ type: "attach"; id: string }>(ws, "attach")!;
    await act(async () => {
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A" }) });
      await flush();
    });
    expect(capturedStore!.registry.leaseSnapshot.holderSessionId).toBe("A");
    await act(async () => {
      ws.serverClose(1006, "feature loss");
      await flush();
      vi.advanceTimersByTime(250);
      await flush();
    });
    const next = SOCKETS.at(-1)!;
    expect(next).not.toBe(ws);
    await act(async () => {
      if (next.readyState !== 1) next.serverOpen();
      next.serverSend(watchAck());
      await flush();
    });
    const detach = lastFrame<{ type: "detach"; id: string; payload: { sessionId: string } }>(next, "detach")
      ?? lastFrame<{ type: "detach"; id: string; payload: { sessionId: string } }>(ws, "detach");
    if (detach) {
      await act(async () => {
        const ack = { type: "response", id: detach.id, payload: { ok: true, result: { sessionId: "A", detached: true } } };
        next.serverSend(ack);
        ws.serverSend(ack);
        await flush();
      });
    }
    const detachCountAfterLoss = countType(ws, "detach") + countType(next, "detach");
    rerender({ cwd: "/x" });
    await act(async () => { await flush(); });
    const textarea = document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    fireEvent.change(textarea, { target: { value: "first from home" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    await act(async () => { await flush(8); });
    expect(SOCKETS.at(-1)).toBe(next);
    const create = lastFrame<{ type: string; id: string }>(next, "create")!;
    expect(create).toBeTruthy();
    await act(async () => {
      next.serverSend({
        type: "response",
        id: create.id,
        payload: { ok: true, result: { sessionId: "legacy-home", epoch: "eL", created: true, cwd: "/x", projectRoot: "/x", snapshot: snapshotPayload({ sessionId: "legacy-home" }).snapshot } },
      });
      await flush();
    });
    const attachLegacy = await waitForAttach(next, "legacy-home");
    expect(attachLegacy.payload?.sessionId).toBe("legacy-home");
    await act(async () => {
      next.serverSend({
        type: "snapshot",
        id: attachLegacy.id,
        payload: snapshotPayload({ sessionId: "legacy-home", epoch: "eL", capabilities: ["runtime.prompt", "runtime.abort"] }),
      });
      await flush(12);
    });
    const prompt = lastFrame<{ type: string; payload: { sessionId: string; command: { type: string; message: string } } }>(next, "command");
    expect(prompt?.payload.sessionId).toBe("legacy-home");
    expect(prompt?.payload.command.type).toBe("prompt");
    expect(prompt?.payload.command.message).toBe("first from home");
    expect(countType(ws, "detach") + countType(next, "detach")).toBe(detachCountAfterLoss);
    expect(countType(ws, "stop") + countType(next, "stop")).toBe(0);
    expect(next.sent.filter((frame) => (frame as { type?: string }).type === "submit_turn")).toHaveLength(0);
  });

  it("global gate revoke while A is held in the background from home/file still detaches without stop", async () => {
    const { queryClient, rerender } = mountApp({ cwd: "/x", session: "A" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(lifecycleAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A"], busySessionIds: ["A"] } });
      await flush();
    });
    const attach = lastFrame<{ type: "attach"; id: string }>(ws, "attach")!;
    await act(async () => {
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A" }) });
      await flush();
    });
    expect(capturedStore!.registry.leaseSnapshot.holderSessionId).toBe("A");
    rerender({ cwd: "/x" });
    await act(async () => { await flush(); });
    expect(capturedStore!.registry.getSnapshot().presentationKey).toBe("home:/x");
    expect(capturedStore!.registry.leaseSnapshot.holderSessionId).toBe("A");
    await act(async () => {
      queryClient.setQueryData(queryKeys.gate.status(), { status: "enabled", required: true, authenticated: false, mode: "local" });
      vi.advanceTimersByTime(0);
      await flush();
    });
    const detach = lastFrame<{ type: "detach"; id: string; payload: { sessionId: string } }>(ws, "detach");
    expect(detach?.payload.sessionId).toBe("A");
    await act(async () => {
      ws.serverSend({ type: "response", id: detach!.id, payload: { ok: true, result: { sessionId: "A", detached: true } } });
      await flush();
    });
    expect(countType(ws, "stop")).toBe(0);
    expect(navigateMock).not.toHaveBeenCalled();
    expect(capturedStore!.registry.leaseSnapshot.holderSessionId).toBeNull();
  });

  it("global agent-cap loss while A is held in the background from a file tab still detaches without stop", async () => {
    const { rerender } = mountApp({ cwd: "/x", session: "A" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(lifecycleAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A"], busySessionIds: ["A"] } });
      await flush();
    });
    const attach = lastFrame<{ type: "attach"; id: string }>(ws, "attach")!;
    await act(async () => {
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A" }) });
      await flush();
    });
    expect(capturedStore!.registry.leaseSnapshot.holderSessionId).toBe("A");
    rerender({ cwd: "/x", file: "/x/a.ts" });
    await act(async () => { await flush(); });
    expect(capturedStore!.registry.getSnapshot().presentationKey).toBe("file:/x:/x/a.ts");
    expect(capturedStore!.registry.leaseSnapshot.holderSessionId).toBe("A");
    rerender({ cwd: "/x", file: "/x/a.ts" }, { capabilities: ["sessions", "files", "models"] });
    await act(async () => { await flush(); });
    const detach = lastFrame<{ type: "detach"; id: string; payload: { sessionId: string } }>(ws, "detach");
    expect(detach?.payload.sessionId).toBe("A");
    await act(async () => {
      ws.serverSend({ type: "response", id: detach!.id, payload: { ok: true, result: { sessionId: "A", detached: true } } });
      await flush();
    });
    expect(countType(ws, "stop")).toBe(0);
    expect(capturedStore!.registry.leaseSnapshot.holderSessionId).toBeNull();
  });

  it("rapid read-only selection B→C keeps the background subscription and never attaches either target", async () => {
    const { rerender } = mountApp({ cwd: "/x" });
    const ws = await connectReady();
    await act(async () => {
      void capturedStore!.openSession("A").catch(() => undefined);
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

describe("AppShell — immediate session selection (no prepare/pending)", () => {
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

  it("navigates immediately on click — one navigation, cwd preserved, no pending cue", async () => {
    const contextDeferreds = new Map<string, Deferred>();
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS, contextDeferreds });
    const { rerender } = mountApp({ cwd: "/x" });
    // Wait for the sessions list so the sidebar rows render.
    await settle();
    expect(screen.getByTestId("session-select-B")).toBeTruthy();
    fireEvent.click(screen.getAllByTestId("session-select-B")[0]!);
    await act(async () => { await flush(8); });
    // IMMEDIATE: exactly one navigation, before any history data settles.
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ to: "/", search: { session: "B", cwd: "/x" } }));
    // No pending cue surface exists anymore.
    expect(screen.queryByLabelText("Opening session…")).toBeNull();
    expect(document.querySelector("[data-pending]")).toBeNull();
    // The router applies the navigation → the keyed TranscriptList mounts B's
    // own surface and its complete-branch request fires under B's exact key.
    rerender({ cwd: "/x", session: "B" });
    await act(async () => { await flush(8); });
    expect(contextDeferreds.get("B")).toBeDefined();
  });

  it("serves a warm complete-branch cache without issuing a context fetch", async () => {
    const contextCalls: string[] = [];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Pre-seed B's exact complete history response — the SAME key the keyed
    // TranscriptList mounts against (centralized cache authority), so the
    // history query resolves from the cache and never hits the network.
    qc.setQueryData(queryKeys.sessions.history("B", 0, null), {
      context: { sessionId: "B", entries: [], pageInfo: { hasMore: false } },
    });
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS, contextCalls });
    mountApp({ cwd: "/x" }, { queryClient: qc });
    await settle();
    fireEvent.click(screen.getAllByTestId("session-select-B")[0]!);
    await act(async () => { await flush(8); });
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ search: { session: "B", cwd: "/x" } }));
    // Warm cache → zero context requests issued.
    expect(contextCalls).toEqual([]);
  });

  it("rapid B→C navigates per click; the last click is the final destination", async () => {
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS });
    mountApp({ cwd: "/x" });
    await settle();
    fireEvent.click(screen.getAllByTestId("session-select-B")[0]!);
    await act(async () => { await flush(6); });
    fireEvent.click(screen.getAllByTestId("session-select-C")[0]!);
    await act(async () => { await flush(6); });
    // Immediate selection: every click navigates at once — no late completion
    // can ever navigate "back" to a superseded target.
    expect(navigateMock).toHaveBeenCalledTimes(2);
    expect(navigateMock).toHaveBeenLastCalledWith(expect.objectContaining({ search: { session: "C", cwd: "/x" } }));
    expect(navigateMock.mock.calls.some((call) => {
      const search = (call[0] as { search?: { session?: string } }).search;
      return search?.session === "B";
    })).toBe(true);
  });

  it("a history fetch error renders the target's honest error surface (navigation already committed)", async () => {
    globalThis.fetch = controllableStubFetch({
      sessions: SESSION_HEADERS,
      contextError: { body: { message: "not found", code: "SESSION_NOT_FOUND" }, status: 404 },
    });
    const { queryClient } = mountApp({ cwd: "/x", session: "B" });
    await settle();
    // Navigation is URL-driven (committed before any fetch); the transcript's
    // own query surfaces the honest error under B's exact history key.
    const state = queryClient.getQueryState(queryKeys.sessions.history("B", 0, null));
    expect(state?.status).toBe("error");
  });

  it("zero runtime attach frames during selection (0-Worker history)", async () => {
    const contextDeferreds = new Map<string, Deferred>();
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS, contextDeferreds });
    const { rerender } = mountApp({ cwd: "/x" });
    const ws = await connectReady();
    // Attach fully to A (live).
    await act(async () => {
      void capturedStore!.openSession("A").catch(() => undefined);
      await flush();
      const attach = lastFrame<{ type: string; id: string }>(ws, "attach")!;
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A" }) });
      await flush();
    });
    expect(capturedStore!.getSnapshot().attached).toBe(true);
    const attachCountBefore = countType(ws, "attach");
    await settle(); // sessions list renders rows
    // Click B (history); the live A frame stays mounted + correct.
    fireEvent.click(screen.getAllByTestId("session-select-B")[0]!);
    await act(async () => { await flush(6); });
    expect(capturedStore!.getSnapshot().attached).toBe(true);
    expect(capturedStore!.getSnapshot().sessionId).toBe("A");
    // Router applies the navigation → the keyed TranscriptList mounts B and
    // issues its one complete-branch request.
    rerender({ cwd: "/x", session: "B" });
    await act(async () => { await flush(8); });
    await act(async () => {
      contextDeferreds.get("B")!.resolve(contextResponse("B"));
      await flush(12);
    });
    expect(navigateMock).toHaveBeenCalledTimes(1);
    // Selection never activates a worker: zero attach frames across selection.
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
  // Assumes mountApp({ cwd: "/x" }) + a ready FakeWebSocket already ran.
  await act(async () => {
    void capturedStore!.openSession("A").catch(() => undefined);
    const attach = await waitForAttach(ws);
    ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A", model: { provider: "openai", id: "gpt-5" }, capabilities: LIVE_CAPS }) });
    await flush();
  });
  // Let the React Query /v1/models catalog settle so the model selector renders.
  await act(async () => { await flush(); });
}

/** Observation-only hold of A (attachMode existing_only). Does not replace mountLiveA. */
async function observeExistingA(ws: FakeWebSocket): Promise<void> {
  await act(async () => {
    void capturedStore!.registry.observeExisting("A").catch(() => undefined);
    const attach = await waitForAttach(ws, "A");
    expect((attach as { payload?: { attachMode?: string } }).payload?.attachMode).toBe("existing_only");
    ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A", model: { provider: "openai", id: "gpt-5" }, capabilities: LIVE_CAPS }) });
    await flush();
  });
  await act(async () => { await flush(); });
}

/** Select B as read-only history while A remains the background subscription. */
async function selectDetachedB(_ws: FakeWebSocket, rerender: (s: WorkspaceSearch) => void): Promise<void> {
  rerender({ cwd: "/x", session: "B" });
  await act(async () => { await flush(); });
  // Let B's transcript + model catalog queries settle. The exact persisted
  // settings are intentionally asynchronous now; detached rendering must not
  // fall back to the catalog while this read is pending.
  await act(async () => {
    await flush(12);
    await vi.runOnlyPendingTimersAsync();
    await flush(12);
  });
}

async function ackBackgroundDetach(ws: FakeWebSocket, sessionId = "A"): Promise<void> {
  const detach = lastFrame<{ type: string; id: string }>(ws, "detach")!;
  await act(async () => {
    ws.serverSend({ type: "response", id: detach.id, payload: { ok: true, result: { sessionId, detached: true } } });
    await flush();
  });
}

function isExactSessionDetailPath(path: string, sessionId: string): boolean {
  const exact = path.match(/\/v1\/sessions\/([^/?]+)(?:\?.*)?$/);
  return Boolean(
    exact
    && !path.includes("/context")
    && !path.includes("/tree")
    && decodeURIComponent(exact[1]!) === sessionId,
  );
}

function countExactSessionDetailCalls(fetchImpl: typeof fetch, sessionId: string): number {
  const calls = (fetchImpl as typeof fetch & { mock: { calls: Array<[RequestInfo | URL]> } }).mock.calls;
  return calls.filter((call) => isExactSessionDetailPath(String(call[0]), sessionId)).length;
}

function installPendingADetailFetch(): { fetchImpl: typeof fetch; deferred: Deferred } {
  // Capture a baseline stub BEFORE mountApp. HttpClientProvider binds
  // globalThis.fetch on construct; swapping after mount never sees /detail.
  const baseline = stubFetch();
  const deferred = createDeferred<Response>();
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    // Clone so StrictMode's second waiter can still read the body.
    if (isExactSessionDetailPath(path, "A")) return deferred.promise.then((response) => response.clone());
    return baseline(input, init);
  }) as unknown as typeof fetch;
  globalThis.fetch = fetchImpl;
  return { fetchImpl, deferred };
}

async function settleQueryNotifications(): Promise<void> {
  // React Query notifyManager + useSyncExternalStore may land on a 0-timer.
  // Repeat a few 0-advances so a resolved detail actually re-renders AppShell.
  for (let round = 0; round < 4; round += 1) {
    await act(async () => {
      await flush(12);
      vi.advanceTimersByTime(0);
      await flush(12);
    });
  }
}

function lifecycleCounts(ws: FakeWebSocket) {
  return {
    attach: countType(ws, "attach"),
    activate: countType(ws, "activate"),
    command: countType(ws, "command"),
    stop: countType(ws, "stop"),
    detach: countType(ws, "detach"),
    create: countType(ws, "create"),
    submit: ws.sent.filter((frame) => (frame as { type?: string }).type === "submit_turn").length,
  };
}

async function ackDetachIfPresent(sockets: readonly FakeWebSocket[], sessionId = "A"): Promise<void> {
  for (const socket of sockets) {
    const detach = lastFrame<{ type: string; id: string; payload?: { sessionId?: string } }>(socket, "detach");
    if (detach?.payload?.sessionId !== sessionId) continue;
    await act(async () => {
      socket.serverSend({ type: "response", id: detach.id, payload: { ok: true, result: { sessionId, detached: true } } });
      await flush();
    });
  }
}

/** Home → hold live A → select A while GET /v1/sessions/A is deferred (empty catalog, no listed header). */
async function mountHeldAPendingDetail(
  handshake: unknown = lifecycleAck(),
  holdA: (ws: FakeWebSocket) => Promise<void> = mountLiveA,
) {
  const pending = installPendingADetailFetch();
  const queryClient = authenticatedQueryClient();
  const mounted = mountApp({ cwd: "/x" }, { queryClient });
  const ws = await acceptAutomaticConnection(handshake);
  await holdA(ws);
  const held = capturedStore!.registry.peek("A")?.getSnapshot();
  expect(held?.attached).toBe(true);
  expect(held?.snapshot?.state.model).toEqual({ provider: "openai", id: "gpt-5" });
  expect(capturedStore!.registry.leaseSnapshot.holderSessionId).toBe("A");
  const baselines = lifecycleCounts(ws);
  mounted.rerender({ cwd: "/x", session: "A" });
  await settleQueryNotifications();
  const detailState = queryClient.getQueryState(queryKeys.sessions.detail("A"));
  expect(countExactSessionDetailCalls(pending.fetchImpl, "A")).toBeGreaterThan(0);
  expect(countExactSessionDetailCalls(pending.fetchImpl, "B")).toBe(0);
  expect(detailState?.data).toBeUndefined();
  expect(detailState?.status).toBe("pending");
  expect(detailState?.fetchStatus).toBe("fetching");
  expect(queryClient.getQueryData(queryKeys.sessions.detail("A"))).toBeUndefined();
  expect(capturedStore!.getSnapshot().sessionId).toBe("A");
  expect(capturedStore!.registry.peek("A")?.getSnapshot().attached).toBe(true);
  expect(capturedStore!.registry.leaseSnapshot.holderSessionId).toBe("A");
  expect((screen.getByLabelText("Send message") as HTMLButtonElement).disabled).toBe(true);
  expect(lifecycleCounts(ws)).toEqual(baselines);
  return { ...mounted, ws, pending, queryClient, baselines, detailState };
}

function expectHeldAPendingSurface(): void {
  const controller = capturedStore!.registry.peek("A")?.getSnapshot();
  expect(controller?.attached).toBe(true);
  expect(controller?.snapshot?.state.model).toEqual({ provider: "openai", id: "gpt-5" });
  expect(capturedStore!.registry.leaseSnapshot.holderSessionId).toBe("A");
  const modelBtn = screen.queryByLabelText("Change model");
  if (modelBtn) expect(modelBtn.textContent).toContain("GPT-5");
}

async function expectReleasedHeldA(ws: FakeWebSocket, baselines: ReturnType<typeof lifecycleCounts>): Promise<void> {
  expect(countType(ws, "detach")).toBe(baselines.detach + 1);
  expect(lastFrame<{ type: "detach"; payload: { sessionId: string } }>(ws, "detach")?.payload.sessionId).toBe("A");
  expect(capturedStore!.registry.peek("A")?.getSnapshot().attached).toBe(false);
  expect(countType(ws, "attach")).toBe(baselines.attach);
  expect(countType(ws, "activate")).toBe(baselines.activate);
  expect(countType(ws, "command")).toBe(baselines.command);
  expect(countType(ws, "stop")).toBe(0);
  expect(ws.sent.filter((frame) => ["create", "submit_turn"].includes((frame as { type?: string }).type ?? "")).length).toBe(0);
  await ackDetachIfPresent([ws]);
  expect(capturedStore!.registry.leaseSnapshot.holderSessionId).toBeNull();
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

describe("Composer — coherent history and staged context", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    SOCKETS.length = 0;
    capturedStore = null;
    navigateMock.mockReset();
    previousFetch = globalThis.fetch;
    modelsCatalog = {
      models: [
        { provider: "acme-gpt", id: "gpt-6-astra", displayName: "Old runtime model", contextWindow: 1_050_000 },
        { provider: "deepseek-official", id: "deepseek-v4-flash", displayName: "Latest persisted model", contextWindow: 1_000_000 },
        { provider: "test", id: "pending", displayName: "Pending model", contextWindow: 2_000_000 },
      ],
      defaultModel: null,
    };
    const baseline = stubFetch();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/context")) {
        const id = decodeURIComponent(path.split("/v1/sessions/")[1]!.split("/")[0]!);
        return json({ context: {
          sessionId: id,
          leafId: `${id}-latest`,
          entries: [],
          settings: { model: { provider: "deepseek-official", modelId: "deepseek-v4-flash" }, thinkingLevel: "off" },
          contextTokens: id === "A" ? 263_711 : 0,
          pageInfo: { hasMore: false },
        } });
      }
      return baseline(input, init);
    }) as typeof fetch;
  });
  afterEach(() => { cleanup(); globalThis.fetch = previousFetch; vi.useRealTimers(); });

  it("shows the latest persisted model and 26% despite an existing same-id worker, with zero runtime reads or activation", async () => {
    const { rerender } = mountApp({ cwd: "/x", session: "A" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(lifecycleAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A"], busySessionIds: [] } });
      await flush();
    });
    await settleQueryNotifications();
    expect(screen.getByLabelText("Change model").textContent).toContain("Latest persisted model");
    expect(screen.getByText("26%")).toBeTruthy();
    expect(screen.getByLabelText("Session info").title).toContain("Estimated context for selected model: 26.4%");
    for (const type of ["attach", "activate", "read", "command"]) expect(countType(ws, type)).toBe(0);
    rerender({ cwd: "/x", session: "B" });
    await settleQueryNotifications();
    expect(screen.getByText("0%")).toBeTruthy();
    expect(screen.queryByText("26%")).toBeNull();
    rerender({ cwd: "/x", session: "A" });
    await settleQueryNotifications();
    expect(screen.getByText("26%")).toBeTruthy();
    for (const type of ["attach", "activate", "read", "command"]) expect(countType(ws, type)).toBe(0);
  });

  it("keeps pending model intent through automatic observation without showing another model's usage, then follows accepted context events", async () => {
    mountApp({ cwd: "/x", session: "A" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(lifecycleAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A"], busySessionIds: [] } });
      await flush();
    });
    await settleQueryNotifications();
    await pickModel("Pending model");
    expect(screen.getByText("13%")).toBeTruthy();
    expect(screen.getByLabelText("Session info").title).toContain("Estimated context for selected model");
    expect(countType(ws, "command")).toBe(0);
    expect(countType(ws, "attach")).toBe(0);
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 2, sessionIds: ["A"], busySessionIds: ["A"] } });
      const attach = await waitForAttach(ws, "A");
      expect(attach.payload).toMatchObject({ attachMode: "existing_only" });
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({
        sessionId: "A", model: { provider: "acme-gpt", id: "gpt-6-astra" },
        capabilities: LIVE_CAPS,
        contextUsage: { percent: 79.6358, tokens: 836_176, contextWindow: 1_050_000 },
      }) });
      await flush();
    });
    await settleQueryNotifications();
    expect(screen.getByLabelText("Change model").textContent).toContain("Pending model");
    expect(document.querySelector(".session-info-bar-donut")).toBeNull();
    expect(screen.queryByText("80%")).toBeNull();
    expect(countType(ws, "command")).toBe(0);
    const context = {
      model: { provider: "test", id: "pending" }, leafId: "A-next",
      contextUsage: { percent: 13.18555, tokens: 263_711, contextWindow: 2_000_000 },
    };
    await act(async () => {
      ws.serverSend({ type: "event", payload: { type: "runtime_state_changed", sessionId: "A", epoch: "e1", eventId: 1, context } });
      await flush();
    });
    expect(screen.getByText("13%")).toBeTruthy();
    await act(async () => {
      ws.serverSend({ type: "event", payload: { type: "runtime_state_changed", sessionId: "A", epoch: "e1", eventId: 2, context: { ...context, contextUsage: null } } });
      await flush();
      ws.serverSend({ type: "event", payload: { type: "runtime_state_changed", sessionId: "A", epoch: "e1", eventId: 1, context } });
      await flush();
    });
    expect(document.querySelector(".session-info-bar-donut")).toBeNull();
    expect(screen.queryByText("13%")).toBeNull();
  });
});

describe("Composer — staged activation controls across A→B (stable toolbar, honest baselines)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubContextSettings = {
      model: { provider: "anthropic", modelId: "claude-opus-4" },
      thinkingLevel: "off",
    };
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

    // Honest B baseline: exact JSONL branch settings from SessionContext —
    // never A's runtime state and never the Host catalog default/first entry.
    expect(modelBtnB.textContent).toContain("Claude Opus 4");
    expect(modelBtnB.textContent).not.toContain("GPT-5");
    expect(thinkingBtnB.textContent).toContain("off");

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

  it("missing additive v2 settings stays unknown instead of falling back to catalog model/auto", async () => {
    stubContextSettings = undefined;
    mountApp({ cwd: "/x", session: "B" });
    const ws = await connectReady();
    await act(async () => {
      await flush(12);
      await vi.runOnlyPendingTimersAsync();
      await flush(12);
    });

    expect(screen.getByLabelText("Change model").textContent).toContain("Select a provider or model");
    expect(screen.getByLabelText("Change model").textContent).not.toContain("Claude Opus 4");
    expect(screen.queryByLabelText("Change reasoning level")).toBeNull();
    expect(countType(ws, "attach")).toBe(0);
    expect(countType(ws, "command")).toBe(0);
  });

  it("A/B staging stays independent across selection; live A never hides B's staged model", async () => {
    const { rerender } = mountApp({ cwd: "/x" });
    const ws = await connectReady();
    await mountLiveA(ws);
    await selectDetachedB(ws, rerender);
    await pickModel("Claude Sonnet 4");
    expect(screen.getByLabelText("Change model").textContent).toContain("Claude Sonnet 4");

    // Reporting B as live MUST NOT attach/take over. Returning to A then B
    // keeps B's independent staged model (never A's gpt-5 snapshot).
    const attachBefore = countType(ws, "attach");
    await act(async () => {
      ws.serverSend({
        type: "event",
        payload: { type: "running_sessions_changed", sessionId: "A", sessionIds: ["A", "B"], busySessionIds: [], eventId: 1, epoch: "e1" },
      });
      await flush();
    });
    expect(countType(ws, "attach")).toBe(attachBefore);
    expect(countType(ws, "detach")).toBe(0);
    rerender({ cwd: "/x", session: "A" });
    await act(async () => {
      await flush(20);
      vi.advanceTimersByTime(0);
      await flush(20);
    });
    expect(screen.getByLabelText("Change model").textContent).toContain("GPT-5");
    rerender({ cwd: "/x", session: "B" });
    await act(async () => {
      await flush(20);
      vi.advanceTimersByTime(0);
      await flush(20);
    });
    expect(screen.getByLabelText("Change model").textContent).toContain("Claude Sonnet 4");
    expect(screen.getByLabelText("Change model").textContent).not.toContain("GPT-5");
  });

  it("keeps already-held A while selected detail is fetching with no header; pending grants no new observe/send", async () => {
    const { ws, baselines } = await mountHeldAPendingDetail();
    expectHeldAPendingSurface();
    expect(countType(ws, "attach")).toBe(baselines.attach);
    expect(countType(ws, "activate")).toBe(baselines.activate);
    expect(countType(ws, "command")).toBe(baselines.command);
    expect(countType(ws, "stop")).toBe(0);
    expect(countType(ws, "detach")).toBe(baselines.detach);
  });

  it.each([
    {
      name: "history_only",
      resolve: () => json({
        session: {
          sessionId: "A",
          cwd: "/x",
          projectRoot: "/x",
          workspaceAccess: { state: "history_only", reason: "outside_allowed_roots" },
        },
      }),
    },
    {
      name: "missing workspaceAccess",
      resolve: () => json({ session: { sessionId: "A", cwd: "/x", projectRoot: "/x" } }),
    },
    {
      name: "HTTP 404",
      resolve: () => jsonStatus({ error: "gone", code: "SESSION_NOT_FOUND", message: "not found" }, 404),
    },
  ] as const)("resolved $name while held A is pending releases once without stop", async ({ resolve }) => {
    const { ws, pending, queryClient, baselines } = await mountHeldAPendingDetail();
    expect(queryClient.getQueryData(queryKeys.sessions.detail("A"))).toBeUndefined();
    await act(async () => {
      pending.deferred.resolve(resolve());
      await flush(12);
      vi.advanceTimersByTime(0);
      await flush(12);
    });
    await settleQueryNotifications();
    await expectReleasedHeldA(ws, baselines);
  });

  it("fresh unknown A does not attach while HTTP access is still unresolved", async () => {
    const deferred = createDeferred<Response>();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/v1/gate/status")) return json({ status: "enabled", required: false, authenticated: false, mode: "local" });
      if (path.includes("/v1/sessions/A") && path.includes("/context")) {
        return json({ context: { sessionId: "A", entries: [], pageInfo: { hasMore: false } } });
      }
      if (path.match(/\/v1\/sessions\/A(?:\?.*)?$/)) return deferred.promise;
      if (path.includes("/v1/sessions")) return json({ sessions: [], page: 1, pageSize: 50, total: 0, totalPages: 0, catalogRevision: 0 });
      if (path.includes("/v1/projects")) return json({ projects: [], page: 1, pageSize: 10, total: 0, totalPages: 0, catalogRevision: 0 });
      if (path.includes("/v1/models")) return json(modelsCatalog);
      return json({});
    }) as unknown as typeof fetch;
    mountApp({ cwd: "/x", session: "A" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(lifecycleAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A"], busySessionIds: ["A"] } });
      await flush();
    });
    expect(lastFrame(ws, "attach")).toBeUndefined();
    expect(countType(ws, "stop")).toBe(0);
    expect((screen.getByLabelText("Send message") as HTMLButtonElement).disabled).toBe(true);
    deferred.resolve(json({ session: { sessionId: "A", cwd: "/x", projectRoot: "/x" } }));
    await act(async () => { await flush(); vi.advanceTimersByTime(0); await flush(); });
    expect(lastFrame(ws, "attach")).toBeUndefined();
  });

  it("global gate revoke while A detail is still pending releases the held observer", async () => {
    const { ws, queryClient, baselines, pending } = await mountHeldAPendingDetail();
    expect(pending.deferred.promise).toBeDefined();
    expect(queryClient.getQueryState(queryKeys.sessions.detail("A"))?.fetchStatus).toBe("fetching");
    await act(async () => {
      queryClient.setQueryData(queryKeys.gate.status(), { status: "enabled", required: true, authenticated: false, mode: "local" });
      vi.advanceTimersByTime(0);
      await flush();
    });
    expect(queryClient.getQueryState(queryKeys.sessions.detail("A"))?.fetchStatus).toBe("fetching");
    await expectReleasedHeldA(ws, baselines);
  });

  it("agent capability loss while A detail is still pending releases without stop", async () => {
    const { ws, rerender, queryClient, baselines } = await mountHeldAPendingDetail();
    rerender({ cwd: "/x", session: "A" }, { capabilities: ["sessions", "files", "models"] });
    await settleQueryNotifications();
    expect(queryClient.getQueryState(queryKeys.sessions.detail("A"))?.fetchStatus).toBe("fetching");
    await expectReleasedHeldA(ws, baselines);
  });

  it("observe-feature true→false while A detail is still pending drops the local observer without stop", async () => {
    const { ws, queryClient, baselines } = await mountHeldAPendingDetail(lifecycleAck(), observeExistingA);
    expect(capturedStore!.registry.leaseSnapshot.holderSessionId).toBe("A");
    expect(lastFrame<{ type: "attach"; payload?: { attachMode?: string } }>(ws, "attach")?.payload?.attachMode).toBe("existing_only");
    await act(async () => {
      ws.serverClose(1006, "feature loss");
      await flush();
      vi.advanceTimersByTime(250);
      await flush();
    });
    const next = SOCKETS.at(-1)!;
    expect(next).not.toBe(ws);
    await act(async () => {
      if (next.readyState !== 1) next.serverOpen();
      next.serverSend(watchAck());
      await flush();
    });
    const detach = lastFrame<{ type: "detach"; id: string; payload: { sessionId: string } }>(next, "detach")
      ?? lastFrame<{ type: "detach"; id: string; payload: { sessionId: string } }>(ws, "detach");
    if (detach) {
      await act(async () => {
        const ack = { type: "response", id: detach.id, payload: { ok: true, result: { sessionId: "A", detached: true } } };
        next.serverSend(ack);
        ws.serverSend(ack);
        await flush();
      });
    }
    await settleQueryNotifications();
    expect(queryClient.getQueryState(queryKeys.sessions.detail("A"))?.fetchStatus).toBe("fetching");
    expect(queryClient.getQueryData(queryKeys.sessions.detail("A"))).toBeUndefined();
    expect(capturedStore!.registry.peek("A")?.getSnapshot().attached).toBe(false);
    expect(capturedStore!.registry.leaseSnapshot).toMatchObject({
      phase: "vacant",
      holderSessionId: null,
      desiredSessionId: null,
    });
    expect(countType(ws, "stop") + countType(next, "stop")).toBe(0);
    expect(countType(next, "activate")).toBe(0);
    expect(countType(next, "create")).toBe(0);
    expect(next.sent.filter((frame) => (frame as { type?: string }).type === "submit_turn")).toHaveLength(0);
    expect(countType(ws, "attach")).toBe(baselines.attach);
    const nextAttaches = next.sent.filter((frame) => (frame as { type?: string }).type === "attach") as Array<{ payload?: { sessionId?: string; attachMode?: string } }>;
    for (const frame of nextAttaches) {
      expect(frame.payload?.sessionId).toBe("A");
      expect(frame.payload?.attachMode).toBe("existing_only");
    }
    // Missing observe-existing must not keep/reacquire a lease. A same-socket
    // resume attach (if any) is existing_only and must already have been
    // released by feature-loss settlement above.
    expect(capturedStore!.registry.leaseSnapshot.phase).toBe("vacant");
    expect(capturedStore!.registry.leaseSnapshot.holderSessionId).toBeNull();
    expect(capturedStore!.registry.leaseSnapshot.desiredSessionId).toBeNull();
    expect(capturedStore!.registry.peek("A")?.getSnapshot().attached).toBe(false);
  });

  it("a pending prompt owned by live A never leaks the running composer state into detached B", async () => {
    const { rerender } = mountApp({ cwd: "/x", session: "A" });
    const ws = await connectReady();
    await mountLiveA(ws);

    const textarea = document.querySelector<HTMLTextAreaElement>(".chat-input-textarea")!;
    await act(async () => { fireEvent.change(textarea, { target: { value: "running on A" } }); await flush(); });
    await act(async () => { fireEvent.click(screen.getByLabelText("Send message")); await flush(); });
    const promptCmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string } } }>(ws, "command")!;
    expect(promptCmd.payload.command.type).toBe("prompt");
    expect(capturedStore!.getSnapshot().promptPending).toBe(true);
    expect(capturedStore!.getSnapshot().optimisticRunningSessionId).toBe("A");
    expect(screen.getByLabelText("Stop agent")).toBeTruthy();

    // B is read-only while A remains the retained background subscription. The
    // global transaction still exists, but only its owner A may render running.
    await selectDetachedB(ws, rerender);
    expect(capturedStore!.getSnapshot().promptPending).toBe(true);
    expect(capturedStore!.getSnapshot().optimisticRunningSessionId).toBe("A");
    expect(screen.queryByLabelText("Stop agent")).toBeNull();
    expect(screen.getByLabelText("Send message")).toBeTruthy();

    // Returning to the owner session restores its still-pending running state.
    rerender({ cwd: "/x", session: "A" });
    await act(async () => { await flush(); });
    expect(screen.getByLabelText("Stop agent")).toBeTruthy();

    await act(async () => {
      ws.serverSend({ type: "response", id: promptCmd.id, payload: { ok: true, result: { commandId: promptCmd.payload.command.commandId, result: { ok: true, type: "prompt" } } } });
      await flush();
    });
    expect(capturedStore!.getSnapshot().promptPending).toBe(false);
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
    // Facade is now exact-target scoped during the transfer; it never borrows
    // A's snapshot under B (B has no snapshot until its attach lands).
    expect(capturedStore!.getSnapshot().snapshot?.state.isPromptRunning).not.toBe(true);

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
    // The staged settings refresh the authoritative snapshot so the selectors
    // reflect what was just applied (getSnapshot envelope answered here).
    const getSnap = lastFrame<{ type: string; id: string }>(ws, "getSnapshot")!;
    expect(getSnap).toBeTruthy();
    await act(async () => {
      ws.serverSend({ type: "response", id: getSnap.id, payload: { ok: true, result: snapshotPayload({ sessionId: "B" }).snapshot } });
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

  it("definite/activation failure and uncertain delivery preserve staged model/thinking", async () => {
    const { rerender } = mountApp({ cwd: "/x" });
    const ws = await connectReady();
    await mountLiveA(ws);
    await selectDetachedB(ws, rerender);
    await pickModel("Claude Sonnet 4");
    await pickThinking("high");
    const textarea = document.querySelector<HTMLTextAreaElement>(".chat-input-textarea")!;
    await act(async () => { fireEvent.change(textarea, { target: { value: "will fail" } }); await flush(); });
    await act(async () => { fireEvent.click(screen.getByLabelText("Send message")); await flush(); });
    await ackBackgroundDetach(ws);
    const attach = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    expect(attach.payload.sessionId).toBe("B");
    await act(async () => {
      ws.serverSend({ type: "response", id: attach.id, payload: { ok: false, error: { code: "not_found", message: "no such session", retryable: false } } });
      await flush();
    });
    expect(screen.getByLabelText("Change model").textContent).toContain("Claude Sonnet 4");
    expect(screen.getByLabelText("Change reasoning level").textContent).toContain("high");
    expect(textarea.value).toBe("will fail");
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
    // A successful live control write must converge the SELECTOR through the
    // authoritative snapshot — not merely put the desired model on the wire.
    const modelSnapshot = lastFrame<{ type: string; id: string }>(ws, "getSnapshot")!;
    await act(async () => {
      ws.serverSend({ type: "response", id: modelSnapshot.id, payload: { ok: true, result: snapshotPayload({ sessionId: "A", model: { provider: "anthropic", id: "claude-sonnet-4" }, capabilities: LIVE_CAPS }).snapshot } });
      await flush();
    });
    expect(screen.getByLabelText("Change model").textContent).toContain("Claude Sonnet 4");
    expect(screen.getByLabelText("Change model").textContent).not.toContain("GPT-5");
    await pickThinking("high");
    const thinkingCmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; level: string } } }>(ws, "command")!;
    expect(thinkingCmd.payload.command.type).toBe("set_thinking_level");
    expect(thinkingCmd.payload.command.level).toBe("high");
    await act(async () => {
      ws.serverSend({ type: "response", id: thinkingCmd.id, payload: { ok: true, result: { commandId: thinkingCmd.payload.command.commandId, result: { ok: true, type: "set_thinking_level" } } } });
      await flush();
    });
    const thinkingSnapshot = lastFrame<{ type: string; id: string }>(ws, "getSnapshot")!;
    await act(async () => {
      ws.serverSend({ type: "response", id: thinkingSnapshot.id, payload: { ok: true, result: snapshotPayload({ sessionId: "A", model: { provider: "anthropic", id: "claude-sonnet-4" }, thinkingLevel: "high", capabilities: LIVE_CAPS }).snapshot } });
      await flush();
    });
    expect(screen.getByLabelText("Change reasoning level").textContent).toContain("high");
    // No prompt was sent by the control interactions alone.
    expect(ws.sent.some((f) => (f as { payload?: { command?: { type?: string } } }).payload?.command?.type === "prompt")).toBe(false);
  });
});

// --- negotiated runtime.submit-turn.v1: atomic model carry + admitted bridge ---
// The model displayed IMMEDIATELY BEFORE Send rides the SAME atomic
// submit_turn.activationOverrides.model (staged choice, detached history
// default, home catalog default, or known live authority baseline) — never a
// side-channel set_model+prompt — and stays visible through admission and the
// post-admission observation attach (admitted bridge) until runtime authority
// replaces it. Older/newer submissions and other sessions never clobber each
// other (record identity fence + exact per-session keys).
interface SubmitTurnFrame {
  type: "submit_turn";
  id: string;
  payload: {
    sessionId: string;
    prompt: string;
    operationId: string;
    activationOverrides?: { model?: { provider: string; modelId: string }; thinkingLevel?: string };
    expectedEpoch?: string;
    expectedRevision?: number;
  };
}

function lastSubmitTurn(ws: FakeWebSocket): SubmitTurnFrame {
  const frame = lastFrame<SubmitTurnFrame>(ws, "submit_turn");
  if (!frame) throw new Error("no submit_turn frame was sent");
  return frame;
}

async function acceptSubmitTurn(
  ws: FakeWebSocket,
  options: { sessionId: string; epoch?: string; model?: { provider: string; id: string } | null },
): Promise<SubmitTurnFrame> {
  const submit = lastSubmitTurn(ws);
  const epoch = options.epoch ?? "e1";
  const turnId = `turn-${options.sessionId}`;
  await act(async () => {
    ws.serverSend({
      type: "submit_turn_result",
      id: submit.id,
      payload: {
        status: "accepted",
        delivery: "accepted",
        sessionId: options.sessionId,
        epoch,
        revision: 5,
        operationId: submit.payload.operationId,
        turnId,
        snapshot: snapshotPayload({ sessionId: options.sessionId, epoch, model: options.model === undefined ? null : options.model, capabilities: LIVE_CAPS }).snapshot,
        turnStatus: { sessionId: options.sessionId, epoch, operationId: submit.payload.operationId, turnId, revision: 0, state: "admitted" },
      },
    });
    await flush();
  });
  return submit;
}

async function rejectSubmitTurn(
  ws: FakeWebSocket,
  options: { sessionId: string; delivery: "not_delivered" | "uncertain" },
): Promise<void> {
  const submit = lastSubmitTurn(ws);
  await act(async () => {
    ws.serverSend({
      type: "submit_turn_result",
      id: submit.id,
      payload: {
        status: "rejected",
        delivery: options.delivery,
        sessionId: options.sessionId,
        operationId: submit.payload.operationId,
        error: {
          code: options.delivery === "not_delivered" ? "session_busy" : "unavailable",
          message: options.delivery === "not_delivered" ? "session busy" : "transport lost",
          retryable: options.delivery === "uncertain",
        },
      },
    });
    await flush();
  });
}

/** Complete the post-admission observation transfer (detach old holder → existing_only attach target). */
async function settlePostAdmissionObservation(
  ws: FakeWebSocket,
  sessionId: string,
  model: { provider: string; id: string } | null,
): Promise<void> {
  const detach = lastFrame<{ type: "detach"; id: string; payload: { sessionId: string } }>(ws, "detach");
  if (detach) {
    await act(async () => {
      ws.serverSend({ type: "response", id: detach.id, payload: { ok: true, result: { sessionId: detach.payload.sessionId, detached: true } } });
      await flush();
    });
  }
  const attach = await waitForAttach(ws, sessionId);
  expect((attach as { payload?: { attachMode?: string } }).payload?.attachMode).toBe("existing_only");
  await act(async () => {
    ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId, model, capabilities: LIVE_CAPS }) });
    await flush();
  });
}

function composerTextarea(): HTMLTextAreaElement {
  return document.querySelector<HTMLTextAreaElement>(".chat-input-textarea")!;
}

async function typeAndSend(text: string): Promise<void> {
  const textarea = composerTextarea();
  await act(async () => { fireEvent.change(textarea, { target: { value: text } }); await flush(); });
  await act(async () => { fireEvent.click(screen.getByLabelText("Send message")); await flush(); });
}

describe("Composer — negotiated runtime.submit-turn.v1 atomic model carry", () => {
  /** Flippable branch-resolved settings the /context stub reports for every session. */
  let negotiatedHistorySettings: { model: { provider: string; modelId: string }; thinkingLevel: "off" } = {
    model: { provider: "deepseek-official", modelId: "deepseek-v4-flash" },
    thinkingLevel: "off",
  };
  beforeEach(() => {
    vi.useFakeTimers();
    SOCKETS.length = 0;
    capturedStore = null;
    navigateMock.mockReset();
    previousFetch = globalThis.fetch;
    negotiatedHistorySettings = { model: { provider: "deepseek-official", modelId: "deepseek-v4-flash" }, thinkingLevel: "off" };
    modelsCatalog = {
      models: [
        { provider: "acme-gpt", id: "gpt-6-astra", displayName: "Old runtime model", contextWindow: 1_050_000 },
        { provider: "deepseek-official", id: "deepseek-v4-flash", displayName: "Latest persisted model", contextWindow: 1_000_000 },
        { provider: "test", id: "pending", displayName: "Pending model", contextWindow: 2_000_000 },
      ],
      defaultModel: null,
    };
    const baseline = stubFetch();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/context")) {
        const id = decodeURIComponent(path.split("/v1/sessions/")[1]!.split("/")[0]!);
        return json({ context: {
          sessionId: id,
          leafId: `${id}-latest`,
          entries: [],
          settings: negotiatedHistorySettings,
          contextTokens: 0,
          pageInfo: { hasMore: false },
        } });
      }
      return baseline(input, init);
    }) as unknown as typeof fetch;
  });
  afterEach(() => { cleanup(); globalThis.fetch = previousFetch; window.localStorage.removeItem("pi-drafts"); vi.useRealTimers(); });

  it("detached history default: submit frame carries the displayed model A even for a reused worker B; display holds through admission and post-admission attach", async () => {
    const { rerender } = mountApp({ cwd: "/x" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(submitTurnAck());
    await mountLiveA(ws);
    await selectDetachedB(ws, rerender);
    // Detached B displays the branch-resolved JSONL model (deepseek), never
    // the attached A runtime or any catalog guess.
    expect(screen.getByLabelText("Change model").textContent).toContain("Latest persisted model");

    const attachBefore = countType(ws, "attach");
    const commandBefore = countType(ws, "command");
    await typeAndSend("hello default");

    // The submit frame carries the DISPLAYED model atomically — no pre-attach,
    // no side-channel set_model, even though the reused worker runs gpt-6-astra.
    const submit = lastSubmitTurn(ws);
    expect(submit.payload.sessionId).toBe("B");
    expect(submit.payload.prompt).toBe("hello default");
    expect(submit.payload.activationOverrides?.model).toEqual({ provider: "deepseek-official", modelId: "deepseek-v4-flash" });
    expect(countType(ws, "attach")).toBe(attachBefore);
    expect(countType(ws, "command")).toBe(commandBefore);

    // Admission accepted with the post-override authority snapshot: the
    // display must still show A before the observation attach settles.
    await acceptSubmitTurn(ws, { sessionId: "B", epoch: "eB", model: { provider: "deepseek-official", id: "deepseek-v4-flash" } });
    expect(countType(ws, "command")).toBe(commandBefore);
    expect(screen.getByLabelText("Change model").textContent).toContain("Latest persisted model");

    // Post-admission observation attach replaces the bridge with live authority (same model).
    await settlePostAdmissionObservation(ws, "B", { provider: "deepseek-official", id: "deepseek-v4-flash" });
    expect(capturedStore!.getSnapshot().sessionId).toBe("B");
    expect(capturedStore!.getSnapshot().attached).toBe(true);
    expect(screen.getByLabelText("Change model").textContent).toContain("Latest persisted model");
    expect(screen.getByLabelText("Change model").textContent).not.toContain("Old runtime model");
    // No set_model/prompt command was ever issued: the model rode the atomic submit.
    expect(countType(ws, "command")).toBe(commandBefore);
  });

  it("staged model with a different persisted baseline: no transient flip to the persisted model between admission and attach", async () => {
    const { rerender } = mountApp({ cwd: "/x" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(submitTurnAck());
    await mountLiveA(ws);
    await selectDetachedB(ws, rerender);
    await pickModel("Pending model");
    expect(screen.getByLabelText("Change model").textContent).toContain("Pending model");

    await typeAndSend("hello staged");
    const submit = lastSubmitTurn(ws);
    expect(submit.payload.activationOverrides?.model).toEqual({ provider: "test", modelId: "pending" });

    await acceptSubmitTurn(ws, { sessionId: "B", epoch: "eB", model: { provider: "test", id: "pending" } });
    // BRIDGE WINDOW: staging is consumed by the admission, the observation
    // attach has NOT settled — the persisted deepseek baseline must not leak in.
    expect(screen.getByLabelText("Change model").textContent).toContain("Pending model");
    expect(screen.getByLabelText("Change model").textContent).not.toContain("Latest persisted model");

    await settlePostAdmissionObservation(ws, "B", { provider: "test", id: "pending" });
    expect(screen.getByLabelText("Change model").textContent).toContain("Pending model");
    expect(screen.getByLabelText("Change model").textContent).not.toContain("Latest persisted model");
  });

  it("home catalog default is captured on the first submit of a brand-new session", async () => {
    modelsCatalog = {
      models: [
        { provider: "acme-gpt", id: "gpt-6-astra", displayName: "Old runtime model", contextWindow: 1_050_000 },
        { provider: "deepseek-official", id: "deepseek-v4-flash", displayName: "Latest persisted model", contextWindow: 1_000_000 },
      ],
      defaultModel: { provider: "acme-gpt", id: "gpt-6-astra" },
    };
    mountApp({ cwd: "/x" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(submitTurnAck());
    await act(async () => { await flush(12); vi.advanceTimersByTime(0); await flush(12); });
    expect(screen.getByLabelText("Change model").textContent).toContain("Old runtime model");

    await typeAndSend("first home prompt");
    const create = lastFrame<{ type: "create"; id: string; payload: { cwd: string } }>(ws, "create")!;
    expect(create.payload.cwd).toBe("/x");
    await act(async () => {
      ws.serverSend({
        type: "response",
        id: create.id,
        payload: { ok: true, result: { sessionId: "home-1", epoch: "eH", lastEventId: 0, created: true, cwd: "/x", projectRoot: "/x" } },
      });
      await flush(8);
    });

    // The created session's first submit carries the HOME DISPLAYED default.
    const submit = lastSubmitTurn(ws);
    expect(submit.payload.sessionId).toBe("home-1");
    expect(submit.payload.activationOverrides?.model).toEqual({ provider: "acme-gpt", modelId: "gpt-6-astra" });
    await acceptSubmitTurn(ws, { sessionId: "home-1", epoch: "eH", model: { provider: "acme-gpt", id: "gpt-6-astra" } });
    // No attach/activate was needed for admission (post-admission observation
    // is presentation-gated; the frame assertions above are the contract).
    expect(countType(ws, "activate")).toBe(0);
  });

  it("live known model is captured on the submit even when an external model update interleaves before admission", async () => {
    mountApp({ cwd: "/x", session: "A" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(submitTurnAck());
    await mountLiveA(ws);
    expect(screen.getByLabelText("Change model").textContent).toContain("gpt-5");

    await typeAndSend("live baseline");
    const submit = lastSubmitTurn(ws);
    expect(submit.payload.sessionId).toBe("A");
    // Known live authority baseline carried — not only an explicit staged choice.
    expect(submit.payload.activationOverrides?.model).toEqual({ provider: "openai", modelId: "gpt-5" });

    // An external model update lands AFTER the frame was dispatched.
    await act(async () => {
      ws.serverSend({
        type: "event",
        payload: {
          type: "runtime_state_changed",
          sessionId: "A",
          epoch: "e1",
          eventId: 3,
          context: { model: { provider: "test", id: "pending" }, leafId: null, contextUsage: null },
        },
      });
      await flush();
    });
    // The already-dispatched submission is immutable: it carried gpt-5.
    expect(submit.payload.activationOverrides?.model).toEqual({ provider: "openai", modelId: "gpt-5" });
    // Admission (revision past the external event) restores the submitted model as authority.
    await acceptSubmitTurn(ws, { sessionId: "A", epoch: "e1", model: { provider: "openai", id: "gpt-5" } });
    expect(screen.getByLabelText("Change model").textContent).toContain("gpt-5");
    expect(screen.getByLabelText("Change model").textContent).not.toContain("Pending model");
  });

  it("one-tab A→B→A: distinct drafts/models, delayed ACCEPTED admission of A never pollutes B", async () => {
    const { rerender } = mountApp({ cwd: "/x" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(submitTurnAck());
    await mountLiveA(ws);
    await selectDetachedB(ws, rerender);
    await pickModel("Pending model");
    await act(async () => { fireEvent.change(composerTextarea(), { target: { value: "b-draft" } }); await flush(); });

    // Back to A: its own (empty) draft and the live runtime model.
    rerender({ cwd: "/x", session: "A" });
    await act(async () => { await flush(12); vi.advanceTimersByTime(0); await flush(12); });
    expect(screen.getByLabelText("Change model").textContent).toContain("gpt-5");
    expect(composerTextarea().value).toBe("");
    await typeAndSend("a-message");
    const submit = lastSubmitTurn(ws);
    expect(submit.payload.sessionId).toBe("A");

    // While A's admission is DELAYED, B keeps its own staged model + draft.
    await selectDetachedB(ws, rerender);
    expect(screen.getByLabelText("Change model").textContent).toContain("Pending model");
    expect(composerTextarea().value).toBe("b-draft");

    // The delayed acceptance settles A only (exact key + revision fence).
    rerender({ cwd: "/x", session: "A" });
    await act(async () => { await flush(12); vi.advanceTimersByTime(0); await flush(12); });
    await acceptSubmitTurn(ws, { sessionId: "A", epoch: "e1", model: { provider: "openai", id: "gpt-5" } });
    expect(screen.getByLabelText("Change model").textContent).toContain("gpt-5");

    await selectDetachedB(ws, rerender);
    expect(screen.getByLabelText("Change model").textContent).toContain("Pending model");
    expect(screen.getByLabelText("Change model").textContent).not.toContain("gpt-5");
    expect(composerTextarea().value).toBe("b-draft");
  });

  it("delayed NOT-DELIVERED admission of A restores A's draft and preserves B's staged intent", async () => {
    const { rerender } = mountApp({ cwd: "/x" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(submitTurnAck());
    await mountLiveA(ws);
    await selectDetachedB(ws, rerender);
    await pickModel("Pending model");
    await act(async () => { fireEvent.change(composerTextarea(), { target: { value: "b-own-draft" } }); await flush(); });
    rerender({ cwd: "/x", session: "A" });
    await act(async () => { await flush(12); vi.advanceTimersByTime(0); await flush(12); });
    await typeAndSend("a-message");

    await rejectSubmitTurn(ws, { sessionId: "A", delivery: "not_delivered" });
    // Proven non-delivery: A's draft is restored and surfaced as an error.
    expect(composerTextarea().value).toBe("a-message");
    expect(screen.getByRole("alert").textContent).toBeTruthy();
    await selectDetachedB(ws, rerender);
    expect(screen.getByLabelText("Change model").textContent).toContain("Pending model");
    expect(composerTextarea().value).toBe("b-own-draft");
  });

  it("delayed UNCERTAIN admission of A keeps the bubble and never touches B's staged intent", async () => {
    const { rerender } = mountApp({ cwd: "/x" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(submitTurnAck());
    await mountLiveA(ws);
    await selectDetachedB(ws, rerender);
    await pickModel("Pending model");
    await act(async () => { fireEvent.change(composerTextarea(), { target: { value: "b-uncertain" } }); await flush(); });
    rerender({ cwd: "/x", session: "A" });
    await act(async () => { await flush(12); vi.advanceTimersByTime(0); await flush(12); });
    await typeAndSend("a-message");

    await rejectSubmitTurn(ws, { sessionId: "A", delivery: "uncertain" });
    // Possible delivery: the optimistic bubble stays; no draft restore.
    expect(screen.getByText("a-message")).toBeTruthy();
    expect(composerTextarea().value).toBe("");
    await selectDetachedB(ws, rerender);
    expect(screen.getByLabelText("Change model").textContent).toContain("Pending model");
    expect(composerTextarea().value).toBe("b-uncertain");
  });

  it("an old admission ack never erases a NEWER staging — including a re-selected SAME value (A→B→A)", async () => {
    const { rerender } = mountApp({ cwd: "/x" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(submitTurnAck());
    await mountLiveA(ws);
    await selectDetachedB(ws, rerender);

    // Submitted generation: staged "Old runtime model".
    await pickModel("Old runtime model");
    await typeAndSend("staged then superseded");
    const submit = lastSubmitTurn(ws);
    expect(submit.payload.activationOverrides?.model).toEqual({ provider: "acme-gpt", modelId: "gpt-6-astra" });

    // Newer selection (distinct value) after the send.
    await pickModel("Pending model");
    // …then re-selected back to the SAME value the submission carried: a NEW
    // record generation, not value equality.
    await pickModel("Old runtime model");
    expect(screen.getByLabelText("Change model").textContent).toContain("Old runtime model");

    // The delayed ack for the submitted generation arrives.
    await acceptSubmitTurn(ws, { sessionId: "B", epoch: "eB", model: { provider: "acme-gpt", id: "gpt-6-astra" } });
    // The newer generation SURVIVES: display keeps the re-selected model and
    // never falls back to the persisted deepseek baseline.
    expect(screen.getByLabelText("Change model").textContent).toContain("Old runtime model");
    expect(screen.getByLabelText("Change model").textContent).not.toContain("Latest persisted model");
  });

  it("admitted snapshot eligibility is bounded: a presentation reselect browses the refreshed branch history, never the retained snapshot", async () => {
    const { rerender } = mountApp({ cwd: "/x" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(submitTurnAck());
    await mountLiveA(ws);
    await selectDetachedB(ws, rerender);
    await typeAndSend("detached send");
    const submit = lastSubmitTurn(ws);
    expect(submit.payload.activationOverrides?.model).toEqual({ provider: "deepseek-official", modelId: "deepseek-v4-flash" });
    // Accepted, but this tab's post-admission observation attach never settles
    // (the session stays detached here) — the exact controller's admitted
    // snapshot holds the display through the gap.
    await acceptSubmitTurn(ws, { sessionId: "B", epoch: "eB", model: { provider: "deepseek-official", id: "deepseek-v4-flash" } });
    expect(screen.getByLabelText("Change model").textContent).toContain("Latest persisted model");

    // Another tab advances the same session AND the user reselects B: the
    // admission's presentation is superseded, so history browsing shows the
    // refreshed branch truth — the retained admitted/worker snapshot must not
    // leak into the default history view or mask the external update.
    negotiatedHistorySettings = { model: { provider: "test", modelId: "pending" }, thinkingLevel: "off" };
    await act(async () => { await rerender({ cwd: "/x", session: "A" }); await flush(12); });
    await selectDetachedB(ws, rerender);
    expect(screen.getByLabelText("Change model").textContent).toContain("Pending model");
    expect(screen.getByLabelText("Change model").textContent).not.toContain("Latest persisted model");
  });

  it("a wrong-session settle never clears another session's staging (per-exact-key fence)", async () => {
    const { rerender } = mountApp({ cwd: "/x" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(submitTurnAck());
    await mountLiveA(ws);
    await selectDetachedB(ws, rerender);
    await pickModel("Pending model");
    rerender({ cwd: "/x", session: "A" });
    await act(async () => { await flush(12); vi.advanceTimersByTime(0); await flush(12); });
    await typeAndSend("a-message");

    // A's admission settles while B (with its own staging) is re-selected.
    await selectDetachedB(ws, rerender);
    await acceptSubmitTurn(ws, { sessionId: "A", epoch: "e1", model: { provider: "openai", id: "gpt-5" } });
    await act(async () => { await flush(12); vi.advanceTimersByTime(0); await flush(12); });
    expect(screen.getByLabelText("Change model").textContent).toContain("Pending model");
    expect(screen.getByLabelText("Change model").textContent).not.toContain("gpt-5");
  });
});

const PROJECT_SESSIONS: readonly SessionHeader[] = [
  ...SESSION_HEADERS,
  { sessionId: "D", cwd: "/y", projectRoot: "/y", title: "Session D", createdAt: 1000, updatedAt: Date.now(), messageCount: 1, workspaceAccess: AUTHORIZED },
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
      "sidebar-projects",
      "sidebar-sessions",
      "sidebar-nav-settings",
    ].filter((id) => document.querySelector(`[data-testid="${id}"]`));
  }

  const catalogCaps: HostInfo["capabilities"] = ["agent", "sessions", "files", "models", "plugins", "skills"];

  it("renders the source hierarchy: Pix, New Session, Projects, Sessions, Settings + pinned file browser", async () => {
    mountApp({ cwd: "/x" }, { capabilities: catalogCaps });
    await settle();
    expect(screen.getByTestId("sidebar-brand").textContent).toBe("Pix");
    expect(screen.getByTestId("sidebar-new-session").textContent).toContain("New Session");
    // The Plugins / Resources nav entries were removed; the Settings modal
    // tabs remain reachable from the footer Settings button.
    expect(screen.queryByTestId("sidebar-nav-plugins")).toBeNull();
    expect(screen.queryByTestId("sidebar-nav-resources")).toBeNull();
    expect(screen.getByTestId("sidebar-projects")).toBeTruthy();
    expect(screen.getByTestId("sidebar-sessions")).toBeTruthy();
    expect(screen.queryByTestId("sidebar-files")).toBeNull();
    expect(screen.getByTestId("sidebar-nav-settings").textContent).toBe("Settings");
    // The file browser toggle is pinned to the window's top-right; no rail strip.
    expect(screen.getByTestId("file-browser-toggle")).toBeTruthy();
    expect(screen.queryByTestId("file-browser-rail")).toBeNull();
    expect(railOrder()).toEqual([
      "sidebar-home-header",
      "sidebar-new-session",
      "sidebar-projects",
      "sidebar-sessions",
      "sidebar-nav-settings",
    ]);
  });

  it("opens a session context menu on touch long-press without selecting the row", async () => {
    mountApp({ cwd: "/x" }, { capabilities: catalogCaps });
    await settle();
    const row = screen.getByTestId("session-select-A").closest<HTMLElement>(".sidebar-list-row")!;
    fireEvent.pointerDown(row, { pointerId: 7, pointerType: "touch", clientX: 40, clientY: 80 });
    act(() => { vi.advanceTimersByTime(519); });
    expect(screen.queryByRole("menu")).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    await settle();
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Archive" })).toBeTruthy();
    fireEvent.pointerUp(row, { pointerId: 7, pointerType: "touch" });
    // The compatibility mousedown emitted after touchend must not dismiss the
    // menu that the long-press gesture just opened.
    fireEvent.mouseDown(row);
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("maps Settings onto the existing SettingsModal tabs and invents no counts", async () => {
    mountApp({ cwd: "/x" }, { capabilities: catalogCaps });
    await settle();
    expect(screen.queryByTestId("nav-packages-badge")).toBeNull();
    expect(screen.queryByTestId("sidebar-update-btn")).toBeNull();
    expect(screen.queryByTestId("crash-host")).toBeNull();
    expect(screen.queryByTestId("stop-host")).toBeNull();
    expect(screen.queryByTestId("fork-thread")).toBeNull();

    fireEvent.click(screen.getByTestId("sidebar-nav-settings"));
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog).toBeTruthy();
    expect(dialog.querySelector('[aria-current="page"]')?.textContent).toBe("Display");
    expect(screen.getByTestId("settings-tab-archive")).toBeTruthy();
  });

  it("browses the global Models catalog without a selected Project or cwd query", async () => {
    modelsCatalog = {
      models: [{ id: "global-model", provider: "configured-provider", displayName: "Global Model" }],
      defaultModel: { id: "global-model", provider: "configured-provider" },
    };
    const fetchImpl = controllableStubFetch({ sessions: [] });
    globalThis.fetch = fetchImpl;
    mountApp({}, { capabilities: ["models"] });
    await settle();
    fireEvent.click(screen.getByTestId("sidebar-nav-settings"));
    fireEvent.click(screen.getByTestId("settings-tab-models"));
    await settle();
    expect(screen.getByText("Global Model")).toBeTruthy();
    expect(screen.queryByText(/Open a project to browse/i)).toBeNull();
    const modelUrls = (fetchImpl as typeof fetch & {
      mock: { calls: Array<[RequestInfo | URL, RequestInit?]> };
    }).mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes("/v1/models"));
    expect(modelUrls.length).toBeGreaterThan(0);
    expect(modelUrls.every((url) => url === "/v1/models")).toBe(true);
  });

  it("restores an archived session from the settings archive tab", async () => {
    mountApp({ cwd: "/x" }, { capabilities: catalogCaps });
    await settle();
    const sessionRow = screen.getByTestId("session-select-A").closest(".sidebar-list-row") as HTMLElement;
    fireEvent.click(within(sessionRow).getByLabelText("Archive"));
    expect(screen.queryByTestId("session-select-A")).toBeNull();
    fireEvent.click(screen.getByTestId("sidebar-nav-settings"));
    fireEvent.click(screen.getByTestId("settings-tab-archive"));
    await settle();
    expect(screen.getByTestId("archive-row")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(screen.getByTestId("session-select-A")).toBeTruthy();
  });

  it("does not reveal an archived subagent in Settings", async () => {
    const now = Date.now();
    window.localStorage.setItem("pi-sidebar-item-state", JSON.stringify({
      pinnedSessions: [],
      pinnedProjects: [],
      archivedSessions: ["child"],
      archivedProjects: [],
    }));
    globalThis.fetch = controllableStubFetch({
      sessions: [
        { sessionId: "parent", cwd: "/x", projectRoot: "/x", title: "Parent session", createdAt: 1000, updatedAt: now, messageCount: 1, workspaceAccess: AUTHORIZED },
        { sessionId: "child", cwd: "/x", projectRoot: "/x", title: "Hidden child", parentSessionId: "parent", createdAt: 1000, updatedAt: now + 1, messageCount: 1, workspaceAccess: AUTHORIZED },
      ],
    });
    mountApp({ cwd: "/x" }, { capabilities: catalogCaps });
    await settle();
    fireEvent.click(screen.getByTestId("sidebar-nav-settings"));
    fireEvent.click(screen.getByTestId("settings-tab-archive"));
    await settle();
    expect(screen.queryByText("Hidden child")).toBeNull();
    expect(screen.getByTestId("archive-empty-sessions")).toBeTruthy();
  });

  it("New Session opens a transient draft without creating a worker", async () => {
    const view = mountApp({ cwd: "/x", session: "A" }, { capabilities: catalogCaps });
    navigateMock.mockImplementation(async (options: { search: WorkspaceSearch }) => {
      view.rerender(options.search);
      await flush();
    });
    const ws = await connectReady();
    await settle();
    await act(async () => {
      // Direct navigation to the empty new-session page (the removed sidebar /
      // title-bar buttons targeted the same route).
      view.rerender({});
      await flush();
    });
    expect(lastFrame(ws, "create")).toBeUndefined();
    // The new-session page defaults to an EMPTY project folder — no cwd is carried over.
    expect(screen.getByTestId("home-stack")).toBeTruthy();
  });

  it("promotes B only after its first prompt transaction owns the command slot", async () => {
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS });
    const view = mountApp({ cwd: "/x", session: "A" });
    const invalidateSpy = vi.spyOn(view.queryClient, "invalidateQueries");
    navigateMock.mockImplementation(async (options: { search: WorkspaceSearch }) => {
      view.rerender(options.search);
      await flush();
    });
    const ws = await connectReady();
    await mountLiveA(ws);
    await settle();

    // New-session page (transient draft): no worker/ID until the first submit.
    view.rerender({});
    await act(async () => { await flush(); });
    expect(lastFrame(ws, "create")).toBeUndefined();
    expect(screen.getByTestId("home-stack")).toBeTruthy();
    // The new-session page defaults to an EMPTY project folder — the user picks the
    // project in the composer dropdown before the first prompt.
    fireEvent.click(screen.getByLabelText("Select project"));
    await act(async () => { await flush(); });
    fireEvent.click(screen.getByRole("button", { name: /\/x/ }));
    await act(async () => { await flush(); });

    const textarea = document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "first after button" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    await act(async () => { await flush(8); });
    expect(SOCKETS).toHaveLength(1);
    expect(SOCKETS[0]).toBe(ws);
    const create = lastFrame<{ type: string; id: string }>(ws, "create")!;
    expect(create).toBeTruthy();

    await act(async () => {
      ws.serverSend({
        type: "response",
        id: create.id,
        payload: { ok: true, result: { sessionId: "new-button", epoch: "e1", created: true, cwd: "/x", projectRoot: "/x", snapshot: snapshotPayload({ sessionId: "new-button" }).snapshot } },
      });
      await flush();
      // Identity-only create → B's first legacy send activates it through the
      // transitionTo path, which detaches the attached A FIRST.
      const detach = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "detach")!;
      expect(detach.payload.sessionId).toBe("A");
      ws.serverSend({ type: "response", id: detach.id, payload: { ok: true, result: { sessionId: "A", detached: true } } });
      await flush();
      const attach = await waitForAttach(ws, "new-button");
      expect(attach.payload?.sessionId).toBe("new-button");
      ws.serverSend({
        type: "snapshot",
        id: attach.id,
        payload: snapshotPayload({
          sessionId: "new-button",
          capabilities: ["runtime.prompt", "runtime.abort", "runtime.stats", "runtime.tools.read"],
        }),
      });
      await flush(12);
    });

    // Production capabilities start stats/tools reads after attach. The prompt
    // transaction must already own the ordinary slot before B is promoted, so
    // these auxiliary reads cannot steal the first Enter.
    const commands = ws.sent.filter((frame) => (frame as { type?: string }).type === "command") as Array<{ id: string; payload: { sessionId: string; command: { commandId: string; type: string; message?: string } } }>;
    expect(commands).toHaveLength(1);
    const prompt = commands[0]!;
    expect(prompt.payload.sessionId).toBe("new-button");
    expect(prompt.payload.command.type).toBe("prompt");
    expect(prompt.payload.command.message).toBe("first after button");
    expect(navigateMock).toHaveBeenLastCalledWith({ to: "/", search: { cwd: "/x", session: "new-button" } });
    expect(screen.queryByTestId("session-select-new-button")).toBeNull();
    expect(view.queryClient.getQueryData(queryKeys.sessions.detail("new-button"))).toBeTruthy();
    // The create-time invalidation was intentionally removed: JSONL is not
    // catalog-visible yet. Prompt settlement owns the sidebar refresh.
    invalidateSpy.mockClear();
    await act(async () => {
      ws.serverSend({ type: "response", id: prompt.id, payload: { ok: true, result: { commandId: prompt.payload.command.commandId, result: { ok: true, type: "prompt" } } } });
      await flush(4);
    });
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some(([input]) => String(input).includes("/v1/sessions/new-button"))).toBe(true);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.sessions.lists });
  });

  it("first prompt on transient B supersedes an in-flight A prompt without session_busy", async () => {
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS });
    const view = mountApp({ cwd: "/x", session: "A" });
    navigateMock.mockImplementation(async (options: { search: WorkspaceSearch }) => {
      view.rerender(options.search);
      await flush();
    });
    const ws = await connectReady();
    await mountLiveA(ws);

    // A owns the old ordinary command slot when the user starts a new draft.
    const aInput = document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement;
    fireEvent.change(aInput, { target: { value: "still running on A" } });
    fireEvent.keyDown(aInput, { key: "Enter", shiftKey: false });
    await act(async () => { await flush(4); });
    const firstPrompt = ws.sent.find((frame) => (frame as { payload?: { command?: { type?: string } } }).payload?.command?.type === "prompt") as { payload: { sessionId: string } };
    expect(firstPrompt.payload.sessionId).toBe("A");

    // New-session page (transient draft): navigate to the empty project folder.
    view.rerender({});
    await act(async () => { await flush(); });
    // The user picks /x in the composer's project dropdown before typing.
    fireEvent.click(screen.getByLabelText("Select project"));
    await act(async () => { await flush(); });
    fireEvent.click(screen.getByRole("button", { name: /\/x/ }));
    await act(async () => { await flush(); });
    const bInput = document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement;
    fireEvent.change(bInput, { target: { value: "first on B" } });
    fireEvent.keyDown(bInput, { key: "Enter", shiftKey: false });
    await act(async () => { await flush(6); });
    expect(SOCKETS).toHaveLength(1);
    expect(SOCKETS[0]).toBe(ws);
    const create = lastFrame<{ type: string; id: string }>(ws, "create")!;

    await act(async () => {
      ws.serverSend({
        type: "response",
        id: create.id,
        payload: { ok: true, result: { sessionId: "new-busy-b", epoch: "e2", created: true, cwd: "/x", projectRoot: "/x", snapshot: snapshotPayload({ sessionId: "new-busy-b" }).snapshot } },
      });
      await flush();
      // Identity-only create → B's first legacy send transitions: detach the
      // attached A (superseding its in-flight prompt), then attach B.
      const detach = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "detach")!;
      expect(detach.payload.sessionId).toBe("A");
      ws.serverSend({ type: "response", id: detach.id, payload: { ok: true, result: { sessionId: "A", detached: true } } });
      await flush();
      const attach = await waitForAttach(ws, "new-busy-b");
      expect(attach.payload?.sessionId).toBe("new-busy-b");
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "new-busy-b", epoch: "e2", capabilities: ["runtime.prompt", "runtime.abort", "runtime.stats", "runtime.tools.read"] }) });
      await flush(10);
    });

    const prompts = ws.sent.filter((frame) => (frame as { payload?: { command?: { type?: string } } }).payload?.command?.type === "prompt") as Array<{ payload: { sessionId: string; command: { message: string } } }>;
    expect(prompts.map((frame) => frame.payload.sessionId)).toEqual(["A", "new-busy-b"]);
    expect(prompts[1]!.payload.command.message).toBe("first on B");
  });

  it.each(["confirm", "Enter"])("selects a custom project absent from the catalog via %s and sends in that cwd", async (method) => {
    const cwd = "/Users/alice/Documents/program/demo-app";
    const view = mountApp({});
    navigateMock.mockImplementation(async (options: { search: WorkspaceSearch }) => {
      view.rerender(options.search);
      await flush();
    });
    const ws = await connectReady();
    await settle();

    const picker = () => screen.getByLabelText("Select project");
    expect(picker().textContent).toBe("Select project");
    fireEvent.click(picker());
    fireEvent.click(screen.getByRole("button", { name: "Custom path…" }));
    const input = screen.getByRole("textbox", { name: "Custom path…" });
    fireEvent.change(input, { target: { value: `  ${cwd}  ` } });
    if (method === "Enter") fireEvent.keyDown(input, { key: "Enter" });
    else fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await settle();

    expect(navigateMock).toHaveBeenLastCalledWith({ to: "/", search: { cwd } });
    expect(picker().textContent).toBe("demo-app");
    expect(picker().getAttribute("title")).toBe(cwd);
    expect(screen.queryByRole("textbox", { name: "Custom path…" })).toBeNull();
    expect(countType(ws, "create")).toBe(0);
    expect(countType(ws, "attach")).toBe(0);

    const textarea = document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "first in custom project" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    await act(async () => { await flush(8); });
    const create = lastFrame<{ type: string; payload: { cwd: string; projectRoot: string } }>(ws, "create");
    expect(create?.payload).toMatchObject({ cwd, projectRoot: cwd });

    // Clearing the route must restore the empty picker, even after a custom selection.
    view.rerender({});
    await settle();
    expect(picker().textContent).toBe("Select project");
  });

  it("creates a new session for the first home prompt even while A remains attached", async () => {
    const view = mountApp({ cwd: "/x" });
    navigateMock.mockImplementation(async (options: { search: WorkspaceSearch }) => {
      view.rerender(options.search);
      await flush();
    });
    const ws = await connectReady();
    // Home is a new-session surface, but an older live session can deliberately
    // remain attached in the background. Its ID must never become the home's
    // implicit send target.
    await act(async () => {
      void capturedStore!.openSession("A").catch(() => undefined);
      const attach = await waitForAttach(ws);
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A" }) });
      await flush();
    });
    expect(capturedStore!.getSnapshot().sessionId).toBe("A");
    await settle();

    const textarea = document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "first from home" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    await act(async () => { await flush(8); });

    // Empty-home send must not navigate to the same cwd before create; that
    // redundant route commit was the visible first-Enter refresh.
    expect(navigateMock).not.toHaveBeenCalled();
    expect(SOCKETS).toHaveLength(1);
    expect(SOCKETS[0]).toBe(ws);
    const create = lastFrame<{ type: string; id: string }>(ws, "create")!;
    expect(create).toBeTruthy();
    await act(async () => {
      ws.serverSend({
        type: "response",
        id: create.id,
        payload: { ok: true, result: { sessionId: "new-home", epoch: "e1", created: true, cwd: "/x", projectRoot: "/x", snapshot: snapshotPayload({ sessionId: "new-home" }).snapshot } },
      });
      await flush();
      // Identity-only create → the home first send activates new-home through
      // transitionTo: detach the background A, then attach new-home.
      const detach = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "detach")!;
      expect(detach.payload.sessionId).toBe("A");
      ws.serverSend({ type: "response", id: detach.id, payload: { ok: true, result: { sessionId: "A", detached: true } } });
      await flush();
      const attach = await waitForAttach(ws, "new-home");
      expect(attach.payload?.sessionId).toBe("new-home");
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "new-home", capabilities: ["runtime.prompt", "runtime.abort"] }) });
      await flush(12);
    });

    const prompts = ws.sent.filter((frame) => (frame as { type?: string; payload?: { command?: { type?: string } } }).type === "command" && (frame as { payload?: { command?: { type?: string } } }).payload?.command?.type === "prompt") as Array<{ payload: { sessionId: string; command: { message: string } } }>;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.payload.sessionId).toBe("new-home");
    expect(prompts[0]!.payload.command.message).toBe("first from home");
  });

  it("highlights the project only on home; a selected session owns the active-row treatment", async () => {
    const { rerender } = mountApp({ cwd: "/x" });
    await settle();
    const project = () => screen.getAllByTestId("sidebar-project-row").find((row) => row.getAttribute("title") === "/x")!.closest(".sidebar-list-row");
    expect(project()?.getAttribute("data-active")).toBe("true");

    rerender({ cwd: "/x", session: "A" });
    await settle();
    expect(project()?.getAttribute("data-active")).toBe("false");
    expect(screen.getAllByTestId("session-select-A")[0]!.closest(".sidebar-list-row")?.getAttribute("data-active")).toBe("true");
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
    await settle();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(other!.getAttribute("aria-expanded")).toBe("true");
    const otherCard = other!.closest("[data-testid=sidebar-project-card]") as HTMLElement;
    expect(within(otherCard).getByText("Session D")).toBeTruthy();
    expect(screen.getByTestId("sidebar-sessions")).toBeTruthy();
    expect(screen.getAllByTestId("session-select-A").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("session-select-D").length).toBeGreaterThan(1);
    expect(screen.getByTestId("file-browser-toggle")).toBeTruthy();
  });

  it("a selected session's auto-revealed project stays collapsed after the user collapses it", async () => {
    // Deep-link reveal: opening ?session=A expands the owning project once.
    const { rerender } = mountApp({ cwd: "/x", session: "A" });
    await settle();
    const card = () => screen.getAllByTestId("sidebar-project-card")
      .find((node) => node.querySelector('[title="/x"]'))!;
    expect(card().getAttribute("data-expanded")).toBe("true");

    // User collapses it.
    const row = screen.getAllByTestId("sidebar-project-row").find((r) => r.getAttribute("title") === "/x")!;
    fireEvent.click(row);
    expect(card().getAttribute("data-expanded")).toBe("false");

    // Any later rerender (a fresh visibleSessions array reference — e.g. a
    // catalog refresh) must NOT silently re-expand the collapsed project.
    rerender({ cwd: "/x", session: "A" });
    await settle();
    expect(card().getAttribute("data-expanded")).toBe("false");
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

  it("immediate selection keeps latest-intent authority (no pending state)", async () => {
    globalThis.fetch = controllableStubFetch({ sessions: PROJECT_SESSIONS });
    mountApp({ cwd: "/x" });
    await settle();
    fireEvent.click(screen.getAllByTestId("session-select-B")[0]!);
    await act(async () => { await flush(6); });
    fireEvent.click(screen.getAllByTestId("session-select-C")[0]!);
    await act(async () => { await flush(6); });
    // No pending cue exists; every click navigated at once and C (latest) won.
    expect(screen.queryByLabelText("Opening session…")).toBeNull();
    expect(navigateMock).toHaveBeenCalledTimes(2);
    expect(navigateMock).toHaveBeenLastCalledWith(expect.objectContaining({ search: { session: "C", cwd: "/x" } }));
  });

  it("shows a running cue on the live attached session without extra chrome", async () => {
    globalThis.fetch = controllableStubFetch({ sessions: PROJECT_SESSIONS });
    const { rerender } = mountApp({ cwd: "/x", session: "A" });
    const ws = await connectReady();
    await act(async () => {
      void capturedStore!.openSession("A").catch(() => undefined);
      const attach = await waitForAttach(ws);
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A" }) });
      await flush();
      void capturedStore!.sendPrompt("hi");
      await flush();
    });
    await settle();
    expect(capturedStore!.getSnapshot().streaming).toBe(true);
    expect(screen.getAllByLabelText("Agent running").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("session-select-A")[0]!.closest('[data-running="true"]')).toBeTruthy();
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
    expect(screen.getAllByTestId("session-select-A")[0]!.closest('[data-running="true"]')).toBeTruthy();
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
    globalThis.fetch = controllableStubFetch({ sessions: PROJECT_SESSIONS });
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
    // Immediate navigation (no pending stage to settle first).
    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ search: { session: "B", cwd: "/x" } }));
    const row = select.closest(".sidebar-list-row");
    expect(row).toBeTruthy();
    const actions = row!.querySelector(".sidebar-row-actions");
    expect(actions).toBeTruthy();
    expect(within(actions as HTMLElement).getByLabelText("Pin to top").tagName).toBe("BUTTON");
    expect(within(actions as HTMLElement).getByLabelText("Archive").tagName).toBe("BUTTON");
    (actions as HTMLElement).querySelectorAll("button").forEach((button) => {
      expect((button as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("hides subagent/agent-home folders from Projects and Sessions", async () => {
    const mixed: readonly SessionHeader[] = [
      ...PROJECT_SESSIONS,
      {
        sessionId: "sub",
        cwd: "/Users/alice/.pi/agent/pi-claude-subagents/019fef69",
        projectRoot: "/Users/alice/.pi/agent/pi-claude-subagents/019fef69",
        title: "Subagent leak",
        createdAt: 1000,
        updatedAt: Date.now(),
        messageCount: 1,
        workspaceAccess: AUTHORIZED,
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

  it("hides parent-linked subagents from both global and project session lists", async () => {
    const now = Date.now();
    globalThis.fetch = controllableStubFetch({
      sessions: [
        { sessionId: "parent", cwd: "/x", projectRoot: "/x", title: "Parent session", createdAt: 1000, updatedAt: now, messageCount: 1, workspaceAccess: AUTHORIZED },
        { sessionId: "child", cwd: "/x", projectRoot: "/x", title: "Child session", parentSessionId: "parent", createdAt: 1000, updatedAt: now + 1, messageCount: 1, workspaceAccess: AUTHORIZED },
      ],
    });
    mountApp({ cwd: "/x" });
    await settle();
    expect(screen.getByTestId("session-select-parent")).toBeTruthy();
    expect(screen.queryByTestId("session-select-child")).toBeNull();
    const project = screen.getByTestId("sidebar-project-row");
    fireEvent.click(project);
    await settle();
    const projectSessions = screen.getByTestId("sidebar-project-sessions");
    expect(within(projectSessions).getByTestId("session-select-parent")).toBeTruthy();
    expect(within(projectSessions).queryByTestId("session-select-child")).toBeNull();
  });

  it("keeps a directly deep-linked subagent out of browse lists", async () => {
    const now = Date.now();
    const fetchImpl = controllableStubFetch({
      sessions: [
        { sessionId: "parent", cwd: "/x", projectRoot: "/x", title: "Parent session", createdAt: 1000, updatedAt: now, messageCount: 1, workspaceAccess: AUTHORIZED },
        { sessionId: "child", cwd: "/x", projectRoot: "/x", title: "Child session", parentSessionId: "parent", createdAt: 1000, updatedAt: now + 1, messageCount: 1, workspaceAccess: AUTHORIZED },
      ],
    });
    globalThis.fetch = fetchImpl;
    mountApp({ cwd: "/x", session: "child" });
    await settle();
    expect(screen.queryByTestId("session-select-child")).toBeNull();
    expect(countMockFetchCalls(fetchImpl, "/v1/sessions/child")).toBeGreaterThanOrEqual(1);
    expect(countMockFetchCalls(fetchImpl, "/v1/sessions?page=1&pageSize=5")).toBeGreaterThanOrEqual(1);
    expect(countMockFetchCalls(fetchImpl, "/v1/sessions?page=2&pageSize=5")).toBe(0);
  });

  it("shows five recent sessions initially, then appends the remaining page", async () => {
    const now = Date.now();
    const many: SessionHeader[] = Array.from({ length: 7 }, (_, index) => ({
      sessionId: `S${index + 1}`,
      cwd: "/x",
      projectRoot: "/x",
      title: `Session ${index + 1}`,
      createdAt: 1000,
      updatedAt: now - index * 1000,
      messageCount: 1,
      workspaceAccess: AUTHORIZED,
    }));
    const fetchImpl = controllableStubFetch({ sessions: many });
    globalThis.fetch = fetchImpl;
    mountApp({ cwd: "/x" });
    await settle();
    const recent = screen.getByTestId("sidebar-sessions");
    for (let index = 1; index <= 5; index += 1) {
      expect(within(recent).getByTestId(`session-select-S${index}`)).toBeTruthy();
    }
    expect(within(recent).queryByTestId("session-select-S6")).toBeNull();
    fireEvent.click(within(recent).getByTestId("sidebar-session-load-more"));
    await settle();
    expect(within(recent).getByTestId("session-select-S6")).toBeTruthy();
    expect(within(recent).getByTestId("session-select-S7")).toBeTruthy();
    expect(countMockFetchCalls(fetchImpl, "/v1/sessions?page=2&pageSize=5")).toBe(1);
  });

  it("loads exactly five more recent sessions per click and appends in place", async () => {
    const now = Date.now();
    const many: SessionHeader[] = Array.from({ length: 12 }, (_, index) => ({
      sessionId: `P${index + 1}`,
      cwd: "/x",
      projectRoot: "/x",
      title: `Paged ${index + 1}`,
      createdAt: 1000,
      updatedAt: now - index * 1000,
      messageCount: 1,
      workspaceAccess: AUTHORIZED,
    }));
    const fetchImpl = controllableStubFetch({ sessions: many });
    globalThis.fetch = fetchImpl;
    mountApp({ cwd: "/x" });
    await settle();
    const recent = screen.getByTestId("sidebar-sessions");
    expect(countMockFetchCalls(fetchImpl, "/v1/sessions?page=1&pageSize=5")).toBe(1);
    expect(within(recent).getByTestId("session-select-P5")).toBeTruthy();
    expect(within(recent).queryByTestId("session-select-P6")).toBeNull();
    fireEvent.click(within(recent).getByTestId("sidebar-session-load-more"));
    await settle();
    expect(within(recent).getByTestId("session-select-P1")).toBeTruthy();
    expect(within(recent).getByTestId("session-select-P10")).toBeTruthy();
    expect(within(recent).queryByTestId("session-select-P11")).toBeNull();
    expect(countMockFetchCalls(fetchImpl, "/v1/sessions?page=2&pageSize=5")).toBe(1);
    expect(within(recent).getByTestId("sidebar-session-load-more")).toBeTruthy();
    expect(within(recent).queryByText(/1 \/ 3|Previous|Next/)).toBeNull();
  });

  it("Projects and Sessions load more independently; project rows append", async () => {
    const now = Date.now();
    const many: SessionHeader[] = Array.from({ length: 12 }, (_, index) => ({
      sessionId: `P${index + 1}`,
      cwd: `/p${index + 1}`,
      projectRoot: `/p${index + 1}`,
      title: `Project ${index + 1}`,
      createdAt: 1000,
      updatedAt: now - index * 1000,
      messageCount: 1,
      workspaceAccess: AUTHORIZED,
    }));
    const fetchImpl = controllableStubFetch({ sessions: many });
    globalThis.fetch = fetchImpl;
    mountApp({ cwd: "/x" });
    await settle();
    const projects = screen.getByTestId("sidebar-projects");
    expect(within(projects).getAllByTestId("sidebar-project-row")).toHaveLength(10);
    fireEvent.click(within(projects).getByTestId("sidebar-project-load-more"));
    await settle();
    expect(within(projects).getAllByTestId("sidebar-project-row")).toHaveLength(12);
    expect(countMockFetchCalls(fetchImpl, "/v1/projects?page=2&pageSize=10")).toBe(1);
    expect(countMockFetchCalls(fetchImpl, "/v1/sessions?page=2&pageSize=5")).toBe(0);
    expect(within(projects).queryByTestId("sidebar-project-load-more")).toBeNull();
  });

  it("restores a pinned project outside the first catalog page and its expanded state", async () => {
    const now = Date.now();
    const many: SessionHeader[] = Array.from({ length: 12 }, (_, index) => ({
      sessionId: `PP${index + 1}`,
      cwd: `/persisted-project-${index + 1}`,
      projectRoot: `/persisted-project-${index + 1}`,
      title: `Persisted project ${index + 1}`,
      createdAt: 1000,
      updatedAt: now - index * 1000,
      messageCount: 1,
      workspaceAccess: AUTHORIZED,
    }));
    window.localStorage.setItem("pi-sidebar-item-state", JSON.stringify({
      pinnedSessions: [],
      pinnedProjects: ["/persisted-project-12"],
      archivedSessions: [],
      archivedProjects: [],
      expandedProjects: ["/persisted-project-12"],
    }));
    const fetchImpl = controllableStubFetch({ sessions: many });
    globalThis.fetch = fetchImpl;
    mountApp({ cwd: "/x" });
    await settle();

    const pinned = screen.getByTestId("sidebar-pinned");
    const projectRow = within(pinned).getByTestId("sidebar-project-row");
    expect(projectRow.textContent).toContain("persisted-project-12");
    expect(projectRow.getAttribute("aria-expanded")).toBe("true");
    expect(within(pinned).getByTestId("session-select-PP12")).toBeTruthy();
    expect(countMockFetchCalls(fetchImpl, "projectRoot=%2Fpersisted-project-12")).toBeGreaterThan(0);
  });

  it("restores a pinned session outside the initial five-session page", async () => {
    const now = Date.now();
    const many: SessionHeader[] = Array.from({ length: 12 }, (_, index) => ({
      sessionId: `PS${index + 1}`,
      cwd: "/persisted-sessions",
      projectRoot: "/persisted-sessions",
      title: `Persisted session ${index + 1}`,
      createdAt: 1000,
      updatedAt: now - index * 1000,
      messageCount: 1,
      workspaceAccess: AUTHORIZED,
    }));
    window.localStorage.setItem("pi-sidebar-item-state", JSON.stringify({
      pinnedSessions: ["PS12"],
      pinnedProjects: [],
      archivedSessions: [],
      archivedProjects: [],
      expandedProjects: [],
    }));
    globalThis.fetch = controllableStubFetch({ sessions: many });
    mountApp({ cwd: "/x" });
    await settle();

    expect(within(screen.getByTestId("sidebar-pinned")).getByTestId("session-select-PS12")).toBeTruthy();
    expect(within(screen.getByTestId("sidebar-sessions")).queryByTestId("session-select-PS12")).toBeNull();
  });

  it("keeps Load more reachable when every Project on the first page is archived", async () => {
    const now = Date.now();
    const many: SessionHeader[] = Array.from({ length: 12 }, (_, index) => ({
      sessionId: `A${index + 1}`,
      cwd: `/a${index + 1}`,
      projectRoot: `/a${index + 1}`,
      title: `Archived project ${index + 1}`,
      createdAt: 1000,
      updatedAt: now - index * 1000,
      messageCount: 1,
      workspaceAccess: AUTHORIZED,
    }));
    window.localStorage.setItem("pi-sidebar-item-state", JSON.stringify({
      pinnedSessions: [],
      pinnedProjects: [],
      archivedSessions: [],
      archivedProjects: many.slice(0, 10).map((session) => session.projectRoot),
    }));
    const fetchImpl = controllableStubFetch({ sessions: many });
    globalThis.fetch = fetchImpl;
    mountApp({ cwd: "/x" });
    await settle();
    const projects = screen.getByTestId("sidebar-projects");
    expect(within(projects).queryAllByTestId("sidebar-project-row")).toHaveLength(0);
    fireEvent.click(within(projects).getByTestId("sidebar-project-load-more"));
    await settle();
    expect(within(projects).getAllByTestId("sidebar-project-row")).toHaveLength(2);
    expect(countMockFetchCalls(fetchImpl, "/v1/projects?page=2&pageSize=10")).toBe(1);
  });

  it("shows an honest Projects error and retries page 1 from Load more", async () => {
    const fetchImpl = controllableStubFetch({
      sessions: PROJECT_SESSIONS,
      projectsError: { status: 503, body: { code: "SESSIONS_UNAVAILABLE", message: "unavailable" } },
    });
    globalThis.fetch = fetchImpl;
    mountApp({ cwd: "/x" });
    await settle();
    const projects = screen.getByTestId("sidebar-projects");
    expect(within(projects).getByText("Projects are temporarily unavailable.")).toBeTruthy();
    expect(countMockFetchCalls(fetchImpl, "/v1/projects?page=1&pageSize=10")).toBe(1);
    fireEvent.click(within(projects).getByTestId("sidebar-project-load-more"));
    await settle();
    expect(countMockFetchCalls(fetchImpl, "/v1/projects?page=1&pageSize=10")).toBe(2);
  });

  it("loads exactly five more project-scoped sessions without replacing the first batch", async () => {
    const now = Date.now();
    const grouped: SessionHeader[] = Array.from({ length: 12 }, (_, index) => ({
      sessionId: `G${index + 1}`,
      cwd: "/x",
      projectRoot: "/x",
      title: `Grouped ${index + 1}`,
      createdAt: 1000,
      updatedAt: now - index * 1000,
      messageCount: 1,
      workspaceAccess: AUTHORIZED,
    }));
    const fetchImpl = controllableStubFetch({ sessions: grouped });
    globalThis.fetch = fetchImpl;
    mountApp({ cwd: "/x" });
    await settle();
    fireEvent.click(screen.getByTestId("sidebar-project-row"));
    await settle();
    const nested = screen.getByTestId("sidebar-project-sessions");
    expect(within(nested).getByTestId("session-select-G1")).toBeTruthy();
    expect(within(nested).getByTestId("session-select-G5")).toBeTruthy();
    expect(within(nested).queryByTestId("session-select-G6")).toBeNull();
    fireEvent.click(within(nested).getByTestId("project-/x-load-more"));
    await settle();
    expect(within(nested).getByTestId("session-select-G1")).toBeTruthy();
    expect(within(nested).getByTestId("session-select-G10")).toBeTruthy();
    expect(within(nested).queryByTestId("session-select-G11")).toBeNull();
    expect(countMockFetchCalls(fetchImpl, "/v1/sessions?page=2&pageSize=5&projectRoot=%2Fx")).toBe(1);
  });

  it("shows an honest nested Sessions error and retries its first scoped page", async () => {
    const fetchImpl = controllableStubFetch({
      sessions: PROJECT_SESSIONS,
      projectSessionsError: { status: 503, body: { code: "SESSIONS_UNAVAILABLE", message: "unavailable" } },
    });
    globalThis.fetch = fetchImpl;
    mountApp({ cwd: "/x" });
    await settle();
    const project = screen.getAllByTestId("sidebar-project-row").find((row) => row.getAttribute("title") === "/x");
    expect(project).toBeTruthy();
    fireEvent.click(project!);
    await settle();
    const nested = screen.getByTestId("sidebar-project-sessions");
    expect(within(nested).getByText("Sessions are temporarily unavailable.")).toBeTruthy();
    expect(countMockFetchCalls(fetchImpl, "/v1/sessions?page=1&pageSize=5&projectRoot=%2Fx")).toBe(1);
    fireEvent.click(within(nested).getByTestId("project-/x-load-more"));
    await settle();
    expect(countMockFetchCalls(fetchImpl, "/v1/sessions?page=1&pageSize=5&projectRoot=%2Fx")).toBe(2);
  });

  it("keeps nested Load more reachable when the first five scoped sessions are archived", async () => {
    const now = Date.now();
    const grouped: SessionHeader[] = Array.from({ length: 12 }, (_, index) => ({
      sessionId: `R${index + 1}`,
      cwd: "/x",
      projectRoot: "/x",
      title: `Archived nested ${index + 1}`,
      createdAt: 1000,
      updatedAt: now - index * 1000,
      messageCount: 1,
      workspaceAccess: AUTHORIZED,
    }));
    window.localStorage.setItem("pi-sidebar-item-state", JSON.stringify({
      pinnedSessions: [],
      pinnedProjects: [],
      archivedSessions: grouped.slice(0, 5).map((session) => session.sessionId),
      archivedProjects: [],
    }));
    const fetchImpl = controllableStubFetch({ sessions: grouped });
    globalThis.fetch = fetchImpl;
    mountApp({ cwd: "/x" });
    await settle();
    fireEvent.click(screen.getByTestId("sidebar-project-row"));
    await settle();
    const nested = screen.getByTestId("sidebar-project-sessions");
    expect(within(nested).queryByTestId("session-select-R1")).toBeNull();
    fireEvent.click(within(nested).getByTestId("project-/x-load-more"));
    await settle();
    expect(within(nested).getByTestId("session-select-R6")).toBeTruthy();
    expect(countMockFetchCalls(fetchImpl, "/v1/sessions?page=2&pageSize=5&projectRoot=%2Fx")).toBe(1);
  });

  it("keeps a deep-linked detail out-of-band when it is outside the current page", async () => {
    const now = Date.now();
    const many: SessionHeader[] = Array.from({ length: 55 }, (_, index) => ({
      sessionId: `D${index + 1}`,
      cwd: "/x",
      projectRoot: "/x",
      title: `Deep ${index + 1}`,
      createdAt: 1000,
      updatedAt: now - index * 1000,
      messageCount: 1,
      workspaceAccess: AUTHORIZED,
    }));
    const fetchImpl = controllableStubFetch({ sessions: many });
    globalThis.fetch = fetchImpl;
    mountApp({ cwd: "/x", session: "D55" });
    await settle();
    expect(within(screen.getByTestId("sidebar-sessions")).queryByTestId("session-select-D55")).toBeNull();
    expect(countMockFetchCalls(fetchImpl, "/v1/sessions?page=1&pageSize=5")).toBeGreaterThanOrEqual(1);
    expect(countMockFetchCalls(fetchImpl, "/v1/sessions/D55")).toBeGreaterThanOrEqual(1);
    expect(countMockFetchCalls(fetchImpl, "/v1/models")).toBeGreaterThanOrEqual(1);
    expect(countMockFetchCalls(fetchImpl, "page=2")).toBe(0);
  });

  it("keeps project actions in the overflow menu, separate from the row", async () => {
    mountApp({ cwd: "/x" });
    await settle();
    const projectButton = screen.getAllByTestId("sidebar-project-row").find((row) => row.getAttribute("title") === "/x");
    expect(projectButton).toBeTruthy();
    const row = projectButton!.closest(".sidebar-list-row") as HTMLElement;
    // The row carries a New-session (Plus) button and a More-options (dots)
    // button; pin/archive moved into the dots menu.
    expect(within(row).getByLabelText("New Session")).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(row).getByLabelText("More options"));
      await flush();
    });
    const menuItem = screen.queryByRole("menuitem", { name: "Pin to top" });
    expect(menuItem).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Archive" })).toBeTruthy();
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
    // The sidebar toggle lives in the title bar, left of the tabs; the
    // sidebar header has no separate collapse button.
    expect(screen.getByRole("button", { name: "Hide sidebar" }).closest(".app-title-bar")).toBeTruthy();
    expect(screen.queryByTestId("sidebar-collapse")).toBeNull();
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
      if (p.includes("/v1/projects")) return json({ projects: [], page: 1, pageSize: 10, total: 0, totalPages: 0, catalogRevision: 0 });
      if (p.includes("/v1/sessions")) return json({ sessions: [], page: 1, pageSize: 50, total: 0, totalPages: 0, catalogRevision: 0 });
      if (p.includes("/v1/worktrees")) return json({ projectRoot: "/x", isGit: true, isTopLevel: true, worktrees: [] });
      if (p.includes("/v1/models")) return json({ models: [], defaultModel: null });
      if (p.includes("/v1/files/") && p.includes("/index")) return json({ files: [], truncated: false });
      if (p.includes("/v1/skills")) return json({ skills: [] });
      return json({});
    }) as unknown as typeof fetch;
  }

  it("selecting a session from the sidebar navigates immediately; the session tab materializes once", async () => {
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS });
    const { rerender } = mountApp({ cwd: "/x" });
    await settle();
    fireEvent.click(screen.getAllByTestId("session-select-B")[0]!);
    await act(async () => { await flush(6); });
    // Immediate navigation — no prepare stage before the URL moves.
    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ search: { session: "B", cwd: "/x" } }));
    // Simulate the router applying the navigation: the session tab then
    // materializes in the title bar, deduped to exactly one.
    rerender({ cwd: "/x", session: "B" });
    await settle();
    expect(screen.getAllByRole("tab", { name: "Session B" })).toHaveLength(1);
  });

  it("closes the mobile sidebar after session selection while keeping the drawer mounted for exit motion", async () => {
    const mobileQuery = {
      matches: true,
      media: "(max-width: 640px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    };
    vi.stubGlobal("matchMedia", vi.fn(() => mobileQuery));
    const viewport = Object.assign(new EventTarget(), { height: 420, offsetTop: 180 });
    vi.stubGlobal("visualViewport", viewport as VisualViewport);
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS });
    mountApp({ cwd: "/x" });
    await settle();

    const shell = document.querySelector(".app-shell") as HTMLElement;
    expect(shell.style.position).toBe("fixed");
    expect(shell.style.top).toBe("180px");
    expect(shell.style.height).toBe("420px");
    expect(shell.style.marginTop).toBe("");
    expect(document.querySelector(".sidebar-container")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
    await act(async () => { vi.advanceTimersByTime(20); });
    const drawer = document.querySelector(".sidebar-container") as HTMLElement;
    expect(drawer.className).toContain("sidebar-open");
    expect(document.querySelector(".sidebar-overlay-backdrop")?.className).toContain("is-open");
    fireEvent.click(screen.getAllByTestId("session-select-B")[0]!);
    expect(drawer.className).toContain("sidebar-closed");
    expect(drawer.getAttribute("aria-hidden")).toBe("true");
    expect(drawer.hasAttribute("inert")).toBe(true);
    expect(screen.getByTestId("sidebar")).toBeTruthy();
    expect(document.querySelector(".sidebar-overlay-backdrop")).toBeNull();
    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ search: { session: "B", cwd: "/x" } }));

    fireEvent.transitionEnd(drawer, { propertyName: "transform" });
    expect(document.querySelector(".sidebar-container")).toBeNull();
  });

  it("cancels mobile drawer disposal when it reopens during the exit transition", async () => {
    const mobileQuery = {
      matches: true,
      media: "(max-width: 640px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    };
    vi.stubGlobal("matchMedia", vi.fn(() => mobileQuery));
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS });
    mountApp({ cwd: "/x" });
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
    await act(async () => { vi.advanceTimersByTime(20); });
    fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
    expect(document.querySelector(".sidebar-container")?.className).toContain("sidebar-closed");
    fireEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
    await act(async () => { vi.advanceTimersByTime(20); });
    vi.advanceTimersByTime(400);

    expect(document.querySelector(".sidebar-container")?.className).toContain("sidebar-open");
    expect(document.querySelector(".sidebar-overlay-backdrop")).toBeTruthy();
  });

  it("removes the mobile drawer when opening is cancelled or transitionend is lost", async () => {
    const mobileQuery = {
      matches: true,
      media: "(max-width: 640px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    };
    vi.stubGlobal("matchMedia", vi.fn(() => mobileQuery));
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS });
    mountApp({ cwd: "/x" });
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
    expect(document.querySelector(".sidebar-container")?.className).toContain("sidebar-closed");
    fireEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
    expect(document.querySelector(".sidebar-container")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
    await act(async () => { vi.advanceTimersByTime(20); });
    fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
    expect(document.querySelector(".sidebar-container")?.className).toContain("sidebar-closed");
    await act(async () => { vi.advanceTimersByTime(340); });
    expect(document.querySelector(".sidebar-container")).toBeNull();
  });

  it("restores persisted session tabs and saves tab closure without restoring file/runtime state", async () => {
    window.localStorage.setItem(WORKSPACE_SESSION_TABS_STORAGE_KEY, JSON.stringify({
      version: 1,
      sessions: [{ sessionId: "A", cwd: "/x" }, { sessionId: "B", cwd: "/x" }],
    }));
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS });
    mountApp({ cwd: "/x" });
    await settle();

    expect(screen.getByRole("tab", { name: "Session A" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Session B" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close Session B" }));
    await settle();
    expect(JSON.parse(window.localStorage.getItem(WORKSPACE_SESSION_TABS_STORAGE_KEY) ?? "null")).toEqual({
      version: 1,
      sessions: [{ sessionId: "A", cwd: "/x" }],
    });
  });

  it("restores the last active session once on an empty PWA cold-start route", async () => {
    window.localStorage.setItem(WORKSPACE_SESSION_TABS_STORAGE_KEY, JSON.stringify({
      version: 1,
      sessions: [{ sessionId: "B", cwd: "/x" }],
    }));
    window.localStorage.setItem(WORKSPACE_LAST_SESSION_STORAGE_KEY, JSON.stringify({
      version: 1,
      sessionId: "B",
    }));
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS });
    const { rerender } = mountApp({});
    await settle();

    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/",
      replace: true,
      search: { cwd: "/x", session: "B" },
    });

    rerender({ cwd: "/x", session: "B" });
    await settle();
    rerender({ cwd: "/x" });
    await settle();
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(WORKSPACE_LAST_SESSION_STORAGE_KEY)).toBeNull();
  });

  it("never lets persisted selection override an explicit startup target", async () => {
    window.localStorage.setItem(WORKSPACE_SESSION_TABS_STORAGE_KEY, JSON.stringify({
      version: 1,
      sessions: [{ sessionId: "B", cwd: "/x" }],
    }));
    window.localStorage.setItem(WORKSPACE_LAST_SESSION_STORAGE_KEY, JSON.stringify({
      version: 1,
      sessionId: "B",
    }));
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS });
    mountApp({ cwd: "/x", session: "A" });
    await settle();

    expect(navigateMock).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem(WORKSPACE_LAST_SESSION_STORAGE_KEY) ?? "null")).toEqual({
      version: 1,
      sessionId: "A",
    });
  });

  it("selecting a session from another project activates its owning cwd", async () => {
    globalThis.fetch = controllableStubFetch({ sessions: PROJECT_SESSIONS });
    mountApp({ cwd: "/x" });
    await settle();
    fireEvent.click(screen.getAllByTestId("session-select-D")[0]!);
    await act(async () => { await flush(6); });
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

  it("tab right-click bulk close: others / right / all with honest navigation", async () => {
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS });
    const { rerender } = mountApp({ cwd: "/x" });
    await settle();
    // Materialize A and B session tabs.
    fireEvent.click(screen.getByTestId("session-select-A"));
    await act(async () => { await flush(6); });
    rerender({ cwd: "/x", session: "A" });
    await settle();
    fireEvent.click(screen.getAllByTestId("session-select-B")[0]!);
    await act(async () => { await flush(6); });
    rerender({ cwd: "/x", session: "B" });
    await settle();
    expect(screen.getAllByRole("tab")).toHaveLength(2);

    // Right-click A → close OTHERS: B's tab disappears, A becomes active.
    fireEvent.contextMenu(screen.getByRole("tab", { name: "Session A" }), { clientX: 40, clientY: 12 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Close other tabs" }));
    await act(async () => { await flush(6); });
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "Session A" })).toBeTruthy();
    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ search: { session: "A", cwd: "/x" } }));

    // Right-click A → close ALL: the strip empties and the URL goes home.
    fireEvent.contextMenu(screen.getByRole("tab", { name: "Session A" }), { clientX: 40, clientY: 12 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Close all tabs" }));
    await act(async () => { await flush(6); });
    expect(screen.queryByRole("tab")).toBeNull();
    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ search: { cwd: "/x" } }));

    // "Close tabs to the right" is disabled on the last tab (honest no-op).
    fireEvent.click(screen.getAllByTestId("session-select-C")[0]!);
    await act(async () => { await flush(6); });
    rerender({ cwd: "/x", session: "C" });
    await settle();
    fireEvent.contextMenu(screen.getByRole("tab", { name: "Session C" }), { clientX: 40, clientY: 12 });
    expect(screen.getByRole("menuitem", { name: "Close tabs to the right" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("the pinned file browser button toggles the FILE BROWSER panel without leaving the window's top-right", async () => {
    globalThis.fetch = fileFetch();
    mountApp({ cwd: "/x" });
    await settle();
    const panel = document.querySelector(".right-panel-container");
    expect(panel?.className).toContain("right-panel-closed");
    const toggle = screen.getByTestId("file-browser-toggle");
    // Pinned: the button's containing block is the shell body (window
    // top-right), not the chat column whose width the panel animation takes —
    // otherwise opening the panel drags the button leftwards.
    expect(toggle.closest(".chat-column")).toBeNull();
    expect(toggle.closest(".app-shell-body")).toBeTruthy();
    const pin = toggle.parentElement as HTMLElement;
    expect(pin.style.position).toBe("absolute");
    expect(pin.style.right).toBe("0px");
    // The in-flow title bar keeps the pinned button's column free for "+".
    expect((document.querySelector(".app-title-bar") as HTMLElement).style.paddingRight).toBe("36px");
    fireEvent.click(toggle);
    expect(document.querySelector(".right-panel-container")?.className).toContain("right-panel-open");
    expect(screen.getByRole("button", { name: "Hide file browser" })).toBeTruthy();
    fireEvent.click(screen.getByTestId("file-browser-toggle"));
    expect(document.querySelector(".right-panel-container")?.className).toContain("right-panel-closed");
  });
});

describe("AppShell / Composer — Phase 6B workspaceAccess fail-closed", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    SOCKETS.length = 0;
    capturedStore = null;
    navigateMock.mockReset();
    previousFetch = globalThis.fetch;
    modelsCatalog = {
      models: [{ id: "gpt-5", provider: "openai", displayName: "GPT-5" }],
      defaultModel: { id: "gpt-5", provider: "openai" },
    };
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

  it("legacy missing workspaceAccess is history-only: history renders, live workspace sends never fire", async () => {
    const legacy: SessionHeader = { sessionId: "legacy", cwd: "/x", projectRoot: "/x", title: "Legacy", createdAt: 1000, updatedAt: Date.now(), messageCount: 1 };
    const fetchImpl = controllableStubFetch({ sessions: [legacy] });
    globalThis.fetch = fetchImpl;
    mountApp({ cwd: "/x", session: "legacy" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection();
    await settle();
    const legacyRows = screen.getAllByTestId("session-select-legacy");
    expect(legacyRows.length).toBeGreaterThan(0);
    expect(screen.getAllByText("This session is history-only until workspace access is confirmed.").length).toBeGreaterThan(0);
    expect(legacyRows[0]!.closest(".sidebar-list-row")?.getAttribute("data-dead")).toBe("true");
    expect(legacyRows[0]!.closest(".sidebar-list-row")?.getAttribute("data-workspace-access")).toBe("unknown");
    expect((screen.getByLabelText("Send message") as HTMLButtonElement).disabled).toBe(true);
    const textarea = document.querySelector<HTMLTextAreaElement>(".chat-input-textarea")!;
    await act(async () => { fireEvent.change(textarea, { target: { value: "should not send" } }); await flush(); });
    await act(async () => { fireEvent.click(screen.getByLabelText("Send message")); await flush(); });
    expect(countType(ws, "attach")).toBe(0);
    expect(countType(ws, "command")).toBe(0);
    expect(ws.sent.some((frame) => (frame as { type?: string }).type === "submit_turn")).toBe(false);
    // The Composer's model selector is a live workspace surface and stays
    // disabled here — but /v1/models is a GLOBAL read-only catalog that
    // Settings may legitimately prefetch, so no zero-count assertion for it.
    expect(countMockFetchCalls(fetchImpl, "/v1/files")).toBe(0);

    // Settings mounts every catalog tab even when hidden; the exact workspace
    // gate must keep all cwd-owned catalog queries pre-wire disabled.
    fireEvent.click(screen.getByTestId("sidebar-nav-settings"));
    await settle();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(countMockFetchCalls(fetchImpl, "/v1/skills")).toBe(0);
    expect(countMockFetchCalls(fetchImpl, "/v1/plugins")).toBe(0);
    expect(countMockFetchCalls(fetchImpl, "/v1/commands")).toBe(0);
  });

  it("authorized existing session keeps models/send; history_only B never leaks A's live surface", async () => {
    const mixed: readonly SessionHeader[] = [
      { ...SESSION_HEADERS[0]!, sessionId: "A", workspaceAccess: AUTHORIZED },
      { sessionId: "B", cwd: "/outside", projectRoot: "/outside", title: "History B", createdAt: 1000, updatedAt: Date.now(), messageCount: 1, workspaceAccess: { state: "history_only", reason: "outside_allowed_roots" } },
    ];
    const fetchImpl = controllableStubFetch({ sessions: mixed });
    globalThis.fetch = fetchImpl;
    const { rerender } = mountApp({ cwd: "/x", session: "A" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection();
    await mountLiveA(ws);
    await settle();
    expect(screen.getByLabelText("Change model").textContent).toContain("GPT-5");
    const textarea = document.querySelector<HTMLTextAreaElement>(".chat-input-textarea")!;
    await act(async () => { fireEvent.change(textarea, { target: { value: "live A" } }); await flush(); });
    expect((screen.getByLabelText("Send message") as HTMLButtonElement).disabled).toBe(false);
    const modelsBeforeB = countMockFetchCalls(fetchImpl, "/v1/models");

    rerender({ cwd: "/outside", session: "B" });
    await settle();
    expect(screen.getAllByText("This session is history-only. Live workspace actions are unavailable.").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("session-select-B")[0]!.closest(".sidebar-list-row")?.getAttribute("data-workspace-access")).toBe("history_only");
    expect((screen.getByLabelText("Send message") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText("Change model")).toBeNull();
    const bInput = document.querySelector<HTMLTextAreaElement>(".chat-input-textarea")!;
    await act(async () => { fireEvent.change(bInput, { target: { value: "blocked B" } }); await flush(); });
    await act(async () => { fireEvent.click(screen.getByLabelText("Send message")); await flush(); });
    expect(countType(ws, "attach")).toBe(1);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "command")).toHaveLength(0);
    expect(countMockFetchCalls(fetchImpl, "/v1/models")).toBe(modelsBeforeB);
    expect(capturedStore!.getSnapshot().sessionId).toBe("A");
    expect(capturedStore!.getSnapshot().attached).toBe(true);
  });

  it("unavailable deleted root can still render catalog metadata but blocks live workspace", async () => {
    const gone: SessionHeader = {
      sessionId: "gone",
      cwd: "/deleted",
      projectRoot: "/deleted",
      title: "Gone",
      createdAt: 1000,
      updatedAt: Date.now(),
      messageCount: 1,
      workspaceAccess: { state: "unavailable", reason: "deleted" },
    };
    const fetchImpl = controllableStubFetch({ sessions: [gone] });
    globalThis.fetch = fetchImpl;
    mountApp({ cwd: "/deleted", session: "gone" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection();
    await settle();
    expect(screen.getAllByTestId("session-select-gone")[0]!.textContent).toContain("Gone");
    expect(screen.getAllByText("This session's workspace is no longer available.").length).toBeGreaterThan(0);
    expect((screen.getByLabelText("Send message") as HTMLButtonElement).disabled).toBe(true);
    expect(countMockFetchCalls(fetchImpl, "/v1/models")).toBe(0);
    expect(countType(ws, "attach")).toBe(0);
  });

  it("new-session home cwd is unchanged by a history-only catalog row", async () => {
    const hist: SessionHeader = {
      sessionId: "hist",
      cwd: "/outside",
      projectRoot: "/outside",
      title: "Outside",
      createdAt: 1000,
      updatedAt: Date.now(),
      messageCount: 1,
      workspaceAccess: { state: "history_only", reason: "outside_allowed_roots" },
    };
    const fetchImpl = controllableStubFetch({ sessions: [hist] });
    globalThis.fetch = fetchImpl;
    mountApp({ cwd: "/x" }, { queryClient: authenticatedQueryClient() });
    await settle();
    expect(screen.getByTestId("home-stack")).toBeTruthy();
    expect(screen.queryByText("This session is history-only. Live workspace actions are unavailable.")).toBeNull();
    // New-session send readiness still follows the existing explicit project
    // selection owner; the history-only row must not suppress cwd-authorized
    // catalog lookup or become the new-session workspace authority.
    expect(screen.getByLabelText("Send message")).toBeTruthy();
    expect(countMockFetchCalls(fetchImpl, "/v1/models")).toBeGreaterThan(0);
  });
});
