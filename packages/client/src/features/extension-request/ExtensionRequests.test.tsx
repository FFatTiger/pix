import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { RuntimeProvider, SelectedSessionProvider } from "@/runtime";
import { I18nProvider } from "@/hooks/useI18n";
import { ExtensionRequests } from "./ExtensionRequests";
import { FakeWebSocket, flush, lastFrame } from "@/runtime/testing/harness";
import { CaptureTestRuntime } from "@/runtime/testing/capture-test-runtime";
import type { TestRuntimeStore } from "@/runtime/testing/test-runtime-store";
import type { RuntimeSocketDeps } from "@/runtime";
import type { HostInfo } from "@fffattiger/pix-protocol";
import { useEffect, useRef, useState } from "react";

const SOCKETS: FakeWebSocket[] = [];
function fakeDeps(): RuntimeSocketDeps {
  return {
    createWebSocket: (url) => { const ws = new FakeWebSocket(url); SOCKETS.push(ws); return ws; },
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

let capturedStore: TestRuntimeStore | null = null;

const EXT_CAPS = ["runtime.prompt", "runtime.abort", "runtime.extension_ui"];

function mountExtension(host: Partial<HostInfo> = { mode: "local", capabilities: ["agent"] }): React.RefObject<HTMLTextAreaElement | null> {
  const composerRef = { current: null as HTMLTextAreaElement | null };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() {
    const ref = useRef<HTMLTextAreaElement | null>(null);
    useEffect(() => { composerRef.current = ref.current; }, []);
    // ExtensionRequests binds the selected-session exact runtime
    // (4A.3.2b1a), so the harness declares the selected session via
    // SelectedSessionProvider exactly as the router boundary does.
    return (
      <SelectedSessionProvider sessionId="s1">
        <ExtensionRequests live composerTextareaRef={ref} />
      </SelectedSessionProvider>
    );
  }
  render(
    <ErrorBoundary>
      <QueryClientProvider client={qc}>
        <HttpClientProvider>
          <CapabilityProvider {...(host === undefined ? {} : { host })}>
            <RuntimeProvider deps={fakeDeps()}>
              <I18nProvider>
                <CaptureTestRuntime onStore={(store) => { capturedStore = store; }} />
                <Harness />
              </I18nProvider>
            </RuntimeProvider>
          </CapabilityProvider>
        </HttpClientProvider>
      </QueryClientProvider>
    </ErrorBoundary>,
  );
  return composerRef;
}

function ack() {
  return { type: "handshake_ack", payload: { protocolVersion: 2, host: { mode: "local", capabilities: ["agent"] }, limits: { maxUpload: 0, maxOpenSessions: 4 }, sessionSnapshotSupport: true } };
}

function extensionSnapshotFor(sessionId: string) {
  return {
    sessionId,
    cwd: "/x",
    projectRoot: "/x",
    epoch: "e1",
    lastEventId: 0,
    workerStatus: "ready",
    resumeStatus: "snapshot",
    snapshot: {
      sessionId,
      cwd: "/x",
      projectRoot: "/x",
      state: {
        sessionId,
        isStreaming: false,
        isPromptRunning: false,
        isBashRunning: false,
        isCompacting: false,
        model: null,
        messageCount: 0,
        pendingExtensionUi: [{ id: "req-custom", method: "custom", lines: ["line one"] }],
      },
      capabilities: { capabilities: EXT_CAPS, version: 1 },
      streaming: { active: false, phase: "idle" },
    },
  };
}

function extensionSnapshot() {
  return extensionSnapshotFor("s1");
}

async function attachWithExtension(): Promise<FakeWebSocket> {
  const store = capturedStore!;
  let ws: FakeWebSocket | undefined;
  await act(async () => {
    store.connect();
    ws = SOCKETS[SOCKETS.length - 1]!;
    ws.serverOpen();
    ws.serverSend(ack());
    await flush();
    void store.openSession("s1").catch(() => {});
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: extensionSnapshot() });
    await flush();
  });
  return ws!;
}

interface InputFrame {
  type: string;
  id: string;
  payload: { sessionId: string; command: { commandId: string; type: string; data: string } };
}

function lastInputFrame(ws: FakeWebSocket): InputFrame {
  for (let i = ws.sent.length - 1; i >= 0; i--) {
    const frame = ws.sent[i] as InputFrame;
    if (frame.payload?.command?.type === "extension_ui_input") return frame;
  }
  throw new Error("no extension_ui_input frame");
}

async function serverSend(ws: FakeWebSocket, message: unknown): Promise<void> {
  await act(async () => {
    ws.serverSend(message);
    await flush();
  });
}

describe("ExtensionRequests — custom input error surfacing (F7)", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("shows a transient FIXED error on custom input rejection and clears it on the next success", async () => {
    const composerRef = mountExtension();
    const ws = await attachWithExtension();
    // The custom panel renders with its hidden terminal textarea.
    const textarea = screen.getByLabelText("Extension input");
    expect(textarea).toBeTruthy();

    // First chunk (ArrowUp → "\x1b[A") is rejected by the runtime with session_busy.
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    await flush();
    const first = lastInputFrame(ws);
    expect(first.payload.command.data).toBe("\x1b[A");
    await serverSend(ws, { type: "response", id: first.id, payload: { ok: false, error: { code: "session_busy", message: "secret raw input payload", retryable: false } } });

    const alert = screen.getByRole("alert");
    // FIXED copy only — the raw message/key/data never leak.
    expect(alert.textContent).toBe("Another extension response is in progress.");
    expect(alert.textContent).not.toContain("secret");
    expect(alert.textContent).not.toContain("\x1b[A");

    // Next chunk (Enter → "\r") succeeds → the error clears.
    fireEvent.keyDown(textarea, { key: "Enter" });
    await flush();
    const second = lastInputFrame(ws);
    expect(second.payload.command.data).toBe("\r");
    await serverSend(ws, { type: "response", id: second.id, payload: { ok: true, result: { commandId: second.payload.command.commandId, result: { ok: true, type: "extension_ui_input" } } } });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(composerRef).toBeTruthy();
  });

  it("renders nothing when the extension_ui capability is not advertised", async () => {
    mountExtension();
    const store = capturedStore!;
    await act(async () => {
      store.connect();
      const ws = SOCKETS[SOCKETS.length - 1]!;
      ws.serverOpen();
      ws.serverSend(ack());
      await flush();
      void store.openSession("s1").catch(() => {});
      await flush();
      const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
      ws.serverSend({
        type: "snapshot",
        id: attachFrame.id,
        payload: {
          sessionId: "s1", cwd: "/x", projectRoot: "/x", epoch: "e1", lastEventId: 0, workerStatus: "ready", resumeStatus: "snapshot",
          snapshot: {
            sessionId: "s1", cwd: "/x", projectRoot: "/x",
            state: { sessionId: "s1", isStreaming: false, isPromptRunning: false, isBashRunning: false, isCompacting: false, model: null, messageCount: 0, pendingExtensionUi: [{ id: "req-custom", method: "custom", lines: ["x"] }] },
            capabilities: { capabilities: ["runtime.prompt", "runtime.abort"], version: 1 },
            streaming: { active: false, phase: "idle" },
            messages: [],
          },
        },
      });
      await flush();
    });
    expect(screen.queryByLabelText("Extension input")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("A/B exact isolation: switching the selection to an unadmitted B renders nothing and emits ZERO frames for B", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Harness() {
      const ref = useRef<HTMLTextAreaElement | null>(null);
      const [selected, setSelected] = useState<string | null>("A");
      return (
        <>
          <SelectedSessionProvider sessionId={selected}>
            <ExtensionRequests live composerTextareaRef={ref} />
          </SelectedSessionProvider>
          <button type="button" onClick={() => setSelected("B")}>selectB</button>
          <button type="button" onClick={() => setSelected(null)}>clear</button>
        </>
      );
    }
    render(
      <ErrorBoundary>
        <QueryClientProvider client={qc}>
          <HttpClientProvider>
            <CapabilityProvider host={{ mode: "local", capabilities: ["agent"] }}>
              <RuntimeProvider deps={fakeDeps()}>
                <I18nProvider>
                  <CaptureTestRuntime onStore={(store) => { capturedStore = store; }} />
                  <Harness />
                </I18nProvider>
              </RuntimeProvider>
            </CapabilityProvider>
          </HttpClientProvider>
        </QueryClientProvider>
      </ErrorBoundary>,
    );
    const store = capturedStore!;
    let ws: FakeWebSocket | undefined;
    await act(async () => {
      store.connect();
      ws = SOCKETS[SOCKETS.length - 1]!;
      ws.serverOpen();
      ws.serverSend(ack());
      await flush();
      // Attach the selected session A with a pending custom extension request.
      void store.openSession("A").catch(() => {});
      await flush();
      const attachFrame = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "attach")!;
      expect(attachFrame.payload.sessionId).toBe("A");
      ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: extensionSnapshotFor("A") });
      await flush();
    });
    // Selection A is live → the custom panel renders.
    expect(screen.getByLabelText("Extension input")).toBeTruthy();
    const attachCountBefore = (ws!.sent as Array<{ type: string }>).filter((f) => f.type === "attach").length;
    const commandCountBefore = (ws!.sent as Array<{ type: string }>).filter((f) => f.type === "command").length;
    // Switch selection to unadmitted B: exact isolation → nothing renders, and
    // B is never admitted/attached (zero frames, zero registry admission).
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "selectB" })); await flush(); });
    expect(screen.queryByLabelText("Extension input")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    const attachFrames = (ws!.sent as Array<{ type: string; payload?: { sessionId?: string } }>).filter((f) => f.type === "attach");
    expect(attachFrames.length).toBe(attachCountBefore);
    expect(attachFrames.some((f) => f.payload?.sessionId === "B")).toBe(false);
    expect((ws!.sent as Array<{ type: string }>).filter((f) => f.type === "command").length).toBe(commandCountBefore);
    expect(store.registry.peek("B")).toBeNull();
    // Clear the selection entirely → still nothing rendered (home/file).
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "clear" })); await flush(); });
    expect(screen.queryByLabelText("Extension input")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

type PendingUiRequest =
  | { id: string; method: "input"; title: string; placeholder: string }
  | { id: string; method: "editor"; title: string; prefill: string }
  | {
    id: string;
    method: "questionnaire";
    questions: {
      header: string;
      question: string;
      multiSelect: boolean;
      options: { label: string; description: string; preview?: string }[];
    }[];
  };

function pendingSnapshot(
  sessionId: string,
  request: PendingUiRequest,
  epoch = "e1",
) {
  return {
    sessionId,
    cwd: "/x",
    projectRoot: "/x",
    epoch,
    lastEventId: 0,
    workerStatus: "ready",
    resumeStatus: "snapshot",
    snapshot: {
      sessionId,
      cwd: "/x",
      projectRoot: "/x",
      state: {
        sessionId,
        isStreaming: false,
        isPromptRunning: false,
        isBashRunning: false,
        isCompacting: false,
        model: null,
        messageCount: 0,
        pendingExtensionUi: [request],
      },
      capabilities: { capabilities: EXT_CAPS, version: 1 },
      streaming: { active: false, phase: "idle" },
    },
  };
}

async function attachPending(
  sessionId: string,
  request: PendingUiRequest,
  epoch = "e1",
): Promise<FakeWebSocket> {
  const store = capturedStore!;
  let ws: FakeWebSocket | undefined;
  await act(async () => {
    store.connect();
    ws = SOCKETS[SOCKETS.length - 1]!;
    ws.serverOpen();
    ws.serverSend(ack());
    await flush();
    void store.openSession(sessionId).catch(() => {});
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: pendingSnapshot(sessionId, request, epoch) });
    await flush();
  });
  return ws!;
}

function lastResponseFrame(ws: FakeWebSocket): { payload: { command: { type: string; id: string; method: string; value?: string; answers?: unknown } } } {
  for (let i = ws.sent.length - 1; i >= 0; i--) {
    const frame = ws.sent[i] as { payload?: { command?: { type: string; id: string; method: string; value?: string; answers?: unknown } } };
    if (frame.payload?.command?.type === "extension_ui_response") return frame as { payload: { command: { type: string; id: string; method: string; value?: string; answers?: unknown } } };
  }
  throw new Error("no extension_ui_response frame");
}

function questionnairePending() {
  return {
    id: "req-q",
    method: "questionnaire" as const,
    questions: [
      {
        header: "H1",
        question: "Color?",
        multiSelect: false,
        options: [{ label: "Red", description: "r" }, { label: "Blue", description: "b" }],
      },
      {
        header: "H2",
        question: "Tools?",
        multiSelect: true,
        options: [{ label: "A", description: "alpha", preview: "preview-A" }, { label: "B", description: "beta" }],
      },
    ],
  };
}

describe("ExtensionRequests — input/editor draft identity", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("keeps a typed input draft across a structuredClone snapshot of the same request and submits it", async () => {
    mountExtension();
    const ws = await attachPending("s1", { id: "r1", method: "input", title: "Name", placeholder: "type" });
    const input = screen.getByPlaceholderText("type") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "custom answer" } });
    expect(input.value).toBe("custom answer");

    await serverSend(ws, {
      type: "event",
      payload: {
        type: "extension_ui_request",
        sessionId: "s1",
        eventId: 1,
        epoch: "e1",
        request: { id: "r1", method: "input", title: "Name", placeholder: "type" },
      },
    });
    expect((screen.getByPlaceholderText("type") as HTMLInputElement).value).toBe("custom answer");
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await flush();
    expect(lastResponseFrame(ws).payload.command).toMatchObject({ id: "r1", method: "input", value: "custom answer" });
  });

  it("keeps editor edits when the same prefill request is cloned through a runtime event", async () => {
    mountExtension();
    const ws = await attachPending("s1", { id: "r2", method: "editor", title: "Edit", prefill: "seed" });
    const textarea = screen.getByDisplayValue("seed") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "edited seed" } });

    await serverSend(ws, {
      type: "event",
      payload: {
        type: "extension_ui_request",
        sessionId: "s1",
        eventId: 1,
        epoch: "e1",
        request: { id: "r2", method: "editor", title: "Edit", prefill: "seed" },
      },
    });
    expect((screen.getByDisplayValue("edited seed") as HTMLTextAreaElement).value).toBe("edited seed");
  });

  it("resets the draft when the current selection switches A→B with a reused request id", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Harness() {
      const ref = useRef<HTMLTextAreaElement | null>(null);
      const [selected, setSelected] = useState<string | null>("A");
      return (
        <>
          <SelectedSessionProvider sessionId={selected}>
            <ExtensionRequests live composerTextareaRef={ref} />
          </SelectedSessionProvider>
          <button type="button" onClick={() => setSelected("B")}>selectB</button>
        </>
      );
    }
    render(
      <ErrorBoundary>
        <QueryClientProvider client={qc}>
          <HttpClientProvider>
            <CapabilityProvider host={{ mode: "local", capabilities: ["agent"] }}>
              <RuntimeProvider deps={fakeDeps()}>
                <I18nProvider>
                  <CaptureTestRuntime onStore={(store) => { capturedStore = store; }} />
                  <Harness />
                </I18nProvider>
              </RuntimeProvider>
            </CapabilityProvider>
          </HttpClientProvider>
        </QueryClientProvider>
      </ErrorBoundary>,
    );
    const store = capturedStore!;
    let ws: FakeWebSocket | undefined;
    await act(async () => {
      store.connect();
      ws = SOCKETS[SOCKETS.length - 1]!;
      ws.serverOpen();
      ws.serverSend(ack());
      await flush();
      void store.openSession("A").catch(() => {});
      await flush();
      const attachA = lastFrame<{ type: string; id: string }>(ws, "attach")!;
      ws.serverSend({
        type: "snapshot",
        id: attachA.id,
        payload: pendingSnapshot("A", { id: "shared", method: "input", title: "Name", placeholder: "type" }),
      });
      await flush();
    });
    fireEvent.change(screen.getByPlaceholderText("type"), { target: { value: "session A draft" } });
    expect((screen.getByPlaceholderText("type") as HTMLInputElement).value).toBe("session A draft");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "selectB" }));
      await flush();
      const acquireB = store.openSession("B");
      acquireB.catch(() => {});
      await flush();
      if (store.registry.leaseSnapshot.phase === "releasing") {
        const detach = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws!, "detach")!;
        ws!.serverSend({ type: "response", id: detach.id, payload: { ok: true, result: { sessionId: detach.payload.sessionId, detached: true } } });
        await flush();
      }
      const attachB = lastFrame<{ type: string; id: string; payload?: { sessionId?: string } }>(ws!, "attach")!;
      expect(attachB.payload?.sessionId).toBe("B");
      ws!.serverSend({
        type: "snapshot",
        id: attachB.id,
        payload: pendingSnapshot("B", { id: "shared", method: "input", title: "Other", placeholder: "type" }),
      });
      await acquireB;
    });
    expect((screen.getByPlaceholderText("type") as HTMLInputElement).value).toBe("");
  });

  it("resets immediately when the first pending method changes on the same request id", async () => {
    mountExtension();
    const ws = await attachPending("s1", { id: "shared", method: "input", title: "Name", placeholder: "type" });
    fireEvent.change(screen.getByPlaceholderText("type"), { target: { value: "typed" } });

    await serverSend(ws, {
      type: "event",
      payload: {
        type: "extension_ui_request",
        sessionId: "s1",
        eventId: 1,
        epoch: "e1",
        request: { id: "shared", method: "editor", title: "Edit", prefill: "fresh prefill" },
      },
    });
    expect((screen.getByDisplayValue("fresh prefill") as HTMLTextAreaElement).value).toBe("fresh prefill");
  });

  it("uses the translated section aria-label in en and zh-CN", async () => {
    window.localStorage.setItem("pi-locale", "en");
    mountExtension();
    await attachPending("s1", { id: "r1", method: "input", title: "Name", placeholder: "type" });
    expect(screen.getByRole("region", { name: "Extension request" })).toBeTruthy();
    cleanup();
    capturedStore = null;
    SOCKETS.length = 0;
    window.localStorage.setItem("pi-locale", "zh-CN");
    mountExtension();
    await attachPending("s1", { id: "r1", method: "input", title: "Name", placeholder: "type" });
    expect(screen.getByRole("region", { name: "扩展请求" })).toBeTruthy();
  });
});

describe("ExtensionRequests — questionnaire dispatch", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; window.localStorage.removeItem("pi-locale"); });
  afterEach(() => { cleanup(); vi.useRealTimers(); window.localStorage.removeItem("pi-locale"); });

  it("submits every answer once and does not dispatch on Prev/Next", async () => {
    mountExtension();
    const ws = await attachPending("s1", questionnairePending());
    fireEvent.click(screen.getByRole("radio", { name: /Red/ }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect((ws.sent as Array<{ payload?: { command?: { type?: string } } }>).filter((frame) => frame.payload?.command?.type === "extension_ui_response")).toHaveLength(0);
    fireEvent.click(screen.getByRole("checkbox", { name: /A/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await flush();
    const responses = (ws.sent as Array<{ payload?: { command?: { type?: string; answers?: unknown } } }>).filter((frame) => frame.payload?.command?.type === "extension_ui_response");
    expect(responses).toHaveLength(1);
    expect(lastResponseFrame(ws).payload.command).toMatchObject({
      id: "req-q",
      method: "questionnaire",
      answers: [
        { kind: "option", questionIndex: 0, optionIndex: 0 },
        { kind: "multi", questionIndex: 1, optionIndices: [0] },
      ],
    });
  });

  it("resets questionnaire drafts when a new request id replaces the current one", async () => {
    mountExtension();
    const ws = await attachPending("s1", questionnairePending());
    fireEvent.click(screen.getByRole("radio", { name: /Red/ }));
    await serverSend(ws, {
      type: "event",
      payload: {
        type: "extension_ui_request",
        sessionId: "s1",
        eventId: 1,
        epoch: "e1",
        request: { ...questionnairePending(), closed: true },
      },
    });
    await serverSend(ws, {
      type: "event",
      payload: {
        type: "extension_ui_request",
        sessionId: "s1",
        eventId: 2,
        epoch: "e1",
        request: { ...questionnairePending(), id: "req-q-2" },
      },
    });
    const radio = screen.getByRole("radio", { name: /Red/ }) as HTMLInputElement;
    expect(radio.checked).toBe(false);
  });
});
