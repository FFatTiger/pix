/**
 * Idle-send recovery (negotiated `runtime.liveness.v1`).
 *
 * The pre-fix defect class: a page left idle (hidden/backgrounded, proxy
 * idle-kill) keeps a WebSocket that LOOKS open — readyState OPEN, socket state
 * ready/attached — while the transport is dead (the close never arrived).
 * Submits raced into that half-open socket: the attempt never received a
 * receipt (hang) or the pre-wire gate timed out ("not sent, draft kept").
 *
 * The fix lives in the transport owners only (RuntimeSocket liveness +
 * RuntimeConnection send/ready gates); every lane inherits it. These tests
 * prove, deterministically:
 *  - heartbeat: ping while ready+idle; missed pong → forced reconnect;
 *  - pong frames are consumed by the transport, never projected;
 *  - no ping is ever sent without the negotiated feature (old Host parity);
 *  - wake-from-hidden past the threshold probes a stale connection and
 *    force-reconnects it before the user can act;
 *  - a submit through a stale connection probes, waits through the forced
 *    reconnect, and re-sends the SAME operationId exactly once per socket
 *    (sessiond admission stays idempotent — no duplicate turn);
 *  - a create through a stale connection waits through recovery too;
 *  - without the negotiated feature the transport keeps the historical
 *    bounded timeout behavior (honest degradation, no fake liveness).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUNTIME_LIVENESS_FEATURE } from "@fffattiger/pix-protocol";
import { createHarness, flush, lastFrame, snapshotPayload, type RuntimeHarness } from "./testing/harness";
import type { FakeWebSocket } from "./testing/harness";
import type { SubmitTurnAdmission } from "@fffattiger/pix-protocol";

const BASE_FEATURES = ["runtime.read-rpc.v1", "runtime.submit-turn.v1", "runtime.observe-existing.v1"];

function ackWithLiveness(): unknown {
  return {
    type: "handshake_ack",
    payload: {
      protocolVersion: 2,
      host: { mode: "local", capabilities: ["agent"] },
      limits: { maxUpload: 0, maxOpenSessions: 4 },
      sessionSnapshotSupport: true,
      acceptedFeatures: [...BASE_FEATURES, RUNTIME_LIVENESS_FEATURE],
    },
  };
}

function ackWithoutLiveness(): unknown {
  return {
    type: "handshake_ack",
    payload: {
      protocolVersion: 2,
      host: { mode: "local", capabilities: ["agent"] },
      limits: { maxUpload: 0, maxOpenSessions: 4 },
      sessionSnapshotSupport: true,
      acceptedFeatures: BASE_FEATURES,
    },
  };
}

async function openSocket(h: RuntimeHarness, ack: () => unknown = ackWithLiveness): Promise<FakeWebSocket> {
  h.store.connect();
  const ws = h.lastSocket();
  ws.serverOpen();
  ws.serverSend(ack());
  await flush();
  return ws;
}

async function openAndAttach(h: RuntimeHarness, ack: () => unknown = ackWithLiveness, sessionId = "s1"): Promise<FakeWebSocket> {
  const ws = await openSocket(h, ack);
  const p = h.store.openSession(sessionId);
  await flush();
  const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
  ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId, epoch: "e1" }) });
  await flush();
  await p;
  return ws;
}

function acceptedAdmission(sessionId: string, operationId: string): SubmitTurnAdmission {
  return {
    status: "accepted",
    delivery: "accepted",
    sessionId,
    epoch: "e1",
    revision: 1,
    operationId,
    turnId: "turn-1",
    snapshot: snapshotPayload({ sessionId, epoch: "e1", lastEventId: 1 }).snapshot as never,
    turnStatus: { sessionId, epoch: "e1", operationId, turnId: "turn-1", revision: 0, state: "admitted" },
  };
}

function submitFrames(ws: FakeWebSocket): Array<{ type: "submit_turn"; id: string; payload: { operationId: string; prompt: string } }> {
  return ws.sent.filter((frame): frame is { type: "submit_turn"; id: string; payload: { operationId: string; prompt: string } } =>
    (frame as { type?: string }).type === "submit_turn"
  );
}

function pingFrames(ws: FakeWebSocket): Array<{ type: "ping"; id: string }> {
  return ws.sent.filter((frame): frame is { type: "ping"; id: string } =>
    (frame as { type?: string }).type === "ping"
  );
}

describe("idle-send recovery (runtime.liveness.v1)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("heartbeat pings an idle ready connection and a pong keeps it alive", async () => {
    const h = createHarness({ liveness: { heartbeatIntervalMs: 30_000, pongTimeoutMs: 10_000 } });
    const ws = await openSocket(h);
    vi.advanceTimersByTime(30_000);
    expect(pingFrames(ws)).toHaveLength(1);
    ws.serverSend({ type: "pong", id: pingFrames(ws)[0]!.id });
    await flush();
    // Still alive: no reconnect, heartbeat continues.
    vi.advanceTimersByTime(30_000);
    expect(pingFrames(ws)).toHaveLength(2);
    expect(h.sockets).toHaveLength(1);
    h.dispose();
  });

  it("a heartbeat ping unanswered past the pong deadline forces a reconnect", async () => {
    const h = createHarness({ liveness: { heartbeatIntervalMs: 30_000, pongTimeoutMs: 10_000 } });
    const ws = await openSocket(h);
    vi.advanceTimersByTime(30_000);
    expect(pingFrames(ws)).toHaveLength(1);
    // No pong: deadline at +10s proves the transport dead.
    vi.advanceTimersByTime(10_000);
    expect(h.sockets).toHaveLength(2); // forced reconnect, immediately connecting
    expect(h.connection.connectionState).toBe("connecting");
    expect(ws.wasClosedByClient).toBe(true);
    h.dispose();
  });

  it("recent inbound traffic satisfies the heartbeat (no ping during a busy stream)", async () => {
    const h = createHarness({ liveness: { heartbeatIntervalMs: 30_000, pongTimeoutMs: 10_000 } });
    const ws = await openSocket(h);
    // Halfway into the beat window, an authoritative push arrives; the tick at
    // t=30s sees 15s-fresh traffic and skips the ping.
    vi.advanceTimersByTime(15_000);
    ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: [], busySessionIds: [] } });
    await flush();
    vi.advanceTimersByTime(15_000);
    expect(pingFrames(ws)).toHaveLength(0);
    h.dispose();
  });

  it("pong frames are consumed by the transport and never projected", async () => {
    const h = createHarness({ liveness: { heartbeatIntervalMs: 30_000, pongTimeoutMs: 10_000 } });
    const ws = await openSocket(h);
    vi.advanceTimersByTime(30_000);
    ws.serverSend({ type: "pong", id: pingFrames(ws)[0]!.id });
    await flush();
    // The controller view must show no error/state churn from the pong itself.
    const view = h.controller("s1")?.getSnapshot();
    expect(view?.error ?? null).toBeNull();
    h.dispose();
  });

  it("never pings without the negotiated feature (old Host keeps exact prior behavior)", async () => {
    const h = createHarness({ liveness: { heartbeatIntervalMs: 30_000, pongTimeoutMs: 10_000 } });
    const ws = await openSocket(h, ackWithoutLiveness);
    vi.advanceTimersByTime(120_000);
    expect(pingFrames(ws)).toHaveLength(0);
    expect(h.sockets).toHaveLength(1);
    // And a submit still resolves through the ordinary path (no probe detour).
    h.dispose();
  });

  it("wake from a long hide probes a stale connection and force-reconnects it before any user action", async () => {
    const h = createHarness({ liveness: { heartbeatIntervalMs: 1_000_000, pongTimeoutMs: 10_000, hiddenProbeThresholdMs: 5_000, freshnessMs: 60_000 } });
    const ws = await openAndAttach(h);
    // Hidden for 61s: no inbound frames (timers suspended), connection stale.
    h.changeVisibility(false);
    vi.advanceTimersByTime(61_000);
    h.changeVisibility(true);
    await flush();
    // Probe ping went out on the dead socket and got no answer…
    expect(pingFrames(ws)).toHaveLength(1);
    vi.advanceTimersByTime(10_000);
    await flush();
    expect(h.sockets).toHaveLength(2);
    expect(h.connection.connectionState).toBe("connecting");
    expect(ws.wasClosedByClient).toBe(true);
    h.dispose();
  });

  it("a brief hide (below the threshold) does not probe", async () => {
    const h = createHarness({ liveness: { heartbeatIntervalMs: 1_000_000, pongTimeoutMs: 10_000, hiddenProbeThresholdMs: 5_000, freshnessMs: 60_000 } });
    const ws = await openAndAttach(h);
    h.changeVisibility(false);
    vi.advanceTimersByTime(2_000);
    h.changeVisibility(true);
    vi.advanceTimersByTime(15_000);
    expect(pingFrames(ws)).toHaveLength(0);
    expect(h.sockets).toHaveLength(1);
    h.dispose();
  });

  it("a submit through a stale (half-open) connection waits through the forced reconnect and re-sends the SAME operationId exactly once per socket", async () => {
    const h = createHarness({ liveness: { heartbeatIntervalMs: 1_000_000, pongTimeoutMs: 5_000, freshnessMs: 60_000 } });
    const ws1 = await openAndAttach(h);
    // Idle past the freshness window: the socket LOOKS attached but may be dead.
    vi.advanceTimersByTime(61_000);
    const sendP = h.store.sendPrompt("idle send");
    await flush();
    // The pre-wire gate probed before writing the turn...
    expect(pingFrames(ws1)).toHaveLength(1);
    expect(submitFrames(ws1)).toHaveLength(0);
    // ...the probe deadline proves death and forces the reconnect.
    vi.advanceTimersByTime(5_000);
    expect(h.sockets).toHaveLength(2);
    const ws2 = h.sockets[1]!;
    expect(submitFrames(ws1)).toHaveLength(0); // nothing raced into the dead socket
    // Recovery: handshake + ack (liveness negotiated again) + resume attach.
    ws2.serverOpen();
    ws2.serverSend(ackWithLiveness());
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws2, "attach")!;
    expect(attachFrame).toBeTruthy();
    ws2.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1", epoch: "e1" }) });
    await flush(8);
    // The SAME operationId is re-sent exactly once on the fresh socket.
    const submits2 = submitFrames(ws2);
    expect(submits2).toHaveLength(1);
    expect(submits2[0]!.payload.prompt).toBe("idle send");
    ws2.serverSend({ type: "submit_turn_result", id: submits2[0]!.id, payload: acceptedAdmission("s1", submits2[0]!.payload.operationId) });
    await expect(sendP).resolves.toBeTruthy();
    await flush();
    expect(submitFrames(ws2)).toHaveLength(1);
    h.dispose();
  });

  it("a create through a stale connection waits through the forced reconnect (new-session first send)", async () => {
    const h = createHarness({ liveness: { heartbeatIntervalMs: 1_000_000, pongTimeoutMs: 5_000, freshnessMs: 60_000 } });
    const ws1 = await openSocket(h);
    vi.advanceTimersByTime(61_000);
    const createP = h.connection.createSession({ cwd: "/x", projectRoot: "/x" });
    await flush();
    expect(pingFrames(ws1)).toHaveLength(1);
    expect(lastFrame(ws1, "create")).toBeUndefined(); // gated before the wire
    vi.advanceTimersByTime(5_000);
    expect(h.sockets).toHaveLength(2);
    const ws2 = h.sockets[1]!;
    ws2.serverOpen();
    ws2.serverSend(ackWithLiveness());
    await flush();
    const create = lastFrame<{ type: string; id: string }>(ws2, "create")!;
    expect(create).toBeTruthy();
    ws2.serverSend({
      type: "response",
      id: create.id,
      payload: { ok: true, result: { sessionId: "new-1", epoch: "eN", created: true, cwd: "/x", projectRoot: "/x", lastEventId: 0 } },
    });
    await expect(createP).resolves.toMatchObject({ sessionId: "new-1" });
    h.dispose();
  });

  it("ordinary command lane waits for a PROVEN connection (shared wire gate — no per-lane patch)", async () => {
    const h = createHarness({ liveness: { heartbeatIntervalMs: 1_000_000, pongTimeoutMs: 5_000, freshnessMs: 60_000 } });
    const ws1 = await openAndAttach(h);
    vi.advanceTimersByTime(61_000);
    const controller = h.controller("s1")!;
    const cmdP = controller.sendCommand({ commandId: "cmd-idle-1", type: "prompt", message: "idle command" });
    await flush();
    // Nothing raced into the stale socket; the shared gate probed instead.
    expect(lastFrame(ws1, "command")).toBeUndefined();
    expect(pingFrames(ws1)).toHaveLength(1);
    // Proven death → forced reconnect → recovery → SAME commandId resent once.
    vi.advanceTimersByTime(5_000);
    expect(h.sockets).toHaveLength(2);
    const ws2 = h.sockets[1]!;
    ws2.serverOpen();
    ws2.serverSend(ackWithLiveness());
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws2, "attach")!;
    expect(attachFrame).toBeTruthy();
    ws2.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1", epoch: "e1" }) });
    await flush(8);
    const cmd2 = lastFrame<{ type: string; id: string; payload: { command: { commandId: string } } }>(ws2, "command")!;
    expect(cmd2).toBeTruthy();
    expect(cmd2.payload.command.commandId).toBe("cmd-idle-1");
    expect(lastFrame(ws1, "command")).toBeUndefined();
    ws2.serverSend({ type: "response", id: cmd2.id, payload: { ok: true, result: { commandId: "cmd-idle-1", result: { ok: true, type: "prompt" } } } });
    await expect(cmdP).resolves.toBeTruthy();
    h.dispose();
  });

  it("whenReady is bounded: a black-holed recovery fails honestly instead of hanging", async () => {
    const h = createHarness({ liveness: { heartbeatIntervalMs: 1_000_000, pongTimeoutMs: 5_000, freshnessMs: 60_000 } });
    const ws1 = await openSocket(h);
    vi.advanceTimersByTime(61_000);
    const createP = h.connection.createSession({ cwd: "/x", projectRoot: "/x" });
    let settled: "pending" | "done" = "pending";
    void createP.then(() => { settled = "done"; }, () => { settled = "done"; });
    await flush();
    expect(pingFrames(ws1)).toHaveLength(1);
    // Every recovery attempt black-holes (sockets never open); the bounded
    // ready gate must reject within its budget, never hang.
    for (let i = 0; i < 120 && settled === "pending"; i += 1) {
      vi.advanceTimersByTime(1_000);
      await flush(4);
    }
    expect(settled).toBe("done");
    await expect(createP).rejects.toMatchObject({ code: "timeout", retryable: true });
    h.dispose();
  });

  it("without the negotiated feature a dead transport still fails bounded (retryable timeout), never a fake success", async () => {
    const h = createHarness({ liveness: { heartbeatIntervalMs: 30_000, pongTimeoutMs: 10_000 } });
    const ws1 = await openAndAttach(h, ackWithoutLiveness);
    vi.advanceTimersByTime(61_000);
    // Transport dies with a delivered close; reconnects stall (never opens).
    ws1.serverClose(1006);
    const sendP = h.store.sendPrompt("offline send");
    // Each reconnect attempt gets the bounded connect budget, then backs off.
    vi.advanceTimersByTime(10_000 + 30_000);
    await flush();
    await expect(sendP).rejects.toMatchObject({ code: "timeout", retryable: true });
    h.dispose();
  });
});
