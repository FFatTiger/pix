import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { useSelectedWorkspaceAccess } from "./use-selected-workspace-access";
import type { SessionHeader } from "@fffattiger/pix-protocol";

const AUTHORIZED = { state: "authorized" as const, reason: "allowed_root" as const };
const HISTORY = { state: "history_only" as const, reason: "outside_allowed_roots" as const };

function header(over: Partial<SessionHeader> = {}): SessionHeader {
  return {
    sessionId: "A",
    cwd: "/x",
    projectRoot: "/x",
    workspaceAccess: AUTHORIZED,
    ...over,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let latest: ReturnType<typeof useSelectedWorkspaceAccess> | null = null;
function Probe({ sessionId, listed }: { sessionId: string | null; listed?: readonly SessionHeader[] | null }): null {
  latest = listed === undefined ? useSelectedWorkspaceAccess(sessionId) : useSelectedWorkspaceAccess(sessionId, listed);
  return null;
}

function mount(sessionId: string | null, listed?: readonly SessionHeader[] | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (id: string | null, rows?: readonly SessionHeader[] | null): ReactNode => (
    <QueryClientProvider client={qc}>
      <HttpClientProvider>
        <CapabilityProvider host={{ mode: "local", capabilities: ["agent", "sessions"] }}>
          {rows === undefined ? <Probe sessionId={id} /> : <Probe sessionId={id} listed={rows} />}
        </CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>
  );
  const view = render(tree(sessionId, listed));
  return {
    queryClient: qc,
    rerender: (id: string | null, rows?: readonly SessionHeader[] | null) => view.rerender(tree(id, rows)),
  };
}

describe("useSelectedWorkspaceAccess", () => {
  let previousFetch: typeof fetch;
  beforeEach(() => {
    previousFetch = globalThis.fetch;
    latest = null;
  });
  afterEach(() => {
    cleanup();
    globalThis.fetch = previousFetch;
  });

  it("reuses the listed HTTP row while detail is still pending and does not invent authorized", async () => {
    const listed = header({ title: "list" });
    const deferred = createDeferred<Response>();
    globalThis.fetch = vi.fn(async (input) => {
      const path = String(input);
      if (path.includes("/v1/sessions/A") && !path.includes("/context")) return deferred.promise;
      return json({});
    }) as unknown as typeof fetch;
    mount("A", [listed]);
    expect(latest).toMatchObject({
      mode: "existing",
      header: listed,
      decision: { kind: "authorized" },
      liveWorkspaceEnabled: true,
      accessLookupPending: false,
    });
    deferred.resolve(json({ session: header({ title: "detail", workspaceAccess: HISTORY }) }));
    await waitFor(() => expect(latest?.header?.title).toBe("detail"));
    expect(latest?.decision.kind).toBe("history_only");
    expect(latest?.liveWorkspaceEnabled).toBe(false);
    expect(latest?.accessLookupPending).toBe(false);
  });

  it("marks pending only for an enabled in-flight detail with no authoritative header", () => {
    const deferred = createDeferred<Response>();
    globalThis.fetch = vi.fn(async (input) => {
      const path = String(input);
      if (path.includes("/v1/sessions/A")) return deferred.promise;
      return json({});
    }) as unknown as typeof fetch;
    mount("A", []);
    expect(latest).toMatchObject({
      mode: "existing",
      header: undefined,
      decision: { kind: "unknown" },
      liveWorkspaceEnabled: false,
      accessLookupPending: true,
    });
  });

  it("completed missing access is unknown and not pending", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const path = String(input);
      if (path.includes("/v1/sessions/A") && !path.includes("/context")) {
        return json({ session: { sessionId: "A", cwd: "/x", projectRoot: "/x" } });
      }
      return json({});
    }) as unknown as typeof fetch;
    mount("A", []);
    await waitFor(() => expect(latest?.accessLookupPending).toBe(false));
    expect(latest?.decision.kind).toBe("unknown");
    expect(latest?.liveWorkspaceEnabled).toBe(false);
  });

  it("failed lookup is not pending and stays fail-closed unknown", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const path = String(input);
      if (path.includes("/v1/sessions/A") && !path.includes("/context")) {
        return json({ error: "gone" }, 404);
      }
      return json({});
    }) as unknown as typeof fetch;
    mount("A", []);
    await waitFor(() => expect(latest?.accessLookupPending).toBe(false));
    expect(latest?.decision.kind).toBe("unknown");
    expect(latest?.liveWorkspaceEnabled).toBe(false);
  });

  it("home is not pending and is not inferred from a listed history row", () => {
    globalThis.fetch = vi.fn(async () => json({})) as unknown as typeof fetch;
    mount(null, [header({ workspaceAccess: HISTORY })]);
    expect(latest).toMatchObject({
      mode: "new-session",
      header: undefined,
      decision: { kind: "unknown" },
      liveWorkspaceEnabled: true,
      accessLookupPending: false,
    });
  });

  it("disabled sessions capability is not pending even without a header", () => {
    const deferred = createDeferred<Response>();
    globalThis.fetch = vi.fn(async (input) => {
      const path = String(input);
      if (path.includes("/v1/sessions/A")) return deferred.promise;
      return json({});
    }) as unknown as typeof fetch;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <HttpClientProvider>
          <CapabilityProvider host={{ mode: "local", capabilities: ["agent"] }}>
            <Probe sessionId="A" listed={[]} />
          </CapabilityProvider>
        </HttpClientProvider>
      </QueryClientProvider>,
    );
    expect(latest).toMatchObject({
      mode: "existing",
      header: undefined,
      decision: { kind: "unknown" },
      liveWorkspaceEnabled: false,
      accessLookupPending: false,
    });
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some(([input]) => String(input).includes("/v1/sessions/A"))).toBe(false);
  });
});
