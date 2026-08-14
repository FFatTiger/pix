import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, flush, lastFrame, snapshotPayload, type RuntimeHarness } from "./testing/harness";
import type { FakeWebSocket } from "./testing/harness";
import type { ExtensionUiRequest } from "@fffattiger/pix-protocol";

function ack(caps: string[] = ["agent"]) {
  return { type: "handshake_ack", payload: { protocolVersion: 1, host: { mode: "local", capabilities: caps }, limits: { maxUpload: 0, maxOpenSessions: 4 }, sessionSnapshotSupport: true } };
}

function openReady(h: RuntimeHarness, caps: string[] = ["agent"]): FakeWebSocket {
  const ws = h.lastSocket();
  ws.serverOpen();
  ws.serverSend(ack(caps));
  return ws;
}

/** Drive a fresh open+attach to ready+attached with the given runtime caps. */
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

const confirmRequest: ExtensionUiRequest = { id: "req-confirm", method: "confirm", title: "Proceed?", message: "Continue the operation?" };
const selectRequest: ExtensionUiRequest = { id: "req-select", method: "select", title: "Pick one", options: ["Alpha", "Beta"] };
const inputRequest: ExtensionUiRequest = { id: "req-input", method: "input", title: "Name", placeholder: "type here" };
const editorRequest: ExtensionUiRequest = { id: "req-editor", method: "editor", title: "Edit", prefill: "seed text" };
const customRequest: ExtensionUiRequest = { id: "req-custom", method: "custom", lines: ["line one"] };
const notifyRequest: ExtensionUiRequest = { id: "req-notify", method: "notify", message: "hello", notifyType: "info" };

interface CommandFrame {
  type: string;
  id: string;
  payload: { sessionId: string; command: { commandId: string; type: string; id?: string; method?: string; responseKind?: string; selected?: string; confirmed?: boolean; value?: string; cancelled?: boolean } };
}

function extFrame(ws: FakeWebSocket): CommandFrame {
  const frame = lastFrame<CommandFrame>(ws, "command")!;
  expect(frame).toBeTruthy();
  expect(frame.payload.command.type).toBe("extension_ui_response");
  return frame;
}

function respondOk(ws: FakeWebSocket, id: string, commandId: string, type = "extension_ui_response"): void {
  ws.serverSend({ type: "response", id, payload: { ok: true, result: { commandId, result: { ok: true, type } } } });
}

function respondErr(ws: FakeWebSocket, id: string, error: { code: string; message: string; retryable: boolean }): void {
  ws.serverSend({ type: "response", id, payload: { ok: false, error } });
}

describe("SessionStore — D2-P8 extension-UI reply slot", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("sends the exact extension_ui_response command for every reply variant/method and never extension_ui_input", async () => {
    const h = createHarness();
    const ws = await attach(h, EXT_CAPS);

    const cases: { request: ExtensionUiRequest; reply: unknown; expectCommand: Record<string, unknown> }[] = [
      { request: confirmRequest, reply: { responseKind: "confirmed", confirmed: true }, expectCommand: { id: "req-confirm", method: "confirm", responseKind: "confirmed", confirmed: true } },
      { request: selectRequest, reply: { responseKind: "selected", selected: "Beta" }, expectCommand: { id: "req-select", method: "select", responseKind: "selected", selected: "Beta" } },
      { request: inputRequest, reply: { responseKind: "value", value: "typed" }, expectCommand: { id: "req-input", method: "input", responseKind: "value", value: "typed" } },
      { request: editorRequest, reply: { responseKind: "value", value: "edited" }, expectCommand: { id: "req-editor", method: "editor", responseKind: "value", value: "edited" } },
      { request: customRequest, reply: { responseKind: "value", value: "custom answer" }, expectCommand: { id: "req-custom", method: "custom", responseKind: "value", value: "custom answer" } },
    ];
    for (const c of cases) {
      const p = h.store.respondExtensionUi(c.request, c.reply as never);
      await flush();
      expect(h.store.getSnapshot().extensionUiReplyPending).toBe(true);
      const frame = extFrame(ws);
      expect(frame.payload.sessionId).toBe("s1");
      const command = frame.payload.command;
      expect(command.commandId).toBeTruthy();
      expect(command.type).toBe("extension_ui_response");
      const commandRecord = command as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(c.expectCommand)) expect(commandRecord[key]).toEqual(value);
      respondOk(ws, frame.id, command.commandId!);
      await expect(p).resolves.toBeUndefined();
      expect(h.store.getSnapshot().extensionUiReplyPending).toBe(false);
    }

    // cancelled is valid for every interactive method.
    for (const request of [confirmRequest, selectRequest, inputRequest, editorRequest, customRequest]) {
      const p = h.store.respondExtensionUi(request, { responseKind: "cancelled", cancelled: true });
      await flush();
      const frame = extFrame(ws);
      expect(frame.payload.command).toMatchObject({ id: request.id, method: request.method, responseKind: "cancelled", cancelled: true });
      respondOk(ws, frame.id, frame.payload.command.commandId!);
      await expect(p).resolves.toBeUndefined();
    }

    // Final-response only: never an extension_ui_input frame.
    const allFrames = h.sockets.flatMap((sock) => sock.sent);
    expect(allFrames.filter((f) => (f as { payload?: { command?: { type?: string } } }).payload?.command?.type === "extension_ui_input")).toHaveLength(0);
  });

  it("works while a prompt is pending (dedicated slot), second reply is session_busy, correlated ack is exact", async () => {
    const h = createHarness();
    const ws = await attach(h, EXT_CAPS);

    const promptP = h.store.sendPrompt("long running prompt");
    await flush();
    // The prompt occupies the ordinary slot — the extension reply must NOT be busy.
    const replyP = h.store.respondExtensionUi(confirmRequest, { responseKind: "confirmed", confirmed: true });
    await flush();
    expect(h.store.getSnapshot().extensionUiReplyPending).toBe(true);
    const frame = extFrame(ws);
    expect(frame.payload.command.commandId).toBeTruthy();

    // Second extension reply (any request) is session_busy and never overwrites.
    const second = h.store.respondExtensionUi(inputRequest, { responseKind: "value", value: "x" });
    await expect(second).rejects.toMatchObject({ code: "session_busy", retryable: false });
    await flush();
    const extFrames = (ws.sent as { payload?: { command?: { type?: string } } }[]).filter((f) => f.payload?.command?.type === "extension_ui_response");
    expect(extFrames).toHaveLength(1);

    // Ack the extension reply: resolves with void (unwrapped ack); prompt still pending.
    respondOk(ws, frame.id, frame.payload.command.commandId!);
    await expect(replyP).resolves.toBeUndefined();
    expect(h.store.getSnapshot().extensionUiReplyPending).toBe(false);

    let promptSettled = false;
    void promptP.then(() => { promptSettled = true; });
    await flush();
    expect(promptSettled).toBe(false);

    // Slot recovered: a fresh reply can go out while the prompt is still pending.
    const next = h.store.respondExtensionUi(selectRequest, { responseKind: "selected", selected: "Alpha" });
    await flush();
    const frame2 = extFrame(ws);
    respondOk(ws, frame2.id, frame2.payload.command.commandId!);
    await expect(next).resolves.toBeUndefined();

    // Finally the prompt settles on its own correlated response.
    const promptCmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string } } }>(ws, "command");
    const promptFrame = (ws.sent as { type: string; id: string; payload: { command: { type: string; commandId: string } } }[]).find((f) => f.type === "command" && f.payload.command.type === "prompt");
    respondOk(ws, promptFrame!.id, promptFrame!.payload.command.commandId, "prompt");
    await expect(promptP).resolves.toBeTruthy();
    expect(promptCmd).toBeTruthy();
  });

  it("rejects a wrong-method/non-interactive reply before any send", async () => {
    const h = createHarness();
    const ws = await attach(h, EXT_CAPS);

    // selected reply on a confirm request → invalid_input before send.
    await expect(h.store.respondExtensionUi(confirmRequest, { responseKind: "selected", selected: "x" })).rejects.toMatchObject({ code: "invalid_input", retryable: false });
    // value reply on a confirm request → invalid_input before send.
    await expect(h.store.respondExtensionUi(confirmRequest, { responseKind: "value", value: "x" })).rejects.toMatchObject({ code: "invalid_input", retryable: false });
    // confirmed reply on a select request → invalid_input before send.
    await expect(h.store.respondExtensionUi(selectRequest, { responseKind: "confirmed", confirmed: true })).rejects.toMatchObject({ code: "invalid_input", retryable: false });
    // Non-interactive request can never be answered.
    await expect(h.store.respondExtensionUi(notifyRequest, { responseKind: "cancelled", cancelled: true })).rejects.toMatchObject({ code: "invalid_input", retryable: false });
    expect(h.store.getSnapshot().extensionUiReplyPending).toBe(false);
    expect((ws.sent as { payload?: { command?: { type?: string } } }[]).filter((f) => f.payload?.command?.type === "extension_ui_response")).toHaveLength(0);
  });

  it("rejects when not attached or without the capability, without sending", async () => {
    const h = createHarness();
    await expect(h.store.respondExtensionUi(confirmRequest, { responseKind: "cancelled", cancelled: true })).rejects.toMatchObject({ code: "unavailable" });

    const h2 = createHarness();
    await attach(h2, ["runtime.prompt", "runtime.abort"]); // no extension_ui capability
    await expect(h2.store.respondExtensionUi(confirmRequest, { responseKind: "cancelled", cancelled: true })).rejects.toMatchObject({ code: "unsupported_capability" });
    expect(h2.store.getSnapshot().extensionUiReplyPending).toBe(false);
  });

  it("surfaces the server's structured invalid_input / not_found rejection exactly once", async () => {
    const h = createHarness();
    const ws = await attach(h, EXT_CAPS);

    const p = h.store.respondExtensionUi(confirmRequest, { responseKind: "confirmed", confirmed: true });
    await flush();
    const frame = extFrame(ws);
    respondErr(ws, frame.id, { code: "invalid_input", message: "extension response method mismatch", retryable: false });
    await expect(p).rejects.toMatchObject({ code: "invalid_input" });
    expect(h.store.getSnapshot().extensionUiReplyPending).toBe(false);

    // Slot recovered.
    const p2 = h.store.respondExtensionUi(confirmRequest, { responseKind: "confirmed", confirmed: true });
    await flush();
    const frame2 = extFrame(ws);
    respondErr(ws, frame2.id, { code: "not_found", message: "no pending extension UI request", retryable: false });
    await expect(p2).rejects.toMatchObject({ code: "not_found" });
    expect(h.store.getSnapshot().extensionUiReplyPending).toBe(false);
  });

  it("same-epoch reconnect resync resends the SAME commandId on a fresh envelope", async () => {
    const h = createHarness();
    let ws = await attach(h, EXT_CAPS);
    const p = h.store.respondExtensionUi(confirmRequest, { responseKind: "cancelled", cancelled: true });
    await flush();
    const frame1 = extFrame(ws);
    const commandId = frame1.payload.command.commandId!;
    const envelope1 = frame1.id;

    ws.serverClose(1006);
    vi.advanceTimersByTime(250);
    ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ack());
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1", epoch: "e1", resumeStatus: "snapshot", capabilities: EXT_CAPS }) });
    await flush();

    const frame2 = extFrame(ws);
    expect(frame2.payload.command.commandId).toBe(commandId);
    expect(frame2.id).not.toBe(envelope1);
    respondOk(ws, frame2.id, frame2.payload.command.commandId!);
    await expect(p).resolves.toBeUndefined();
  });

  it("epoch_changed never resends; rejects as ambiguous and frees the slot", async () => {
    const h = createHarness();
    let ws = await attach(h, EXT_CAPS);
    const p = h.store.respondExtensionUi(confirmRequest, { responseKind: "cancelled", cancelled: true });
    await flush();
    const frame1 = extFrame(ws);
    const commandId = frame1.payload.command.commandId!;

    ws.serverClose(1006);
    vi.advanceTimersByTime(250);
    ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ack());
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1", epoch: "e2", resumeStatus: "epoch_changed", capabilities: EXT_CAPS }) });
    await flush();

    await expect(p).rejects.toMatchObject({ code: "epoch_changed" });
    expect(h.store.getSnapshot().extensionUiReplyPending).toBe(false);
    const extFrames = h.sockets.flatMap((sock) => sock.sent).filter((f) => (f as { payload?: { command?: { type?: string } } }).payload?.command?.type === "extension_ui_response");
    expect(extFrames).toHaveLength(1);
    expect(commandId).toBeTruthy();
  });

  it("detach / stop / dispose settle the in-flight reply exactly once and free the slot", async () => {
    // detach
    const h = createHarness();
    const ws = await attach(h, EXT_CAPS);
    const p = h.store.respondExtensionUi(confirmRequest, { responseKind: "confirmed", confirmed: true });
    await flush();
    const detachP = h.store.detach();
    await flush();
    const detachFrame = lastFrame<{ type: string; id: string }>(ws, "detach")!;
    ws.serverSend({ type: "response", id: detachFrame.id, payload: { ok: true, result: { sessionId: "s1", detached: true } } });
    await expect(detachP).resolves.toBeUndefined();
    await expect(p).rejects.toMatchObject({ code: "interrupted", message: "detached" });
    expect(h.store.getSnapshot().extensionUiReplyPending).toBe(false);

    // stop
    const h2 = createHarness();
    const ws2 = await attach(h2, EXT_CAPS);
    const p2 = h2.store.respondExtensionUi(confirmRequest, { responseKind: "confirmed", confirmed: true });
    await flush();
    const stopP = h2.store.stop();
    await flush();
    const stopFrame = lastFrame<{ type: string; id: string }>(ws2, "stop")!;
    ws2.serverSend({ type: "response", id: stopFrame.id, payload: { ok: true, result: { sessionId: "s1", stopped: true } } });
    await expect(stopP).resolves.toBeUndefined();
    await expect(p2).rejects.toMatchObject({ code: "interrupted", message: "session stopped" });
    expect(h2.store.getSnapshot().extensionUiReplyPending).toBe(false);

    // dispose
    const h3 = createHarness();
    const ws3 = await attach(h3, EXT_CAPS);
    const p3 = h3.store.respondExtensionUi(confirmRequest, { responseKind: "confirmed", confirmed: true });
    await flush();
    h3.store.dispose();
    await expect(p3).rejects.toMatchObject({ code: "unavailable" });
    expect(h3.store.getSnapshot().extensionUiReplyPending).toBe(false);
    expect(ws3.wasClosedByClient).toBe(true);
  });

  it("session switch (detach-then-open) settles the in-flight reply and never re-sends it into s2", async () => {
    const h = createHarness();
    const ws = await attach(h, EXT_CAPS, "s1");
    const p = h.store.respondExtensionUi(confirmRequest, { responseKind: "confirmed", confirmed: true });
    await flush();
    // The AppShell switch path is detach-then-open; detach settles the reply.
    const detachP = h.store.detach();
    await flush();
    const detachFrame = lastFrame<{ type: string; id: string }>(ws, "detach")!;
    ws.serverSend({ type: "response", id: detachFrame.id, payload: { ok: true, result: { sessionId: "s1", detached: true } } });
    await expect(detachP).resolves.toBeUndefined();
    await expect(p).rejects.toMatchObject({ code: "interrupted", message: "detached" });
    expect(h.store.getSnapshot().extensionUiReplyPending).toBe(false);

    // Switch to s2: a fresh reply goes out on s2 and is never cross-talked with s1.
    const openP = h.store.openSession("s2");
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    expect(attachFrame.payload.sessionId).toBe("s2");
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s2", capabilities: EXT_CAPS }) });
    await flush();
    await expect(openP).resolves.toBeUndefined();

    const next = h.store.respondExtensionUi(inputRequest, { responseKind: "value", value: "for s2" });
    await flush();
    const frame2 = extFrame(ws);
    expect(frame2.payload.sessionId).toBe("s2");
    respondOk(ws, frame2.id, frame2.payload.command.commandId!);
    await expect(next).resolves.toBeUndefined();
  });

  it("send failure rejects the reply and clears the slot", async () => {
    const h = createHarness();
    const ws = await attach(h, EXT_CAPS);
    (ws as unknown as { send: (data: string) => void }).send = () => { throw new Error("boom"); };
    const p = h.store.respondExtensionUi(confirmRequest, { responseKind: "cancelled", cancelled: true });
    await flush();
    await expect(p).rejects.toThrow("boom");
    expect(h.store.getSnapshot().extensionUiReplyPending).toBe(false);
  });

  it("wrong envelope / wrong commandId / wrong type responses are dropped; the legit frame settles once", async () => {
    const h = createHarness();
    const ws = await attach(h, EXT_CAPS);
    const p = h.store.respondExtensionUi(confirmRequest, { responseKind: "confirmed", confirmed: true });
    await flush();
    const frame = extFrame(ws);
    const commandId = frame.payload.command.commandId!;

    // Wrong envelope id → dropped.
    ws.serverSend({ type: "response", id: "other-envelope", payload: { ok: true, result: { commandId, result: { ok: true, type: "extension_ui_response" } } } });
    await flush();
    // Wrong commandId on the right envelope → dropped.
    ws.serverSend({ type: "response", id: frame.id, payload: { ok: true, result: { commandId: "wrong-command-id", result: { ok: true, type: "extension_ui_response" } } } });
    await flush();
    // Right envelope+commandId but WRONG result type → dropped.
    ws.serverSend({ type: "response", id: frame.id, payload: { ok: true, result: { commandId, result: { ok: true, type: "prompt" } } } });
    await flush();

    let settled = false;
    void p.then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    expect(h.store.getSnapshot().extensionUiReplyPending).toBe(true);

    // The legit correlated frame resolves exactly once.
    respondOk(ws, frame.id, commandId);
    await expect(p).resolves.toBeUndefined();
    expect(h.store.getSnapshot().extensionUiReplyPending).toBe(false);

    // A duplicate late frame is dropped (slot already cleared, no double settle).
    ws.serverSend({ type: "response", id: frame.id, payload: { ok: true, result: { commandId, result: { ok: true, type: "extension_ui_response" } } } });
    await flush();
    expect(h.store.getSnapshot().extensionUiReplyPending).toBe(false);
  });

  it("capability loss settles the in-flight reply with unsupported_capability", async () => {
    const h = createHarness();
    const ws = await attach(h, EXT_CAPS);
    const p = h.store.respondExtensionUi(confirmRequest, { responseKind: "confirmed", confirmed: true });
    await flush();
    expect(h.store.getSnapshot().extensionUiReplyPending).toBe(true);

    // runtime_capabilities_changed drops the capability (eventId must be 1 after attach).
    ws.serverSend({ type: "event", payload: { type: "runtime_capabilities_changed", sessionId: "s1", eventId: 1, epoch: "e1", capabilities: { capabilities: ["runtime.prompt", "runtime.abort"], version: 2 } } });
    await flush();
    await expect(p).rejects.toMatchObject({ code: "unsupported_capability" });
    expect(h.store.getSnapshot().extensionUiReplyPending).toBe(false);

    // Capability revoked → subsequent replies are rejected up front.
    await expect(h.store.respondExtensionUi(confirmRequest, { responseKind: "cancelled", cancelled: true })).rejects.toMatchObject({ code: "unsupported_capability" });
  });
});
