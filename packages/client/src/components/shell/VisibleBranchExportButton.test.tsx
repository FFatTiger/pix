import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { HttpClientProvider } from "@/app/http-context";
import { VisibleBranchExportButton } from "./VisibleBranchExportButton";
import type { HostCapability, HostInfo } from "@fffattiger/pix-protocol";
import { VISIBLE_BRANCH_EXPORT_ERROR } from "@/lib/visible-branch-export";

function contextResponse(sessionId: string, text = "hello history") {
  return new Response(
    JSON.stringify({
      context: {
        sessionId,
        leafId: "leaf-1",
        entries: [
          {
            entryId: "e1",
            message: { role: "user", content: text, timestamp: 1 },
          },
          {
            entryId: "e2",
            parentEntryId: "e1",
            message: {
              role: "assistant",
              model: "m",
              provider: "p",
              content: [
                { type: "text", text: "reply" },
                { type: "thinking", thinking: "" },
                {
                  type: "toolCall",
                  toolCallId: "tc1",
                  toolName: "read",
                  input: { path: "/tmp/x" },
                },
              ],
              writtenFiles: ["/secret"],
              timestamp: 2,
            },
          },
          {
            entryId: "e3",
            parentEntryId: "e2",
            message: {
              role: "bashExecution",
              command: "true",
              output: "",
              exitCode: 0,
              fullOutputPath: "/tmp/full.log",
              timestamp: 3,
            },
          },
        ],
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function mount(
  props: {
    sessionId: string;
    selectionMatchesLive: boolean;
    host?: Partial<HostInfo> | null;
    downloadDeps?: Parameters<typeof VisibleBranchExportButton>[0]["downloadDeps"];
    queryClient?: QueryClient;
  },
) {
  const qc =
    props.queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const defaultHost: Partial<HostInfo> = {
    mode: "local",
    capabilities: ["sessions", "agent"] as HostCapability[],
  };
  const host = props.host === undefined ? defaultHost : props.host;
  return render(
    <QueryClientProvider client={qc}>
      <HttpClientProvider>
        <CapabilityProvider host={host}>
          <VisibleBranchExportButton
            sessionId={props.sessionId}
            selectionMatchesLive={props.selectionMatchesLive}
            {...(props.downloadDeps === undefined ? {} : { downloadDeps: props.downloadDeps })}
          />
        </CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>,
  );
}

function stubDownloadDeps() {
  const click = vi.fn();
  const createObjectURL = vi.fn(() => "blob:vbe");
  const revokeObjectURL = vi.fn();
  const appendChild = vi.fn();
  const removeChild = vi.fn();
  const blobParts: string[] = [];
  const setTimeout = vi.fn((fn: () => void) => {
    fn();
    return 0;
  });
  const createElement = vi.fn(() => {
    const el = {
      href: "",
      download: "",
      style: { display: "" },
      setAttribute: vi.fn(),
      click,
    };
    return el as unknown as HTMLAnchorElement;
  });
  const BlobCtor = vi.fn(function BlobMock(this: unknown, parts: BlobPart[], opts?: BlobPropertyBag) {
    for (const part of parts) {
      if (typeof part === "string") blobParts.push(part);
      else if (part instanceof ArrayBuffer) blobParts.push(new TextDecoder().decode(part));
      else if (ArrayBuffer.isView(part)) {
        blobParts.push(new TextDecoder().decode(part as ArrayBufferView<ArrayBuffer>));
      }
    }
    return { parts, opts };
  }) as unknown as typeof Blob;
  return {
    deps: {
      createObjectURL,
      revokeObjectURL,
      appendChild,
      removeChild,
      createElement,
      setTimeout,
      Blob: BlobCtor,
    },
    click,
    createObjectURL,
    createElement,
    blobParts,
  };
}

describe("VisibleBranchExportButton", () => {
  let previousFetch: typeof fetch;
  beforeEach(() => {
    previousFetch = globalThis.fetch;
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = previousFetch;
    cleanup();
  });

  it("is hidden when selectionMatchesLive (no request)", async () => {
    const fetchMock = vi.fn(async () => contextResponse("s-live"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    mount({ sessionId: "s-live", selectionMatchesLive: true });
    expect(screen.queryByRole("button", { name: "Export visible branch" })).toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is hidden without sessions capability (zero context requests)", async () => {
    const fetchMock = vi.fn(async () => contextResponse("s-b"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    mount({
      sessionId: "s-b",
      selectionMatchesLive: false,
      host: { mode: "local", capabilities: ["agent"] as HostCapability[] },
    });
    expect(screen.queryByRole("button", { name: "Export visible branch" })).toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows disabled button while loading, then enables after context arrives", async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    globalThis.fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    ) as unknown as typeof fetch;

    mount({ sessionId: "s-hist", selectionMatchesLive: false });
    const btn = await screen.findByRole("button", { name: "Export visible branch" });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Selected context branch only/i)).toBeTruthy();

    await act(async () => {
      resolveFetch?.(contextResponse("s-hist"));
    });
    await waitFor(() => expect((screen.getByRole("button", { name: "Export visible branch" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("stays disabled on context error and never shows raw error text", async () => {
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    mount({ sessionId: "s-err", selectionMatchesLive: false });
    const btn = await screen.findByRole("button", { name: "Export visible branch" });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(true));
    expect(screen.queryByText(/nope|500|Internal/i)).toBeNull();
  });

  it("history success downloads once with selected session only; double-click does not double-download", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain("/v1/sessions/");
      expect(url).toContain("s-b");
      expect(url).not.toMatch(/\/export|\/thinking|bash-output/);
      return contextResponse("s-b", "branch-b");
    }) as unknown as typeof fetch;

    const { deps, click, createElement } = stubDownloadDeps();
    mount({ sessionId: "s-b", selectionMatchesLive: false, downloadDeps: deps });

    const btn = await screen.findByRole("button", { name: "Export visible branch" });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(click).toHaveBeenCalledTimes(1);

    const anchor = createElement.mock.results[0]!.value as HTMLAnchorElement;
    expect(anchor.download).toBe("pix-visible-branch-s-b.json");
    // Filename must not embed title/cwd/content.
    expect(anchor.download).not.toContain("branch-b");
    expect(anchor.download).not.toContain("leaf");
  });

  it("keeps busyRef through microtasks until the next macrotask so a second click cannot double-download", async () => {
    globalThis.fetch = vi.fn(async () => contextResponse("s-busy", "once")) as unknown as typeof fetch;
    const { deps, click } = stubDownloadDeps();
    // download helper's setTimeout must not steal fake-timer control from the busyRef release.
    const downloadSetTimeout = vi.fn((fn: () => void) => {
      fn();
      return 0;
    });
    mount({
      sessionId: "s-busy",
      selectionMatchesLive: false,
      downloadDeps: { ...deps, setTimeout: downloadSetTimeout },
    });

    // Resolve the context query with real timers first (react-query needs them).
    const btn = await screen.findByRole("button", { name: "Export visible branch" });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));

    vi.useFakeTimers();
    try {
      fireEvent.click(btn);
      expect(click).toHaveBeenCalledTimes(1);

      // Microtasks alone must not release the guard (real dblclick can span tasks).
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      fireEvent.click(btn);
      expect(click).toHaveBeenCalledTimes(1);

      // After the macrotask timer fires, a subsequent click may download again.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(btn);
      expect(click).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("A→B stale query race: late A resolve must not change the B export filename or bytes", async () => {
    let resolveA: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("sess-a")) {
        return new Promise<Response>((resolve) => {
          resolveA = resolve;
        });
      }
      if (url.includes("sess-b")) {
        return contextResponse("sess-b", "CONTENT-FROM-B-ONLY");
      }
      return new Response("missing", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { deps, click, createElement, blobParts } = stubDownloadDeps();

    const view = mount({
      sessionId: "sess-a",
      selectionMatchesLive: false,
      downloadDeps: deps,
      queryClient: qc,
    });

    // A is pending — button present but disabled.
    const btnA = await screen.findByRole("button", { name: "Export visible branch" });
    expect((btnA as HTMLButtonElement).disabled).toBe(true);
    expect(resolveA).toBeTypeOf("function");

    // Rerender same QueryClient onto B; B returns and becomes exportable.
    view.rerender(
      <QueryClientProvider client={qc}>
        <HttpClientProvider>
          <CapabilityProvider
            host={{
              mode: "local",
              capabilities: ["sessions", "agent"] as HostCapability[],
            }}
          >
            <VisibleBranchExportButton
              sessionId="sess-b"
              selectionMatchesLive={false}
              downloadDeps={deps}
            />
          </CapabilityProvider>
        </HttpClientProvider>
      </QueryClientProvider>,
    );

    const btnB = await screen.findByRole("button", { name: "Export visible branch" });
    await waitFor(() => expect((btnB as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(btnB);
    expect(click).toHaveBeenCalledTimes(1);
    const anchor = createElement.mock.results[0]!.value as HTMLAnchorElement;
    expect(anchor.download).toBe("pix-visible-branch-sess-b.json");
    const exportedBytes = blobParts.join("");
    expect(exportedBytes).toContain("CONTENT-FROM-B-ONLY");
    expect(exportedBytes).toContain("sess-b");
    expect(exportedBytes).not.toContain("CONTENT-FROM-A-ONLY");
    expect(exportedBytes).not.toContain("sess-a");

    // Late A resolve must not alter the already-exported B snapshot / next click still B.
    await act(async () => {
      resolveA?.(contextResponse("sess-a", "CONTENT-FROM-A-ONLY"));
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Button still targets B (selected session unchanged).
    const btnAfter = screen.getByRole("button", { name: "Export visible branch" });
    expect((btnAfter as HTMLButtonElement).disabled).toBe(false);
    // Re-export after busyRef macrotask would still be B; assert prior bytes stayed B-only.
    expect(blobParts.join("")).toContain("CONTENT-FROM-B-ONLY");
    expect(blobParts.join("")).not.toContain("CONTENT-FROM-A-ONLY");
    expect(createElement.mock.results[0]!.value.download).toBe("pix-visible-branch-sess-b.json");
  });

  it("surfaces the fixed export error without leaking raw failure details", async () => {
    globalThis.fetch = vi.fn(async () => contextResponse("s-b")) as unknown as typeof fetch;
    const { deps } = stubDownloadDeps();
    const failingDeps = {
      ...deps,
      createObjectURL: () => {
        throw new Error("raw-blob-failure-SECRET");
      },
    };
    mount({ sessionId: "s-b", selectionMatchesLive: false, downloadDeps: failingDeps });
    const btn = await screen.findByRole("button", { name: "Export visible branch" });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(btn);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(VISIBLE_BRANCH_EXPORT_ERROR);
    expect(alert.textContent).not.toContain("SECRET");
    expect(screen.queryByText(/raw-blob-failure/)).toBeNull();
  });

  it("never issues /export, /thinking, bash-output, or websocket traffic", async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return contextResponse("s-b");
    }) as unknown as typeof fetch;
    const wsSpy = vi.fn();
    const PreviousWS = globalThis.WebSocket;
    // @ts-expect-error test stub
    globalThis.WebSocket = wsSpy;

    try {
      const { deps } = stubDownloadDeps();
      mount({ sessionId: "s-b", selectionMatchesLive: false, downloadDeps: deps });
      const btn = await screen.findByRole("button", { name: "Export visible branch" });
      await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(btn);
      expect(urls.every((u) => !/\/export|\/thinking|bash-output/i.test(u))).toBe(true);
      expect(wsSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.WebSocket = PreviousWS;
    }
  });
});

describe("VisibleBranchExportButton via AppShell selection gates", () => {
  // Lightweight re-export of shell gate expectations using the button in isolation
  // with the same props AppShell computes (search.session + selectionMatchesLive).
  let previousFetch: typeof fetch;
  beforeEach(() => {
    previousFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
    cleanup();
  });

  it("attached A + selected B is exportable for B only", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("s-a")) return contextResponse("s-a", "from-A");
      return contextResponse("s-b", "from-B");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { deps, createElement } = stubDownloadDeps();

    // Simulate AppShell props for selected B while A is attached (live=false).
    mount({ sessionId: "s-b", selectionMatchesLive: false, downloadDeps: deps });
    const btn = await screen.findByRole("button", { name: "Export visible branch" });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(btn);
    const anchor = createElement.mock.results[0]!.value as HTMLAnchorElement;
    expect(anchor.download).toBe("pix-visible-branch-s-b.json");
    // Only B context was requested.
    expect(fetchMock.mock.calls.every((call) => String(call[0]).includes("s-b"))).toBe(true);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("s-a"))).toBe(false);
  });
});
