import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProtocolHandshakeResponse,
  RuntimeEventData,
  WsEventMessage,
  WsSnapshotMessage,
  WsTurnStatusMessage,
} from "@fffattiger/pix-protocol";
import {
  RuntimeConnection,
  type RuntimeControllerPort,
  type RuntimeConnectionOptions,
} from "./runtime-connection";
import type { RuntimeSocketDeps } from "./socket";
import { FakeWebSocket, flush, lastFrame, snapshotPayload } from "./testing/harness";

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

function makeConnection(options: RuntimeConnectionOptions = {}) {
  const sockets: FakeWebSocket[] = [];
  const deps: RuntimeSocketDeps = {
    createWebSocket: (url) => { const ws = new FakeWebSocket(url); sockets.push(ws); return ws; },
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    random: () => 0.5,
    location: { href: "https://pix.local/app/" },
    identity: { shell: "web", platform: "mac" },
    onOnline: () => () => undefined,
    onVisible: () => () => undefined,
  };
  return { connection: new RuntimeConnection(deps, options), sockets };
}

interface PortRecord {
  states: string[];
  snapshots: WsSnapshotMessage[];
  events: WsEventMessage[];
  statuses: WsTurnStatusMessage[];
  unavailable: unknown[];
  attachedSession: string | null;
  sessions: Set<string>;
  turns: Set<string>;
}

function port(record: PortRecord): RuntimeControllerPort {
  return {
    onTransportState: (state) => { record.states.push(state); },
    onTransportFatal: () => undefined,
    onSnapshot: (message) => { record.snapshots.push(message); },
    onEvent: (message) => { record.events.push(message); },
    onTurnStatus: (message) => { record.statuses.push(message); },
    onUnavailable: (message) => { record.unavailable.push(message); },
  };
}

function record(): PortRecord {
  return {
    states: [], snapshots: [], events: [], statuses: [], unavailable: [],
    attachedSession: null, sessions: new Set(), turns: new Set(),
  };
}

function ready(connection: RuntimeConnection, sockets: FakeWebSocket[], features: readonly string[] = ["runtime.running-watch.v1"]): FakeWebSocket {
  connection.connect();
  const ws = sockets.at(-1)!;
  ws.serverOpen();
  ws.serverSend(ack(features));
  return ws;
}

function commandSpec(callbacks: { frames: unknown[]; failures: unknown[]; disconnects: unknown[] }, commandId = "cmd-1", sessionId = "s1") {
  return {
    buildMessage: (id: string) => ({
      type: "command" as const,
      id,
      payload: { sessionId, command: { commandId, type: "set_session_name" as const, name: "name" } },
    }),
    expectation: { kind: "command" as const, sessionId, commandId, resultType: "set_session_name" as const },
    disconnectPolicy: "logical_retry" as const,
    onFrame: (frame: unknown) => { callbacks.frames.push(frame); },
    onSendFailure: (error: unknown) => { callbacks.failures.push(error); },
    onDisconnect: (error: unknown) => { callbacks.disconnects.push(error); },
  };
}

describe("RuntimeConnection — sole socket, binding and bounded attempts", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("opens exactly one RuntimeSocket while exact A/B bindings coexist and duplicate A is rejected", () => {
    const { connection, sockets } = makeConnection();
    connection.registerController("A", port(record()));
    connection.registerController("B", port(record()));
    expect(() => connection.registerController("A", port(record()))).toThrow(/already has a controller/);
    connection.connect();
    connection.connect();
    expect(sockets).toHaveLength(1);
  });

  it("invalidates an unbound token: stale sends and callbacks are inert", () => {
    const { connection, sockets } = makeConnection();
    const firstRecord = record();
    const first = connection.registerController("s1", port(firstRecord));
    const ws = ready(connection, sockets);
    const stale = { frames: [] as unknown[], failures: [] as unknown[], disconnects: [] as unknown[] };
    const staleHandle = first.sendAttempt(commandSpec(stale, "stale-command"))!;
    first.unbind();
    ws.serverSend({ type: "response", id: staleHandle.envelopeId, payload: { ok: true, result: { commandId: "stale-command", result: { ok: true, type: "set_session_name" } } } });
    expect(stale.frames).toHaveLength(0);
    expect(first.sendAttempt(commandSpec(stale))).toBeNull();
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "command")).toHaveLength(1);

    const secondRecord = record();
    secondRecord.attachedSession = "s2";
    secondRecord.sessions.add("s2");
    connection.registerController("s2", port(secondRecord));
    connection.replaceAttachmentRoute("s2");
    ws.serverSend({ type: "event", payload: { type: "agent_start", sessionId: "s2", eventId: 1, epoch: "e2" } });
    expect(firstRecord.events).toHaveLength(0);
    expect(secondRecord.events).toHaveLength(1);
  });

  it("rejects at a low registry bound before send and never overwrites the live attempt", () => {
    const { connection, sockets } = makeConnection({ maxOutboundAttempts: 1 });
    const binding = connection.registerController("s1", port(record()));
    const ws = ready(connection, sockets);
    const first = { frames: [] as unknown[], failures: [] as unknown[], disconnects: [] as unknown[] };
    const second = { frames: [] as unknown[], failures: [] as unknown[], disconnects: [] as unknown[] };
    const firstHandle = binding.sendAttempt(commandSpec(first, "cmd-1"));
    expect(firstHandle).not.toBeNull();
    expect(binding.sendAttempt(commandSpec(second, "cmd-2"))).toBeNull();
    expect(second.failures).toEqual([expect.objectContaining({ code: "session_busy", retryable: true })]);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "command")).toHaveLength(1);

    ws.serverSend({ type: "response", id: firstHandle!.envelopeId, payload: { ok: true, result: { commandId: "cmd-1", result: { ok: true, type: "set_session_name" } } } });
    expect(first.frames).toHaveLength(1);
  });

  it("drops wrong envelope/generation/frame type/session/commandId/result type; exact frame settles once and duplicate is inert", () => {
    const { connection, sockets } = makeConnection();
    const binding = connection.registerController("s1", port(record()));
    const ws = ready(connection, sockets);
    const callbacks = { frames: [] as unknown[], failures: [] as unknown[], disconnects: [] as unknown[] };
    const handle = binding.sendAttempt(commandSpec(callbacks))!;

    ws.serverSend({ type: "response", id: "wrong", payload: { ok: true, result: { commandId: "cmd-1", result: { ok: true, type: "set_session_name" } } } });
    ws.serverSend({ type: "interrupt_result", id: handle.envelopeId, payload: { sessionId: "s1", commandId: "cmd-1", interruptType: "abort", result: { ok: true, type: "abort" } } });
    ws.serverSend({ type: "response", id: handle.envelopeId, payload: { sessionId: "other", ok: true, result: { commandId: "cmd-1", result: { ok: true, type: "set_session_name" } } } });
    ws.serverSend({ type: "response", id: handle.envelopeId, payload: { ok: true, result: { commandId: "wrong", result: { ok: true, type: "set_session_name" } } } });
    ws.serverSend({ type: "response", id: handle.envelopeId, payload: { ok: true, result: { commandId: "cmd-1", result: { ok: true, type: "set_thinking_level" } } } });
    expect(callbacks.frames).toHaveLength(0);

    ws.serverSend({ type: "response", id: handle.envelopeId, payload: { sessionId: "s1", ok: true, result: { commandId: "cmd-1", result: { ok: true, type: "set_session_name" } } } });
    ws.serverSend({ type: "response", id: handle.envelopeId, payload: { sessionId: "s1", ok: true, result: { commandId: "cmd-1", result: { ok: true, type: "set_session_name" } } } });
    expect(callbacks.frames).toHaveLength(1);

    ws.serverClose(1006);
    vi.advanceTimersByTime(250);
    const ws2 = sockets.at(-1)!;
    ws2.serverOpen();
    ws2.serverSend(ack());
    ws.serverSend({ type: "response", id: handle.envelopeId, payload: { ok: true, result: { commandId: "cmd-1", result: { ok: true, type: "set_session_name" } } } });
    expect(callbacks.frames).toHaveLength(1);
  });

  it("does not consume a stop attempt until the exact session reports stopped=true", () => {
    const { connection, sockets } = makeConnection();
    const binding = connection.registerController("s1", port(record()));
    const ws = ready(connection, sockets);
    const frames: unknown[] = [];
    let settlements = 0;
    const handle = binding.sendAttempt({
      buildMessage: (id) => ({ type: "stop", id, payload: { sessionId: "s1" } }),
      expectation: { kind: "stop", sessionId: "s1" },
      disconnectPolicy: "reject_on_disconnect",
      onFrame: (frame) => { frames.push(frame); settlements += 1; },
      onSendFailure: () => { settlements += 1; },
      onDisconnect: () => { settlements += 1; },
    })!;

    ws.serverSend({ type: "response", id: handle.envelopeId, payload: { ok: true, result: { sessionId: "s1", stopped: false } } });
    expect(frames).toHaveLength(0);
    expect(settlements).toBe(0);
    ws.serverSend({ type: "response", id: handle.envelopeId, payload: { ok: true, result: { sessionId: "s1", stopped: true } } });
    ws.serverSend({ type: "response", id: handle.envelopeId, payload: { ok: true, result: { sessionId: "s1", stopped: true } } });
    expect(frames).toHaveLength(1);
    expect(settlements).toBe(1);
  });

  it("send throw removes only the exact attempt; an old cancel token cannot remove a newer reused envelope", () => {
    const ids = ["handshake", "boom", "same", "same"];
    const { connection, sockets } = makeConnection({ id: () => ids.shift() ?? "next", maxOutboundAttempts: 1 });
    const binding = connection.registerController("s1", port(record()));
    const ws = ready(connection, sockets);
    const originalSend = ws.send.bind(ws);
    let throwOnce = true;
    ws.send = (data: string) => {
      const parsed = JSON.parse(data) as { type?: string };
      if (parsed.type === "command" && throwOnce) { throwOnce = false; throw new Error("send boom"); }
      originalSend(data);
    };
    const failed = { frames: [] as unknown[], failures: [] as unknown[], disconnects: [] as unknown[] };
    expect(binding.sendAttempt(commandSpec(failed, "cmd-old"))).toBeNull();
    expect(failed.failures).toHaveLength(1);

    const old = { frames: [] as unknown[], failures: [] as unknown[], disconnects: [] as unknown[] };
    const oldHandle = binding.sendAttempt(commandSpec(old, "cmd-old-live"))!;
    expect(oldHandle.envelopeId).toBe("same");
    ws.serverSend({ type: "response", id: "same", payload: { ok: true, result: { commandId: "cmd-old-live", result: { ok: true, type: "set_session_name" } } } });
    expect(old.frames).toHaveLength(1);

    const newer = { frames: [] as unknown[], failures: [] as unknown[], disconnects: [] as unknown[] };
    const newerHandle = binding.sendAttempt(commandSpec(newer, "cmd-new"))!;
    expect(newerHandle.envelopeId).toBe("same");
    oldHandle.cancel(); // unique internal token: must not remove the newer record
    ws.serverSend({ type: "response", id: "same", payload: { ok: true, result: { commandId: "cmd-new", result: { ok: true, type: "set_session_name" } } } });
    expect(newer.frames).toHaveLength(1);
  });

  it("disconnect rejects one-shot once while logical retry remains owner-held and re-registers fresh", () => {
    const { connection, sockets } = makeConnection();
    const binding = connection.registerController("s1", port(record()));
    let ws = ready(connection, sockets);
    const oneShot = { frames: [] as unknown[], failures: [] as unknown[], disconnects: [] as unknown[] };
    const logical = { frames: [] as unknown[], failures: [] as unknown[], disconnects: [] as unknown[] };
    binding.sendAttempt({
      buildMessage: (id) => ({ type: "getSnapshot", id, payload: { sessionId: "s1" } }),
      expectation: { kind: "getSnapshot", sessionId: "s1" },
      disconnectPolicy: "reject_on_disconnect",
      onFrame: (frame) => oneShot.frames.push(frame),
      onSendFailure: (error) => oneShot.failures.push(error),
      onDisconnect: (error) => oneShot.disconnects.push(error),
    });
    const firstLogical = binding.sendAttempt(commandSpec(logical, "stable-command"))!;
    ws.serverClose(1006);
    expect(oneShot.disconnects).toHaveLength(1);
    expect(logical.disconnects).toHaveLength(0);

    vi.advanceTimersByTime(250);
    ws = sockets.at(-1)!;
    ws.serverOpen();
    ws.serverSend(ack());
    const retry = binding.sendAttempt(commandSpec(logical, "stable-command"))!;
    expect(retry.envelopeId).not.toBe(firstLogical.envelopeId);
    ws.serverSend({ type: "response", id: retry.envelopeId, payload: { ok: true, result: { commandId: "stable-command", result: { ok: true, type: "set_session_name" } } } });
    expect(logical.frames).toHaveLength(1);
  });
});

describe("RuntimeConnection — exact multi-binding routing groundwork", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("routes the same operationId on A/B through collision-safe exact turn owners", () => {
    const { connection, sockets } = makeConnection();
    const a = record();
    const b = record();
    const bindingA = connection.registerController("A", port(a));
    const bindingB = connection.registerController("B", port(b));
    const ws = ready(connection, sockets);
    const submit = (binding: typeof bindingA, sessionId: string) => binding.sendAttempt({
      buildMessage: (id) => ({ type: "submit_turn", id, payload: { sessionId, operationId: "same-op", prompt: "hello" } }),
      expectation: { kind: "submit_turn", sessionId, operationId: "same-op" },
      disconnectPolicy: "logical_retry",
      onFrame: () => undefined,
      onSendFailure: () => undefined,
      onDisconnect: () => undefined,
    });
    expect(submit(bindingA, "A")).not.toBeNull();
    expect(submit(bindingB, "B")).not.toBeNull();
    ws.serverSend({ type: "turn_status", payload: { sessionId: "A", epoch: "eA", operationId: "same-op", turnId: "tA", revision: 1, state: "completed" } });
    ws.serverSend({ type: "turn_status", payload: { sessionId: "B", epoch: "eB", operationId: "same-op", turnId: "tB", revision: 1, state: "failed", error: { code: "internal", message: "failed", retryable: false } } });
    expect(a.statuses.map((status) => status.payload.sessionId)).toEqual(["A"]);
    expect(b.statuses.map((status) => status.payload.sessionId)).toEqual(["B"]);
  });

  it("rejects a wrong binding target before send", () => {
    const { connection, sockets } = makeConnection();
    const bindingA = connection.registerController("A", port(record()));
    const ws = ready(connection, sockets);
    const callbacks = { frames: [] as unknown[], failures: [] as unknown[], disconnects: [] as unknown[] };
    expect(bindingA.sendAttempt(commandSpec(callbacks, "cmd-B", "B"))).toBeNull();
    expect(callbacks.failures).toEqual([expect.objectContaining({ code: "not_found", retryable: false })]);
    expect(ws.sent.some((frame) => (frame as { type?: string }).type === "command")).toBe(false);
  });

  it("unbind A removes only A attempts/turn ownership; B remains live", () => {
    const { connection, sockets } = makeConnection();
    const a = record();
    const b = record();
    const bindingA = connection.registerController("A", port(a));
    const bindingB = connection.registerController("B", port(b));
    const ws = ready(connection, sockets);
    const callbacksA = { frames: [] as unknown[], failures: [] as unknown[], disconnects: [] as unknown[] };
    const callbacksB = { frames: [] as unknown[], failures: [] as unknown[], disconnects: [] as unknown[] };
    const attemptA = bindingA.sendAttempt(commandSpec(callbacksA, "cmd-A", "A"))!;
    const attemptB = bindingB.sendAttempt(commandSpec(callbacksB, "cmd-B", "B"))!;
    bindingA.sendAttempt({
      buildMessage: (id) => ({ type: "submit_turn", id, payload: { sessionId: "A", operationId: "op", prompt: "a" } }),
      expectation: { kind: "submit_turn", sessionId: "A", operationId: "op" },
      disconnectPolicy: "logical_retry", onFrame: () => undefined, onSendFailure: () => undefined, onDisconnect: () => undefined,
    });
    bindingB.sendAttempt({
      buildMessage: (id) => ({ type: "submit_turn", id, payload: { sessionId: "B", operationId: "op", prompt: "b" } }),
      expectation: { kind: "submit_turn", sessionId: "B", operationId: "op" },
      disconnectPolicy: "logical_retry", onFrame: () => undefined, onSendFailure: () => undefined, onDisconnect: () => undefined,
    });
    bindingA.unbind();
    ws.serverSend({ type: "response", id: attemptA.envelopeId, payload: { ok: true, result: { commandId: "cmd-A", result: { ok: true, type: "set_session_name" } } } });
    ws.serverSend({ type: "response", id: attemptB.envelopeId, payload: { ok: true, result: { commandId: "cmd-B", result: { ok: true, type: "set_session_name" } } } });
    ws.serverSend({ type: "turn_status", payload: { sessionId: "A", epoch: "eA", operationId: "op", turnId: "tA", revision: 1, state: "completed" } });
    ws.serverSend({ type: "turn_status", payload: { sessionId: "B", epoch: "eB", operationId: "op", turnId: "tB", revision: 1, state: "completed" } });
    expect(callbacksA.frames).toHaveLength(0);
    expect(callbacksB.frames).toHaveLength(1);
    expect(a.statuses).toHaveLength(0);
    expect(b.statuses).toHaveLength(1);
    expect(bindingA.sendAttempt(commandSpec(callbacksA, "stale", "A"))).toBeNull();
  });

  it("uses one explicit attachment route; replacement makes late A id-less frames inert and routes B", () => {
    const { connection, sockets } = makeConnection();
    const a = record();
    const b = record();
    connection.registerController("A", port(a));
    connection.registerController("B", port(b));
    const ws = ready(connection, sockets);
    const routeA = connection.replaceAttachmentRoute("A");
    ws.serverSend({ type: "event", payload: { type: "agent_start", sessionId: "A", eventId: 1, epoch: "eA" } });
    expect(a.events).toHaveLength(1);
    const routeB = connection.replaceAttachmentRoute("B");
    expect(routeA.isCurrent()).toBe(false);
    ws.serverSend({ type: "event", payload: { type: "agent_start", sessionId: "A", eventId: 2, epoch: "eA" } });
    ws.serverSend({ type: "snapshot", payload: snapshotPayload({ sessionId: "A", epoch: "eA" }) });
    ws.serverSend({ type: "event", payload: { type: "agent_start", sessionId: "B", eventId: 1, epoch: "eB" } });
    ws.serverSend({ type: "snapshot", payload: snapshotPayload({ sessionId: "B", epoch: "eB" }) });
    expect(a.events).toHaveLength(1);
    expect(a.snapshots).toHaveLength(0);
    expect(b.events).toHaveLength(1);
    expect(b.snapshots).toHaveLength(1);
    routeA.clear();
    expect(routeB.isCurrent()).toBe(true);
  });

  it("routes session runtime_unavailable exactly and global unavailable to both bindings", () => {
    const { connection, sockets } = makeConnection();
    const a = record();
    const b = record();
    connection.registerController("A", port(a));
    connection.registerController("B", port(b));
    const ws = ready(connection, sockets);
    ws.serverSend({ type: "runtime_unavailable", payload: { sessionId: "A", error: { code: "unavailable", message: "A down", retryable: true } } });
    expect(a.unavailable).toHaveLength(1);
    expect(b.unavailable).toHaveLength(0);
    ws.serverSend({ type: "runtime_unavailable", payload: { error: { code: "unavailable", message: "transport down", retryable: true } } });
    expect(a.unavailable).toHaveLength(2);
    expect(b.unavailable).toHaveLength(1);
  });
});

describe("RuntimeConnection — running watch and create/seeds", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("accepts lower watch revision after reconnect and rejects stale same-generation revisions", () => {
    const { connection, sockets } = makeConnection();
    connection.registerController("s1", port(record()));
    let ws = ready(connection, sockets, ["runtime.running-watch.v1"]);
    ws.serverSend({ type: "running_state", payload: { revision: 5, sessionIds: ["s1"], busySessionIds: ["s1"] } });
    ws.serverSend({ type: "running_state", payload: { revision: 4, sessionIds: ["stale"], busySessionIds: [] } });
    expect(connection.getSnapshot().runningSessionIds).toEqual(["s1"]);

    ws.serverClose(1006);
    vi.advanceTimersByTime(250);
    ws = sockets.at(-1)!;
    ws.serverOpen();
    ws.serverSend(ack(["runtime.running-watch.v1"]));
    ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["s2"], busySessionIds: [] } });
    expect(connection.getSnapshot().liveSessionIds).toEqual(["s2"]);
  });

  it("watch ignores accepted legacy state while the controller still receives and cursor-consumes the event", () => {
    const { connection, sockets } = makeConnection();
    const rec = record();
    rec.attachedSession = "s1";
    const binding = connection.registerController("s1", port(rec));
    connection.replaceAttachmentRoute("s1");
    const ws = ready(connection, sockets, ["runtime.running-watch.v1"]);
    ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["s1"], busySessionIds: ["s1"] } });
    const event: Extract<RuntimeEventData, { type: "running_sessions_changed" }> = {
      type: "running_sessions_changed", sessionId: "s1", sessionIds: [], busySessionIds: [],
    };
    ws.serverSend({ type: "event", payload: { ...event, eventId: 1, epoch: "e1" } });
    expect(rec.events).toHaveLength(1);
    binding.acceptLegacyRunningEvent(event);
    expect(connection.getSnapshot().runningSessionIds).toEqual(["s1"]);
  });

  it("sends an epoch-fenced command to an already-live session with zero attach/create", async () => {
    const { connection, sockets } = makeConnection();
    const ws = ready(connection, sockets, ["runtime.running-watch.v1", "runtime.epoch-rollover.v1"]);
    const commandP = connection.sendLiveSessionCommand("live-1", {
      commandId: "title-1",
      type: "generate_session_title",
      model: { provider: "title-provider", modelId: "title-model" },
    });
    await flush();

    const list = lastFrame<{ type: "listRunning"; id: string }>(ws, "listRunning")!;
    ws.serverSend({
      type: "response",
      id: list.id,
      payload: {
        ok: true,
        result: { sessions: [{ sessionId: "live-1", cwd: "/x", projectRoot: "/x", workerStatus: "ready", epoch: "epoch-live" }] },
      },
    });
    await flush();

    const command = lastFrame<{
      type: "command";
      id: string;
      payload: { sessionId: string; epoch?: string; command: { commandId: string; type: string } };
    }>(ws, "command")!;
    expect(command.payload).toMatchObject({
      sessionId: "live-1",
      epoch: "epoch-live",
      command: { commandId: "title-1", type: "generate_session_title" },
    });
    ws.serverSend({
      type: "response",
      id: command.id,
      payload: {
        sessionId: "live-1",
        ok: true,
        result: { commandId: "title-1", result: { ok: true, type: "generate_session_title", title: "Generated" } },
      },
    });
    await expect(commandP).resolves.toMatchObject({
      commandId: "title-1",
      result: { ok: true, type: "generate_session_title", title: "Generated" },
    });
    expect(ws.sent.filter((frame) => ["attach", "create"].includes((frame as { type?: string }).type ?? ""))).toHaveLength(0);
  });

  it("fails a live command closed when listRunning no longer contains the session", async () => {
    const { connection, sockets } = makeConnection();
    const ws = ready(connection, sockets, ["runtime.running-watch.v1", "runtime.epoch-rollover.v1"]);
    const commandP = connection.sendLiveSessionCommand("stopped", {
      commandId: "title-stopped",
      type: "generate_session_title",
    });
    await flush();
    const list = lastFrame<{ type: "listRunning"; id: string }>(ws, "listRunning")!;
    ws.serverSend({ type: "response", id: list.id, payload: { ok: true, result: { sessions: [] } } });
    await expect(commandP).rejects.toMatchObject({ code: "not_found", retryable: false });
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "command")).toHaveLength(0);
    expect(ws.sent.filter((frame) => ["attach", "create"].includes((frame as { type?: string }).type ?? ""))).toHaveLength(0);
  });

  it("reads stats from an already-live session without attach or Worker activation", async () => {
    const { connection, sockets } = makeConnection();
    const ws = ready(connection, sockets, ["runtime.running-watch.v1", "runtime.read-rpc.v1"]);
    const statsP = connection.getLiveSessionStats("live-1");
    await flush();
    const list = ws.sent.find((frame) => (frame as { type?: string }).type === "listRunning") as { id: string };
    ws.serverSend({
      type: "response",
      id: list.id,
      payload: {
        ok: true,
        result: { sessions: [{ sessionId: "live-1", cwd: "/x", projectRoot: "/x", workerStatus: "ready", epoch: "epoch-live" }] },
      },
    });
    await flush();
    const read = ws.sent.find((frame) => (frame as { type?: string }).type === "read") as { id: string; payload: { sessionId: string; epoch: string; read: { type: string } } };
    expect(read.payload).toEqual({ sessionId: "live-1", epoch: "epoch-live", read: { type: "get_session_stats" } });
    ws.serverSend({
      type: "read_result",
      id: read.id,
      payload: {
        sessionId: "live-1",
        epoch: "epoch-live",
        requestId: read.id,
        result: { ok: true, type: "get_session_stats", stats: { messageCount: 8, tokenCount: 52_452, contextUsage: { percent: 1.7809, contextWindow: 1_000_000, tokens: 17_809 } } },
      },
    });
    await expect(statsP).resolves.toMatchObject({ contextUsage: { percent: 1.7809, tokens: 17_809 } });
    expect(ws.sent.filter((frame) => ["attach", "create"].includes((frame as { type?: string }).type ?? ""))).toHaveLength(0);
  });

  it("bounds both live-stats stages and makes late frames inert", async () => {
    const { connection, sockets } = makeConnection();
    const ws = ready(connection, sockets, ["runtime.running-watch.v1", "runtime.read-rpc.v1"]);

    const lookupP = connection.getLiveSessionStats("slow-lookup");
    await flush();
    const lookup = lastFrame<{ type: "listRunning"; id: string }>(ws, "listRunning")!;
    vi.advanceTimersByTime(5_001);
    await expect(lookupP).rejects.toMatchObject({ code: "timeout", retryable: true });
    ws.serverSend({ type: "response", id: lookup.id, payload: { ok: true, result: { sessions: [{ sessionId: "slow-lookup", cwd: "/x", projectRoot: "/x", workerStatus: "ready", epoch: "late" }] } } });
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "read")).toHaveLength(0);

    const readP = connection.getLiveSessionStats("slow-read");
    await flush();
    const lists = ws.sent.filter((frame) => (frame as { type?: string }).type === "listRunning") as { id: string }[];
    const list = lists.at(-1)!;
    ws.serverSend({ type: "response", id: list.id, payload: { ok: true, result: { sessions: [{ sessionId: "slow-read", cwd: "/x", projectRoot: "/x", workerStatus: "ready", epoch: "e-slow" }] } } });
    await flush();
    const read = lastFrame<{ type: "read"; id: string }>(ws, "read")!;
    vi.advanceTimersByTime(5_001);
    await expect(readP).rejects.toMatchObject({ code: "timeout", retryable: true });
    ws.serverSend({ type: "read_result", id: read.id, payload: { sessionId: "slow-read", epoch: "e-slow", requestId: read.id, result: { ok: true, type: "get_session_stats", stats: { messageCount: 1 } } } });
  });

  it("fails a live stats read closed when listRunning no longer contains the selected session", async () => {
    const { connection, sockets } = makeConnection();
    const ws = ready(connection, sockets, ["runtime.running-watch.v1", "runtime.read-rpc.v1"]);
    const statsP = connection.getLiveSessionStats("stopped");
    await flush();
    const list = ws.sent.find((frame) => (frame as { type?: string }).type === "listRunning") as { id: string };
    ws.serverSend({ type: "response", id: list.id, payload: { ok: true, result: { sessions: [] } } });
    await expect(statsP).rejects.toMatchObject({ code: "not_found" });
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "read")).toHaveLength(0);
  });

  it("identity-only create sends zero attach/detach and reconnects with stable createRequestId/fresh envelope", async () => {
    const { connection, sockets } = makeConnection();
    connection.registerController("s1", port(record()));
    let ws = ready(connection, sockets);
    const create = connection.createSession({ cwd: "/x", projectRoot: "/x" });
    await flush();
    const first = ws.sent.find((frame) => (frame as { type?: string }).type === "create") as { id: string; payload: { createRequestId: string } };
    ws.serverClose(1006);
    vi.advanceTimersByTime(250);
    ws = sockets.at(-1)!;
    ws.serverOpen();
    ws.serverSend(ack());
    const retry = ws.sent.find((frame) => (frame as { type?: string }).type === "create") as { id: string; payload: { createRequestId: string } };
    expect(retry.id).not.toBe(first.id);
    expect(retry.payload.createRequestId).toBe(first.payload.createRequestId);
    ws.serverSend({ type: "response", id: retry.id, payload: { ok: true, result: { sessionId: "new", epoch: "e1", lastEventId: 3, created: true, cwd: "/x", projectRoot: "/x" } } });
    await expect(create).resolves.toMatchObject({ sessionId: "new", epoch: "e1", lastEventId: 3 });
    expect(ws.sent.filter((frame) => ["attach", "detach"].includes((frame as { type?: string }).type ?? ""))).toHaveLength(0);
  });
});

describe("RuntimeConnection — explicit activate identity", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("rejects unsupported_capability without sending activate when the feature is absent", async () => {
    const { connection, sockets } = makeConnection();
    const ws = ready(connection, sockets, ["runtime.running-watch.v1"]);
    await expect(connection.activateSession("A")).rejects.toMatchObject({ code: "unsupported_capability", retryable: false });
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "activate")).toHaveLength(0);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "attach")).toHaveLength(0);
  });

  it("does not consume a foreign or wrong-kind activate result and never auto-retries on disconnect", async () => {
    const { connection, sockets } = makeConnection();
    let ws = ready(connection, sockets, ["runtime.explicit-activate.v1"]);
    const pending = connection.activateSession("A");
    await flush();
    const activate = lastFrame<{ type: "activate"; id: string; payload: { sessionId: string } }>(ws, "activate")!;
    expect(activate.payload).toEqual({ sessionId: "A" });
    ws.serverSend({
      type: "response",
      id: activate.id,
      payload: {
        ok: true,
        result: { sessionId: "B", epoch: "eB", cwd: "/x", projectRoot: "/x", workerStatus: "ready" },
      },
    });
    ws.serverSend({
      type: "response",
      id: activate.id,
      payload: { ok: true, result: { sessionId: "A", detached: true } },
    });
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "activate")).toHaveLength(1);
    ws.serverClose(1006);
    await expect(pending).rejects.toMatchObject({ code: "unavailable", retryable: true });
    vi.advanceTimersByTime(250);
    ws = sockets.at(-1)!;
    ws.serverOpen();
    ws.serverSend(ack(["runtime.explicit-activate.v1"]));
    await flush();
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "activate")).toHaveLength(0);
  });

  it("resolves only an exact RuntimeActivateResult for the requested session", async () => {
    const { connection, sockets } = makeConnection();
    const ws = ready(connection, sockets, ["runtime.explicit-activate.v1"]);
    const pending = connection.activateSession("A");
    await flush();
    const activate = lastFrame<{ type: "activate"; id: string }>(ws, "activate")!;
    const result = { sessionId: "A", epoch: "eA", cwd: "/x", projectRoot: "/x", workerStatus: "ready" as const };
    ws.serverSend({ type: "response", id: activate.id, payload: { ok: true, result } });
    await expect(pending).resolves.toMatchObject(result);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "attach")).toHaveLength(0);
  });
});
