import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { AppShell } from "./AppShell";
import type { WorkspaceSearch } from "@/lib/search-params";
import { RuntimeProvider, useRuntimeStore } from "@/runtime/runtime-provider";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { I18nProvider } from "@/hooks/useI18n";
import { HttpClientProvider } from "@/app/http-context";
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
function mountApp(search: WorkspaceSearch) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host: Partial<HostInfo> = { mode: "local", capabilities: ["agent", "sessions", "files"] };
  const Tree = ({ search: s }: { search: WorkspaceSearch }): ReactNode => (
    <QueryClientProvider client={qc}>
      <HttpClientProvider>
        <CapabilityProvider host={host}>
          <RuntimeProvider deps={fakeDeps()}>
            <I18nProvider>
              <Capture />
              <AppShell search={s} />
            </I18nProvider>
          </RuntimeProvider>
        </CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>
  );
  const view = render(<Tree search={search} />);
  return {
    rerender: (s: WorkspaceSearch) => view.rerender(<Tree search={s} />),
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

function attachFrame(ws: FakeWebSocket, sessionId: string): { type: string; id: string } {
  const frame = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "attach")!;
  expect(frame.payload.sessionId).toBe(sessionId);
  return frame;
}

function countType(ws: FakeWebSocket, type: string): number {
  return ws.sent.filter((f) => (f as { type: string }).type === type).length;
}

describe("AppShell — single-owner URL session selection (rapid A→B→C / reordered settles)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    SOCKETS.length = 0;
    capturedStore = null;
    navigateMock.mockReset();
    previousFetch = globalThis.fetch;
    globalThis.fetch = stubFetch();
  });
  afterEach(() => { cleanup(); globalThis.fetch = previousFetch; vi.useRealTimers(); });

  it("rapid A→B→C selection supersedes in-flight opens; only the last selection attaches", async () => {
    const { rerender } = mountApp({ cwd: "/x" });
    const ws = await connectReady();
    // Select A — attach A goes on the wire.
    rerender({ cwd: "/x", session: "A" });
    await flush();
    const attachA = attachFrame(ws, "A");
    // Select B before A's snapshot — supersedes A.
    rerender({ cwd: "/x", session: "B" });
    await flush();
    const attachB = attachFrame(ws, "B");
    // Select C before B's snapshot — supersedes B.
    rerender({ cwd: "/x", session: "C" });
    await flush();
    const attachC = attachFrame(ws, "C");
    // Only the last selection's attach completes.
    await act(async () => {
      ws.serverSend({ type: "snapshot", id: attachC.id, payload: snapshotPayload({ sessionId: "C" }) });
      await flush();
    });
    expect(capturedStore!.getSnapshot().sessionId).toBe("C");
    expect(capturedStore!.getSnapshot().attached).toBe(true);
    // The superseded opens never attach: no snapshots for A/B, no error notice.
    expect(capturedStore!.getSnapshot().error).toBeNull();
    // Re-a proving no clobber: deliver A's and B's LATE snapshots — dropped.
    await act(async () => {
      ws.serverSend({ type: "snapshot", id: attachA.id, payload: snapshotPayload({ sessionId: "A", epoch: "eA" }) });
      ws.serverSend({ type: "snapshot", id: attachB.id, payload: snapshotPayload({ sessionId: "B", epoch: "eB" }) });
      await flush();
    });
    expect(capturedStore!.getSnapshot().sessionId).toBe("C");
    expect(capturedStore!.getSnapshot().epoch).toBe("e1");
  });

  it("reordered settles: a superseded B→C flow never detaches into a stale attach, and no error surfaces", async () => {
    const { rerender } = mountApp({ cwd: "/x" });
    const ws = await connectReady();
    // Attach fully to A first (live).
    await act(async () => {
      void capturedStore!.openSession("A");
      await flush();
      const attach = lastFrame<{ type: string; id: string }>(ws, "attach")!;
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A" }) });
      await flush();
    });
    expect(capturedStore!.getSnapshot().sessionId).toBe("A");
    // Click B → the single owner starts detaching A, then would open B.
    rerender({ cwd: "/x", session: "B" });
    await flush();
    // Click C before B's detach resolves → supersedes B; the owner detaches A again.
    rerender({ cwd: "/x", session: "C" });
    await flush();
    // Exactly TWO detach envelopes (B's flow and C's flow, both for A) are in flight.
    expect(countType(ws, "detach")).toBe(2);
    const detaches = ws.sent.filter((f) => (f as { type: string }).type === "detach") as { type: string; id: string }[];
    // Resolve C's detach FIRST → C's flow proceeds to open C.
    await act(async () => {
      ws.serverSend({ type: "response", id: detaches[1]!.id, payload: { ok: true, result: { sessionId: "A", detached: true } } });
      await flush();
    });
    const attachC = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    expect(attachC.payload.sessionId).toBe("C");
    // Resolve B's detach LATE → the superseded flow is dropped (gen guard): it
    // must NOT open B on top of C.
    await act(async () => {
      ws.serverSend({ type: "response", id: detaches[0]!.id, payload: { ok: true, result: { sessionId: "A", detached: true } } });
      ws.serverSend({ type: "snapshot", id: attachC.id, payload: snapshotPayload({ sessionId: "C" }) });
      await flush();
    });
    expect(countType(ws, "attach")).toBe(2); // initial A + C only — B never attaches
    const attachIds = (ws.sent.filter((f) => (f as { type: string }).type === "attach") as { payload: { sessionId: string } }[])
      .map((f) => f.payload.sessionId);
    expect(attachIds).toEqual(["A", "C"]);
    expect(capturedStore!.getSnapshot().sessionId).toBe("C");
    expect(capturedStore!.getSnapshot().attached).toBe(true);
    expect(capturedStore!.getSnapshot().error).toBeNull();
  });
});
