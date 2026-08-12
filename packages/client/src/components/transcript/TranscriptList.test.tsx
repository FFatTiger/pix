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

// jsdom gives the scroll container 0 height, so the real virtualizer renders no
// rows. Stub it to render every row so runtime→row integration is testable.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, getItemKey }: { count: number; getItemKey?: (index: number) => string | number }) => ({
    getTotalSize: () => count * 48,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        key: getItemKey?.(index) ?? index,
        index,
        start: index * 48,
      })),
    measureElement: () => undefined,
  }),
}));

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
  afterEach(() => {
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
});
