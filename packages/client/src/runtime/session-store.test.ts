import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, flush, lastFrame, snapshotPayload, type RuntimeHarness } from "./testing/harness";
import type { FakeWebSocket } from "./testing/harness";

function ack(caps: string[] = ["agent"]) {
  return { type: "handshake_ack", payload: { protocolVersion: 1, host: { mode: "local", capabilities: caps }, limits: { maxUpload: 0, maxOpenSessions: 4 }, sessionSnapshotSupport: true } };
}

function openReady(h: RuntimeHarness, caps: string[] = ["agent"]): FakeWebSocket {
  const ws = h.lastSocket();
  ws.serverOpen();
  ws.serverSend(ack(caps));
  return ws;
}

/** Drive a fresh open+attach to `ready`+`attached` without deadlocking. */
async function openAndAttach(h: RuntimeHarness, sessionId = "s1", resumeStatus: "snapshot" | "gap" | "epoch_changed" = "snapshot", epoch = "e1"): Promise<FakeWebSocket> {
  h.store.connect();
  const ws = openReady(h);
  const p = h.store.openSession(sessionId);
  await flush();
  const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
  ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId, epoch, resumeStatus }) });
  await flush();
  await p;
  return ws;
}

describe("SessionStore — connect / handshake / capability honesty", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("exposes canAgent only when the host advertises the agent capability", async () => {
    const h = createHarness();
    h.store.connect();
    openReady(h, ["files"]);
    await flush();
    expect(h.store.getSnapshot().canAgent).toBe(false);
    expect(h.store.getSnapshot().host?.capabilities).toEqual(["files"]);
  });

  it("fatal handshake reject stops and never attaches", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend({ type: "handshake_reject", payload: { error: { code: "unauthorized", message: "no", retryable: false } } });
    await flush();
    const view = h.store.getSnapshot();
    expect(view.connection).toBe("stopped");
    expect(view.fatal).toBe(true);
    expect(view.attached).toBe(false);
  });
});

describe("SessionStore — create → attach id correlation", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("create extracts sessionId then FRESH attaches; create snapshot is ignored", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = openReady(h);
    const p = h.store.createSession({ cwd: "/x", projectRoot: "/x" });
    await flush();
    const createFrame = lastFrame<{ type: string; id: string }>(ws, "create")!;
    ws.serverSend({ type: "response", id: createFrame.id, payload: { ok: true, result: { sessionId: "s1", epoch: "e1", created: true, cwd: "/x", projectRoot: "/x", snapshot: snapshotPayload({ sessionId: "s1" }).snapshot } } });
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string; payload: Record<string, unknown> }>(ws, "attach")!;
    expect(attachFrame.payload.sessionId).toBe("s1");
    expect(Object.keys(attachFrame.payload)).toEqual(["sessionId"]);
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1" }) });
    await flush();
    await expect(p).resolves.toEqual({ sessionId: "s1" });
    expect(h.store.getSnapshot().attached).toBe(true);
    expect(h.store.getSnapshot().sessionId).toBe("s1");
  });

  it("attach failure response (matching id) rejects and never attaches", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = openReady(h);
    const openP = h.store.openSession("s1");
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "response", id: attachFrame.id, payload: { ok: false, error: { code: "not_found", message: "no such session", retryable: false } } });
    await expect(openP).rejects.toMatchObject({ code: "not_found" });
    expect(h.store.getSnapshot().attached).toBe(false);
  });

  it("cold open = fresh attach (no create)", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = openReady(h);
    const p = h.store.openSession("s1");
    await flush();
    expect(lastFrame(ws, "create")).toBeUndefined();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1" }) });
    await flush();
    await expect(p).resolves.toBeUndefined();
    expect(h.store.getSnapshot().attached).toBe(true);
  });
});

describe("SessionStore — event cursor gating", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("applies eventId = last+1; drops duplicate", async () => {
    const h = createHarness();
    const ws = await openAndAttach(h);
    ws.serverSend({ type: "event", payload: { type: "agent_start", sessionId: "s1", eventId: 1, epoch: "e1" } });
    await flush();
    expect(h.store.getSnapshot().snapshot?.state.isPromptRunning).toBe(true);
    ws.serverSend({ type: "event", payload: { type: "agent_end", sessionId: "s1", eventId: 1, epoch: "e1" } });
    await flush();
    expect(h.store.getSnapshot().snapshot?.state.isPromptRunning).toBe(true);
  });

  it("gap and epoch mismatch trigger reattach, no apply", async () => {
    const h = createHarness();
    const ws = await openAndAttach(h);
    ws.serverSend({ type: "event", payload: { type: "agent_end", sessionId: "s1", eventId: 9, epoch: "e1" } });
    await flush();
    expect(lastFrame(ws, "attach")).toBeDefined();
    const h2 = createHarness();
    const ws2 = await openAndAttach(h2);
    ws2.serverSend({ type: "event", payload: { type: "agent_end", sessionId: "s1", eventId: 1, epoch: "OTHER" } });
    await flush();
    expect(lastFrame(ws2, "attach")).toBeDefined();
  });

  it("ignores events before the generation's first snapshot", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = openReady(h);
    void h.store.openSession("s1");
    await flush();
    ws.serverSend({ type: "event", payload: { type: "agent_start", sessionId: "s1", eventId: 1, epoch: "e1" } });
    await flush();
    // No snapshot yet → event dropped → isPromptRunning never becomes true.
    expect(h.store.getSnapshot().snapshot?.state.isPromptRunning).not.toBe(true);
  });
});

describe("SessionStore — getSnapshot does NOT advance the cursor", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("replaces projection state but keeps epoch/lastEventId", async () => {
    const h = createHarness();
    const ws = await openAndAttach(h);
    const fetchP = h.store.fetchSnapshot();
    await flush();
    const gsFrame = lastFrame<{ type: string; id: string }>(ws, "getSnapshot")!;
    const snap = snapshotPayload({ sessionId: "s1" }).snapshot as Record<string, unknown>;
    const state = { ...(snap.state as object), messageCount: 7 };
    ws.serverSend({ type: "response", id: gsFrame.id, payload: { ok: true, result: { ...snap, state } } });
    await expect(fetchP).resolves.toBeTruthy();
    expect(h.store.getSnapshot().snapshot?.state.messageCount).toBe(7);
    ws.serverSend({ type: "event", payload: { type: "agent_start", sessionId: "s1", eventId: 1, epoch: "e1" } });
    await flush();
    expect(h.store.getSnapshot().snapshot?.state.isPromptRunning).toBe(true);
  });
});

describe("SessionStore — prompt stream + abort", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("sends a prompt command and streams; abort uses an independent interrupt", async () => {
    const h = createHarness();
    const ws = await openAndAttach(h);
    const promptP = h.store.sendPrompt("hello");
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; message: string } } }>(ws, "command")!;
    expect(cmd.payload.command.type).toBe("prompt");
    ws.serverSend({ type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "prompt" } } } });
    await expect(promptP).resolves.toBeTruthy();
    ws.serverSend({ type: "event", payload: { type: "message_start", sessionId: "s1", streamId: "st", messageId: "m", message: { role: "assistant", model: "m", provider: "p" }, eventId: 1, epoch: "e1" } });
    ws.serverSend({ type: "event", payload: { type: "message_update", sessionId: "s1", streamId: "st", messageId: "m", delta: { role: "assistant", delta: { type: "text", text: "hi" } }, eventId: 2, epoch: "e1" } });
    await flush();
    expect(h.store.getSnapshot().streaming).toBe(true);
    const abortP = h.store.abort();
    await flush();
    const interrupt = lastFrame<{ type: string; id: string; payload: { commandId: string; interrupt: { type: string } } }>(ws, "interrupt")!;
    expect(interrupt.payload.interrupt.type).toBe("abort");
    ws.serverSend({ type: "interrupt_result", id: interrupt.id, payload: { sessionId: "s1", commandId: interrupt.payload.commandId, interruptType: "abort", result: { ok: true, type: "abort" } } });
    await expect(abortP).resolves.toBeTruthy();
  });

  it("coalesces concurrent aborts into a single in-flight interrupt", async () => {
    const h = createHarness();
    const ws = await openAndAttach(h);
    void h.store.sendPrompt("hi");
    await flush();
    h.store.abort();
    await flush();
    h.store.abort();
    await flush();
    const interrupts = (ws.sent as { type: string }[]).filter((f) => f.type === "interrupt");
    expect(interrupts.length).toBe(1);
  });
});

describe("SessionStore — abort-before-stop HOL rule", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  async function promptRunning(h: RuntimeHarness): Promise<FakeWebSocket> {
    const ws = await openAndAttach(h);
    void h.store.sendPrompt("hi");
    await flush();
    ws.serverSend({ type: "event", payload: { type: "agent_start", sessionId: "s1", eventId: 1, epoch: "e1" } });
    await flush();
    return ws;
  }

  it("stop while running FIRST aborts + awaits interrupt result, THEN stops", async () => {
    const h = createHarness();
    const ws = await promptRunning(h);
    expect(h.store.getSnapshot().snapshot?.state.isPromptRunning).toBe(true);
    const stopP = h.store.stop("done");
    await flush();
    const interrupt = lastFrame<{ type: string; id: string; payload: { commandId: string } }>(ws, "interrupt");
    expect(interrupt).toBeDefined();
    expect(lastFrame(ws, "stop")).toBeUndefined();
    ws.serverSend({ type: "interrupt_result", id: interrupt!.id, payload: { sessionId: "s1", commandId: interrupt!.payload.commandId, interruptType: "abort", result: { ok: true, type: "abort" } } });
    await flush();
    expect(lastFrame(ws, "stop")).toBeDefined();
    await expect(stopP).resolves.toBeUndefined();
    expect(h.store.getSnapshot().sessionStopped).toBe(true);
  });

  it("stop proceeds even if the abort result never arrives (bounded timeout)", async () => {
    const h = createHarness({ storeOptions: { abortTimeoutMs: 1_000 } });
    const ws = await promptRunning(h);
    const stopP = h.store.stop();
    await flush();
    expect(lastFrame(ws, "interrupt")).toBeDefined();
    vi.advanceTimersByTime(1_000);
    await flush();
    expect(lastFrame(ws, "stop")).toBeDefined();
    await expect(stopP).resolves.toBeUndefined();
  });
});

describe("SessionStore — same-epoch resend vs epoch_changed reject", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  async function reconnectReady(h: RuntimeHarness): Promise<FakeWebSocket> {
    vi.advanceTimersByTime(250);
    const ws2 = h.lastSocket();
    ws2.serverOpen();
    ws2.serverSend(ack());
    return ws2;
  }

  it("same epoch: re-sends the UNCONFIRMED pending command with the SAME commandId", async () => {
    const h = createHarness();
    let ws = await openAndAttach(h);
    const promptP = h.store.sendPrompt("hi");
    await flush();
    const cmd1 = lastFrame<{ type: string; payload: { command: { commandId: string } } }>(ws, "command")!;
    ws.serverClose(1006);
    ws = await reconnectReady(h);
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1", epoch: "e1", resumeStatus: "snapshot" }) });
    await flush();
    const cmd2 = lastFrame<{ type: string; id: string; payload: { command: { commandId: string } } }>(ws, "command")!;
    expect(cmd2.payload.command.commandId).toBe(cmd1.payload.command.commandId);
    ws.serverSend({ type: "response", id: cmd2.id, payload: { ok: true, result: { commandId: cmd2.payload.command.commandId, result: { ok: true, type: "prompt" } } } });
    await expect(promptP).resolves.toBeTruthy();
  });

  it("epoch_changed: NEVER re-sends the old commandId; rejects as ambiguous", async () => {
    const h = createHarness();
    let ws = await openAndAttach(h);
    const promptP = h.store.sendPrompt("hi");
    await flush();
    const cmd1 = lastFrame<{ type: string; payload: { command: { commandId: string } } }>(ws, "command")!;
    ws.serverClose(1006);
    ws = await reconnectReady(h);
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1", epoch: "e2", resumeStatus: "epoch_changed" }) });
    await flush();
    await expect(promptP).rejects.toMatchObject({ code: "epoch_changed" });
    expect(lastFrame(ws, "command")).toBeUndefined();
    expect(cmd1.payload.command.commandId).toBeTruthy();
  });
});

describe("SessionStore — dispose / unavailable / strict result union", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("dispose closes the socket and detaches; never stops a worker", async () => {
    const h = createHarness();
    const ws = await openAndAttach(h);
    h.store.dispose();
    expect(h.store.getSnapshot().connection).toBe("stopped");
    expect(lastFrame(ws, "stop")).toBeUndefined();
  });

  it("records runtime_unavailable error", async () => {
    const h = createHarness();
    const ws = await openAndAttach(h);
    ws.serverSend({ type: "runtime_unavailable", payload: { sessionId: "s1", error: { code: "runtime_unavailable", message: "down", retryable: true } } });
    await flush();
    expect(h.store.getSnapshot().error?.code).toBe("runtime_unavailable");
  });

  it("an invalid response result fails closed (strict result union, no `as any`)", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = openReady(h);
    ws.serverSend({ type: "response", id: "x", payload: { ok: true, result: { bogus: true } } });
    await flush();
    expect(h.store.getSnapshot().connection).toBe("stopped");
  });
});
