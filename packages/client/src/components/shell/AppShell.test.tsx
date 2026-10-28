import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, act, screen, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { AppShell } from "./AppShell";
import type { WorkspaceSearch } from "@/lib/search-params";
import { clearDraft, getDraft } from "@/lib/draft-store";
import { queryKeys } from "@/api/query-keys";
import type { SessionEntry, SessionHeader } from "@fffattiger/pix-protocol";
import { RuntimeProvider, SelectedSessionProvider } from "@/runtime/runtime-provider";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { I18nProvider } from "@/hooks/useI18n";
import { HttpClientProvider } from "@/app/http-context";
import { ContextMenuProvider } from "@/components/ContextMenu";
import { openChatFile, transcriptScrollRef } from "@/components/chat/chat-experience-bridge";
import { SessionStagingProvider } from "@/features/composer/session-staging-provider";
import { authoritySnapshot, FakeWebSocket, flush, lastFrame, snapshotPayload } from "@/runtime/testing/harness";
import { CaptureTestRuntime } from "@/runtime/testing/capture-test-runtime";
import { describeRuntimeObservationError } from "@/runtime/observation-errors";
import { ASSISTANT_NOTIFY_MESSAGE_PREFIX } from "@/lib/assistant-message";
import { WORKSPACE_LAST_SESSION_STORAGE_KEY, WORKSPACE_SESSION_TABS_STORAGE_KEY } from "@/features/workspace/tabs/workspace-tab-state";
import type { TestRuntimeStore } from "@/runtime/testing/test-runtime-store";
import { setWatchSessionFactory, type WatchConnectionState, type WatchSession } from "@/api/files-watch";
import type { RuntimeSocketDeps } from "@/runtime/socket";
import type { HostInfo } from "@fffattiger/pix-protocol";

// AppShell is the single owner of URL-session selection intent; this suite
// proves inactive/history selection never activates a target, authorized
// already-live selection (busy OR idle Worker) uses observation-only
// attachment, background runtime state remains identity-gated, and send-time
// supersession has no hung/late clobber. Live/idle observation is a read of
// an existing Worker — never create/activate, never a busy cue.

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
  /** Server-owned pin/archive document. Tests that still stage the legacy
   * localStorage shape pass it here so the sidebar reads the same intent. */
  workspaceFlags?: { sessions?: Record<string, { pinned?: boolean; archived?: boolean }>; projects?: Record<string, { pinned?: boolean; archived?: boolean }> };
  contextDeferreds?: Map<string, Deferred>;
  contextEntries?: Map<string, SessionEntry[]>;
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
    if (p.includes("/v1/workspace-flags")) return json({ revision: 1, sessions: {}, projects: {}, ...opts.workspaceFlags });
    if (p.includes("/v1/sessions/") && p.includes("/context")) {
      const id = decodeURIComponent(p.split("/v1/sessions/")[1]!.split("/")[0]!);
      opts.contextCalls?.push(id);
      if (opts.contextError !== undefined) return jsonStatus(opts.contextError.body, opts.contextError.status);
      const immediateEntries = opts.contextEntries?.get(id);
      if (immediateEntries !== undefined) {
        return json({
          context: {
            sessionId: id,
            entries: immediateEntries,
            settings: { model: { provider: "anthropic", modelId: "claude-opus-4" }, thinkingLevel: "off" },
            pageInfo: { hasMore: false },
          },
        });
      }
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
      const parentSessionId = url.searchParams.get("parentSessionId");
      const query = url.searchParams.get("query");
      if (projectRoot !== null && opts.projectSessionsError !== undefined) {
        return jsonStatus(opts.projectSessionsError.body, opts.projectSessionsError.status);
      }
      const visible = parentSessionId === null
        ? sessions.filter((session) => session.parentSessionId === undefined && !/pi-(?:claude-)?subagents/.test(session.projectRoot))
        : sessions.filter((session) => session.parentSessionId === parentSessionId);
      const scoped = projectRoot === null ? visible : visible.filter((session) => session.projectRoot === projectRoot);
      // Server-side keyword search (mirrors the daemon contract): case-
      // insensitive substring over title (first-message display name when
      // untitled) / project basename / first message, ranked title > project >
      // message then latest activity, tagged with matchSource.
      let filtered = [...scoped].sort((a, b) => (b.pinned === true ? 1 : 0) - (a.pinned === true ? 1 : 0));
      if (query !== null && query.trim().length > 0) {
        const needle = query.trim().toLowerCase();
        const projectName = (session: SessionHeader) => (session.projectRoot || session.cwd).replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() ?? "";
        const matchOf = (session: SessionHeader): "title" | "project" | "message" | null => {
          const title = session.title && session.title.trim().length > 0 ? session.title : session.firstMessage;
          if (title && title.toLowerCase().includes(needle)) return "title";
          if (projectName(session).toLowerCase().includes(needle)) return "project";
          if (session.firstMessage && session.firstMessage.toLowerCase().includes(needle)) return "message";
          return null;
        };
        const tier = { title: 0, project: 1, message: 2 } as const;
        filtered = scoped
          .map((session) => {
            const source = matchOf(session);
            return source === null ? null : { session, source };
          })
          .filter((entry): entry is { session: SessionHeader; source: "title" | "project" | "message" } => entry !== null)
          .sort((a, b) => tier[a.source] - tier[b.source]
            || (b.session.updatedAt ?? b.session.lastMessageAt ?? b.session.createdAt ?? 0)
              - (a.session.updatedAt ?? a.session.lastMessageAt ?? a.session.createdAt ?? 0))
          .map(({ session, source }) => ({ ...session, matchSource: source }));
      }
      const offset = (page - 1) * pageSize;
      return json({ sessions: filtered.slice(offset, offset + pageSize), page, pageSize, total: filtered.length, totalPages: filtered.length === 0 ? 0 : Math.ceil(filtered.length / pageSize), catalogRevision: 0 });
    }
    if (p.includes("/v1/worktrees")) return json({ projectRoot: "/x", isGit: true, isTopLevel: true, worktrees: [] });
    if (p.includes("/v1/models")) return json(modelsCatalog);
    if (p.includes("/v1/files/") && p.includes("/index")) return json({ files: [], truncated: false });
    if (p.includes("/v1/skills")) return json({ skills: [] });
    if (p.includes("/v1/plugins")) return json({ plugins: [] });
    if (p.includes("/v1/commands")) return json({ commands: [] });
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
    if (p.includes("/v1/workspace-flags")) return json({ revision: 0, sessions: {}, projects: {} });
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
    if (p.includes("/v1/plugins")) return json({ plugins: [] });
    if (p.includes("/v1/commands")) return json({ commands: [] });
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
  // jsdom has no scrollIntoView — the ⌘K palette keyboard navigation uses it.
  Element.prototype.scrollIntoView = vi.fn();
  window.localStorage.removeItem("pi-sidebar-item-state");
  window.localStorage.removeItem("pi-sidebar-projects-open");
  window.localStorage.removeItem("pi-sidebar-sessions-open");
  window.localStorage.removeItem("pi-sidebar-pinned-open");
  window.localStorage.removeItem(WORKSPACE_SESSION_TABS_STORAGE_KEY);
  window.localStorage.removeItem(WORKSPACE_LAST_SESSION_STORAGE_KEY);
  // The send outbox is durable too: an earlier test's undelivered send must not
  // be delivered into the next test's fake socket.
  window.localStorage.removeItem("pix.send-outbox.v1");
});

function authenticatedQueryClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.gate.status(), { status: "enabled", required: false, authenticated: false, mode: "local" });
  return client;
}

function mountApp(search: WorkspaceSearch, opts: { queryClient?: QueryClient; capabilities?: HostInfo["capabilities"] } = {}) {
  const qc = opts.queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const defaultCapabilities: HostInfo["capabilities"] = opts.capabilities ?? ["agent", "sessions", "session.write", "files", "models"];
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

/** Every real Host acks submit_turn (it closes rather than ack a degraded handshake). */
function ack(): unknown {
  return { type: "handshake_ack", payload: { protocolVersion: 2, host: { mode: "local", capabilities: ["agent"] }, limits: { maxUpload: 0, maxOpenSessions: 4 }, sessionSnapshotSupport: true, acceptedFeatures: ["runtime.submit-turn.v1"] } };
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

  it("keeps delete available for idle live sessions, disables it with a fixed reason while running, and opens the menu from the row more button", async () => {
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

    // A is live AND running: delete stays visible but disabled with the fixed
    // reason (sessiond never stops a running turn).
    fireEvent.contextMenu(screen.getAllByTestId("session-select-A")[0]!);
    const deleteA = screen.getByRole("menuitem", { name: "Delete" });
    expect(deleteA.getAttribute("aria-disabled")).toBe("true");
    expect(deleteA.getAttribute("title")).toBe("Running — stop it before deleting");
    const exportA = screen.getByRole("menuitem", { name: /export/i });
    expect(exportA.getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });

    // B is live but idle (a background resident Worker): delete is offered —
    // sessiond stops that idle Worker as part of the delete.
    fireEvent.contextMenu(screen.getAllByTestId("session-select-B")[0]!);
    const deleteB = screen.getByRole("menuitem", { name: "Delete" });
    expect(deleteB.getAttribute("aria-disabled")).not.toBe("true");
    expect(deleteB.getAttribute("title")).toBeNull();
    const exportB = screen.getByRole("menuitem", { name: /export/i });
    expect(exportB.getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });

    // C has no Worker: plain history delete.
    fireEvent.contextMenu(screen.getAllByTestId("session-select-C")[0]!);
    expect(screen.getByRole("menuitem", { name: "Delete" }).getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });

    // The hover/more button opens the exact same menu without a long press.
    fireEvent.click(screen.getAllByTestId("session-more-B")[0]!);
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Smart rename" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
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
    expect(countType(ws, "activate")).toBe(0);
    // Live-idle A without negotiated observe-existing is an honest deny, not a
    // silent history view and not an activating fallback.
    expect(screen.getByTestId("observation-error").textContent).toBe(
      describeRuntimeObservationError({ code: "unsupported_capability", retryable: false }),
    );

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
    expect(screen.queryAllByRole("alert").map((node) => node.textContent)).toEqual([
      describeRuntimeObservationError({ code: "unsupported_capability", retryable: false }),
    ]);
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

  it("does NOT attach inactive history when another session is live (0-Worker invariant)", async () => {
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS });
    mountApp({ cwd: "/x", session: "B" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(lifecycleAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A"], busySessionIds: ["A"] } });
      await flush();
    });
    expect(lastFrame(ws, "attach")).toBeUndefined();
    expect(countType(ws, "activate")).toBe(0);
    expect(countType(ws, "create")).toBe(0);
    expect(countType(ws, "stop")).toBe(0);
    expect(screen.queryByTestId("subagent-activity-card")).toBeNull();
    expect(capturedStore!.registry.leaseSnapshot.holderSessionId).not.toBe("B");
  });

  it("observes a live-idle selected session without activating a Worker", async () => {
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS });
    mountApp({ cwd: "/x", session: "B" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(lifecycleAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["B"], busySessionIds: [] } });
      await flush();
    });
    const attach = lastFrame<{ type: "attach"; payload: { sessionId: string; attachMode?: string } }>(ws, "attach");
    expect(attach?.payload).toEqual({ sessionId: "B", attachMode: "existing_only" });
    expect(countType(ws, "activate")).toBe(0);
    expect(countType(ws, "create")).toBe(0);
    expect(countType(ws, "stop")).toBe(0);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "submit_turn")).toHaveLength(0);
    expect(screen.queryByText("Opening session…")).toBeNull();
  });

  const LIVE_IDLE_CHILD_TASK = {
    taskId: "task-child",
    description: "Inspect runtime",
    agentType: "Explore",
    status: "running" as const,
    startedAt: Date.parse("2026-09-27T00:00:00.000Z"),
    childSessionId: "child",
  };
  const LIVE_IDLE_TODO = {
    revision: 1,
    items: [{ id: 1, subject: "Keep the status card honest", blockedBy: [], status: "in_progress" as const }],
  };

  it("renders the top-right activity card from a live-idle parent's attach snapshot with zero activation", async () => {
    const parent: SessionHeader = {
      sessionId: "A",
      cwd: "/x",
      projectRoot: "/x",
      title: "Session A",
      createdAt: 1000,
      updatedAt: Date.now(),
      messageCount: 1,
      workspaceAccess: AUTHORIZED,
    };
    const child: SessionHeader = {
      sessionId: "child",
      cwd: "/x",
      projectRoot: "/x",
      title: "Child",
      parentSessionId: "A",
      createdAt: 2000,
      updatedAt: Date.now(),
      messageCount: 1,
      workspaceAccess: AUTHORIZED,
    };
    const contextEntries = new Map<string, SessionEntry[]>([["A", []], ["child", []]]);
    globalThis.fetch = controllableStubFetch({ sessions: [parent, child], contextEntries });
    mountApp({ cwd: "/x", session: "A" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(lifecycleAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A"], busySessionIds: [] } });
      await flush();
    });
    const attach = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string; attachMode?: string } }>(ws, "attach")!;
    expect(attach.payload).toEqual({ sessionId: "A", attachMode: "existing_only" });
    expect(countType(ws, "attach")).toBe(1);
    expect(countType(ws, "activate")).toBe(0);
    expect(countType(ws, "create")).toBe(0);
    expect(ws.sent.filter((frame) => ["submit_turn", "command"].includes((frame as { type?: string }).type ?? ""))).toHaveLength(0);
    await act(async () => {
      ws.serverSend({
        type: "snapshot",
        id: attach.id,
        payload: snapshotPayload({
          sessionId: "A",
          capabilities: ["runtime.prompt", "runtime.subagents", "runtime.todo"],
          subagents: { revision: 1, tasks: [LIVE_IDLE_CHILD_TASK] },
          todo: LIVE_IDLE_TODO,
        }),
      });
      await flush();
    });
    const card = screen.getByTestId("subagent-activity-card");
    expect(card).toBeTruthy();
    expect(card.closest(".app-title-bar")).toBeNull();
    expect(card.closest(".app-title-trailing")).toBeNull();
    expect(document.querySelector(".conversation-container")?.contains(card)).toBe(true);
    expect(screen.queryByText("Opening session…")).toBeNull();
    expect(screen.getAllByTestId("session-select-A")[0]!.closest('[data-running="true"]')).toBeNull();
    expect(capturedStore!.registry.leaseSnapshot.holderSessionId).toBe("A");
    expect(capturedStore!.getSnapshot().attached).toBe(true);
  });

  it("renders the top-right activity card immediately for a busy already-live parent", async () => {
    const parent: SessionHeader = {
      sessionId: "A",
      cwd: "/x",
      projectRoot: "/x",
      title: "Session A",
      createdAt: 1000,
      updatedAt: Date.now(),
      messageCount: 1,
      workspaceAccess: AUTHORIZED,
    };
    globalThis.fetch = controllableStubFetch({
      sessions: [parent],
      contextEntries: new Map([["A", []]]),
    });
    mountApp({ cwd: "/x", session: "A" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(lifecycleAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A"], busySessionIds: ["A"] } });
      await flush();
    });
    const attach = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string; attachMode?: string } }>(ws, "attach")!;
    expect(attach.payload).toEqual({ sessionId: "A", attachMode: "existing_only" });
    expect(countType(ws, "activate")).toBe(0);
    await act(async () => {
      ws.serverSend({
        type: "snapshot",
        id: attach.id,
        payload: snapshotPayload({
          sessionId: "A",
          capabilities: ["runtime.prompt", "runtime.subagents", "runtime.todo"],
          subagents: { revision: 1, tasks: [LIVE_IDLE_CHILD_TASK] },
          todo: LIVE_IDLE_TODO,
        }),
      });
      await flush();
    });
    expect(screen.getByTestId("subagent-activity-card")).toBeTruthy();
    expect(screen.queryByText("Opening session…")).toBeNull();
  });

  it("inactive history baseline never attaches, never paints the activity card, and never creates a Worker", async () => {
    globalThis.fetch = controllableStubFetch({
      sessions: SESSION_HEADERS,
      contextEntries: new Map([["A", []]]),
    });
    mountApp({ cwd: "/x", session: "A" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(lifecycleAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: [], busySessionIds: [] } });
      await flush();
    });
    expect(lastFrame(ws, "attach")).toBeUndefined();
    expect(countType(ws, "activate")).toBe(0);
    expect(countType(ws, "create")).toBe(0);
    expect(screen.queryByTestId("subagent-activity-card")).toBeNull();
    expect(screen.queryByText("Opening session…")).toBeNull();
    expect(capturedStore!.getSnapshot().attached).toBe(false);
  });

  it("a late A observation snapshot cannot paint the activity card on selected B", async () => {
    globalThis.fetch = controllableStubFetch({
      sessions: SESSION_HEADERS,
      contextEntries: new Map([["A", []], ["B", []]]),
    });
    const { rerender } = mountApp({ cwd: "/x", session: "A" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(lifecycleAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A", "B"], busySessionIds: [] } });
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
      ws.serverSend({
        type: "snapshot",
        id: attachA.id,
        payload: snapshotPayload({
          sessionId: "A",
          capabilities: ["runtime.prompt", "runtime.subagents"],
          subagents: { revision: 1, tasks: [LIVE_IDLE_CHILD_TASK] },
        }),
      });
      await flush();
    });
    expect(screen.queryByTestId("subagent-activity-card")).toBeNull();
    expect(capturedStore!.registry.getSnapshot().presentationKey).toBe("session:B");
    expect(countType(ws, "activate")).toBe(0);
  });

  it("does not auto-observe a live-idle session when observe-existing was not negotiated", async () => {
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS });
    mountApp({ cwd: "/x", session: "A" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(watchAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A"], busySessionIds: [] } });
      await flush();
    });
    expect(lastFrame(ws, "attach")).toBeUndefined();
    expect(countType(ws, "activate")).toBe(0);
    expect(screen.getByTestId("observation-error").textContent).toBe(
      describeRuntimeObservationError({ code: "unsupported_capability", retryable: false }),
    );
    expect(screen.queryByTestId("subagent-activity-card")).toBeNull();
    expect(capturedStore!.registry.leaseSnapshot.holderSessionId).not.toBe("A");
  });

  it("does not auto-observe a live-idle session without the agent capability", async () => {
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS });
    mountApp(
      { cwd: "/x", session: "A" },
      { queryClient: authenticatedQueryClient(), capabilities: ["sessions", "files", "models"] },
    );
    await act(async () => { await flush(); });
    expect(SOCKETS).toHaveLength(0);
    expect(screen.queryByTestId("subagent-activity-card")).toBeNull();
  });

  it("does not auto-observe a live-idle session when the gate requires login", async () => {
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(queryKeys.gate.status(), { status: "enabled", required: true, authenticated: false, mode: "local" });
    mountApp({ cwd: "/x", session: "A" }, { queryClient: qc });
    await act(async () => { await flush(); });
    expect(SOCKETS).toHaveLength(0);
    expect(document.querySelector(".login-page")).toBeTruthy();
    expect(screen.queryByTestId("subagent-activity-card")).toBeNull();
  });

  it("does not auto-observe a live-idle session with unknown/history-only workspace", async () => {
    const deferred = createDeferred<Response>();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/v1/gate/status")) return json({ status: "enabled", required: false, authenticated: false, mode: "local" });
      if (path.includes("/v1/workspace-flags")) return json({ revision: 0, sessions: {}, projects: {} });
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
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A"], busySessionIds: [] } });
      await flush();
    });
    expect(lastFrame(ws, "attach")).toBeUndefined();
    expect(countType(ws, "activate")).toBe(0);
    deferred.resolve(json({
      session: {
        sessionId: "A",
        cwd: "/x",
        projectRoot: "/x",
        workspaceAccess: { state: "history_only", reason: "outside_allowed_roots" },
      },
    }));
    await act(async () => { await flush(); vi.advanceTimersByTime(0); await flush(); });
    expect(lastFrame(ws, "attach")).toBeUndefined();
    expect(countType(ws, "activate")).toBe(0);
    expect(screen.queryByTestId("subagent-activity-card")).toBeNull();
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

  it("an observation error does not hammer-loop, but a later live-set authority recovers", async () => {
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS });
    mountApp({ cwd: "/x", session: "A" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(lifecycleAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A"], busySessionIds: [] } });
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
      ws.serverSend({ type: "running_state", payload: { revision: 3, sessionIds: [], busySessionIds: [] } });
      await flush();
    });
    expect(countType(ws, "attach")).toBe(attachCountAfterError);
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 4, sessionIds: ["A"], busySessionIds: [] } });
      await flush();
    });
    expect(countType(ws, "attach")).toBeGreaterThan(attachCountAfterError);
    const recovered = lastFrame<{ type: "attach"; payload: { sessionId: string; attachMode?: string } }>(ws, "attach");
    expect(recovered?.payload).toEqual({ sessionId: "A", attachMode: "existing_only" });
    expect(countType(ws, "stop")).toBe(0);
  });

  it("observe-feature true→false releases once; a later send on a connection without submit_turn stays queued", async () => {
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
    await act(async () => { await flush(12); });
    // submit_turn is the only send: this connection never negotiated it, so the
    // message stays queued for the next connection — no legacy prompt, no
    // attach chain, and the earlier release is not repeated.
    expect(countCommandFrames(next, "prompt")).toBe(0);
    expect(next.sent.filter((frame) => (frame as { type?: string }).type === "submit_turn")).toHaveLength(0);
    expect(countType(ws, "detach") + countType(next, "detach")).toBe(detachCountAfterLoss);
    expect(countType(ws, "stop") + countType(next, "stop")).toBe(0);
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

  it("opening a session from the ⌘K palette navigates exactly like a sidebar row click", async () => {
    globalThis.fetch = controllableStubFetch({ sessions: SESSION_HEADERS });
    mountApp({ cwd: "/x" });
    await settle();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = screen.getByTestId("search-palette-input");
    fireEvent.change(input, { target: { value: "Session C" } });
    await act(async () => { vi.advanceTimersByTime(200); });
    await settle();
    fireEvent.click(within(screen.getByTestId("search-palette-results")).getByText("Session C"));
    await act(async () => { await flush(8); });
    // The SAME navigation owner and arguments as a sidebar row: one navigate,
    // cwd preserved, and the palette closes.
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ to: "/", search: { session: "C", cwd: "/x" } }));
    expect(screen.queryByTestId("search-palette")).toBeNull();
  });

  it("serves a warm complete-branch cache without issuing a context fetch", async () => {
    const contextCalls: string[] = [];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Pre-seed B's exact complete history response — the SAME key the keyed
    // TranscriptList mounts against (centralized cache authority), so the
    // history query resolves from the cache and never hits the network.
    qc.setQueryData(queryKeys.sessions.history("B", 0, null), {
      pages: [{ context: { sessionId: "B", entries: [], pageInfo: { hasMore: false } } }],
      pageParams: [""],
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

function countCommandFrames(ws: FakeWebSocket, type: string): number {
  return ws.sent.filter((frame) => (frame as { type?: string; payload?: { command?: { type?: string } } }).type === "command"
    && (frame as { payload?: { command?: { type?: string } } }).payload?.command?.type === type).length;
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
  await act(async () => { fireEvent.click(screen.getByLabelText("Thinking effort")); await flush(); });
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
    const attachA = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string; attachMode?: string } }>(ws, "attach");
    expect(attachA?.payload).toEqual({ sessionId: "A", attachMode: "existing_only" });
    expect(countType(ws, "activate")).toBe(0);
    expect(countType(ws, "create")).toBe(0);
    expect(countType(ws, "read")).toBe(0);
    expect(countType(ws, "command")).toBe(0);
    await act(async () => {
      ws.serverSend({
        type: "snapshot",
        id: attachA!.id,
        payload: snapshotPayload({
          sessionId: "A",
          model: { provider: "deepseek-official", id: "deepseek-v4-flash" },
          capabilities: LIVE_CAPS,
          contextUsage: { percent: 26.4, tokens: 263_711, contextWindow: 1_000_000 },
        }),
      });
      await flush();
    });
    await settleQueryNotifications();
    expect(screen.getByLabelText("Change model").textContent).toContain("Latest persisted model");
    expect(screen.getByText("26%")).toBeTruthy();
    expect(screen.getByLabelText("Session info").title).toContain("26.4%");
    rerender({ cwd: "/x", session: "B" });
    await settleQueryNotifications();
    expect(screen.getByText("0%")).toBeTruthy();
    expect(screen.queryByText("26%")).toBeNull();
    rerender({ cwd: "/x", session: "A" });
    await settleQueryNotifications();
    expect(screen.getByText("26%")).toBeTruthy();
    expect(countType(ws, "activate")).toBe(0);
    expect(countType(ws, "read")).toBe(0);
    expect(countType(ws, "command")).toBe(0);
  });

  it("refetches the model catalog on every picker open without blanking the cached list", async () => {
    mountApp({ cwd: "/x", session: "A" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(lifecycleAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A"], busySessionIds: [] } });
      await flush();
    });
    await settleQueryNotifications();
    const fetchImpl = globalThis.fetch as typeof fetch;
    const before = countMockFetchCalls(fetchImpl, "/v1/models");
    expect(before).toBeGreaterThan(0);

    await act(async () => { fireEvent.click(screen.getByLabelText("Change model")); await flush(); });
    // The cached catalog stays on screen while the refresh runs: opening must
    // never blank the list or swap it for a loading state.
    expect(document.querySelectorAll(".model-row").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Search models…")).toBeTruthy();
    await settleQueryNotifications();
    expect(countMockFetchCalls(fetchImpl, "/v1/models")).toBe(before + 1);

    // Every open refreshes, not just the first one.
    fireEvent.click(screen.getByLabelText("Change model"));
    await act(async () => { await flush(); });
    fireEvent.click(screen.getByLabelText("Change model"));
    await act(async () => { await flush(); });
    await settleQueryNotifications();
    expect(countMockFetchCalls(fetchImpl, "/v1/models")).toBe(before + 2);
  });

  it("keeps pending model intent through automatic observation without showing another model's usage, then follows accepted context events", async () => {
    mountApp({ cwd: "/x", session: "A" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(lifecycleAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A"], busySessionIds: [] } });
      await flush();
    });
    const attach = await waitForAttach(ws, "A");
    expect(attach.payload).toMatchObject({ sessionId: "A", attachMode: "existing_only" });
    expect(countType(ws, "activate")).toBe(0);
    await settleQueryNotifications();
    await pickModel("Pending model");
    expect(screen.getByText("13%")).toBeTruthy();
    expect(screen.getByLabelText("Session info").title).toContain("Estimated context for selected model");
    expect(countType(ws, "command")).toBe(0);
    await act(async () => {
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({
        sessionId: "A", model: { provider: "acme-gpt", id: "gpt-6-astra" },
        capabilities: LIVE_CAPS,
        contextUsage: { percent: 79.6358, tokens: 836_176, contextWindow: 1_050_000 },
      }) });
      await flush();
    });
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 2, sessionIds: ["A"], busySessionIds: ["A"] } });
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
    expect(screen.getByLabelText("Thinking effort")).toBeTruthy();

    // Select B → DETACHED: toolbar structure stays stable (both selectors remain).
    await selectDetachedB(ws, rerender);
    const modelBtnB = screen.getByLabelText("Change model");
    const thinkingBtnB = screen.getByLabelText("Thinking effort");
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
    expect(screen.getByLabelText("Thinking effort").textContent).toContain("high");
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
    expect(screen.queryByLabelText("Thinking effort")).toBeNull();
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
      if (path.includes("/v1/workspace-flags")) return json({ revision: 0, sessions: {}, projects: {} });
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
    const submit = await waitForSubmitTurn(ws);
    expect(submit.payload.prompt).toBe("running on A");
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

    await acceptSubmitTurn(ws, { sessionId: "A", model: { provider: "openai", id: "gpt-5" } });
    expect(capturedStore!.getSnapshot().promptPending).toBe(false);
  });

  it("sending from detached B carries staged model and thinking on ONE submit_turn (no settings commands, no attach chain)", async () => {
    const { rerender } = mountApp({ cwd: "/x" });
    const ws = await connectReady();
    await mountLiveA(ws);
    await selectDetachedB(ws, rerender);
    await pickModel("Claude Sonnet 4");
    await pickThinking("high");
    const commandsBefore = countType(ws, "command");

    const textarea = document.querySelector<HTMLTextAreaElement>(".chat-input-textarea")!;
    await act(async () => { fireEvent.change(textarea, { target: { value: "hello staged" } }); await flush(); });
    await act(async () => { fireEvent.click(screen.getByLabelText("Send message")); await flush(); });
    // UI-first: B's bubble and running indicators are visible before admission.
    // The overlay belongs only to B, never the still-attached A.
    expect(screen.getByText("hello staged")).toBeTruthy();
    expect(document.querySelector('[data-tab-id="session:B"]')?.getAttribute("data-running")).toBe("true");
    expect(capturedStore!.getSnapshot().optimisticRunningSessionId).toBe("B");
    expect(capturedStore!.getSnapshot().snapshot?.state.isPromptRunning).not.toBe(true);

    const submit = await waitForSubmitTurn(ws);
    expect(submit.payload.sessionId).toBe("B");
    expect(submit.payload.prompt).toBe("hello staged");
    expect(submit.payload.activationOverrides).toEqual({ model: { provider: "anthropic", modelId: "claude-sonnet-4" }, thinkingLevel: "high" });
    // The staged choices ride the submit: no set_model / set_thinking_level / prompt commands.
    expect(countType(ws, "command")).toBe(commandsBefore);
    expect(ws.sent.filter((f) => (f as { type?: string }).type === "submit_turn")).toHaveLength(1);
    await acceptSubmitTurn(ws, { sessionId: "B", model: { provider: "anthropic", id: "claude-sonnet-4" } });
    expect(capturedStore!.getSnapshot().promptPending).toBe(false);
  });


  it("a proven-final rejection preserves staged model/thinking and restores the draft", async () => {
    const { rerender } = mountApp({ cwd: "/x" });
    const ws = await connectReady();
    await mountLiveA(ws);
    await selectDetachedB(ws, rerender);
    await pickModel("Claude Sonnet 4");
    await pickThinking("high");
    const textarea = document.querySelector<HTMLTextAreaElement>(".chat-input-textarea")!;
    await act(async () => { fireEvent.change(textarea, { target: { value: "will fail" } }); await flush(); });
    await act(async () => { fireEvent.click(screen.getByLabelText("Send message")); await flush(); });
    await waitForSubmitTurn(ws);
    await rejectSubmitTurn(ws, { sessionId: "B", delivery: "not_delivered" });
    expect(screen.getByLabelText("Change model").textContent).toContain("Claude Sonnet 4");
    expect(screen.getByLabelText("Thinking effort").textContent).toContain("high");
    expect(textarea.value).toBe("will fail");
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
    expect(screen.getByLabelText("Thinking effort").textContent).toContain("high");
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

/** Wait for the outbox to put a submit_turn on the wire (a few microtask rounds). */
async function waitForSubmitTurn(ws: FakeWebSocket): Promise<SubmitTurnFrame> {
  await act(async () => {
    for (let i = 0; i < 80 && lastFrame(ws, "submit_turn") === undefined; i += 1) await flush(4);
  });
  return lastSubmitTurn(ws);
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

/** The accepted turn's terminal status (acceptSubmitTurn left the cursor at 5). */
async function completeSubmitTurn(ws: FakeWebSocket, submit: SubmitTurnFrame, sessionId: string, epoch = "e1"): Promise<void> {
  await act(async () => {
    ws.serverSend({ type: "turn_status", authority: authoritySnapshot(sessionId, epoch, 5), payload: { sessionId, epoch, operationId: submit.payload.operationId, turnId: `turn-${sessionId}`, revision: 1, state: "completed" } });
    await flush(4);
  });
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
          // invalid_input is a proven-final rejection; unavailable is transient.
          code: options.delivery === "not_delivered" ? "invalid_input" : "unavailable",
          message: options.delivery === "not_delivered" ? "the payload is illegal" : "transport lost",
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

describe("Composer — steer / follow-up settle like a send", () => {
  // The queued-turn lane now carries the same send-failure judgment as an
  // ordinary prompt: proven non-delivery restores the draft and says so;
  // an unresolved delivery shows the "unconfirmed" copy and keeps the message.
  let lastRerender: ((search: WorkspaceSearch) => void) | null = null;
  beforeEach(() => {
    vi.useFakeTimers();
    SOCKETS.length = 0;
    capturedStore = null;
    lastRerender = null;
    navigateMock.mockReset();
    previousFetch = globalThis.fetch;
    modelsCatalog = { models: [{ provider: "openai", id: "gpt-5", displayName: "GPT-5", contextWindow: 1_000_000 }], defaultModel: null };
    globalThis.fetch = stubFetch();
    window.localStorage.removeItem("pi-streaming-send-mode");
  });
  afterEach(() => { cleanup(); globalThis.fetch = previousFetch; vi.useRealTimers(); });

  /** Mount the live session A while the agent is running so Enter queues a steer. */
  async function mountRunningA(): Promise<FakeWebSocket> {
    const { rerender } = mountApp({ cwd: "/x", session: "A" }, { queryClient: authenticatedQueryClient() });
    lastRerender = rerender;
    const ws = await acceptAutomaticConnection(submitTurnAck());
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A"], busySessionIds: ["A"] } });
      await flush();
    });
    await mountLiveA(ws);
    await act(async () => {
      ws.serverSend({
        type: "event",
        payload: { type: "runtime_capabilities_changed", sessionId: "A", epoch: "e1", eventId: 1, capabilities: { capabilities: [...LIVE_CAPS, "runtime.steer", "runtime.follow_up"], version: 1 } },
      });
      await flush(12);
    });
    await act(async () => {
      ws.serverSend({
        type: "event",
        payload: {
          type: "message_start",
          sessionId: "A",
          epoch: "e1",
          eventId: 2,
          streamId: "s1",
          messageId: "m1",
          message: { role: "assistant", content: [{ type: "text", text: "working" }] },
        },
      });
      await flush(12);
    });
    return ws;
  }

  function lastCommandFrame(ws: FakeWebSocket): { id: string; payload: { command: { commandId: string; type: string; message?: string } } } {
    const frame = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; message?: string } } }>(ws, "command");
    if (!frame) throw new Error("no command frame was sent");
    return frame;
  }

  async function queueWhileRunning(text: string): Promise<void> {
    const textarea = composerTextarea();
    await act(async () => { fireEvent.change(textarea, { target: { value: text } }); await flush(); });
    await act(async () => { fireEvent.keyDown(textarea, { key: "Enter" }); await flush(); });
  }

  it("Enter while the agent runs is ONE send carrying the steer preference, and a transient failure stays silent", async () => {
    // There is no separate steer channel any more: Enter sends the message with
    // `whenBusy` from the「运行中按 Enter」preference and the authority decides.
    const ws = await mountRunningA();
    window.localStorage.setItem("pi-streaming-send-mode", "steer");
    await queueWhileRunning("queued while running");
    await act(async () => {
      for (let i = 0; i < 120 && lastFrame(ws, "submit_turn") === undefined && lastFrame(ws, "command") === undefined; i += 1) await flush(4);
    });
    const submit = lastFrame<{ type: "submit_turn"; id: string; payload: { operationId: string; whenBusy?: string } }>(ws, "submit_turn");
    if (submit !== undefined) expect(submit.payload.whenBusy).toBe("steer");
    const frame = submit ?? lastCommandFrame(ws);
    // The legacy command envelope has no whenBusy field; it delivers the queued
    // turn directly, which is the same intent.
    if (submit === undefined) expect((frame.payload as { command: { type: string } }).command.type).toBe("follow_up");
    await act(async () => {
      ws.serverSend({
        type: submit !== undefined ? "submit_turn_result" : "response",
        id: frame.id,
        payload: submit !== undefined
          ? { status: "rejected", delivery: "not_delivered", sessionId: "A", operationId: submit.payload.operationId, error: { code: "unavailable", message: "sessiond request failed", retryable: true } }
          : { ok: false, error: { code: "unavailable", message: "sessiond request failed", retryable: true } },
      });
      await flush(12);
    });
    // Transient: no copy at all, and the draft stays cleared (still on its way).
    expect(screen.queryByRole("alert")).toBeNull();
    expect(composerTextarea().value).toBe("");
  });

  it("a proven-final steer rejection restores the draft and says it was not sent", async () => {
    const ws = await mountRunningA();
    await queueWhileRunning("queued while running");
    await act(async () => {
      for (let i = 0; i < 120 && lastFrame(ws, "submit_turn") === undefined && lastFrame(ws, "command") === undefined; i += 1) await flush(4);
    });
    const submit = lastFrame<{ type: "submit_turn"; id: string; payload: { operationId: string } }>(ws, "submit_turn");
    const frame = submit ?? lastCommandFrame(ws);
    await act(async () => {
      ws.serverSend({
        type: submit !== undefined ? "submit_turn_result" : "response",
        id: frame.id,
        payload: submit !== undefined
          ? { status: "rejected", delivery: "not_delivered", sessionId: "A", operationId: submit.payload.operationId, error: { code: "invalid_input", message: "illegal", retryable: false } }
          : { ok: false, error: { code: "invalid_input", message: "illegal", retryable: false } },
      });
      await flush(12);
    });
    expect(screen.getByRole("alert").textContent).toContain("The message was not sent");
    expect(composerTextarea().value).toBe("queued while running");
  });


  it("toggling a visible row sends one switch_queued_delivery addressing the runtime queue, not the visible row", async () => {
    const ws = await mountRunningA();
    await act(async () => {
      ws.serverSend({
        type: "event",
        payload: { type: "runtime_capabilities_changed", sessionId: "A", epoch: "e1", eventId: 3, capabilities: { capabilities: [...LIVE_CAPS, "runtime.steer", "runtime.follow_up", "runtime.queue"], version: 2 } },
      });
      await flush(12);
    });
    // A Pixie notice and a user message wait in the runtime queue; the card
    // only renders the user's message.
    await act(async () => {
      ws.serverSend({
        type: "event",
        payload: {
          type: "queue_update",
          sessionId: "A",
          epoch: "e1",
          eventId: 4,
          steering: [],
          followUp: [
            { message: `${ASSISTANT_NOTIFY_MESSAGE_PREFIX}\n\n会话完成` },
            { message: "mine to steer" },
          ],
        },
      });
      await flush(12);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Expand status" }));
      await flush();
    });
    const section = screen.getByTestId("status-queue-section");
    // Row 0 is the user's message even though the assistant notice sits first
    // in the runtime queue: the switch must address the message the row shows,
    // at its FULL-queue coordinates (list followUp, index 1).
    await act(async () => {
      fireEvent.click(within(section).getByRole("button", { name: /Queue: sent after this run/ }));
      await flush();
    });
    const frame = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; list: string; index: number; message: string } } }>(ws, "command")!;
    expect(frame.payload.command).toMatchObject({ type: "switch_queued_delivery", list: "followUp", index: 1, message: "mine to steer" });
    await act(async () => {
      ws.serverSend({ type: "response", id: frame.id, payload: { ok: true, result: { commandId: frame.payload.command.commandId, result: { ok: true, type: "switch_queued_delivery" } } } });
      // The authoritative queue_update moves the entry into steering.
      ws.serverSend({
        type: "event",
        payload: {
          type: "queue_update",
          sessionId: "A",
          epoch: "e1",
          eventId: 5,
          steering: [{ message: "mine to steer" }],
          followUp: [{ message: `${ASSISTANT_NOTIFY_MESSAGE_PREFIX}\n\n会话完成` }],
        },
      });
      await flush(12);
    });
    // Delivery order follows the queue: the moved entry now renders as steer.
    const labels = within(section).getAllByRole("button", { name: /Steer: inserted|Queue: sent/ });
    expect(labels.map((label) => label.className)).toEqual(["status-queue-kind is-steer"]);
    // Nothing was pushed into the input and no clear/steer frames were sent.
    expect(composerTextarea().value).not.toContain("mine to steer");
    expect(lastFrame(ws, "interrupt")).toBeUndefined();
  });

  it("a failed queue switch reverts the label to the authoritative queue and shows the light notice", async () => {
    const ws = await mountRunningA();
    const section = await queueNoticeAndMine(ws);
    await act(async () => {
      fireEvent.click(within(section).getByRole("button", { name: /Queue: sent after this run/ }));
      await flush();
    });
    const frame = lastFrame<{ type: string; id: string; payload: { command: { commandId: string } } }>(ws, "command")!;
    // The queue changed server-side (stale fence): the runtime refuses.
    await act(async () => {
      ws.serverSend({ type: "response", id: frame.id, payload: { ok: true, result: { commandId: frame.payload.command.commandId, result: { ok: false, type: "switch_queued_delivery", error: { code: "conflict", message: "the queued message changed before the switch", retryable: false } } } } });
      await flush(12);
    });
    // The label reverts to follow-up (the projection never changed) and the
    // fixed notice renders inside the queue section.
    const labels = within(section).getAllByRole("button", { name: /Steer: inserted|Queue: sent/ });
    expect(labels.map((label) => label.className)).toEqual(["status-queue-kind is-follow-up"]);
    expect(within(section).getByRole("alert").textContent).toBe("Could not switch the message type; restored");
  });

  /** Queue one notice and one user message, open the card, and return it. */
  async function queueNoticeAndMine(ws: FakeWebSocket): Promise<HTMLElement> {
    await act(async () => {
      ws.serverSend({
        type: "event",
        payload: {
          type: "runtime_capabilities_changed",
          sessionId: "A",
          epoch: "e1",
          eventId: 3,
          capabilities: { capabilities: [...LIVE_CAPS, "runtime.steer", "runtime.follow_up", "runtime.queue"], version: 2 },
        },
      });
      await flush(12);
    });
    await act(async () => {
      ws.serverSend({
        type: "event",
        payload: {
          type: "queue_update",
          sessionId: "A",
          epoch: "e1",
          eventId: 4,
          steering: [],
          followUp: [
            { message: `${ASSISTANT_NOTIFY_MESSAGE_PREFIX}\n\n会话完成` },
            { message: "我自己的消息" },
          ],
        },
      });
      await flush(12);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Expand status" }));
      await flush();
    });
    return screen.getByTestId("status-queue-section");
  }

  it("recall re-queues Pixie's hidden notice even after the session switched away", async () => {
    const ws = await mountRunningA();
    const section = await queueNoticeAndMine(ws);
    await act(async () => {
      fireEvent.click(within(section).getByRole("button", { name: "Recall to input" }));
      await flush();
    });
    const clear = lastFrame<{ type: string; id: string; payload: { commandId: string } }>(ws, "interrupt")!;
    // The clear ack lands after the user moved to another session: the queue is
    // already empty, so it must still be put back.
    // A REAL selection switch: AppShell's search now selects B, so the same
    // editor instance serves B's draft key when the ack lands.
    await act(async () => {
      lastRerender!({ cwd: "/x", session: "B" });
      await flush(16);
    });
    await act(async () => {
      ws.serverSend({ type: "interrupt_result", id: clear.id, payload: { sessionId: "A", commandId: clear.payload.commandId, interruptType: "clear_queue", result: { ok: true, type: "clear_queue" } } });
      await flush(24);
    });
    const requeue = lastFrame<{ type: string; id: string; payload: { command: { type: string; message: string } } }>(ws, "command")!;
    expect(requeue.payload.command.type).toBe("follow_up");
    expect(requeue.payload.command.message).toContain(ASSISTANT_NOTIFY_MESSAGE_PREFIX);
    // The user's own message belongs to session A: it must never be drafted
    // into whatever session the editor is showing now.
    const { getDraft: readDraft } = await import("@/lib/draft-store");
    expect(readDraft("B")?.value ?? "").not.toContain("我自己的消息");
    // A's own draft keeps the recalled message: switching sessions must not
    // lose the user's text along with the cleared queue.
    expect(readDraft("A")?.value ?? "").toContain("我自己的消息");
  });

  it("a failed recall clear is reported instead of silently leaving the queue", async () => {
    const ws = await mountRunningA();
    const section = await queueNoticeAndMine(ws);
    await act(async () => {
      fireEvent.click(within(section).getByRole("button", { name: "Recall to input" }));
      await flush();
    });
    const clear = lastFrame<{ type: string; id: string; payload: { commandId: string } }>(ws, "interrupt")!;
    await act(async () => {
      ws.serverSend({ type: "interrupt_result", id: clear.id, payload: { sessionId: "A", commandId: clear.payload.commandId, interruptType: "clear_queue", result: { ok: false, error: { code: "session_busy", message: "another interrupt is in flight", retryable: false } } } });
      await flush(12);
    });
    expect(screen.getByRole("alert").textContent).toContain("Could not recall messages. The queue is unchanged.");
  });

  it("a Pixie notice that cannot be re-queued comes back without its marker line", async () => {
    const ws = await mountRunningA();
    const section = await queueNoticeAndMine(ws);
    await act(async () => {
      fireEvent.click(within(section).getByRole("button", { name: "Recall to input" }));
      await flush();
    });
    const clear = lastFrame<{ type: string; id: string; payload: { commandId: string } }>(ws, "interrupt")!;
    await act(async () => {
      ws.serverSend({ type: "interrupt_result", id: clear.id, payload: { sessionId: "A", commandId: clear.payload.commandId, interruptType: "clear_queue", result: { ok: true, type: "clear_queue" } } });
      await flush(12);
    });
    // Re-queueing the notice fails: its BODY is recoverable, its marker is not
    // the user's text.
    const requeue = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string } } }>(ws, "command")!;
    await act(async () => {
      ws.serverSend({ type: "response", id: requeue.id, payload: { ok: false, error: { code: "session_busy", message: "queue full", retryable: false } } });
      await flush(12);
    });
    expect(composerTextarea().value).toContain("会话完成");
    expect(composerTextarea().value).not.toContain(ASSISTANT_NOTIFY_MESSAGE_PREFIX);
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
      "sidebar-nav-settings",
    ].filter((id) => document.querySelector(`[data-testid="${id}"]`));
  }

  const catalogCaps: HostInfo["capabilities"] = ["agent", "sessions", "files", "models", "plugins", "skills"];
  // Round 5: pin/archive writes ride the session.write seam (PATCH flags).
  const catalogWriteCaps: HostInfo["capabilities"] = [...catalogCaps, "session.write"];

  it("renders the source hierarchy: Pix, New Session, Projects, Settings + pinned right pane (no Recent section)", async () => {
    mountApp({ cwd: "/x" }, { capabilities: catalogCaps });
    await settle();
    expect(screen.getByTestId("sidebar-brand").textContent).toBe("Pix");
    expect(screen.getByTestId("sidebar-new-session").textContent).toContain("New Session");
    // The Plugins / Resources nav entries were removed; the Settings modal
    // tabs remain reachable from the footer Settings button.
    expect(screen.queryByTestId("sidebar-nav-plugins")).toBeNull();
    expect(screen.queryByTestId("sidebar-nav-resources")).toBeNull();
    expect(screen.getByTestId("sidebar-projects")).toBeTruthy();
    // The standalone "Recent" section is gone: sessions live under their
    // projects (plus search); its testid must not render.
    expect(screen.queryByTestId("sidebar-sessions")).toBeNull();
    expect(screen.queryByTestId("sidebar-files")).toBeNull();
    expect(screen.getByTestId("sidebar-nav-settings").textContent).toBe("Settings");
    // Desktop: the right pane is driven by the icon rail; the corner toggle is
    // mobile-only and no sidebar rail strip exists.
    expect(screen.getByTestId("right-pane-rail")).toBeTruthy();
    expect(screen.queryByTestId("right-pane-toggle")).toBeNull();
    expect(screen.queryByTestId("file-browser-rail")).toBeNull();
    expect(railOrder()).toEqual([
      "sidebar-home-header",
      "sidebar-new-session",
      "sidebar-projects",
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
    expect(dialog.querySelector('[aria-current="page"]')?.textContent).toBe("Appearance");
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
    fireEvent.click(screen.getByTestId("settings-tab-providers"));
    await settle();
    expect(screen.getByText("Global Model")).toBeTruthy();
    expect(screen.getByTestId("settings-tab-skills").hasAttribute("disabled")).toBe(false);
    expect(screen.getByTestId("settings-tab-plugins").hasAttribute("disabled")).toBe(false);
    const modelUrls = (fetchImpl as typeof fetch & {
      mock: { calls: Array<[RequestInfo | URL, RequestInit?]> };
    }).mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes("/v1/models"));
    expect(modelUrls.length).toBeGreaterThan(0);
    expect(modelUrls.every((url) => url === "/v1/models")).toBe(true);
  });

  it("restores an archived session from the settings archive tab", async () => {
    const serverSessions = PROJECT_SESSIONS.map((row) => ({ ...row }));
    const flags: { sessions: Record<string, { pinned?: boolean; archived?: boolean }>; projects: Record<string, { pinned?: boolean; archived?: boolean }> } = { sessions: {}, projects: {} };
    const base = controllableStubFetch({ sessions: serverSessions, workspaceFlags: flags });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/v1/workspace-flags") && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { kind: "session" | "project"; key: string; pinned?: boolean; archived?: boolean };
        const map = body.kind === "session" ? flags.sessions : flags.projects;
        map[body.key] = { ...map[body.key], ...(body.pinned === undefined ? {} : { pinned: body.pinned }), ...(body.archived === undefined ? {} : { archived: body.archived }) };
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return base(input, init);
    }) as unknown as typeof fetch;
    mountApp({ cwd: "/x" }, { capabilities: catalogWriteCaps });
    await settle();
    const sessionRow = screen.getByTestId("session-select-A").closest(".sidebar-list-row") as HTMLElement;
    fireEvent.click(within(sessionRow).getByLabelText("Archive"));
    expect(screen.queryByTestId("session-select-A")).toBeNull();
    fireEvent.click(screen.getByTestId("sidebar-nav-settings"));
    fireEvent.click(screen.getByTestId("settings-tab-archive"));
    await settle();
    expect(screen.getByTestId("archive-row")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await settle();
    expect(screen.getByTestId("session-select-A")).toBeTruthy();
  });

  it("does not reveal an archived subagent in Settings", async () => {
    const now = Date.now();
    globalThis.fetch = controllableStubFetch({
      sessions: [
        { sessionId: "parent", cwd: "/x", projectRoot: "/x", title: "Parent session", createdAt: 1000, updatedAt: now, messageCount: 1, workspaceAccess: AUTHORIZED },
        { sessionId: "child", cwd: "/x", projectRoot: "/x", title: "Hidden child", parentSessionId: "parent", createdAt: 1000, updatedAt: now + 1, messageCount: 1, archived: true, workspaceAccess: AUTHORIZED },
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

  it("enables New Session on a session URL without cwd and navigates to a blank draft", async () => {
    mountApp({ session: "A" }, { capabilities: catalogCaps });
    const ws = await connectReady();
    await settle();
    const button = screen.getByTestId("sidebar-new-session") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.title).toBe("New Session");
    fireEvent.click(button);
    await settle();
    expect(navigateMock).toHaveBeenCalledWith({ to: "/", search: {} });
    expect(countType(ws, "create")).toBe(0);
    expect(countType(ws, "activate")).toBe(0);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "submit_turn")).toHaveLength(0);
  });

  it("enables New Session on home without cwd", async () => {
    mountApp({}, { capabilities: catalogCaps });
    await settle();
    const button = screen.getByTestId("sidebar-new-session") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.title).toBe("New Session");
  });

  it("keeps New Session disabled without the agent capability", async () => {
    mountApp({ session: "A" }, { capabilities: ["sessions", "files", "models"] });
    await settle();
    expect((screen.getByTestId("sidebar-new-session") as HTMLButtonElement).disabled).toBe(true);
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
      await flush(12);
    });

    // Identity-only create → B's first send is ONE submit_turn on its own lane:
    // no detach/attach chain first, so auxiliary reads cannot steal it.
    const prompt = await waitForSubmitTurn(ws);
    expect(prompt.payload.sessionId).toBe("new-button");
    expect(prompt.payload.prompt).toBe("first after button");
    expect(countCommandFrames(ws, "prompt")).toBe(0);
    expect(navigateMock).toHaveBeenLastCalledWith({ to: "/", search: { cwd: "/x", session: "new-button" } });
    expect(screen.queryByTestId("session-select-new-button")).toBeNull();
    expect(view.queryClient.getQueryData(queryKeys.sessions.detail("new-button"))).toBeTruthy();
    // The create-time invalidation was intentionally removed: JSONL is not
    // catalog-visible yet. The turn's terminal status owns the sidebar refresh.
    invalidateSpy.mockClear();
    await acceptSubmitTurn(ws, { sessionId: "new-button" });
    await completeSubmitTurn(ws, prompt, "new-button");
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
    const firstPrompt = await waitForSubmitTurn(ws);
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
    });
    // B's first send is its own submit_turn; A's in-flight send never makes it session_busy.
    await act(async () => {
      for (let i = 0; i < 80 && ws.sent.filter((f) => (f as { type?: string }).type === "submit_turn").length < 2; i += 1) await flush(4);
    });
    const prompts = ws.sent.filter((frame) => (frame as { type?: string }).type === "submit_turn") as SubmitTurnFrame[];
    expect(prompts.map((frame) => frame.payload.sessionId)).toEqual(["A", "new-busy-b"]);
    expect(prompts[1]!.payload.prompt).toBe("first on B");
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

  it("keeps the typed draft when a project is picked afterwards", async () => {
    // The new-session composer has no draft identity until a project is
    // chosen; picking one must not throw the pending text away.
    const cwd = "/Users/alice/Documents/program/demo-app";
    const view = mountApp({});
    navigateMock.mockImplementation(async (options: { search: WorkspaceSearch }) => {
      view.rerender(options.search);
      await flush();
    });
    await connectReady();
    await settle();

    const textarea = document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "keep this draft" } });

    fireEvent.click(screen.getByLabelText("Select project"));
    fireEvent.click(screen.getByRole("button", { name: "Custom path…" }));
    const input = screen.getByRole("textbox", { name: "Custom path…" });
    fireEvent.change(input, { target: { value: cwd } });
    fireEvent.keyDown(input, { key: "Enter" });
    await settle();

    expect(navigateMock).toHaveBeenLastCalledWith({ to: "/", search: { cwd } });
    expect((document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement).value).toBe("keep this draft");
  });

  it("browses a server folder, preserves the draft, and never activates a worker", async () => {
    clearDraft("new:/x");
    clearDraft("new:/repo");
    const baseline = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const p = String(input);
      if (p.includes("/v1/cwd/roots")) return json({ roots: ["/x", "/repo"], defaultCwd: "/x" });
      if (p.includes("/v1/cwd/browse")) {
        const path = new URL(p, "http://pix.local").searchParams.get("path");
        if (path === "/x") return json({ path: "/x", parentPath: null, directories: ["draft-child"] });
        if (path === "/x/draft-child") return json({ path, parentPath: "/x", directories: [] });
        if (path === "/repo") return json({ path: "/repo", parentPath: null, directories: [] });
        return jsonStatus({ error: "not found", code: "PATH_NOT_FOUND" }, 404);
      }
      return baseline(input, init);
    }) as typeof fetch;
    const view = mountApp({ cwd: "/x" }, { capabilities: catalogCaps });
    navigateMock.mockImplementation(async (options: { search: WorkspaceSearch }) => {
      view.rerender(options.search);
      await flush();
    });
    const ws = await connectReady();
    await settle();

    const textarea = document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "keep this draft" } });
    await act(async () => { await flush(2); });
    expect(getDraft("new:/x")?.value).toBe("keep this draft");

    fireEvent.click(screen.getByLabelText("Select project"));
    fireEvent.click(screen.getByRole("button", { name: "Browse folders…" }));
    await settle();
    expect(screen.getByRole("dialog")).toBeTruthy();
    // Starts at the current cwd because /x is an authorized root.
    expect(screen.getByText("draft-child")).toBeTruthy();
    // Navigate into a subfolder, then switch to another authorized root.
    fireEvent.click(screen.getByTestId("folder-browser-directory"));
    await settle();
    fireEvent.click(screen.getAllByTestId("folder-browser-root")[1]!);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Select folder" }));
    await settle();

    expect(navigateMock).toHaveBeenLastCalledWith({ to: "/", search: { cwd: "/repo" } });
    expect((document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement).value).toBe("keep this draft");
    expect(countType(ws, "create")).toBe(0);
    expect(countType(ws, "attach")).toBe(0);
    expect(countType(ws, "activate")).toBe(0);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "submit_turn")).toHaveLength(0);
    clearDraft("new:/x");
    clearDraft("new:/repo");
  });

  it("does not offer server folder browsing without the files capability", async () => {
    mountApp({ cwd: "/x" }, { capabilities: ["agent", "sessions", "models"] });
    await settle();
    fireEvent.click(screen.getByLabelText("Select project"));
    // The manual path stays available; only the server browser is gated.
    expect(screen.getByRole("button", { name: "Custom path…" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Browse folders…" })).toBeNull();
  });

  it("drops the select-a-project error once a project is picked", async () => {
    const cwd = "/Users/alice/Documents/program/demo-app";
    const view = mountApp({});
    navigateMock.mockImplementation(async (options: { search: WorkspaceSearch }) => {
      view.rerender(options.search);
      await flush();
    });
    await connectReady();
    await settle();

    // Sending without a project fails closed with invalid_input.
    const textarea = document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    await act(async () => { await flush(8); });
    expect(screen.getByRole("alert").textContent).toContain("Select a project first");

    fireEvent.click(screen.getByLabelText("Select project"));
    fireEvent.click(screen.getByRole("button", { name: "Custom path…" }));
    const input = screen.getByRole("textbox", { name: "Custom path…" });
    fireEvent.change(input, { target: { value: cwd } });
    fireEvent.keyDown(input, { key: "Enter" });
    await settle();

    // The precondition is gone: the stale error must not keep hanging.
    expect(screen.queryByText(/Select a project first/)).toBeNull();
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
    });

    // Identity-only create → the home's first send targets new-home, never A.
    const prompt = await waitForSubmitTurn(ws);
    expect(ws.sent.filter((f) => (f as { type?: string }).type === "submit_turn")).toHaveLength(1);
    expect(prompt.payload.sessionId).toBe("new-home");
    expect(prompt.payload.prompt).toBe("first from home");
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

  it("recent projects start expanded by default; clicking collapses in place without changing cwd", async () => {
    mountApp({ cwd: "/x" });
    await settle();
    const rows = screen.getAllByTestId("sidebar-project-row");
    const current = rows.find((row) => row.textContent === "x");
    const other = rows.find((row) => row.textContent === "y");
    expect(current).toBeTruthy();
    expect(other).toBeTruthy();
    // Both projects were active within the last three days → expanded by default.
    expect(current!.getAttribute("aria-expanded")).toBe("true");
    expect(other!.getAttribute("aria-expanded")).toBe("true");
    const otherCard = other!.closest("[data-testid=sidebar-project-card]") as HTMLElement;
    expect(within(otherCard).getByText("Session D")).toBeTruthy();
    fireEvent.click(other!);
    await settle();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(other!.getAttribute("aria-expanded")).toBe("false");
    expect(otherCard.getAttribute("data-expanded")).toBe("false");
    // The collapsed body stays mounted for the height transition but is closed.
    expect(otherCard.querySelector('[data-testid="sidebar-project-sessions"]')?.getAttribute("data-open")).toBe("false");
    fireEvent.click(other!);
    await settle();
    expect(other!.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByTestId("session-select-A").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("session-select-D").length).toBeGreaterThan(0);
    expect(screen.getByTestId("right-pane-rail")).toBeTruthy();
  });

  it("projects expand by recency default only; an explicit collapse persists", async () => {
    const now = Date.now();
    const sessions: SessionHeader[] = [
      { sessionId: "fresh", cwd: "/fresh", projectRoot: "/fresh", title: "Fresh session", createdAt: 1000, updatedAt: now, messageCount: 1, workspaceAccess: AUTHORIZED },
      { sessionId: "stale", cwd: "/stale", projectRoot: "/stale", title: "Stale session", createdAt: 1000, updatedAt: now - 5 * 24 * 60 * 60 * 1000, messageCount: 1, workspaceAccess: AUTHORIZED },
    ];
    globalThis.fetch = controllableStubFetch({ sessions });
    mountApp({ cwd: "/fresh" });
    await settle();
    const row = (root: string) => screen.getAllByTestId("sidebar-project-row").find((r) => r.getAttribute("title") === root)!;
    // Active within 3 days → expanded; older → collapsed until opened by hand.
    expect(row("/fresh").getAttribute("aria-expanded")).toBe("true");
    expect(row("/stale").getAttribute("aria-expanded")).toBe("false");
    expect(within(screen.getAllByTestId("sidebar-project-card")[0]!).getByTestId("session-select-fresh")).toBeTruthy();
    // Collapsing the recent project records an explicit collapse that wins
    // over the recency default — and expanding the stale one records the opposite.
    fireEvent.click(row("/fresh"));
    fireEvent.click(row("/stale"));
    await settle();
    expect(row("/fresh").getAttribute("aria-expanded")).toBe("false");
    expect(row("/stale").getAttribute("aria-expanded")).toBe("true");
    expect(JSON.parse(window.localStorage.getItem("pi-sidebar-item-state") ?? "{}")).toMatchObject({
      expandedProjects: ["/stale"],
      collapsedProjects: ["/fresh"],
    });
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

    await waitForSubmitTurn(ws);
    await acceptSubmitTurn(ws, { sessionId: "A" });
    // Admission is not a terminal state: indicators stay running until an
    // authoritative event takes ownership, so there is no ack→agent_start blink.
    expect(screen.getByRole("tab", { name: "Session A" }).getAttribute("data-running")).toBe("true");
  });

  it("collapsed project rows summarize a waiting session, then the running spinner", async () => {
    globalThis.fetch = controllableStubFetch({ sessions: PROJECT_SESSIONS });
    mountApp({ cwd: "/x" }, { queryClient: authenticatedQueryClient() });
    const ws = await acceptAutomaticConnection(watchAck());
    await settle();
    const row = () => screen.getAllByTestId("sidebar-project-row").find((r) => r.getAttribute("title") === "/x")!;
    const rowEl = () => row().closest(".sidebar-list-row") as HTMLElement;
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["A"], busySessionIds: [], waitingSessionIds: ["A"] } });
      await flush(4);
    });
    // Expanded (recency default): no summary on the project row — the
    // session rows own their markers.
    expect(rowEl().querySelector(".session-status-dot")).toBeNull();
    // Collapsed: the waiting dot summarizes the project.
    fireEvent.click(row());
    await settle();
    expect(rowEl().querySelector('.session-status-dot[data-status="waiting"]')).toBeTruthy();
    // Busy outranks waiting on the same project: the spinner replaces the dot.
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 2, sessionIds: ["A"], busySessionIds: ["A"], waitingSessionIds: [] } });
      await flush(4);
    });
    expect(rowEl().querySelector(".session-status-dot")).toBeNull();
    expect(rowEl().querySelector(".sidebar-row-status")).toBeTruthy();
    expect(rowEl().getAttribute("data-running")).toBe("true");
    // Re-expanding hides the summary again (the session row owns the marker).
    fireEvent.click(row());
    await settle();
    expect(rowEl().querySelector(".sidebar-row-status")).toBeNull();
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
    // Round 5: session flags are SERVER state — the stub answers PATCH
    // /v1/sessions/:id by applying {pinned}/{archived} to the row and the
    // client refetches the list (mutation onSuccess invalidation).
    const serverSessions = PROJECT_SESSIONS.map((row) => ({ ...row }));
    const base = controllableStubFetch({ sessions: serverSessions });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const patchMatch = path.match(/\/v1\/sessions\/([^/?]+)$/);
      if (init?.method === "PATCH" && patchMatch) {
        const body = JSON.parse(String(init.body)) as { pinned?: boolean; archived?: boolean };
        const target = serverSessions.find((row) => row.sessionId === patchMatch[1]);
        if (target) Object.assign(target, body);
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return base(input, init);
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchImpl;
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

  it("hides parent-linked subagents from the project body and the search palette", async () => {
    const now = Date.now();
    globalThis.fetch = controllableStubFetch({
      sessions: [
        { sessionId: "parent", cwd: "/x", projectRoot: "/x", title: "Parent session", createdAt: 1000, updatedAt: now, messageCount: 1, workspaceAccess: AUTHORIZED },
        { sessionId: "child", cwd: "/x", projectRoot: "/x", title: "Child session", parentSessionId: "parent", createdAt: 1000, updatedAt: now + 1, messageCount: 1, workspaceAccess: AUTHORIZED },
      ],
    });
    mountApp({ cwd: "/x" });
    await settle();
    const projectSessions = screen.getByTestId("sidebar-project-sessions");
    expect(within(projectSessions).getByTestId("session-select-parent")).toBeTruthy();
    expect(within(projectSessions).queryByTestId("session-select-child")).toBeNull();
    // The ⌘K palette searches the same browse-visible roots — the fork never
    // surfaces (the sidebar's inline filter is gone).
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = screen.getByTestId("search-palette-input");
    fireEvent.change(input, { target: { value: "Child" } });
    await act(async () => { vi.advanceTimersByTime(200); });
    await settle();
    expect(within(screen.getByTestId("search-palette-results")).queryByText("Child session")).toBeNull();
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

  it("keeps project session order stable when selecting an older session", async () => {
    const now = Date.now();
    globalThis.fetch = controllableStubFetch({
      sessions: [
        { sessionId: "newer", cwd: "/x", projectRoot: "/x", title: "Newer", createdAt: 1000, updatedAt: now, messageCount: 1, workspaceAccess: AUTHORIZED },
        { sessionId: "older", cwd: "/x", projectRoot: "/x", title: "Older", createdAt: 1000, updatedAt: now - 1000, messageCount: 1, workspaceAccess: AUTHORIZED },
      ],
    });
    const view = mountApp({ cwd: "/x", session: "older" });
    await settle();
    const order = (container: HTMLElement) => Array.from(container.querySelectorAll("[data-testid^='session-select-']"))
      .map((row) => row.getAttribute("data-testid"));
    expect(order(screen.getByTestId("sidebar-project-sessions"))).toEqual(["session-select-newer", "session-select-older"]);
    view.rerender({ cwd: "/x", session: "newer" });
    await settle();
    view.rerender({ cwd: "/x", session: "older" });
    await settle();
    expect(order(screen.getByTestId("sidebar-project-sessions"))).toEqual(["session-select-newer", "session-select-older"]);
  });

  it("the ⌘K palette searches server-side; Esc closes and the sidebar sections stay put", async () => {
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
    // The sidebar no longer mounts an inline search field — the magnifier
    // opens the palette instead.
    expect(screen.queryByTestId("sidebar-search-field")).toBeNull();
    fireEvent.click(screen.getByTestId("sidebar-search"));
    const input = screen.getByTestId("search-palette-input");
    expect(screen.getByTestId("search-palette")).toBeTruthy();
    // Typing fires a server-side keyword request (debounced 150ms — advance
    // the suite's fake timers past the debounce, then settle the query).
    fireEvent.change(input, { target: { value: "Session 4" } });
    await act(async () => { vi.advanceTimersByTime(200); });
    await settle();
    expect(countMockFetchCalls(fetchImpl, "query=Session+4")).toBeGreaterThanOrEqual(1);
    const results = screen.getByTestId("search-palette-results");
    expect(within(results).getByText("Session 4")).toBeTruthy();
    expect(within(results).queryByText("Session 1")).toBeNull();
    // The palette is an overlay: sidebar sections never move.
    expect(screen.getByTestId("sidebar-projects")).toBeTruthy();
    fireEvent.change(input, { target: { value: "zzz" } });
    await act(async () => { vi.advanceTimersByTime(200); });
    await settle();
    expect(screen.getByTestId("search-palette-empty")).toBeTruthy();
    // Esc closes the palette (the input survives for the next open).
    fireEvent.keyDown(input, { key: "Escape" });
    await settle();
    expect(screen.queryByTestId("search-palette")).toBeNull();
    expect(screen.getByTestId("sidebar-projects")).toBeTruthy();
    // Re-open with ⌘K: the previous query and its result are still there.
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await settle();
    expect((screen.getByTestId("search-palette-input") as HTMLInputElement).value).toBe("zzz");
    // ⌘K again toggles it closed.
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await settle();
    expect(screen.queryByTestId("search-palette")).toBeNull();
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
      expandedProjects: ["/persisted-project-12"],
    }));
    const fetchImpl = controllableStubFetch({ sessions: many, workspaceFlags: { projects: { "/persisted-project-12": { pinned: true } } } });
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

  it("restores a pinned session outside the initial project rows", async () => {
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
    globalThis.fetch = controllableStubFetch({ sessions: many, workspaceFlags: { sessions: { PS12: { pinned: true } } } });
    mountApp({ cwd: "/x" });
    await settle();

    expect(within(screen.getByTestId("sidebar-pinned")).getByTestId("session-select-PS12")).toBeTruthy();
    // The project body reveals only the first three scoped roots; PS12
    // (never paged in) stays out of it.
    expect(within(screen.getByTestId("sidebar-project-sessions")).queryByTestId("session-select-PS12")).toBeNull();
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
    const fetchImpl = controllableStubFetch({
      sessions: many,
      workspaceFlags: { projects: Object.fromEntries(many.slice(0, 10).map((session) => [session.projectRoot, { archived: true }])) },
    });
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

  it("shows three project sessions initially, then five more per click with scoped paging", async () => {
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
    // /x is recent → expanded by default; only the first three roots render.
    const nested = screen.getByTestId("sidebar-project-sessions");
    expect(within(nested).getByTestId("session-select-G1")).toBeTruthy();
    expect(within(nested).getByTestId("session-select-G3")).toBeTruthy();
    expect(within(nested).queryByTestId("session-select-G4")).toBeNull();
    expect(countMockFetchCalls(fetchImpl, "/v1/sessions?page=1&pageSize=5&projectRoot=%2Fx")).toBe(1);
    // One click reveals five more roots and loads the next scoped page.
    fireEvent.click(within(nested).getByTestId("project-/x-load-more"));
    await settle();
    expect(within(nested).getByTestId("session-select-G1")).toBeTruthy();
    expect(within(nested).getByTestId("session-select-G8")).toBeTruthy();
    expect(within(nested).queryByTestId("session-select-G9")).toBeNull();
    expect(countMockFetchCalls(fetchImpl, "/v1/sessions?page=2&pageSize=5&projectRoot=%2Fx")).toBe(1);
    // A second click outreaches the loaded pages again and pulls page 3 in;
    // with every root visible the button disappears (no counts are shown).
    fireEvent.click(within(nested).getByTestId("project-/x-load-more"));
    await settle();
    expect(within(nested).getByTestId("session-select-G12")).toBeTruthy();
    expect(countMockFetchCalls(fetchImpl, "/v1/sessions?page=3&pageSize=5&projectRoot=%2Fx")).toBe(1);
    expect(within(nested).queryByTestId("project-/x-load-more")).toBeNull();
    expect(within(nested).queryByText(/\d+ \//)).toBeNull();
  });

  it("shows an honest nested Sessions error and retries its first scoped page", async () => {
    const fetchImpl = controllableStubFetch({
      sessions: PROJECT_SESSIONS,
      projectSessionsError: { status: 503, body: { code: "SESSIONS_UNAVAILABLE", message: "unavailable" } },
    });
    globalThis.fetch = fetchImpl;
    mountApp({ cwd: "/x" });
    await settle();
    // /x is recent → expanded by default: the scoped page fires without a click.
    const project = screen.getAllByTestId("sidebar-project-row").find((row) => row.getAttribute("title") === "/x")!;
    expect(project.getAttribute("aria-expanded")).toBe("true");
    const card = project.closest("[data-testid=sidebar-project-card]") as HTMLElement;
    const nested = within(card).getByTestId("sidebar-project-sessions");
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
    const archivedIds = grouped.slice(0, 5).map((session) => session.sessionId);
    const fetchImpl = controllableStubFetch({
      sessions: grouped,
      workspaceFlags: { sessions: Object.fromEntries(archivedIds.map((id) => [id, { archived: true }])) },
    });
    globalThis.fetch = fetchImpl;
    mountApp({ cwd: "/x" });
    await settle();
    // /x is recent → expanded by default; the archived first page leaves the
    // body empty but Load more stays reachable (scoped pages remain).
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
    // The project body reveals only the first three scoped roots; the
    // deep-linked D55 stays out-of-band (exact detail only).
    const nested = screen.getByTestId("sidebar-project-sessions");
    expect(within(nested).getByTestId("session-select-D1")).toBeTruthy();
    expect(within(nested).queryByTestId("session-select-D4")).toBeNull();
    expect(within(nested).queryByTestId("session-select-D55")).toBeNull();
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
  function fileFetch(read: { content: string; language: string } = { content: "AAAA", language: "text" }): typeof fetch {
    return vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : input instanceof URL ? `${input.pathname}${input.search}` : input.url;
      const p = String(path);
      if (p.includes("/v1/gate/status")) return json({ status: "enabled", required: false, authenticated: false, mode: "local" });
      if (p.includes("/v1/workspace-flags")) return json({ revision: 0, sessions: {}, projects: {} });
      if (p.includes("op=read")) return json({ ...read, size: read.content.length });
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
    // The drawer mounts the sidebar fresh: settle the projects → scoped
    // sessions query chain before querying rows.
    await settle();
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

  it("loads titles for persisted tabs outside the initial session page", async () => {
    const sessions: SessionHeader[] = Array.from({ length: 7 }, (_, index) => ({
      sessionId: `T${index + 1}`,
      cwd: "/x",
      projectRoot: "/x",
      title: `Tab session ${index + 1}`,
      createdAt: 1000,
      updatedAt: Date.now() - index * 1000,
      messageCount: 1,
      workspaceAccess: AUTHORIZED,
    }));
    window.localStorage.setItem(WORKSPACE_SESSION_TABS_STORAGE_KEY, JSON.stringify({
      version: 1,
      sessions: [{ sessionId: "T7", cwd: "/x" }],
    }));
    const fetchImpl = controllableStubFetch({ sessions });
    globalThis.fetch = fetchImpl;
    mountApp({ cwd: "/x" });
    await settle();

    expect(screen.getByRole("tab", { name: "Tab session 7" })).toBeTruthy();
    expect(countMockFetchCalls(fetchImpl, "/v1/sessions/T7")).toBeGreaterThanOrEqual(1);
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

  it("opens a persisted child Agent session from the compact card in the shared right pane", async () => {
    const parent: SessionHeader = {
      sessionId: "parent",
      sessionFile: "/sessions/parent.jsonl",
      cwd: "/x",
      projectRoot: "/x",
      title: "Parent",
      createdAt: 1000,
      updatedAt: Date.now(),
      messageCount: 3,
      workspaceAccess: AUTHORIZED,
    };
    const child: SessionHeader = {
      sessionId: "child",
      sessionFile: "/sessions/child.jsonl",
      cwd: "/x",
      projectRoot: "/x",
      title: "Child agent",
      parentSessionId: "parent",
      createdAt: 2000,
      updatedAt: Date.now(),
      messageCount: 1,
      workspaceAccess: AUTHORIZED,
    };
    const contextEntries = new Map<string, SessionEntry[]>([
      // No Agent tool call/result exists in parent history. The card must come
      // only from the authority snapshot below.
      ["parent", []],
      ["child", []],
    ]);
    const contextCalls: string[] = [];
    const fetchImpl = controllableStubFetch({ sessions: [parent, child], contextEntries, contextCalls });
    globalThis.fetch = fetchImpl;
    mountApp({ cwd: "/x", session: "parent" });
    const ws = await connectReady();
    await act(async () => {
      void capturedStore!.openSession("parent").catch(() => undefined);
      const attach = await waitForAttach(ws, "parent");
      ws.serverSend({
        type: "snapshot",
        id: attach.id,
        payload: snapshotPayload({
          sessionId: "parent",
          capabilities: ["runtime.prompt", "runtime.subagents"],
          subagents: {
            revision: 1,
            tasks: [{
              taskId: "task-1",
              description: "Inspect runtime",
              agentType: "Explore",
              status: "running",
              startedAt: Date.parse("2026-09-27T00:00:00.000Z"),
              childSessionId: "child",
            }],
          },
        }),
      });
      await flush();
    });
    await settle();
    await act(async () => {
      ws.serverSend({
        type: "event",
        payload: {
          type: "subagents_changed",
          sessionId: "parent",
          epoch: "e1",
          eventId: 1,
          subagents: {
            revision: 2,
            tasks: [{
              taskId: "task-1",
              description: "Inspect runtime live",
              agentType: "Explore",
              status: "running",
              startedAt: Date.parse("2026-09-27T00:00:00.000Z"),
              childSessionId: "child",
            }],
          },
        },
      });
      await flush();
    });

    const parentTranscriptScroll = transcriptScrollRef.current;
    const conversation = document.querySelector(".conversation-container");
    expect(parentTranscriptScroll).toBeTruthy();
    expect(conversation).toBeTruthy();
    expect(screen.getByTestId("subagent-activity-card").closest(".conversation-container")).toBe(conversation);
    expect(screen.getByTestId("subagent-activity-card").closest(".app-title-bar")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand status" }));
    expect(screen.getByRole("button", { name: "Expand status" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Open agent Inspect runtime live" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open agent Inspect runtime live" }));
    await settle();

    expect(screen.getByTestId("subagent-activity-card").closest(".conversation-container")).toBe(conversation);
    expect(screen.getByTestId("subagent-activity-card").closest(".app-title-bar")).toBeNull();
    expect(screen.getByTestId("subagent-panel")).toBeTruthy();
    expect(document.querySelector(".right-panel-container")?.className).toContain("right-panel-open");
    expect(screen.getByTestId("right-pane-rail").getAttribute("aria-label")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Agents" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getAllByText("Inspect runtime live").length).toBeGreaterThanOrEqual(1);
    expect(contextCalls).toContain("child");
    expect(transcriptScrollRef.current).toBe(parentTranscriptScroll);
    expect(countMockFetchCalls(fetchImpl, "parentSessionId=parent")).toBe(0);
    const childAttaches = ws.sent.filter((frame) => (
      (frame as { type?: string; payload?: { sessionId?: string } }).type === "attach"
      && (frame as { payload?: { sessionId?: string } }).payload?.sessionId === "child"
    ));
    expect(childAttaches).toHaveLength(0);

    const childCallsBeforeRevision = contextCalls.filter((id) => id === "child").length;
    await act(async () => {
      ws.serverSend({
        type: "event",
        payload: {
          type: "subagents_changed",
          sessionId: "parent",
          epoch: "e1",
          eventId: 2,
          subagents: {
            revision: 3,
            tasks: [{
              taskId: "task-1",
              description: "Inspect runtime live",
              agentType: "Explore",
              status: "running",
              startedAt: Date.parse("2026-09-27T00:00:00.000Z"),
              childSessionId: "child",
            }],
          },
        },
      });
      await flush();
    });
    await settle();
    expect(contextCalls.filter((id) => id === "child")).toHaveLength(childCallsBeforeRevision + 1);
    expect(transcriptScrollRef.current).toBe(parentTranscriptScroll);
    expect(ws.sent.filter((frame) => (
      (frame as { type?: string; payload?: { sessionId?: string } }).type === "attach"
      && (frame as { payload?: { sessionId?: string } }).payload?.sessionId === "child"
    ))).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(screen.queryByTestId("subagent-panel")).toBeNull();
    expect(screen.getByRole("button", { name: "Files" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("opens side chat only for the exact live parent, preserves it across pane close, and closes on parent switch", async () => {
    const sessions: readonly SessionHeader[] = [
      { sessionId: "parent", cwd: "/x", projectRoot: "/x", title: "Parent", createdAt: 1000, updatedAt: Date.now(), messageCount: 1, workspaceAccess: AUTHORIZED },
      { sessionId: "B", cwd: "/x", projectRoot: "/x", title: "Session B", createdAt: 1000, updatedAt: Date.now(), messageCount: 1, workspaceAccess: AUTHORIZED },
    ];
    globalThis.fetch = controllableStubFetch({ sessions, contextEntries: new Map([["parent", []], ["B", []]]) });
    const { rerender } = mountApp({ cwd: "/x", session: "parent" });
    const ws = await connectReady();
    await act(async () => {
      void capturedStore!.openSession("parent").catch(() => undefined);
      const attach = await waitForAttach(ws, "parent");
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "parent", capabilities: ["runtime.prompt", "runtime.abort", "runtime.side_chat"] }) });
      await flush();
    });
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Side chat" }));
    await act(async () => { await flush(8); });
    const starts = () => ws.sent.filter((frame) => (
      (frame as { type?: string; payload?: { command?: { type?: string } } }).type === "command"
      && (frame as { payload?: { command?: { type?: string } } }).payload?.command?.type === "side_chat_start"
    )) as Array<{ id: string; payload: { command: { commandId: string } } }>;
    expect(starts()).toHaveLength(1);
    const start = starts()[0]!;
    await act(async () => {
      ws.serverSend({
        type: "event",
        payload: {
          type: "side_chat_changed",
          sessionId: "parent",
          epoch: "e1",
          eventId: 1,
          sideChat: {
            conversationId: "side-1",
            revision: 1,
            runId: "run-1",
            model: { provider: "anthropic", id: "claude-sonnet" },
            thinkingLevel: "medium",
            status: "running",
            messages: [{ role: "user", content: "Side question" }],
            messagesTruncated: false,
            totalCharsTruncated: false,
            partialMessage: {
              role: "assistant",
              content: [{ type: "text", text: "Side response" }],
              model: "claude-sonnet",
              provider: "anthropic",
            },
          },
        },
      });
      ws.serverSend({ type: "response", id: start.id, payload: { ok: true, result: { commandId: start.payload.command.commandId, result: { ok: true, type: "side_chat_start", conversationId: "side-1" } } } });
      await flush();
    });
    expect(screen.getByTestId("side-chat-panel").textContent).toContain("Side response");
    expect((document.querySelector(".chat-input-textarea") as HTMLTextAreaElement).disabled).toBe(false);
    await act(async () => {
      ws.serverSend({
        type: "event",
        payload: {
          type: "side_chat_delta",
          sessionId: "parent",
          epoch: "e1",
          eventId: 2,
          delta: {
            conversationId: "side-1",
            runId: "run-1",
            previousRevision: 1,
            revision: 2,
            partial: {
              role: "assistant",
              content: [{ type: "text", text: "Side response continued" }],
              model: "claude-sonnet",
              provider: "anthropic",
            },
          },
        },
      });
      await flush();
      vi.advanceTimersByTime(1_000);
      await flush();
    });
    expect(screen.getByTestId("side-chat-panel").textContent).toContain("Side response continued");

    fireEvent.click(screen.getByRole("button", { name: "Side chat" }));
    expect(screen.queryByTestId("side-chat-panel")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Side chat" }));
    expect(screen.getByTestId("side-chat-panel").textContent).toContain("Side response");
    expect(starts()).toHaveLength(1);

    rerender({ cwd: "/x", session: "B" });
    await settle();
    expect((screen.getByRole("button", { name: "Side chat" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Side chat" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("side-chat-panel")).toBeNull();
    expect(ws.sent.filter((frame) => (frame as { type?: string; payload?: { sessionId?: string } }).type === "attach" && (frame as { payload?: { sessionId?: string } }).payload?.sessionId === "B")).toHaveLength(0);
  });

  it("hides Pixie's own queued prompts from the Status capsule but keeps the user's", async () => {
    const parent: SessionHeader = {
      sessionId: "parent",
      sessionFile: "/sessions/parent.jsonl",
      cwd: "/x",
      projectRoot: "/x",
      title: "Parent",
      createdAt: 1000,
      updatedAt: Date.now(),
      messageCount: 3,
      workspaceAccess: AUTHORIZED,
    };
    globalThis.fetch = controllableStubFetch({ sessions: [parent], contextEntries: new Map([["parent", []]]) });
    mountApp({ cwd: "/x", session: "parent" });
    const ws = await connectReady();
    await act(async () => {
      void capturedStore!.openSession("parent").catch(() => undefined);
      const attach = await waitForAttach(ws, "parent");
      ws.serverSend({
        type: "snapshot",
        id: attach.id,
        payload: snapshotPayload({
          sessionId: "parent",
          capabilities: [...LIVE_CAPS, "runtime.steer", "runtime.follow_up", "runtime.queue"],
          queuedMessages: {
            steering: [{ message: "去修测试" }],
            followUp: [{ message: `${ASSISTANT_NOTIFY_MESSAGE_PREFIX}\n\n会话完成` }, { message: "我自己的后续" }],
          },
        }),
      });
      await flush();
    });
    await settle();
    // Assistant-marked items still sit in the runtime queue; the card only
    // counts and lists what the user typed.
    const capsule = screen.getByRole("button", { name: "Expand status" });
    expect(capsule.textContent).toContain("2 queued");
    fireEvent.click(capsule);
    const section = screen.getByTestId("status-queue-section");
    expect(within(section).queryByText(/会话完成/)).toBeNull();
    expect(within(section).getByText("我自己的后续")).toBeTruthy();
  });

  it("updates the Status capsule from snapshot Todo then todo_changed through the production reducer", async () => {
    const parent: SessionHeader = {
      sessionId: "parent",
      sessionFile: "/sessions/parent.jsonl",
      cwd: "/x",
      projectRoot: "/x",
      title: "Parent",
      createdAt: 1000,
      updatedAt: Date.now(),
      messageCount: 3,
      workspaceAccess: AUTHORIZED,
    };
    const fetchImpl = controllableStubFetch({ sessions: [parent], contextEntries: new Map([["parent", []]]) });
    globalThis.fetch = fetchImpl;
    mountApp({ cwd: "/x", session: "parent" });
    const ws = await connectReady();
    await act(async () => {
      void capturedStore!.openSession("parent").catch(() => undefined);
      const attach = await waitForAttach(ws, "parent");
      ws.serverSend({
        type: "snapshot",
        id: attach.id,
        payload: snapshotPayload({
          sessionId: "parent",
          capabilities: ["runtime.prompt", "runtime.subagents", "runtime.todo"],
          todo: {
            revision: 1,
            items: [{ id: 1, subject: "Draft the capsule", blockedBy: [], status: "pending" }],
          },
        }),
      });
      await flush();
    });
    await settle();
    expect(screen.getByRole("button", { name: "Expand status" }).textContent).toContain("Draft the capsule");

    await act(async () => {
      ws.serverSend({
        type: "event",
        payload: {
          type: "todo_changed",
          sessionId: "parent",
          epoch: "e1",
          eventId: 1,
          todo: {
            revision: 2,
            items: [
              { id: 1, subject: "Draft the capsule", blockedBy: [], status: "completed" },
              { id: 2, subject: "Ship the panel", blockedBy: [], status: "in_progress" },
            ],
          },
        },
      });
      await flush();
    });
    expect(screen.getByRole("button", { name: "Expand status" }).textContent).toContain("Ship the panel");
    expect(screen.getByRole("button", { name: "Expand status" }).textContent).not.toContain("Draft the capsule");
    expect(countMockFetchCalls(fetchImpl, "parentSessionId=parent")).toBe(0);
  });

  it("keeps an agent that ended before this turn out of the capsule, and a finished todo list off it once the turn is over", async () => {
    const TURN_STARTED_AT = Date.parse("2026-09-27T01:00:00.000Z");
    const userMessage = (text: string, timestamp: number): SessionEntry => ({
      entryId: `u:${timestamp}`,
      message: { role: "user", content: text, timestamp },
    });
    const parent: SessionHeader = {
      sessionId: "parent",
      sessionFile: "/sessions/parent.jsonl",
      cwd: "/x",
      projectRoot: "/x",
      title: "Parent",
      createdAt: 1000,
      updatedAt: Date.now(),
      messageCount: 3,
      workspaceAccess: AUTHORIZED,
    };
    const contextEntries = new Map<string, SessionEntry[]>([[
      "parent",
      // Pixie's work notice is a user-role entry too: it never opens a turn.
      [
        userMessage("for this turn", TURN_STARTED_AT),
        userMessage(`${ASSISTANT_NOTIFY_MESSAGE_PREFIX}\n\n上一轮完成`, TURN_STARTED_AT + 60_000),
      ],
    ]]);
    globalThis.fetch = controllableStubFetch({ sessions: [parent], contextEntries });
    mountApp({ cwd: "/x", session: "parent" });
    const ws = await connectReady();
    await act(async () => {
      void capturedStore!.openSession("parent").catch(() => undefined);
      const attach = await waitForAttach(ws, "parent");
      ws.serverSend({
        type: "snapshot",
        id: attach.id,
        payload: snapshotPayload({
          sessionId: "parent",
          capabilities: [...LIVE_CAPS, "runtime.subagents", "runtime.todo"],
          subagents: {
            revision: 1,
            tasks: [
              {
                taskId: "task-old",
                description: "Ended last turn",
                agentType: "Explore",
                status: "completed",
                startedAt: TURN_STARTED_AT - 120_000,
                completedAt: TURN_STARTED_AT - 60_000,
              },
              {
                taskId: "task-now",
                description: "Ended this turn",
                agentType: "Explore",
                status: "completed",
                startedAt: TURN_STARTED_AT + 1_000,
                completedAt: TURN_STARTED_AT + 2_000,
              },
            ],
          },
          todo: {
            revision: 1,
            items: [{ id: 1, subject: "Draft the capsule", blockedBy: [], status: "completed" }],
          },
        }),
      });
      await flush();
    });
    await settle();

    const capsule = screen.getByRole("button", { name: "Expand status" });
    // A finished checklist belongs to the turn that finished it.
    expect(capsule.textContent).not.toContain("Draft the capsule");
    expect(capsule.querySelector(".status-capsule-count")).toBeNull();
    fireEvent.click(capsule);
    const agents = screen.getByTestId("status-agents-section");
    expect(within(agents).getByText("Ended this turn")).toBeTruthy();
    expect(within(agents).queryByText("Ended last turn")).toBeNull();
    expect(screen.queryByTestId("status-progress-section")).toBeNull();
  });

  it("never shows the whole delegation history while the turn boundary is still unknown (refresh)", async () => {
    const TURN_STARTED_AT = Date.parse("2026-09-27T01:00:00.000Z");
    const contextDeferreds = new Map<string, Deferred>();
    const parent: SessionHeader = {
      sessionId: "parent",
      sessionFile: "/sessions/parent.jsonl",
      cwd: "/x",
      projectRoot: "/x",
      title: "Parent",
      createdAt: 1000,
      updatedAt: Date.now(),
      messageCount: 3,
      workspaceAccess: AUTHORIZED,
    };
    // The snapshot carries a finished last turn: the history page that dates
    // the turn is still in flight when the capsule is already rendered.
    globalThis.fetch = controllableStubFetch({ sessions: [parent], contextDeferreds });
    mountApp({ cwd: "/x", session: "parent" });
    const ws = await connectReady();
    await act(async () => {
      void capturedStore!.openSession("parent").catch(() => undefined);
      const attach = await waitForAttach(ws, "parent");
      ws.serverSend({
        type: "snapshot",
        id: attach.id,
        payload: snapshotPayload({
          sessionId: "parent",
          capabilities: [...LIVE_CAPS, "runtime.subagents", "runtime.todo"],
          subagents: {
            revision: 1,
            tasks: [
              {
                taskId: "task-old",
                description: "Ended last turn",
                agentType: "Explore",
                status: "completed",
                startedAt: TURN_STARTED_AT - 120_000,
                completedAt: TURN_STARTED_AT - 60_000,
              },
            ],
          },
          todo: {
            revision: 1,
            items: [{ id: 1, subject: "Draft the capsule", blockedBy: [], status: "completed" }],
          },
        }),
      });
      await flush();
    });
    await settle();

    // History not loaded yet: the capsule must not flash last turn's work.
    expect(contextDeferreds.get("parent")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Expand status" })).toBeNull();

    await act(async () => {
      contextDeferreds.get("parent")!.resolve(json({
        context: {
          sessionId: "parent",
          entries: [{ entryId: "u1", message: { role: "user", content: "done with that", timestamp: TURN_STARTED_AT } }],
          settings: { model: { provider: "anthropic", modelId: "claude-opus-4" }, thinkingLevel: "off" },
          pageInfo: { hasMore: false },
        },
      }));
      await flush(20);
    });
    await settle();
    // Dated turn start arrives: still nothing from the previous turn.
    expect(screen.queryByRole("button", { name: "Expand status" })).toBeNull();
  });

  it("keeps the current turn's capsule steady while the optimistic user message has no timestamp yet", async () => {
    const TURN_STARTED_AT = Date.parse("2026-09-27T01:00:00.000Z");
    const contextDeferreds = new Map<string, Deferred>();
    const parent: SessionHeader = {
      sessionId: "parent",
      sessionFile: "/sessions/parent.jsonl",
      cwd: "/x",
      projectRoot: "/x",
      title: "Parent",
      createdAt: 1000,
      updatedAt: Date.now(),
      messageCount: 3,
      workspaceAccess: AUTHORIZED,
    };
    globalThis.fetch = controllableStubFetch({ sessions: [parent], contextDeferreds });
    mountApp({ cwd: "/x", session: "parent" });
    const ws = await connectReady();
    const attach = await act(async () => {
      void capturedStore!.openSession("parent").catch(() => undefined);
      return waitForAttach(ws, "parent");
    });
    await act(async () => {
      ws.serverSend({
        type: "snapshot",
        id: attach.id,
        payload: snapshotPayload({
          sessionId: "parent",
          capabilities: [...LIVE_CAPS, "runtime.subagents", "runtime.todo"],
          subagents: { revision: 1, tasks: [] },
          todo: {
            revision: 1,
            items: [{ id: 1, subject: "Draft the capsule", blockedBy: [], status: "completed" }],
          },
        }),
      });
      await flush();
    });
    // The previous turn's checklist is out of the capsule, and it is the turn
    // boundary the fresh send must NOT lose.
    await settle();
    expect(screen.queryByRole("button", { name: "Expand status" })).toBeNull();
    await act(async () => {
      contextDeferreds.get("parent")!.resolve(json({
        context: {
          sessionId: "parent",
          entries: [{ entryId: "u1", message: { role: "user", content: "done with that", timestamp: TURN_STARTED_AT } }],
          settings: { model: { provider: "anthropic", modelId: "claude-opus-4" }, thinkingLevel: "off" },
          pageInfo: { hasMore: false },
        },
      }));
      await flush(20);
    });
    await settle();
    expect(screen.queryByRole("button", { name: "Expand status" })).toBeNull();

    // The new send lands immediately (optimistic bubble, no timestamp) while
    // the authority says the turn is running: the finished list must stay off.
    await act(async () => {
      void capturedStore!.sendPrompt("next task").catch(() => undefined);
      await flush();
      ws.serverSend({ type: "event", payload: { type: "agent_start", sessionId: "parent", epoch: "e1", eventId: 1 } });
      await flush();
    });
    await settle();
    expect(screen.queryByRole("button", { name: "Expand status" })).toBeNull();

    // A todo update from THIS turn may appear now, and it must stay put once
    // the turn start is still the send instant.
    await act(async () => {
      ws.serverSend({
        type: "event",
        payload: {
          type: "todo_changed",
          sessionId: "parent",
          epoch: "e1",
          eventId: 2,
          todo: { revision: 2, items: [{ id: 2, subject: "Ship the panel", blockedBy: [], status: "in_progress" }] },
        },
      });
      await flush();
    });
    await settle();
    expect(screen.getByRole("button", { name: "Expand status" }).textContent).toContain("Ship the panel");
  });

  it("does not resurrect a finished checklist when a new turn starts running", async () => {
    const TURN_STARTED_AT = Date.parse("2026-09-27T01:00:00.000Z");
    const parent: SessionHeader = {
      sessionId: "parent",
      sessionFile: "/sessions/parent.jsonl",
      cwd: "/x",
      projectRoot: "/x",
      title: "Parent",
      createdAt: 1000,
      updatedAt: Date.now(),
      messageCount: 3,
      workspaceAccess: AUTHORIZED,
    };
    const contextEntries = new Map<string, SessionEntry[]>([[
      "parent",
      [{ entryId: "u1", message: { role: "user", content: "done with that", timestamp: TURN_STARTED_AT } }] as SessionEntry[],
    ]]);
    globalThis.fetch = controllableStubFetch({ sessions: [parent], contextEntries });
    mountApp({ cwd: "/x", session: "parent" });
    const ws = await connectReady();
    await act(async () => {
      void capturedStore!.openSession("parent").catch(() => undefined);
      const attach = await waitForAttach(ws, "parent");
      ws.serverSend({
        type: "snapshot",
        id: attach.id,
        payload: snapshotPayload({
          sessionId: "parent",
          capabilities: [...LIVE_CAPS, "runtime.subagents", "runtime.todo"],
          todo: {
            revision: 1,
            items: [{ id: 1, subject: "Draft the capsule", blockedBy: [], status: "completed" }],
          },
        }),
      });
      await flush();
    });
    await settle();
    expect(screen.queryByRole("button", { name: "Expand status" })).toBeNull();

    // The turn runs with the last turn's finished snapshot still in state:
    // nothing in this turn updated the checklist, so it stays hidden.
    await act(async () => {
      ws.serverSend({ type: "event", payload: { type: "agent_start", sessionId: "parent", epoch: "e1", eventId: 1 } });
      await flush();
    });
    await settle();
    expect(screen.queryByRole("button", { name: "Expand status" })).toBeNull();
  });

  it("the right-pane rail toggles the Files panel without a mobile-only corner toggle", async () => {
    globalThis.fetch = fileFetch();
    mountApp({ cwd: "/x" });
    await settle();
    const panel = document.querySelector(".right-panel-container");
    expect(panel?.className).toContain("right-panel-closed");
    // Desktop has no corner toggle; the rail owns opening/closing.
    expect(screen.queryByTestId("right-pane-toggle")).toBeNull();
    const railFiles = screen.getByRole("button", { name: "Files" });
    expect(railFiles.closest(".right-pane-rail")).toBeTruthy();
    expect(railFiles.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(railFiles);
    expect(document.querySelector(".right-panel-container")?.className).toContain("right-panel-open");
    expect(railFiles.getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("button", { name: "Side chat" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Side chat" }).getAttribute("title")).toContain("selected live session");
    // Clicking the open pane's rail icon closes the panel again.
    fireEvent.click(railFiles);
    expect(document.querySelector(".right-panel-container")?.className).toContain("right-panel-closed");
    expect(railFiles.getAttribute("aria-pressed")).toBe("false");
  });

  it("previews a turn file in its own pane and closes it with the X", async () => {
    globalThis.fetch = fileFetch();
    mountApp({ cwd: "/x" });
    await settle();
    const railFiles = screen.getByRole("button", { name: "Files" });
    await act(async () => {
      openChatFile("/tmp/outside.png", { source: "turn-files" });
      await flush();
    });
    await settle();
    expect(screen.getByRole("region", { name: /outside\.png/ })).toBeTruthy();
    expect(railFiles.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector(".right-panel-container")?.className).toContain("right-panel-open");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("region", { name: /outside\.png/ })).toBeNull();
    expect(document.querySelector(".right-panel-container")?.className).toContain("right-panel-closed");
  });

  it("a file handed over in the answer (openfile) opens rendered when it has a preview", async () => {
    globalThis.fetch = fileFetch({ content: "hellohtml", language: "html" });
    mountApp({ cwd: "/x" });
    await settle();
    await act(async () => {
      openChatFile("/x/page.html", { source: "turn-files" });
      await flush();
    });
    await settle();
    expect(screen.getByRole("region", { name: /page\.html/ })).toBeTruthy();
    expect(screen.getByTitle("HTML preview")).toBeTruthy();
  });

  it("opens a written file in the preview pane as a diff", async () => {
    globalThis.fetch = fileFetch();
    mountApp({ cwd: "/x" });
    await settle();
    await act(async () => {
      openChatFile("/x/a.ts", { source: "turn-files", initialDisplayMode: "diff" });
      await flush();
    });
    await settle();
    expect(screen.getByRole("region", { name: /a\.ts/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Files" }).getAttribute("aria-pressed")).toBe("false");
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
    mountApp({ cwd: "/x", session: "legacy" }, { queryClient: authenticatedQueryClient(), capabilities: ["agent", "sessions", "files", "models", "skills", "plugins"] });
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

    // Settings catalogs are global on-disk reads. History-only still permits
    // them, but they must not carry a project path or live-activate a Worker.
    fireEvent.click(screen.getByTestId("sidebar-nav-settings"));
    await settle();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    fireEvent.click(screen.getByTestId("settings-tab-skills"));
    await settle();
    fireEvent.click(screen.getByTestId("settings-tab-plugins"));
    await settle();
    const catalogUrls = (fetchImpl as typeof fetch & {
      mock: { calls: Array<[RequestInfo | URL, RequestInit?]> };
    }).mock.calls.map((call) => String(call[0])).filter((url) => /\/v1\/(skills|plugins|commands)/.test(url));
    expect([...new Set(catalogUrls)].sort()).toEqual(["/v1/commands", "/v1/plugins", "/v1/skills"]);
    expect(countMockFetchCalls(fetchImpl, "/v1/files")).toBe(0);
    expect(countType(ws, "attach")).toBe(0);
    expect(countType(ws, "command")).toBe(0);
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

// ---------------------------------------------------------------------------
// Assistant view (project-less evergreen conversation, `/?assistant=1`)
// ---------------------------------------------------------------------------

const ASSISTANT_CWD = "/home/x/.pi/pix/assistant";

/** Stub fetch with an /v1/assistant binding layered over the shell stub. */
function assistantStubFetch(binding: { cwd: string; sessionId: string | null } | { error: true; status: number }): typeof fetch {
  const base = controllableStubFetch({ sessions: [] });
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string"
      ? input
      : input instanceof URL
        ? `${input.pathname}${input.search}`
        : input.url;
    if (String(path).includes("/v1/assistant")) {
      if ("error" in binding) return jsonStatus({ error: "unavailable" }, binding.status);
      return json(binding);
    }
    return base(input, init);
  }) as unknown as typeof fetch;
}

describe("AppShell — assistant view (Pixie tab + shared status markers)", () => {
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
    window.localStorage.removeItem("pi-title-model");
    window.localStorage.removeItem(WORKSPACE_SESSION_TABS_STORAGE_KEY);
    window.localStorage.removeItem(WORKSPACE_LAST_SESSION_STORAGE_KEY);
    vi.useRealTimers();
  });

  it("sidebar entry with NO assistant session yet routes to the new-session draft entry; an existing session opens the conversation", async () => {
    globalThis.fetch = assistantStubFetch({ cwd: ASSISTANT_CWD, sessionId: null });
    mountApp({}, { queryClient: authenticatedQueryClient(), capabilities: ["agent", "sessions", "models", "assistant"] });
    await act(async () => { for (let i = 0; i < 12; i += 1) { await flush(4); vi.advanceTimersByTime(0); } });

    const entry = screen.getByTestId("sidebar-assistant");
    expect(entry.textContent).toContain("Pixie");
    expect(entry.getAttribute("data-active")).toBe(null);

    await act(async () => { fireEvent.click(entry); await flush(4); });
    // No conversation yet: the draft entry on the new-session page (the old
    // landing page is gone).
    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ search: { assistantDraft: true } }));
  });

  it("sidebar entry with an EXISTING assistant session opens the conversation directly", async () => {
    globalThis.fetch = assistantStubFetch({ cwd: ASSISTANT_CWD, sessionId: "assist-live" });
    mountApp({}, { queryClient: authenticatedQueryClient(), capabilities: ["agent", "sessions", "models", "assistant"] });
    await act(async () => { for (let i = 0; i < 12; i += 1) { await flush(4); vi.advanceTimersByTime(0); } });

    await act(async () => { fireEvent.click(screen.getByTestId("sidebar-assistant")); await flush(4); });
    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ search: { assistant: true } }));
  });

  it("viewing the assistant records it as the last location, and a killed PWA reopens it", async () => {
    globalThis.fetch = assistantStubFetch({ cwd: ASSISTANT_CWD, sessionId: "assist-live" });
    mountApp({ assistant: true }, { queryClient: authenticatedQueryClient(), capabilities: ["agent", "sessions", "models", "assistant"] });
    await act(async () => { for (let i = 0; i < 12; i += 1) { await flush(4); vi.advanceTimersByTime(0); } });
    expect(JSON.parse(window.localStorage.getItem(WORKSPACE_LAST_SESSION_STORAGE_KEY) ?? "null")).toEqual({ version: 1, assistant: true });
    cleanup();

    // The PWA relaunches its start_url (`/`): the assistant comes back.
    navigateMock.mockReset();
    mountApp({}, { queryClient: authenticatedQueryClient(), capabilities: ["agent", "sessions", "models", "assistant"] });
    await act(async () => { for (let i = 0; i < 12; i += 1) { await flush(4); vi.advanceTimersByTime(0); } });
    expect(navigateMock).toHaveBeenCalledWith({ to: "/", replace: true, search: { assistant: true } });
  });

  it("hides the entry without the assistant capability and degrades both URL flags to home", async () => {
    globalThis.fetch = assistantStubFetch({ cwd: ASSISTANT_CWD, sessionId: null });
    mountApp({ assistant: true }, { queryClient: authenticatedQueryClient(), capabilities: ["agent", "sessions", "models"] });
    await act(async () => { await flush(8); });
    expect(screen.queryByTestId("sidebar-assistant")).toBeNull();
    // Degrade honestly to the ordinary home draft, never a broken assistant view.
    expect(screen.getByTestId("home-stack")).toBeTruthy();
    // The draft entry chip is capability-gated too.
    expect(screen.queryByTestId("assistant-entry-tab")).toBeNull();
  });

  it("Pixie entry shows only the shared markers: online/starting never render, residency failure is error", async () => {
    globalThis.fetch = assistantStubFetch({ cwd: ASSISTANT_CWD, sessionId: "assist-live" });
    mountApp({}, { queryClient: authenticatedQueryClient(), capabilities: ["agent", "sessions", "models", "assistant"] });
    const presenceAck = (() => {
      const frame = ack() as { type: string; payload: Record<string, unknown> };
      return { ...frame, payload: { ...frame.payload, acceptedFeatures: ["runtime.running-watch.v1", "runtime.assistant-presence.v1"] } };
    })();
    const ws = await acceptAutomaticConnection(presenceAck);
    // Unknown presence (no baseline yet): no marker, no guess.
    expect(screen.getByTestId("sidebar-assistant").querySelector(".session-status-dot")).toBeNull();
    await act(async () => {
      ws.serverSend({ type: "assistant_state", payload: { sessionId: "assist-live", status: "online" } });
      await flush(4);
    });
    // Always-on by design: online/starting are NOT user-facing states.
    expect(screen.getByTestId("sidebar-assistant").querySelector(".session-status-dot")).toBeNull();
    await act(async () => {
      ws.serverSend({ type: "assistant_state", payload: { sessionId: "assist-live", status: "starting" } });
      await flush(4);
    });
    expect(screen.getByTestId("sidebar-assistant").querySelector(".session-status-dot")).toBeNull();
    await act(async () => {
      ws.serverSend({ type: "assistant_state", payload: { sessionId: "assist-live", status: "restarting" } });
      await flush(4);
    });
    // Restart backoff (residency failing) maps onto the shared error marker.
    expect(screen.getByTestId("sidebar-assistant").querySelector(".session-status-dot[data-status=\"error\"]")).toBeTruthy();
    // Armed (no conversation tracked) hides the marker again.
    await act(async () => {
      ws.serverSend({ type: "assistant_state", payload: { sessionId: null, status: "armed" } });
      await flush(4);
    });
    expect(screen.getByTestId("sidebar-assistant").querySelector(".session-status-dot")).toBeNull();
  });

  it("waiting-user from the running watch marks the Pixie entry and its tab", async () => {
    globalThis.fetch = assistantStubFetch({ cwd: ASSISTANT_CWD, sessionId: "assist-live" });
    const app = mountApp({}, { queryClient: authenticatedQueryClient(), capabilities: ["agent", "sessions", "models", "assistant"] });
    const ws = await acceptAutomaticConnection(watchAck());
    // Open the Pixie conversation (sidebar entry = open/activate the tab).
    await act(async () => { fireEvent.click(screen.getByTestId("sidebar-assistant")); await flush(4); });
    await act(async () => { app.rerender({ assistant: true }); await flush(8); });
    const tab = screen.getByRole("tab", { name: "Pixie" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    // The authoritative watch projects the conversation as waiting for user
    // input (pending extension UI) — same marker set as ordinary sessions.
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["assist-live"], busySessionIds: ["assist-live"], waitingSessionIds: ["assist-live"] } });
      await flush(4);
    });
    expect(screen.getByTestId("sidebar-assistant").querySelector(".session-status-dot[data-status=\"waiting\"]")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Pixie" }).querySelector(".session-status-dot[data-status=\"waiting\"]")).toBeTruthy();
    // Settling the request clears it in real time.
    await act(async () => {
      ws.serverSend({ type: "running_state", payload: { revision: 2, sessionIds: ["assist-live"], busySessionIds: [] } });
      await flush(4);
    });
    expect(screen.getByTestId("sidebar-assistant").querySelector(".session-status-dot")).toBeNull();
    expect(screen.getByRole("tab", { name: "Pixie" }).querySelector(".session-status-dot")).toBeNull();
  });

  it("the assistant view materializes a Pixie tab; closing it only closes the tab (never stops the session)", async () => {
    globalThis.fetch = assistantStubFetch({ cwd: ASSISTANT_CWD, sessionId: "assist-live" });
    const app = mountApp({ assistant: true }, { queryClient: authenticatedQueryClient(), capabilities: ["agent", "sessions", "models", "assistant"] });
    const ws = await acceptAutomaticConnection(watchAck());
    await act(async () => { for (let i = 0; i < 12; i += 1) { await flush(4); vi.advanceTimersByTime(0); } });

    const tab = screen.getByRole("tab", { name: "Pixie" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    // Durable exactly like an ordinary session tab.
    expect(window.localStorage.getItem(WORKSPACE_SESSION_TABS_STORAGE_KEY) ?? "").toContain("assistant");

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Close Pixie" })); await flush(4); });
    // Tab close is navigation-only: fall home (the mocked navigate needs the
    // URL to follow it, exactly like a real router would)…
    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ search: {} }));
    await act(async () => { app.rerender({}); await flush(6); });
    expect(screen.queryByRole("tab", { name: "Pixie" })).toBeNull();
    // …persisted tabs drop the assistant entry, and no stop frame ever fires
    // (the resident worker is sessiond's business).
    expect(window.localStorage.getItem(WORKSPACE_SESSION_TABS_STORAGE_KEY) ?? "{}").not.toContain("assistant");
    expect(ws.sent.filter((frame) => (frame as { type: string }).type === "stop")).toHaveLength(0);
  });

  it("?assistant=1 with no session yet redirects to the draft entry (the landing page is gone)", async () => {
    const fetchImpl = assistantStubFetch({ cwd: ASSISTANT_CWD, sessionId: null });
    globalThis.fetch = fetchImpl;
    mountApp({ assistant: true }, { queryClient: authenticatedQueryClient(), capabilities: ["agent", "sessions", "models", "assistant"] });
    await act(async () => { for (let i = 0; i < 30; i += 1) { await flush(4); vi.advanceTimersByTime(0); } });

    // The old "Your assistant" empty state never renders; the binding resolved
    // null, so the app redirects to the new-session page assistant state.
    expect(screen.queryByTestId("transcript-home")?.textContent ?? "").not.toContain("Your assistant");
    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ search: { assistantDraft: true } }));
    // The binding endpoint was consulted exactly through the typed transport.
    expect(countMockFetchCalls(fetchImpl, "/v1/assistant")).toBeGreaterThan(0);
    // No workspace session tab was materialized for the assistant selector.
    expect(window.localStorage.getItem(WORKSPACE_SESSION_TABS_STORAGE_KEY) ?? "{}").not.toContain("assistant");
  });

  it("first send from the DRAFT entry creates the session in the FIXED assistant cwd and navigates to the assistant view", async () => {
    globalThis.fetch = assistantStubFetch({ cwd: ASSISTANT_CWD, sessionId: null });
    const qc = authenticatedQueryClient();
    mountApp({ assistantDraft: true }, { queryClient: qc, capabilities: ["agent", "sessions", "models", "assistant"] });
    const ws = await acceptAutomaticConnection(submitTurnAck());
    await act(async () => { await flush(10); });

    // Draft state: chip selected, assistant placeholder, no project picker.
    expect(screen.getByTestId("assistant-entry-tab").getAttribute("data-state")).toBe("selected");
    expect(composerTextarea().getAttribute("placeholder")).toContain("follow up on a project");

    await typeAndSend("帮我找一下上次的会话");
    const create = lastFrame<{ type: "create"; id: string; payload: { cwd: string } }>(ws, "create")!;
    expect(create.payload.cwd).toBe(ASSISTANT_CWD);
    await act(async () => {
      ws.serverSend({
        type: "response",
        id: create.id,
        payload: { ok: true, result: { sessionId: "assist-1", epoch: "eA", lastEventId: 0, created: true, cwd: ASSISTANT_CWD, projectRoot: ASSISTANT_CWD } },
      });
      await flush(8);
    });

    const submit = lastSubmitTurn(ws);
    expect(submit.payload.sessionId).toBe("assist-1");
    // The draft-originated create navigates to the assistant conversation URL
    // (the same selector the sidebar uses) and publishes the binding — never
    // a /?session=assist-1 URL.
    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ search: { assistant: true } }));
    expect(navigateMock).not.toHaveBeenCalledWith(expect.objectContaining({ search: expect.objectContaining({ session: "assist-1" }) }));
    expect(qc.getQueryData(queryKeys.assistant.info())).toEqual({ cwd: ASSISTANT_CWD, sessionId: "assist-1" });
    await acceptSubmitTurn(ws, { sessionId: "assist-1", epoch: "eA" });
    // No session tab ever materializes for the assistant conversation.
    expect((window.localStorage.getItem(WORKSPACE_SESSION_TABS_STORAGE_KEY) ?? "{}")).not.toContain("assist-1");
  });

  it("an existing assistant session binds read-only through the endpoint (Pixie tab only, no activation)", async () => {
    globalThis.fetch = assistantStubFetch({ cwd: ASSISTANT_CWD, sessionId: "assist-live" });
    const qc = authenticatedQueryClient();
    mountApp({ assistant: true }, { queryClient: qc, capabilities: ["agent", "sessions", "models", "assistant"] });
    const ws = await acceptAutomaticConnection();
    await act(async () => { await flush(12); });

    // The conversation view renders (not home, not the first-entry empty state).
    expect(screen.queryByTestId("home-stack")).toBeNull();
    expect(screen.queryByTestId("transcript-home")).toBeNull();
    expect(screen.getByLabelText("Send message")).toBeTruthy();
    // Read-only binding: the Pixie tab is pure tab-strip state — selection
    // never creates/activates/attaches anything, and no SESSION tab is
    // materialized for the conversation.
    expect(countType(ws, "create")).toBe(0);
    expect(countType(ws, "activate")).toBe(0);
    expect(countType(ws, "attach")).toBe(0);
    expect(window.localStorage.getItem(WORKSPACE_SESSION_TABS_STORAGE_KEY) ?? "{}").not.toContain("assist-live");
  });

  it("an endpoint failure surfaces the honest degraded copy, never a fake empty conversation", async () => {
    globalThis.fetch = assistantStubFetch({ error: true, status: 503 });
    mountApp({ assistant: true }, { queryClient: authenticatedQueryClient(), capabilities: ["agent", "sessions", "models", "assistant"] });
    await act(async () => { for (let i = 0; i < 30; i += 1) { await flush(4); vi.advanceTimersByTime(0); } });
    const state = screen.getByTestId("assistant-binding-state");
    expect(state.getAttribute("role")).toBe("alert");
    expect(state.textContent).toContain("Pixie is unavailable");
    // No composer is mounted while the binding is unresolved.
    expect(screen.queryByLabelText("Send message")).toBeNull();
  });

  it("a late assistant create after switching to home never navigates (distinct draft keys)", async () => {
    globalThis.fetch = assistantStubFetch({ cwd: ASSISTANT_CWD, sessionId: null });
    const qc = authenticatedQueryClient();
    const app = mountApp({ assistant: true }, { queryClient: qc, capabilities: ["agent", "sessions", "models", "assistant"] });
    const ws = await acceptAutomaticConnection(submitTurnAck());
    await act(async () => { for (let i = 0; i < 30; i += 1) { await flush(4); vi.advanceTimersByTime(0); } });

    await typeAndSend("assistant first prompt");
    const create = lastFrame<{ type: "create"; id: string; payload: { cwd: string } }>(ws, "create")!;
    expect(create.payload.cwd).toBe(ASSISTANT_CWD);

    // Switch to the ordinary home draft BEFORE the create resolves.
    await act(async () => { app.rerender({}); await flush(6); });
    await act(async () => {
      ws.serverSend({
        type: "response",
        id: create.id,
        payload: { ok: true, result: { sessionId: "assist-late", epoch: "eL", lastEventId: 0, created: true, cwd: ASSISTANT_CWD, projectRoot: ASSISTANT_CWD } },
      });
      await flush(8);
    });

    // The home presentation is a DIFFERENT draft key: no navigation to a
    // session URL, no assistant-binding publish from the stale assistant
    // create (the cached binding stays whatever the endpoint last answered —
    // never assist-late). The only navigation so far is the no-session
    // redirect to the draft entry, which the rerender away from ?assistant=1
    // supersedes.
    expect(navigateMock).not.toHaveBeenCalledWith(expect.objectContaining({ search: expect.objectContaining({ session: "assist-late" }) }));
    expect(navigateMock).not.toHaveBeenCalledWith(expect.objectContaining({ search: expect.objectContaining({ assistant: true }) }));
    expect(qc.getQueryData<{ sessionId: string | null }>(queryKeys.assistant.info())?.sessionId ?? null).toBe(null);
  });

  it("a late HOME create while on the assistant view never poisons the assistant binding", async () => {
    globalThis.fetch = assistantStubFetch({ cwd: ASSISTANT_CWD, sessionId: null });
    const qc = authenticatedQueryClient();
    const app = mountApp({ cwd: "/x" }, { queryClient: qc, capabilities: ["agent", "sessions", "models", "assistant"] });
    const ws = await acceptAutomaticConnection(submitTurnAck());
    await act(async () => { for (let i = 0; i < 30; i += 1) { await flush(4); vi.advanceTimersByTime(0); } });

    await typeAndSend("home first prompt");
    const create = lastFrame<{ type: "create"; id: string; payload: { cwd: string } }>(ws, "create")!;
    expect(create.payload.cwd).toBe("/x");

    // Switch to the assistant view BEFORE the home create resolves.
    await act(async () => { app.rerender({ assistant: true }); await flush(6); });
    await act(async () => {
      ws.serverSend({
        type: "response",
        id: create.id,
        payload: { ok: true, result: { sessionId: "home-late", epoch: "eH", lastEventId: 0, created: true, cwd: "/x", projectRoot: "/x" } },
      });
      await flush(8);
    });

    // The assistant draft key is distinct: the project session never becomes
    // the assistant conversation binding.
    const binding = qc.getQueryData<{ cwd: string; sessionId: string | null }>(queryKeys.assistant.info());
    expect(binding?.sessionId ?? null).toBe(null);
    expect(binding?.cwd).toBe(ASSISTANT_CWD);
  });

  it("assistant entry chip: idle entry enters the draft state; ✕ returns with the draft preserved", async () => {
    globalThis.fetch = assistantStubFetch({ cwd: ASSISTANT_CWD, sessionId: null });
    const app = mountApp({}, { queryClient: authenticatedQueryClient(), capabilities: ["agent", "sessions", "models", "assistant"] });
    await act(async () => { for (let i = 0; i < 12; i += 1) { await flush(4); vi.advanceTimersByTime(0); } });

    // Idle chip above the composer, no project selected yet.
    const chip = screen.getByTestId("assistant-entry-tab");
    expect(chip.getAttribute("data-state")).toBe("idle");
    expect(screen.getByTestId("assistant-entry-chip-activate").textContent).toContain("Ask Pixie");
    // The home composer still offers the project picker.
    expect(screen.queryByTitle("Select project")).not.toBeNull();

    // A typed draft travels into the assistant state (never sent).
    await act(async () => { fireEvent.change(composerTextarea(), { target: { value: "随手的事" } }); await flush(2); });
    await act(async () => { fireEvent.click(screen.getByTestId("assistant-entry-chip-activate")); await flush(4); });
    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ search: { assistantDraft: true } }));

    await act(async () => { app.rerender({ assistantDraft: true }); await flush(6); });
    expect(screen.getByTestId("assistant-entry-tab").getAttribute("data-state")).toBe("selected");
    // Placeholder swapped, project picker hidden, draft preserved.
    expect(composerTextarea().getAttribute("placeholder")).toContain("follow up on a project");
    expect(screen.queryByTitle("Select project")).toBeNull();
    expect(composerTextarea().value).toBe("随手的事");

    // ✕ returns to the ordinary new-session state, draft still intact.
    await act(async () => { fireEvent.click(screen.getByTestId("assistant-entry-chip-dismiss")); await flush(4); });
    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ search: {} }));
    await act(async () => { app.rerender({}); await flush(6); });
    expect(screen.getByTestId("assistant-entry-tab").getAttribute("data-state")).toBe("idle");
    expect(composerTextarea().value).toBe("随手的事");
    expect(screen.queryByTitle("Select project")).not.toBeNull();
  });

  it("chip click with an EXISTING assistant session moves the draft text into the assistant composer (never sends)", async () => {
    globalThis.fetch = assistantStubFetch({ cwd: ASSISTANT_CWD, sessionId: "assist-live" });
    mountApp({}, { queryClient: authenticatedQueryClient(), capabilities: ["agent", "sessions", "models", "assistant"] });
    await act(async () => { for (let i = 0; i < 12; i += 1) { await flush(4); vi.advanceTimersByTime(0); } });

    await act(async () => { fireEvent.change(composerTextarea(), { target: { value: "跟进一下 pix 的进度" } }); await flush(2); });
    await act(async () => { fireEvent.click(screen.getByTestId("assistant-entry-chip-activate")); await flush(4); });
    // Straight to the assistant conversation; the draft text rides along into
    // the assistant session's draft slot, not sent anywhere.
    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ search: { assistant: true } }));
    expect(getDraft("assist-live")?.value).toBe("跟进一下 pix 的进度");
  });

  it("the chip collapses when a project is selected and re-expands when cleared", async () => {
    globalThis.fetch = assistantStubFetch({ cwd: ASSISTANT_CWD, sessionId: null });
    const app = mountApp({ cwd: "/repos/pix" }, { queryClient: authenticatedQueryClient(), capabilities: ["agent", "sessions", "models", "assistant"] });
    await act(async () => { await flush(8); });
    expect(screen.getByTestId("assistant-entry-tab").getAttribute("data-state")).toBe("hidden");

    await act(async () => { app.rerender({}); await flush(6); });
    expect(screen.getByTestId("assistant-entry-tab").getAttribute("data-state")).toBe("idle");
  });

  it("switching from the assistant to a normal session clears the selector", async () => {
    globalThis.fetch = assistantStubFetch({ cwd: ASSISTANT_CWD, sessionId: null });
    mountApp({ assistant: true }, { queryClient: authenticatedQueryClient(), capabilities: ["agent", "sessions", "models", "assistant"] });
    await act(async () => { await flush(8); });
    expect(screen.getByTestId("sidebar-assistant").getAttribute("data-active")).toBe("true");

    await act(async () => { fireEvent.click(screen.getByTestId("sidebar-new-session")); await flush(4); });
    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ search: {} }));
  });
});
