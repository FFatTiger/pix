import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeSocket, type LivenessOptions, type RuntimeSocketHandler, type RuntimeSocketDeps } from "./socket";
import { FakeWebSocket } from "./testing/harness";
import type { ClientIdentity, HostCapability, ProtocolHandshakeResponse, WsHostMessage } from "@fffattiger/pix-protocol";

function ackPayload(caps: HostCapability[] = ["agent"]): ProtocolHandshakeResponse {
  return { protocolVersion: 2, host: { mode: "local", capabilities: caps }, limits: { maxUpload: 0, maxOpenSessions: 4 }, sessionSnapshotSupport: true };
}

interface Recorded {
  states: string[];
  acks: { caps: string[] }[];
  rejects: unknown[];
  messages: { message: WsHostMessage; generation: number }[];
}

function makeHandler(rec: Recorded): RuntimeSocketHandler {
  return {
    onConnectionState: (s) => { rec.states.push(s); },
    onHandshakeAck: (host) => { rec.acks.push({ caps: [...host.capabilities] }); },
    onHandshakeReject: (e) => { rec.rejects.push(e); },
    onMessage: (message, generation) => { rec.messages.push({ message, generation }); },
  };
}

function makeDeps(sockets: FakeWebSocket[], opts: { random?: () => number; onOnline?: (cb: () => void) => () => void; onAttention?: (cb: (attention: { visible: boolean; focused: boolean }) => void) => () => void; liveness?: Partial<LivenessOptions> } = {}): RuntimeSocketDeps {
  return {
    createWebSocket: (url) => { const ws = new FakeWebSocket(url); sockets.push(ws); return ws; },
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    random: opts.random ?? (() => 0.5),
    location: { href: "https://pix.local/app/" },
    identity: { shell: "web", platform: "mac" } satisfies ClientIdentity,
    onOnline: opts.onOnline ?? (() => () => undefined),
    ...(opts.onAttention === undefined ? {} : { onAttention: opts.onAttention }),
    ...(opts.liveness === undefined ? {} : { liveness: opts.liveness }),
  };
}

describe("RuntimeSocket", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("handshake ack → ready and surfaces host capabilities", async () => {
    const sockets: FakeWebSocket[] = [];
    const rec: Recorded = { states: [], acks: [], rejects: [], messages: [] };
    const socket = new RuntimeSocket(makeDeps(sockets), makeHandler(rec));
    socket.connect();
    const ws = sockets[0]!;
    ws.serverOpen(); // sends handshake synchronously
    expect(socket.connectionState).toBe("handshaking");
    const handshake = ws.sent[0] as { type: string; payload: { features: string[] } };
    expect(handshake.type).toBe("handshake");
    expect(handshake.payload.features).toContain("runtime.running-watch.v1");
    expect(handshake.payload.features).toContain("runtime.observe-existing.v1");
    expect(handshake.payload.features).toContain("runtime.explicit-activate.v1");
    expect(handshake.payload.features).toContain("runtime.questionnaire.v1");
    ws.serverSend({ type: "handshake_ack", payload: ackPayload(["agent", "files"]) });
    expect(socket.connectionState).toBe("ready");
    expect(rec.acks[0]?.caps).toEqual(["agent", "files"]);
  });

  it("handshake reject is fatal: stopped, no reconnect", () => {
    const sockets: FakeWebSocket[] = [];
    const rec: Recorded = { states: [], acks: [], rejects: [], messages: [] };
    const socket = new RuntimeSocket(makeDeps(sockets), makeHandler(rec));
    socket.connect();
    sockets[0]!.serverOpen();
    sockets[0]!.serverSend({ type: "handshake_reject", payload: { error: { code: "protocol_mismatch", message: "x", retryable: false } } });
    expect(socket.connectionState).toBe("stopped");
    expect(rec.rejects).toHaveLength(1);
    // No reconnect socket created even after advancing timers.
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it("invalid frame fails closed (stopped)", () => {
    const sockets: FakeWebSocket[] = [];
    const rec: Recorded = { states: [], acks: [], rejects: [], messages: [] };
    const socket = new RuntimeSocket(makeDeps(sockets), makeHandler(rec));
    socket.connect();
    sockets[0]!.serverOpen();
    sockets[0]!.serverSend({ type: "handshake_ack", payload: ackPayload() });
    sockets[0]!.serverSend("not-json{}");
    expect(socket.connectionState).toBe("stopped");
  });

  it("reconnects with exponential full-jitter backoff on unexpected close", () => {
    const sockets: FakeWebSocket[] = [];
    const rec: Recorded = { states: [], acks: [], rejects: [], messages: [] };
    const socket = new RuntimeSocket(makeDeps(sockets, { random: () => 0.5 }), makeHandler(rec));
    socket.connect();
    sockets[0]!.serverOpen();
    sockets[0]!.serverSend({ type: "handshake_ack", payload: ackPayload() });
    // Unexpected close (not manual).
    sockets[0]!.serverClose(1006);
    expect(socket.connectionState).toBe("unavailable");
    // attempt 1, random 0.5, upper=500 → delay 250ms.
    vi.advanceTimersByTime(249);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2); // reconnected
  });

  it("caps the reconnect wait at 2s while visible and keeps the full backoff while hidden", () => {
    const sockets: FakeWebSocket[] = [];
    let setAttention: (attention: { visible: boolean; focused: boolean }) => void = () => undefined;
    const deps: RuntimeSocketDeps = {
      ...makeDeps(sockets, { random: () => 0.999 }),
      onAttention: (cb) => { setAttention = cb; return () => undefined; },
    };
    const socket = new RuntimeSocket(deps, makeHandler({ states: [], acks: [], rejects: [], messages: [] }));
    socket.connect();
    // Six failed attempts: the uncapped wait would now be ~16s.
    for (let attempt = 0; attempt < 6; attempt++) {
      sockets.at(-1)!.serverClose(1006);
      vi.advanceTimersByTime(2_000);
    }
    expect(sockets).toHaveLength(7);
    setAttention({ visible: false, focused: true });
    sockets.at(-1)!.serverClose(1006);
    vi.advanceTimersByTime(2_000);
    expect(sockets).toHaveLength(7);
  });

  it("online recovery triggers immediate reconnect", () => {
    const sockets: FakeWebSocket[] = [];
    const onlineCbs: (() => void)[] = [];
    const deps = makeDeps(sockets, {
      onOnline: (cb) => { onlineCbs.push(cb); return () => undefined; },
    });
    const rec: Recorded = { states: [], acks: [], rejects: [], messages: [] };
    const socket = new RuntimeSocket(deps, makeHandler(rec));
    socket.connect();
    sockets[0]!.serverOpen();
    sockets[0]!.serverSend({ type: "handshake_ack", payload: ackPayload() });
    sockets[0]!.serverClose(1006); // → unavailable, backoff pending
    // online fires → immediate reconnect bypasses the backoff wait.
    onlineCbs[0]!();
    expect(sockets).toHaveLength(2);
  });

  it("dispose is idempotent and prevents reconnect", () => {
    const sockets: FakeWebSocket[] = [];
    const rec: Recorded = { states: [], acks: [], rejects: [], messages: [] };
    const socket = new RuntimeSocket(makeDeps(sockets), makeHandler(rec));
    socket.connect();
    sockets[0]!.serverOpen();
    sockets[0]!.serverSend({ type: "handshake_ack", payload: ackPayload() });
    socket.dispose();
    socket.dispose();
    expect(socket.connectionState).toBe("stopped");
    expect(sockets[0]!.wasClosedByClient).toBe(true);
    sockets[0]!.serverClose(1000);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1); // no reconnect after dispose
  });

  it("pre-ack runtime_unavailable fails closed (no data before handshake ack)", () => {
    const sockets: FakeWebSocket[] = [];
    const rec: Recorded = { states: [], acks: [], rejects: [], messages: [] };
    const socket = new RuntimeSocket(makeDeps(sockets), makeHandler(rec));
    socket.connect();
    sockets[0]!.serverOpen();
    // Before handshake_ack, runtime_unavailable is a protocol violation → fail closed.
    sockets[0]!.serverSend({ type: "runtime_unavailable", payload: { sessionId: "s1", error: { code: "runtime_unavailable", message: "down", retryable: true } } });
    expect(socket.connectionState).toBe("stopped");
    expect(rec.messages).toHaveLength(0);
  });

  it("generation drops late frames from a superseded socket", async () => {
    const sockets: FakeWebSocket[] = [];
    const rec: Recorded = { states: [], acks: [], rejects: [], messages: [] };
    const socket = new RuntimeSocket(makeDeps(sockets), makeHandler(rec));
    socket.connect();
    const first = sockets[0]!;
    first.serverOpen();
    first.serverSend({ type: "handshake_ack", payload: ackPayload() });
    expect(socket.currentGeneration).toBe(1);
    first.serverClose(1006);
    vi.advanceTimersByTime(250); // reconnect → generation 2
    const second = sockets[1]!;
    expect(socket.currentGeneration).toBe(2);
    second.serverOpen();
    second.serverSend({ type: "handshake_ack", payload: ackPayload() });
    // A late frame from the FIRST (old-generation) socket must be ignored.
    first.serverSend({ type: "event", payload: { type: "agent_start", sessionId: "s", eventId: 1, epoch: "e" } });
    expect(rec.messages).toHaveLength(0);
    // A current-generation frame is delivered.
    second.serverSend({ type: "event", payload: { type: "agent_start", sessionId: "s", eventId: 1, epoch: "e" } });
    expect(rec.messages).toHaveLength(1);
    socket.dispose();
  });

  it("rejects invalid image-bearing frames before any bytes are written", () => {
    const sockets: FakeWebSocket[] = [];
    const rec: Recorded = { states: [], acks: [], rejects: [], messages: [] };
    const socket = new RuntimeSocket(makeDeps(sockets), makeHandler(rec));
    socket.connect();
    sockets[0]!.serverOpen();
    sockets[0]!.serverSend({ type: "handshake_ack", payload: ackPayload() });
    const before = sockets[0]!.sent.length;
    expect(() => socket.send({
      type: "command",
      id: "c1",
      payload: {
        sessionId: "s1",
        command: {
          commandId: "cmd-1",
          type: "prompt",
          message: "hi",
          images: Array.from({ length: 9 }, () => ({ type: "image", data: "AA==", mimeType: "image/png" })),
        },
      },
    })).toThrow();
    expect(sockets[0]!.sent.length).toBe(before);
    socket.send({
      type: "command",
      id: "c2",
      payload: {
        sessionId: "s1",
        command: {
          commandId: "cmd-2",
          type: "prompt",
          message: "hi",
          images: [{ type: "image", data: "AA==", mimeType: "image/png" }],
        },
      },
    });
    expect(sockets[0]!.sent.at(-1)).toMatchObject({ type: "command", id: "c2" });
  });

  it("negotiated attention: initial report after ack and updates on visibility/focus change", async () => {
    const sockets: FakeWebSocket[] = [];
    let attentionCb: ((attention: { visible: boolean; focused: boolean }) => void) | undefined;
    const deps = makeDeps(sockets, {
      onAttention: (cb) => {
        attentionCb = cb;
        return () => undefined;
      },
    });
    const rec: Recorded = { states: [], acks: [], rejects: [], messages: [] };
    const socket = new RuntimeSocket(deps, makeHandler(rec));
    socket.connect();
    const ws = sockets[0]!;
    ws.serverOpen();
    const handshake = ws.sent[0] as { payload: { features: string[] } };
    expect(handshake.payload.features).toContain("runtime.visibility.v1");
    ws.serverSend({ type: "handshake_ack", payload: { ...ackPayload(), acceptedFeatures: ["runtime.visibility.v1"] } });
    // Initial report (page assumed visible+focused until reported otherwise):
    // attended is only true while BOTH hold — per-device push suppression.
    expect(ws.sent.at(-1)).toEqual({ type: "visibility", payload: { visible: true, attended: true } });
    attentionCb!({ visible: true, focused: false }); // blur: still visible, not looked at
    expect(ws.sent.at(-1)).toEqual({ type: "visibility", payload: { visible: true, attended: false } });
    attentionCb!({ visible: false, focused: true }); // hidden tab
    expect(ws.sent.at(-1)).toEqual({ type: "visibility", payload: { visible: false, attended: false } });
    attentionCb!({ visible: true, focused: true });
    expect(ws.sent.at(-1)).toEqual({ type: "visibility", payload: { visible: true, attended: true } });
    socket.dispose();
  });

  it("focus-only changes re-report without forcing a reconnect", () => {
    const sockets: FakeWebSocket[] = [];
    let attentionCb: ((attention: { visible: boolean; focused: boolean }) => void) | undefined;
    const deps = makeDeps(sockets, {
      onAttention: (cb) => { attentionCb = cb; return () => undefined; },
    });
    const rec: Recorded = { states: [], acks: [], rejects: [], messages: [] };
    const socket = new RuntimeSocket(deps, makeHandler(rec));
    socket.connect();
    const ws = sockets[0]!;
    ws.serverOpen();
    ws.serverSend({ type: "handshake_ack", payload: { ...ackPayload(), acceptedFeatures: ["runtime.visibility.v1"] } });
    const framesBefore = ws.sent.length;
    attentionCb!({ visible: true, focused: false });
    attentionCb!({ visible: true, focused: true });
    expect(ws.sent.length).toBe(framesBefore + 2); // both blur and focus reported
    expect(sockets).toHaveLength(1); // but no reconnect was forced
    expect(socket.connectionState).toBe("ready");
    socket.dispose();
  });

  it("push endpoint hash: reported once set, re-reported on change, survives reconnect", () => {
    const sockets: FakeWebSocket[] = [];
    const deps = makeDeps(sockets);
    const rec: Recorded = { states: [], acks: [], rejects: [], messages: [] };
    const socket = new RuntimeSocket(deps, makeHandler(rec));
    socket.connect();
    const ws = sockets[0]!;
    ws.serverOpen();
    ws.serverSend({ type: "handshake_ack", payload: { ...ackPayload(), acceptedFeatures: ["runtime.visibility.v1"] } });
    expect(ws.sent.at(-1)).toEqual({ type: "visibility", payload: { visible: true, attended: true } });
    const hash = "a".repeat(64);
    socket.setPushEndpointHash(hash);
    expect(ws.sent.at(-1)).toEqual({ type: "visibility", payload: { visible: true, attended: true, pushEndpointHash: hash } });
    // Same hash → no redundant frame.
    const before = ws.sent.length;
    socket.setPushEndpointHash(hash);
    expect(ws.sent.length).toBe(before);
    // Cleared (push disabled on this device) → reported without a hash.
    socket.setPushEndpointHash(undefined);
    expect(ws.sent.at(-1)).toEqual({ type: "visibility", payload: { visible: true, attended: true } });
    // A hash set while disconnected is picked up by the next handshake ack report.
    socket.setPushEndpointHash(hash);
    ws.serverClose(1006);
    vi.advanceTimersByTime(250); // reconnect
    const next = sockets[1]!;
    next.serverOpen();
    next.serverSend({ type: "handshake_ack", payload: { ...ackPayload(), acceptedFeatures: ["runtime.visibility.v1"] } });
    expect(next.sent.at(-1)).toEqual({ type: "visibility", payload: { visible: true, attended: true, pushEndpointHash: hash } });
    socket.dispose();
  });

  it("initialAttention is adopted before any hook fires (hidden-tab connect reports honestly)", () => {
    const sockets: FakeWebSocket[] = [];
    const deps: RuntimeSocketDeps = {
      ...makeDeps(sockets),
      initialAttention: { visible: false, focused: true },
    };
    const rec: Recorded = { states: [], acks: [], rejects: [], messages: [] };
    const socket = new RuntimeSocket(deps, makeHandler(rec));
    socket.connect();
    const ws = sockets[0]!;
    ws.serverOpen();
    ws.serverSend({ type: "handshake_ack", payload: { ...ackPayload(), acceptedFeatures: ["runtime.visibility.v1"] } });
    expect(ws.sent.at(-1)).toEqual({ type: "visibility", payload: { visible: false, attended: false } });
    socket.dispose();
  });

  it("unnegotiated attention: no frame is ever sent", async () => {
    const sockets: FakeWebSocket[] = [];
    let attentionCb: ((attention: { visible: boolean; focused: boolean }) => void) | undefined;
    const deps = makeDeps(sockets, {
      onAttention: (cb) => {
        attentionCb = cb;
        return () => undefined;
      },
    });
    const rec: Recorded = { states: [], acks: [], rejects: [], messages: [] };
    const socket = new RuntimeSocket(deps, makeHandler(rec));
    socket.connect();
    const ws = sockets[0]!;
    ws.serverOpen();
    ws.serverSend({ type: "handshake_ack", payload: ackPayload() });
    const before = ws.sent.length;
    attentionCb!({ visible: true, focused: true });
    attentionCb!({ visible: false, focused: false });
    expect(ws.sent.length).toBe(before);
    socket.dispose();
  });

  // ONE liveness clock: a probe sends the ping and is answered by the pong (or
  // by the pong deadline that proves the transport dead). There is no second
  // probe timer; only a SHORTER caller wait truncates the answer.
  it("a probe is answered by the armed pong deadline, not by a second timer", async () => {
    const sockets: FakeWebSocket[] = [];
    const deps = makeDeps(sockets, { liveness: { heartbeatIntervalMs: 1_000_000, pongTimeoutMs: 5_000 } });
    const rec: Recorded = { states: [], acks: [], rejects: [], messages: [] };
    const socket = new RuntimeSocket(deps, makeHandler(rec));
    socket.connect();
    const ws = sockets[0]!;
    ws.serverOpen();
    ws.serverSend({ type: "handshake_ack", payload: { ...ackPayload(), acceptedFeatures: ["runtime.liveness.v1"] } });
    // The caller waits longer than the pong timeout: death is proven at 5s, not
    // at the caller's 60s (one clock, no leftover timer).
    const alive = socket.probe(60_000);
    vi.advanceTimersByTime(4_999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await expect(alive).resolves.toBe(false);
    expect(sockets).toHaveLength(2); // the pong deadline forced the reconnect
    socket.dispose();
  });

  it("a shorter caller wait resolves first and the single pong deadline still proves death", async () => {
    const sockets: FakeWebSocket[] = [];
    const deps = makeDeps(sockets, { liveness: { heartbeatIntervalMs: 1_000_000, pongTimeoutMs: 5_000 } });
    const rec: Recorded = { states: [], acks: [], rejects: [], messages: [] };
    const socket = new RuntimeSocket(deps, makeHandler(rec));
    socket.connect();
    const ws = sockets[0]!;
    ws.serverOpen();
    ws.serverSend({ type: "handshake_ack", payload: { ...ackPayload(), acceptedFeatures: ["runtime.liveness.v1"] } });
    const alive = socket.probe(1_000);
    vi.advanceTimersByTime(1_000);
    await expect(alive).resolves.toBe(false);
    expect(sockets).toHaveLength(1); // the caller's truncation never reconnects
    vi.advanceTimersByTime(4_000);
    expect(sockets).toHaveLength(2); // the one pong deadline still decides death
    socket.dispose();
  });

  // The browser fires visibilitychange once and the socket is its ONLY
  // subscriber: becoming visible reconnects a non-sendable transport on that
  // one path (no second "page is visible" hook racing it).
  it("becoming visible reconnects a non-sendable transport on the one visibility path", async () => {
    const sockets: FakeWebSocket[] = [];
    let attentionCb: ((attention: { visible: boolean; focused: boolean }) => void) | undefined;
    const deps = makeDeps(sockets, {
      onAttention: (cb) => { attentionCb = cb; return () => undefined; },
    });
    const rec: Recorded = { states: [], acks: [], rejects: [], messages: [] };
    const socket = new RuntimeSocket(deps, makeHandler(rec));
    socket.connect();
    sockets[0]!.serverOpen();
    sockets[0]!.serverSend({ type: "handshake_ack", payload: ackPayload() });
    sockets[0]!.serverClose(1006); // unavailable, backoff pending
    expect(socket.connectionState).toBe("unavailable");
    attentionCb!({ visible: true, focused: true });
    expect(sockets).toHaveLength(2); // immediate reconnect, no backoff wait
    socket.dispose();
  });
});
