import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClientProvider } from "@/app/http-context";
import { queryKeys } from "@/api/query-keys";
import {
  flushNow,
  resetPendingWritesForTest,
} from "@/lib/preferences/preference-sync";
import {
  loadSidebarItemState,
  useSidebarItemState,
} from "@/lib/sidebar-item-state";
import { useEffect } from "react";
import { ServerPreferenceSync } from "./ServerPreferenceSync";

const SIDEBAR_STATE_KEY = "pi-sidebar-item-state";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function AutoRevealSidebar() {
  const { state, setProjectExpanded } = useSidebarItemState();
  useEffect(() => {
    if (!state.expandedProjects.includes("/current")) {
      setProjectExpanded("/current", true);
    }
  }, [setProjectExpanded, state.expandedProjects]);
  return <div data-testid="workspace">workspace</div>;
}

beforeEach(() => {
  window.localStorage.clear();
  resetPendingWritesForTest();
});

afterEach(() => {
  resetPendingWritesForTest();
  vi.restoreAllMocks();
});

describe("ServerPreferenceSync startup barrier", () => {
  it("hydrates server pins before a restored workspace can persist automatic expansion", async () => {
    const serverSidebarState = JSON.stringify({
      pinnedSessions: ["pinned-session"],
      pinnedProjects: ["/pinned-project"],
      archivedSessions: [],
      archivedProjects: [],
      expandedProjects: [],
    });
    const preferencesResponse = deferred<Response>();
    const patches: Array<Record<string, string | null>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = request?.url ?? String(input);
      const method = init?.method ?? request?.method ?? "GET";
      if (url.includes("/v1/preferences") && method === "GET") {
        return preferencesResponse.promise;
      }
      if (url.includes("/v1/preferences") && method === "PUT") {
        const rawBody = init?.body === undefined
          ? await request?.clone().text()
          : String(init.body);
        const body = JSON.parse(rawBody ?? "") as { patch: Record<string, string | null> };
        patches.push(body.patch);
        return json({ ok: true, preferences: body.patch });
      }
      return json({});
    }));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.gate.status(), {
      status: "enabled",
      required: true,
      authenticated: true,
      mode: "local",
    });

    render(
      <QueryClientProvider client={queryClient}>
        <HttpClientProvider>
          <ServerPreferenceSync>
            <AutoRevealSidebar />
          </ServerPreferenceSync>
        </HttpClientProvider>
      </QueryClientProvider>,
    );

    expect(screen.queryByTestId("workspace")).toBeNull();
    expect(window.localStorage.getItem(SIDEBAR_STATE_KEY)).toBeNull();

    await act(async () => {
      preferencesResponse.resolve(json({ preferences: { [SIDEBAR_STATE_KEY]: serverSidebarState } }));
      await preferencesResponse.promise;
    });

    expect(await screen.findByTestId("workspace")).toBeTruthy();
    expect(loadSidebarItemState()).toEqual({
      pinnedSessions: ["pinned-session"],
      pinnedProjects: ["/pinned-project"],
      archivedSessions: [],
      archivedProjects: [],
      expandedProjects: ["/current"],
    });

    await act(async () => { await flushNow(); });
    expect(patches).toHaveLength(1);
    expect(JSON.parse(patches[0]?.[SIDEBAR_STATE_KEY] ?? "null")).toEqual({
      pinnedSessions: ["pinned-session"],
      pinnedProjects: ["/pinned-project"],
      archivedSessions: [],
      archivedProjects: [],
      expandedProjects: ["/current"],
    });
  });
});
