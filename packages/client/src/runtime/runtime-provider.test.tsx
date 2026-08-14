import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
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

describe("RuntimeProvider — D2-P3 setModel exposure", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("exposes setModel on the RuntimeApi and sends an exact set_model command", async () => {
    let exposed!: ReturnType<typeof useRuntime>;
    function Probe(): null {
      exposed = useRuntime();
      return null;
    }
    mount(<Probe />);
    expect(typeof exposed.setModel).toBe("function");

    const ws = await driveReady();
    const store = capturedStore!;
    await act(async () => {
      void store.openSession("s1");
      await flush();
      const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
      ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1", capabilities: ["runtime.prompt", "runtime.abort", "runtime.model.set"] }) });
      await flush();
    });

    let settled = false;
    let rejection: unknown = null;
    const p = exposed.setModel("anthropic", "claude-opus-4");
    p.then(() => { settled = true; }, (error: unknown) => { rejection = error; });
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; provider: string; modelId: string } } }>(ws, "command")!;
    expect(cmd.payload.command.type).toBe("set_model");
    expect(cmd.payload.command.provider).toBe("anthropic");
    expect(cmd.payload.command.modelId).toBe("claude-opus-4");
    await serverSend(ws, { type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "set_model" } } } });
    expect(settled).toBe(true);
    expect(rejection).toBeNull();
  });
});

describe("RuntimeProvider — D2-P4 steer/followUp/clearQueue exposure", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("exposes steer/followUp/clearQueue on the RuntimeApi", async () => {
    let exposed!: ReturnType<typeof useRuntime>;
    function Probe(): null {
      exposed = useRuntime();
      return null;
    }
    mount(<Probe />);
    expect(typeof exposed.steer).toBe("function");
    expect(typeof exposed.followUp).toBe("function");
    expect(typeof exposed.clearQueue).toBe("function");
  });

  it("steer sends an exact steer command and followUp an exact follow_up command", async () => {
    let exposed!: ReturnType<typeof useRuntime>;
    function Probe(): null {
      exposed = useRuntime();
      return null;
    }
    mount(<Probe />);
    const ws = await driveReady();
    const store = capturedStore!;
    await act(async () => {
      void store.openSession("s1");
      await flush();
      const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
      ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1", capabilities: ["runtime.prompt", "runtime.abort", "runtime.steer", "runtime.follow_up", "runtime.queue"] }) });
      await flush();
    });

    let steerSettled = false;
    const steerP = exposed.steer("steer now");
    steerP.then(() => { steerSettled = true; }, () => {});
    await flush();
    const steerCmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; message: string } } }>(ws, "command")!;
    expect(steerCmd.payload.command.type).toBe("steer");
    expect(steerCmd.payload.command.message).toBe("steer now");
    await serverSend(ws, { type: "response", id: steerCmd.id, payload: { ok: true, result: { commandId: steerCmd.payload.command.commandId, result: { ok: true, type: "steer" } } } });
    expect(steerSettled).toBe(true);

    let followSettled = false;
    const followP = exposed.followUp("follow now");
    followP.then(() => { followSettled = true; }, () => {});
    await flush();
    const followCmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; message: string } } }>(ws, "command")!;
    expect(followCmd.payload.command.type).toBe("follow_up");
    expect(followCmd.payload.command.message).toBe("follow now");
    await serverSend(ws, { type: "response", id: followCmd.id, payload: { ok: true, result: { commandId: followCmd.payload.command.commandId, result: { ok: true, type: "follow_up" } } } });
    expect(followSettled).toBe(true);

    let clearSettled = false;
    const clearP = exposed.clearQueue();
    clearP.then(() => { clearSettled = true; }, () => {});
    await flush();
    const intr = lastFrame<{ type: string; id: string; payload: { commandId: string; interrupt: { type: string } } }>(ws, "interrupt")!;
    expect(intr.payload.interrupt.type).toBe("clear_queue");
    await serverSend(ws, { type: "interrupt_result", id: intr.id, payload: { sessionId: "s1", commandId: intr.payload.commandId, interruptType: "clear_queue", result: { ok: true, type: "clear_queue" } } });
    expect(clearSettled).toBe(true);
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
    await serverSend(ws, { type: "event", payload: { type: "message_start", sessionId: "s1", streamId: "st", messageId: "m", message: { role: "assistant", model: "m", provider: "p" }, eventId: 1, epoch: "e1" } });
    const abortBtn = screen.getByLabelText("Abort the running response");
    fireEvent.click(abortBtn);
    await flush();
    const interrupt = lastFrame<{ type: string; payload: { interrupt: { type: string } } }>(ws, "interrupt")!;
    expect(interrupt.payload.interrupt.type).toBe("abort");
  });

  it("never surfaces a non-selected session's stream: live=false stays disabled/readonly with no Abort", async () => {
    mount(<Composer live={false} />);
    const ws = await driveReady();
    await driveAttach(ws);
    // The runtime (A) starts streaming…
    await serverSend(ws, { type: "event", payload: { type: "message_start", sessionId: "s1", streamId: "st", messageId: "m", message: { role: "assistant", model: "m", provider: "p" }, eventId: 1, epoch: "e1" } });
    // …but the selected session is NOT live, so this composer must stay honest:
    // no stale streaming state, no Abort for another session, input disabled.
    const textarea = screen.getByLabelText("Message the agent") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    expect(screen.queryByLabelText("Abort the running response")).toBeNull();
    expect(screen.queryByText("streaming")).toBeNull();
    expect(screen.getByText(/selected session is not live/)).toBeTruthy();
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
    await serverSend(ws, { type: "event", payload: { type: "message_start", sessionId: "s1", streamId: "st", messageId: "m", message: { role: "user", content: "hi there" }, eventId: 1, epoch: "e1" } });
    await serverSend(ws, { type: "event", payload: { type: "message_end", sessionId: "s1", streamId: "st", messageId: "m", message: { role: "user", content: "hi there" }, eventId: 2, epoch: "e1" } });
    expect(screen.getByText("hi there")).toBeTruthy();
  });

  it("renders the active streaming partial", async () => {
    mount(<TranscriptList sessionId="s1" />);
    const ws = await driveReady();
    await driveAttach(ws);
    await serverSend(ws, { type: "event", payload: { type: "message_start", sessionId: "s1", streamId: "st", messageId: "m", message: { role: "assistant", content: [{ type: "text", text: "part" }], model: "m", provider: "p" }, eventId: 1, epoch: "e1" } });
    expect(screen.getByText("part")).toBeTruthy();
  });
});

describe("RuntimeProvider — D2-P5 runBash/abortBash exposure", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("exposes runBash and abortBash on the RuntimeApi", async () => {
    let exposed!: ReturnType<typeof useRuntime>;
    function Probe(): null {
      exposed = useRuntime();
      return null;
    }
    mount(<Probe />);
    expect(typeof exposed.runBash).toBe("function");
    expect(typeof exposed.abortBash).toBe("function");
  });

  it("runBash sends an exact bash command and abortBash an exact abort_bash interrupt", async () => {
    let exposed!: ReturnType<typeof useRuntime>;
    function Probe(): null {
      exposed = useRuntime();
      return null;
    }
    mount(<Probe />);
    const ws = await driveReady();
    const store = capturedStore!;
    await act(async () => {
      void store.openSession("s1");
      await flush();
      const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
      ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1", capabilities: ["runtime.prompt", "runtime.abort", "runtime.bash", "runtime.bash.abort"] }) });
      await flush();
    });

    let bashSettled = false;
    const bashP = exposed.runBash("echo hello", { excludeFromContext: true });
    bashP.then(() => { bashSettled = true; }, () => {});
    await flush();
    const bashCmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; command: string; excludeFromContext?: boolean } } }>(ws, "command")!;
    expect(bashCmd.payload.command.type).toBe("bash");
    expect(bashCmd.payload.command.command).toBe("echo hello");
    expect(bashCmd.payload.command.excludeFromContext).toBe(true);
    await serverSend(ws, { type: "response", id: bashCmd.id, payload: { ok: true, result: { commandId: bashCmd.payload.command.commandId, result: { ok: true, type: "bash" } } } });
    expect(bashSettled).toBe(true);

    let abortSettled = false;
    const abortP = exposed.abortBash();
    abortP.then(() => { abortSettled = true; }, () => {});
    await flush();
    const intr = lastFrame<{ type: string; id: string; payload: { commandId: string; interrupt: { type: string } } }>(ws, "interrupt")!;
    expect(intr.payload.interrupt.type).toBe("abort_bash");
    await serverSend(ws, { type: "interrupt_result", id: intr.id, payload: { sessionId: "s1", commandId: intr.payload.commandId, interruptType: "abort_bash", result: { ok: true, type: "abort_bash" } } });
    expect(abortSettled).toBe(true);
  });
});
