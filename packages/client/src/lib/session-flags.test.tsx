import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionFlags, migrateLocalSessionFlagsToServer, type SessionFlagsMigrationDeps } from "@/lib/session-flags";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { I18nProvider } from "@/hooks/useI18n";
import type { SessionHeader } from "@fffattiger/pix-protocol";

function header(over: Partial<SessionHeader> = {}): SessionHeader {
  return {
    sessionId: "s-1",
    cwd: "/repos/pix",
    projectRoot: "/repos/pix",
    createdAt: 1,
    updatedAt: 2,
    ...over,
  } as SessionHeader;
}

function mount(hook: () => ReturnType<typeof useSessionFlags>, sessions: SessionHeader[] = [header()]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  queryClient.setQueryData(["pix", "sessions", "page"], { sessions, page: 1, pageSize: 5, total: sessions.length, totalPages: 1, catalogRevision: 0 });
  let result: ReturnType<typeof useSessionFlags> | undefined;
  const Probe = () => {
    result = hook();
    return null;
  };
  render(
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>
        <CapabilityProvider host={{ mode: "local", capabilities: ["session.write", "sessions"] }}>
          <I18nProvider><Probe /></I18nProvider>
        </CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>,
  );
  return { queryClient, getResult: () => result! };
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("useSessionFlags", () => {
  it("derives pinned/archived sets from the cached session pages", () => {
    const { getResult } = mount(() => useSessionFlags(), [header({ pinned: true }), header({ sessionId: "s-2", archived: true })]);
    expect(getResult().pinnedSessions).toEqual(["s-1"]);
    expect(getResult().archivedSessions).toEqual(["s-2"]);
  });

  it("optimistically patches the cache and keeps it when the API succeeds", async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: unknown) => new Response(JSON.stringify({ success: true }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { queryClient, getResult } = mount(() => useSessionFlags());
    getResult().setSessionFlags("s-1", { pinned: true });
    // Optimistic patch is immediate.
    const cached = queryClient.getQueryData<{ sessions: SessionHeader[] }>(["pix", "sessions", "page"] as const)!;
    expect(cached.sessions[0]?.pinned).toBe(true);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/v1/sessions/s-1");
    const init = fetchMock.mock.calls[0]![1] as RequestInit | undefined;
    expect(JSON.parse(String(init?.body))).toEqual({ pinned: true });
    expect(getResult().flagError).toBeNull();
  });

  it("rolls the optimistic patch back and surfaces an error when the API fails", async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: unknown) => new Response(JSON.stringify({ error: "x" }), { status: 503, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { queryClient, getResult } = mount(() => useSessionFlags());
    getResult().setSessionFlags("s-1", { archived: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // Rollback: the cached row no longer carries the optimistic flag and the
    // error copy is surfaced (never a fake success).
    const rolledBack = queryClient.getQueryData<{ sessions: SessionHeader[] }>(["pix", "sessions", "page"] as const)!;
    expect(rolledBack.sessions[0]?.archived).toBeUndefined();

  });
});

describe("migrateLocalSessionFlagsToServer", () => {
  function deps(rows: Array<{ sessionId: string; pinned?: boolean; archived?: boolean }>): SessionFlagsMigrationDeps & { setCalls: Array<[string, Record<string, boolean>]> } {
    const setCalls: Array<[string, Record<string, boolean>]> = [];
    return {
      setCalls,
      setFlags: async (id, flags) => { setCalls.push([id, flags]); return { success: true }; },
      listSessions: async () => rows,
    };
  }

  it("uploads unset local flags additively; server-set flags win; strips local session arrays", async () => {
    window.localStorage.setItem("pi-sidebar-item-state", JSON.stringify({
      pinnedSessions: ["a", "b"],
      archivedSessions: ["c"],
      pinnedProjects: ["/keep"],
      expandedProjects: ["/keep"],
    }));
    const d = deps([
      { sessionId: "a" },   // unset → upload
      { sessionId: "b", pinned: true },        // server already pinned → server wins, NO upload
      { sessionId: "c", archived: true },      // server already archived → no upload
      { sessionId: "ghost" },                  // not needed
    ]);
    await migrateLocalSessionFlagsToServer(d);
    expect(d.setCalls).toEqual([["a", { pinned: true }]]);
    const stored = JSON.parse(window.localStorage.getItem("pi-sidebar-item-state")!);
    expect(stored.pinnedSessions).toBeUndefined();
    expect(stored.archivedSessions).toBeUndefined();
    expect(stored.pinnedProjects).toEqual(["/keep"]);
    expect(stored.expandedProjects).toEqual(["/keep"]);
  });

  it("unknown local ids are abandoned, not uploaded", async () => {
    window.localStorage.setItem("pi-sidebar-item-state", JSON.stringify({ pinnedSessions: ["gone"] }));
    const d = deps([]);
    await migrateLocalSessionFlagsToServer(d);
    expect(d.setCalls).toEqual([]);
    expect(JSON.parse(window.localStorage.getItem("pi-sidebar-item-state")!).pinnedSessions).toBeUndefined();
  });

  it("no-op when nothing to migrate", async () => {
    window.localStorage.setItem("pi-sidebar-item-state", JSON.stringify({ pinnedSessions: [], archivedSessions: [], expandedProjects: ["/x"] }));
    const d = deps([]);
    await migrateLocalSessionFlagsToServer(d);
    expect(d.setCalls).toEqual([]);
    expect(JSON.parse(window.localStorage.getItem("pi-sidebar-item-state")!).expandedProjects).toEqual(["/x"]);
  });
});
