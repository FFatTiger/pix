import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { HttpClientProvider } from "@/app/http-context";
import { Sidebar, describeSessionDeleteError } from "./Sidebar";
import { HttpError } from "@/api/http-client";
import type { ReactNode } from "react";
import type { HostCapability, HostInfo, SessionHeader } from "@fffattiger/pix-protocol";
import type { WorkspaceSearch } from "@/lib/search-params";

// Sidebar links via TanStack Router; stub it so the component renders in
// isolation. The anchor carries the search object so we can assert Link
// search semantics.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, search }: { children: ReactNode; to: string; search?: unknown }) => (
    <a href={to} data-search={JSON.stringify(search ?? {})}>{children}</a>
  ),
}));

const SESSIONS_CAP: HostCapability[] = ["sessions"];
const NO_SESSIONS_CAP: HostCapability[] = [];

function listResponse(sessions: SessionHeader[]): Response {
  return new Response(JSON.stringify({ sessions }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function baseSession(overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    sessionId: "sess-1",
    cwd: "/proj",
    projectRoot: "/proj",
    ...overrides,
  };
}

function mount(
  search: WorkspaceSearch,
  host: Partial<HostInfo>,
  queryClient?: QueryClient,
) {
  const qc = queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <HttpClientProvider>
        <CapabilityProvider host={host}>
          <Sidebar open search={search} />
        </CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>,
  );
  return { view, qc, rerender: (s: WorkspaceSearch, h: Partial<HostInfo>) => view.rerender(
    <QueryClientProvider client={qc}>
      <HttpClientProvider>
        <CapabilityProvider host={h}>
          <Sidebar open search={s} />
        </CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>,
  ) };
}

describe("Sidebar — capability fail-closed", () => {
  let previousFetch: typeof fetch;
  beforeEach(() => { previousFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = previousFetch; cleanup(); });

  it("initial no sessions capability: zero fetch, unavailable hint, no cached rows", async () => {
    const fetchMock = vi.fn(async () => listResponse([baseSession({ sessionId: "hidden" })]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    mount({ cwd: "/proj" }, { mode: "local", capabilities: NO_SESSIONS_CAP });

    expect(screen.queryByText("hidden")).toBeNull();
    expect(screen.getByText(/Session history unavailable/i)).toBeTruthy();
    expect(screen.queryByText(/Loading sessions/i)).toBeNull();
    expect(screen.queryByText(/Sessions unavailable/i)).toBeNull();
    expect(screen.queryByText(/No sessions/i)).toBeNull();

    // Let any pending microtasks settle; still no fetch and no rows.
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText("hidden")).toBeNull();
  });

  it("loads then revokes capability (same QueryClient): cache hidden immediately, no new fetch", async () => {
    const fetchMock = vi.fn(async () => listResponse([baseSession({ sessionId: "sess-loaded", title: "Loaded" })]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { rerender } = mount({ cwd: "/proj" }, { mode: "local", capabilities: SESSIONS_CAP });
    await waitFor(() => expect(screen.getByText("sess-loaded")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Revoke the sessions capability.
    rerender({ cwd: "/proj" }, { mode: "local", capabilities: NO_SESSIONS_CAP });

    // Cache is hidden immediately; unavailable hint returns.
    expect(screen.queryByText("sess-loaded")).toBeNull();
    expect(screen.queryByText("Loaded")).toBeNull();
    expect(screen.getByText(/Session history unavailable/i)).toBeTruthy();
    expect(screen.queryByText(/Loading sessions/i)).toBeNull();

    // No new request is issued after revocation.
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("pending request revoked mid-flight: late success still not visible", async () => {
    let resolveList: ((value: Response) => void) | undefined;
    globalThis.fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveList = resolve;
        }),
    ) as unknown as typeof fetch;

    const { rerender } = mount({ cwd: "/proj" }, { mode: "local", capabilities: SESSIONS_CAP });
    // Request is pending.
    expect(resolveList).toBeTypeOf("function");
    expect(screen.queryByText("late-sess")).toBeNull();

    // Revoke while pending.
    rerender({ cwd: "/proj" }, { mode: "local", capabilities: NO_SESSIONS_CAP });
    expect(screen.queryByText("late-sess")).toBeNull();
    expect(screen.getByText(/Session history unavailable/i)).toBeTruthy();

    // The in-flight request eventually resolves with real data…
    await act(async () => {
      resolveList?.(listResponse([baseSession({ sessionId: "late-sess", title: "Late" })]));
      await Promise.resolve();
    });

    // …but it must not recover the list.
    expect(screen.queryByText("late-sess")).toBeNull();
    expect(screen.queryByText("Late")).toBeNull();
    expect(screen.getByText(/Session history unavailable/i)).toBeTruthy();
  });
});

describe("Sidebar — read-only metadata rendering", () => {
  let previousFetch: typeof fetch;
  beforeEach(() => { previousFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = previousFetch; cleanup(); });

  it("renders full metadata for a complete session", async () => {
    const session = baseSession({
      sessionId: "full-1",
      title: "Complete session",
      cwd: "/Users/me/pix-proj",
      updatedAt: 1_700_000_000_000,
      messageCount: 3,
      parentSessionId: "parent-1",
    });
    globalThis.fetch = vi.fn(async () => listResponse([session])) as unknown as typeof fetch;
    mount({ cwd: "/proj" }, { mode: "local", capabilities: SESSIONS_CAP });

    await waitFor(() => expect(screen.getByText("Complete session")).toBeTruthy());
    // Full session id preserved.
    expect(screen.getByText("full-1")).toBeTruthy();
    // CWD short label via formatCwdLabel (distinct from the Project section label).
    expect(screen.getByText("…/me/pix-proj")).toBeTruthy();
    // Activity time via <time dateTime> (only the attribute is asserted).
    const time = screen.getByRole("time");
    expect(time.getAttribute("dateTime")).toBe(new Date(1_700_000_000_000).toISOString());
    // Message count incl. pluralization.
    expect(screen.getByText("3 messages")).toBeTruthy();
    // Fork only when parentSessionId present.
    expect(screen.getByText("Fork")).toBeTruthy();
  });

  it("shows 0 messages and 1 message variants", async () => {
    globalThis.fetch = vi.fn(async () =>
      listResponse([
        baseSession({ sessionId: "zero", messageCount: 0 }),
        baseSession({ sessionId: "one", messageCount: 1 }),
      ]),
    ) as unknown as typeof fetch;
    mount({ cwd: "/proj" }, { mode: "local", capabilities: SESSIONS_CAP });
    await waitFor(() => expect(screen.getByText("zero")).toBeTruthy());
    expect(screen.getByText("0 messages")).toBeTruthy();
    expect(screen.getByText("1 message")).toBeTruthy();
    expect(screen.queryByText("1 messages")).toBeNull();
  });

  it("omits missing fields, untitled fallback, and never renders undefined/null/Invalid Date", async () => {
    // No title, no messageCount, no parentSessionId, no times at all.
    const session = baseSession({ sessionId: "bare", cwd: "/proj" });
    globalThis.fetch = vi.fn(async () => listResponse([session])) as unknown as typeof fetch;
    mount({ cwd: "/proj" }, { mode: "local", capabilities: SESSIONS_CAP });
    await waitFor(() => expect(screen.getByText("bare")).toBeTruthy());

    // Untitled fallback.
    expect(screen.getByText("Untitled session")).toBeTruthy();
    // No message count, no fork, no time.
    expect(screen.queryByText(/messages?/i)).toBeNull();
    expect(screen.queryByText("Fork")).toBeNull();
    expect(screen.queryByRole("time")).toBeNull();

    // Nothing leaks placeholder/invalid text anywhere in the list.
    const list = screen.getByRole("list").textContent ?? "";
    expect(list).not.toContain("undefined");
    expect(list).not.toContain("null");
    expect(list).not.toContain("Invalid Date");
  });

  it("time three-layer fallback: updatedAt → lastMessageAt → createdAt", async () => {
    const updated = baseSession({ sessionId: "by-updated", updatedAt: 1_700_000_001_000 });
    const last = baseSession({ sessionId: "by-last", lastMessageAt: 1_700_000_002_000 });
    const created = baseSession({ sessionId: "by-created", createdAt: 1_700_000_003_000 });
    globalThis.fetch = vi.fn(async () => listResponse([updated, last, created])) as unknown as typeof fetch;
    mount({ cwd: "/proj" }, { mode: "local", capabilities: SESSIONS_CAP });
    await waitFor(() => expect(screen.getByText("by-updated")).toBeTruthy());

    const times = screen.getAllByRole("time");
    const byId = new Map(times.map((t) => [t.closest("a")?.querySelector(".session-row-id")?.textContent, t.getAttribute("dateTime")]));
    expect(byId.get("by-updated")).toBe(new Date(1_700_000_001_000).toISOString());
    expect(byId.get("by-last")).toBe(new Date(1_700_000_002_000).toISOString());
    expect(byId.get("by-created")).toBe(new Date(1_700_000_003_000).toISOString());
  });

  it("skips an unrepresentable candidate and falls through to the next usable one", async () => {
    // updatedAt is out of Date range (unrepresentable); lastMessageAt wins.
    const session = baseSession({
      sessionId: "skip-bad",
      updatedAt: 1e30,
      lastMessageAt: 1_700_000_004_000,
    });
    globalThis.fetch = vi.fn(async () => listResponse([session])) as unknown as typeof fetch;
    mount({ cwd: "/proj" }, { mode: "local", capabilities: SESSIONS_CAP });
    await waitFor(() => expect(screen.getByText("skip-bad")).toBeTruthy());
    const time = screen.getByRole("time");
    expect(time.getAttribute("dateTime")).toBe(new Date(1_700_000_004_000).toISOString());
  });

  it("omits the time entirely when the candidate is unrepresentable", async () => {
    // 1e30 is a finite JSON number that passes schema but maps to an invalid Date.
    const session = baseSession({ sessionId: "all-bad", updatedAt: 1e30 });
    globalThis.fetch = vi.fn(async () => listResponse([session])) as unknown as typeof fetch;
    mount({ cwd: "/proj" }, { mode: "local", capabilities: SESSIONS_CAP });
    await waitFor(() => expect(screen.getByText("all-bad")).toBeTruthy());
    expect(screen.queryByRole("time")).toBeNull();
    expect((screen.getByRole("list").textContent ?? "")).not.toContain("Invalid Date");
  });

  it("Fork requires parentSessionId; forkPointEntryId alone is not inferred, root is not shown", async () => {
    globalThis.fetch = vi.fn(async () =>
      listResponse([
        baseSession({ sessionId: "fork", parentSessionId: "p", forkPointEntryId: "e" }),
        baseSession({ sessionId: "entry-only", forkPointEntryId: "e" }),
        baseSession({ sessionId: "root" }),
      ]),
    ) as unknown as typeof fetch;
    mount({ cwd: "/proj" }, { mode: "local", capabilities: SESSIONS_CAP });
    await waitFor(() => expect(screen.getByText("fork")).toBeTruthy());
    // Exactly one Fork badge (only the parentSessionId row).
    expect(screen.getAllByText("Fork")).toHaveLength(1);
  });
});

describe("Sidebar — cwd encoding, Link search, A→B late race", () => {
  let previousFetch: typeof fetch;
  beforeEach(() => { previousFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = previousFetch; cleanup(); });

  it("encodes the cwd query and preserves Link search semantics (session + cwd)", async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      return listResponse([baseSession({ sessionId: "s-1", title: "One", cwd: "/proj A/B" })]);
    }) as unknown as typeof fetch;

    mount({ cwd: "/proj A/B" }, { mode: "local", capabilities: SESSIONS_CAP });
    await waitFor(() => expect(screen.getByText("s-1")).toBeTruthy());

    // The list request encodes the cwd as a query param.
    expect(seen.some((u) => u.startsWith("/v1/sessions?cwd="))).toBe(true);
    const cwdParam = new URLSearchParams(seen[0]!.split("?")[1]!).get("cwd");
    expect(cwdParam).toBe("/proj A/B");

    // The row link carries session + cwd search, matching existing semantics.
    const link = screen.getByText("s-1").closest("a")!;
    const search = JSON.parse(link.getAttribute("data-search")!) as Record<string, string>;
    expect(search.session).toBe("s-1");
    expect(search.cwd).toBe("/proj A/B");
  });

  it("Link search omits cwd when the workspace has no cwd", async () => {
    globalThis.fetch = vi.fn(async () => listResponse([baseSession({ sessionId: "s-2" })])) as unknown as typeof fetch;
    mount({}, { mode: "local", capabilities: SESSIONS_CAP });
    await waitFor(() => expect(screen.getByText("s-2")).toBeTruthy());
    const link = screen.getByText("s-2").closest("a")!;
    const search = JSON.parse(link.getAttribute("data-search")!) as Record<string, unknown>;
    expect(search.session).toBe("s-2");
    expect("cwd" in search).toBe(false);
  });

  it("A→B cwd change: a late A response does not overwrite the B list", async () => {
    let resolveA: ((value: Response) => void) | undefined;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const cwd = new URLSearchParams(url.split("?")[1] ?? "").get("cwd");
      if (cwd === "/proj-a") {
        return new Promise<Response>((resolve) => { resolveA = resolve; });
      }
      if (cwd === "/proj-b") {
        return listResponse([baseSession({ sessionId: "sess-b", title: "B only", cwd: "/proj-b" })]);
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const { rerender } = mount({ cwd: "/proj-a" }, { mode: "local", capabilities: SESSIONS_CAP });
    expect(resolveA).toBeTypeOf("function");
    expect(screen.queryByText("sess-b")).toBeNull();

    // Switch to B; B resolves and is shown.
    rerender({ cwd: "/proj-b" }, { mode: "local", capabilities: SESSIONS_CAP });
    await waitFor(() => expect(screen.getByText("sess-b")).toBeTruthy());

    // The late A response arrives — it must not pollute the B list.
    await act(async () => {
      resolveA?.(listResponse([baseSession({ sessionId: "sess-a", title: "A leak", cwd: "/proj-a" })]));
      await Promise.resolve();
    });
    expect(screen.getByText("sess-b")).toBeTruthy();
    expect(screen.queryByText("sess-a")).toBeNull();
    expect(screen.queryByText("A leak")).toBeNull();
  });
});

describe("Sidebar — strictly read-only", () => {
  let previousFetch: typeof fetch;
  beforeEach(() => { previousFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = previousFetch; cleanup(); });

  it("only issues GET sessions list traffic; no mutation/runtime/websocket", async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return listResponse([baseSession({ sessionId: "ro" })]);
    }) as unknown as typeof fetch;
    const wsSpy = vi.fn();
    const PreviousWS = globalThis.WebSocket;
    // @ts-expect-error test stub
    globalThis.WebSocket = wsSpy;

    try {
      mount({ cwd: "/proj" }, { mode: "local", capabilities: SESSIONS_CAP });
      await waitFor(() => expect(screen.getByText("ro")).toBeTruthy());
      // Only the GET /v1/sessions list path is observed — no per-session
      // detail/context/export sub-paths, no mutation, no websocket.
      expect(urls.every((u) => u.replace(/\?.*$/, "") === "/v1/sessions")).toBe(true);
      expect(urls.length).toBeGreaterThanOrEqual(1);
      expect(wsSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.WebSocket = PreviousWS;
    }
  });
});

describe("Sidebar — D4 session-history delete", () => {
  let previousFetch: typeof fetch;
  beforeEach(() => { previousFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = previousFetch; cleanup(); });

  function deleteMount(
    search: WorkspaceSearch,
    host: Partial<HostInfo>,
    extra: { liveSessionId?: string | null; onSessionDeleted?: (id: string) => void } = {},
  ) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={qc}>
        <HttpClientProvider>
          <CapabilityProvider host={host}>
            <Sidebar
              open
              search={search}
              liveSessionId={extra.liveSessionId ?? null}
              {...(extra.onSessionDeleted === undefined ? {} : { onSessionDeleted: extra.onSessionDeleted })}
            />
          </CapabilityProvider>
        </HttpClientProvider>
      </QueryClientProvider>,
    );
    return { view, qc };
  }

  /** Fetch mock recording { url, method }; GET list, DELETE success by default. */
  function recordingFetch(list: SessionHeader[] = [baseSession({ sessionId: "s-1", title: "One" })]) {
    const calls: { url: string; method: string }[] = [];
    const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method });
      if (method === "DELETE") {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return listResponse(list);
    });
    return { impl: impl as unknown as typeof fetch, calls };
  }

  async function openConfirm(label: string) {
    screen.getByRole("button", { name: `Delete session ${label}` }).click();
    await waitFor(() => expect(screen.getByRole("alert", { name: `Confirm deleting ${label}` })).toBeTruthy());
  }

  it("no session.delete capability: zero delete controls and zero DELETE traffic", async () => {
    const { impl, calls } = recordingFetch();
    globalThis.fetch = impl;
    deleteMount({ cwd: "/proj" }, { mode: "local", capabilities: ["sessions"] });
    await waitFor(() => expect(screen.getByText("s-1")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Delete session/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Confirm delete/ })).toBeNull();
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
  });

  it("with session.delete: shows a Delete control per eligible row", async () => {
    globalThis.fetch = recordingFetch([
      baseSession({ sessionId: "s-1", title: "One" }),
      baseSession({ sessionId: "s-2", title: "Two" }),
    ]).impl;
    deleteMount({ cwd: "/proj" }, { mode: "local", capabilities: ["sessions", "session.delete"] });
    await waitFor(() => expect(screen.getByText("s-1")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Delete session One" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete session Two" })).toBeTruthy();
  });

  it("hides the delete control for the currently attached/live session only", async () => {
    globalThis.fetch = recordingFetch([
      baseSession({ sessionId: "live-1", title: "Live" }),
      baseSession({ sessionId: "hist-1", title: "Hist" }),
    ]).impl;
    deleteMount({ cwd: "/proj" }, { mode: "local", capabilities: ["sessions", "session.delete"] }, { liveSessionId: "live-1" });
    await waitFor(() => expect(screen.getByText("live-1")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Delete session Live" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete session Hist" })).toBeTruthy();
  });

  it("the delete control is a sibling of the row Link — clicking it never navigates", async () => {
    globalThis.fetch = recordingFetch().impl;
    deleteMount({ cwd: "/proj" }, { mode: "local", capabilities: ["sessions", "session.delete"] });
    await waitFor(() => expect(screen.getByText("s-1")).toBeTruthy());
    const button = screen.getByRole("button", { name: "Delete session One" });
    expect(button.closest("a")).toBeNull(); // not nested in the row Link
    // Opening the confirmation is a row-local effect; the row Link is untouched.
    button.click();
    await waitFor(() => expect(screen.getByRole("alert", { name: "Confirm deleting One" })).toBeTruthy());
    expect(screen.getByRole("link").getAttribute("href")).toBe("/");
  });

  it("confirm shows Cancel with default focus; cancel returns focus to the delete control", async () => {
    globalThis.fetch = recordingFetch().impl;
    deleteMount({ cwd: "/proj" }, { mode: "local", capabilities: ["sessions", "session.delete"] });
    await waitFor(() => expect(screen.getByText("s-1")).toBeTruthy());
    const rowDelete = screen.getByRole("button", { name: "Delete session One" });
    rowDelete.click();
    await waitFor(() => expect(screen.getByRole("alert", { name: "Confirm deleting One" })).toBeTruthy());
    const confirm = screen.getByRole("alert", { name: "Confirm deleting One" });
    expect(confirm.textContent).toContain("permanent and cannot be undone");
    // Cancel is the safe default focus.
    const cancel = screen.getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    cancel.click();
    await waitFor(() => expect(screen.queryByRole("alert", { name: "Confirm deleting One" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete session One" })));
  });

  it("delete of the URL-selected row sends exactly one DELETE and notifies AppShell (cwd preserved there)", async () => {
    const { impl, calls } = recordingFetch();
    globalThis.fetch = impl;
    const deleted: string[] = [];
    deleteMount({ cwd: "/proj", session: "s-1" }, { mode: "local", capabilities: ["sessions", "session.delete"] }, { onSessionDeleted: (id) => deleted.push(id) });
    await waitFor(() => expect(screen.getByText("s-1")).toBeTruthy());
    await openConfirm("One");
    screen.getByRole("button", { name: "Confirm delete One" }).click();
    await waitFor(() => expect(deleted).toEqual(["s-1"]));
    const deletes = calls.filter((call) => call.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.url).toBe("/v1/sessions/s-1");
    // Mutation onSuccess invalidates the session lists + detail (existing option).
    await waitFor(() => expect(calls.filter((call) => call.url.startsWith("/v1/sessions")).length).toBeGreaterThanOrEqual(2));
  });

  it("deleting a NON-selected row leaves the URL untouched (no onSessionDeleted)", async () => {
    const { impl, calls } = recordingFetch([
      baseSession({ sessionId: "sel-1", title: "Selected" }),
      baseSession({ sessionId: "other-2", title: "Other" }),
    ]);
    globalThis.fetch = impl;
    const deleted: string[] = [];
    deleteMount({ cwd: "/proj", session: "sel-1" }, { mode: "local", capabilities: ["sessions", "session.delete"] }, { onSessionDeleted: (id) => deleted.push(id) });
    await waitFor(() => expect(screen.getByText("other-2")).toBeTruthy());
    await openConfirm("Other");
    screen.getByRole("button", { name: "Confirm delete Other" }).click();
    await waitFor(() => expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1));
    expect(deleted).toEqual([]); // non-selected deletion never navigates
  });

  it("live 409 maps to the fixed in-use copy and never leaks the raw host message", async () => {
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return new Response(
          JSON.stringify({ error: "raw secret host in-use marker", code: "SESSION_IN_USE", message: "raw secret host in-use marker" }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      }
      return listResponse([baseSession({ sessionId: "s-1", title: "One" })]);
    }) as unknown as typeof fetch;
    deleteMount({ cwd: "/proj" }, { mode: "local", capabilities: ["sessions", "session.delete"] });
    await waitFor(() => expect(screen.getByText("s-1")).toBeTruthy());
    await openConfirm("One");
    screen.getByRole("button", { name: "Confirm delete One" }).click();
    await waitFor(() => expect(screen.getByText("This session is currently in use.")).toBeTruthy());
    expect(screen.queryByText(/raw secret host in-use marker/)).toBeNull();
  });

  it("down 503 maps to the fixed unavailable copy with no leak", async () => {
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return new Response(
          JSON.stringify({ error: "leak: /secret/sessiond.sock", code: "SESSIONS_UNAVAILABLE", message: "leak: /secret/sessiond.sock" }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }
      return listResponse([baseSession({ sessionId: "s-1", title: "One" })]);
    }) as unknown as typeof fetch;
    deleteMount({ cwd: "/proj" }, { mode: "local", capabilities: ["sessions", "session.delete"] });
    await waitFor(() => expect(screen.getByText("s-1")).toBeTruthy());
    await openConfirm("One");
    screen.getByRole("button", { name: "Confirm delete One" }).click();
    await waitFor(() => expect(screen.getByText("Session deletion is temporarily unavailable.")).toBeTruthy());
    expect(screen.queryByText(/leak/)).toBeNull();
    expect(screen.queryByText(/secret\/sessiond/)).toBeNull();
  });

  it("double submit issues exactly one DELETE (singleflight)", async () => {
    let resolveDelete: ((value: Response) => void) | undefined;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return new Promise<Response>((resolve) => { resolveDelete = resolve; });
      }
      return listResponse([baseSession({ sessionId: "s-1", title: "One" })]);
    }) as unknown as typeof fetch;
    deleteMount({ cwd: "/proj" }, { mode: "local", capabilities: ["sessions", "session.delete"] });
    await waitFor(() => expect(screen.getByText("s-1")).toBeTruthy());
    await openConfirm("One");
    const confirmDelete = screen.getByRole("button", { name: "Confirm delete One" });
    confirmDelete.click();
    confirmDelete.click(); // same-tick double submit
    await act(async () => { await Promise.resolve(); });
    expect(resolveDelete).toBeTypeOf("function");
    await act(async () => {
      resolveDelete?.(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
      await Promise.resolve();
    });
    // Exactly one DELETE request was issued.
    const deletes = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
    );
    expect(deletes).toHaveLength(1);
  });

  it("capability revoke mid-flight makes the late result inert (no error, no navigation)", async () => {
    let resolveDelete: ((value: Response) => void) | undefined;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return new Promise<Response>((resolve) => { resolveDelete = resolve; });
      }
      return listResponse([baseSession({ sessionId: "s-1", title: "One" })]);
    }) as unknown as typeof fetch;
    const deleted: string[] = [];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const build = (host: Partial<HostInfo>) => (
      <QueryClientProvider client={qc}>
        <HttpClientProvider>
          <CapabilityProvider host={host}>
            <Sidebar open search={{ cwd: "/proj", session: "s-1" }} liveSessionId={null} onSessionDeleted={(id) => deleted.push(id)} />
          </CapabilityProvider>
        </HttpClientProvider>
      </QueryClientProvider>
    );
    const view = render(build({ mode: "local", capabilities: ["sessions", "session.delete"] }));
    await waitFor(() => expect(screen.getByText("s-1")).toBeTruthy());
    await openConfirm("One");
    screen.getByRole("button", { name: "Confirm delete One" }).click();
    await act(async () => { await Promise.resolve(); });
    // Revoke the session.delete capability while the DELETE is in flight.
    view.rerender(build({ mode: "local", capabilities: ["sessions"] }));
    await act(async () => {
      resolveDelete?.(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
      await Promise.resolve();
    });
    expect(deleted).toEqual([]); // late success must not navigate
    expect(screen.queryByRole("alert")).toBeNull(); // no stale error/status
    expect(screen.queryByRole("button", { name: /Delete session/ })).toBeNull(); // controls gone
  });

  it("URL session selection change mid-flight makes the late success inert", async () => {
    let resolveDelete: ((value: Response) => void) | undefined;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return new Promise<Response>((resolve) => { resolveDelete = resolve; });
      }
      return listResponse([baseSession({ sessionId: "s-1", title: "One" })]);
    }) as unknown as typeof fetch;
    const deleted: string[] = [];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const build = (search: WorkspaceSearch) => (
      <QueryClientProvider client={qc}>
        <HttpClientProvider>
          <CapabilityProvider host={{ mode: "local", capabilities: ["sessions", "session.delete"] }}>
            <Sidebar open search={search} liveSessionId={null} onSessionDeleted={(id) => deleted.push(id)} />
          </CapabilityProvider>
        </HttpClientProvider>
      </QueryClientProvider>
    );
    const view = render(build({ cwd: "/proj", session: "s-1" }));
    await waitFor(() => expect(screen.getByText("s-1")).toBeTruthy());
    await openConfirm("One");
    screen.getByRole("button", { name: "Confirm delete One" }).click();
    await act(async () => { await Promise.resolve(); });
    // The URL selection switches away mid-flight.
    view.rerender(build({ cwd: "/proj", session: "other-9" }));
    await act(async () => {
      resolveDelete?.(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
      await Promise.resolve();
    });
    expect(deleted).toEqual([]); // stale selection must not navigate
  });
});


describe("describeSessionDeleteError — fixed copy, no raw leak", () => {
  it("maps each status/code to fixed text and never renders raw messages", () => {
    const raw = (msg: string) => ({ status: 500, code: "SESSION_IN_USE", path: "/v1/sessions/s", message: msg });
    expect(describeSessionDeleteError(new HttpError(raw("raw in-use marker")))).toBe("This session is currently in use.");
    expect(describeSessionDeleteError(new HttpError({ status: 404, code: "SESSION_NOT_FOUND", path: "/v1/sessions/s", message: "raw not-found marker" }))).toBe("This session no longer exists.");
    expect(describeSessionDeleteError(new HttpError({ status: 503, code: "SESSIONS_UNAVAILABLE", path: "/v1/sessions/s", message: "raw down marker" }))).toBe("Session deletion is temporarily unavailable.");
    expect(describeSessionDeleteError(new HttpError({ status: 401, path: "/v1/sessions/s", message: "unauth" }))).toBe("You are not authorized for this action.");
    expect(describeSessionDeleteError(new HttpError({ kind: "network", status: 0, path: "/v1/sessions/s", message: "raw network marker" }))).toBe("Network error — unable to reach the host.");
    expect(describeSessionDeleteError(new HttpError({ kind: "timeout", status: 0, path: "/v1/sessions/s", message: "raw timeout marker" }))).toBe("Request timed out — try again.");
    expect(describeSessionDeleteError(new HttpError({ kind: "aborted", status: 0, path: "/v1/sessions/s", message: "raw aborted marker" }))).toBe("The action was cancelled.");
    expect(describeSessionDeleteError(new Error("raw unknown marker"))).toBe("Unable to delete this session.");
  });
});
