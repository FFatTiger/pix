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

describe("SessionStore — resume re-attach sends atomic {epoch, lastEventId}", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("re-attach after transport loss sends epoch AND lastEventId together (never one without the other)", async () => {
    const h = createHarness();
    let ws = await openAndAttach(h);
    // Advance the cursor so lastEventId is non-zero and the resume cursor is meaningful.
    ws.serverSend({ type: "event", payload: { type: "agent_start", sessionId: "s1", eventId: 1, epoch: "e1" } });
    await flush();
    expect(h.store.getSnapshot().epoch).toBe("e1");
    expect(h.store.getSnapshot().snapshot?.state.isPromptRunning).toBe(true);
    ws.serverClose(1006);
    vi.advanceTimersByTime(250);
    ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ack());
    await flush();
    const attachFrame = lastFrame<{
      type: string;
      payload: { sessionId: string; epoch?: string; lastEventId?: number };
    }>(ws, "attach")!;
    expect(attachFrame.payload.sessionId).toBe("s1");
    // Resume cursor is atomic: epoch and lastEventId appear together.
    expect(attachFrame.payload.epoch).toBe("e1");
    expect(attachFrame.payload.lastEventId).toBe(1);
    expect("epoch" in attachFrame.payload).toBe(true);
    expect("lastEventId" in attachFrame.payload).toBe(true);
  });

  it("fresh attach never sends epoch/lastEventId (no resume cursor)", async () => {
    const h = createHarness();
    const ws = await openAndAttach(h);
    const attachFrame = lastFrame<{ type: string; payload: Record<string, unknown> }>(ws, "attach")!;
    expect(attachFrame.payload.sessionId).toBe("s1");
    expect("epoch" in attachFrame.payload).toBe(false);
    expect("lastEventId" in attachFrame.payload).toBe(false);
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

describe("SessionStore — D2-P6 tools + reload (getTools / setTools / reload)", () => {
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

  function lastCommand(ws: FakeWebSocket): { id: string; payload: { command: { commandId: string; type: string; toolNames?: string[] } } } {
    const frame = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; toolNames?: string[] } } }>(ws, "command")!;
    expect(frame).toBeTruthy();
    return frame;
  }

  it("getTools sends get_tools and resolves with the typed tool list", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.tools.read"]);
    const p = h.store.getTools();
    await flush();
    const cmd = lastCommand(ws);
    expect(cmd.payload.command.type).toBe("get_tools");
    ws.serverSend({ type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "get_tools", tools: [{ name: "read", active: true }, { name: "write", active: false }] } } } });
    await expect(p).resolves.toEqual([{ name: "read", active: true }, { name: "write", active: false }]);
  });

  it("setTools trims and de-duplicates names and resolves on ok", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.tools.write"]);
    const p = h.store.setTools(["  read  ", "write", "read"]);
    await flush();
    const cmd = lastCommand(ws);
    expect(cmd.payload.command.type).toBe("set_tools");
    expect(cmd.payload.command.toolNames).toEqual(["read", "write"]);
    ws.serverSend({ type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "set_tools" } } } });
    await expect(p).resolves.toBeUndefined();
  });

  it("setTools rejects a blank name without sending (invalid_input)", async () => {
    const h = createHarness();
    await attachWithCaps(h, ["runtime.tools.write"]);
    await expect(h.store.setTools(["read", "   "])).rejects.toMatchObject({ code: "invalid_input", retryable: false });
    await expect(h.store.setTools(["read", "\n\t"])).rejects.toMatchObject({ code: "invalid_input", retryable: false });
    const frames = h.lastSocket().sent.filter((f) => (f as { type: string }).type === "command");
    expect(frames).toHaveLength(0);
  });

  it("setTools allows an empty selection (all-tools-off) and sends toolNames []", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.tools.write"]);
    const p = h.store.setTools([]);
    await flush();
    const cmd = lastCommand(ws);
    expect(cmd.payload.command.type).toBe("set_tools");
    expect(cmd.payload.command.toolNames).toEqual([]);
    ws.serverSend({ type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "set_tools" } } } });
    await expect(p).resolves.toBeUndefined();
  });

  it("reload sends reload and resolves on ok", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.reload"]);
    const p = h.store.reload();
    await flush();
    const cmd = lastCommand(ws);
    expect(cmd.payload.command.type).toBe("reload");
    ws.serverSend({ type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "reload" } } } });
    await expect(p).resolves.toBeUndefined();
  });

  it("concurrent setTools/reload fail fast as session_busy (single command slot)", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.tools.write", "runtime.reload"]);
    const first = h.store.setTools(["read"]);
    const second = h.store.reload();
    await expect(second).rejects.toMatchObject({ code: "session_busy", retryable: false });
    await flush();
    const commands = (ws.sent as { type: string; payload?: { command?: { type?: string } } }[]).filter((f) => f.type === "command");
    expect(commands).toHaveLength(1);
    expect(commands[0]?.payload?.command?.type).toBe("set_tools");
    const cmd = lastCommand(ws);
    ws.serverSend({ type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "set_tools" } } } });
    await expect(first).resolves.toBeUndefined();
  });

  it("getTools/setTools/reload reject honestly with unsupported_capability when the runtime gates them", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort"]);

    const toolsP = h.store.getTools();
    await flush();
    const toolsCmd = lastCommand(ws);
    ws.serverSend({ type: "response", id: toolsCmd.id, payload: { ok: true, result: { commandId: toolsCmd.payload.command.commandId, result: { ok: false, type: "get_tools", error: { code: "unsupported_capability", message: "runtime.tools.read not available", retryable: false } } } } });
    await expect(toolsP).rejects.toMatchObject({ code: "unsupported_capability", message: "runtime.tools.read not available" });

    const setP = h.store.setTools(["read"]);
    await flush();
    const setCmd = lastCommand(ws);
    ws.serverSend({ type: "response", id: setCmd.id, payload: { ok: true, result: { commandId: setCmd.payload.command.commandId, result: { ok: false, type: "set_tools", error: { code: "unsupported_capability", message: "runtime.tools.write not available", retryable: false } } } } });
    await expect(setP).rejects.toMatchObject({ code: "unsupported_capability", message: "runtime.tools.write not available" });

    const reloadP = h.store.reload();
    await flush();
    const reloadCmd = lastCommand(ws);
    ws.serverSend({ type: "response", id: reloadCmd.id, payload: { ok: true, result: { commandId: reloadCmd.payload.command.commandId, result: { ok: false, type: "reload", error: { code: "unsupported_capability", message: "runtime.reload not available", retryable: false } } } } });
    await expect(reloadP).rejects.toMatchObject({ code: "unsupported_capability", message: "runtime.reload not available" });

    expect(h.store.hasRuntimeCapability("runtime.tools.read")).toBe(false);
    expect(h.store.hasRuntimeCapability("runtime.tools.write")).toBe(false);
    expect(h.store.hasRuntimeCapability("runtime.reload")).toBe(false);
  });

  it("getTools/setTools/reload reject when not attached", async () => {
    const h = createHarness();
    await expect(h.store.getTools()).rejects.toThrow();
    await expect(h.store.setTools(["read"])).rejects.toThrow();
    await expect(h.store.reload()).rejects.toThrow();
  });
});

describe("SessionStore — D2-P4 dual-slot queued turns (steer/follow_up) + clear_queue interrupt", () => {
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

  function commandFrame(ws: FakeWebSocket): { id: string; payload: { command: { commandId: string; type: string; message?: string } } } {
    const frame = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; message?: string } } }>(ws, "command")!;
    expect(frame).toBeTruthy();
    return frame;
  }

  function respondOk(ws: FakeWebSocket, id: string, commandId: string, type: string): void {
    ws.serverSend({ type: "response", id, payload: { ok: true, result: { commandId, result: { ok: true, type } } } });
  }

  it("steer sends a trimmed steer command on the queued-turn slot and toggles queuedTurnPending", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.steer", "runtime.follow_up"]);
    const p = h.store.steer("  hello steer  ");
    await flush();
    expect(h.store.getSnapshot().queuedTurnPending).toBe(true);
    const cmd = commandFrame(ws);
    expect(cmd.payload.command.type).toBe("steer");
    expect(cmd.payload.command.message).toBe("hello steer");
    respondOk(ws, cmd.id, cmd.payload.command.commandId, "steer");
    await expect(p).resolves.toEqual({ commandId: cmd.payload.command.commandId, result: { ok: true, type: "steer" } });
    expect(h.store.getSnapshot().queuedTurnPending).toBe(false);
  });

  it("followUp sends a follow_up command and resolves on ok", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.follow_up"]);
    const p = h.store.followUp("hello follow");
    await flush();
    const cmd = commandFrame(ws);
    expect(cmd.payload.command.type).toBe("follow_up");
    expect(cmd.payload.command.message).toBe("hello follow");
    respondOk(ws, cmd.id, cmd.payload.command.commandId, "follow_up");
    await expect(p).resolves.toBeTruthy();
  });

  it("steer/followUp reject blank messages without sending (invalid_input)", async () => {
    const h = createHarness();
    await attachWithCaps(h, ["runtime.steer", "runtime.follow_up"]);
    await expect(h.store.steer("   ")).rejects.toMatchObject({ code: "invalid_input", retryable: false });
    await expect(h.store.followUp(" \n ")).rejects.toMatchObject({ code: "invalid_input", retryable: false });
    expect(h.store.getSnapshot().queuedTurnPending).toBe(false);
  });

  it("reject when not attached (steer/followUp/clearQueue)", async () => {
    const h = createHarness();
    await expect(h.store.steer("hi")).rejects.toMatchObject({ code: "unavailable" });
    await expect(h.store.followUp("hi")).rejects.toMatchObject({ code: "unavailable" });
    await expect(h.store.clearQueue()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("prompt + steer run CONCURRENTLY (dual slot) and both settle independently", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.steer"]);
    const promptP = h.store.sendPrompt("long running prompt");
    await flush();
    const steerP = h.store.steer("steer during prompt");
    await flush();
    const cmds = (ws.sent as { type: string; id?: string; payload?: { command?: { type?: string; commandId?: string } } }[]).filter((f) => f.type === "command");
    expect(cmds.length).toBe(2);
    const steerCmd = commandFrame(ws);
    expect(steerCmd.payload.command.type).toBe("steer");
    // Settle steer first; the prompt promise must remain pending.
    respondOk(ws, steerCmd.id, steerCmd.payload.command.commandId, "steer");
    await flush();
    let promptSettled = false;
    void promptP.then(() => { promptSettled = true; });
    await flush();
    expect(promptSettled).toBe(false);
    const promptCmd = cmds.find((f) => f.payload?.command?.type === "prompt");
    respondOk(ws, promptCmd!.id!, promptCmd!.payload!.command!.commandId!, "prompt");
    await expect(promptP).resolves.toBeTruthy();
    await expect(steerP).resolves.toBeTruthy();
  });

  it("second queued turn is session_busy and never overwrites the first waiter", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.steer", "runtime.follow_up"]);
    const first = h.store.steer("first");
    await flush();
    const second = h.store.followUp("second");
    await expect(second).rejects.toMatchObject({ code: "session_busy", retryable: false });
    await flush();
    const cmds = (ws.sent as { type: string; payload?: { command?: { message?: string } } }[]).filter((f) => f.type === "command");
    expect(cmds).toHaveLength(1);
    expect(cmds[0]?.payload?.command?.message).toBe("first");
    const cmd = commandFrame(ws);
    respondOk(ws, cmd.id, cmd.payload.command.commandId, "steer");
    await expect(first).resolves.toBeTruthy();
    // Slot freed: a follow-up can now go out.
    const next = h.store.followUp("after first");
    await flush();
    expect(h.store.getSnapshot().queuedTurnPending).toBe(true);
    const cmd2 = commandFrame(ws);
    expect(cmd2.payload.command.type).toBe("follow_up");
    respondOk(ws, cmd2.id, cmd2.payload.command.commandId, "follow_up");
    await expect(next).resolves.toBeTruthy();
  });

  it("send throw rejects the queued turn and clears the slot", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.steer"]);
    (ws as unknown as { send: (data: string) => void }).send = () => { throw new Error("boom"); };
    const p = h.store.steer("x");
    await flush();
    await expect(p).rejects.toThrow("boom");
    expect(h.store.getSnapshot().queuedTurnPending).toBe(false);
  });

  it("wrong envelope does NOT clear a pending queued turn; the legit frame resolves once", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.steer"]);
    const p = h.store.steer("steer me");
    await flush();
    const cmd = commandFrame(ws);
    // A response with the WRONG envelope id must be dropped.
    ws.serverSend({ type: "response", id: "some-other-envelope", payload: { ok: true, result: { commandId: "wrong", result: { ok: true, type: "steer" } } } });
    await flush();
    let settled = false;
    void p.then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    expect(h.store.getSnapshot().queuedTurnPending).toBe(true);
    respondOk(ws, cmd.id, cmd.payload.command.commandId, "steer");
    await expect(p).resolves.toBeTruthy();
    expect(h.store.getSnapshot().queuedTurnPending).toBe(false);
  });

  it("resync after a reconnect snapshot resends the SAME commandId on a fresh envelope", async () => {
    const h = createHarness();
    let ws = await attachWithCaps(h, ["runtime.steer"]);
    const p = h.store.steer("steer me");
    await flush();
    const cmd1 = commandFrame(ws);
    const commandId = cmd1.payload.command.commandId;
    const envelope1 = cmd1.id;
    ws.serverClose(1006);
    vi.advanceTimersByTime(250);
    ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ack());
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1", epoch: "e1", resumeStatus: "snapshot" }) });
    await flush();
    const cmd2 = commandFrame(ws);
    expect(cmd2.payload.command.commandId).toBe(commandId);
    expect(cmd2.id).not.toBe(envelope1);
    respondOk(ws, cmd2.id, cmd2.payload.command.commandId, "steer");
    await expect(p).resolves.toBeTruthy();
  });

  it("epoch_changed NEVER re-sends the queued turn; rejects as ambiguous", async () => {
    const h = createHarness();
    let ws = await attachWithCaps(h, ["runtime.steer"]);
    const p = h.store.steer("steer me");
    await flush();
    const cmd1 = commandFrame(ws);
    const commandId = cmd1.payload.command.commandId;
    ws.serverClose(1006);
    vi.advanceTimersByTime(250);
    ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ack());
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1", epoch: "e2", resumeStatus: "epoch_changed" }) });
    await flush();
    await expect(p).rejects.toMatchObject({ code: "epoch_changed" });
    expect(h.store.getSnapshot().queuedTurnPending).toBe(false);
    // Only ONE steer envelope was ever sent (the resend never happened).
    const steers = h.sockets.flatMap((sock) => sock.sent).filter((f) => (f as { type: string; payload?: { command?: { type?: string } } }).type === "command" && (f as { payload?: { command?: { type?: string } } }).payload?.command?.type === "steer");
    expect(steers.length).toBe(1);
    expect(commandId).toBeTruthy();
  });

  it("stop settles the in-flight queued turn", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.steer"]);
    const p = h.store.steer("steer me");
    await flush();
    const stopP = h.store.stop();
    await flush();
    const stopFrame = lastFrame<{ type: string; id: string }>(ws, "stop")!;
    ws.serverSend({ type: "response", id: stopFrame.id, payload: { ok: true, result: { sessionId: "s1", stopped: true } } });
    await expect(stopP).resolves.toBeUndefined();
    await expect(p).rejects.toMatchObject({ code: "interrupted", message: "session stopped" });
    expect(h.store.getSnapshot().queuedTurnPending).toBe(false);
  });

  it("detach (the AppShell session-switch path: detach-then-open) settles the in-flight queued turn", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.steer"]);
    const p = h.store.steer("steer me");
    await flush();
    const detachP = h.store.detach();
    await flush();
    const detachFrame = lastFrame<{ type: string; id: string }>(ws, "detach")!;
    ws.serverSend({ type: "response", id: detachFrame.id, payload: { ok: true, result: { sessionId: "s1", detached: true } } });
    await expect(detachP).resolves.toBeUndefined();
    await expect(p).rejects.toMatchObject({ code: "interrupted", message: "detached" });
    expect(h.store.getSnapshot().queuedTurnPending).toBe(false);
    // Slot freed: after switching to a new session, a fresh steer goes out.
    const openP = h.store.openSession("s2");
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s2", capabilities: ["runtime.steer"] }) });
    await flush();
    await openP;
    const next = h.store.steer("after switch");
    await flush();
    const cmd2 = commandFrame(ws);
    expect(cmd2.payload.command.message).toBe("after switch");
    respondOk(ws, cmd2.id, cmd2.payload.command.commandId, "steer");
    await expect(next).resolves.toBeTruthy();
  });

  it("dispose settles the in-flight queued turn", async () => {
    const h = createHarness();
    await attachWithCaps(h, ["runtime.steer"]);
    const p = h.store.steer("steer me");
    await flush();
    h.store.dispose();
    await expect(p).rejects.toMatchObject({ code: "unavailable" });
    expect(h.store.getSnapshot().queuedTurnPending).toBe(false);
  });

  it("steer resolves honestly to unsupported_capability when the runtime gates it", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort"]);
    const p = h.store.steer("steer me");
    await flush();
    const cmd = commandFrame(ws);
    ws.serverSend({ type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: false, type: "steer", error: { code: "unsupported_capability", message: "runtime.steer not available", retryable: false } } } } });
    await expect(p).resolves.toEqual({ commandId: cmd.payload.command.commandId, result: { ok: false, type: "steer", error: { code: "unsupported_capability", message: "runtime.steer not available", retryable: false } } });
    expect(h.store.hasRuntimeCapability("runtime.steer")).toBe(false);
  });

  it("clearQueue sends the clear_queue interrupt and resolves on ok", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.queue"]);
    const p = h.store.clearQueue();
    await flush();
    const intr = lastFrame<{ type: string; id: string; payload: { commandId: string; interrupt: { type: string } } }>(ws, "interrupt")!;
    expect(intr).toBeTruthy();
    expect(intr.payload.interrupt.type).toBe("clear_queue");
    ws.serverSend({ type: "interrupt_result", id: intr.id, payload: { sessionId: "s1", commandId: intr.payload.commandId, interruptType: "clear_queue", result: { ok: true, type: "clear_queue" } } });
    await expect(p).resolves.toEqual({ ok: true, type: "clear_queue" });
  });

  it("abort while clear_queue is in flight is session_busy (typed admission, no串线)", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.queue"]);
    const clearP = h.store.clearQueue();
    await flush();
    // Different interrupt type → session_busy, never coalesced into clear's promise.
    const abortP = h.store.abort();
    await expect(abortP).rejects.toMatchObject({ code: "session_busy", retryable: false });
    const intr = lastFrame<{ type: string; id: string; payload: { commandId: string } }>(ws, "interrupt")!;
    // Only ONE interrupt frame (clear_queue) was sent.
    const interrupts = (ws.sent as { type: string; payload?: { interrupt?: { type?: string } } }[]).filter((f) => f.type === "interrupt");
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0]?.payload?.interrupt?.type).toBe("clear_queue");
    ws.serverSend({ type: "interrupt_result", id: intr.id, payload: { sessionId: "s1", commandId: intr.payload.commandId, interruptType: "clear_queue", result: { ok: true, type: "clear_queue" } } });
    await expect(clearP).resolves.toBeTruthy();
  });

  it("clear_queue while abort is in flight is session_busy; abort regression unchanged", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.queue"]);
    const abortP = h.store.abort();
    await flush();
    const clearP = h.store.clearQueue();
    await expect(clearP).rejects.toMatchObject({ code: "session_busy", retryable: false });
    const intr = lastFrame<{ type: string; id: string; payload: { commandId: string; interrupt: { type: string } } }>(ws, "interrupt")!;
    expect(intr.payload.interrupt.type).toBe("abort");
    ws.serverSend({ type: "interrupt_result", id: intr.id, payload: { sessionId: "s1", commandId: intr.payload.commandId, interruptType: "abort", result: { ok: true, type: "abort" } } });
    await expect(abortP).resolves.toBeTruthy();
  });

  it("concurrent aborts still coalesce to one in-flight interrupt", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort"]);
    const a1 = h.store.abort();
    await flush();
    const a2 = h.store.abort();
    await flush();
    const interrupts = (ws.sent as { type: string }[]).filter((f) => f.type === "interrupt");
    expect(interrupts).toHaveLength(1);
    const intr = lastFrame<{ type: string; id: string; payload: { commandId: string } }>(ws, "interrupt")!;
    ws.serverSend({ type: "interrupt_result", id: intr.id, payload: { sessionId: "s1", commandId: intr.payload.commandId, interruptType: "abort", result: { ok: true, type: "abort" } } });
    await expect(a1).resolves.toBeTruthy();
    await expect(a2).resolves.toBeTruthy();
  });

  it("interrupt result with wrong commandId / interruptType is dropped (triple match), legit frame resolves", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.queue"]);
    const p = h.store.clearQueue();
    await flush();
    const intr = lastFrame<{ type: string; id: string; payload: { commandId: string; interrupt: { type: string } } }>(ws, "interrupt")!;
    // Wrong commandId on the right envelope.
    ws.serverSend({ type: "interrupt_result", id: intr.id, payload: { sessionId: "s1", commandId: "other-cmd", interruptType: "clear_queue", result: { ok: true, type: "clear_queue" } } });
    await flush();
    let settled = false;
    void p.then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    // Right envelope + commandId but WRONG interrupt type.
    ws.serverSend({ type: "interrupt_result", id: intr.id, payload: { sessionId: "s1", commandId: intr.payload.commandId, interruptType: "abort", result: { ok: true, type: "abort" } } });
    await flush();
    void p.then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    // Legit triple-matched frame resolves exactly once.
    ws.serverSend({ type: "interrupt_result", id: intr.id, payload: { sessionId: "s1", commandId: intr.payload.commandId, interruptType: "clear_queue", result: { ok: true, type: "clear_queue" } } });
    await expect(p).resolves.toEqual({ ok: true, type: "clear_queue" });
  });
});

describe("SessionStore — D2-P5 bash runtime control (runBash / abortBash)", () => {
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

  function bashFrame(ws: FakeWebSocket): { id: string; payload: { command: { commandId: string; type: string; command: string; excludeFromContext?: boolean } } } {
    const frame = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; command: string; excludeFromContext?: boolean } } }>(ws, "command")!;
    expect(frame).toBeTruthy();
    expect(frame.payload.command.type).toBe("bash");
    return frame;
  }

  function respondOk(ws: FakeWebSocket, id: string, commandId: string, type: string): void {
    ws.serverSend({ type: "response", id, payload: { ok: true, result: { commandId, result: { ok: true, type } } } });
  }

  it("runBash sends an exact bash command on the ordinary command slot and resolves on ok", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.bash", "runtime.bash.abort"]);
    const p = h.store.runBash("  echo hello  ", { excludeFromContext: true });
    await flush();
    const cmd = bashFrame(ws);
    expect(cmd.payload.command.command).toBe("echo hello");
    expect(cmd.payload.command.excludeFromContext).toBe(true);
    expect(cmd.payload.command.commandId).toBeTruthy();
    respondOk(ws, cmd.id, cmd.payload.command.commandId, "bash");
    await expect(p).resolves.toBeUndefined();
    // Slot freed: a follow-up bash can go out.
    const next = h.store.runBash("echo again");
    await flush();
    const cmd2 = bashFrame(ws);
    expect(cmd2.payload.command.excludeFromContext).toBeUndefined();
    respondOk(ws, cmd2.id, cmd2.payload.command.commandId, "bash");
    await expect(next).resolves.toBeUndefined();
  });

  it("runBash rejects blank commands without sending (invalid_input)", async () => {
    const h = createHarness();
    await attachWithCaps(h, ["runtime.bash"]);
    await expect(h.store.runBash("   ")).rejects.toMatchObject({ code: "invalid_input", retryable: false });
    await expect(h.store.runBash("\n\t")).rejects.toMatchObject({ code: "invalid_input", retryable: false });
    const frames = h.lastSocket().sent.filter((f) => (f as { type: string }).type === "command");
    expect(frames).toHaveLength(0);
  });

  it("second ordinary command while a bash is pending is session_busy and never overwrites the bash waiter", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.bash"]);
    const bashP = h.store.runBash("sleep 5");
    await flush();
    // A second bash is session_busy; a prompt is ALSO an ordinary command → session_busy.
    const secondBash = h.store.runBash("second");
    await expect(secondBash).rejects.toMatchObject({ code: "session_busy", retryable: false });
    const promptDuringBash = h.store.sendPrompt("hello");
    await expect(promptDuringBash).rejects.toMatchObject({ code: "session_busy", retryable: false });
    await flush();
    const frames = (ws.sent as { type: string; payload?: { command?: { type?: string; command?: string } } }[]).filter((f) => f.type === "command");
    // Only ONE ordinary command frame was sent (the first bash) — no overwrite.
    expect(frames).toHaveLength(1);
    const cmd = bashFrame(ws);
    expect(cmd.payload.command.command).toBe("sleep 5");
    respondOk(ws, cmd.id, cmd.payload.command.commandId, "bash");
    await expect(bashP).resolves.toBeUndefined();
  });

  it("runBash while a prompt is pending is session_busy (bash never overwrites prompt state)", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.bash"]);
    const promptP = h.store.sendPrompt("long running prompt");
    await flush();
    const bashP = h.store.runBash("echo x");
    await expect(bashP).rejects.toMatchObject({ code: "session_busy", retryable: false });
    const promptCmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; message: string } } }>(ws, "command")!;
    expect(promptCmd.payload.command.type).toBe("prompt");
    respondOk(ws, promptCmd.id, promptCmd.payload.command.commandId, "prompt");
    await expect(promptP).resolves.toBeTruthy();
    // Prompt slot freed: a bash can now go out and must not be a hung promise.
    const nextBash = h.store.runBash("echo after prompt");
    await flush();
    const bashCmd = bashFrame(ws);
    respondOk(ws, bashCmd.id, bashCmd.payload.command.commandId, "bash");
    await expect(nextBash).resolves.toBeUndefined();
  });

  it("abortBash sends the abort_bash interrupt and resolves on ok (independent of the bash command)", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.bash", "runtime.bash.abort"]);
    // Start a bash command on the ordinary slot; abortBash must still dispatch.
    const bashP = h.store.runBash("sleep 5");
    await flush();
    const abortP = h.store.abortBash();
    await flush();
    const intr = lastFrame<{ type: string; id: string; payload: { commandId: string; interrupt: { type: string } } }>(ws, "interrupt")!;
    expect(intr).toBeTruthy();
    expect(intr.payload.interrupt.type).toBe("abort_bash");
    ws.serverSend({ type: "interrupt_result", id: intr.id, payload: { sessionId: "s1", commandId: intr.payload.commandId, interruptType: "abort_bash", result: { ok: true, type: "abort_bash" } } });
    await expect(abortP).resolves.toEqual({ ok: true, type: "abort_bash" });
    // The bash command promise stays pending until its own correlated result.
    let settled = false;
    void bashP.then(() => { settled = true; }, () => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    const cmd = bashFrame(ws);
    ws.serverSend({ type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: false, type: "bash", error: { code: "interrupted", message: "bash aborted", retryable: true } } } } });
    await expect(bashP).rejects.toMatchObject({ code: "interrupted" });
  });

  it("abortBash while another interrupt type is in flight is session_busy (typed admission)", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.bash.abort"]);
    const abortP = h.store.abort();
    await flush();
    const bashAbortP = h.store.abortBash();
    await expect(bashAbortP).rejects.toMatchObject({ code: "session_busy", retryable: false });
    const intr = lastFrame<{ type: string; id: string; payload: { commandId: string; interrupt: { type: string } } }>(ws, "interrupt")!;
    expect(intr.payload.interrupt.type).toBe("abort");
    const interrupts = (ws.sent as { type: string; payload?: { interrupt?: { type?: string } } }[]).filter((f) => f.type === "interrupt");
    expect(interrupts).toHaveLength(1);
    ws.serverSend({ type: "interrupt_result", id: intr.id, payload: { sessionId: "s1", commandId: intr.payload.commandId, interruptType: "abort", result: { ok: true, type: "abort" } } });
    await expect(abortP).resolves.toBeTruthy();
  });

  it("abort while abort_bash is in flight is session_busy; concurrent abort_bash coalesces", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.bash.abort"]);
    const a1 = h.store.abortBash();
    await flush();
    const abortP = h.store.abort();
    await expect(abortP).rejects.toMatchObject({ code: "session_busy", retryable: false });
    const a2 = h.store.abortBash();
    await flush();
    const interrupts = (ws.sent as { type: string; payload?: { interrupt?: { type?: string } } }[]).filter((f) => f.type === "interrupt");
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0]?.payload?.interrupt?.type).toBe("abort_bash");
    const intr = lastFrame<{ type: string; id: string; payload: { commandId: string } }>(ws, "interrupt")!;
    ws.serverSend({ type: "interrupt_result", id: intr.id, payload: { sessionId: "s1", commandId: intr.payload.commandId, interruptType: "abort_bash", result: { ok: true, type: "abort_bash" } } });
    await expect(a1).resolves.toBeTruthy();
    await expect(a2).resolves.toBeTruthy();
  });

  it("wrong commandId / interruptType abort_bash result is dropped (triple match)", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.bash.abort"]);
    const p = h.store.abortBash();
    await flush();
    const intr = lastFrame<{ type: string; id: string; payload: { commandId: string } }>(ws, "interrupt")!;
    ws.serverSend({ type: "interrupt_result", id: intr.id, payload: { sessionId: "s1", commandId: "wrong", interruptType: "abort_bash", result: { ok: true, type: "abort_bash" } } });
    await flush();
    let settled = false;
    void p.then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    ws.serverSend({ type: "interrupt_result", id: intr.id, payload: { sessionId: "s1", commandId: intr.payload.commandId, interruptType: "abort", result: { ok: true, type: "abort" } } });
    await flush();
    void p.then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    ws.serverSend({ type: "interrupt_result", id: intr.id, payload: { sessionId: "s1", commandId: intr.payload.commandId, interruptType: "abort_bash", result: { ok: true, type: "abort_bash" } } });
    await expect(p).resolves.toEqual({ ok: true, type: "abort_bash" });
  });

  it("stop / detach / dispose settle an in-flight bash command exactly once", async () => {
    // stop
    const h1 = createHarness();
    const ws1 = await attachWithCaps(h1, ["runtime.prompt", "runtime.abort", "runtime.bash"]);
    const bashP1 = h1.store.runBash("sleep 5");
    await flush();
    const stopP = h1.store.stop();
    await flush();
    const stopFrame = lastFrame<{ type: string; id: string }>(ws1, "stop")!;
    ws1.serverSend({ type: "response", id: stopFrame.id, payload: { ok: true, result: { sessionId: "s1", stopped: true } } });
    await expect(stopP).resolves.toBeUndefined();
    await expect(bashP1).rejects.toMatchObject({ code: "interrupted", message: "session stopped" });

    // detach
    const h2 = createHarness();
    const ws2 = await attachWithCaps(h2, ["runtime.bash"]);
    const bashP2 = h2.store.runBash("sleep 5");
    await flush();
    const detachP = h2.store.detach();
    await flush();
    const detachFrame = lastFrame<{ type: string; id: string }>(ws2, "detach")!;
    ws2.serverSend({ type: "response", id: detachFrame.id, payload: { ok: true, result: { sessionId: "s1", detached: true } } });
    await expect(detachP).resolves.toBeUndefined();
    await expect(bashP2).rejects.toMatchObject({ code: "interrupted", message: "detached" });

    // dispose
    const h3 = createHarness();
    await attachWithCaps(h3, ["runtime.bash"]);
    const bashP3 = h3.store.runBash("sleep 5");
    await flush();
    h3.store.dispose();
    await expect(bashP3).rejects.toMatchObject({ code: "unavailable" });
  });

  it("session switch (detach-then-open) rejects a pending bash exactly once; a late result cannot settle the new session", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.bash"], "s1");
    const bashP = h.store.runBash("sleep 5");
    await flush();
    const bashCmd = bashFrame(ws);
    const oldEnvelope = bashCmd.id;
    // AppShell switch path: detach the live session (Worker preserved) — the
    // pending bash bound to s1 is rejected exactly once.
    const detachP = h.store.detach();
    await flush();
    const detachFrame = lastFrame<{ type: string; id: string }>(ws, "detach")!;
    ws.serverSend({ type: "response", id: detachFrame.id, payload: { ok: true, result: { sessionId: "s1", detached: true } } });
    await flush();
    await expect(bashP).rejects.toMatchObject({ code: "interrupted", message: "detached" });
    await detachP;
    // A late response for the OLD bash envelope is dropped — it must not settle
    // anything (the pendingCommand slot is already cleared).
    ws.serverSend({ type: "response", id: oldEnvelope, payload: { ok: true, result: { commandId: bashCmd.payload.command.commandId, result: { ok: true, type: "bash" } } } });
    await flush();
    // Open the new session; the ordinary slot is free → a fresh bash goes out.
    const openP = h.store.openSession("s2");
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s2", capabilities: ["runtime.bash"] }) });
    await flush();
    await openP;
    const next = h.store.runBash("echo new session");
    await flush();
    const cmd2 = bashFrame(ws);
    expect(cmd2.payload.command.command).toBe("echo new session");
    respondOk(ws, cmd2.id, cmd2.payload.command.commandId, "bash");
    await expect(next).resolves.toBeUndefined();
  });

  it("runBash resolves honestly to unsupported_capability when the runtime gates it", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort"]);
    const p = h.store.runBash("echo x");
    await flush();
    const cmd = bashFrame(ws);
    ws.serverSend({ type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: false, type: "bash", error: { code: "unsupported_capability", message: "runtime.bash not available", retryable: false } } } } });
    await expect(p).rejects.toMatchObject({ code: "unsupported_capability" });
    expect(h.store.hasRuntimeCapability("runtime.bash")).toBe(false);
  });

  it("bash_update events project exact accumulated output into snapshot.state.bash", async () => {
    const h = createHarness();
    await attachWithCaps(h, ["runtime.bash"]);
    wsEvent(h, { type: "bash_update", sessionId: "s1", eventId: 1, epoch: "e1", command: "echo hi", output: "line 1\n" });
    wsEvent(h, { type: "bash_update", sessionId: "s1", eventId: 2, epoch: "e1", command: "echo hi", output: "line 2\n" });
    wsEvent(h, { type: "bash_update", sessionId: "s1", eventId: 3, epoch: "e1", command: "echo hi", exitCode: 0, truncated: false });
    const state = h.store.getSnapshot().snapshot!.state;
    expect(state.bash?.output).toBe("line 1\nline 2\n");
    expect(state.bash?.exitCode).toBe(0);
    expect(state.bash?.completed).toBe(true);
    expect(state.bash?.command).toBe("echo hi");
    expect(state.isBashRunning).toBe(false);
    expect(h.store.getSnapshot().streaming).toBe(false);
  });
});

describe("SessionStore — D2-P7 compact runtime control (compact / abortCompaction)", () => {
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

  function compactFrame(ws: FakeWebSocket): { id: string; payload: { command: { commandId: string; type: string; customInstructions?: string } } } {
    const frame = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; customInstructions?: string } } }>(ws, "command")!;
    expect(frame).toBeTruthy();
    expect(frame.payload.command.type).toBe("compact");
    return frame;
  }

  function respondOk(ws: FakeWebSocket, id: string, commandId: string, type: string): void {
    ws.serverSend({ type: "response", id, payload: { ok: true, result: { commandId, result: { ok: true, type } } } });
  }

  it("compact sends an exact compact command on the ordinary slot and resolves on ok", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.compact", "runtime.compact.abort"]);
    const p = h.store.compact("keep decisions");
    await flush();
    const cmd = compactFrame(ws);
    expect(cmd.payload.command.customInstructions).toBe("keep decisions");
    expect(cmd.payload.command.commandId).toBeTruthy();
    respondOk(ws, cmd.id, cmd.payload.command.commandId, "compact");
    await expect(p).resolves.toBeUndefined();
    // Slot freed: a follow-up compact can go out.
    const next = h.store.compact();
    await flush();
    const cmd2 = compactFrame(ws);
    expect(cmd2.payload.command.customInstructions).toBeUndefined();
    respondOk(ws, cmd2.id, cmd2.payload.command.commandId, "compact");
    await expect(next).resolves.toBeUndefined();
  });

  it("compact forwards customInstructions exactly (no silent trim/reinterpret)", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.compact"]);
    const custom = "  keep decisions  \n  and notes  ";
    const p = h.store.compact(custom);
    await flush();
    const cmd = compactFrame(ws);
    expect(cmd.payload.command.customInstructions).toBe(custom);
    respondOk(ws, cmd.id, cmd.payload.command.commandId, "compact");
    await expect(p).resolves.toBeUndefined();
  });

  it("compact rejects blank customInstructions without sending (invalid_input)", async () => {
    const h = createHarness();
    await attachWithCaps(h, ["runtime.compact"]);
    await expect(h.store.compact("   ")).rejects.toMatchObject({ code: "invalid_input", retryable: false });
    await expect(h.store.compact("\n\t")).rejects.toMatchObject({ code: "invalid_input", retryable: false });
    const frames = h.lastSocket().sent.filter((f) => (f as { type: string }).type === "command");
    expect(frames).toHaveLength(0);
  });

  it("second ordinary command while a compact is pending is session_busy and never overwrites the compact waiter", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.compact", "runtime.tools.write", "runtime.reload"]);
    const compactP = h.store.compact("keep");
    await flush();
    const secondCompact = h.store.compact("again");
    await expect(secondCompact).rejects.toMatchObject({ code: "session_busy", retryable: false });
    const promptDuringCompact = h.store.sendPrompt("hello");
    await expect(promptDuringCompact).rejects.toMatchObject({ code: "session_busy", retryable: false });
    const setToolsDuringCompact = h.store.setTools(["read"]);
    await expect(setToolsDuringCompact).rejects.toMatchObject({ code: "session_busy", retryable: false });
    const reloadDuringCompact = h.store.reload();
    await expect(reloadDuringCompact).rejects.toMatchObject({ code: "session_busy", retryable: false });
    await flush();
    const frames = (ws.sent as { type: string; payload?: { command?: { type?: string } } }[]).filter((f) => f.type === "command");
    expect(frames).toHaveLength(1);
    const cmd = compactFrame(ws);
    expect(cmd.payload.command.customInstructions).toBe("keep");
    respondOk(ws, cmd.id, cmd.payload.command.commandId, "compact");
    await expect(compactP).resolves.toBeUndefined();
  });

  it("compact while a prompt is pending is session_busy (compact never overwrites prompt state)", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.compact"]);
    const promptP = h.store.sendPrompt("long running prompt");
    await flush();
    const compactP = h.store.compact();
    await expect(compactP).rejects.toMatchObject({ code: "session_busy", retryable: false });
    const promptCmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; message: string } } }>(ws, "command")!;
    expect(promptCmd.payload.command.type).toBe("prompt");
    respondOk(ws, promptCmd.id, promptCmd.payload.command.commandId, "prompt");
    await expect(promptP).resolves.toBeTruthy();
  });

  it("abortCompaction sends the abort_compaction interrupt and resolves on ok (independent of the compact command)", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.compact", "runtime.compact.abort"]);
    const compactP = h.store.compact("keep");
    await flush();
    const abortP = h.store.abortCompaction();
    await flush();
    const intr = lastFrame<{ type: string; id: string; payload: { commandId: string; interrupt: { type: string } } }>(ws, "interrupt")!;
    expect(intr).toBeTruthy();
    expect(intr.payload.interrupt.type).toBe("abort_compaction");
    ws.serverSend({ type: "interrupt_result", id: intr.id, payload: { sessionId: "s1", commandId: intr.payload.commandId, interruptType: "abort_compaction", result: { ok: true, type: "abort_compaction" } } });
    await expect(abortP).resolves.toEqual({ ok: true, type: "abort_compaction" });
    // The compact command promise stays pending until its own correlated result.
    let settled = false;
    void compactP.then(() => { settled = true; }, () => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    const cmd = compactFrame(ws);
    ws.serverSend({ type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: false, type: "compact", error: { code: "interrupted", message: "compaction aborted", retryable: true } } } } });
    await expect(compactP).rejects.toMatchObject({ code: "interrupted" });
  });

  it("abortCompaction while another interrupt type is in flight is session_busy; same-type coalesces", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.compact.abort"]);
    // Different in-flight type (abort): abortCompaction is session_busy.
    const abortP = h.store.abort();
    await flush();
    const compactAbortP = h.store.abortCompaction();
    await expect(compactAbortP).rejects.toMatchObject({ code: "session_busy", retryable: false });
    await flush();
    const interrupts = (ws.sent as { type: string; payload?: { interrupt?: { type?: string } } }[]).filter((f) => f.type === "interrupt");
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0]?.payload?.interrupt?.type).toBe("abort");
    const intr = lastFrame<{ type: string; id: string; payload: { commandId: string } }>(ws, "interrupt")!;
    ws.serverSend({ type: "interrupt_result", id: intr.id, payload: { sessionId: "s1", commandId: intr.payload.commandId, interruptType: "abort", result: { ok: true, type: "abort" } } });
    await expect(abortP).resolves.toBeTruthy();

    // Same type in flight (abort_compaction): the second abortCompaction
    // COALESCES to the same promise — exactly one abort_compaction frame.
    const c1 = h.store.abortCompaction();
    await flush();
    const c2 = h.store.abortCompaction();
    await flush();
    const compactInterrupts = (ws.sent as { type: string; payload?: { interrupt?: { type?: string } } }[]).filter((f) => f.type === "interrupt");
    expect(compactInterrupts).toHaveLength(2);
    expect(compactInterrupts[1]?.payload?.interrupt?.type).toBe("abort_compaction");
    const cIntr = lastFrame<{ type: string; id: string; payload: { commandId: string } }>(ws, "interrupt")!;
    ws.serverSend({ type: "interrupt_result", id: cIntr.id, payload: { sessionId: "s1", commandId: cIntr.payload.commandId, interruptType: "abort_compaction", result: { ok: true, type: "abort_compaction" } } });
    await expect(c1).resolves.toEqual({ ok: true, type: "abort_compaction" });
    await expect(c2).resolves.toEqual({ ok: true, type: "abort_compaction" });
  });

  it("wrong commandId / interruptType abort_compaction result is dropped (triple match)", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.compact.abort"]);
    const p = h.store.abortCompaction();
    await flush();
    const intr = lastFrame<{ type: string; id: string; payload: { commandId: string } }>(ws, "interrupt")!;
    ws.serverSend({ type: "interrupt_result", id: intr.id, payload: { sessionId: "s1", commandId: "wrong", interruptType: "abort_compaction", result: { ok: true, type: "abort_compaction" } } });
    await flush();
    let settled = false;
    void p.then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    ws.serverSend({ type: "interrupt_result", id: intr.id, payload: { sessionId: "s1", commandId: intr.payload.commandId, interruptType: "abort", result: { ok: true, type: "abort" } } });
    await flush();
    void p.then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    ws.serverSend({ type: "interrupt_result", id: intr.id, payload: { sessionId: "s1", commandId: intr.payload.commandId, interruptType: "abort_compaction", result: { ok: true, type: "abort_compaction" } } });
    await expect(p).resolves.toEqual({ ok: true, type: "abort_compaction" });
  });

  it("stop / detach / dispose settle an in-flight compact command exactly once", async () => {
    // stop
    const h1 = createHarness();
    const ws1 = await attachWithCaps(h1, ["runtime.compact"]);
    const compactP1 = h1.store.compact("keep");
    await flush();
    const stopP = h1.store.stop();
    await flush();
    const stopFrame = lastFrame<{ type: string; id: string }>(ws1, "stop")!;
    ws1.serverSend({ type: "response", id: stopFrame.id, payload: { ok: true, result: { sessionId: "s1", stopped: true } } });
    await expect(stopP).resolves.toBeUndefined();
    await expect(compactP1).rejects.toMatchObject({ code: "interrupted", message: "session stopped" });

    // detach
    const h2 = createHarness();
    const ws2 = await attachWithCaps(h2, ["runtime.compact"]);
    const compactP2 = h2.store.compact("keep");
    await flush();
    const detachP = h2.store.detach();
    await flush();
    const detachFrame = lastFrame<{ type: string; id: string }>(ws2, "detach")!;
    ws2.serverSend({ type: "response", id: detachFrame.id, payload: { ok: true, result: { sessionId: "s1", detached: true } } });
    await expect(detachP).resolves.toBeUndefined();
    await expect(compactP2).rejects.toMatchObject({ code: "interrupted", message: "detached" });

    // dispose
    const h3 = createHarness();
    await attachWithCaps(h3, ["runtime.compact"]);
    const compactP3 = h3.store.compact("keep");
    await flush();
    h3.store.dispose();
    await expect(compactP3).rejects.toMatchObject({ code: "unavailable" });
  });

  it("session switch (detach-then-open) rejects a pending compact exactly once; a late result cannot settle the new session", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.compact"], "s1");
    const compactP = h.store.compact("keep");
    await flush();
    const compactCmd = compactFrame(ws);
    const oldEnvelope = compactCmd.id;
    const detachP = h.store.detach();
    await flush();
    const detachFrame = lastFrame<{ type: string; id: string }>(ws, "detach")!;
    ws.serverSend({ type: "response", id: detachFrame.id, payload: { ok: true, result: { sessionId: "s1", detached: true } } });
    await flush();
    await expect(compactP).rejects.toMatchObject({ code: "interrupted", message: "detached" });
    await detachP;
    // A late response for the OLD compact envelope is dropped.
    ws.serverSend({ type: "response", id: oldEnvelope, payload: { ok: true, result: { commandId: compactCmd.payload.command.commandId, result: { ok: true, type: "compact" } } } });
    await flush();
    const openP = h.store.openSession("s2");
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s2", capabilities: ["runtime.compact"] }) });
    await flush();
    await openP;
    const next = h.store.compact();
    await flush();
    const cmd2 = compactFrame(ws);
    respondOk(ws, cmd2.id, cmd2.payload.command.commandId, "compact");
    await expect(next).resolves.toBeUndefined();
  });

  it("compact resolves honestly to unsupported_capability when the runtime gates it", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort"]);
    const p = h.store.compact("keep");
    await flush();
    const cmd = compactFrame(ws);
    ws.serverSend({ type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: false, type: "compact", error: { code: "unsupported_capability", message: "runtime.compact not available", retryable: false } } } } });
    await expect(p).rejects.toMatchObject({ code: "unsupported_capability" });
    expect(h.store.hasRuntimeCapability("runtime.compact")).toBe(false);
  });

  it("compact and abortCompaction reject when not attached", async () => {
    const h = createHarness();
    await expect(h.store.compact()).rejects.toThrow();
    await expect(h.store.abortCompaction()).rejects.toThrow();
  });

  it("compaction events project into the snapshot (start sets isCompacting, end clears; messageCount stays authoritative)", async () => {
    const h = createHarness();
    await attachWithCaps(h, ["runtime.compact"]);
    wsEvent(h, { type: "compaction_start", sessionId: "s1", eventId: 1, epoch: "e1", reason: "manual" });
    expect(h.store.getSnapshot().snapshot!.state.isCompacting).toBe(true);
    expect(h.store.getSnapshot().snapshot!.state.compaction?.status).toBe("running");
    wsEvent(h, { type: "compaction_end", sessionId: "s1", eventId: 2, epoch: "e1", reason: "manual", aborted: false });
    expect(h.store.getSnapshot().snapshot!.state.isCompacting).toBe(false);
    expect(h.store.getSnapshot().snapshot!.state.compaction).toBeUndefined();
    expect(h.store.getSnapshot().streaming).toBe(false);
  });
});

describe("SessionStore — F9 read-only query cleanup on detach / session switch", () => {
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

  function statsFrame(ws: FakeWebSocket): { id: string; payload: { sessionId: string; command: { commandId: string; type: string } } } {
    const frame = lastFrame<{ type: string; id: string; payload: { sessionId: string; command: { commandId: string; type: string } } }>(ws, "command")!;
    expect(frame).toBeTruthy();
    expect(frame.payload.command.type).toBe("get_session_stats");
    return frame;
  }

  function promptFrame(ws: FakeWebSocket): { id: string; payload: { sessionId: string; command: { commandId: string; type: string; message: string } } } {
    const frame = lastFrame<{ type: string; id: string; payload: { sessionId: string; command: { commandId: string; type: string; message: string } } }>(ws, "command")!;
    expect(frame).toBeTruthy();
    expect(frame.payload.command.type).toBe("prompt");
    return frame;
  }

  function respondOk(ws: FakeWebSocket, id: string, commandId: string, type: string): void {
    ws.serverSend({ type: "response", id, payload: { ok: true, result: { commandId, result: { ok: true, type } } } });
  }

  /** Detach s1 (AppShell switch path: detach-then-open) and ack the detach. */
  async function detachAck(ws: FakeWebSocket, h: RuntimeHarness): Promise<void> {
    const detachP = h.store.detach();
    await flush();
    const detachFrame = lastFrame<{ type: string; id: string }>(ws, "detach")!;
    ws.serverSend({ type: "response", id: detachFrame.id, payload: { ok: true, result: { sessionId: "s1", detached: true } } });
    await expect(detachP).resolves.toBeUndefined();
  }

  /** Open s2 with the SAME epoch so a stale resync would (if not settled) re-send the old commandId. */
  async function openNewSession(ws: FakeWebSocket, h: RuntimeHarness, capabilities: string[], sessionId = "s2"): Promise<void> {
    const openP = h.store.openSession(sessionId);
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId, epoch: "e1", capabilities }) });
    await flush();
    await openP;
  }

  it("detach settles a pending get_session_stats exactly once and frees the ordinary slot", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.stats"], "s1");
    const statsP = h.store.getSessionStats();
    await flush();
    const statsCmd = statsFrame(ws);
    expect(statsCmd.payload.sessionId).toBe("s1");

    await detachAck(ws, h);
    // The pending stats query bound to the detached session is rejected once.
    await expect(statsP).rejects.toMatchObject({ code: "interrupted", message: "detached", retryable: false });

    // A late ack for the OLD stats envelope is dropped — it must settle nothing.
    ws.serverSend({ type: "response", id: statsCmd.id, payload: { ok: true, result: { commandId: statsCmd.payload.command.commandId, result: { ok: true, type: "get_session_stats", stats: { messageCount: 99, tokenCount: 999 } } } } });
    await flush();
    expect(h.store.getSnapshot().error).toBeNull();

    // The ordinary slot is free: a fresh command goes out on the new session.
    await openNewSession(ws, h, ["runtime.prompt", "runtime.abort"]);
    const promptP = h.store.sendPrompt("hello new session");
    await flush();
    const cmd = promptFrame(ws);
    expect(cmd.payload.sessionId).toBe("s2");
    expect(cmd.payload.command.commandId).not.toBe(statsCmd.payload.command.commandId);
    respondOk(ws, cmd.id, cmd.payload.command.commandId, "prompt");
    await expect(promptP).resolves.toBeTruthy();
  });

  it("session switch never re-sends the OLD get_session_stats commandId/sessionId; the new prompt is not session_busy", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.stats"], "s1");
    const statsP = h.store.getSessionStats();
    statsP.catch(() => undefined);
    await flush();
    const statsCmd = statsFrame(ws);
    const oldEnvelope = statsCmd.id;
    const oldCommandId = statsCmd.payload.command.commandId;

    // AppShell switch path: detach s1, then open s2 (same epoch — the same
    // resync that used to re-send the OLD sessionId+commandId onto the new attach).
    await detachAck(ws, h);
    await expect(statsP).rejects.toMatchObject({ code: "interrupted", message: "detached", retryable: false });
    await openNewSession(ws, h, ["runtime.prompt", "runtime.abort", "runtime.stats"]);

    // No command was resent carrying the old commandId / old sessionId.
    const resent = (ws.sent as { type: string; id?: string; payload?: { sessionId?: string; command?: { commandId?: string } } }[]).filter(
      (frame) => frame.type === "command" && frame.id !== oldEnvelope && frame.payload?.command?.commandId === oldCommandId,
    );
    expect(resent).toHaveLength(0);

    // The new session's prompt sends immediately — never session_busy.
    const promptP = h.store.sendPrompt("first prompt on s2");
    await flush();
    const cmd = promptFrame(ws);
    expect(cmd.payload.sessionId).toBe("s2");
    respondOk(ws, cmd.id, cmd.payload.command.commandId, "prompt");
    await expect(promptP).resolves.toBeTruthy();
  });

  it("a late OLD stats ack never settles or pollutes the new session's prompt", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.stats"], "s1");
    const statsP = h.store.getSessionStats();
    statsP.catch(() => undefined);
    await flush();
    const statsCmd = statsFrame(ws);
    const oldEnvelope = statsCmd.id;
    const oldCommandId = statsCmd.payload.command.commandId;

    await detachAck(ws, h);
    await expect(statsP).rejects.toMatchObject({ code: "interrupted", message: "detached" });
    await openNewSession(ws, h, ["runtime.prompt", "runtime.abort"]);

    const promptP = h.store.sendPrompt("hi");
    await flush();
    const promptCmd = promptFrame(ws);

    // Deliver the OLD stats ack while the new prompt is in flight: it is
    // dropped (wrong envelope), so the prompt must still be pending.
    ws.serverSend({ type: "response", id: oldEnvelope, payload: { ok: true, result: { commandId: oldCommandId, result: { ok: true, type: "get_session_stats", stats: { messageCount: 77, tokenCount: 777 } } } } });
    await flush();
    let settled = false;
    promptP.then(() => { settled = true; }, () => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    expect(h.store.getSnapshot().error).toBeNull();

    // Only the prompt's OWN correlated ack settles it.
    respondOk(ws, promptCmd.id, promptCmd.payload.command.commandId, "prompt");
    await expect(promptP).resolves.toBeTruthy();
  });

  it.each([
    ["getState", "get_state"],
    ["getTools", "get_tools"],
    ["getCommands", "get_commands"],
    ["getLastAssistantText", "get_last_assistant_text"],
  ] as const)("detach/switch settle a pending %s query and free the slot (table-driven)", async (_helper, type) => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort", "runtime.stats", "runtime.tools.read"], "s1");
    const helper = (): Promise<unknown> => {
      if (_helper === "getState") return h.store.getState();
      if (_helper === "getTools") return h.store.getTools();
      if (_helper === "getCommands") return h.store.getCommands();
      return h.store.getLastAssistantText();
    };
    const p = helper();
    p.catch(() => undefined);
    await flush();
    const frame = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string } } }>(ws, "command")!;
    expect(frame.payload.command.type).toBe(type);

    await detachAck(ws, h);
    await expect(p).rejects.toMatchObject({ code: "interrupted", message: "detached", retryable: false });
    await openNewSession(ws, h, ["runtime.prompt", "runtime.abort"]);
    // Slot freed: a fresh query on the new session sends immediately.
    const freshP = h.store.getCommands();
    await flush();
    const fresh = lastFrame<{ type: string; id: string; payload: { sessionId: string; command: { commandId: string; type: string } } }>(ws, "command")!;
    expect(fresh.payload.sessionId).toBe("s2");
    expect(fresh.payload.command.type).toBe("get_commands");
    ws.serverSend({ type: "response", id: fresh.id, payload: { ok: true, result: { commandId: fresh.payload.command.commandId, result: { ok: true, type: "get_commands", commands: [] } } } });
    await expect(freshP).resolves.toEqual([]);
  });

  it("a pending PROMPT is NOT settled by detach (prompt promise semantics untouched)", async () => {
    const h = createHarness();
    const ws = await attachWithCaps(h, ["runtime.prompt", "runtime.abort"], "s1");
    const promptP = h.store.sendPrompt("hello");
    await flush();
    const promptCmd = promptFrame(ws);

    await detachAck(ws, h);
    // The prompt is still pending — detach/settlePendingControlCommand never
    // touches a prompt promise. It settles only on its own correlated response.
    let settled = false;
    promptP.then(() => { settled = true; }, () => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    respondOk(ws, promptCmd.id, promptCmd.payload.command.commandId, "prompt");
    await expect(promptP).resolves.toBeTruthy();
  });
});

function wsEvent(h: RuntimeHarness, payload: Record<string, unknown>): void {
  h.lastSocket().serverSend({ type: "event", payload });
}
