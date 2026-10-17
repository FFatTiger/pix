import { act, fireEvent, render, screen, waitFor, within, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionHeader } from "@fffattiger/pix-protocol";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { I18nProvider } from "@/hooks/useI18n";
import { SessionSearchPalette } from "./SessionSearchPalette";

const AUTHORIZED = { state: "authorized" as const, reason: "allowed_root" as const };

function session(over: Partial<SessionHeader> & Pick<SessionHeader, "sessionId">): SessionHeader {
  return { cwd: "/x", projectRoot: "/x", createdAt: 1000, updatedAt: 5_000, messageCount: 1, workspaceAccess: AUTHORIZED, ...over };
}

const SESSIONS: SessionHeader[] = [
  session({ sessionId: "alpha", title: "侧栏改版方案", updatedAt: 5000 }),
  session({ sessionId: "beta", title: "Weekly report", firstMessage: "collect three things into one page", updatedAt: 4000 }),
  session({ sessionId: "gamma", firstMessage: "把搜索改成居中面板", updatedAt: 3000 }),
  session({ sessionId: "archived", title: "Archived row", archived: true, updatedAt: 9000 }),
];

/** Server-side keyword search stub (mirrors the daemon contract). */
type MatchSource = "title" | "project" | "message";
type StubRow = Omit<SessionHeader, "matchSource"> & { matchSource?: MatchSource | undefined };

function searchStubFetch(sessions: readonly SessionHeader[]): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? `${input.pathname}${input.search}` : input.url;
    const url = new URL(String(raw), "http://pix.local");
    const respond = (rows: readonly StubRow[]): Response => new Response(JSON.stringify({
      sessions: rows,
      page: Number(url.searchParams.get("page") ?? 1),
      pageSize: Number(url.searchParams.get("pageSize") ?? 20),
      total: rows.length,
      totalPages: rows.length === 0 ? 0 : 1,
      catalogRevision: 0,
    }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname !== "/v1/sessions") return new Response(JSON.stringify({}), { status: 200 });
    const query = url.searchParams.get("query");
    if (query === null) return respond(sessions.filter((row) => row.archived !== true) as StubRow[]);
    const needle = query.trim().toLowerCase();
    const matchOf = (row: SessionHeader): MatchSource | null => {
      const title = row.title && row.title.trim().length > 0 ? row.title : row.firstMessage;
      if (title !== undefined && title.toLowerCase().includes(needle)) return "title";
      if ("x".includes(needle)) return "project";
      if (row.firstMessage !== undefined && row.firstMessage.toLowerCase().includes(needle)) return "message";
      return null;
    };
    const matched: StubRow[] = sessions
      .filter((row) => row.archived !== true)
      .flatMap((row): StubRow[] => {
        const source = matchOf(row);
        return source === null ? [] : [{ ...row, matchSource: source }];
      });
    return respond(matched);
  }) as unknown as typeof fetch;
}

function fetchCalls(fetchImpl: typeof fetch): string[] {
  return (fetchImpl as typeof fetch & { mock: { calls: Array<[RequestInfo | URL]> } }).mock.calls.map((call) => String(call[0]));
}

function mountPalette(overrides: Partial<Parameters<typeof SessionSearchPalette>[0]> = {}): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <HttpClientProvider>
        <CapabilityProvider host={{ mode: "local", capabilities: ["sessions"] }}>
          <I18nProvider>
            <SessionSearchPalette
              open
              onClose={vi.fn()}
              onOpenSession={vi.fn()}
              runningSessionIds={new Set<string>()}
              waitingSessionIds={new Set<string>()}
              {...overrides}
            />
          </I18nProvider>
        </CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>,
  );
}

async function settleDebounce(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)); });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// jsdom has no scrollIntoView — stub it for the keyboard-navigation effect.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe("SessionSearchPalette", () => {
  it("shows the recent group before any input and focuses the input", async () => {
    globalThis.fetch = searchStubFetch(SESSIONS);
    mountPalette();
    expect(screen.getByTestId("search-palette-input")).toBe(document.activeElement);
    expect(await screen.findByText("侧栏改版方案")).toBeTruthy();
    // The Recent group header renders; archived rows never surface.
    expect(screen.getByText("Recent")).toBeTruthy();
    expect(screen.queryByText("Archived row")).toBeNull();
  });

  it("debounces the keyword request and highlights title matches", async () => {
    const fetchImpl = searchStubFetch(SESSIONS);
    globalThis.fetch = fetchImpl;
    mountPalette();
    await screen.findByText("侧栏改版方案");
    const input = screen.getByTestId("search-palette-input");
    fireEvent.change(input, { target: { value: "侧栏" } });
    await settleDebounce();
    const calls = fetchCalls(fetchImpl).filter((call) => call.includes("query="));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("pageSize=20");
    // A title match renders the matched span in bold (the placeholder row
    // carries no highlight — wait for the settled result).
    const row = await waitFor(() => {
      const bold = document.querySelector(".search-palette-title strong");
      expect(bold?.textContent).toBe("侧栏");
      return bold!.closest("button");
    });
    expect(row).toBeTruthy();
    expect(row!.textContent).toContain("侧栏改版方案");
  });

  it("renders a message snippet with the match bolded for message hits", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const raw = String(typeof input === "string" ? input : input instanceof URL ? `${input.pathname}${input.search}` : input.url);
      if (!raw.includes("query=")) return new Response(JSON.stringify({ sessions: [], page: 1, pageSize: 20, total: 0, totalPages: 0, catalogRevision: 0 }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({
        sessions: [{ ...SESSIONS[1]!, matchSource: "message" }],
        page: 1, pageSize: 20, total: 1, totalPages: 1, catalogRevision: 0,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    mountPalette();
    const input = screen.getByTestId("search-palette-input");
    fireEvent.change(input, { target: { value: "three" } });
    await settleDebounce();
    const meta = await waitFor(() => {
      const element = document.querySelector(".search-palette-meta");
      expect(element).toBeTruthy();
      return element!;
    });
    expect(meta!.textContent).toContain("Message: ");
    expect(meta!.querySelector("strong")?.textContent).toBe("three");
  });

  it("arrow keys cycle with wrap-around and enter opens through the shared navigation callback", async () => {
    globalThis.fetch = searchStubFetch(SESSIONS);
    const onOpenSession = vi.fn();
    const onClose = vi.fn();
    mountPalette({ onOpenSession, onClose });
    await screen.findByText("侧栏改版方案");
    const input = screen.getByTestId("search-palette-input");
    const rows = () => screen.getAllByRole("option");
    expect(rows()[0]!.getAttribute("data-active")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe("search-palette-option-alpha");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(rows()[1]!.getAttribute("data-active")).toBe("true");
    // Wrap-around from the last row back to the first.
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(rows()[0]!.getAttribute("data-active")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(onOpenSession).toHaveBeenCalledWith("alpha", "/x");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("never opens a session from an IME composition Enter", async () => {
    globalThis.fetch = searchStubFetch(SESSIONS);
    const onOpenSession = vi.fn();
    mountPalette({ onOpenSession });
    await screen.findByText("侧栏改版方案");
    const input = screen.getByTestId("search-palette-input");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(onOpenSession).not.toHaveBeenCalled();
    // A plain Enter still opens.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpenSession).toHaveBeenCalledTimes(1);
  });

  it("escape closes without clearing the input; reopen keeps the query", async () => {
    globalThis.fetch = searchStubFetch(SESSIONS);
    const onClose = vi.fn();
    const { rerender } = mountPalette({ onClose });
    await screen.findByText("侧栏改版方案");
    const input = screen.getByTestId("search-palette-input");
    fireEvent.change(input, { target: { value: "侧栏" } });
    await settleDebounce();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    // The parent flips `open`; the component keeps its draft for next time.
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <HttpClientProvider>
          <CapabilityProvider host={{ mode: "local", capabilities: ["sessions"] }}>
            <I18nProvider>
              <SessionSearchPalette
                open={false}
                onClose={onClose}
                onOpenSession={vi.fn()}
                runningSessionIds={new Set<string>()}
                waitingSessionIds={new Set<string>()}
              />
            </I18nProvider>
          </CapabilityProvider>
        </HttpClientProvider>
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId("search-palette")).toBeNull();
  });

  it("shows the empty result copy only after a settled keyword search", async () => {
    globalThis.fetch = searchStubFetch(SESSIONS);
    mountPalette();
    await screen.findByText("侧栏改版方案");
    const input = screen.getByTestId("search-palette-input");
    fireEvent.change(input, { target: { value: "zzz" } });
    const empty = await waitFor(() => {
      const element = screen.getByTestId("search-palette-empty");
      expect(element).toBeTruthy();
      return element;
    });
    expect(empty.textContent).toContain("zzz");
    expect(screen.getByText("Try words from the session's first message")).toBeTruthy();
  });

  it("keeps the previous result while the next keyword request is in flight (no empty flash)", async () => {
    let release: ((value: Response) => void) | undefined;
    let first = true;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const raw = String(typeof input === "string" ? input : input instanceof URL ? `${input.pathname}${input.search}` : input.url);
      if (!raw.includes("query=")) {
        return new Response(JSON.stringify({ sessions: SESSIONS.filter((row) => row.archived !== true).slice(0, 8), page: 1, pageSize: 8, total: 3, totalPages: 1, catalogRevision: 0 }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (first) {
        first = false;
        return new Response(JSON.stringify({
          sessions: [{ ...SESSIONS[0]!, matchSource: "title" }],
          page: 1, pageSize: 20, total: 1, totalPages: 1, catalogRevision: 0,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return await new Promise<Response>((resolve) => { release = resolve; });
    }) as unknown as typeof fetch;
    mountPalette();
    await screen.findByText("侧栏改版方案");
    const input = screen.getByTestId("search-palette-input");
    fireEvent.change(input, { target: { value: "侧栏" } });
    await settleDebounce();
    expect(await screen.findByText("侧栏改版方案")).toBeTruthy();
    fireEvent.change(input, { target: { value: "周报" } });
    await settleDebounce();
    // The in-flight second keyword keeps the FIRST result on screen.
    expect(screen.getByText("侧栏改版方案")).toBeTruthy();
    expect(screen.queryByTestId("search-palette-empty")).toBeNull();
    release?.(new Response(JSON.stringify({ sessions: [], page: 1, pageSize: 20, total: 0, totalPages: 0, catalogRevision: 0 }), { status: 200, headers: { "content-type": "application/json" } }));
    await waitFor(() => expect(screen.getByTestId("search-palette-empty")).toBeTruthy());
  });

  it("renders the waiting dot and running spinner from the shared status sources", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const raw = String(typeof input === "string" ? input : input instanceof URL ? `${input.pathname}${input.search}` : input.url);
      const rows = [
        { ...SESSIONS[0]!, sessionId: "wait", title: "Waiting row" },
        { ...SESSIONS[1]!, sessionId: "run", title: "Running row" },
        { ...SESSIONS[2]!, sessionId: "idle", title: "Idle row", firstMessage: undefined },
      ];
      const needle = new URL(raw, "http://pix.local").searchParams.get("query");
      const filtered = needle === null ? rows : rows.filter((row) => (row.title ?? "").toLowerCase().includes(needle.trim().toLowerCase()));
      return new Response(JSON.stringify({ sessions: filtered, page: 1, pageSize: 20, total: filtered.length, totalPages: filtered.length === 0 ? 0 : 1, catalogRevision: 0 }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    mountPalette({
      runningSessionIds: new Set(["run"]),
      waitingSessionIds: new Set(["wait"]),
    });
    await screen.findByText("Idle row");
    const rowOf = (label: string) => screen.getByText(label).closest("button")!;
    expect(rowOf("Waiting row").querySelector(".session-status-dot[data-status='waiting']")).toBeTruthy();
    expect(rowOf("Running row").querySelector(".sidebar-row-status")).toBeTruthy();
    // An idle row shows neither marker — only the compact activity time.
    expect(rowOf("Idle row").querySelector(".session-status-dot")).toBeNull();
    expect(rowOf("Idle row").querySelector(".sidebar-row-status")).toBeNull();
    expect(rowOf("Idle row").querySelector(".search-palette-aside")?.textContent).toBeTruthy();
  });

  it("clear button resets to the recent list", async () => {
    globalThis.fetch = searchStubFetch(SESSIONS);
    mountPalette();
    await screen.findByText("侧栏改版方案");
    const input = screen.getByTestId("search-palette-input");
    fireEvent.change(input, { target: { value: "Weekly" } });
    await settleDebounce();
    expect(screen.getByText("Weekly report")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Clear"));
    await waitFor(() => expect((screen.getByTestId("search-palette-input") as HTMLInputElement).value).toBe(""));
    expect(screen.getByText("Recent")).toBeTruthy();
  });

  it("shows how many more results exist beyond the served page", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const raw = String(typeof input === "string" ? input : input instanceof URL ? `${input.pathname}${input.search}` : input.url);
      if (!raw.includes("query=")) return new Response(JSON.stringify({ sessions: [], page: 1, pageSize: 8, total: 0, totalPages: 0, catalogRevision: 0 }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({
        sessions: [{ ...SESSIONS[0]!, matchSource: "title" }],
        page: 1, pageSize: 20, total: 6, totalPages: 1, catalogRevision: 0,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    mountPalette();
    fireEvent.change(screen.getByTestId("search-palette-input"), { target: { value: "侧栏" } });
    await settleDebounce();
    expect(await screen.findByText("5 more results")).toBeTruthy();
    const results = screen.getByTestId("search-palette-results");
    expect(within(results).getAllByRole("option")).toHaveLength(1);
  });
});
