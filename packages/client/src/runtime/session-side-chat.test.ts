import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProtocolHandshakeResponse } from "@fffattiger/pix-protocol";
import { createHarness, flush, lastFrame, snapshotPayload, type FakeWebSocket, type RuntimeHarness } from "./testing/harness";

function ack(): { type: "handshake_ack"; payload: ProtocolHandshakeResponse } {
  return {
    type: "handshake_ack",
    payload: {
      protocolVersion: 2,
      host: { mode: "local", capabilities: ["agent"] },
      limits: { maxUpload: 0, maxOpenSessions: 4 },
      sessionSnapshotSupport: true,
      acceptedFeatures: [],
    },
  };
}

async function attach(h: RuntimeHarness, epoch = "e1", capabilities = ["runtime.prompt", "runtime.abort", "runtime.side_chat"]): Promise<FakeWebSocket> {
  h.store.connect();
  const ws = h.lastSocket();
  ws.serverOpen();
  ws.serverSend(ack());
  const opened = h.store.openSession("s1");
  await flush();
  const frame = lastFrame<{ type: "attach"; id: string }>(ws, "attach")!;
  ws.serverSend({ type: "snapshot", id: frame.id, payload: snapshotPayload({ sessionId: "s1", epoch, capabilities }) });
  await opened;
  return ws;
}

type CommandFrame = {
  type: "command";
  id: string;
  payload: { command: { commandId: string; type: string } };
};

function commandFrames(ws: FakeWebSocket): CommandFrame[] {
  return ws.sent.filter((frame): frame is CommandFrame => (frame as { type?: string }).type === "command");
}

function respond(ws: FakeWebSocket, frame: CommandFrame, result: Record<string, unknown>): void {
  ws.serverSend({
    type: "response",
    id: frame.id,
    payload: {
      ok: true,
      result: { commandId: frame.payload.command.commandId, result: { ok: true, ...result } },
    },
  });
}

function snapshotWithSideChat(overrides: Parameters<typeof snapshotPayload>[0] = {}) {
  const payload = snapshotPayload(overrides);
  const snapshot = payload.snapshot as { state: Record<string, unknown> };
  snapshot.state.sideChat = {
    conversationId: "conversation-1",
    revision: 1,
    capturedModel: { provider: "anthropic", id: "claude-sonnet" },
    capturedThinkingLevel: "medium",
    mode: "read_only",
    status: "idle",
    messages: [],
    messagesTruncated: false,
    totalCharsTruncated: false,
    stream: { text: "", thinking: "", textTruncated: false, thinkingTruncated: false },
    tools: [],
  };
  return payload;
}

function sideCommandFrames(ws: FakeWebSocket): CommandFrame[] {
  return commandFrames(ws).filter((frame) => frame.payload.command.type.startsWith("side_chat_"));
}

describe("SessionController side-chat lane", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("runs beside a main command, coalesces start, and keeps exact typed correlation", async () => {
    const h = createHarness();
    const ws = await attach(h);
    const controller = h.controller("s1")!;
    const main = controller.sendCommand({ commandId: "main-command", type: "prompt", message: "main" });
    const first = controller.sideChatStart();
    const second = controller.sideChatStart();
    await flush();

    const frames = commandFrames(ws);
    expect(frames.map((frame) => frame.payload.command.type)).toEqual(["prompt", "side_chat_start"]);
    const side = frames[1]!;
    ws.serverSend({
      type: "response",
      id: side.id,
      payload: { ok: true, result: { commandId: "wrong", result: { ok: true, type: "side_chat_start", conversationId: "wrong" } } },
    });
    await flush();
    let settled = false;
    void first.then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);

    respond(ws, side, { type: "side_chat_start", conversationId: "conversation-1" });
    await expect(first).resolves.toBe("conversation-1");
    await expect(second).resolves.toBe("conversation-1");
    respond(ws, frames[0]!, { type: "prompt" });
    await expect(main).resolves.toBeTruthy();
    h.dispose();
  });

  it("resends the same commandId after a same-epoch reconnect and never resends across an epoch change", async () => {
    const h = createHarness();
    let ws = await attach(h);
    const controller = h.controller("s1")!;
    const sent = controller.sideChatSend("conversation-1", "hello");
    await flush();
    const first = commandFrames(ws).at(-1)!;

    ws.serverClose(1006);
    vi.advanceTimersByTime(250);
    ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ack());
    await flush();
    const resume = lastFrame<{ type: "attach"; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: resume.id, payload: snapshotPayload({ sessionId: "s1", epoch: "e1", resumeStatus: "snapshot", capabilities: ["runtime.side_chat"] }) });
    await flush();
    const resent = commandFrames(ws).at(-1)!;
    expect(resent.payload.command.commandId).toBe(first.payload.command.commandId);
    expect(resent.id).not.toBe(first.id);
    respond(ws, resent, { type: "side_chat_send", runId: "run-1" });
    await expect(sent).resolves.toBe("run-1");

    const pending = controller.sideChatReset("conversation-1", "refork");
    await flush();
    ws.serverClose(1006);
    vi.advanceTimersByTime(250);
    ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ack());
    await flush();
    const changed = lastFrame<{ type: "attach"; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: changed.id, payload: snapshotPayload({ sessionId: "s1", epoch: "e2", resumeStatus: "epoch_changed", capabilities: ["runtime.side_chat"] }) });
    await expect(pending).rejects.toMatchObject({ code: "epoch_changed" });
    expect(commandFrames(ws)).toHaveLength(0);
    h.dispose();
  });

  it("settles on capability loss, detach, dispose, and bounded timeout", async () => {
    const h = createHarness({ storeOptions: { sideChatCommandTimeoutMs: 50 } });
    const ws = await attach(h);
    const controller = h.controller("s1")!;

    const lost = controller.sideChatSetMode("conversation-1", "edit");
    await flush();
    ws.serverSend({ type: "snapshot", payload: snapshotPayload({ sessionId: "s1", epoch: "e1", resumeStatus: "snapshot", capabilities: [] }) });
    await expect(lost).rejects.toMatchObject({ code: "unsupported_capability" });

    ws.serverSend({ type: "snapshot", payload: snapshotPayload({ sessionId: "s1", epoch: "e1", resumeStatus: "snapshot", capabilities: ["runtime.side_chat"] }) });
    const detached = controller.sideChatReset("conversation-1", "clear");
    const detach = controller.detach();
    await flush();
    const detachFrame = lastFrame<{ type: "detach"; id: string }>(ws, "detach")!;
    ws.serverSend({ type: "response", id: detachFrame.id, payload: { ok: true, result: { sessionId: "s1", detached: true } } });
    await detach;
    await expect(detached).rejects.toMatchObject({ code: "interrupted", message: "detached" });

    await attach(h);
    const timed = controller.sideChatStart();
    vi.advanceTimersByTime(51);
    await expect(timed).rejects.toMatchObject({ code: "timeout" });

    const disposing = controller.sideChatStart();
    controller.dispose();
    await expect(disposing).rejects.toMatchObject({ code: "unavailable" });
    h.dispose();
  });

  it.each(["detach", "stop", "capability"] as const)("rejects retained-state start after %s authority loss without sending", async (loss) => {
    const h = createHarness();
    const ws = await attach(h);
    const controller = h.controller("s1")!;
    ws.serverSend({ type: "snapshot", payload: snapshotWithSideChat({ sessionId: "s1", epoch: "e1", capabilities: ["runtime.side_chat"] }) });
    await flush();
    expect(controller.getSnapshot().snapshot?.state.sideChat?.conversationId).toBe("conversation-1");

    if (loss === "detach") {
      const detached = controller.detach();
      await flush();
      const frame = lastFrame<{ type: "detach"; id: string }>(ws, "detach")!;
      ws.serverSend({ type: "response", id: frame.id, payload: { ok: true, result: { sessionId: "s1", detached: true } } });
      await detached;
    } else if (loss === "stop") {
      const stopped = controller.stop();
      await flush();
      const frame = lastFrame<{ type: "stop"; id: string }>(ws, "stop")!;
      ws.serverSend({ type: "response", id: frame.id, payload: { ok: true, result: { sessionId: "s1", stopped: true } } });
      await stopped;
    } else {
      ws.serverSend({ type: "snapshot", payload: snapshotWithSideChat({ sessionId: "s1", epoch: "e1", capabilities: [] }) });
      await flush();
    }

    const before = sideCommandFrames(ws).length;
    await expect(controller.sideChatStart()).rejects.toMatchObject({ code: "unsupported_capability" });
    expect(sideCommandFrames(ws)).toHaveLength(before);
    h.dispose();
  });

  it("settles side capability loss from fetchSnapshot and ignores the old ack after a new slot starts", async () => {
    const h = createHarness();
    const ws = await attach(h);
    const controller = h.controller("s1")!;
    const oldPending = controller.sideChatSetMode("conversation-1", "edit");
    await flush();
    const oldFrame = sideCommandFrames(ws).at(-1)!;

    const fetched = controller.fetchSnapshot();
    await flush();
    const snapshotFrame = lastFrame<{ type: "getSnapshot"; id: string }>(ws, "getSnapshot")!;
    ws.serverSend({ type: "response", id: snapshotFrame.id, payload: { ok: true, result: snapshotPayload({ sessionId: "s1", capabilities: [] }).snapshot } });
    await fetched;
    await expect(oldPending).rejects.toMatchObject({ code: "unsupported_capability" });
    expect(controller.evictionProtection.pendingSideChatCommand).toBe(false);

    ws.serverSend({ type: "snapshot", payload: snapshotWithSideChat({ sessionId: "s1", epoch: "e1", capabilities: ["runtime.side_chat"] }) });
    await flush();
    const nextPending = controller.sideChatSend("conversation-1", "next");
    await flush();
    const nextFrame = sideCommandFrames(ws).at(-1)!;
    expect(nextFrame.id).not.toBe(oldFrame.id);
    respond(ws, oldFrame, { type: "side_chat_set_mode" });
    await flush();
    let nextSettled = false;
    void nextPending.then(() => { nextSettled = true; });
    await flush();
    expect(nextSettled).toBe(false);
    respond(ws, nextFrame, { type: "side_chat_send", runId: "run-next" });
    await expect(nextPending).resolves.toBe("run-next");
    h.dispose();
  });

  it("keeps main and side abort identities distinct and coalesces only the same side target", async () => {
    const h = createHarness();
    const ws = await attach(h);
    const controller = h.controller("s1")!;
    const sideAbort = controller.abortSideChat("conversation-A");
    const sameTarget = controller.abortSideChat("conversation-A");
    expect(sameTarget).toBe(sideAbort);
    await flush();
    const frame = lastFrame<{ type: "interrupt"; id: string; payload: { commandId: string; interrupt: { type: string; conversationId?: string } } }>(ws, "interrupt")!;
    expect(frame.payload.interrupt).toEqual({ type: "abort_side_chat", conversationId: "conversation-A" });
    await expect(controller.abortSideChat("conversation-B")).rejects.toMatchObject({ code: "session_busy" });
    await expect(controller.abort()).rejects.toMatchObject({ code: "session_busy" });
    expect(ws.sent.filter((candidate) => (candidate as { type?: string }).type === "interrupt")).toHaveLength(1);
    ws.serverSend({ type: "interrupt_result", id: frame.id, payload: { sessionId: "s1", commandId: frame.payload.commandId, interruptType: "abort_side_chat", result: { ok: true, type: "abort_side_chat" } } });
    await expect(sideAbort).resolves.toMatchObject({ ok: true, type: "abort_side_chat" });
    await expect(sameTarget).resolves.toMatchObject({ ok: true, type: "abort_side_chat" });
    h.dispose();
  });
});
