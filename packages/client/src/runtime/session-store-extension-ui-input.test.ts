import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, flush, lastFrame, snapshotPayload, type RuntimeHarness } from "./testing/harness";
import type { FakeWebSocket } from "./testing/harness";
import type { ExtensionUiRequest } from "@fffattiger/pix-protocol";

/**
 * E15 — SessionStore extension-UI INCREMENTAL input slot.
 *
 * `sendExtensionUiInput` is a dedicated bounded FIFO transport for
 * `extension_ui_input` (input/editor/custom), independent of the ordinary
 * command slot (prompt pending never blocks it) and of the D2-P8 final-response
 * slot (input and final response may travel in parallel). Ordering is exact
 * FIFO: one frame on the wire at a time, each awaiting its correlated ack.
 * Bounded: in-flight + waiting ≤ 16; overflow is a fixed session_busy. Every
 * entry settles exactly once on ack / error / detach / stop / dispose /
 * session switch / capability loss / epoch change. Key data is forwarded
 * verbatim (terminal bytes are meaningful) and never leaks into errors.
 */

function ack(caps: string[] = ["agent"]) {
  return { type: "handshake_ack", payload: { protocolVersion: 2, host: { mode: "local", capabilities: caps }, limits: { maxUpload: 0, maxOpenSessions: 4 }, sessionSnapshotSupport: true } };
}

function openReady(h: RuntimeHarness, caps: string[] = ["agent"]): FakeWebSocket {
  const ws = h.lastSocket();
  ws.serverOpen();
  ws.serverSend(ack(caps));
  return ws;
}

async function attach(h: RuntimeHarness, capabilities: string[], sessionId = "s1", resumeStatus: "snapshot" | "gap" | "epoch_changed" = "snapshot", epoch = "e1"): Promise<FakeWebSocket> {
  h.store.connect();
  const ws = openReady(h);
  const p = h.store.openSession(sessionId);
  await flush();
  const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
  ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId, epoch, resumeStatus, capabilities }) });
  await flush();
  await p;
  return ws;
}

const EXT_CAPS = ["runtime.prompt", "runtime.abort", "runtime.extension_ui"];

const customRequest: ExtensionUiRequest = { id: "req-custom", method: "custom", lines: ["line one"] };
const inputRequest: ExtensionUiRequest = { id: "req-input", method: "input", title: "Name", placeholder: "type here" };
const editorRequest: ExtensionUiRequest = { id: "req-editor", method: "editor", title: "Edit", prefill: "seed" };
const confirmRequest: ExtensionUiRequest = { id: "req-confirm", method: "confirm", title: "Proceed?", message: "m" };
const selectRequest: ExtensionUiRequest = { id: "req-select", method: "select", title: "Pick", options: ["a", "b"] };
const notifyRequest: ExtensionUiRequest = { id: "req-notify", method: "notify", message: "hello", notifyType: "info" };

interface InputCommandFrame {
  type: string;
  id: string;
  payload: { sessionId: string; command: { commandId: string; type: string; id: string; method: string; data: string } };
}

const inputFrames = (ws: FakeWebSocket): InputCommandFrame[] =>
  ws.sent.filter((f) => (f as InputCommandFrame).payload?.command?.type === "extension_ui_input") as InputCommandFrame[];

function ackInput(ws: FakeWebSocket, frame: InputCommandFrame): void {
  ws.serverSend({ type: "response", id: frame.id, payload: { ok: true, result: { commandId: frame.payload.command.commandId, result: { ok: true, type: "extension_ui_input" } } } });
}

function errInput(ws: FakeWebSocket, frame: InputCommandFrame, error: { code: string; message: string; retryable: boolean }): void {
  ws.serverSend({ type: "response", id: frame.id, payload: { ok: false, error } });
}

describe("SessionStore — E15 extension-UI incremental input slot", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("sends exact method-bound commands in strict FIFO (one on the wire at a time), key data verbatim", async () => {
    const h = createHarness();
    const ws = await attach(h, EXT_CAPS);

    // A typing burst — none of the callers awaits; all chunks enqueue instantly.
    const keys = ["\x1b[A", "a", " ", "b", "\x03"];
    const promises = keys.map((data) => h.store.sendExtensionUiInput(customRequest, data));
    await flush();

    // Exactly ONE frame on the wire (the FIFO head); the rest wait.
    let frames = inputFrames(ws);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload).toMatchObject({ sessionId: "s1" });
    expect(frames[0]!.payload.command).toMatchObject({ type: "extension_ui_input", id: "req-custom", method: "custom", data: "\x1b[A" });

    for (let i = 0; i < keys.length; i += 1) {
      frames = inputFrames(ws);
      expect(frames).toHaveLength(i + 1);
      expect(frames[i]!.payload.command.data).toBe(keys[i]);
      expect(frames[i]!.payload.command.commandId).toBeTruthy();
      ackInput(ws, frames[i]!);
      await flush();
      await expect(promises[i]).resolves.toBeUndefined();
    }
    expect(inputFrames(ws)).toHaveLength(keys.length);
  });

  it("accepts input/editor/custom, rejects select/confirm/non-interactive before any send", async () => {
    const h = createHarness();
    const ws = await attach(h, EXT_CAPS);

    for (const request of [inputRequest, editorRequest, customRequest]) {
      const p = h.store.sendExtensionUiInput(request, "x");
      await flush();
      const frame = inputFrames(ws).at(-1)!;
      expect(frame.payload.command.method).toBe(request.method);
      expect(frame.payload.command.id).toBe(request.id);
      ackInput(ws, frame);
      await expect(p).resolves.toBeUndefined();
    }

    for (const request of [confirmRequest, selectRequest, notifyRequest]) {
      await expect(h.store.sendExtensionUiInput(request, "x")).rejects.toMatchObject({ code: "invalid_input" });
    }
    // Nothing extra was sent for the rejections (3 acked frames only).
    expect(inputFrames(ws)).toHaveLength(3);
  });

  it("rejects when not attached or without the capability, without sending", async () => {
    const h = createHarness();
    await expect(h.store.sendExtensionUiInput(customRequest, "x")).rejects.toMatchObject({ code: "unavailable" });

    const ws = await attach(h, ["runtime.prompt", "runtime.abort"]);
    await expect(h.store.sendExtensionUiInput(customRequest, "x")).rejects.toMatchObject({ code: "unsupported_capability" });
    expect(inputFrames(ws)).toHaveLength(0);
  });

  it("runs while a prompt is pending AND in parallel with the final response (independent slots)", async () => {
    const h = createHarness();
    const ws = await attach(h, EXT_CAPS);

    const promptP = h.store.sendPrompt("long running prompt");
    await flush();
    // The prompt occupies the ordinary slot — incremental input must NOT be busy.
    const inputP = h.store.sendExtensionUiInput(customRequest, "\t");
    await flush();
    // The final response slot is ALSO free — both travel in parallel.
    const replyP = h.store.respondExtensionUi(customRequest, { responseKind: "value", value: "done" });
    await flush();

    const inputFrame = inputFrames(ws)[0]!;
    const responseFrame = ws.sent.filter((f) => (f as InputCommandFrame).payload?.command?.type === "extension_ui_response").at(-1) as InputCommandFrame;
    expect(responseFrame).toBeTruthy();

    // Settle all three in any order — each settles by its own correlation.
    ackInput(ws, inputFrame);
    ws.serverSend({ type: "response", id: responseFrame.id, payload: { ok: true, result: { commandId: responseFrame.payload.command.commandId, result: { ok: true, type: "extension_ui_response" } } } });
    ws.serverSend({ type: "response", id: (ws.sent.find((f) => (f as InputCommandFrame).payload?.command?.type === "prompt") as InputCommandFrame).id, payload: { ok: true, result: { commandId: (ws.sent.find((f) => (f as InputCommandFrame).payload?.command?.type === "prompt") as InputCommandFrame).payload.command.commandId, result: { ok: true, type: "prompt" } } } });
    await flush();
    await expect(inputP).resolves.toBeUndefined();
    await expect(replyP).resolves.toBeUndefined();
    await expect(promptP).resolves.toBeDefined();
  });

  it("queue is bounded: the 17th entry rejects with the fixed session_busy overflow error; slot recovers", async () => {
    const h = createHarness();
    const ws = await attach(h, EXT_CAPS);

    // 1 in flight + 15 waiting = 16 accepted.
    const accepted = Array.from({ length: 16 }, (_, i) => h.store.sendExtensionUiInput(customRequest, `k${i}`));
    await flush();
    expect(inputFrames(ws)).toHaveLength(1);

    const overflow = h.store.sendExtensionUiInput(customRequest, "k16");
    await expect(overflow).rejects.toMatchObject({ code: "session_busy", message: "extension UI input queue is full" });
    await flush();
    expect(inputFrames(ws)).toHaveLength(1);

    // Drain the whole FIFO; every accepted entry settles exactly once, in order.
    for (let i = 0; i < accepted.length; i += 1) {
      const frame = inputFrames(ws).at(-1)!;
      ackInput(ws, frame);
      await flush();
      await expect(accepted[i]).resolves.toBeUndefined();
    }
    expect(inputFrames(ws)).toHaveLength(16);

    // The slot recovered — a fresh burst is accepted again.
    const next = h.store.sendExtensionUiInput(customRequest, "again");
    await flush();
    ackInput(ws, inputFrames(ws).at(-1)!);
    await expect(next).resolves.toBeUndefined();
  });

  it("a per-entry server error settles only that entry; the FIFO keeps draining in order", async () => {
    const h = createHarness();
    const ws = await attach(h, EXT_CAPS);
    const p1 = h.store.sendExtensionUiInput(customRequest, "a");
    const p2 = h.store.sendExtensionUiInput(customRequest, "b");
    await flush();
    const frames = inputFrames(ws);
    expect(frames).toHaveLength(1);

    // The head is answered not_found (e.g. the request just closed server-side).
    errInput(ws, frames[0]!, { code: "not_found", message: "no pending extension UI input: req-custom", retryable: false });
    await flush();
    await expect(p1).rejects.toMatchObject({ code: "not_found" });

    // The queued tail still dispatches on its own frame and settles normally.
    const second = inputFrames(ws)[1]!;
    expect(second.payload.command.data).toBe("b");
    ackInput(ws, second);
    await expect(p2).resolves.toBeUndefined();
  });

  it("wrong envelope / wrong commandId / wrong result type frames are dropped; the legit ack settles once", async () => {
    const h = createHarness();
    const ws = await attach(h, EXT_CAPS);
    const p = h.store.sendExtensionUiInput(customRequest, "\x1b[B");
    await flush();
    const frame = inputFrames(ws)[0]!;
    const commandId = frame.payload.command.commandId;

    ws.serverSend({ type: "response", id: "other-envelope", payload: { ok: true, result: { commandId, result: { ok: true, type: "extension_ui_input" } } } });
    await flush();
    ws.serverSend({ type: "response", id: frame.id, payload: { ok: true, result: { commandId: "wrong", result: { ok: true, type: "extension_ui_input" } } } });
    await flush();
    ws.serverSend({ type: "response", id: frame.id, payload: { ok: true, result: { commandId, result: { ok: true, type: "prompt" } } } });
    await flush();

    let settled = false;
    void p.then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    // Still in flight → the tail is NOT dispatched past the head.
    const p2 = h.store.sendExtensionUiInput(customRequest, "z");
    await flush();
    expect(inputFrames(ws)).toHaveLength(1);

    ackInput(ws, frame);
    await expect(p).resolves.toBeUndefined();
    // Head settled → the tail dispatches now.
    const tail = inputFrames(ws)[1]!;
    ackInput(ws, tail);
    await expect(p2).resolves.toBeUndefined();
  });

  it("same-epoch reconnect resync resends the in-flight head with the SAME commandId; the waiting tail is untouched", async () => {
    const h = createHarness();
    let ws = await attach(h, EXT_CAPS);
    const p1 = h.store.sendExtensionUiInput(customRequest, "one");
    const p2 = h.store.sendExtensionUiInput(customRequest, "two");
    await flush();
    const frame1 = inputFrames(ws)[0]!;
    const commandId = frame1.payload.command.commandId;

    ws.serverClose(1006);
    vi.advanceTimersByTime(250);
    ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ack());
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1", epoch: "e1", resumeStatus: "gap", capabilities: EXT_CAPS }) });
    await flush();

    const resent = inputFrames(ws).at(-1)!;
    expect(resent.payload.command.commandId).toBe(commandId);
    expect(resent.id).not.toBe(frame1.id);
    expect(resent.payload.command.data).toBe("one");
    ackInput(ws, resent);
    await expect(p1).resolves.toBeUndefined();

    const tail = inputFrames(ws).at(-1)!;
    expect(tail.payload.command.data).toBe("two");
    expect(tail.payload.command.commandId).not.toBe(commandId);
    ackInput(ws, tail);
    await expect(p2).resolves.toBeUndefined();
  });

  it("epoch_changed settles the whole FIFO exactly once and nothing is resent", async () => {
    const h = createHarness();
    let ws = await attach(h, EXT_CAPS);
    const allInputFrames = (): number => h.sockets.reduce((count, sock) => count + sock.sent.filter((f) => (f as InputCommandFrame).payload?.command?.type === "extension_ui_input").length, 0);
    const p1 = h.store.sendExtensionUiInput(customRequest, "one");
    const p2 = h.store.sendExtensionUiInput(customRequest, "two");
    await flush();
    const sentBefore = allInputFrames();
    expect(sentBefore).toBe(1);

    ws.serverClose(1006);
    vi.advanceTimersByTime(250);
    ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ack());
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1", epoch: "e2", resumeStatus: "epoch_changed", capabilities: EXT_CAPS }) });
    await flush();

    await expect(p1).rejects.toMatchObject({ code: "epoch_changed" });
    await expect(p2).rejects.toMatchObject({ code: "epoch_changed" });
    expect(allInputFrames()).toBe(sentBefore); // epoch_changed must never resend input
  });

  it("detach retains in-flight input; stop / dispose settle queued entries exactly once", async () => {
    const h = createHarness();
    const ws = await attach(h, EXT_CAPS);
    const p1 = h.store.sendExtensionUiInput(customRequest, "a");
    await flush();
    const frame1 = inputFrames(ws)[0]!;
    const detachP = h.store.detach();
    await flush();
    const detachFrame = lastFrame<{ type: string; id: string }>(ws, "detach")!;
    ws.serverSend({ type: "response", id: detachFrame.id, payload: { ok: true, result: { sessionId: "s1", detached: true } } });
    await expect(detachP).resolves.toBeUndefined();
    expect(h.controller("s1")?.evictionProtection.pendingExtensionInput).toBe(true);
    ackInput(ws, frame1);
    await expect(p1).resolves.toBeUndefined();

    const h2 = createHarness();
    const ws2 = await attach(h2, EXT_CAPS);
    const p2 = h2.store.sendExtensionUiInput(customRequest, "a");
    await flush();
    const stopP = h2.store.stop();
    await flush();
    const stopFrame = lastFrame<{ type: string; id: string }>(ws2, "stop")!;
    ws2.serverSend({ type: "response", id: stopFrame.id, payload: { ok: true, result: { sessionId: "s1", stopped: true } } });
    await expect(stopP).resolves.toBeUndefined();
    await expect(p2).rejects.toMatchObject({ code: "interrupted", message: "session stopped" });

    const h3 = createHarness();
    await attach(h3, EXT_CAPS);
    const p3 = h3.store.sendExtensionUiInput(customRequest, "a");
    const p4 = h3.store.sendExtensionUiInput(customRequest, "b");
    await flush();
    h3.dispose();
    await expect(p3).rejects.toMatchObject({ code: "unavailable" });
    await expect(p4).rejects.toMatchObject({ code: "unavailable" });
  });

  it("session switch retains A input while B owns an independent input lane", async () => {
    const h = createHarness();
    const ws = await attach(h, EXT_CAPS, "s1");
    const old = h.store.sendExtensionUiInput(customRequest, "a");
    await flush();
    const oldFrame = inputFrames(ws)[0]!;
    const openP = h.store.openSession("s2");
    await flush();
    const detachFrame = lastFrame<{ type: string; id: string }>(ws, "detach")!;
    ws.serverSend({ type: "response", id: detachFrame.id, payload: { ok: true, result: { sessionId: "s1", detached: true } } });
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s2", capabilities: EXT_CAPS }) });
    await openP;

    const next = h.store.sendExtensionUiInput(inputRequest, "for s2");
    await flush();
    const frame = inputFrames(ws).at(-1)!;
    expect(frame.payload.sessionId).toBe("s2");
    expect(h.controller("s1")?.evictionProtection.pendingExtensionInput).toBe(true);
    expect(h.controller("s2")?.evictionProtection.pendingExtensionInput).toBe(true);
    ackInput(ws, oldFrame);
    await expect(old).resolves.toBeUndefined();
    ackInput(ws, frame);
    await expect(next).resolves.toBeUndefined();
  });

  it("capability loss settles the whole FIFO with unsupported_capability and blocks new input", async () => {
    const h = createHarness();
    const ws = await attach(h, EXT_CAPS);
    const p1 = h.store.sendExtensionUiInput(customRequest, "a");
    const p2 = h.store.sendExtensionUiInput(customRequest, "b");
    await flush();

    ws.serverSend({ type: "event", payload: { type: "runtime_capabilities_changed", sessionId: "s1", eventId: 1, epoch: "e1", capabilities: { capabilities: ["runtime.prompt", "runtime.abort"], version: 2 } } });
    await flush();
    await expect(p1).rejects.toMatchObject({ code: "unsupported_capability" });
    await expect(p2).rejects.toMatchObject({ code: "unsupported_capability" });
    await expect(h.store.sendExtensionUiInput(customRequest, "c")).rejects.toMatchObject({ code: "unsupported_capability" });
  });

  it("send failure settles the in-flight entry and keeps draining; every entry settles exactly once", async () => {
    const h = createHarness();
    const ws = await attach(h, EXT_CAPS);
    const originalSend = ws.send.bind(ws) as unknown as (data: string) => void;
    (ws as unknown as { send: (data: string) => void }).send = () => { throw new Error("boom"); };
    const p1 = h.store.sendExtensionUiInput(customRequest, "a");
    const p2 = h.store.sendExtensionUiInput(customRequest, "b");
    await flush();
    await expect(p1).rejects.toThrow("boom");
    await expect(p2).rejects.toThrow("boom");

    // Transport restored → the slot accepts new input.
    (ws as unknown as { send: (data: string) => void }).send = originalSend;
    const p3 = h.store.sendExtensionUiInput(customRequest, "c");
    await flush();
    const frame = inputFrames(ws).at(-1)!;
    expect(frame.payload.command.data).toBe("c");
    ackInput(ws, frame);
    await expect(p3).resolves.toBeUndefined();
  });

  it("never leaks key data into any rejection (fixed error strings only)", async () => {
    const h = createHarness();
    await attach(h, EXT_CAPS);
    const rejections: unknown[] = [];
    const collect = (p: Promise<void>): void => { void p.catch((error) => rejections.push(error)); };

    collect(h.store.sendExtensionUiInput(confirmRequest, "SECRET-KEY"));
    // Overflow path: fill the queue then overflow with a secret chunk.
    for (let i = 0; i < 16; i += 1) collect(h.store.sendExtensionUiInput(customRequest, `bulk-${i}`));
    collect(h.store.sendExtensionUiInput(customRequest, "SECRET-CHUNK"));
    collect(h.store.sendExtensionUiInput(notifyRequest, "SECRET-KEY"));
    await flush();

    const serialized = JSON.stringify(rejections);
    expect(serialized).not.toContain("SECRET-KEY");
    expect(serialized).not.toContain("SECRET-CHUNK");
    // Bulk data never appeared in errors either (entries are still queued/pending,
    // never rejected with payload-carrying messages).
    expect(serialized).not.toContain("bulk-5");
  });
});
