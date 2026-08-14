import assert from "node:assert/strict";
import test from "node:test";
import { SessiondRuntimeGateway, mapRpcError } from "../dist/index.js";

// --- fixtures -------------------------------------------------------------

const wait = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

const snapshot = (sessionId) => ({
  sessionId,
  cwd: "/p",
  projectRoot: "/p",
  state: { sessionId, isStreaming: false, isPromptRunning: false, isBashRunning: false, isCompacting: false, model: null, messageCount: 0 },
  capabilities: { capabilities: [], version: 0 },
});

const attachResponse = (sessionId) => ({
  sessionId,
  epoch: "e1",
  lastEventId: 0,
  cwd: "/p",
  projectRoot: "/p",
  workerStatus: "ready",
  resumeStatus: "snapshot",
  snapshot: snapshot(sessionId),
});

const hello = JSON.stringify({
  type: "handshake",
  payload: { protocolVersion: 1, client: { shell: "web", platform: "mac" }, features: [] },
});

// --- fakes ----------------------------------------------------------------

class FakeSession {
  constructor() {
    this.sent = [];
    this.messageListeners = new Set();
    this.closeListeners = new Set();
    this.bufferedAmount = 0;
    this.closed = null;
  }
  send(data) {
    this.sent.push(data);
  }
  close(code, reason) {
    if (this.closed) return;
    this.closed = { code: code ?? null, reason: reason ?? "" };
    const listeners = [...this.closeListeners];
    this.closeListeners.clear();
    for (const fn of listeners) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  }
  onMessage(fn) {
    this.messageListeners.add(fn);
    return () => this.messageListeners.delete(fn);
  }
  onClose(fn) {
    this.closeListeners.add(fn);
    return () => this.closeListeners.delete(fn);
  }
  receive(data) {
    for (const fn of this.messageListeners) fn(data);
  }
  lastJson() {
    return JSON.parse(this.sent[this.sent.length - 1]);
  }
  jsonAt(i) {
    return JSON.parse(this.sent[i]);
  }
}

class FakeSubscription {
  constructor(response) {
    this.response = response;
    this.onPush = null;
    let resolveClosed;
    this.closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    this._resolveClosed = resolveClosed;
    this.localClosed = false;
    this.remoteClosed = false;
  }
  close() {
    this.localClosed = true;
    this._settle();
  }
  remoteClose() {
    this.remoteClosed = true;
    this._settle();
  }
  _settle() {
    if (this._resolveClosed) {
      const r = this._resolveClosed;
      this._resolveClosed = null;
      r();
    }
  }
  deliver(push) {
    if (this.onPush) return Promise.resolve(this.onPush(push));
    return Promise.resolve();
  }
}

const rpcError = (code, message, retryable = false) => {
  const err = new Error(message);
  err.code = code;
  err.retryable = retryable;
  return err;
};

class FakeClient {
  constructor() {
    this.calls = [];
    this.handlers = {};
    this.attachFn = null;
  }
  async call(method, params) {
    this.calls.push({ method, params });
    if (!(method in this.handlers)) throw rpcError("internal", `no handler for ${method}`);
    const value = this.handlers[method];
    if (value instanceof Error) throw value;
    return typeof value === "function" ? value(params) : value;
  }
  async attach(params, onPush) {
    this.calls.push({ method: "runtime.attach", params });
    if (this.attachFn === null) throw rpcError("worker_unavailable", "no active worker", true);
    return this.attachFn(params, onPush);
  }
}

function makeGateway(client, options = {}) {
  return new SessiondRuntimeGateway({
    mode: "local",
    capabilities: [],
    client,
    now: () => 1_700_000_000_000,
    ...options,
  });
}

async function connect(gateway) {
  const session = new FakeSession();
  await gateway.attach(session, hello);
  return session;
}

// --- tests ----------------------------------------------------------------

test("handshake valid → handshake_ack with protocolVersion 1 and empty capabilities", async () => {
  const gw = makeGateway(new FakeClient());
  const session = await connect(gw);
  const ack = session.jsonAt(0);
  assert.equal(ack.type, "handshake_ack");
  assert.equal(ack.payload.protocolVersion, 1);
  assert.equal(ack.payload.host.mode, "local");
  assert.deepEqual(ack.payload.host.capabilities, []);
  assert.equal(ack.payload.sessionSnapshotSupport, true);
  assert.equal(typeof ack.payload.serverTime, "number");
});

test("handshake rejects bad JSON / version mismatch with close 1008", async () => {
  const gw = makeGateway(new FakeClient());
  for (const bad of ["not-json", JSON.stringify({ type: "handshake", payload: { protocolVersion: 99, client: { shell: "web", platform: "mac" } } })]) {
    const session = new FakeSession();
    await gw.attach(session, bad);
    assert.equal(session.closed.code, 1008);
    assert.equal(session.lastJson().type, "handshake_reject");
  }
});

// --- X1: dynamic capability resolver (WS == HTTP projection) -----------------

const repeatHello = JSON.stringify({
  type: "handshake",
  payload: { protocolVersion: 1, client: { shell: "web", platform: "mac" }, features: [] },
});

test("capability resolver: healthy sessiond → handshake advertises [\"agent\"]", async () => {
  const gw = makeGateway(new FakeClient(), {
    resolveCapabilities: async () => ["agent"],
  });
  const session = await connect(gw);
  const ack = session.jsonAt(0);
  assert.equal(ack.type, "handshake_ack");
  assert.deepEqual(ack.payload.host.capabilities, ["agent"]);
});

test("capability resolver: sessiond down → handshake advertises []", async () => {
  const gw = makeGateway(new FakeClient(), {
    resolveCapabilities: async () => [],
  });
  const session = await connect(gw);
  const ack = session.jsonAt(0);
  assert.deepEqual(ack.payload.host.capabilities, []);
});

test("capability resolver: throw → [] with sanitized warn and no client-facing leak", async () => {
  const warned = [];
  const gw = makeGateway(new FakeClient(), {
    resolveCapabilities: async () => {
      throw new Error("ECONNREFUSED /Users/secret/.pi/sessiond.sock");
    },
    logger: { warn: (msg, fields) => warned.push({ msg, fields }) },
  });
  const session = await connect(gw);
  const ack = session.jsonAt(0);
  // fail closed: no capabilities advertised
  assert.deepEqual(ack.payload.host.capabilities, []);
  // a single sanitized warning was logged without resolver details
  assert.equal(warned.length, 1);
  assert.match(warned[0].msg, /capability resolver failed/);
  assert.equal(warned[0].fields, undefined);
  assert.equal(JSON.stringify(warned).includes("/Users/secret"), false);
  // the ack frame sent to the client must NOT carry the secret/path
  assert.equal(JSON.stringify(ack).includes("/Users/secret"), false);
});

test("capability resolver runs once per connection; repeated handshake reuses the result (no drift)", async () => {
  let calls = 0;
  const gw = makeGateway(new FakeClient(), {
    resolveCapabilities: async () => {
      calls += 1;
      return ["agent"];
    },
  });
  const session1 = await connect(gw);
  assert.equal(calls, 1);
  assert.deepEqual(session1.jsonAt(0).payload.host.capabilities, ["agent"]);

  // a second connection resolves again (per-connection, not per-gateway)
  const session2 = await connect(gw);
  assert.equal(calls, 2);

  // a repeated handshake WITHIN session1 must NOT re-resolve and must echo the
  // same connection-scoped answer (no static-then-async correction, no drift).
  session1.receive(repeatHello);
  await wait();
  assert.equal(calls, 2, "repeated handshake must not re-invoke the resolver");
  const reAck = session1.lastJson();
  assert.equal(reAck.type, "handshake_ack");
  assert.deepEqual(reAck.payload.host.capabilities, ["agent"]);
});

test("no capability resolver → static capabilities advertised unchanged (back-compat)", async () => {
  const gw = makeGateway(new FakeClient(), { capabilities: ["agent", "files"] });
  const session = await connect(gw);
  const ack = session.jsonAt(0);
  assert.deepEqual(ack.payload.host.capabilities, ["agent", "files"]);
});

test("malformed subsequent frame closes 1008", async () => {
  const gw = makeGateway(new FakeClient());
  const session = await connect(gw);
  session.receive("not-json");
  await wait();
  assert.equal(session.closed.code, 1008);
});

test("schema-invalid subsequent frame closes 1008", async () => {
  const gw = makeGateway(new FakeClient());
  const session = await connect(gw);
  session.receive(JSON.stringify({ type: "create", payload: {} })); // missing id + cwd
  await wait();
  assert.equal(session.closed.code, 1008);
});

test("create routes to runtime.create and echoes the result", async () => {
  const client = new FakeClient();
  client.handlers["runtime.create"] = { sessionId: "s1", epoch: "e1", created: true, cwd: "/p", projectRoot: "/p", workerStatus: "ready" };
  const session = await connect(makeGateway(client));
  session.receive(JSON.stringify({ type: "create", id: "c1", payload: { createRequestId: "cr1", cwd: "/p", projectRoot: "/p" } }));
  await wait();
  assert.deepEqual(client.calls[0], { method: "runtime.create", params: { createRequestId: "cr1", cwd: "/p", projectRoot: "/p" } });
  const res = session.lastJson();
  assert.equal(res.type, "response");
  assert.equal(res.id, "c1");
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.result.sessionId, "s1");
});

test("create RPC error is mapped to a sanitized response error", async () => {
  const client = new FakeClient();
  client.handlers["runtime.create"] = rpcError("session_busy", "busy here", true);
  const session = await connect(makeGateway(client));
  session.receive(JSON.stringify({ type: "create", id: "c1", payload: { createRequestId: "cr1", cwd: "/p", projectRoot: "/p" } }));
  await wait();
  const res = session.lastJson();
  assert.equal(res.payload.ok, false);
  assert.equal(res.payload.error.code, "session_busy");
  assert.equal(res.payload.error.retryable, true);
});

test("command uses commandId as response id when WS id is absent", async () => {
  const client = new FakeClient();
  client.handlers["runtime.command"] = { commandId: "cmd-9", result: { ok: true, type: "prompt" } };
  const session = await connect(makeGateway(client));
  session.receive(JSON.stringify({ type: "command", payload: { sessionId: "s1", command: { commandId: "cmd-9", type: "prompt", message: "hello" } } }));
  await wait();
  const res = session.lastJson();
  assert.equal(res.id, "cmd-9");
  assert.equal(res.payload.result.commandId, "cmd-9");
});

test("getSnapshot routes to runtime.getSnapshot and returns the snapshot", async () => {
  const client = new FakeClient();
  client.handlers["runtime.getSnapshot"] = snapshot("s1");
  const session = await connect(makeGateway(client));
  session.receive(JSON.stringify({ type: "getSnapshot", id: "g1", payload: { sessionId: "s1" } }));
  await wait();
  const res = session.lastJson();
  assert.equal(res.id, "g1");
  assert.equal(res.payload.result.sessionId, "s1");
});

test("stop routes to runtime.stop and closes the matching attach subscription", async () => {
  const client = new FakeClient();
  client.handlers["runtime.stop"] = { sessionId: "s1", stopped: true };
  const sub = new FakeSubscription(attachResponse("s1"));
  client.attachFn = (_p, onPush) => {
    sub.onPush = onPush;
    return sub;
  };
  const session = await connect(makeGateway(client));
  session.receive(JSON.stringify({ type: "attach", id: "a1", payload: { sessionId: "s1" } }));
  await wait();
  assert.equal(sub.localClosed, false);
  session.receive(JSON.stringify({ type: "stop", id: "st1", payload: { sessionId: "s1" } }));
  await wait();
  assert.equal(session.lastJson().payload.result.stopped, true);
  assert.equal(sub.localClosed, true);
});

test("interrupt translates the R0 correlated result into interrupt_result keeping ids", async () => {
  const client = new FakeClient();
  client.handlers["runtime.interrupt"] = { commandId: "ci1", result: { ok: true, type: "abort" } };
  const session = await connect(makeGateway(client));
  session.receive(JSON.stringify({ type: "interrupt", id: "i1", payload: { sessionId: "s1", commandId: "ci1", interrupt: { type: "abort" } } }));
  await wait();
  assert.deepEqual(client.calls[0], { method: "runtime.interrupt", params: { sessionId: "s1", commandId: "ci1", interrupt: { type: "abort" } } });
  const res = session.lastJson();
  assert.equal(res.type, "interrupt_result");
  assert.equal(res.id, "i1");
  assert.equal(res.payload.sessionId, "s1");
  assert.equal(res.payload.commandId, "ci1");
  assert.equal(res.payload.interruptType, "abort");
  assert.equal(res.payload.result.ok, true);
});

test("cold attach → activate → retry attach (open semantics)", async () => {
  const client = new FakeClient();
  client.handlers["runtime.activate"] = { sessionId: "s1", epoch: "e1", cwd: "/p", projectRoot: "/p", workerStatus: "ready" };
  const sub = new FakeSubscription(attachResponse("s1"));
  let attachAttempts = 0;
  client.attachFn = (_p, onPush) => {
    attachAttempts += 1;
    if (attachAttempts === 1) throw rpcError("worker_unavailable", "no active worker", true);
    sub.onPush = onPush;
    return sub;
  };
  const session = await connect(makeGateway(client));
  session.receive(JSON.stringify({ type: "attach", id: "a1", payload: { sessionId: "s1" } }));
  await wait();
  assert.equal(attachAttempts, 2);
  const methods = client.calls.map((c) => c.method);
  assert.deepEqual(methods, ["runtime.attach", "runtime.activate", "runtime.attach"]);
  assert.ok(session.sent.some((f) => JSON.parse(f).type === "snapshot"));
});

test("cold attach invalid session surfaces runtime_unavailable (activate not_found)", async () => {
  const client = new FakeClient();
  client.handlers["runtime.activate"] = rpcError("not_found", "session not found: sX");
  client.attachFn = () => {
    throw rpcError("worker_unavailable", "no active worker", true);
  };
  const session = await connect(makeGateway(client));
  session.receive(JSON.stringify({ type: "attach", id: "a1", payload: { sessionId: "sX" } }));
  await wait();
  const res = session.lastJson();
  assert.equal(res.type, "response");
  assert.equal(res.id, "a1");
  assert.equal(res.payload.ok, false);
  assert.equal(res.payload.error.code, "not_found");
});

test("initial snapshot is sent before replay/live events", async () => {
  const client = new FakeClient();
  const sub = new FakeSubscription(attachResponse("s1"));
  client.attachFn = (_p, onPush) => {
    sub.onPush = onPush;
    return sub;
  };
  const session = await connect(makeGateway(client));
  session.receive(JSON.stringify({ type: "attach", id: "a1", payload: { sessionId: "s1" } }));
  await wait();
  // snapshot already sent; now a live event arrives and must follow it
  assert.equal(session.sent.slice(1).map((f) => JSON.parse(f).type)[0], "snapshot");
  sub.deliver({ type: "event", event: { type: "prompt_done", eventId: 1, sessionId: "s1", epoch: "e1" } });
  await wait();
  const types = session.sent.slice(1).map((f) => JSON.parse(f).type);
  assert.equal(types[0], "snapshot");
  assert.equal(types[1], "event");
});

test("session switch: old subscription closed intentionally + best-effort detach", async () => {
  const client = new FakeClient();
  client.handlers["runtime.detach"] = { sessionId: "s1", detached: true };
  const sub1 = new FakeSubscription(attachResponse("s1"));
  const sub2 = new FakeSubscription(attachResponse("s2"));
  let n = 0;
  client.attachFn = (_p, onPush) => {
    n += 1;
    const sub = n === 1 ? sub1 : sub2;
    sub.onPush = onPush;
    return sub;
  };
  const session = await connect(makeGateway(client));
  session.receive(JSON.stringify({ type: "attach", id: "a1", payload: { sessionId: "s1" } }));
  await wait();
  assert.equal(sub1.localClosed, false);
  session.receive(JSON.stringify({ type: "attach", id: "a2", payload: { sessionId: "s2" } }));
  await wait();
  assert.equal(sub1.localClosed, true);
  assert.ok(client.calls.some((c) => c.method === "runtime.detach" && c.params.sessionId === "s1"));
  assert.ok(!session.closed);
});

test("late push from a superseded subscription is dropped", async () => {
  const client = new FakeClient();
  const sub1 = new FakeSubscription(attachResponse("s1"));
  const sub2 = new FakeSubscription(attachResponse("s2"));
  let n = 0;
  client.attachFn = (_p, onPush) => {
    n += 1;
    const sub = n === 1 ? sub1 : sub2;
    sub.onPush = onPush;
    return sub;
  };
  const session = await connect(makeGateway(client));
  session.receive(JSON.stringify({ type: "attach", id: "a1", payload: { sessionId: "s1" } }));
  await wait();
  session.receive(JSON.stringify({ type: "attach", id: "a2", payload: { sessionId: "s2" } }));
  await wait();
  const before = session.sent.length;
  sub1.deliver({ type: "event", event: { type: "prompt_done", eventId: 99, sessionId: "s1", epoch: "e1" } });
  await wait();
  assert.equal(session.sent.length, before);
});

test("browser close: unsubscribes + best-effort detach, never runtime.stop", async () => {
  const client = new FakeClient();
  client.handlers["runtime.detach"] = { sessionId: "s1", detached: true };
  const sub = new FakeSubscription(attachResponse("s1"));
  client.attachFn = (_p, onPush) => {
    sub.onPush = onPush;
    return sub;
  };
  const session = await connect(makeGateway(client));
  session.receive(JSON.stringify({ type: "attach", id: "a1", payload: { sessionId: "s1" } }));
  await wait();
  session.close();
  await wait();
  assert.equal(sub.localClosed, true);
  assert.ok(client.calls.some((c) => c.method === "runtime.detach"));
  assert.ok(!client.calls.some((c) => c.method === "runtime.stop"));
});

test("unexpected attach stream close → runtime_unavailable + browser close 1011", async () => {
  const client = new FakeClient();
  const sub = new FakeSubscription(attachResponse("s1"));
  client.attachFn = (_p, onPush) => {
    sub.onPush = onPush;
    return sub;
  };
  const session = await connect(makeGateway(client));
  session.receive(JSON.stringify({ type: "attach", id: "a1", payload: { sessionId: "s1" } }));
  await wait();
  sub.remoteClose();
  await wait();
  assert.ok(session.sent.some((f) => JSON.parse(f).type === "runtime_unavailable"));
  assert.equal(session.closed.code, 1011);
});

test("detach without id sends no response; with id sends detached result", async () => {
  const client = new FakeClient();
  client.handlers["runtime.detach"] = { sessionId: "s1", detached: true };
  const sub = new FakeSubscription(attachResponse("s1"));
  client.attachFn = (_p, onPush) => {
    sub.onPush = onPush;
    return sub;
  };
  const session = await connect(makeGateway(client));
  session.receive(JSON.stringify({ type: "attach", id: "a1", payload: { sessionId: "s1" } }));
  await wait();
  const before = session.sent.length;
  session.receive(JSON.stringify({ type: "detach", payload: { sessionId: "s1" } }));
  await wait();
  assert.equal(session.sent.length, before);
  assert.equal(sub.localClosed, true);
});

test("outbound overflow fail-closes the browser socket (1009)", async () => {
  const client = new FakeClient();
  const sub = new FakeSubscription(attachResponse("s1"));
  client.attachFn = (_p, onPush) => {
    sub.onPush = onPush;
    return sub;
  };
  const gw = makeGateway(client, { outbound: { maxFrames: 1024, maxBytes: 1024 * 1024, maxBufferedAmount: 1024 } });
  const session = await connect(gw);
  session.receive(JSON.stringify({ type: "attach", id: "a1", payload: { sessionId: "s1" } }));
  await wait();
  // Simulate a backed-up raw socket so flush() detects bufferedAmount overflow.
  session.bufferedAmount = 10 * 1024;
  for (let i = 0; i < 5; i += 1) {
    sub.deliver({ type: "event", event: { type: "prompt_done", eventId: i + 1, sessionId: "s1", epoch: "e1" } });
  }
  await wait(20);
  assert.equal(session.closed.code, 1009);
});

test("mapRpcError sanitizes unknown errors and never leaks stack/secret", async () => {
  const mapped = mapRpcError(new Error("ECONNREFUSED /Users/secret/.pi/socket"));
  assert.equal(mapped.code, "unavailable");
  assert.equal(mapped.message, "sessiond request failed");
  assert.equal(mapped.retryable, false);
  const structured = mapRpcError(rpcError("timeout", "rpc timed out", true));
  assert.equal(structured.code, "timeout");
  assert.equal(structured.retryable, true);
});

test("mapRpcError rejects an unknown code (sanitized, not echoed)", async () => {
  const mapped = mapRpcError({ code: "definitely_not_a_protocol_code", message: "x", retryable: true });
  assert.equal(mapped.code, "unavailable");
});

// --- C1 audit: snapshot id correlation + command transparency ----------------

const snapshotPush = (sessionId) => ({
  type: "snapshot",
  sessionId,
  epoch: "e2",
  lastEventId: 5,
  cwd: "/p",
  projectRoot: "/p",
  workerStatus: "ready",
  snapshot: snapshot(sessionId),
  resumeStatus: "snapshot",
});

test("initial attach snapshot echoes the attach request id", async () => {
  const client = new FakeClient();
  const sub = new FakeSubscription(attachResponse("s1"));
  client.attachFn = (_p, onPush) => {
    sub.onPush = onPush;
    return sub;
  };
  const session = await connect(makeGateway(client));
  session.receive(JSON.stringify({ type: "attach", id: "req-att-1", payload: { sessionId: "s1" } }));
  await wait();
  const initial = session.sent.slice(1).map((f) => JSON.parse(f)).find((m) => m.type === "snapshot");
  assert.ok(initial, "expected an initial snapshot");
  assert.equal(initial.id, "req-att-1");
});

test("replay/live sessiond push snapshots do NOT carry an id", async () => {
  const client = new FakeClient();
  const sub = new FakeSubscription(attachResponse("s1"));
  client.attachFn = (_p, onPush) => {
    sub.onPush = onPush;
    return sub;
  };
  const session = await connect(makeGateway(client));
  session.receive(JSON.stringify({ type: "attach", id: "req-att-1", payload: { sessionId: "s1" } }));
  await wait();
  // initial snapshot has id; a later push snapshot must be id-less
  sub.deliver(snapshotPush("s1"));
  await wait();
  const snapshots = session.sent.slice(1).map((f) => JSON.parse(f)).filter((m) => m.type === "snapshot");
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].id, "req-att-1");
  assert.equal(snapshots[1].id, undefined);
});

test("superseded attach late snapshot push is dropped (cannot resolve new pending)", async () => {
  const client = new FakeClient();
  const sub1 = new FakeSubscription(attachResponse("s1"));
  const sub2 = new FakeSubscription(attachResponse("s2"));
  let n = 0;
  client.attachFn = (_p, onPush) => {
    n += 1;
    const sub = n === 1 ? sub1 : sub2;
    sub.onPush = onPush;
    return sub;
  };
  const session = await connect(makeGateway(client));
  session.receive(JSON.stringify({ type: "attach", id: "req-a", payload: { sessionId: "s1" } }));
  await wait();
  session.receive(JSON.stringify({ type: "attach", id: "req-b", payload: { sessionId: "s2" } }));
  await wait();
  const before = session.sent.length;
  // late snapshot push from the superseded subscription must not be forwarded
  sub1.deliver(snapshotPush("s1"));
  await wait();
  assert.equal(session.sent.length, before);
});

test("command commandId is forwarded unchanged (at-most-once owned by sessiond)", async () => {
  const client = new FakeClient();
  client.handlers["runtime.command"] = (params) => ({ commandId: params.command.commandId, result: { ok: true, type: "prompt" } });
  const session = await connect(makeGateway(client));
  session.receive(JSON.stringify({ type: "command", id: "ws-1", payload: { sessionId: "s1", command: { commandId: "cmd-orig", type: "prompt", message: "hi" } } }));
  await wait();
  // forwarded verbatim, no rewrite
  assert.equal(client.calls[0].params.command.commandId, "cmd-orig");
  const res = session.lastJson();
  assert.equal(res.id, "ws-1");
  assert.equal(res.payload.result.commandId, "cmd-orig");
});

// --- F1/F2 adversarial: bounded inbound serial queue + interrupt concurrency ---

const hang = () => new Promise(() => {});
const cmdFrame = (id) => JSON.stringify({ type: "command", id, payload: { sessionId: "s1", command: { commandId: id, type: "prompt", message: "hi" } } });
const interruptFrame = (id) => JSON.stringify({ type: "interrupt", id, payload: { sessionId: "s1", commandId: id, interrupt: { type: "abort" } } });
const okCommand = (p) => ({ commandId: p.command.commandId, result: { ok: true, type: "prompt" } });
const okInterrupt = (p) => ({ commandId: p.commandId, result: { ok: true, type: "abort" } });

test("F1: hung command queue count overflow fails closed 1009 and opens no extra RPC", async () => {
  const client = new FakeClient();
  client.handlers["runtime.command"] = () => hang();
  const gw = makeGateway(client, { inbound: { maxSerialFrames: 2, maxSerialBytes: 4 * 1024 * 1024, maxInflightInterrupts: 16 } });
  const session = await connect(gw);
  session.receive(cmdFrame("c1"));
  await wait(); // c1 dispatches and its RPC hangs
  session.receive(cmdFrame("c2")); // queued behind the hung c1 (pending = 2)
  await wait();
  session.receive(cmdFrame("c3")); // 3rd pending frame → overflow
  await wait();
  assert.equal(session.closed.code, 1009);
  // only c1 dispatched (its RPC hung); c2 was queued and short-circuited, c3 rejected — neither opened an RPC
  const cmds = client.calls.filter((c) => c.method === "runtime.command");
  assert.equal(cmds.length, 1);
});

test("F1: inbound byte overflow fails closed 1009 and opens no RPC", async () => {
  const client = new FakeClient();
  client.handlers["runtime.command"] = okCommand;
  const gw = makeGateway(client, { inbound: { maxSerialFrames: 256, maxSerialBytes: 64, maxInflightInterrupts: 16 } });
  const session = await connect(gw);
  session.receive(cmdFrame("c1")); // frame is well over 64 bytes
  await wait();
  assert.equal(session.closed.code, 1009);
  assert.equal(client.calls.filter((c) => c.method === "runtime.command").length, 0);
});

test("F1: queued task after browser close does not dispatch", async () => {
  const client = new FakeClient();
  client.handlers["runtime.command"] = () => hang();
  const gw = makeGateway(client, { inbound: { maxSerialFrames: 4, maxSerialBytes: 4 * 1024 * 1024, maxInflightInterrupts: 16 } });
  const session = await connect(gw);
  session.receive(cmdFrame("c1")); // dispatches, RPC hangs
  session.receive(cmdFrame("c2")); // queued behind c1
  await wait();
  session.close(); // browser disconnects
  await wait();
  // c2 must never dispatch — only c1 opened an RPC
  assert.equal(client.calls.filter((c) => c.method === "runtime.command").length, 1);
});

test("F1: serial counter recovers after tasks settle (new frames accepted)", async () => {
  const client = new FakeClient();
  client.handlers["runtime.command"] = okCommand;
  const gw = makeGateway(client, { inbound: { maxSerialFrames: 2, maxSerialBytes: 4 * 1024 * 1024, maxInflightInterrupts: 16 } });
  const session = await connect(gw);
  session.receive(cmdFrame("c1"));
  session.receive(cmdFrame("c2"));
  await wait(); // both settle, counter returns to 0
  session.receive(cmdFrame("c3"));
  session.receive(cmdFrame("c4"));
  await wait();
  assert.ok(!session.closed, "socket must not have closed");
  assert.equal(client.calls.filter((c) => c.method === "runtime.command").length, 4);
  assert.equal(session.sent.filter((f) => JSON.parse(f).type === "response").length, 4);
});

test("F2: in-flight interrupts are capped; N+1 closes 1008 and opens no RPC", async () => {
  const client = new FakeClient();
  client.handlers["runtime.interrupt"] = () => hang();
  const gw = makeGateway(client, { inbound: { maxSerialFrames: 256, maxSerialBytes: 4 * 1024 * 1024, maxInflightInterrupts: 2 } });
  const session = await connect(gw);
  session.receive(interruptFrame("i1"));
  session.receive(interruptFrame("i2"));
  session.receive(interruptFrame("i3")); // 3rd in-flight → cap
  await wait();
  assert.equal(session.closed.code, 1008);
  // only 2 interrupt RPCs opened; the 3rd did NOT open an RPC
  assert.equal(client.calls.filter((c) => c.method === "runtime.interrupt").length, 2);
});

test("F2: interrupt slots recover after completion (new interrupts accepted)", async () => {
  const client = new FakeClient();
  client.handlers["runtime.interrupt"] = okInterrupt;
  const gw = makeGateway(client, { inbound: { maxSerialFrames: 256, maxSerialBytes: 4 * 1024 * 1024, maxInflightInterrupts: 2 } });
  const session = await connect(gw);
  session.receive(interruptFrame("i1"));
  session.receive(interruptFrame("i2"));
  await wait(); // both resolve, slots free
  session.receive(interruptFrame("i3"));
  session.receive(interruptFrame("i4"));
  await wait();
  assert.ok(!session.closed);
  assert.equal(client.calls.filter((c) => c.method === "runtime.interrupt").length, 4);
  assert.equal(session.sent.filter((f) => JSON.parse(f).type === "interrupt_result").length, 4);
});

test("F2: browser close / late completion sends no interrupt_result", async () => {
  const client = new FakeClient();
  let resolveRpc;
  client.handlers["runtime.interrupt"] = () => new Promise((resolve) => { resolveRpc = resolve; });
  const gw = makeGateway(client, { inbound: { maxSerialFrames: 256, maxSerialBytes: 4 * 1024 * 1024, maxInflightInterrupts: 4 } });
  const session = await connect(gw);
  session.receive(interruptFrame("i1")); // RPC in flight
  await wait();
  session.close(); // browser disconnects while RPC pending
  await wait();
  resolveRpc({ commandId: "i1", result: { ok: true, type: "abort" } }); // late completion
  await wait();
  assert.equal(session.sent.filter((f) => JSON.parse(f).type === "interrupt_result").length, 0);
});

test("non-finite inbound limits fall back to safe defaults", async () => {
  const commandClient = new FakeClient();
  commandClient.handlers["runtime.command"] = () => hang();
  const commandSession = await connect(makeGateway(commandClient, {
    inbound: { maxSerialFrames: Number.NaN, maxSerialBytes: Number.POSITIVE_INFINITY, maxInflightInterrupts: 16 },
  }));
  for (let i = 0; i < 257; i += 1) commandSession.receive(cmdFrame(`nan-c${i}`));
  await wait();
  assert.equal(commandSession.closed.code, 1009);
  // The synchronous flood closes the queue before its first microtask runs,
  // so every reserved command safely short-circuits without opening an RPC.
  assert.equal(commandClient.calls.filter((c) => c.method === "runtime.command").length, 0);

  const interruptClient = new FakeClient();
  interruptClient.handlers["runtime.interrupt"] = () => hang();
  const interruptSession = await connect(makeGateway(interruptClient, {
    inbound: { maxSerialFrames: 256, maxSerialBytes: 4 * 1024 * 1024, maxInflightInterrupts: Number.NaN },
  }));
  for (let i = 0; i < 17; i += 1) interruptSession.receive(interruptFrame(`nan-i${i}`));
  await wait();
  assert.equal(interruptSession.closed.code, 1008);
  assert.equal(interruptClient.calls.filter((c) => c.method === "runtime.interrupt").length, 16);
});

test("non-finite byte and bufferedAmount limits cannot disable fail-closed bounds", async () => {
  const inboundClient = new FakeClient();
  inboundClient.handlers["runtime.command"] = okCommand;
  const inboundSession = await connect(makeGateway(inboundClient, {
    inbound: { maxSerialFrames: 256, maxSerialBytes: Number.NaN, maxInflightInterrupts: 16 },
  }));
  const oversized = JSON.stringify({
    type: "command",
    id: "large",
    payload: { sessionId: "s1", command: { commandId: "large", type: "prompt", message: "x".repeat(4 * 1024 * 1024) } },
  });
  inboundSession.receive(oversized);
  await wait();
  assert.equal(inboundSession.closed.code, 1009);
  assert.equal(inboundClient.calls.filter((c) => c.method === "runtime.command").length, 0);

  const outboundClient = new FakeClient();
  outboundClient.handlers["runtime.command"] = okCommand;
  const outboundSession = await connect(makeGateway(outboundClient, {
    outbound: { maxBufferedAmount: Number.NaN },
  }));
  outboundSession.bufferedAmount = 4 * 1024 * 1024 + 1;
  outboundSession.receive(cmdFrame("buffered"));
  await wait();
  assert.equal(outboundSession.closed.code, 1009);
});

// --- D2-P4/P2-P8: independent interleaving lane (steer/follow_up + extension UI) ---

const steerFrame = (id) => JSON.stringify({ type: "command", id, payload: { sessionId: "s1", command: { commandId: id, type: "steer", message: "steer" } } });
const followFrame = (id) => JSON.stringify({ type: "command", id, payload: { sessionId: "s1", command: { commandId: id, type: "follow_up", message: "follow" } } });
const extensionResponseFrame = (id) => JSON.stringify({ type: "command", id, payload: { sessionId: "s1", command: { commandId: id, type: "extension_ui_response", id: "ui-1", method: "confirm", responseKind: "confirmed", confirmed: true } } });
const extensionInputFrame = (id) => JSON.stringify({ type: "command", id, payload: { sessionId: "s1", command: { commandId: id, type: "extension_ui_input", id: "ui-1", method: "input", data: "typed" } } });
const promptFrame = (id) => cmdFrame(id);
const getSnapshotFrame = (id) => JSON.stringify({ type: "getSnapshot", id, payload: { sessionId: "s1" } });
const createFrame = (id) => JSON.stringify({ type: "create", id, payload: { createRequestId: id, cwd: "/p", projectRoot: "/p" } });
const okByType = (p) => ({ commandId: p.command.commandId, result: { ok: true, type: p.command.type } });
const commandCalls = (client) => client.calls.filter((c) => c.method === "runtime.command");
const responseIds = (session) => session.sent.map((f) => JSON.parse(f)).filter((m) => m.type === "response").map((m) => m.id);

test("D2-P4: steer/follow_up dispatch on the queued-turn lane while a prompt HOLs the serial lane; responses in FIFO order", async () => {
  const client = new FakeClient();
  // prompt hangs forever on the serial lane; steer/follow resolve immediately.
  client.handlers["runtime.command"] = (p) => (p.command.type === "prompt" ? hang() : okByType(p));
  const gw = makeGateway(client, { inbound: { maxSerialFrames: 8, maxSerialBytes: 4 * 1024 * 1024, maxInflightInterrupts: 16 } });
  const session = await connect(gw);

  session.receive(promptFrame("p1")); // serial lane dispatches + RPC hangs
  await wait();
  session.receive(steerFrame("s1")); // queued-turn lane → must NOT be HOL-blocked
  await wait();
  session.receive(followFrame("f1")); // queued-turn lane FIFO after s1
  await wait();

  // steer + follow both opened an RPC while the prompt is still hanging.
  const cmds = commandCalls(client);
  assert.equal(cmds.length, 3, "prompt + steer + follow must each open an RPC");
  assert.deepEqual(cmds.map((c) => c.params.command.type).sort(), ["follow_up", "prompt", "steer"]);
  // responses for steer + follow arrived (prompt's response is still pending).
  const ids = responseIds(session);
  assert.ok(ids.includes("s1"), `responses=${ids.join(",")}`);
  assert.ok(ids.includes("f1"), `responses=${ids.join(",")}`);
  assert.ok(!ids.includes("p1"), "hung prompt must not have a response");
  // queued-turn lane is FIFO: s1 response before f1 response.
  assert.ok(ids.indexOf("s1") < ids.indexOf("f1"), `order=${ids.join(",")}`);
  assert.ok(!session.closed, "socket must stay open");
});

test("D2-P4: ordinary getSnapshot still HOLs behind a long prompt on the serial lane", async () => {
  const client = new FakeClient();
  let resolvePrompt;
  client.handlers["runtime.command"] = (p) => {
    if (p.command.type === "prompt") return new Promise((res) => { resolvePrompt = res; });
    return okByType(p);
  };
  client.handlers["runtime.getSnapshot"] = { snapshot: snapshot("s1") };
  const gw = makeGateway(client, { inbound: { maxSerialFrames: 8, maxSerialBytes: 4 * 1024 * 1024, maxInflightInterrupts: 16 } });
  const session = await connect(gw);

  session.receive(promptFrame("p1")); // serial lane dispatches + RPC pending
  await wait();
  session.receive(getSnapshotFrame("g1")); // serial lane → queued behind p1
  await wait();
  // getSnapshot must NOT open an RPC while the prompt is pending.
  assert.equal(client.calls.filter((c) => c.method === "runtime.getSnapshot").length, 0);

  resolvePrompt({ commandId: "p1", result: { ok: true, type: "prompt" } }); // prompt settles
  await wait();
  // only now does the queued getSnapshot dispatch.
  assert.equal(client.calls.filter((c) => c.method === "runtime.getSnapshot").length, 1);
  assert.ok(responseIds(session).includes("g1"));
  assert.ok(!session.closed);
});

test("D2-P4: queued-turn lane overflow fails closed 1009 and opens no extra RPC", async () => {
  const client = new FakeClient();
  client.handlers["runtime.command"] = () => hang();
  const gw = makeGateway(client, { inbound: { maxSerialFrames: 2, maxSerialBytes: 4 * 1024 * 1024, maxInflightInterrupts: 16 } });
  const session = await connect(gw);
  session.receive(steerFrame("s1")); // queued-turn lane dispatches + RPC hangs
  await wait();
  session.receive(steerFrame("s2")); // queued behind s1 (pending = 2)
  await wait();
  session.receive(steerFrame("s3")); // 3rd pending queued-turn frame → overflow
  await wait();
  assert.equal(session.closed.code, 1009);
  // only s1 dispatched (its RPC hung); s2 short-circuited, s3 rejected — no extra RPC.
  assert.equal(commandCalls(client).length, 1);
});

test("D2-P4: lane overflow logs lane + count + bytes, never the raw frame", async () => {
  const client = new FakeClient();
  client.handlers["runtime.command"] = () => hang();
  const warned = [];
  const gw = makeGateway(client, {
    inbound: { maxSerialFrames: 2, maxSerialBytes: 4 * 1024 * 1024, maxInflightInterrupts: 16 },
    logger: { warn: (msg, fields) => warned.push({ msg, fields }) },
  });
  const session = await connect(gw);
  session.receive(steerFrame("s1"));
  await wait();
  session.receive(steerFrame("s2"));
  await wait();
  session.receive(steerFrame("s3")); // overflow
  await wait();
  assert.equal(session.closed.code, 1009);
  assert.equal(warned.length, 1);
  assert.match(warned[0].msg, /inbound overflow/);
  assert.equal(warned[0].fields.lane, "interleaving");
  assert.ok(Number.isInteger(warned[0].fields.pending));
  assert.ok(Number.isInteger(warned[0].fields.bytes));
  // no raw frame body (the steer message text / frame id) leaks into the log.
  assert.equal(JSON.stringify(warned).includes("steer me"), false);
  assert.equal(JSON.stringify(warned).includes("s3"), false);
});

test("D2-P4: browser close short-circuits queued tasks on BOTH lanes (no RPC)", async () => {
  const client = new FakeClient();
  client.handlers["runtime.command"] = () => hang();
  const gw = makeGateway(client, { inbound: { maxSerialFrames: 8, maxSerialBytes: 4 * 1024 * 1024, maxInflightInterrupts: 16 } });
  const session = await connect(gw);
  session.receive(promptFrame("p1")); // serial: dispatched + RPC hangs
  session.receive(steerFrame("s1")); // queued-turn: dispatched + RPC hangs
  session.receive(promptFrame("p2")); // serial: queued behind p1
  session.receive(steerFrame("s2")); // queued-turn: queued behind s1
  await wait();
  session.close(); // browser disconnect
  await wait();
  // Only the two dispatched commands opened RPCs; queued p2/s2 short-circuit.
  assert.equal(commandCalls(client).length, 2);
});

test("D2-P4: create stays on the serial lane and never runs concurrently with a pending prompt", async () => {
  const client = new FakeClient();
  client.handlers["runtime.command"] = () => hang();
  client.handlers["runtime.create"] = { sessionId: "new", epoch: "e1", created: true, cwd: "/p", projectRoot: "/p", workerStatus: "ready" };
  const gw = makeGateway(client, { inbound: { maxSerialFrames: 8, maxSerialBytes: 4 * 1024 * 1024, maxInflightInterrupts: 16 } });
  const session = await connect(gw);
  session.receive(promptFrame("p1")); // serial lane dispatched + RPC hangs
  await wait();
  session.receive(createFrame("cr1")); // serial lane → queued behind p1
  await wait();
  // create must NOT dispatch concurrently with the hanging prompt.
  assert.equal(client.calls.filter((c) => c.method === "runtime.create").length, 0);
  assert.ok(!session.closed, "socket stays open (create is queued, not rejected)");
});

// --- D2-P8: extension UI response/input interleave on the interleaving lane ---

test("D2-P8: extension_ui_response/input dispatch on the interleaving lane while a prompt HOLs the serial lane", async () => {
  const client = new FakeClient();
  // The prompt (awaiting an extension request) hangs on the serial lane;
  // response/input resolve immediately on the interleaving lane.
  client.handlers["runtime.command"] = (p) => (p.command.type === "prompt" ? hang() : okByType(p));
  const gw = makeGateway(client, { inbound: { maxSerialFrames: 8, maxSerialBytes: 4 * 1024 * 1024, maxInflightInterrupts: 16 } });
  const session = await connect(gw);

  session.receive(promptFrame("p1")); // serial lane dispatches + RPC hangs
  await wait();
  session.receive(extensionResponseFrame("r1")); // interleaving lane → NOT HOL-blocked
  await wait();
  session.receive(extensionInputFrame("i1")); // interleaving lane FIFO after r1
  await wait();

  // response + input both opened an RPC while the prompt is still hanging.
  const cmds = commandCalls(client);
  assert.equal(cmds.length, 3, "prompt + response + input must each open an RPC");
  assert.deepEqual(
    cmds.map((c) => c.params.command.type).sort(),
    ["extension_ui_input", "extension_ui_response", "prompt"],
  );
  // Both extension responses arrived (the prompt's response is still pending).
  const ids = responseIds(session);
  assert.ok(ids.includes("r1"), `responses=${ids.join(",")}`);
  assert.ok(ids.includes("i1"), `responses=${ids.join(",")}`);
  assert.ok(!ids.includes("p1"), "hung prompt must not have a response");
  // Interleaving lane is FIFO: r1 response before i1 response.
  assert.ok(ids.indexOf("r1") < ids.indexOf("i1"), `order=${ids.join(",")}`);
  assert.ok(!session.closed, "socket must stay open");
});

test("D2-P8: ordinary getSnapshot still HOLs behind a long prompt awaiting extension UI", async () => {
  const client = new FakeClient();
  let resolvePrompt;
  client.handlers["runtime.command"] = (p) => {
    if (p.command.type === "prompt") return new Promise((res) => { resolvePrompt = res; });
    return okByType(p);
  };
  client.handlers["runtime.getSnapshot"] = { snapshot: snapshot("s1") };
  const gw = makeGateway(client, { inbound: { maxSerialFrames: 8, maxSerialBytes: 4 * 1024 * 1024, maxInflightInterrupts: 16 } });
  const session = await connect(gw);

  session.receive(promptFrame("p1")); // serial lane dispatches + RPC pending
  await wait();
  session.receive(getSnapshotFrame("g1")); // serial lane → queued behind p1
  await wait();
  assert.equal(client.calls.filter((c) => c.method === "runtime.getSnapshot").length, 0);
  resolvePrompt({ commandId: "p1", result: { ok: true, type: "prompt" } });
  await wait();
  assert.equal(client.calls.filter((c) => c.method === "runtime.getSnapshot").length, 1);
  assert.ok(responseIds(session).includes("g1"));
  assert.ok(!session.closed);
});

test("D2-P8: interleaving lane overflow fails closed 1009 and opens no extra RPC", async () => {
  const client = new FakeClient();
  client.handlers["runtime.command"] = () => hang();
  const gw = makeGateway(client, { inbound: { maxSerialFrames: 2, maxSerialBytes: 4 * 1024 * 1024, maxInflightInterrupts: 16 } });
  const session = await connect(gw);
  session.receive(extensionResponseFrame("r1")); // interleaving lane dispatches + RPC hangs
  await wait();
  session.receive(extensionInputFrame("r2")); // queued behind r1 (pending = 2)
  await wait();
  session.receive(extensionResponseFrame("r3")); // 3rd pending interleaving frame → overflow
  await wait();
  assert.equal(session.closed.code, 1009);
  // only r1 dispatched (its RPC hung); r2 short-circuited, r3 rejected — no extra RPC.
  assert.equal(commandCalls(client).length, 1);
});

test("D2-P8: extension UI flood cannot bypass the interleaving lane limits", async () => {
  const client = new FakeClient();
  client.handlers["runtime.command"] = () => hang();
  const warned = [];
  const gw = makeGateway(client, {
    inbound: { maxSerialFrames: 2, maxSerialBytes: 4 * 1024 * 1024, maxInflightInterrupts: 16 },
    logger: { warn: (msg, fields) => warned.push({ msg, fields }) },
  });
  const session = await connect(gw);
  session.receive(extensionInputFrame("f1"));
  await wait();
  session.receive(extensionInputFrame("f2"));
  await wait();
  session.receive(extensionInputFrame("f3")); // overflow
  await wait();
  assert.equal(session.closed.code, 1009);
  assert.equal(warned.length, 1);
  assert.equal(warned[0].fields.lane, "interleaving");
  // No raw UI text leaks into the overflow log.
  assert.equal(JSON.stringify(warned).includes("typed"), false);
  assert.equal(commandCalls(client).length, 1);
});

test("D2-P8: browser close short-circuits queued extension commands (no extra RPC)", async () => {
  const client = new FakeClient();
  client.handlers["runtime.command"] = () => hang();
  const gw = makeGateway(client, { inbound: { maxSerialFrames: 8, maxSerialBytes: 4 * 1024 * 1024, maxInflightInterrupts: 16 } });
  const session = await connect(gw);
  session.receive(promptFrame("p1")); // serial: dispatched + RPC hangs
  session.receive(extensionResponseFrame("r1")); // interleaving: dispatched + RPC hangs
  session.receive(extensionInputFrame("r2")); // interleaving: queued behind r1
  await wait();
  session.close();
  await wait();
  // Only the two dispatched commands opened RPCs; queued r2 short-circuits.
  assert.equal(commandCalls(client).length, 2);
});
