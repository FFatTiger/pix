import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { RuntimeProvider, useRuntimeStore, useRuntime } from "./runtime-provider";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { HttpClientProvider } from "@/app/http-context";
import { Composer } from "@/components/shell/Composer";
import { TranscriptList } from "@/components/transcript/TranscriptList";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import { FakeWebSocket, flush, lastFrame, snapshotPayload } from "./testing/harness";
import type { RuntimeSocketDeps } from "./socket";
import type { HostInfo } from "@fffattiger/pix-protocol";
import type { SessionStore } from "./session-store";
import { useEffect, type ReactNode } from "react";

// jsdom gives the scroll container 0 height, so the real virtualizer renders no
// rows. Stub it to render every row so runtime→row integration is testable.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 48,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 48 })),
    measureElement: () => undefined,
  }),
}));

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

let capturedStore: SessionStore | null = null;
function Capture(): null {
  const store = useRuntimeStore();
  useEffect(() => { capturedStore = store; }, [store]);
  return null;
}

function ConnectionProbe(): ReactNode {
  const rt = useRuntime();
  return <span data-testid="connection">{rt.connection}</span>;
}

function mount(children: ReactNode, host: Partial<HostInfo> | null | undefined = { mode: "local", capabilities: ["agent"] }): void {
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
  return { type: "handshake_ack", payload: { protocolVersion: 1, host: { mode: "local", capabilities: caps }, limits: { maxUpload: 0, maxOpenSessions: 4 }, sessionSnapshotSupport: true } };
}

async function driveReady(): Promise<FakeWebSocket> {
  const store = capturedStore!;
  store.connect();
  const ws = SOCKETS[SOCKETS.length - 1]!;
  ws.serverOpen();
  ws.serverSend(ack());
  await flush();
  return ws;
}

async function driveAttach(ws: FakeWebSocket, sessionId = "s1"): Promise<void> {
  const store = capturedStore!;
  void store.openSession(sessionId);
  await flush();
  const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
  ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId }) });
  await flush();
}

describe("RuntimeProvider / useSyncExternalStore", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("reactively reflects connection state via useSyncExternalStore", async () => {
    mount(<ConnectionProbe />);
    expect(screen.getByTestId("connection").textContent).toBe("idle");
    await driveReady();
    expect(screen.getByTestId("connection").textContent).toBe("ready");
  });
});

describe("Composer — capability honesty + send/abort", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("is disabled when the host has no agent capability", () => {
    mount(<Composer />, { mode: "local", capabilities: ["files"] });
    const textarea = screen.getByLabelText("Message the agent") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    expect(screen.getByText(/no agent capability|readonly/)).toBeTruthy();
  });

  it("sends a prompt when attached + canAgent, and offers Abort while streaming", async () => {
    mount(<Composer />);
    const ws = await driveReady();
    await driveAttach(ws);
    const textarea = screen.getByLabelText("Message the agent") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
    fireEvent.change(textarea, { target: { value: "hello world" } });
    fireEvent.click(screen.getByText("Send"));
    await flush();
    const cmd = lastFrame<{ type: string; payload: { command: { type: string; message: string } } }>(ws, "command")!;
    expect(cmd.payload.command.message).toBe("hello world");
    // start streaming → Abort control appears
    ws.serverSend({ type: "event", payload: { type: "message_start", sessionId: "s1", streamId: "st", messageId: "m", message: { role: "assistant", model: "m", provider: "p" }, eventId: 1, epoch: "e1" } });
    await flush();
    const abortBtn = screen.getByLabelText("Abort the running response");
    fireEvent.click(abortBtn);
    await flush();
    const interrupt = lastFrame<{ type: string; payload: { interrupt: { type: string } } }>(ws, "interrupt")!;
    expect(interrupt.payload.interrupt.type).toBe("abort");
  });
});

describe("TranscriptList — runtime messages", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("renders rows from the SessionStore projection", async () => {
    mount(<TranscriptList sessionId="s1" />);
    const ws = await driveReady();
    await driveAttach(ws);
    // full stream lifecycle commits a user message
    ws.serverSend({ type: "event", payload: { type: "message_start", sessionId: "s1", streamId: "st", messageId: "m", message: { role: "user", content: "hi there" }, eventId: 1, epoch: "e1" } });
    ws.serverSend({ type: "event", payload: { type: "message_end", sessionId: "s1", streamId: "st", messageId: "m", message: { role: "user", content: "hi there" }, eventId: 2, epoch: "e1" } });
    await flush();
    expect(screen.getByText("hi there")).toBeTruthy();
  });

  it("renders the active streaming partial", async () => {
    mount(<TranscriptList sessionId="s1" />);
    const ws = await driveReady();
    await driveAttach(ws);
    ws.serverSend({ type: "event", payload: { type: "message_start", sessionId: "s1", streamId: "st", messageId: "m", message: { role: "assistant", content: [{ type: "text", text: "part" }], model: "m", provider: "p" }, eventId: 1, epoch: "e1" } });
    await flush();
    expect(screen.getByText("part")).toBeTruthy();
  });
});
