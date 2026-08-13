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
    // HIGH-1: store recovers to ready so a subsequent open proceeds immediately.
    expect(h.store.getSnapshot().connection).toBe("ready");
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

  async function promptRunning(h: RuntimeHarness): Promise<{ ws: FakeWebSocket; promptP: Promise<unknown> }> {
    const ws = await openAndAttach(h);
    const promptP = h.store.sendPrompt("hi");
    // Prevent unhandled rejection when stop settles the pending prompt.
    promptP.catch(() => undefined);
    await flush();
    ws.serverSend({ type: "event", payload: { type: "agent_start", sessionId: "s1", eventId: 1, epoch: "e1" } });
    await flush();
    return { ws, promptP };
  }

  /** Ack a stop frame with a valid RuntimeStopResult. */
  function ackStop(ws: FakeWebSocket, sessionId = "s1"): void {
    const stop = lastFrame<{ type: string; id: string }>(ws, "stop")!;
    ws.serverSend({ type: "response", id: stop.id, payload: { ok: true, result: { sessionId, stopped: true } } });
  }

  it("stop while running FIRST aborts + awaits interrupt result, THEN stops", async () => {
    const h = createHarness();
    const { ws, promptP } = await promptRunning(h);
    expect(h.store.getSnapshot().snapshot?.state.isPromptRunning).toBe(true);
    const stopP = h.store.stop("done");
    await flush();
    const interrupt = lastFrame<{ type: string; id: string; payload: { commandId: string } }>(ws, "interrupt");
    expect(interrupt).toBeDefined();
    expect(lastFrame(ws, "stop")).toBeUndefined();
    ws.serverSend({ type: "interrupt_result", id: interrupt!.id, payload: { sessionId: "s1", commandId: interrupt!.payload.commandId, interruptType: "abort", result: { ok: true, type: "abort" } } });
    await flush();
    expect(lastFrame(ws, "stop")).toBeDefined();
    ackStop(ws);
    await flush();
    await expect(stopP).resolves.toBeUndefined();
    expect(h.store.getSnapshot().sessionStopped).toBe(true);
    // MEDIUM-4: pending prompt is settled on stop.
    await expect(promptP).rejects.toMatchObject({ code: "interrupted" });
  });

  it("stop proceeds even if the abort result never arrives (bounded timeout)", async () => {
    const h = createHarness({ storeOptions: { abortTimeoutMs: 1_000 } });
    const { ws } = await promptRunning(h);
    const stopP = h.store.stop();
    await flush();
    expect(lastFrame(ws, "interrupt")).toBeDefined();
    vi.advanceTimersByTime(1_000);
    await flush();
    expect(lastFrame(ws, "stop")).toBeDefined();
    ackStop(ws);
    await flush();
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

describe("SessionStore — verifier regressions (PROBE-1/2/3/5/9/12/14/15/16)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  async function reconnectReady(h: RuntimeHarness): Promise<FakeWebSocket> {
    vi.advanceTimersByTime(250);
    const ws2 = h.lastSocket();
    ws2.serverOpen();
    ws2.serverSend(ack());
    return ws2;
  }

  function ackStop(ws: FakeWebSocket, sessionId = "s1"): void {
    const stop = lastFrame<{ type: string; id: string }>(ws, "stop")!;
    ws.serverSend({ type: "response", id: stop.id, payload: { ok: true, result: { sessionId, stopped: true } } });
  }

  // PROBE-1 / PROBE-12 / PROBE-15: attach failure recovers to ready; second open settles on same socket.
  it("PROBE-1/12/15: attach failure recovers to ready; second open on same socket settles", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = openReady(h);
    const open1 = h.store.openSession("missing");
    await flush();
    const attach1 = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "response", id: attach1.id, payload: { ok: false, error: { code: "not_found", message: "gone", retryable: false } } });
    await expect(open1).rejects.toMatchObject({ code: "not_found" });
    expect(h.store.getSnapshot().connection).toBe("ready");

    const open2 = h.store.openSession("s1");
    await flush();
    const attach2 = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    expect(attach2.id).not.toBe(attach1.id);
    ws.serverSend({ type: "snapshot", id: attach2.id, payload: snapshotPayload({ sessionId: "s1" }) });
    await flush();
    await expect(open2).resolves.toBeUndefined();
    expect(h.store.getSnapshot().attached).toBe(true);
    expect(h.store.getSnapshot().connection).toBe("attached");
  });

  // PROBE-2: create → attach interrupted by socket close → original create promise settles via resume.
  it("PROBE-2: create→attach across reconnect settles the original create promise", async () => {
    const h = createHarness();
    h.store.connect();
    let ws = openReady(h);
    const createP = h.store.createSession({ cwd: "/x", projectRoot: "/x" });
    await flush();
    const createFrame = lastFrame<{ type: string; id: string }>(ws, "create")!;
    ws.serverSend({ type: "response", id: createFrame.id, payload: { ok: true, result: { sessionId: "s1", epoch: "e1", created: true, cwd: "/x", projectRoot: "/x" } } });
    await flush();
    expect(lastFrame(ws, "attach")).toBeDefined();
    // Drop the socket mid-attach: original create promise must survive via stable deferred.
    ws.serverClose(1006);
    ws = await reconnectReady(h);
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1", epoch: "e1", resumeStatus: "snapshot" }) });
    await flush();
    await expect(createP).resolves.toEqual({ sessionId: "s1" });
    expect(h.store.getSnapshot().attached).toBe(true);
  });

  // PROBE-3: prompt promise settles after abort+stop.
  it("PROBE-3: sendPrompt promise settles after abort+stop", async () => {
    const h = createHarness();
    const ws = await openAndAttach(h);
    const promptP = h.store.sendPrompt("hi");
    await flush();
    ws.serverSend({ type: "event", payload: { type: "agent_start", sessionId: "s1", eventId: 1, epoch: "e1" } });
    await flush();
    const stopP = h.store.stop();
    await flush();
    const interrupt = lastFrame<{ type: string; id: string; payload: { commandId: string } }>(ws, "interrupt")!;
    ws.serverSend({ type: "interrupt_result", id: interrupt.id, payload: { sessionId: "s1", commandId: interrupt.payload.commandId, interruptType: "abort", result: { ok: true, type: "abort" } } });
    await flush();
    ackStop(ws);
    await flush();
    await expect(stopP).resolves.toBeUndefined();
    await expect(promptP).rejects.toMatchObject({ code: "interrupted" });
  });

  // PROBE-5: concurrent create — second is busy-rejected; only one create frame.
  it("PROBE-5: concurrent create rejects second as busy and sends one frame", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = openReady(h);
    const a = h.store.createSession({ cwd: "/x", projectRoot: "/x" });
    const b = h.store.createSession({ cwd: "/y", projectRoot: "/y" });
    await flush();
    await expect(b).rejects.toMatchObject({ code: "session_busy" });
    const creates = (ws.sent as { type: string }[]).filter((f) => f.type === "create");
    expect(creates.length).toBe(1);
    // First create still proceeds to attach.
    const createFrame = lastFrame<{ type: string; id: string }>(ws, "create")!;
    ws.serverSend({ type: "response", id: createFrame.id, payload: { ok: true, result: { sessionId: "s1", epoch: "e1", created: true, cwd: "/x", projectRoot: "/x" } } });
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1" }) });
    await flush();
    await expect(a).resolves.toEqual({ sessionId: "s1" });
  });

  // PROBE-9: stop while socket not sendable must NOT claim success without sending.
  it("PROBE-9: stop during backoff does not claim sessionStopped without a stop frame", async () => {
    const h = createHarness({ storeOptions: { stopSendTimeoutMs: 500, stopAckTimeoutMs: 500 } });
    const ws = await openAndAttach(h);
    // Force transport loss → unavailable/reconnecting; stop must wait, then fail honestly.
    ws.serverClose(1006);
    await flush();
    expect(["unavailable", "reconnecting"]).toContain(h.store.getSnapshot().connection);
    const stopP = h.store.stop();
    await flush();
    // No stop frame can have been sent on the dead socket.
    expect(lastFrame(ws, "stop")).toBeUndefined();
    // Bound the wait so the test does not hang; reject keeps resume eligibility.
    vi.advanceTimersByTime(500);
    await flush();
    await expect(stopP).rejects.toMatchObject({ code: "timeout" });
    expect(h.store.getSnapshot().sessionStopped).toBe(false);
  });

  // PROBE-14: one-shot getSnapshot rejects on transport loss (no Map/promise leak).
  it("PROBE-14: getSnapshot pending is rejected on reconnect; Map does not leak", async () => {
    const h = createHarness();
    const ws = await openAndAttach(h);
    const snapP = h.store.fetchSnapshot();
    await flush();
    expect(lastFrame(ws, "getSnapshot")).toBeDefined();
    ws.serverClose(1006);
    await flush();
    await expect(snapP).rejects.toMatchObject({ code: "unavailable" });
    // Late response on new generation must not resurrect the settled promise.
    const ws2 = await reconnectReady(h);
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws2, "attach")!;
    ws2.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1" }) });
    await flush();
    // Promise already rejected; no hang / no double settle.
    await expect(snapP).rejects.toMatchObject({ code: "unavailable" });
  });

  // PROBE-16: concurrent stop merges into a single promise / single stop frame.
  it("PROBE-16: concurrent stop merges into one frame and one promise", async () => {
    const h = createHarness();
    const ws = await openAndAttach(h);
    // Start a prompt so interrupt path is exercised, then stop twice concurrently.
    const promptP = h.store.sendPrompt("hi");
    promptP.catch(() => undefined);
    await flush();
    ws.serverSend({ type: "event", payload: { type: "agent_start", sessionId: "s1", eventId: 1, epoch: "e1" } });
    await flush();
    const stopA = h.store.stop();
    const stopB = h.store.stop();
    expect(stopA).toBe(stopB); // same merged promise
    await flush();
    const interrupt = lastFrame<{ type: string; id: string; payload: { commandId: string } }>(ws, "interrupt")!;
    ws.serverSend({ type: "interrupt_result", id: interrupt.id, payload: { sessionId: "s1", commandId: interrupt.payload.commandId, interruptType: "abort", result: { ok: true, type: "abort" } } });
    await flush();
    const stops = (ws.sent as { type: string }[]).filter((f) => f.type === "stop");
    expect(stops.length).toBe(1);
    ackStop(ws);
    await flush();
    await expect(stopA).resolves.toBeUndefined();
    await expect(stopB).resolves.toBeUndefined();
    expect(h.store.getSnapshot().sessionStopped).toBe(true);
  });

  it("malicious wrong-id response does not resolve a pending open", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = openReady(h);
    const openP = h.store.openSession("s1");
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    // Wrong-id success response must not attach or settle.
    ws.serverSend({ type: "response", id: "not-the-attach-id", payload: { ok: true, result: { sessionId: "s1", detached: true } } });
    await flush();
    expect(h.store.getSnapshot().attached).toBe(false);
    // Wrong-id snapshot must not attach either.
    ws.serverSend({ type: "snapshot", id: "other", payload: snapshotPayload({ sessionId: "s1" }) });
    await flush();
    expect(h.store.getSnapshot().attached).toBe(false);
    // Correlated snapshot settles.
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1" }) });
    await flush();
    await expect(openP).resolves.toBeUndefined();
  });
});

describe("SessionStore — runtime capability authority + generic command", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("exposes authoritative runtime capabilities only while attached", async () => {
    const h = createHarness();
    // before attach: no runtime capability (never inferred from the Host agent capability)
    expect(h.store.runtimeCapabilities()).toBeNull();
    expect(h.store.hasRuntimeCapability("runtime.prompt")).toBe(false);
    expect(h.store.getSnapshot().capabilities).toBeNull();

    const ws = await openAndAttach(h);
    // the attach snapshot carried the authoritative runtime.prompt + runtime.abort
    expect(h.store.runtimeCapabilities()).toEqual({ capabilities: ["runtime.prompt", "runtime.abort"], version: 1 });
    expect(h.store.hasRuntimeCapability("runtime.prompt")).toBe(true);
    expect(h.store.hasRuntimeCapability("runtime.abort")).toBe(true);
    expect(h.store.hasRuntimeCapability("runtime.bash")).toBe(false);
    expect(h.store.getSnapshot().capabilities).toEqual({ capabilities: ["runtime.prompt", "runtime.abort"], version: 1 });
    // canAgent is the Host-level gate and is independent of runtime capability
    expect(h.store.getSnapshot().canAgent).toBe(true);
    ws;
  });

  it("a later capabilities event / snapshot updates the exposed capability set", async () => {
    const h = createHarness();
    const ws = await openAndAttach(h, "s1", "snapshot", "e1");
    ws.serverSend({ type: "event", payload: { type: "runtime_capabilities_changed", sessionId: "s1", eventId: 1, epoch: "e1", capabilities: { capabilities: ["runtime.prompt", "runtime.abort", "runtime.bash"], version: 2 } } });
    await flush();
    expect(h.store.runtimeCapabilities()).toEqual({ capabilities: ["runtime.prompt", "runtime.abort", "runtime.bash"], version: 2 });
    expect(h.store.hasRuntimeCapability("runtime.bash")).toBe(true);
  });

  it("detach clears the runtime capability set", async () => {
    const h = createHarness();
    const ws = await openAndAttach(h);
    expect(h.store.runtimeCapabilities()).not.toBeNull();
    const detachP = h.store.detach();
    await flush();
    const detachFrame = lastFrame<{ type: string; id: string }>(ws, "detach")!;
    ws.serverSend({ type: "response", id: detachFrame.id, payload: { ok: true, result: { sessionId: "s1", detached: true } } });
    await expect(detachP).resolves.toBeUndefined();
    expect(h.store.runtimeCapabilities()).toBeNull();
    expect(h.store.getSnapshot().capabilities).toBeNull();
  });

  it("stop clears the runtime capability set", async () => {
    const h = createHarness();
    const ws = await openAndAttach(h);
    expect(h.store.runtimeCapabilities()).not.toBeNull();
    const stopP = h.store.stop();
    await flush();
    const stopFrame = lastFrame<{ type: string; id: string }>(ws, "stop")!;
    ws.serverSend({ type: "response", id: stopFrame.id, payload: { ok: true, result: { sessionId: "s1", stopped: true } } });
    await expect(stopP).resolves.toBeUndefined();
    expect(h.store.runtimeCapabilities()).toBeNull();
    expect(h.store.getSnapshot().capabilities).toBeNull();
  });

  it("sendCommand reuses command correlation and settles on the correlated response", async () => {
    const h = createHarness();
    const ws = await openAndAttach(h);
    const cmdP = h.store.sendCommand({ commandId: "cmd-1", type: "prompt", message: "hi" });
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string } } }>(ws, "command")!;
    expect(cmd.payload.command.commandId).toBe("cmd-1");
    ws.serverSend({ type: "response", id: cmd.id, payload: { ok: true, result: { commandId: "cmd-1", result: { ok: true, type: "prompt" } } } });
    await expect(cmdP).resolves.toEqual({ commandId: "cmd-1", result: { ok: true, type: "prompt" } });
  });

  it("concurrent sendCommand fails fast instead of overwriting the first waiter", async () => {
    const h = createHarness();
    const ws = await openAndAttach(h);
    const first = h.store.sendCommand({ commandId: "cmd-1", type: "prompt", message: "first" });
    const second = h.store.sendCommand({ commandId: "cmd-2", type: "prompt", message: "second" });
    await expect(second).rejects.toMatchObject({ code: "session_busy", retryable: false });
    await flush();
    const commands = (ws.sent as { type: string; id?: string; payload?: { command?: { commandId?: string } } }[]).filter((frame) => frame.type === "command");
    expect(commands).toHaveLength(1);
    expect(commands[0]?.payload?.command?.commandId).toBe("cmd-1");
    ws.serverSend({ type: "response", id: commands[0]!.id!, payload: { ok: true, result: { commandId: "cmd-1", result: { ok: true, type: "prompt" } } } });
    await expect(first).resolves.toEqual({ commandId: "cmd-1", result: { ok: true, type: "prompt" } });
  });

  it("sendCommand resolves to an unsupported_capability result without throwing", async () => {
    const h = createHarness();
    const ws = await openAndAttach(h);
    // The runtime advertises runtime.prompt + runtime.abort only; a bash command
    // is unsupported and resolves to a correlated unsupported_capability result.
    const cmdP = h.store.sendCommand({ commandId: "cmd-bash", type: "bash", command: "ls" });
    await flush();
    const cmd = lastFrame<{ type: string; id: string }>(ws, "command")!;
    ws.serverSend({ type: "response", id: cmd.id, payload: { ok: true, result: { commandId: "cmd-bash", result: { ok: false, type: "bash", error: { code: "unsupported_capability", message: "runtime.bash not available", retryable: false } } } } });
    await expect(cmdP).resolves.toEqual({ commandId: "cmd-bash", result: { ok: false, type: "bash", error: { code: "unsupported_capability", message: "runtime.bash not available", retryable: false } } });
    // capability exposure is unchanged by the unsupported result
    expect(h.store.hasRuntimeCapability("runtime.bash")).toBe(false);
  });

  it("sendCommand rejects when not attached", async () => {
    const h = createHarness();
    await expect(h.store.sendCommand({ commandId: "x", type: "prompt", message: "hi" })).rejects.toThrow();
  });
});

describe("SessionStore — D2-P1 typed command helpers", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function attachWithCaps(h: RuntimeHarness, capabilities: string[], sessionId = "s1"): Promise<FakeWebSocket> {
    h.store.connect();
    const ws = openReady(h);
    const p = h.store.openSession(sessionId);
    return flush().then(() => {
      const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
      ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId, capabilities }) });
      return flush().then(() => p.then(() => ws));
    });
  }

  it("getState/getCommands/getLastAssistantText mint commandId internally and unwrap the correlated result", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort"]);

    const stateP = h.store.getState();
    await flush();
    const stateCmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string } } }>(ws, "command")!;
    expect(stateCmd.payload.command.type).toBe("get_state");
    expect(stateCmd.payload.command.commandId.length).toBeGreaterThan(0);
    ws.serverSend({ type: "response", id: stateCmd.id, payload: { ok: true, result: { commandId: stateCmd.payload.command.commandId, result: { ok: true, type: "get_state", state: { sessionId: "s1", isStreaming: false, isPromptRunning: false, isBashRunning: false, isCompacting: false, model: null, messageCount: 0 } } } } });
    await expect(stateP).resolves.toMatchObject({ sessionId: "s1", messageCount: 0 });

    const commandsP = h.store.getCommands();
    await flush();
    const commandsCmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string } } }>(ws, "command")!;
    expect(commandsCmd.payload.command.type).toBe("get_commands");
    ws.serverSend({ type: "response", id: commandsCmd.id, payload: { ok: true, result: { commandId: commandsCmd.payload.command.commandId, result: { ok: true, type: "get_commands", commands: [{ name: "/help", source: "prompt" }] } } } });
    await expect(commandsP).resolves.toEqual([{ name: "/help", source: "prompt" }]);

    const lastP = h.store.getLastAssistantText();
    await flush();
    const lastCmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string } } }>(ws, "command")!;
    expect(lastCmd.payload.command.type).toBe("get_last_assistant_text");
    ws.serverSend({ type: "response", id: lastCmd.id, payload: { ok: true, result: { commandId: lastCmd.payload.command.commandId, result: { ok: true, type: "get_last_assistant_text", text: "Hello world" } } } });
    await expect(lastP).resolves.toBe("Hello world");
  });

  it("getSessionStats and setSessionName unwrap their payloads and resolve", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.stats", "runtime.session.rename"]);

    const statsP = h.store.getSessionStats();
    await flush();
    const statsCmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string } } }>(ws, "command")!;
    expect(statsCmd.payload.command.type).toBe("get_session_stats");
    ws.serverSend({ type: "response", id: statsCmd.id, payload: { ok: true, result: { commandId: statsCmd.payload.command.commandId, result: { ok: true, type: "get_session_stats", stats: { messageCount: 3, tokenCount: 12 } } } } });
    await expect(statsP).resolves.toEqual({ messageCount: 3, tokenCount: 12 });

    const renameP = h.store.setSessionName("  Renamed  ");
    await flush();
    const renameCmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; name: string } } }>(ws, "command")!;
    expect(renameCmd.payload.command.type).toBe("set_session_name");
    // the helper trims the name before sending
    expect(renameCmd.payload.command.name).toBe("Renamed");
    ws.serverSend({ type: "response", id: renameCmd.id, payload: { ok: true, result: { commandId: renameCmd.payload.command.commandId, result: { ok: true, type: "set_session_name" } } } });
    await expect(renameP).resolves.toBeUndefined();
  });

  it("setThinkingLevel sends set_thinking_level and resolves on ok", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.thinking.set"]);

    const thinkingP = h.store.setThinkingLevel("high");
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; level: string } } }>(ws, "command")!;
    expect(cmd.payload.command.type).toBe("set_thinking_level");
    expect(cmd.payload.command.level).toBe("high");
    ws.serverSend({ type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "set_thinking_level" } } } });
    await expect(thinkingP).resolves.toBeUndefined();
  });

  it("setSessionName rejects a blank name without sending a command", async () => {
    const h = createHarness();
    await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.session.rename"]);
    await expect(h.store.setSessionName("   ")).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("concurrent typed helpers share the single-inflight command: the second fails fast as session_busy", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.stats", "runtime.thinking.set"]);
    const first = h.store.getState();
    const second = h.store.getSessionStats();
    await expect(second).rejects.toMatchObject({ code: "session_busy", retryable: false });
    await flush();
    const commands = (ws.sent as { type: string; id?: string; payload?: { command?: { commandId?: string; type?: string } } }[]).filter((frame) => frame.type === "command");
    expect(commands).toHaveLength(1);
    expect(commands[0]?.payload?.command?.type).toBe("get_state");
    const firstCmd = commands[0]!;
    ws.serverSend({ type: "response", id: firstCmd.id!, payload: { ok: true, result: { commandId: firstCmd.payload?.command?.commandId, result: { ok: true, type: "get_state", state: { sessionId: "s1", isStreaming: false, isPromptRunning: false, isBashRunning: false, isCompacting: false, model: null, messageCount: 0 } } } } });
    await expect(first).resolves.toMatchObject({ sessionId: "s1" });

    // Concurrent setThinkingLevel also fails fast as session_busy while another
    // typed command is in flight.
    const thinkingFirst = h.store.setThinkingLevel("medium");
    const thinkingSecond = h.store.setThinkingLevel("high");
    await expect(thinkingSecond).rejects.toMatchObject({ code: "session_busy", retryable: false });
    await flush();
    const thinkingCmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; level: string } } }>(ws, "command")!;
    expect(thinkingCmd.payload.command.type).toBe("set_thinking_level");
    expect(thinkingCmd.payload.command.level).toBe("medium");
    ws.serverSend({ type: "response", id: thinkingCmd.id, payload: { ok: true, result: { commandId: thinkingCmd.payload.command.commandId, result: { ok: true, type: "set_thinking_level" } } } });
    await expect(thinkingFirst).resolves.toBeUndefined();
  });

  it("a capability-gated helper rejects honestly with the runtime's unsupported_capability error", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort"]);
    // The runtime does NOT advertise runtime.stats; the server answers
    // unsupported_capability and the helper surfaces it (never fakes a result).
    const statsP = h.store.getSessionStats();
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string } } }>(ws, "command")!;
    ws.serverSend({ type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: false, type: "get_session_stats", error: { code: "unsupported_capability", message: "runtime.stats not available", retryable: false } } } } });
    await expect(statsP).rejects.toMatchObject({ code: "unsupported_capability", message: "runtime.stats not available" });
    // the client's capability exposure is unchanged
    expect(h.store.hasRuntimeCapability("runtime.stats")).toBe(false);
  });

  it("setThinkingLevel rejects honestly with unsupported_capability when the runtime gates it", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort"]);
    const thinkingP = h.store.setThinkingLevel("low");
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; level: string } } }>(ws, "command")!;
    expect(cmd.payload.command.type).toBe("set_thinking_level");
    expect(cmd.payload.command.level).toBe("low");
    ws.serverSend({ type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: false, type: "set_thinking_level", error: { code: "unsupported_capability", message: "runtime.thinking.set not available", retryable: false } } } } });
    await expect(thinkingP).rejects.toMatchObject({ code: "unsupported_capability", message: "runtime.thinking.set not available" });
    expect(h.store.hasRuntimeCapability("runtime.thinking.set")).toBe(false);
  });

  it("an ok:false response rejects the helper with the runtime error (not a fake success)", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort"]);
    const stateP = h.store.getState();
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string } } }>(ws, "command")!;
    ws.serverSend({ type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: false, type: "get_state", error: { code: "external", message: "boom", retryable: true } } } } });
    await expect(stateP).rejects.toMatchObject({ code: "external", message: "boom" });
  });

  it("helpers reject when not attached", async () => {
    const h = createHarness();
    await expect(h.store.getState()).rejects.toThrow();
    await expect(h.store.getCommands()).rejects.toThrow();
    await expect(h.store.getLastAssistantText()).rejects.toThrow();
    await expect(h.store.getSessionStats()).rejects.toThrow();
    await expect(h.store.setSessionName("x")).rejects.toThrow();
    await expect(h.store.setThinkingLevel("off")).rejects.toThrow();
    await expect(h.store.setModel("openai", "gpt-5")).rejects.toThrow();
  });
});

describe("SessionStore — D2-P3 setModel typed helper", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function attachWithCaps(h: RuntimeHarness, capabilities: string[], sessionId = "s1"): Promise<FakeWebSocket> {
    h.store.connect();
    const ws = openReady(h);
    const p = h.store.openSession(sessionId);
    return flush().then(() => {
      const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
      ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId, capabilities }) });
      return flush().then(() => p.then(() => ws));
    });
  }

  it("setModel sends set_model with exact provider/modelId and resolves on ok", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.model.set"]);

    const modelP = h.store.setModel("openai", "gpt-5");
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; provider: string; modelId: string } } }>(ws, "command")!;
    expect(cmd.payload.command.type).toBe("set_model");
    expect(cmd.payload.command.provider).toBe("openai");
    expect(cmd.payload.command.modelId).toBe("gpt-5");
    ws.serverSend({ type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "set_model" } } } });
    await expect(modelP).resolves.toBeUndefined();
  });

  it("setModel rejects blank provider/modelId without sending a command", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.model.set"]);
    await expect(h.store.setModel("", "gpt-5")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(h.store.setModel("openai", "  ")).rejects.toMatchObject({ code: "invalid_input" });
    await flush();
    const commands = (ws.sent as { type: string }[]).filter((frame) => frame.type === "command");
    expect(commands).toHaveLength(0);
  });

  it("concurrent setModel fails fast as session_busy while another typed command is in flight", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.model.set"]);
    const first = h.store.setModel("openai", "gpt-5");
    const second = h.store.setModel("anthropic", "claude-opus-4");
    await expect(second).rejects.toMatchObject({ code: "session_busy", retryable: false });
    await flush();
    const commands = (ws.sent as { type: string; id?: string; payload?: { command?: { commandId?: string; provider?: string; modelId?: string } } }[]).filter((frame) => frame.type === "command");
    expect(commands).toHaveLength(1);
    expect(commands[0]?.payload?.command?.provider).toBe("openai");
    const firstCmd = commands[0]!;
    ws.serverSend({ type: "response", id: firstCmd.id!, payload: { ok: true, result: { commandId: firstCmd.payload?.command?.commandId, result: { ok: true, type: "set_model" } } } });
    await expect(first).resolves.toBeUndefined();
  });

  it("setModel rejects honestly with unsupported_capability when the runtime gates it", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort"]);
    const modelP = h.store.setModel("openai", "gpt-5");
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; provider: string; modelId: string } } }>(ws, "command")!;
    expect(cmd.payload.command.type).toBe("set_model");
    ws.serverSend({ type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: false, type: "set_model", error: { code: "unsupported_capability", message: "runtime.model.set not available", retryable: false } } } } });
    await expect(modelP).rejects.toMatchObject({ code: "unsupported_capability", message: "runtime.model.set not available" });
    expect(h.store.hasRuntimeCapability("runtime.model.set")).toBe(false);
  });

  it("setModel rejects an ok:false response with the runtime error (not a fake success)", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.model.set"]);
    const modelP = h.store.setModel("openai", "gpt-5");
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string } } }>(ws, "command")!;
    ws.serverSend({ type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: false, type: "set_model", error: { code: "external", message: "unknown model backend boom", retryable: false } } } } });
    await expect(modelP).rejects.toMatchObject({ code: "external", message: "unknown model backend boom" });
  });
});
