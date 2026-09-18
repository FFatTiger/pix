import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProtocolHandshakeResponse, WsSnapshotMessage } from "@fffattiger/pix-protocol";
import { SessionController, type ControllerView } from "./session-controller";
import { createHarness, flush, lastFrame, snapshotPayload } from "./testing/harness";

function ack(features: readonly string[] = []): { type: "handshake_ack"; payload: ProtocolHandshakeResponse } {
  return {
    type: "handshake_ack",
    payload: {
      protocolVersion: 2,
      host: { mode: "local", capabilities: ["agent"] },
      limits: { maxUpload: 0, maxOpenSessions: 4 },
      sessionSnapshotSupport: true,
      acceptedFeatures: [...features],
    },
  };
}

async function attachExact(controller: SessionController, h: ReturnType<typeof createHarness>, sessionId: string) {
  h.connection.replaceAttachmentRoute(sessionId);
  const open = controller.openSession();
  await flush();
  const frame = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string } }>(h.lastSocket(), "attach")!;
  expect(frame.payload.sessionId).toBe(sessionId);
  h.lastSocket().serverSend({ type: "snapshot", id: frame.id, payload: snapshotPayload({ sessionId, epoch: `e-${sessionId}` }) });
  await open;
}

describe("SessionController — immutable exact-session ownership", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("fixes a readonly exact sessionId and fails closed for mismatched snapshots/events", async () => {
    const h = createHarness();
    const controller = new SessionController("A", h.connection);
    expect(controller.sessionId).toBe("A");
    expect(controller.getSnapshot().createdWithAutoThinking).toBe(false);
    expect(() => { (controller as unknown as { sessionId: string }).sessionId = "B"; }).toThrow();
    h.connection.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ack());
    await attachExact(controller, h, "A");
    const before = controller.getSnapshot();
    controller.onSnapshot({ type: "snapshot", payload: snapshotPayload({ sessionId: "B", epoch: "e-B", lastEventId: 9 }) } as WsSnapshotMessage, h.connection.currentGeneration);
    controller.onEvent({ type: "event", payload: { type: "agent_start", sessionId: "B", epoch: "e-B", eventId: 1 } }, h.connection.currentGeneration);
    expect(controller.getSnapshot().sessionId).toBe("A");
    expect(controller.getSnapshot().epoch).toBe(before.epoch);
    expect(controller.getSnapshot().snapshot).toEqual(before.snapshot);
    controller.dispose();
    h.dispose();
  });

  it("reduces exact-session events with cursor/history identity and drops duplicate/wrong-session frames", async () => {
    const h = createHarness();
    const controller = new SessionController("A", h.connection);
    h.connection.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ack());
    await attachExact(controller, h, "A");
    const generation = h.connection.currentGeneration;
    controller.onEvent({ type: "event", payload: { type: "message_start", sessionId: "A", epoch: "e-A", eventId: 1, streamId: "stream-A-1", messageId: "message-A-1", message: { role: "user", content: "exact A" } } }, generation);
    const event = {
      type: "event" as const,
      payload: {
        type: "message_end" as const,
        sessionId: "A",
        epoch: "e-A",
        eventId: 2,
        entryId: "entry-A-1",
        streamId: "stream-A-1",
        messageId: "message-A-1",
        message: { role: "user" as const, content: "exact A" },
      },
    };
    controller.onEvent(event, generation);
    controller.onEvent(event, generation);
    controller.onEvent({ ...event, payload: { ...event.payload, sessionId: "B", eventId: 3, entryId: "entry-B-2" } }, generation);
    expect(controller.getSnapshot().liveEntries.map((entry) => entry.entryId)).toEqual(["entry-A-1"]);
    expect(controller.getSnapshot().snapshot?.state.messageCount).toBe(1);
    controller.dispose();
    h.dispose();
  });

  it("keeps pending atomic lanes and optimistic entries session-local across A/B controllers", async () => {
    let seq = 0;
    const h = createHarness({ id: () => `id-${++seq}` });
    const controllerA = new SessionController("A", h.connection, { id: () => `a-${++seq}` });
    const controllerB = new SessionController("B", h.connection, { id: () => `b-${++seq}` });
    h.connection.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ack(["runtime.submit-turn.v1"]));
    await attachExact(controllerA, h, "A");
    const pendingA = controllerA.sendPrompt("prompt A").catch((error) => error);
    const pendingB = controllerB.submitTurn({ sessionId: "B", prompt: "prompt B" }).catch((error) => error);
    await flush();
    expect(controllerA.getSnapshot().turnActive).toBe(true);
    expect(controllerB.getSnapshot().turnActive).toBe(true);
    expect(controllerA.getSnapshot().optimisticEntries.map((entry) => entry.sessionId)).toEqual(["A"]);
    expect(controllerB.getSnapshot().optimisticEntries.map((entry) => entry.sessionId)).toEqual(["B"]);
    controllerA.dispose();
    controllerB.dispose();
    await pendingA;
    await pendingB;
    h.dispose();
  });

  it("negotiated rollover commands carry the exact epoch; epoch_changed settles once and a late response is inert", async () => {
    const h = createHarness();
    const controller = new SessionController("A", h.connection);
    h.connection.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ack(["runtime.epoch-rollover.v1"]));
    await attachExact(controller, h, "A");

    const first = controller.sendCommand({ type: "set_auto_retry", commandId: "cmd-old", enabled: true }).catch((error) => error);
    await flush();
    const command = lastFrame<{ type: "command"; id: string; payload: { sessionId: string; epoch?: string; command: { commandId: string } } }>(ws, "command")!;
    expect(command.payload.epoch).toBe("e-A");

    ws.serverSend({ type: "snapshot", payload: snapshotPayload({ sessionId: "A", epoch: "e-A-2", lastEventId: 0, resumeStatus: "epoch_changed" }) });
    await flush();
    await expect(first).resolves.toMatchObject({ code: "epoch_changed" });
    ws.serverSend({ type: "response", id: command.id, payload: { sessionId: "A", ok: true, result: { commandId: "cmd-old", result: { ok: true, type: "set_auto_retry" } } } });
    await flush();
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "command")).toHaveLength(1);

    const retry = controller.sendCommand({ type: "set_auto_retry", commandId: "cmd-new", enabled: false });
    await flush();
    const retried = lastFrame<{ type: "command"; id: string; payload: { epoch?: string } }>(ws, "command")!;
    expect(retried.payload.epoch).toBe("e-A-2");
    ws.serverSend({ type: "response", id: retried.id, payload: { sessionId: "A", ok: true, result: { commandId: "cmd-new", result: { ok: true, type: "set_auto_retry" } } } });
    await expect(retry).resolves.toMatchObject({ commandId: "cmd-new", result: { ok: true, type: "set_auto_retry" } });
    controller.dispose();
    h.dispose();
  });

  it("controller-local dispose never sends stop and does not close the shared socket", async () => {
    const h = createHarness();
    const controller = new SessionController("A", h.connection);
    h.connection.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ack());
    await attachExact(controller, h, "A");
    controller.dispose();
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "stop")).toHaveLength(0);
    expect(ws.wasClosedByClient).toBe(false);
    h.dispose();
  });

  it("activateAndObserve sends a correlated activate then existing_only attach", async () => {
    const h = createHarness();
    const controller = new SessionController("A", h.connection);
    h.connection.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ack(["runtime.explicit-activate.v1", "runtime.observe-existing.v1"]));
    h.connection.replaceAttachmentRoute("A");
    const pending = controller.activateAndObserve();
    await flush();
    const activate = lastFrame<{ type: "activate"; id: string; payload: { sessionId: string } }>(ws, "activate")!;
    expect(activate.payload).toEqual({ sessionId: "A" });
    expect(controller.evictionProtection.explicitActivation).toBe(true);
    ws.serverSend({
      type: "response",
      id: activate.id,
      payload: { ok: true, result: { sessionId: "A", epoch: "eA", cwd: "/x", projectRoot: "/x", workerStatus: "ready" } },
    });
    await flush();
    const attach = lastFrame<{ type: "attach"; id: string; payload: Record<string, unknown> }>(ws, "attach")!;
    expect(attach.payload).toEqual({ sessionId: "A", attachMode: "existing_only" });
    ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A", epoch: "eA" }) });
    await pending;
    expect(controller.getSnapshot().attached).toBe(true);
    expect(controller.evictionProtection.explicitActivation).toBe(false);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "stop")).toHaveLength(0);
    controller.dispose();
    h.dispose();
  });

  it("observeExisting resume keeps attachMode existing_only", async () => {
    const h = createHarness();
    const controller = new SessionController("A", h.connection);
    h.connection.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ack(["runtime.observe-existing.v1"]));
    h.connection.replaceAttachmentRoute("A");
    const first = controller.observeExisting();
    await flush();
    const attach = lastFrame<{ type: "attach"; id: string; payload: Record<string, unknown> }>(ws, "attach")!;
    expect(attach.payload).toEqual({ sessionId: "A", attachMode: "existing_only" });
    ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A", epoch: "eA", lastEventId: 4 }) });
    await first;
    const detaching = controller.detach();
    await flush();
    const detach = lastFrame<{ type: "detach"; id: string }>(ws, "detach")!;
    ws.serverSend({ type: "response", id: detach.id, payload: { ok: true, result: { sessionId: "A", detached: true } } });
    await detaching;
    const resume = controller.observeExisting();
    await flush();
    const resumeAttach = lastFrame<{ type: "attach"; id: string; payload: Record<string, unknown> }>(ws, "attach")!;
    expect(resumeAttach.payload).toEqual({ sessionId: "A", attachMode: "existing_only", epoch: "eA", lastEventId: 4 });
    ws.serverSend({ type: "snapshot", id: resumeAttach.id, payload: snapshotPayload({ sessionId: "A", epoch: "eA", lastEventId: 4 }) });
    await resume;
    controller.dispose();
    h.dispose();
  });
});

function assistantPartialText(partial: { role?: string; content?: unknown } | null | undefined): string | null {
  if (partial?.role !== "assistant" || !Array.isArray(partial.content)) return null;
  return partial.content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
    .map((block) => block.text)
    .join("");
}

describe("SessionController — streamingPartial follows the shared projection", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("publishes first held text inside 90ms and does not need a later idle event", async () => {
    vi.setSystemTime(1_000_000);
    const h = createHarness();
    const controller = new SessionController("A", h.connection);
    h.connection.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ack());
    await attachExact(controller, h, "A");

    const published: ControllerView[] = [];
    const unsubscribe = controller.subscribe(() => {
      published.push(controller.getSnapshot());
    });
    const latest = (): ControllerView => {
      const view = published[published.length - 1];
      if (view === undefined) throw new Error("expected a published ControllerView");
      return view;
    };

    const generation = h.connection.currentGeneration;
    controller.onEvent({
      type: "event",
      payload: {
        type: "message_start",
        sessionId: "A",
        epoch: "e-A",
        eventId: 1,
        streamId: "stream-A-1",
        messageId: "message-A-1",
        message: { role: "assistant", model: "m", provider: "p" },
      },
    }, generation);
    controller.onEvent({
      type: "event",
      payload: {
        type: "message_update",
        sessionId: "A",
        epoch: "e-A",
        eventId: 2,
        streamId: "stream-A-1",
        messageId: "message-A-1",
        delta: { role: "assistant", delta: { type: "text", text: "held first text" } },
      },
    }, generation);

    expect(assistantPartialText(latest().snapshot?.streaming?.partialMessage)).toBe("held first text");
    expect(assistantPartialText(latest().streamingPartial)).toBe("held first text");
    expect(latest().streaming).toBe(true);

    const quietCount = published.length;
    const afterQuiet = latest();
    vi.advanceTimersByTime(120);
    expect(published).toHaveLength(quietCount);
    expect(published[quietCount - 1]).toBe(afterQuiet);
    expect(assistantPartialText(controller.getSnapshot().streamingPartial)).toBe("held first text");

    controller.onEvent({
      type: "event",
      payload: {
        type: "message_update",
        sessionId: "A",
        epoch: "e-A",
        eventId: 3,
        streamId: "stream-A-1",
        messageId: "message-A-1",
        delta: { role: "assistant", delta: { type: "text", text: " then latest" } },
      },
    }, generation);
    expect(assistantPartialText(latest().streamingPartial)).toBe("held first text then latest");

    vi.advanceTimersByTime(10);
    controller.onEvent({
      type: "event",
      payload: {
        type: "message_update",
        sessionId: "A",
        epoch: "e-A",
        eventId: 4,
        streamId: "stream-A-1",
        messageId: "message-A-1",
        delta: { role: "assistant", delta: { type: "text", text: " within window" } },
      },
    }, generation);
    expect(assistantPartialText(latest().streamingPartial)).toBe("held first text then latest within window");

    controller.onEvent({
      type: "event",
      payload: {
        type: "message_end",
        sessionId: "A",
        epoch: "e-A",
        eventId: 5,
        streamId: "stream-A-1",
        messageId: "message-A-1",
        entryId: "entry-A-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "held first text then latest within window" }],
          model: "m",
          provider: "p",
        },
      },
    }, generation);
    expect(latest().streamingPartial).toBeNull();
    expect(latest().snapshot?.streaming?.partialMessage).toBeUndefined();

    unsubscribe();
    controller.dispose();
    h.dispose();
  });
});
