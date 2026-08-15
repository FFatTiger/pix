import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { RuntimeProvider, useRuntimeStore } from "@/runtime/runtime-provider";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { HttpClientProvider } from "@/app/http-context";
import { Composer } from "@/components/shell/Composer";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import { FakeWebSocket, flush, lastFrame, snapshotPayload } from "@/runtime/testing/harness";
import type { RuntimeSocketDeps } from "@/runtime/socket";
import type { HostInfo } from "@fffattiger/pix-protocol";
import type { SessionStore } from "@/runtime/session-store";
import { useEffect, type ReactNode } from "react";

// Composer renders TranscriptList, which uses the hand-rolled virtualizer
// (src/lib/virtual-list). jsdom has no ResizeObserver, so it renders every row
// (render-all fallback) — no mock needed.

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

async function driveAttach(ws: FakeWebSocket, capabilities: string[], sessionId = "s1"): Promise<void> {
  const store = capturedStore!;
  await act(async () => {
    void store.openSession(sessionId);
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId, capabilities }) });
    await flush();
  });
}

async function serverSend(ws: FakeWebSocket, message: unknown): Promise<void> {
  await act(async () => {
    ws.serverSend(message);
    await flush();
  });
}

const STREAM_START = {
  type: "message_start",
  sessionId: "s1",
  streamId: "st",
  messageId: "m",
  message: { role: "assistant", model: "m", provider: "p" },
  eventId: 1,
  epoch: "e1",
};

const QUEUE_CAPS = ["runtime.prompt", "runtime.abort", "runtime.steer", "runtime.follow_up", "runtime.queue"];

function queueUpdate(steering: unknown[], followUp: unknown[], eventId = 1) {
  return { type: "queue_update", sessionId: "s1", steering, followUp, eventId, epoch: "e1" };
}

describe("Composer — D2-P4 steer/follow_up/queue behavior", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("without follow_up capability, streaming keeps the composer disabled (existing behavior)", async () => {
    mount(<Composer />);
    const ws = await driveReady();
    await driveAttach(ws, ["runtime.prompt", "runtime.abort"]);
    await serverSend(ws, { type: "event", payload: STREAM_START });
    const textarea = screen.getByLabelText("Message the agent") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    expect(screen.getByLabelText("Abort the running response")).toBeTruthy();
    expect(screen.queryByLabelText("Steer the running response")).toBeNull();
    const send = screen.getByText("Send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(screen.getByText("streaming")).toBeTruthy();
  });

  it("with follow_up capability, streaming keeps textarea+Send usable and Send sends follow_up", async () => {
    mount(<Composer />);
    const ws = await driveReady();
    await driveAttach(ws, QUEUE_CAPS);
    await serverSend(ws, { type: "event", payload: STREAM_START });
    const textarea = screen.getByLabelText("Message the agent") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
    fireEvent.change(textarea, { target: { value: "follow me" } });
    fireEvent.click(screen.getByText("Send"));
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { type: string; message: string } } }>(ws, "command")!;
    expect(cmd.payload.command.type).toBe("follow_up");
    expect(cmd.payload.command.message).toBe("follow me");
    // Follow-up draft clears only on confirmed success.
    await serverSend(ws, { type: "response", id: cmd.id, payload: { ok: true, result: { commandId: "fu-1", result: { ok: true, type: "follow_up" } } } });
    expect((screen.getByLabelText("Message the agent") as HTMLTextAreaElement).value).toBe("");
  });

  it("follow_up failure keeps the draft", async () => {
    mount(<Composer />);
    const ws = await driveReady();
    await driveAttach(ws, QUEUE_CAPS);
    await serverSend(ws, { type: "event", payload: STREAM_START });
    const textarea = screen.getByLabelText("Message the agent") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "keep me" } });
    fireEvent.click(screen.getByText("Send"));
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { type: string } } }>(ws, "command")!;
    await serverSend(ws, { type: "response", id: cmd.id, payload: { ok: true, result: { commandId: "fu-1", result: { ok: false, type: "follow_up", error: { code: "external", message: "boom", retryable: false } } } } });
    expect((screen.getByLabelText("Message the agent") as HTMLTextAreaElement).value).toBe("keep me");
  });

  it("Steer button appears while streaming with steer capability; success clears the draft", async () => {
    mount(<Composer />);
    const ws = await driveReady();
    await driveAttach(ws, QUEUE_CAPS);
    await serverSend(ws, { type: "event", payload: STREAM_START });
    const steerBtn = screen.getByLabelText("Steer the running response") as HTMLButtonElement;
    expect(steerBtn.disabled).toBe(true); // no draft yet
    fireEvent.change(screen.getByLabelText("Message the agent"), { target: { value: "steer me" } });
    expect(steerBtn.disabled).toBe(false);
    fireEvent.click(steerBtn);
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { type: string; message: string } } }>(ws, "command")!;
    expect(cmd.payload.command.type).toBe("steer");
    expect(cmd.payload.command.message).toBe("steer me");
    await serverSend(ws, { type: "response", id: cmd.id, payload: { ok: true, result: { commandId: "st-1", result: { ok: true, type: "steer" } } } });
    expect((screen.getByLabelText("Message the agent") as HTMLTextAreaElement).value).toBe("");
  });

  it("Steer failure keeps the draft", async () => {
    mount(<Composer />);
    const ws = await driveReady();
    await driveAttach(ws, QUEUE_CAPS);
    await serverSend(ws, { type: "event", payload: STREAM_START });
    const textarea = screen.getByLabelText("Message the agent") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "keep steer" } });
    fireEvent.click(screen.getByLabelText("Steer the running response"));
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { type: string } } }>(ws, "command")!;
    await serverSend(ws, { type: "response", id: cmd.id, payload: { ok: true, result: { commandId: "st-1", result: { ok: false, type: "steer", error: { code: "external", message: "boom", retryable: false } } } } });
    expect((screen.getByLabelText("Message the agent") as HTMLTextAreaElement).value).toBe("keep steer");
  });

  it("while a queued turn is pending, Send and Steer are disabled", async () => {
    mount(<Composer />);
    const ws = await driveReady();
    await driveAttach(ws, QUEUE_CAPS);
    await serverSend(ws, { type: "event", payload: STREAM_START });
    const textarea = screen.getByLabelText("Message the agent") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "in flight" } });
    // Fire steer but do NOT respond — it stays pending.
    fireEvent.click(screen.getByLabelText("Steer the running response"));
    await flush();
    const steerBtn = screen.getByLabelText("Steer the running response") as HTMLButtonElement;
    const send = screen.getByText("Send") as HTMLButtonElement;
    expect(steerBtn.disabled).toBe(true);
    expect(send.disabled).toBe(true);
    // textarea stays editable (draft kept for the next turn).
    expect(textarea.disabled).toBe(false);
  });

  it("renders queued steering + follow-up text with image count placeholder, never image data", async () => {
    mount(<Composer />);
    const ws = await driveReady();
    await driveAttach(ws, QUEUE_CAPS);
    await serverSend(ws, { type: "event", payload: queueUpdate(
      [{ message: "steer one", images: [{ type: "image", data: "c2VjcmV0LWltYWdlLWRhdGE=", mimeType: "image/png" as const }] }],
      [{ message: "follow one" }, { message: "follow two" }],
    ) });
    expect(screen.getByText("steer one")).toBeTruthy();
    expect(screen.getByText("follow one")).toBeTruthy();
    expect(screen.getByText("follow two")).toBeTruthy();
    // Fixed image count placeholder — the data payload must never render.
    expect(screen.getByText(/1 image/)).toBeTruthy();
    expect(document.body.textContent ?? "").not.toContain("c2VjcmV0LWltYWdlLWRhdGE=");
  });

  it("Clear queue shows with runtime.queue + non-empty queue and hides immediately on capability revoke", async () => {
    mount(<Composer />);
    const ws = await driveReady();
    await driveAttach(ws, QUEUE_CAPS);
    await serverSend(ws, { type: "event", payload: queueUpdate([{ message: "steer one" }], []) });
    expect(screen.getByLabelText("Clear the queued turns")).toBeTruthy();
    // Capability revoked → Clear queue hides immediately (authoritative snapshot).
    await serverSend(ws, { type: "event", payload: { type: "runtime_capabilities_changed", sessionId: "s1", eventId: 2, epoch: "e1", capabilities: { capabilities: ["runtime.prompt", "runtime.abort", "runtime.steer", "runtime.follow_up"], version: 2 } } });
    expect(screen.queryByLabelText("Clear the queued turns")).toBeNull();
    // Queue items still shown (only the capability-gated Clear button hides).
    expect(screen.getByText("steer one")).toBeTruthy();
  });

  it("Clear queue issues the clear_queue interrupt", async () => {
    mount(<Composer />);
    const ws = await driveReady();
    await driveAttach(ws, QUEUE_CAPS);
    await serverSend(ws, { type: "event", payload: queueUpdate([{ message: "steer one" }], []) });
    fireEvent.click(screen.getByLabelText("Clear the queued turns"));
    await flush();
    const intr = lastFrame<{ type: string; payload: { interrupt: { type: string } } }>(ws, "interrupt")!;
    expect(intr.payload.interrupt.type).toBe("clear_queue");
  });

  it("live=false never shows queue, steer, or stale streaming state", async () => {
    mount(<Composer live={false} />);
    const ws = await driveReady();
    await driveAttach(ws, QUEUE_CAPS);
    await serverSend(ws, { type: "event", payload: STREAM_START });
    await serverSend(ws, { type: "event", payload: queueUpdate([{ message: "steer one" }], []) });
    const textarea = screen.getByLabelText("Message the agent") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    expect(screen.queryByLabelText("Steer the running response")).toBeNull();
    expect(screen.queryByLabelText("Clear the queued turns")).toBeNull();
    expect(screen.queryByText("steer one")).toBeNull();
    expect(screen.queryByText("streaming")).toBeNull();
    expect(screen.getByText(/selected session is not live/)).toBeTruthy();
  });

  it("idle: Send sends a prompt; no Steer/Follow-up indicators and no queue controls", async () => {
    mount(<Composer />);
    const ws = await driveReady();
    await driveAttach(ws, QUEUE_CAPS);
    const textarea = screen.getByLabelText("Message the agent") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "plain prompt" } });
    expect(screen.queryByLabelText("Steer the running response")).toBeNull();
    fireEvent.click(screen.getByText("Send"));
    await flush();
    const cmd = lastFrame<{ type: string; payload: { command: { type: string; message: string } } }>(ws, "command")!;
    expect(cmd.payload.command.type).toBe("prompt");
    expect(cmd.payload.command.message).toBe("plain prompt");
    expect(screen.queryByLabelText("Clear the queued turns")).toBeNull();
  });
});
