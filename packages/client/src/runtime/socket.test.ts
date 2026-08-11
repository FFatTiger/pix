import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeSocket, type RuntimeSocketHandler, type RuntimeSocketDeps } from "./socket";
import { FakeWebSocket } from "./testing/harness";
import type { ClientIdentity, HostCapability, ProtocolHandshakeResponse, WsHostMessage } from "@fffattiger/pix-protocol";

function ackPayload(caps: HostCapability[] = ["agent"]): ProtocolHandshakeResponse {
  return { protocolVersion: 1, host: { mode: "local", capabilities: caps }, limits: { maxUpload: 0, maxOpenSessions: 4 }, sessionSnapshotSupport: true };
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

function makeDeps(sockets: FakeWebSocket[], opts: { random?: () => number; onOnline?: (cb: () => void) => () => void; onVisible?: (cb: () => void) => () => void } = {}): RuntimeSocketDeps {
  return {
    createWebSocket: (url) => { const ws = new FakeWebSocket(url); sockets.push(ws); return ws; },
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    random: opts.random ?? (() => 0.5),
    location: { href: "https://pix.local/app/" },
    identity: { shell: "web", platform: "mac" } satisfies ClientIdentity,
    onOnline: opts.onOnline ?? (() => () => undefined),
    onVisible: opts.onVisible ?? (() => () => undefined),
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
    expect((ws.sent[0] as { type: string }).type).toBe("handshake");
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

  it("online/visibility recovery triggers immediate reconnect", () => {
    const sockets: FakeWebSocket[] = [];
    const onlineCbs: (() => void)[] = [];
    const deps = makeDeps(sockets, {
      onOnline: (cb) => { onlineCbs.push(cb); return () => undefined; },
      onVisible: () => () => undefined,
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
});
