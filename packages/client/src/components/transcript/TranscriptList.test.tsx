import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";
import { RuntimeProvider, useRuntimeStore } from "@/runtime";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { HttpClientProvider } from "@/app/http-context";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import { FakeWebSocket, flush, lastFrame, snapshotPayload } from "@/runtime/testing/harness";
import type { RuntimeSocketDeps } from "@/runtime/socket";
import type { SessionStore } from "@/runtime/session-store";
import type { HostInfo } from "@fffattiger/pix-protocol";
import { useEffect, type ReactNode } from "react";
import { TranscriptList, projectAssistantBlocks } from "./TranscriptList";
import { buildTranscriptRows } from "./row-model";
import { installVirtualization, restoreVirtualization } from "@/lib/testing/virtualization";
import { LIVE_BASH_ROW_ID, projectBashViewModel } from "./bash-view-model";

// TranscriptList uses the hand-rolled virtualizer (src/lib/virtual-list). jsdom
// has no ResizeObserver, so it degrades to render-all and every row mounts.
// The dedicated UX1 windowed tests below install a mock ResizeObserver to
// exercise the real windowed path deterministically.

const SOCKETS: FakeWebSocket[] = [];
function fakeDeps(): RuntimeSocketDeps {
  return {
    createWebSocket: (url) => {
      const ws = new FakeWebSocket(url);
      SOCKETS.push(ws);
      return ws;
    },
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

let capturedStore: SessionStore | null = null;
function Capture(): null {
  const store = useRuntimeStore();
  useEffect(() => {
    capturedStore = store;
  }, [store]);
  return null;
}

function mount(
  children: ReactNode,
  host: Partial<HostInfo> | null | undefined = {
    mode: "local",
    capabilities: ["agent", "sessions"],
  },
): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ErrorBoundary>
      <QueryClientProvider client={qc}>
        <HttpClientProvider>
          <CapabilityProvider {...(host === undefined ? {} : { host })}>
            <RuntimeProvider deps={fakeDeps()}>
              <Capture />
              {children}
            </RuntimeProvider>
          </CapabilityProvider>
        </HttpClientProvider>
      </QueryClientProvider>
    </ErrorBoundary>,
  );
}

/**
 * Mount that allows re-rendering with a different capability host while keeping
 * the SAME QueryClient and runtime store, so cached query data and in-flight
 * requests survive a capability transition (true→false revocation). Returns a
 * `rerender(nextHost)` that only swaps the CapabilityProvider host prop.
 */
function mountDynamic(
  children: ReactNode,
  host: Partial<HostInfo> | null | undefined,
): (nextHost: Partial<HostInfo> | null | undefined) => void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const deps = fakeDeps();
  const tree = (h: Partial<HostInfo> | null | undefined): ReactNode => (
    <ErrorBoundary>
      <QueryClientProvider client={qc}>
        <HttpClientProvider>
          <CapabilityProvider {...(h === undefined ? {} : { host: h })}>
            <RuntimeProvider deps={deps}>
              <Capture />
              {children}
            </RuntimeProvider>
          </CapabilityProvider>
        </HttpClientProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
  const view = render(tree(host));
  return (nextHost: Partial<HostInfo> | null | undefined) => view.rerender(tree(nextHost));
}

function ack(caps: string[] = ["agent"]) {
  return {
    type: "handshake_ack",
    payload: {
      protocolVersion: 1,
      host: { mode: "local", capabilities: caps },
      limits: { maxUpload: 0, maxOpenSessions: 4 },
      sessionSnapshotSupport: true,
    },
  };
}

async function driveReady(): Promise<FakeWebSocket> {
  const store = capturedStore!;
  let ws: FakeWebSocket | undefined;
  await act(async () => {
    store.connect();
    ws = SOCKETS[SOCKETS.length - 1]!;
    ws.serverOpen();
    ws.serverSend(ack());
    await flush();
  });
  return ws!;
}

async function driveAttach(ws: FakeWebSocket, sessionId = "s1"): Promise<void> {
  const store = capturedStore!;
  await act(async () => {
    void store.openSession(sessionId);
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId }) });
    await flush();
  });
}

async function serverSend(ws: FakeWebSocket, message: unknown): Promise<void> {
  await act(async () => {
    ws.serverSend(message);
    await flush();
  });
}

function assistantContentResponse(
  sessionId: string,
  content: Array<
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string }
    | { type: "toolCall"; toolCallId: string; toolName: string; input: unknown }
    | { type: "image"; source: { type: "url"; url: string } }
  >,
) {
  return new Response(
    JSON.stringify({
      context: {
        sessionId,
        entries: [
          {
            entryId: "e-assistant",
            message: {
              role: "assistant",
              content,
              model: "m",
              provider: "p",
            },
          },
        ],
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("projectAssistantBlocks", () => {
  it("keeps interleaved thinking/text order and drops empty thinking", () => {
    const parts = projectAssistantBlocks([
      { type: "thinking", thinking: "first" },
      { type: "text", text: "mid" },
      { type: "thinking", thinking: "" },
      { type: "thinking", thinking: "second" },
      { type: "text", text: "end" },
      { type: "toolCall", toolCallId: "t1", toolName: "read", input: { path: "a" } },
      { type: "image", source: { type: "url", url: "https://example.com/x.png" } },
    ]);
    expect(parts).toEqual([
      { type: "thinking", thinking: "first" },
      { type: "text", text: "mid" },
      { type: "thinking", thinking: "second" },
      { type: "text", text: "end" },
      { type: "toolCall", text: 'read({"path":"a"})' },
      { type: "image", text: "[image]" },
    ]);
  });

  it("concatenates adjacent same-type text/thinking without trimming", () => {
    const parts = projectAssistantBlocks(
      [
        { type: "thinking", thinking: "  a" },
        { type: "thinking", thinking: "b  " },
        { type: "text", text: "x" },
        { type: "text", text: "y" },
        { type: "thinking", thinking: "z" },
      ],
      { streaming: true },
    );
    expect(parts).toEqual([
      { type: "thinking", thinking: "  ab  ", streaming: true },
      { type: "text", text: "xy" },
      { type: "thinking", thinking: "z", streaming: true },
    ]);
  });

  it("marks streaming thinking without rewriting raw content", () => {
    const parts = projectAssistantBlocks([{ type: "thinking", thinking: "  keep  " }], {
      streaming: true,
    });
    expect(parts).toEqual([{ type: "thinking", thinking: "  keep  ", streaming: true }]);
  });
});

describe("TranscriptList — history thinking display", () => {
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

  it("renders history thinking + text as separate parts; completed thinking defaults closed", async () => {
    globalThis.fetch = vi.fn(async () =>
      assistantContentResponse("s-hist", [
        { type: "thinking", thinking: "history plan" },
        { type: "text", text: "history answer" },
      ]),
    ) as unknown as typeof fetch;

    mount(<TranscriptList sessionId="s-hist" live={false} />);

    expect(await screen.findByText("history answer")).toBeTruthy();
    const details = screen.getByText("Thinking").closest("details");
    expect(details).toBeTruthy();
    expect(details?.open).toBe(false);
    expect(within(details!).getByText("history plan")).toBeTruthy();
    // Text is outside the thinking container.
    expect(details?.textContent).not.toContain("history answer");
  });

  it("preserves multi thinking/text interleaving order", async () => {
    globalThis.fetch = vi.fn(async () =>
      assistantContentResponse("s-hist", [
        { type: "thinking", thinking: "t1" },
        { type: "text", text: "a1" },
        { type: "thinking", thinking: "t2" },
        { type: "text", text: "a2" },
      ]),
    ) as unknown as typeof fetch;

    mount(<TranscriptList sessionId="s-hist" live={false} />);
    await screen.findByText("a2");

    const body = document.querySelector(".transcript-row-body");
    expect(body).toBeTruthy();
    const children = Array.from(body!.children);
    expect(children).toHaveLength(4);
    expect(children[0]?.classList.contains("transcript-thinking")).toBe(true);
    expect(children[0]?.textContent).toContain("t1");
    expect(children[1]?.textContent).toBe("a1");
    expect(children[2]?.classList.contains("transcript-thinking")).toBe(true);
    expect(children[2]?.textContent).toContain("t2");
    expect(children[3]?.textContent).toBe("a2");
  });

  it("does not render an empty thinking container", async () => {
    globalThis.fetch = vi.fn(async () =>
      assistantContentResponse("s-hist", [
        { type: "thinking", thinking: "" },
        { type: "text", text: "only answer" },
      ]),
    ) as unknown as typeof fetch;

    mount(<TranscriptList sessionId="s-hist" live={false} />);
    expect(await screen.findByText("only answer")).toBeTruthy();
    expect(screen.queryByText("Thinking")).toBeNull();
    expect(document.querySelectorAll(".transcript-thinking")).toHaveLength(0);
  });

  it("renders script-looking thinking as pure text (no HTML execution)", async () => {
    const payload = '<script>alert("xss")</script>';
    globalThis.fetch = vi.fn(async () =>
      assistantContentResponse("s-hist", [
        { type: "thinking", thinking: payload },
        { type: "text", text: "safe" },
      ]),
    ) as unknown as typeof fetch;

    mount(<TranscriptList sessionId="s-hist" live={false} />);
    expect(await screen.findByText("safe")).toBeTruthy();
    // React text rendering: the literal characters appear, no script node is created.
    expect(screen.getByText(payload)).toBeTruthy();
    expect(document.querySelectorAll("script")).toHaveLength(0);
    const thinkingBody = document.querySelector(".transcript-thinking-body");
    expect(thinkingBody?.textContent).toBe(payload);
    expect(thinkingBody?.innerHTML).toContain("&lt;script&gt;");
  });

  it("does not request the /thinking endpoint when loading history", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/thinking")) {
        throw new Error(`unexpected /thinking fetch: ${url}`);
      }
      return assistantContentResponse("s-hist", [
        { type: "thinking", thinking: "from context" },
        { type: "text", text: "answer" },
      ]);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    mount(<TranscriptList sessionId="s-hist" live={false} />);
    expect(await screen.findByText("answer")).toBeTruthy();
    expect(screen.getByText("from context")).toBeTruthy();

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => !url.includes("/thinking"))).toBe(true);
    expect(urls.some((url) => url.includes("/context") || url.includes("sessions"))).toBe(true);
  });
});

describe("TranscriptList — live streaming thinking", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    SOCKETS.length = 0;
    capturedStore = null;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("updates streaming thinking on one stable row: active open, manually closeable, completed closed", async () => {
    mount(<TranscriptList sessionId="s1" live />);
    const ws = await driveReady();
    await driveAttach(ws);

    await serverSend(ws, {
      type: "event",
      payload: {
        type: "message_start",
        sessionId: "s1",
        streamId: "st",
        messageId: "m",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "live-start" }],
          model: "m",
          provider: "p",
        },
        eventId: 1,
        epoch: "e1",
      },
    });

    expect(screen.getByText("live-start")).toBeTruthy();
    const partialRows = document.querySelectorAll('[data-row-id="row:partial"]');
    expect(partialRows).toHaveLength(1);
    let details = screen.getByText("Thinking").closest("details")!;
    expect(details.open).toBe(true);

    // Manual collapse must be allowed while still streaming.
    fireEvent.click(within(details).getByText("Thinking"));
    expect(details.open).toBe(false);

    await serverSend(ws, {
      type: "event",
      payload: {
        type: "message_update",
        sessionId: "s1",
        streamId: "st",
        messageId: "m",
        delta: { role: "assistant", delta: { type: "thinking", thinking: "-plan" } },
        eventId: 2,
        epoch: "e1",
      },
    });

    // Still a single stable partial row after the update.
    expect(document.querySelectorAll('[data-row-id="row:partial"]')).toHaveLength(1);
    expect(screen.getByText("live-start-plan")).toBeTruthy();
    // User's manual close is preserved across content updates (local open state).
    details = screen.getByText("Thinking").closest("details")!;
    expect(details.open).toBe(false);

    await serverSend(ws, {
      type: "event",
      payload: {
        type: "message_update",
        sessionId: "s1",
        streamId: "st",
        messageId: "m",
        delta: { role: "assistant", delta: { type: "text", text: "final" } },
        eventId: 3,
        epoch: "e1",
      },
    });
    expect(screen.getByText("final")).toBeTruthy();

    await serverSend(ws, {
      type: "event",
      payload: {
        type: "message_end",
        sessionId: "s1",
        streamId: "st",
        messageId: "m",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "live-start-plan" },
            { type: "text", text: "final" },
          ],
          model: "m",
          provider: "p",
        },
        eventId: 4,
        epoch: "e1",
      },
    });

    // Partial row is gone; completed assistant row has closed thinking by default.
    expect(document.querySelectorAll('[data-row-id="row:partial"]')).toHaveLength(0);
    expect(screen.getByText("final")).toBeTruthy();
    const completed = screen.getByText("Thinking").closest("details")!;
    expect(completed.open).toBe(false);
    expect(within(completed).getByText("live-start-plan")).toBeTruthy();
    // One top-level assistant message row (not one row per part).
    expect(document.querySelectorAll(".transcript-row--assistant")).toHaveLength(1);
  });
});

describe("TranscriptList — selection boundary (no A→B thinking leak)", () => {
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

  it("selected B history never shows attached A's live thinking", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/sessions/s-b/") || url.includes("sessions/s-b")) {
        return assistantContentResponse("s-b", [{ type: "text", text: "B history only" }]);
      }
      return assistantContentResponse("s-a", [{ type: "text", text: "A history" }]);
    }) as unknown as typeof fetch;

    // Mount with live=false as AppShell does when selectionMatchesLive is false.
    mount(<TranscriptList sessionId="s-b" live={false} />);

    expect(await screen.findByText("B history only")).toBeTruthy();

    // Runtime attaches to A and streams thinking — must not appear in B's transcript.
    // Use real timers (history fetch); drive runtime after B history is visible.
    vi.useFakeTimers();
    try {
      const ws = await driveReady();
      await driveAttach(ws, "s-a");
      await serverSend(ws, {
        type: "event",
        payload: {
          type: "message_start",
          sessionId: "s-a",
          streamId: "st",
          messageId: "m",
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: "SECRET-A-THINKING" }],
            model: "m",
            provider: "p",
          },
          eventId: 1,
          epoch: "e1",
        },
      });
    } finally {
      vi.useRealTimers();
    }

    expect(screen.getByText("B history only")).toBeTruthy();
    expect(screen.queryByText("SECRET-A-THINKING")).toBeNull();
    expect(screen.queryByText("Thinking")).toBeNull();
  });
});

describe("TranscriptList — rows prop path", () => {
  let previousFetch: typeof fetch;
  beforeEach(() => {
    previousFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
    cleanup();
  });

  it("renders prebuilt structured rows without network", () => {
    const rows = buildTranscriptRows([
      {
        id: "prebuilt",
        role: "assistant",
        text: "t\nanswer",
        parts: [
          { type: "thinking", thinking: "t" },
          { type: "text", text: "answer" },
        ],
      },
    ]);
    mount(<TranscriptList rows={rows} />);
    expect(screen.getByText("answer")).toBeTruthy();
    const details = screen.getByText("Thinking").closest("details");
    expect(details?.open).toBe(false);
  });

  it("explicit rows ignore the sessions capability: shows only rows, no history-unavailable / No messages, and issues no context fetch", () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("unexpected context fetch");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const rows = buildTranscriptRows([
      { id: "explicit-1", role: "assistant", text: "explicit answer" },
    ]);
    // No sessions capability — explicit rows are not session history, so they
    // must render and never show the history-unavailable overlay.
    mount(<TranscriptList rows={rows} />, { mode: "local", capabilities: ["agent"] });

    expect(screen.getByText("explicit answer")).toBeTruthy();
    expect(screen.queryByText("Session history unavailable until the runtime connects.")).toBeNull();
    expect(screen.queryByText("No messages")).toBeNull();
    expect(document.querySelectorAll(".transcript-empty")).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explicit empty rows show no overlay even without sessions capability", () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("unexpected context fetch");
    }) as unknown as typeof fetch;

    mount(<TranscriptList rows={[]} />, { mode: "local", capabilities: ["agent"] });

    expect(screen.queryByText("Session history unavailable until the runtime connects.")).toBeNull();
    expect(screen.queryByText("No messages")).toBeNull();
    expect(document.querySelectorAll(".transcript-empty")).toHaveLength(0);
  });
});

function bashHistoryResponse(
  sessionId: string,
  message: {
    command: string;
    output: string;
    exitCode?: number;
    cancelled?: boolean;
    truncated?: boolean;
    fullOutputPath?: string;
    excludeFromContext?: boolean;
  },
) {
  return new Response(
    JSON.stringify({
      context: {
        sessionId,
        entries: [
          {
            entryId: "e-bash",
            message: {
              role: "bashExecution",
              command: message.command,
              output: message.output,
              ...(message.exitCode === undefined ? {} : { exitCode: message.exitCode }),
              ...(message.cancelled === undefined ? {} : { cancelled: message.cancelled }),
              ...(message.truncated === undefined ? {} : { truncated: message.truncated }),
              ...(message.fullOutputPath === undefined ? {} : { fullOutputPath: message.fullOutputPath }),
              ...(message.excludeFromContext === undefined
                ? {}
                : { excludeFromContext: message.excludeFromContext }),
            },
          },
        ],
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("TranscriptList — history bash display", () => {
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

  it("renders command, output, exit code; empty output; cancelled; truncated", async () => {
    globalThis.fetch = vi.fn(async () =>
      bashHistoryResponse("s-bash", {
        command: "echo hi",
        output: "hi\n",
        exitCode: 0,
        truncated: true,
      }),
    ) as unknown as typeof fetch;

    mount(<TranscriptList sessionId="s-bash" live={false} />);
    expect(await screen.findByText("$ echo hi")).toBeTruthy();
    expect(document.querySelector(".transcript-bash-output")?.textContent).toBe("hi\n");
    expect(screen.getByText("exit 0")).toBeTruthy();
    expect(screen.getByText("truncated")).toBeTruthy();
    expect(document.querySelectorAll(".transcript-row--bash")).toHaveLength(1);
  });

  it("shows fixed (no output) sentinel for empty output", async () => {
    globalThis.fetch = vi.fn(async () =>
      bashHistoryResponse("s-bash", { command: "true", output: "" }),
    ) as unknown as typeof fetch;

    mount(<TranscriptList sessionId="s-bash" live={false} />);
    expect(await screen.findByText("$ true")).toBeTruthy();
    expect(screen.getByText("(no output)")).toBeTruthy();
  });

  it("renders cancelled status without inventing exit", async () => {
    globalThis.fetch = vi.fn(async () =>
      bashHistoryResponse("s-bash", {
        command: "sleep 99",
        output: "partial",
        cancelled: true,
      }),
    ) as unknown as typeof fetch;

    mount(<TranscriptList sessionId="s-bash" live={false} />);
    expect(await screen.findByText("cancelled")).toBeTruthy();
    expect(screen.queryByText(/^exit /)).toBeNull();
  });

  it("never puts fullOutputPath in the DOM and ignores excludeFromContext for hide", async () => {
    const secretPath = "/var/secret/bash-full-output-xyz";
    globalThis.fetch = vi.fn(async () =>
      bashHistoryResponse("s-bash", {
        command: "cat secret",
        output: "ok",
        exitCode: 0,
        fullOutputPath: secretPath,
        excludeFromContext: true,
      }),
    ) as unknown as typeof fetch;

    mount(<TranscriptList sessionId="s-bash" live={false} />);
    expect(await screen.findByText("$ cat secret")).toBeTruthy();
    // Row is still shown despite excludeFromContext.
    expect(document.querySelectorAll(".transcript-row--bash")).toHaveLength(1);
    expect(document.body.innerHTML).not.toContain(secretPath);
    expect(document.body.innerHTML).not.toContain("fullOutputPath");
    // No title / data attributes carrying the path.
    for (const el of Array.from(document.querySelectorAll("*"))) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.value).not.toContain(secretPath);
      }
    }
  });

  it("renders HTML/script bash output as pure text", async () => {
    const payload = '<script>alert("xss")</script>';
    globalThis.fetch = vi.fn(async () =>
      bashHistoryResponse("s-bash", {
        command: "echo xss",
        output: payload,
        exitCode: 0,
      }),
    ) as unknown as typeof fetch;

    mount(<TranscriptList sessionId="s-bash" live={false} />);
    expect(await screen.findByText(payload)).toBeTruthy();
    expect(document.querySelectorAll("script")).toHaveLength(0);
    const pre = document.querySelector(".transcript-bash-output");
    expect(pre?.textContent).toBe(payload);
    expect(pre?.innerHTML).toContain("&lt;script&gt;");
  });

  it("does not fetch bash-output API and does not send runtime commands", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("bash-output") || url.includes("/bash/")) {
        throw new Error(`unexpected bash fetch: ${url}`);
      }
      return bashHistoryResponse("s-bash", {
        command: "ls",
        output: "a",
        exitCode: 0,
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    mount(<TranscriptList sessionId="s-bash" live={false} />);
    expect(await screen.findByText("$ ls")).toBeTruthy();

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.every((url) => !url.includes("bash-output"))).toBe(true);
    expect(urls.every((url) => !url.includes("/thinking"))).toBe(true);
    // History path must not open a websocket runtime command frame.
    expect(SOCKETS).toHaveLength(0);
  });
});

describe("TranscriptList — live state.bash display", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    SOCKETS.length = 0;
    capturedStore = null;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("keeps one stable state row across output/status updates and reconnect", async () => {
    mount(<TranscriptList sessionId="s1" live />);
    const ws = await driveReady();
    await driveAttach(ws);

    await serverSend(ws, {
      type: "event",
      payload: {
        type: "bash_update",
        sessionId: "s1",
        command: "echo live",
        output: "Hello ",
        eventId: 1,
        epoch: "e1",
      },
    });

    expect(screen.getByText("$ echo live")).toBeTruthy();
    expect(document.querySelector(".transcript-bash-output")?.textContent).toBe("Hello ");
    expect(screen.getByText("running")).toBeTruthy();
    expect(document.querySelectorAll(`[data-row-id="${LIVE_BASH_ROW_ID}"]`)).toHaveLength(1);

    await serverSend(ws, {
      type: "event",
      payload: {
        type: "bash_update",
        sessionId: "s1",
        output: "World",
        eventId: 2,
        epoch: "e1",
      },
    });

    // Still a single stable row; content updated in place.
    expect(document.querySelectorAll(`[data-row-id="${LIVE_BASH_ROW_ID}"]`)).toHaveLength(1);
    expect(document.querySelectorAll(".transcript-row--bash")).toHaveLength(1);
    expect(document.querySelector(".transcript-bash-output")?.textContent).toBe("Hello World");

    await serverSend(ws, {
      type: "event",
      payload: {
        type: "bash_update",
        sessionId: "s1",
        exitCode: 0,
        truncated: true,
        eventId: 3,
        epoch: "e1",
      },
    });

    expect(document.querySelectorAll(`[data-row-id="${LIVE_BASH_ROW_ID}"]`)).toHaveLength(1);
    expect(screen.getByText("exit 0")).toBeTruthy();
    expect(screen.getByText("truncated")).toBeTruthy();
    expect(screen.queryByText("running")).toBeNull();

    // Snapshot replace (reconnect) restores the same stable row id.
    // Prefer a mid-stream snapshot frame (no openSession) so cleanup does not
    // race a pending attach promise after the store is disposed.
    await act(async () => {
      ws.serverSend({
        type: "snapshot",
        payload: {
          ...snapshotPayload({ sessionId: "s1", resumeStatus: "gap" }),
          snapshot: {
            sessionId: "s1",
            cwd: "/x",
            projectRoot: "/x",
            state: {
              sessionId: "s1",
              isStreaming: false,
              isPromptRunning: false,
              isBashRunning: false,
              isCompacting: false,
              model: null,
              messageCount: 0,
              bash: {
                command: "echo live",
                output: "Hello World",
                excludeFromContext: false,
                truncated: true,
                cancelled: false,
                completed: true,
                exitCode: 0,
                updateCount: 3,
              },
            },
            capabilities: { capabilities: ["runtime.prompt", "runtime.abort"], version: 1 },
            streaming: { active: false, phase: "idle" },
            messages: [],
          },
        },
      });
      await flush();
    });

    expect(document.querySelectorAll(`[data-row-id="${LIVE_BASH_ROW_ID}"]`)).toHaveLength(1);
    expect(screen.getByText("$ echo live")).toBeTruthy();
    expect(document.querySelector(".transcript-bash-output")?.textContent).toBe("Hello World");
  });

  it("shows both message and state bash rows when both are present (no identity => no hide)", async () => {
    mount(<TranscriptList sessionId="s1" live />);
    const ws = await driveReady();
    await driveAttach(ws);

    // Full snapshot replace carrying both completed bashExecution + state.bash
    // with distinct command/output so we prove neither side is swallowed.
    await act(async () => {
      ws.serverSend({
        type: "snapshot",
        payload: {
          ...snapshotPayload({ sessionId: "s1", resumeStatus: "gap" }),
          snapshot: {
            sessionId: "s1",
            cwd: "/x",
            projectRoot: "/x",
            state: {
              sessionId: "s1",
              isStreaming: false,
              isPromptRunning: false,
              isBashRunning: false,
              isCompacting: false,
              model: null,
              messageCount: 1,
              bash: {
                command: "echo state-cmd",
                output: "state-output",
                excludeFromContext: false,
                truncated: false,
                cancelled: false,
                completed: true,
                exitCode: 0,
                updateCount: 1,
                fullOutputPath: "/secret/live.out",
              },
            },
            capabilities: { capabilities: ["runtime.prompt", "runtime.abort"], version: 1 },
            streaming: { active: false, phase: "idle" },
            messages: [
              {
                role: "bashExecution",
                command: "echo msg-cmd",
                output: "msg-output",
                exitCode: 0,
                fullOutputPath: "/secret/msg.out",
              },
            ],
          },
        },
      });
      await flush();
    });

    // Both bash rows visible: message command/output + state command/output.
    // No authoritative execution id => never hide either side.
    expect(document.querySelectorAll(".transcript-row--bash")).toHaveLength(2);
    expect(document.querySelectorAll(`[data-row-id="${LIVE_BASH_ROW_ID}"]`)).toHaveLength(1);
    expect(screen.getByText("$ echo msg-cmd")).toBeTruthy();
    expect(screen.getByText("msg-output")).toBeTruthy();
    expect(screen.getByText("$ echo state-cmd")).toBeTruthy();
    expect(screen.getByText("state-output")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("/secret/live.out");
    expect(document.body.innerHTML).not.toContain("/secret/msg.out");
  });

  it("does not emit runtime.bash / abort_bash frames from transcript display", async () => {
    mount(<TranscriptList sessionId="s1" live />);
    const ws = await driveReady();
    await driveAttach(ws);

    await serverSend(ws, {
      type: "event",
      payload: {
        type: "bash_update",
        sessionId: "s1",
        command: "pwd",
        output: "/tmp\n",
        exitCode: 0,
        eventId: 1,
        epoch: "e1",
      },
    });

    expect(screen.getByText("$ pwd")).toBeTruthy();
    const commandFrames = ws.sent.filter((frame) => {
      const f = frame as { type?: string; payload?: { command?: { type?: string } } };
      return f.type === "command";
    });
    // Only attach/handshake lifecycle — no bash command frames from the transcript.
    for (const frame of commandFrames) {
      const type = (frame as { payload?: { command?: { type?: string } } }).payload?.command?.type;
      expect(type).not.toBe("bash");
      expect(type).not.toBe("abort_bash");
    }
  });
});

describe("TranscriptList — selection boundary (no A→B bash leak)", () => {
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

  it("selected B history never shows attached A's live bash state", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/sessions/s-b/") || url.includes("sessions/s-b")) {
        return bashHistoryResponse("s-b", {
          command: "echo B",
          output: "B history bash",
          exitCode: 0,
        });
      }
      return bashHistoryResponse("s-a", { command: "echo A", output: "A", exitCode: 0 });
    }) as unknown as typeof fetch;

    mount(<TranscriptList sessionId="s-b" live={false} />);
    expect(await screen.findByText("B history bash")).toBeTruthy();

    vi.useFakeTimers();
    try {
      const ws = await driveReady();
      await driveAttach(ws, "s-a");
      await serverSend(ws, {
        type: "event",
        payload: {
          type: "bash_update",
          sessionId: "s-a",
          command: "echo SECRET-A-BASH",
          output: "SECRET-A-OUTPUT",
          eventId: 1,
          epoch: "e1",
        },
      });
    } finally {
      vi.useRealTimers();
    }

    expect(screen.getByText("B history bash")).toBeTruthy();
    expect(screen.queryByText("SECRET-A-OUTPUT")).toBeNull();
    expect(screen.queryByText("$ echo SECRET-A-BASH")).toBeNull();
    expect(document.querySelectorAll(`[data-row-id="${LIVE_BASH_ROW_ID}"]`)).toHaveLength(0);
  });
});

describe("projectBashViewModel integration via prebuilt rows", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders shared bash view-model on prebuilt rows", () => {
    const bash = projectBashViewModel({
      command: "prebuilt",
      output: "out",
      exitCode: 2,
      fullOutputPath: "/nope",
    });
    const rows = buildTranscriptRows([
      {
        id: "bash-pre",
        role: "bash",
        text: `$ prebuilt\nout\nexit 2`,
        bash,
      },
    ]);
    mount(<TranscriptList rows={rows} />);
    expect(screen.getByText("$ prebuilt")).toBeTruthy();
    expect(screen.getByText("out")).toBeTruthy();
    expect(screen.getByText("exit 2")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("/nope");
  });
});

describe("TranscriptList — history capability fail-closed", () => {
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

  it("hides cached history immediately when the sessions capability is retracted (same QueryClient, no new fetch)", async () => {
    const fetchMock = vi.fn(async () =>
      assistantContentResponse("s-rev", [{ type: "text", text: "CACHED HISTORY" }]),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const rerender = mountDynamic(<TranscriptList sessionId="s-rev" live={false} />, {
      mode: "local",
      capabilities: ["agent", "sessions"],
    });

    // History loaded and cached on the shared QueryClient.
    expect(await screen.findByText("CACHED HISTORY")).toBeTruthy();
    expect(screen.queryByText("Session history unavailable until the runtime connects.")).toBeNull();
    const callsBefore = fetchMock.mock.calls.length;

    // Revoke the sessions capability without remounting (same QueryClient + store).
    rerender({ mode: "local", capabilities: ["agent"] });

    // Stale cached history is hidden immediately; the honest message appears.
    expect(screen.queryByText("CACHED HISTORY")).toBeNull();
    expect(screen.getByText("Session history unavailable until the runtime connects.")).toBeTruthy();
    expect(screen.queryByText("No messages")).toBeNull();

    // No additional context request is triggered by the revocation.
    await act(async () => {
      await flush();
    });
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it("ignores a late-arriving context response after capability revocation", async () => {
    let resolveHistory!: (response: Response) => void;
    const historyPromise = new Promise<Response>((resolve) => {
      resolveHistory = resolve;
    });
    const fetchMock = vi.fn(async () => historyPromise);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const rerender = mountDynamic(<TranscriptList sessionId="s-late" live={false} />, {
      mode: "local",
      capabilities: ["agent", "sessions"],
    });

    // The context request is in flight (pending) and not yet resolved.
    await act(async () => {
      await flush();
    });
    expect(fetchMock.mock.calls.length).toBe(1);
    // With-cap + pending keeps the existing loading/empty semantics ("No messages").
    expect(screen.getByText("No messages")).toBeTruthy();

    // Revoke the capability while the request is still in flight.
    rerender({ mode: "local", capabilities: ["agent"] });
    expect(screen.getByText("Session history unavailable until the runtime connects.")).toBeTruthy();

    // The late response now arrives successfully.
    await act(async () => {
      resolveHistory(assistantContentResponse("s-late", [{ type: "text", text: "LATE HISTORY" }]));
      await flush();
    });

    // Late history must not be restored; the unavailable message persists.
    expect(screen.queryByText("LATE HISTORY")).toBeNull();
    expect(screen.getByText("Session history unavailable until the runtime connects.")).toBeTruthy();
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it("renders the unavailable message (not No messages) and issues 0 context requests with no sessions capability", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("unexpected context fetch");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    mount(<TranscriptList sessionId="s-nocap" live={false} />, {
      mode: "local",
      capabilities: ["agent"],
    });

    expect(screen.getByText("Session history unavailable until the runtime connects.")).toBeTruthy();
    expect(screen.queryByText("No messages")).toBeNull();

    await act(async () => {
      await flush();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows No messages when sessions capability is present but context is empty", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ context: { sessionId: "s-empty", entries: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    mount(<TranscriptList sessionId="s-empty" live={false} />, {
      mode: "local",
      capabilities: ["agent", "sessions"],
    });
    expect(await screen.findByText("No messages")).toBeTruthy();
    expect(screen.queryByText("Session history unavailable until the runtime connects.")).toBeNull();
  });

  it("renders the live transcript when sessions capability is absent (no unavailable message, no context fetch)", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("unexpected context fetch");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    mount(<TranscriptList sessionId="s-live" live />, {
      mode: "local",
      capabilities: ["agent"],
    });
    const ws = await driveReady();
    await driveAttach(ws, "s-live");

    await serverSend(ws, {
      type: "event",
      payload: {
        type: "message_start",
        sessionId: "s-live",
        streamId: "st",
        messageId: "m",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "LIVE MESSAGE" }],
          model: "m",
          provider: "p",
        },
        eventId: 1,
        epoch: "e1",
      },
    });

    expect(screen.getByText("LIVE MESSAGE")).toBeTruthy();
    expect(screen.queryByText("Session history unavailable until the runtime connects.")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("TranscriptList — UX1 virtualization (windowed)", () => {
  let previousFetch: typeof fetch;
  beforeEach(() => {
    previousFetch = globalThis.fetch;
    SOCKETS.length = 0;
    capturedStore = null;
  });
  afterEach(() => {
    cleanup();
    restoreVirtualization();
    globalThis.fetch = previousFetch;
  });

  function makeRows(count: number, estimateHeight = 48) {
    return buildTranscriptRows(
      Array.from({ length: count }, (_, i) => ({
        id: `row-${i}`,
        role: "user" as const,
        text: `message ${i}`,
        estimateHeight,
      })),
    );
  }

  function mountRows(rows: ReturnType<typeof makeRows>) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (r: ReturnType<typeof makeRows>): ReactNode => (
      <ErrorBoundary>
        <QueryClientProvider client={qc}>
          <HttpClientProvider>
            <CapabilityProvider host={{ mode: "local", capabilities: ["agent"] }}>
              <RuntimeProvider deps={fakeDeps()}>
                <TranscriptList rows={r} />
              </RuntimeProvider>
            </CapabilityProvider>
          </HttpClientProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    );
    const view = render(tree(rows));
    return { rerender: (next: ReturnType<typeof makeRows>) => view.rerender(tree(next)) };
  }

  it("2000 rows: bounded mounted row count regardless of data size, correct window at scrollTop 0", () => {
    const env = installVirtualization();
    mountRows(makeRows(2000));
    const scroller = document.querySelector(".transcript-scroll") as HTMLElement;
    expect(scroller).toBeTruthy();
    act(() => {
      env.setClientHeight(scroller, 600);
      env.fireViewport(scroller);
    });
    // Deterministic estimate-only window: rows are never measured in jsdom, so
    // every row uses the 48px estimate.
    const rows = Array.from(document.querySelectorAll(".transcript-row"));
    const budget = Math.ceil(600 / 48) + 2 * 8 + 2;
    expect(rows.length).toBeLessThanOrEqual(budget);
    const indexes = rows.map((el) => Number((el as HTMLElement).dataset.index));
    expect(Math.min(...indexes)).toBe(0);
    expect(Math.max(...indexes)).toBeLessThan(2000);
    // The inner spacer carries the full scroll height; rows are absolutely
    // positioned at their content offsets.
    const inner = document.querySelector(".transcript-inner") as HTMLElement;
    expect(Number(inner.style.height.replace("px", ""))).toBe(2000 * 48);
    expect((rows[0] as HTMLElement).style.transform).toContain("translateY(0px)");
  });

  it("window content matches the scrollTop exactly (2000 rows)", () => {
    const env = installVirtualization();
    mountRows(makeRows(2000));
    const scroller = document.querySelector(".transcript-scroll") as HTMLElement;
    act(() => {
      env.setClientHeight(scroller, 600);
      env.fireViewport(scroller);
    });
    act(() => {
      env.setScrollTop(scroller, 48 * 500);
    });
    const rows = Array.from(document.querySelectorAll(".transcript-row"));
    const indexes = rows.map((el) => Number((el as HTMLElement).dataset.index));
    expect(Math.min(...indexes)).toBe(500 - 8);
    expect(Math.max(...indexes)).toBe(500 + Math.floor(600 / 48) + 8);
    expect((rows[0] as HTMLElement).style.transform).toContain(
      `translateY(${48 * (500 - 8)}px)`,
    );
  });

  it("dynamic measurement of a taller row updates total height (varying block heights)", () => {
    const env = installVirtualization();
    mountRows(makeRows(100));
    const scroller = document.querySelector(".transcript-scroll") as HTMLElement;
    act(() => {
      env.setClientHeight(scroller, 600);
      env.fireViewport(scroller);
    });
    const inner = document.querySelector(".transcript-inner") as HTMLElement;
    expect(Number(inner.style.height.replace("px", ""))).toBe(100 * 48);
    // Measure row 0 as a much taller block (e.g. a long tool output).
    const row0 = document.querySelector('[data-index="0"]') as HTMLElement;
    act(() => {
      env.measureRow(row0, 200);
    });
    expect(Number(inner.style.height.replace("px", ""))).toBe(200 + 99 * 48);
  });

  it("auto-scrolls to bottom on content growth while pinned; scrolling up releases the pin", () => {
    const env = installVirtualization();
    const view = mountRows(makeRows(20));
    const scroller = document.querySelector(".transcript-scroll") as HTMLElement;
    act(() => {
      env.setClientHeight(scroller, 600);
      env.fireViewport(scroller);
      env.setScrollHeight(scroller, 10000);
    });
    // Growth while pinned at the bottom auto-scrolls to the bottom edge.
    view.rerender(makeRows(100));
    expect(scroller.scrollTop).toBe(10000);
    // User scrolls up -> pin released -> further growth preserves position.
    act(() => {
      env.setScrollTop(scroller, 200);
    });
    view.rerender(makeRows(150));
    expect(scroller.scrollTop).toBe(200);
  });
});
