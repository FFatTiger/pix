import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, act, fireEvent, waitFor } from "@testing-library/react";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { HttpClientProvider } from "@/app/http-context";
import { RuntimeProvider, useRuntimeStore } from "@/runtime";
import { AppShell } from "./AppShell";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import { FakeWebSocket, flush, lastFrame, snapshotPayload } from "@/runtime/testing/harness";
import type { RuntimeSocketDeps } from "@/runtime/socket";
import type { HostInfo } from "@fffattiger/pix-protocol";
import type { SessionStore } from "@/runtime";
import type { WorkspaceSearch } from "@/lib/search-params";
import { useEffect, type ReactNode } from "react";

// jsdom gives the scroll container 0 height; stub the virtualizer to render rows.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 48,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 48 })),
    measureElement: () => undefined,
  }),
}));

// AppShell uses TanStack Router navigation; stub it so the component renders in
// isolation without a router context, and capture navigation calls for the D3A
// worktree Open/switch assertions.
const { navigateCalls } = vi.hoisted(() => ({
  navigateCalls: [] as { to: string; search: Record<string, unknown> | undefined }[],
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, search }: { children: ReactNode; to: string; search?: unknown }) =>
    <a href={to} data-search={JSON.stringify(search ?? {})}>{children}</a>,
  useNavigate: () => (opts: { to: string; search?: Record<string, unknown> }) => {
    navigateCalls.push({ to: opts.to, search: opts.search });
  },
}));

const SOCKETS: FakeWebSocket[] = [];
function fakeDeps(): RuntimeSocketDeps {
  return {
    createWebSocket: (url) => { const ws = new FakeWebSocket(url); SOCKETS.push(ws); return ws; },
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    random: () => 0.5,
    location: { href: "https://pix.local/" },
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

function contextResponse(sessionId: string, text = "hello history") {
  return new Response(
    JSON.stringify({
      context: {
        sessionId,
        entries: [{ entryId: "e1", message: { role: "user", content: text } }],
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function ack(caps: string[] = ["agent"]) {
  return { type: "handshake_ack", payload: { protocolVersion: 1, host: { mode: "local", capabilities: caps }, limits: { maxUpload: 0, maxOpenSessions: 4 }, sessionSnapshotSupport: true } };
}

function mount(search: WorkspaceSearch, host: Partial<HostInfo> | null): {
  view: ReturnType<typeof render>;
  rerender: (s: WorkspaceSearch, nextHost?: Partial<HostInfo> | null) => void;
} {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const build = (s: WorkspaceSearch, currentHost: Partial<HostInfo> | null) => (
    <ErrorBoundary>
      <QueryClientProvider client={qc}>
        <HttpClientProvider>
          <CapabilityProvider {...(currentHost === undefined ? {} : { host: currentHost })}>
            <RuntimeProvider deps={fakeDeps()}>
              <Capture />
              <AppShell search={s} />
            </RuntimeProvider>
          </CapabilityProvider>
        </HttpClientProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
  const view = render(build(search, host));
  return {
    view,
    rerender: (s: WorkspaceSearch, nextHost = host) => { view.rerender(build(s, nextHost)); },
  };
}

/** Open + handshake the first socket so the store is ready. */
async function driveReady(): Promise<FakeWebSocket> {
  const store = capturedStore!;
  await act(async () => {
    store.connect();
    const ws = SOCKETS[SOCKETS.length - 1]!;
    ws.serverOpen();
    ws.serverSend(ack());
    await flush();
  });
  return SOCKETS[SOCKETS.length - 1]!;
}

/** Attach to `sessionId` and commit one user message into the runtime projection. */
async function driveLiveOnA(ws: FakeWebSocket, sessionId = "s-a", message = "live message from A"): Promise<void> {
  const store = capturedStore!;
  await act(async () => {
    void store.openSession(sessionId);
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId }) });
    await flush();
    ws.serverSend({ type: "event", payload: { type: "message_start", sessionId, streamId: "st", messageId: "m", message: { role: "user", content: message }, eventId: 1, epoch: "e1" } });
    ws.serverSend({ type: "event", payload: { type: "message_end", sessionId, streamId: "st", messageId: "m", message: { role: "user", content: message }, eventId: 2, epoch: "e1" } });
    await flush();
  });
}

async function serverSend(ws: FakeWebSocket, message: unknown): Promise<void> {
  await act(async () => {
    ws.serverSend(message);
    await flush();
  });
}

/** Ack every outstanding detach frame (the mismatch effect + Continue live may both fire). */
async function ackAllDetaches(ws: FakeWebSocket): Promise<void> {
  const frames = (ws.sent as { type: string; id: string }[]).filter((frame) => frame.type === "detach");
  for (const frame of frames) {
    await serverSend(ws, {
      type: "response",
      id: frame.id,
      payload: { ok: true, result: { sessionId: "s-a", detached: true } },
    });
  }
}

describe("AppShell read-only deep link + Continue live", () => {
  let previousFetch: typeof fetch;
  beforeEach(() => {
    previousFetch = globalThis.fetch;
    SOCKETS.length = 0;
    capturedStore = null;
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
    cleanup();
  });

  it("renders read-only history without opening a runtime socket (no Worker activation)", async () => {
    globalThis.fetch = vi.fn(async () => contextResponse("s-abc")) as unknown as typeof fetch;
    mount({ session: "s-abc", cwd: "/proj" }, { mode: "local", capabilities: ["agent", "sessions"] });
    // The read-only context is rendered.
    expect(await screen.findByText("hello history")).toBeTruthy();
    // No WebSocket was created: the deep link is strictly read-only.
    expect(SOCKETS.length).toBe(0);
    // The Continue live affordance is present but has NOT activated anything.
    expect(screen.getByRole("button", { name: "Continue live" })).toBeTruthy();
  });

  it("Continue live opens a runtime socket only after an explicit click", async () => {
    globalThis.fetch = vi.fn(async () => contextResponse("s-abc")) as unknown as typeof fetch;
    mount({ session: "s-abc", cwd: "/proj" }, { mode: "local", capabilities: ["agent", "sessions"] });
    await screen.findByText("hello history");
    expect(SOCKETS.length).toBe(0);
    const openSpy = vi.spyOn(capturedStore!, "openSession");
    screen.getByRole("button", { name: "Continue live" }).click();
    expect(openSpy).toHaveBeenCalledWith("s-abc");
    // openSession ensures a connection: a WebSocket is created.
    expect(SOCKETS.length).toBe(1);
  });

  it("does not show Continue live without the agent capability (read-only shell)", async () => {
    globalThis.fetch = vi.fn(async () => contextResponse("s-abc")) as unknown as typeof fetch;
    mount({ session: "s-abc", cwd: "/proj" }, { mode: "local", capabilities: ["sessions"] });
    await screen.findByText("hello history");
    expect(screen.queryByRole("button", { name: "Continue live" })).toBeNull();
    expect(SOCKETS.length).toBe(0);
  });

  it("homepage keeps the Open project form (no session selected)", () => {
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    mount({}, { mode: "local", capabilities: ["agent", "sessions"] });
    expect(screen.getByLabelText("Project path")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open project" })).toBeTruthy();
  });
});

describe("AppShell history/live coordination", () => {
  let previousFetch: typeof fetch;
  beforeEach(() => {
    previousFetch = globalThis.fetch;
    SOCKETS.length = 0;
    capturedStore = null;
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
    cleanup();
  });

  it("Open project submit only navigates — it never implicitly creates a session", async () => {
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    mount({}, { mode: "local", capabilities: ["agent", "sessions"] });
    const createSpy = vi.spyOn(capturedStore!, "createSession");
    const input = screen.getByLabelText("Project path") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/proj" } });
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await flush();
    // No runtime socket / create: Open project only sets the workspace cwd.
    expect(createSpy).not.toHaveBeenCalled();
    expect(SOCKETS.length).toBe(0);
  });

  it("switching from live A to selected B fail-closes immediately: no A transcript, Composer disabled, SessionActions hidden, detach called, B context shown", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("s-b")) return contextResponse("s-b", "hello history");
      if (url.includes("s-a")) return contextResponse("s-a", "hello from A history");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const { rerender } = mount({ session: "s-a", cwd: "/proj" }, { mode: "local", capabilities: ["agent", "sessions"] });

    // Live on A with a committed runtime message.
    const ws = await driveReady();
    await driveLiveOnA(ws, "s-a");
    expect(screen.getByText("live message from A")).toBeTruthy();
    expect((screen.getByLabelText("Message the agent") as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "State" })).toBeTruthy();

    // Select B in the sidebar (a plain search navigation — no Continue live).
    rerender({ session: "s-b", cwd: "/proj" });
    await flush();

    // IMMEDIATELY fail-closed, before the detach has been acked:
    expect(screen.queryByText("live message from A")).toBeNull();
    expect((screen.getByLabelText("Message the agent") as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "State" })).toBeNull();
    const detachFrame = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "detach")!;
    expect(detachFrame.payload.sessionId).toBe("s-a");
    // B history is visible while the detach is still pending.
    expect(await screen.findByText("hello history")).toBeTruthy();

    // After detach settles the view stays fail-closed (still B history, never A).
    await ackAllDetaches(ws);
    expect(screen.queryByText("live message from A")).toBeNull();
    expect((screen.getByLabelText("Message the agent") as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "State" })).toBeNull();
    expect(screen.getByText("hello history")).toBeTruthy();
  });

  it("Continue live on selected B (while A is still attached) awaits detach, then opens B", async () => {
    globalThis.fetch = vi.fn(async () => contextResponse("s-b")) as unknown as typeof fetch;
    const { rerender } = mount({ session: "s-a", cwd: "/proj" }, { mode: "local", capabilities: ["agent", "sessions"] });
    const ws = await driveReady();
    await driveLiveOnA(ws, "s-a");

    rerender({ session: "s-b", cwd: "/proj" });
    await flush();
    // The Continue live affordance is available while the runtime is stale.
    expect(screen.getByRole("button", { name: "Continue live" })).toBeTruthy();

    const openSpy = vi.spyOn(capturedStore!, "openSession");
    screen.getByRole("button", { name: "Continue live" }).click();
    // Detach is awaited before the open: ack the outstanding detaches, then B is opened.
    await ackAllDetaches(ws);
    await waitFor(() => expect(openSpy).toHaveBeenCalledWith("s-b"));
    await waitFor(() => expect(lastFrame<{ type: string; payload: { sessionId: string } }>(ws, "attach")?.payload.sessionId).toBe("s-b"));
  });

  it("selecting the same live session never detaches", async () => {
    globalThis.fetch = vi.fn(async () => contextResponse("s-a")) as unknown as typeof fetch;
    const { rerender } = mount({ session: "s-a", cwd: "/proj" }, { mode: "local", capabilities: ["agent", "sessions"] });
    const ws = await driveReady();
    await driveLiveOnA(ws, "s-a");
    expect(lastFrame(ws, "detach")).toBeUndefined();
    // Re-selecting the same live session (e.g. sidebar re-click) still no detach.
    rerender({ session: "s-a", cwd: "/proj" });
    await flush();
    expect(lastFrame(ws, "detach")).toBeUndefined();
    expect(screen.getByText("live message from A")).toBeTruthy();
  });

  it("detach rejection keeps the page fail-closed and surfaces an honest error (no detach loop)", async () => {
    globalThis.fetch = vi.fn(async () => contextResponse("s-b")) as unknown as typeof fetch;
    const { rerender } = mount({ session: "s-a", cwd: "/proj" }, { mode: "local", capabilities: ["agent", "sessions"] });
    const ws = await driveReady();
    await driveLiveOnA(ws, "s-a");

    rerender({ session: "s-b", cwd: "/proj" });
    await flush();
    const detachFrame = lastFrame<{ type: string; id: string }>(ws, "detach")!;
    await serverSend(ws, { type: "response", id: detachFrame.id, payload: { ok: false, error: { code: "unavailable", message: "cannot detach right now", retryable: true } } });

    // Honest error is surfaced…
    expect((await screen.findByRole("alert")).textContent).toBe("cannot detach right now");
    // …and the page remains fail-closed on B (never A, no usable live surface).
    expect(screen.queryByText("live message from A")).toBeNull();
    expect((screen.getByLabelText("Message the agent") as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "State" })).toBeNull();
    expect(screen.getByText("hello history")).toBeTruthy();
    // The guarded effect fired exactly one detach — no retry loop while the
    // (attached, selected) pair is unchanged.
    expect((ws.sent as { type: string }[]).filter((frame) => frame.type === "detach")).toHaveLength(1);
  });

  it("New session from a history view clears the stale selection so the fresh session is never detached", async () => {
    globalThis.fetch = vi.fn(async () => contextResponse("s-b")) as unknown as typeof fetch;
    const { rerender } = mount({ session: "s-b", cwd: "/proj" }, { mode: "local", capabilities: ["agent", "sessions"] });
    await screen.findByText("hello history");

    const createSpy = vi.spyOn(capturedStore!, "createSession");
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    expect(createSpy).toHaveBeenCalledWith({ cwd: "/proj", projectRoot: "/proj" });
    // handleCreate clears the stale ?session= (navigate commits synchronously,
    // well before the create/attach round-trip below) — simulate that commit.
    rerender({ cwd: "/proj" });

    const ws = SOCKETS[SOCKETS.length - 1]!;
    await act(async () => {
      ws.serverOpen();
      ws.serverSend(ack());
      await flush();
    });
    // Complete RuntimeCreateResult (protocol-valid) so parseHostFrame accepts it.
    const createFrame = lastFrame<{ type: string; id: string }>(ws, "create")!;
    await serverSend(ws, {
      type: "response",
      id: createFrame.id,
      payload: { ok: true, result: { sessionId: "s-new", epoch: "e1", created: true, cwd: "/proj", projectRoot: "/proj" } },
    });
    await waitFor(() => expect(lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "attach")?.payload.sessionId).toBe("s-new"));
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    await serverSend(ws, { type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s-new" }) });

    // The fresh live session stays attached: never detach-called, live in topbar.
    expect(lastFrame(ws, "detach")).toBeUndefined();
    expect(screen.getByText(/session:s-new/)).toBeTruthy();
  });
});

describe("AppShell Catalog / Workspace mutual exclusion", () => {
  let previousFetch: typeof fetch;
  beforeEach(() => {
    previousFetch = globalThis.fetch;
    SOCKETS.length = 0;
    capturedStore = null;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://pix.local");
      if (url.pathname === "/v1/files" && url.searchParams.get("op") === "list") {
        return new Response(JSON.stringify({ path: url.searchParams.get("path"), entries: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/v1/models") {
        return new Response(JSON.stringify({ models: [], defaultModel: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/v1/auth/providers") {
        return new Response(JSON.stringify({ providers: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/v1/skills" || url.pathname === "/v1/plugins" || url.pathname === "/v1/commands") {
        return new Response(JSON.stringify({ skills: [], plugins: [], commands: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/v1/trust") {
        return new Response(
          JSON.stringify({
            cwd: url.searchParams.get("cwd"),
            level: "unknown",
            trusted: false,
            canReloadResources: { allowed: false, level: "unknown", reason: "Project resources are not trusted" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
    cleanup();
  });

  it("shows Catalog button only when a catalog cap is present", () => {
    mount({ cwd: "/proj" }, { mode: "local", capabilities: ["files"] });
    expect(screen.queryByRole("button", { name: /catalog panel/i })).toBeNull();
    cleanup();
    mount({ cwd: "/proj" }, { mode: "local", capabilities: ["models"] });
    expect(screen.getByRole("button", { name: "Show catalog panel" })).toBeTruthy();
  });

  it("opening Catalog closes Workspace and vice versa", async () => {
    mount({ cwd: "/proj" }, { mode: "local", capabilities: ["files", "models"] });
    fireEvent.click(screen.getByRole("button", { name: "Show workspace panel" }));
    expect(await screen.findByRole("tab", { name: "Files" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Models" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show catalog panel" }));
    expect(await screen.findByRole("tab", { name: "Models" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Files" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show workspace panel" }));
    expect(await screen.findByRole("tab", { name: "Files" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Models" })).toBeNull();
  });

  it("cap revocation closes Catalog and a later grant does not reopen it", async () => {
    const { rerender } = mount({ cwd: "/proj" }, { mode: "local", capabilities: ["models"] });
    fireEvent.click(screen.getByRole("button", { name: "Show catalog panel" }));
    expect(await screen.findByRole("tab", { name: "Models" })).toBeTruthy();

    rerender({ cwd: "/proj" }, { mode: "local", capabilities: ["files"] });
    expect(screen.queryByRole("button", { name: /catalog panel/i })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Models" })).toBeNull();

    rerender({ cwd: "/proj" }, { mode: "local", capabilities: ["files", "models"] });
    await waitFor(() => expect(screen.getByRole("button", { name: "Show catalog panel" })).toBeTruthy());
    expect(screen.queryByRole("tab", { name: "Models" })).toBeNull();
  });

  it("shows Workspace button for only-worktree and labels it Workspace", () => {
    mount({ cwd: "/proj" }, { mode: "local", capabilities: ["worktree"] });
    const btn = screen.getByRole("button", { name: "Show workspace panel" });
    expect(btn).toBeTruthy();
    expect(btn.textContent).toMatch(/Workspace/);
    expect(btn.textContent).not.toMatch(/Files\/Git/);
  });

  it("opens and closes the Worktrees-only workspace dock", async () => {
    mount({ cwd: "/proj" }, { mode: "local", capabilities: ["worktree"] });
    fireEvent.click(screen.getByRole("button", { name: "Show workspace panel" }));
    expect(await screen.findByRole("tab", { name: "Worktrees" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide workspace panel" }));
    expect(screen.queryByRole("tab", { name: "Worktrees" })).toBeNull();
  });

  it("cap revocation closes Workspace and a later grant does not reopen it", async () => {
    const { rerender } = mount({ cwd: "/proj" }, { mode: "local", capabilities: ["worktree"] });
    fireEvent.click(screen.getByRole("button", { name: "Show workspace panel" }));
    expect(await screen.findByRole("tab", { name: "Worktrees" })).toBeTruthy();

    rerender({ cwd: "/proj" }, { mode: "local", capabilities: ["models"] });
    expect(screen.queryByRole("button", { name: /workspace panel/i })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Worktrees" })).toBeNull();

    rerender({ cwd: "/proj" }, { mode: "local", capabilities: ["worktree", "models"] });
    await waitFor(() => expect(screen.getByRole("button", { name: "Show workspace panel" })).toBeTruthy());
    expect(screen.queryByRole("tab", { name: "Worktrees" })).toBeNull();
  });
});

describe("AppShell visible-branch export gate (D1B-3)", () => {
  let previousFetch: typeof fetch;
  beforeEach(() => {
    previousFetch = globalThis.fetch;
    SOCKETS.length = 0;
    capturedStore = null;
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
    cleanup();
  });

  it("shows Export visible branch for history selection and hides it when selection matches live", async () => {
    globalThis.fetch = vi.fn(async () => contextResponse("s-a")) as unknown as typeof fetch;
    const { rerender } = mount({ session: "s-a", cwd: "/proj" }, { mode: "local", capabilities: ["agent", "sessions"] });

    // History view: export affordance is present (shares context GET with Transcript).
    expect(await screen.findByRole("button", { name: "Export visible branch" })).toBeTruthy();
    expect(screen.getByText(/Selected context branch only/i)).toBeTruthy();

    // Attach live to the same session → selectionMatchesLive hides the button.
    const ws = await driveReady();
    await driveLiveOnA(ws, "s-a");
    expect(screen.queryByRole("button", { name: "Export visible branch" })).toBeNull();

    // Switch selection to B while A is still attached → export returns for B only.
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("s-b")) return contextResponse("s-b", "hello history");
      return contextResponse("s-a");
    }) as unknown as typeof fetch;
    rerender({ session: "s-b", cwd: "/proj" });
    await flush();
    expect(await screen.findByRole("button", { name: "Export visible branch" })).toBeTruthy();
    expect(screen.queryByText("live message from A")).toBeNull();
  });

  it("does not show export without sessions capability", async () => {
    globalThis.fetch = vi.fn(async () => contextResponse("s-abc")) as unknown as typeof fetch;
    mount({ session: "s-abc", cwd: "/proj" }, { mode: "local", capabilities: ["agent"] });
    await flush();
    expect(screen.queryByRole("button", { name: "Export visible branch" })).toBeNull();
  });
});

describe("AppShell worktree Open/switch navigation (D3A)", () => {
  let previousFetch: typeof fetch;
  beforeEach(() => {
    previousFetch = globalThis.fetch;
    SOCKETS.length = 0;
    capturedStore = null;
    navigateCalls.length = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://pix.local");
      if (url.pathname === "/v1/worktrees") {
        return new Response(
          JSON.stringify({
            projectRoot: "/proj",
            isGit: true,
            isTopLevel: true,
            worktrees: [
              { path: "/proj", branch: "main", isMain: true, authorized: true, managedByPix: true },
              { path: "/proj-worktrees/feature", branch: "feature/x", isMain: false, authorized: true, managedByPix: true },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return contextResponse("s-stale");
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
    cleanup();
  });

  it("Open worktree navigates to the row path, clears old session, and issues no mutation", async () => {
    mount(
      { cwd: "/proj", session: "s-stale" },
      { mode: "local", capabilities: ["agent", "worktree", "worktree.write"] },
    );
    fireEvent.click(screen.getByRole("button", { name: "Show workspace panel" }));
    await screen.findByRole("tab", { name: "Worktrees" });
    await screen.findByText("feature/x");

    fireEvent.click(screen.getByRole("button", { name: "Open worktree feature/x" }));

    // Client URL cwd navigation ONLY — AppShell owns it via navigate.
    await waitFor(() =>
      expect(navigateCalls).toContainEqual({ to: "/", search: { cwd: "/proj-worktrees/feature" } }),
    );
    // The fresh search intentionally clears the old session selection.
    const nav = navigateCalls.find((n) => n.to === "/");
    expect(nav?.search).toEqual({ cwd: "/proj-worktrees/feature" });
    expect(nav?.search).not.toHaveProperty("session");
    // No runtime socket (no session attach), no worktree mutation.
    expect(SOCKETS.length).toBe(0);
  });

  it("Open is not offered for the current worktree row", async () => {
    mount(
      { cwd: "/proj", session: "s-stale" },
      { mode: "local", capabilities: ["agent", "worktree", "worktree.write"] },
    );
    fireEvent.click(screen.getByRole("button", { name: "Show workspace panel" }));
    await screen.findByRole("tab", { name: "Worktrees" });
    await screen.findByText("feature/x");
    // The current cwd (/proj = main) row is never offered an Open control.
    expect(screen.queryByRole("button", { name: /open worktree main/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Open worktree feature/x" })).toBeTruthy();
  });
});
