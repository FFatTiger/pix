import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useWorkspaceFlags,
  migrateLocalOrganizationPrefsToServer,
  type WorkspaceFlagsMaps,
  type WorkspaceFlagsMigrationDeps,
} from "@/lib/workspace-flags";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { I18nProvider } from "@/hooks/useI18n";

const FLAGS_DOC: WorkspaceFlagsMaps = {
  revision: 7,
  sessions: { "s-1": { pinned: true }, "s-2": { archived: true } },
  projects: { "/repos/pix": { pinned: true }, "/repos/old": { archived: true } },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mount(fetchImpl: typeof fetch) {
  vi.stubGlobal("fetch", fetchImpl);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let result: ReturnType<typeof useWorkspaceFlags> | undefined;
  const Probe = () => {
    result = useWorkspaceFlags();
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

describe("useWorkspaceFlags", () => {
  it("derives all four sets from the workspace-flags document", async () => {
    const { getResult } = mount(vi.fn(async () => jsonResponse(FLAGS_DOC)) as unknown as typeof fetch);
    await waitFor(() => expect(getResult().flagsLoaded).toBe(true));
    expect(getResult().pinnedSessions).toEqual(["s-1"]);
    expect(getResult().archivedSessions).toEqual(["s-2"]);
    expect(getResult().pinnedProjects).toEqual(["/repos/pix"]);
    expect(getResult().archivedProjects).toEqual(["/repos/old"]);
  });

  it("optimistically patches the flags document and keeps it when the API succeeds", async () => {
    const fetchMock = vi.fn(async (input: unknown, init?: unknown) => {
      const path = String((input as URL).href ?? input);
      if ((init as RequestInit | undefined)?.method === "PATCH") return jsonResponse({ success: true });
      return jsonResponse(FLAGS_DOC);
    });
    const { queryClient, getResult } = mount(fetchMock as unknown as typeof fetch);
    await waitFor(() => expect(getResult().flagsLoaded).toBe(true));
    getResult().setProjectFlags("/repos/pix", { archived: true });
    // Optimistic document patch is immediate (both flags now set).
    await waitFor(() => expect(getResult().archivedProjects).toContain("/repos/pix"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/v1/workspace-flags"),
      expect.objectContaining({ method: "PATCH" }),
    ));
    expect(getResult().flagError).toBeNull();
    void queryClient;
  });

  it("rolls the optimistic patch back and surfaces an error when the API fails", async () => {
    const fetchMock = vi.fn(async (input: unknown, init?: unknown) => {
      const path = String((input as URL).href ?? input);
      if ((init as RequestInit | undefined)?.method === "PATCH") return jsonResponse({ error: "down" }, 503);
      return jsonResponse(FLAGS_DOC);
    });
    const { queryClient, getResult } = mount(fetchMock as unknown as typeof fetch);
    await waitFor(() => expect(getResult().flagsLoaded).toBe(true));
    const before = queryClient.getQueryData(["pix", "workspace-flags"]);
    getResult().setSessionFlags("s-3", { pinned: true });
    await waitFor(() => expect(getResult().flagError).toBe("desktop.workspaceFlagsSaveFailed"));
    expect(queryClient.getQueryData(["pix", "workspace-flags"])).toEqual(before);
  });
});

describe("migrateLocalOrganizationPrefsToServer", () => {
  function deps(server: WorkspaceFlagsMaps): WorkspaceFlagsMigrationDeps & { setCalls: Array<[string, string, Record<string, boolean>]> } {
    const setCalls: Array<[string, string, Record<string, boolean>]> = [];
    return {
      setCalls,
      setFlags: async (kind, key, flags) => { setCalls.push([kind, key, flags]); return { success: true }; },
      getWorkspaceFlags: async () => server,
    };
  }

  it("uploads unset local session AND project flags additively; server-set values win; strips all local arrays", async () => {
    window.localStorage.setItem("pi-sidebar-item-state", JSON.stringify({
      pinnedSessions: ["a", "b"],
      archivedSessions: ["c"],
      pinnedProjects: ["/repos/p1", "/repos/p2"],
      archivedProjects: ["/repos/p3"],
      expandedProjects: ["/keep-open"],
    }));
    const d = deps({
      revision: 3,
      sessions: { b: { pinned: true }, c: { archived: true } },
      projects: { "/repos/p2": { pinned: true } },
    });
    await migrateLocalOrganizationPrefsToServer(d);
    // Only genuinely-unset flags upload; server-set ones do not.
    expect(d.setCalls).toEqual([
      ["session", "a", { pinned: true }],
      ["project", "/repos/p1", { pinned: true }],
      ["project", "/repos/p3", { archived: true }],
    ]);
    const stored = JSON.parse(window.localStorage.getItem("pi-sidebar-item-state")!);
    expect(stored.pinnedSessions).toBeUndefined();
    expect(stored.archivedSessions).toBeUndefined();
    expect(stored.pinnedProjects).toBeUndefined();
    expect(stored.archivedProjects).toBeUndefined();
    expect(stored.expandedProjects).toEqual(["/keep-open"]);
  });

  it("no-op when nothing to migrate (expansion untouched)", async () => {
    window.localStorage.setItem("pi-sidebar-item-state", JSON.stringify({ expandedProjects: ["/x"] }));
    const d = deps({ revision: 0, sessions: {}, projects: {} });
    await migrateLocalOrganizationPrefsToServer(d);
    expect(d.setCalls).toEqual([]);
    expect(JSON.parse(window.localStorage.getItem("pi-sidebar-item-state")!).expandedProjects).toEqual(["/x"]);
  });
});
