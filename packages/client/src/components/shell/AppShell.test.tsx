import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup } from "@testing-library/react";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { HttpClientProvider } from "@/app/http-context";
import { RuntimeProvider, useRuntimeStore } from "@/runtime";
import { AppShell } from "./AppShell";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import { FakeWebSocket } from "@/runtime/testing/harness";
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
// isolation without a router context.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, search }: { children: ReactNode; to: string; search?: unknown }) =>
    <a href={to} data-search={JSON.stringify(search ?? {})}>{children}</a>,
  useNavigate: () => () => undefined,
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

function contextResponse(sessionId: string) {
  return new Response(
    JSON.stringify({
      context: {
        sessionId,
        entries: [{ entryId: "e1", message: { role: "user", content: "hello history" } }],
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function mount(search: WorkspaceSearch, host: Partial<HostInfo> | null): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ErrorBoundary>
      <QueryClientProvider client={qc}>
        <HttpClientProvider>
          <CapabilityProvider {...(host === undefined ? {} : { host })}>
            <RuntimeProvider deps={fakeDeps()}>
              <Capture />
              <AppShell search={search} />
            </RuntimeProvider>
          </CapabilityProvider>
        </HttpClientProvider>
      </QueryClientProvider>
    </ErrorBoundary>,
  );
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
