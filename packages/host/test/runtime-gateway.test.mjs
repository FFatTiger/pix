import assert from "node:assert/strict";
import test from "node:test";
import {
  PROTOCOL_VERSION,
  RUNTIME_EPOCH_ROLLOVER_FEATURE,
  RUNTIME_EXPLICIT_ACTIVATE_FEATURE,
  RUNTIME_OBSERVE_EXISTING_FEATURE,
  RUNTIME_READ_RPC_FEATURE,
  RUNTIME_RUNNING_WATCH_FEATURE,
  RUNTIME_SUBMIT_TURN_FEATURE,
  SESSIOND_BUILD_CAPABILITIES,
  SESSIOND_BUILD_IDENTITY,
} from "@fffattiger/pix-protocol";
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
  payload: { protocolVersion: 2, client: { shell: "web", platform: "mac" }, features: [] },
});
const watchHello = JSON.stringify({
  type: "handshake",
  payload: { protocolVersion: 2, client: { shell: "web", platform: "mac" }, features: [RUNTIME_RUNNING_WATCH_FEATURE] },
});
const readHello = JSON.stringify({
  type: "handshake",
  payload: { protocolVersion: 2, client: { shell: "web", platform: "mac" }, features: [RUNTIME_READ_RPC_FEATURE] },
});
const submitHello = JSON.stringify({
  type: "handshake",
  payload: { protocolVersion: 2, client: { shell: "web", platform: "mac" }, features: [RUNTIME_SUBMIT_TURN_FEATURE] },
});
const rolloverHello = JSON.stringify({
  type: "handshake",
  payload: { protocolVersion: 2, client: { shell: "web", platform: "mac" }, features: [RUNTIME_EPOCH_ROLLOVER_FEATURE] },
});
const observeHello = JSON.stringify({
  type: "handshake",
  payload: { protocolVersion: 2, client: { shell: "web", platform: "mac" }, features: [RUNTIME_OBSERVE_EXISTING_FEATURE] },
});
const activateHello = JSON.stringify({
  type: "handshake",
  payload: { protocolVersion: 2, client: { shell: "web", platform: "mac" }, features: [RUNTIME_EXPLICIT_ACTIVATE_FEATURE] },
});
const lifecycleHello = JSON.stringify({
  type: "handshake",
  payload: {
    protocolVersion: 2,
    client: { shell: "web", platform: "mac" },
    features: [RUNTIME_OBSERVE_EXISTING_FEATURE, RUNTIME_EXPLICIT_ACTIVATE_FEATURE],
  },
});

// --- fakes ----------------------------------------------------------------

class FakeSession {
  constructor(options = {}) {
    this.sent = [];
    this.messageListeners = new Set();
    this.closeListeners = new Set();
    this.bufferedAmount = 0;
    this.closed = null;
    this.verifyGate = Object.prototype.hasOwnProperty.call(options, "verifyGate")
      ? options.verifyGate
      : (async () => ({ ok: true }));
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
    this.watchFn = null;
    this.submitTurnFn = null;
  }
  async call(method, params, timeoutMs) {
    this.calls.push(timeoutMs === undefined ? { method, params } : { method, params, timeoutMs });
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
  async watchRunning(onPush) {
    this.calls.push({ method: "runtime.watchRunning", params: {} });
    if (this.watchFn === null) throw rpcError("unavailable", "running watch unavailable", true);
    return this.watchFn(onPush);
  }
  async submitTurn(params, onPush) {
    this.calls.push({ method: "runtime.submitTurn", params });
    if (this.submitTurnFn === null) throw rpcError("unavailable", "submit turn unavailable", true);
    return this.submitTurnFn(params, onPush);
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

function lifecycleAuthorizer(authorize) {
  return {
    calls: [],
    async authorize(request) {
      this.calls.push(request);
      return authorize(request);
    },
  };
}

function makeLifecycleGateway(client, options = {}) {
  const authorizer = options.authorizer ?? lifecycleAuthorizer(async ({ sessionId }) => ({
    ok: true,
    source: "live",
    identity: { sessionId, cwd: "/p", projectRoot: "/p", epoch: "e1" },
    access: { state: "authorized", reason: "allowed_root" },
  }));
  const { authorizer: _ignored, ...rest } = options;
  return {
    authorizer,
    gateway: makeGateway(client, {
      capabilities: ["agent"],
      runtimeWorkspaceAuthorizer: authorizer,
      ...rest,
    }),
  };
}

async function connect(gateway, handshake = hello) {
  const session = new FakeSession();
  await gateway.attach(session, handshake);
  return session;
}

// --- tests ----------------------------------------------------------------

test("handshake valid → handshake_ack with the singular PROTOCOL_VERSION and empty capabilities", async () => {
  const gw = makeGateway(new FakeClient());
  const session = await connect(gw);
  const ack = session.jsonAt(0);
  assert.equal(ack.type, "handshake_ack");
  // The runtime handshake advertises the SAME single protocol-version constant
  // the CLI uses to classify a daemon as "current" — the authority is singular.
  assert.equal(ack.payload.protocolVersion, PROTOCOL_VERSION);
  assert.equal(ack.payload.host.mode, "local");
  assert.deepEqual(ack.payload.host.capabilities, []);
  assert.equal(ack.payload.sessionSnapshotSupport, true);
  assert.equal(typeof ack.payload.serverTime, "number");
});

test("negotiated running watch sends an unattached baseline and remains independent from attach lifecycle", async () => {
  const client = new FakeClient();
  client.handlers["system.hello"] = { protocolVersion: 2, capabilities: [RUNTIME_RUNNING_WATCH_FEATURE] };
  const runningSub = new FakeSubscription({ revision: 4, sessionIds: ["A"], busySessionIds: ["A"] });
  client.watchFn = (onPush) => { runningSub.onPush = onPush; return runningSub; };
  const attachSub = new FakeSubscription(attachResponse("A"));
  client.attachFn = (_params, onPush) => { attachSub.onPush = onPush; return attachSub; };
  const session = await connect(makeGateway(client), watchHello);
  await wait();
  assert.equal(session.jsonAt(0).type, "handshake_ack");
  assert.deepEqual(session.jsonAt(0).payload.acceptedFeatures, [RUNTIME_RUNNING_WATCH_FEATURE]);
  assert.deepEqual(session.jsonAt(1), { type: "running_state", payload: { revision: 4, sessionIds: ["A"], busySessionIds: ["A"] } });

  await runningSub.deliver({ type: "running_state", state: { revision: 5, sessionIds: ["A"], busySessionIds: [] } });
  assert.deepEqual(session.lastJson(), { type: "running_state", payload: { revision: 5, sessionIds: ["A"], busySessionIds: [] } });

  session.receive(JSON.stringify({ type: "attach", id: "a1", payload: { sessionId: "A" } }));
  await wait();
  // Global watch owns running STATE, but the legacy event still consumed this
  // attach journal cursor. It must be forwarded so the Client sees contiguous
  // eventIds and does not enter a false gap → reattach loop.
  await attachSub.deliver({
    type: "event",
    event: { type: "running_sessions_changed", sessionId: "A", sessionIds: ["A"], busySessionIds: ["A"], eventId: 9, epoch: "e1" },
  });
  assert.deepEqual(session.lastJson(), {
    type: "event",
    payload: { type: "running_sessions_changed", sessionId: "A", sessionIds: ["A"], busySessionIds: ["A"], eventId: 9, epoch: "e1" },
  });

  session.receive(JSON.stringify({ type: "detach", id: "d1", payload: { sessionId: "A" } }));
  await wait();
  assert.equal(attachSub.localClosed, true);
  assert.equal(runningSub.localClosed, false, "detach closes only the per-session attach");
  session.close(1000, "done");
  assert.equal(runningSub.localClosed, true, "browser close owns and closes the global watch");
});

test("Phase 5B: negotiated epoch rollover marks attach and requires/forwards exact command + interrupt epochs", async () => {
  const client = new FakeClient();
  client.handlers["system.hello"] = { protocolVersion: 2, capabilities: [RUNTIME_EPOCH_ROLLOVER_FEATURE] };
  client.handlers["runtime.command"] = ({ command }) => ({ commandId: command.commandId, result: { ok: true, type: command.type } });
  client.handlers["runtime.interrupt"] = ({ commandId, interrupt }) => ({ commandId, result: { ok: true, type: interrupt.type } });
  const attachSub = new FakeSubscription(attachResponse("s1"));
  client.attachFn = (_params, onPush) => { attachSub.onPush = onPush; return attachSub; };
  const session = await connect(makeGateway(client), rolloverHello);
  assert.deepEqual(session.jsonAt(0).payload.acceptedFeatures, [RUNTIME_EPOCH_ROLLOVER_FEATURE]);

  session.receive(JSON.stringify({ type: "attach", id: "a1", payload: { sessionId: "s1" } }));
  await wait();
  assert.equal(client.calls.find((call) => call.method === "runtime.attach").params.supportsEpochRollover, true);

  session.receive(JSON.stringify({ type: "command", id: "missing", payload: { sessionId: "s1", command: { type: "set_auto_retry", commandId: "c0", enabled: true } } }));
  await wait();
  assert.equal(session.lastJson().payload.error.code, "invalid_input");
  assert.equal(client.calls.filter((call) => call.method === "runtime.command").length, 0);

  session.receive(JSON.stringify({ type: "command", id: "exact", payload: { sessionId: "s1", epoch: "e1", command: { type: "set_auto_retry", commandId: "c1", enabled: true } } }));
  await wait();
  assert.equal(client.calls.find((call) => call.method === "runtime.command").params.epoch, "e1");

  session.receive(JSON.stringify({ type: "interrupt", id: "i1", payload: { sessionId: "s1", commandId: "ic1", epoch: "e1", interrupt: { type: "abort" } } }));
  await wait();
  assert.equal(client.calls.find((call) => call.method === "runtime.interrupt").params.epoch, "e1");
});

test("Phase 2B: negotiated read RPC forwards strict identity with the short read timeout", async () => {
  const client = new FakeClient();
  client.handlers["system.hello"] = { protocolVersion: 2, capabilities: [RUNTIME_READ_RPC_FEATURE] };
  client.handlers["runtime.read"] = (params) => ({
    sessionId: params.sessionId,
    epoch: params.epoch,
    requestId: params.requestId,
    result: { ok: true, type: "get_commands", commands: [] },
  });
  const session = await connect(makeGateway(client, { readTimeoutMs: 1_234 }), readHello);
  assert.deepEqual(session.jsonAt(0).payload.acceptedFeatures, [RUNTIME_READ_RPC_FEATURE]);

  session.receive(JSON.stringify({
    type: "read",
    id: "read-1",
    payload: { sessionId: "s1", epoch: "e1", read: { type: "get_commands" } },
  }));
  await wait();

  const call = client.calls.find((entry) => entry.method === "runtime.read");
  assert.deepEqual(call, {
    method: "runtime.read",
    params: { sessionId: "s1", epoch: "e1", requestId: "read-1", read: { type: "get_commands" } },
    timeoutMs: 1_234,
  });
  assert.deepEqual(session.lastJson(), {
    type: "read_result",
    id: "read-1",
    payload: { sessionId: "s1", epoch: "e1", requestId: "read-1", result: { ok: true, type: "get_commands", commands: [] } },
  });
});

test("Phase 2B: unnegotiated read frames fail closed without opening runtime.read", async () => {
  const client = new FakeClient();
  const session = await connect(makeGateway(client));
  session.receive(JSON.stringify({
    type: "read",
    id: "read-1",
    payload: { sessionId: "s1", epoch: "e1", read: { type: "get_commands" } },
  }));
  await wait();
  assert.equal(session.closed.code, 1008);
  assert.equal(client.calls.some((entry) => entry.method === "runtime.read"), false);
});

test("Phase 2B: negotiated connections reject legacy read commands without opening runtime.command", async () => {
  const client = new FakeClient();
  client.handlers["system.hello"] = { protocolVersion: 2, capabilities: [RUNTIME_READ_RPC_FEATURE] };
  const session = await connect(makeGateway(client), readHello);
  session.receive(JSON.stringify({
    type: "command",
    id: "legacy-read",
    payload: { sessionId: "s1", command: { commandId: "legacy-read", type: "get_commands" } },
  }));
  await wait();
  assert.deepEqual(session.lastJson(), {
    type: "response",
    id: "legacy-read",
    payload: { ok: false, error: { code: "invalid_command", message: "read commands must use the read envelope on this connection", retryable: false } },
  });
  assert.equal(client.calls.some((entry) => entry.method === "runtime.command"), false);
});

test("running watch is not negotiated when sessiond lacks support", async () => {
  const client = new FakeClient();
  client.handlers["system.hello"] = { protocolVersion: 2, capabilities: ["runtime.authority"] };
  const session = await connect(makeGateway(client), watchHello);
  assert.equal(session.jsonAt(0).payload.acceptedFeatures, undefined);
  assert.equal(client.calls.some((call) => call.method === "runtime.watchRunning"), false);
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
  payload: { protocolVersion: 2, client: { shell: "web", platform: "mac" }, features: [] },
});

test("capability resolver: healthy sessiond → handshake advertises [\"agent\"]", async () => {
  const gw = makeGateway(new FakeClient(), {
    resolveCapabilities: async () => ({ sessiond: "up", capabilities: ["agent"] }),
  });
  const session = await connect(gw);
  const ack = session.jsonAt(0);
  assert.equal(ack.type, "handshake_ack");
  assert.deepEqual(ack.payload.host.capabilities, ["agent"]);
});

test("capability resolver: sessiond down → handshake advertises []", async () => {
  const gw = makeGateway(new FakeClient(), {
    resolveCapabilities: async () => ({ sessiond: "down", capabilities: [] }),
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
      return { sessiond: "up", capabilities: ["agent"] };
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

test("command RPC gets the long command timeout; control-plane calls keep the default", async () => {
  const client = new FakeClient();
  client.handlers["runtime.command"] = (p) => ({ commandId: p.command.commandId, result: { ok: true, type: "prompt" } });
  const session = await connect(makeGateway(client));
  session.receive(JSON.stringify({ type: "command", id: "ws-1", payload: { sessionId: "s1", command: { commandId: "c1", type: "prompt", message: "hi" } } }));
  await wait();
  const cmdCall = client.calls.find((c) => c.method === "runtime.command");
  assert.equal(cmdCall.timeoutMs, 30 * 60 * 1_000);
  // create stays on the default (no per-call override).
  client.handlers["runtime.create"] = { sessionId: "s1", epoch: "e1", created: true, cwd: "/x", projectRoot: "/x", workerStatus: "ready" };
  session.receive(JSON.stringify({ type: "create", id: "c1", payload: { createRequestId: "r1", cwd: "/x", projectRoot: "/x" } }));
  await wait();
  const createCall = client.calls.find((c) => c.method === "runtime.create");
  assert.equal(createCall.timeoutMs, undefined);
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

test("listRunning routes to runtime.listRunning without attaching a worker", async () => {
  const client = new FakeClient();
  client.handlers["runtime.listRunning"] = {
    sessions: [
      { sessionId: "s1", cwd: "/p", projectRoot: "/p", workerStatus: "busy", epoch: "e1" },
    ],
  };
  const session = await connect(makeGateway(client));
  session.receive(JSON.stringify({ type: "listRunning", id: "lr1", payload: {} }));
  await wait();
  assert.deepEqual(client.calls[0], { method: "runtime.listRunning", params: {} });
  const res = session.lastJson();
  assert.equal(res.id, "lr1");
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.result.sessions[0].sessionId, "s1");
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

// --- Phase 2: read lane + D2-P4/P2-P8 interleaving lane ---------------------

const getCommandsFrame = (id) => JSON.stringify({ type: "command", id, payload: { sessionId: "s1", command: { commandId: id, type: "get_commands" } } });
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

test("Phase 2: read commands use the read lane while a prompt HOLs the mutation lane", async () => {
  const client = new FakeClient();
  client.handlers["runtime.command"] = (p) => (p.command.type === "prompt" ? hang() : okByType(p));
  const gw = makeGateway(client, { inbound: { maxSerialFrames: 8, maxSerialBytes: 4 * 1024 * 1024, maxInflightInterrupts: 16 } });
  const session = await connect(gw);

  session.receive(promptFrame("p1"));
  await wait();
  session.receive(getCommandsFrame("r1"));
  await wait();

  assert.equal(client.calls.filter((c) => c.method === "runtime.command").length, 2);
  assert.deepEqual(client.calls.filter((c) => c.method === "runtime.command").map((c) => c.params.command.type), ["prompt", "get_commands"]);
  assert.ok(responseIds(session).includes("r1"));
  assert.ok(!responseIds(session).includes("p1"));
  assert.ok(!session.closed);
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

test("Phase 2: browser close short-circuits queued tasks on mutation/read/interleaving lanes", async () => {
  const client = new FakeClient();
  client.handlers["runtime.command"] = () => hang();
  const gw = makeGateway(client, { inbound: { maxSerialFrames: 8, maxSerialBytes: 4 * 1024 * 1024, maxInflightInterrupts: 16 } });
  const session = await connect(gw);
  session.receive(promptFrame("p1")); // mutation: dispatched + RPC hangs
  session.receive(getCommandsFrame("r1")); // read: dispatched + RPC hangs
  session.receive(steerFrame("s1")); // interleaving: dispatched + RPC hangs
  session.receive(promptFrame("p2")); // mutation: queued behind p1
  session.receive(getCommandsFrame("r2")); // read: queued behind r1
  session.receive(steerFrame("s2")); // interleaving: queued behind s1
  await wait();
  session.close(); // browser disconnect
  await wait();
  // Only the three dispatched commands opened RPCs; queued p2/r2/s2 short-circuit.
  assert.equal(commandCalls(client).length, 3);
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

// --- E15: custom incremental input rides the SAME interleaving lane (no new lane) ---

const extensionCustomInputFrame = (id, data = "\u001b[A") =>
  JSON.stringify({ type: "command", id, payload: { sessionId: "s1", command: { commandId: id, type: "extension_ui_input", id: "ui-custom", method: "custom", data } } });

test("E15: custom extension_ui_input is admitted (schema) and dispatches on the interleaving lane while a prompt HOLs the serial lane; FIFO with the response", async () => {
  const client = new FakeClient();
  // The prompt (awaiting a custom extension request) hangs on the serial lane;
  // custom key data resolves immediately on the interleaving lane.
  client.handlers["runtime.command"] = (p) => (p.command.type === "prompt" ? hang() : okByType(p));
  const gw = makeGateway(client, { inbound: { maxSerialFrames: 8, maxSerialBytes: 4 * 1024 * 1024, maxInflightInterrupts: 16 } });
  const session = await connect(gw);

  session.receive(promptFrame("p1")); // serial lane dispatches + RPC hangs
  await wait();
  session.receive(extensionResponseFrame("r1")); // interleaving lane → NOT HOL-blocked
  await wait();
  session.receive(extensionCustomInputFrame("c1", "\u001b[A")); // interleaving lane FIFO after r1
  await wait();
  session.receive(extensionCustomInputFrame("c2", "\u0003")); // FIFO after c1
  await wait();

  const cmds = commandCalls(client);
  assert.equal(cmds.length, 4, "prompt + response + two custom inputs must each open an RPC");
  assert.deepEqual(
    cmds.map((c) => `${c.params.command.type}:${c.params.command.method ?? "-"}`).sort(),
    ["extension_ui_input:custom", "extension_ui_input:custom", "extension_ui_response:confirm", "prompt:-"],
  );
  const ids = responseIds(session);
  assert.ok(ids.includes("c1") && ids.includes("c2"), `responses=${ids.join(",")}`);
  assert.ok(!ids.includes("p1"), "hung prompt must not have a response");
  // Interleaving lane is FIFO: r1 → c1 → c2 responses in receive order.
  assert.ok(ids.indexOf("r1") < ids.indexOf("c1") && ids.indexOf("c1") < ids.indexOf("c2"), `order=${ids.join(",")}`);
  assert.ok(!session.closed, "socket must stay open");
});

test("E15: custom input flood cannot bypass the interleaving lane limits; raw key bytes never leak into the overflow log", async () => {
  const client = new FakeClient();
  client.handlers["runtime.command"] = () => hang();
  const warned = [];
  const gw = makeGateway(client, {
    inbound: { maxSerialFrames: 2, maxSerialBytes: 4 * 1024 * 1024, maxInflightInterrupts: 16 },
    logger: { warn: (msg, fields) => warned.push({ msg, fields }) },
  });
  const session = await connect(gw);
  session.receive(extensionCustomInputFrame("k1"));
  await wait();
  session.receive(extensionCustomInputFrame("k2"));
  await wait();
  session.receive(extensionCustomInputFrame("k3")); // 3rd pending interleaving frame → overflow
  await wait();
  assert.equal(session.closed.code, 1009);
  assert.equal(warned.length, 1);
  assert.equal(warned[0].fields.lane, "interleaving");
  // No raw key data (escape/control bytes) leaks into the overflow log.
  assert.equal(JSON.stringify(warned).includes("\\u001b"), false);
  assert.equal(JSON.stringify(warned).includes("\\u0003"), false);
  assert.equal(commandCalls(client).length, 1, "only the dispatched frame opened an RPC");
});

test("E15: browser close short-circuits queued custom input (no extra RPC); select/confirm input still rejected at the schema", async () => {
  const client = new FakeClient();
  client.handlers["runtime.command"] = () => hang();
  const gw = makeGateway(client, { inbound: { maxSerialFrames: 8, maxSerialBytes: 4 * 1024 * 1024, maxInflightInterrupts: 16 } });
  const session = await connect(gw);
  session.receive(extensionCustomInputFrame("c1")); // interleaving: dispatched + RPC hangs
  session.receive(extensionCustomInputFrame("c2")); // interleaving: queued behind c1
  await wait();
  session.close();
  await wait();
  assert.equal(commandCalls(client).length, 1, "queued c2 must short-circuit without an RPC");

  // A second connection proves the schema boundary: select/confirm methods on
  // extension_ui_input are still rejected (fail-protocol, no dispatch).
  const client2 = new FakeClient();
  client2.handlers["runtime.command"] = okByType;
  const gw2 = makeGateway(client2, { inbound: { maxSerialFrames: 8, maxSerialBytes: 4 * 1024 * 1024, maxInflightInterrupts: 16 } });
  const session2 = await connect(gw2);
  session2.receive(JSON.stringify({ type: "command", id: "bad1", payload: { sessionId: "s1", command: { commandId: "bad1", type: "extension_ui_input", id: "ui-custom", method: "confirm", data: "x" } } }));
  session2.receive(JSON.stringify({ type: "command", id: "bad2", payload: { sessionId: "s1", command: { commandId: "bad2", type: "extension_ui_input", id: "ui-custom", method: "select", data: "x" } } }));
  await wait();
  assert.ok(session2.closed, "select/confirm extension_ui_input must fail protocol");
  assert.equal(commandCalls(client2).length, 0);
});

// --- Phase 3 atomic submit-turn gateway -------------------------------------

const turnAdmission = (sessionId, operationId, epoch = "e1") => ({
  status: "accepted",
  delivery: "accepted",
  sessionId,
  epoch,
  revision: 0,
  operationId,
  turnId: "turn-1",
  snapshot: snapshot(sessionId),
  turnStatus: { sessionId, epoch, operationId, turnId: "turn-1", revision: 0, state: "admitted" },
});

function submitTurnGateway(client) {
  client.handlers["system.hello"] = { protocolVersion: 2, capabilities: [RUNTIME_SUBMIT_TURN_FEATURE] };
  return makeGateway(client);
}

test("Phase 3: negotiated submitTurn sends the admission frame BEFORE statuses and opens a status subscription", async () => {
  const client = new FakeClient();
  const sub = new FakeSubscription(turnAdmission("s1", "op-1"));
  client.submitTurnFn = (_params, onPush) => { sub.onPush = onPush; return sub; };
  const session = await connect(submitTurnGateway(client), submitHello);
  assert.deepEqual(session.jsonAt(0).payload.acceptedFeatures, [RUNTIME_SUBMIT_TURN_FEATURE]);

  session.receive(JSON.stringify({
    type: "submit_turn",
    id: "st-1",
    payload: { sessionId: "s1", prompt: "hello", operationId: "op-1", expectedEpoch: "e1", expectedRevision: 0 },
  }));
  await wait();
  // Admission frame first (strictly before any status).
  const frames = session.sent.map((raw) => JSON.parse(raw));
  const admissionFrame = frames[frames.length - 1];
  assert.equal(admissionFrame.type, "submit_turn_result");
  assert.equal(admissionFrame.id, "st-1");
  assert.equal(admissionFrame.payload.status, "accepted");

  // Live status push forwards as turn_status with the full status payload.
  await sub.deliver({ type: "turn_status", status: { sessionId: "s1", epoch: "e1", operationId: "op-1", turnId: "turn-1", revision: 1, state: "completed" } });
  await wait();
  const statusFrame = session.lastJson();
  assert.equal(statusFrame.type, "turn_status");
  assert.equal(statusFrame.payload.state, "completed");

  // A status for a WRONG operation/session is not forwarded.
  await sub.deliver({ type: "turn_status", status: { sessionId: "s1", epoch: "e1", operationId: "op-other", turnId: "turn-1", revision: 2, state: "completed" } });
  const beforeWrong = session.sent.length;
  await wait();
  assert.equal(session.sent.length, beforeWrong, "wrong-identity status must be dropped");
});

test("Phase 3: blocked ordinary serial work cannot HOL-block negotiated submit_turn on the dedicated turn lane", async () => {
  const client = new FakeClient();
  client.handlers["system.hello"] = { protocolVersion: 2, capabilities: [RUNTIME_SUBMIT_TURN_FEATURE] };
  client.handlers["runtime.getSnapshot"] = () => hang();
  const sub = new FakeSubscription(turnAdmission("s1", "op-lane"));
  client.submitTurnFn = (_params, onPush) => { sub.onPush = onPush; return sub; };
  const session = await connect(makeGateway(client), submitHello);

  // getSnapshot occupies the ordinary serial lane indefinitely.
  session.receive(getSnapshotFrame("snapshot-blocked"));
  await wait();
  assert.equal(client.calls.filter((call) => call.method === "runtime.getSnapshot").length, 1);

  // submit_turn uses the independent turn lane and must still admit promptly.
  session.receive(JSON.stringify({
    type: "submit_turn",
    id: "st-lane",
    payload: { sessionId: "s1", prompt: "hello", operationId: "op-lane", expectedEpoch: "e1", expectedRevision: 0 },
  }));
  await wait();
  const admission = session.sent.map((raw) => JSON.parse(raw)).find((frame) => frame.type === "submit_turn_result" && frame.id === "st-lane");
  assert.equal(admission?.payload.status, "accepted");
  assert.equal(responseIds(session).includes("snapshot-blocked"), false, "ordinary serial request remains blocked");
});

test("Phase 3: a blocked legacy prompt on an old connection cannot block a negotiated submit on another connection", async () => {
  const client = new FakeClient();
  client.handlers["system.hello"] = { protocolVersion: 2, capabilities: [RUNTIME_SUBMIT_TURN_FEATURE] };
  client.handlers["runtime.command"] = (params) => params.command.type === "prompt" ? hang() : okByType(params);
  const sub = new FakeSubscription(turnAdmission("s1", "op-cross-connection"));
  client.submitTurnFn = (_params, onPush) => { sub.onPush = onPush; return sub; };
  const gateway = makeGateway(client);

  const legacy = await connect(gateway, hello);
  legacy.receive(promptFrame("legacy-prompt"));
  await wait();
  assert.equal(client.calls.some((call) => call.method === "runtime.command" && call.params.command.type === "prompt"), true);
  assert.equal(responseIds(legacy).includes("legacy-prompt"), false);

  const negotiated = await connect(gateway, submitHello);
  negotiated.receive(JSON.stringify({
    type: "submit_turn",
    id: "st-cross-connection",
    payload: { sessionId: "s1", prompt: "new path", operationId: "op-cross-connection", expectedEpoch: "e1" },
  }));
  await wait();
  const admission = negotiated.sent.map((raw) => JSON.parse(raw)).find((frame) => frame.type === "submit_turn_result");
  assert.equal(admission?.payload.status, "accepted");
  assert.equal(responseIds(legacy).includes("legacy-prompt"), false, "legacy prompt is still blocked independently");
});

test("Phase 3: browser close closes the turn status subscription only (never stops the turn)", async () => {
  const client = new FakeClient();
  const sub = new FakeSubscription(turnAdmission("s1", "op-1"));
  client.submitTurnFn = (_params, onPush) => { sub.onPush = onPush; return sub; };
  const session = await connect(submitTurnGateway(client), submitHello);
  session.receive(JSON.stringify({
    type: "submit_turn",
    id: "st-1",
    payload: { sessionId: "s1", prompt: "hello", operationId: "op-1", expectedEpoch: "e1" },
  }));
  await wait();
  assert.equal(sub.localClosed, false);
  session.close(1000, "browser closed");
  await wait();
  assert.equal(sub.localClosed, true, "browser close must close the status subscription");
  assert.equal(client.calls.some((call) => call.method === "runtime.stop"), false, "browser close must never runtime.stop");
});

test("Phase 4A.0: active turn subscriptions key by exact (sessionId, operationId) — same operationId on A and B coexist", async () => {
  const client = new FakeClient();
  const subA = new FakeSubscription(turnAdmission("A", "op-shared"));
  const subB = new FakeSubscription(turnAdmission("B", "op-shared"));
  client.submitTurnFn = (params, onPush) => {
    const sub = params.sessionId === "A" ? subA : subB;
    sub.onPush = onPush;
    return sub;
  };
  const session = await connect(submitTurnGateway(client), submitHello);

  // Simultaneous submits for sessions A and B with the SAME operationId must
  // coexist (old operationId-only keying let B overwrite A's subscription).
  session.receive(JSON.stringify({ type: "submit_turn", id: "st-A", payload: { sessionId: "A", prompt: "a", operationId: "op-shared", expectedEpoch: "e1" } }));
  await wait();
  session.receive(JSON.stringify({ type: "submit_turn", id: "st-B", payload: { sessionId: "B", prompt: "b", operationId: "op-shared", expectedEpoch: "e1" } }));
  await wait();
  const admissions = session.sent.map((raw) => JSON.parse(raw)).filter((frame) => frame.type === "submit_turn_result");
  assert.deepEqual(admissions.map((frame) => frame.id).sort(), ["st-A", "st-B"]);

  // Terminal status for A forwards via A's own subscription only.
  await subA.deliver({ type: "turn_status", status: { sessionId: "A", epoch: "e1", operationId: "op-shared", turnId: "turn-1", revision: 1, state: "completed" } });
  assert.equal(session.lastJson().payload.sessionId, "A");

  // Wrong-session status on B's subscription cannot cross-route to A (dropped).
  const beforeWrong = session.sent.length;
  await subB.deliver({ type: "turn_status", status: { sessionId: "A", epoch: "e1", operationId: "op-shared", turnId: "turn-1", revision: 1, state: "completed" } });
  assert.equal(session.sent.length, beforeWrong, "wrong-session status on B must be dropped");

  // B's terminal still forwards — A's terminal did NOT remove/close B.
  await subB.deliver({ type: "turn_status", status: { sessionId: "B", epoch: "e1", operationId: "op-shared", turnId: "turn-1", revision: 1, state: "completed" } });
  assert.equal(session.lastJson().payload.sessionId, "B");

  // Browser close closes BOTH exact-owner subscriptions (old keying leaked A).
  session.close(1000, "browser closed");
  await wait();
  assert.equal(subA.localClosed, true, "browser close must close A's subscription");
  assert.equal(subB.localClosed, true, "browser close must close B's subscription");
});

test("Phase 4A.0: closing A's turn subscription removes only A — B stays registered and routable", async () => {
  const client = new FakeClient();
  const subA = new FakeSubscription(turnAdmission("A", "op-shared"));
  const subB = new FakeSubscription(turnAdmission("B", "op-shared"));
  client.submitTurnFn = (params, onPush) => {
    const sub = params.sessionId === "A" ? subA : subB;
    sub.onPush = onPush;
    return sub;
  };
  const session = await connect(submitTurnGateway(client), submitHello);
  session.receive(JSON.stringify({ type: "submit_turn", id: "st-A", payload: { sessionId: "A", prompt: "a", operationId: "op-shared", expectedEpoch: "e1" } }));
  await wait();
  session.receive(JSON.stringify({ type: "submit_turn", id: "st-B", payload: { sessionId: "B", prompt: "b", operationId: "op-shared", expectedEpoch: "e1" } }));
  await wait();

  // A's status channel ends at sessiond → its subscription closes. Only A's
  // exact composite key is removed; B must remain registered and routable.
  subA.remoteClose();
  await wait();
  await subB.deliver({ type: "turn_status", status: { sessionId: "B", epoch: "e1", operationId: "op-shared", turnId: "turn-2", revision: 2, state: "completed" } });
  assert.equal(session.lastJson().payload.sessionId, "B", "B stays routable after A's subscription closed");

  // Browser close still owns and closes B (A was already closed by sessiond).
  session.close(1000, "browser closed");
  await wait();
  assert.equal(subA.remoteClosed, true, "A was closed by sessiond");
  assert.equal(subB.localClosed, true, "browser close must close B's still-registered subscription");
});

test("Phase 3: a legacy prompt command on a negotiated connection is rejected fail-closed (no worker dispatch)", async () => {
  const client = new FakeClient();
  client.handlers["runtime.command"] = () => ({ commandId: "cc1", result: { ok: true, type: "prompt" } });
  const session = await connect(submitTurnGateway(client), submitHello);
  session.receive(JSON.stringify({
    type: "command",
    id: "c1",
    payload: { sessionId: "s1", command: { commandId: "cc1", type: "prompt", message: "hi" } },
  }));
  await wait();
  const response = session.lastJson();
  assert.equal(response.type, "response");
  assert.equal(response.payload.ok, false);
  assert.equal(response.payload.error.code, "invalid_command");
  assert.equal(client.calls.some((call) => call.method === "runtime.command"), false, "legacy prompt must never open a worker command RPC");
});

test("Phase 3: unnegotiated submit_turn frames fail closed without opening an RPC", async () => {
  const client = new FakeClient();
  const session = await connect(makeGateway(client));
  session.receive(JSON.stringify({
    type: "submit_turn",
    id: "st-1",
    payload: { sessionId: "s1", prompt: "hi", operationId: "op-1" },
  }));
  await wait();
  assert.ok(session.closed, "unnegotiated submit_turn must fail closed");
  assert.equal(client.calls.some((call) => call.method === "runtime.submitTurn"), false);
});

test("Phase 3: a submitTurn RPC failure maps to an uncertain rejection frame", async () => {
  const client = new FakeClient();
  client.handlers["system.hello"] = { protocolVersion: 2, capabilities: [RUNTIME_SUBMIT_TURN_FEATURE] };
  const gw = makeGateway(client);
  const session = await connect(gw, submitHello);
  session.receive(JSON.stringify({
    type: "submit_turn",
    id: "st-1",
    payload: { sessionId: "s1", prompt: "hi", operationId: "op-1", expectedEpoch: "e1" },
  }));
  await wait();
  const frame = session.lastJson();
  assert.equal(frame.type, "submit_turn_result");
  assert.equal(frame.payload.status, "rejected");
  assert.equal(frame.payload.delivery, "uncertain");
  assert.equal(frame.payload.operationId, "op-1");
});

function deny(code = "forbidden") {
  return { ok: false, error: { code, message: "workspace is not authorized", retryable: false } };
}

function allowLive(sessionId = "s1") {
  return {
    ok: true,
    source: "live",
    identity: { sessionId, cwd: "/p", projectRoot: "/p", epoch: "e1" },
    access: { state: "authorized", reason: "allowed_root" },
  };
}

function sideEffectMethods(client) {
  return client.calls.filter((call) => call.method === "runtime.attach" || call.method === "runtime.activate").map((call) => call.method);
}

function compatibleHello(over = {}) {
  return {
    protocolVersion: 2,
    capabilities: [...SESSIOND_BUILD_CAPABILITIES],
    build: SESSIOND_BUILD_IDENTITY,
    ...over,
  };
}

function fakeClock() {
  let now = 0;
  const timers = new Map();
  let nextId = 1;
  return {
    now: () => now,
    setTimeoutFn(fn, ms) {
      const id = nextId++;
      timers.set(id, { due: now + ms, fn });
      return id;
    },
    clearTimeoutFn(id) {
      timers.delete(id);
    },
    async advance(ms) {
      now += ms;
      const due = [...timers.entries()].filter(([, timer]) => timer.due <= now);
      for (const [id] of due) timers.delete(id);
      for (const [, timer] of due) timer.fn();
      await Promise.resolve();
    },
  };
}

test("LC-01: browser lifecycle features are advertised only when the authorizer seam and compatible hello attach/activate are wired", async () => {
  const wired = new FakeClient();
  wired.handlers["system.hello"] = compatibleHello();
  const { gateway: wiredGateway } = makeLifecycleGateway(wired);
  const wiredSession = await connect(wiredGateway, lifecycleHello);
  assert.deepEqual(wiredSession.jsonAt(0).payload.acceptedFeatures, [
    RUNTIME_OBSERVE_EXISTING_FEATURE,
    RUNTIME_EXPLICIT_ACTIVATE_FEATURE,
  ]);
  assert.equal(SESSIOND_BUILD_CAPABILITIES.includes(RUNTIME_OBSERVE_EXISTING_FEATURE), false);
  assert.equal(SESSIOND_BUILD_CAPABILITIES.includes(RUNTIME_EXPLICIT_ACTIVATE_FEATURE), false);

  const noAuthorizer = new FakeClient();
  noAuthorizer.handlers["system.hello"] = compatibleHello();
  const unadvertised = await connect(makeGateway(noAuthorizer, { capabilities: ["agent"] }), lifecycleHello);
  assert.equal(unadvertised.jsonAt(0).payload.acceptedFeatures, undefined);

  const noAgent = new FakeClient();
  noAgent.handlers["system.hello"] = compatibleHello();
  const { gateway: noAgentGateway } = makeLifecycleGateway(noAgent, { capabilities: [] });
  const noAgentSession = await connect(noAgentGateway, lifecycleHello);
  assert.equal(noAgentSession.jsonAt(0).payload.acceptedFeatures, undefined);
});

test("LC-01: raw WS existing_only without negotiated feature never attaches or activates", async () => {
  const client = new FakeClient();
  const sub = new FakeSubscription(attachResponse("s1"));
  client.attachFn = (_params, onPush) => { sub.onPush = onPush; return sub; };
  client.handlers["runtime.activate"] = { sessionId: "s1", epoch: "e1", cwd: "/p", projectRoot: "/p", workerStatus: "ready" };
  const { authorizer, gateway } = makeLifecycleGateway(client);
  const session = await connect(gateway);
  session.receive(JSON.stringify({ type: "attach", id: "a1", payload: { sessionId: "s1", attachMode: "existing_only" } }));
  await wait();
  const res = session.lastJson();
  assert.equal(res.type, "response");
  assert.equal(res.payload.ok, false);
  assert.equal(res.payload.error.code, "unsupported_capability");
  assert.deepEqual(sideEffectMethods(client), []);
  assert.equal(authorizer.calls.length, 0);
});

test("LC-01: history_only / unavailable / unknown / timeout / revoked authorized results open zero attach/activate RPC", async () => {
  const cases = [
    ["history_only", { ok: false, error: { code: "forbidden", message: "workspace is history-only", retryable: false }, access: { state: "history_only", reason: "outside_allowed_roots" } }],
    ["unavailable", { ok: false, error: { code: "unavailable", message: "workspace is unavailable", retryable: false }, access: { state: "unavailable", reason: "unresolvable" } }],
    ["unknown", { ok: false, error: { code: "not_found", message: "session was not found", retryable: false } }],
    ["lookup timeout", { ok: false, error: { code: "unavailable", message: "workspace lookup failed", retryable: false } }],
    ["revoked", { ok: false, error: { code: "forbidden", message: "workspace is not authorized", retryable: false } }],
  ];
  for (const [label, decision] of cases) {
    const client = new FakeClient();
    client.handlers["system.hello"] = compatibleHello();
    client.handlers["runtime.activate"] = { sessionId: "s1", epoch: "e1", cwd: "/p", projectRoot: "/p", workerStatus: "ready" };
    client.attachFn = () => { throw new Error(`attach must not run for ${label}`); };
    const { gateway } = makeLifecycleGateway(client, { authorizer: lifecycleAuthorizer(async () => decision) });
    const session = await connect(gateway, lifecycleHello);
    session.receive(JSON.stringify({ type: "attach", id: "obs", payload: { sessionId: "s1", attachMode: "existing_only" } }));
    session.receive(JSON.stringify({ type: "activate", id: "act", payload: { sessionId: "s1" } }));
    await wait();
    const frames = session.sent.slice(1).map((frame) => JSON.parse(frame));
    assert.equal(frames.length, 2, label);
    assert.equal(frames[0].payload.ok, false, label);
    assert.equal(frames[0].payload.error.code, decision.error.code, label);
    assert.equal(frames[1].payload.ok, false, label);
    assert.equal(frames[1].payload.error.code, decision.error.code, label);
    assert.deepEqual(sideEffectMethods(client), [], label);
  }
});

test("LC-01: worker disappears after authorized live lookup attaches once and never activates", async () => {
  const client = new FakeClient();
  client.handlers["system.hello"] = compatibleHello();
  client.handlers["runtime.activate"] = { sessionId: "s1", epoch: "e1", cwd: "/p", projectRoot: "/p", workerStatus: "ready" };
  client.attachFn = () => { throw rpcError("worker_unavailable", "worker gone", true); };
  const { authorizer, gateway } = makeLifecycleGateway(client);
  const session = await connect(gateway, observeHello);
  session.receive(JSON.stringify({ type: "attach", id: "a1", payload: { sessionId: "s1", attachMode: "existing_only" } }));
  await wait();
  assert.deepEqual(authorizer.calls, [{ sessionId: "s1", intent: "observe" }]);
  assert.deepEqual(sideEffectMethods(client), ["runtime.attach"]);
  assert.equal(session.lastJson().payload.error.code, "worker_unavailable");
});

test("LC-01: existing_only strips the browser field, attaches once, and never coldAttaches even on worker_unavailable", async () => {
  const client = new FakeClient();
  client.handlers["system.hello"] = compatibleHello();
  client.handlers["runtime.activate"] = { sessionId: "s1", epoch: "e1", cwd: "/p", projectRoot: "/p", workerStatus: "ready" };
  client.attachFn = () => { throw rpcError("worker_unavailable", "no active worker", true); };
  const { gateway } = makeLifecycleGateway(client);
  const session = await connect(gateway, observeHello);
  session.receive(JSON.stringify({
    type: "attach",
    id: "a1",
    payload: { sessionId: "s1", epoch: "e1", lastEventId: 4, attachMode: "existing_only" },
  }));
  await wait();
  const attach = client.calls.find((call) => call.method === "runtime.attach");
  assert.deepEqual(attach.params, { sessionId: "s1", epoch: "e1", lastEventId: 4 });
  assert.equal("attachMode" in attach.params, false);
  assert.deepEqual(sideEffectMethods(client), ["runtime.attach"]);
  const res = session.lastJson();
  assert.equal(res.payload.ok, false);
  assert.equal(res.payload.error.code, "worker_unavailable");
});

test("LC-01: existing_only still delivers snapshot before live events and drops superseded generation", async () => {
  const client = new FakeClient();
  client.handlers["system.hello"] = compatibleHello();
  const first = new FakeSubscription(attachResponse("s1"));
  const second = new FakeSubscription(attachResponse("s2"));
  let n = 0;
  client.attachFn = (_params, onPush) => {
    n += 1;
    const sub = n === 1 ? first : second;
    sub.onPush = onPush;
    return sub;
  };
  const { gateway } = makeLifecycleGateway(client);
  const session = await connect(gateway, observeHello);
  session.receive(JSON.stringify({ type: "attach", id: "a1", payload: { sessionId: "s1", attachMode: "existing_only" } }));
  await wait();
  session.receive(JSON.stringify({ type: "attach", id: "a2", payload: { sessionId: "s2", attachMode: "existing_only" } }));
  await wait();
  const before = session.sent.length;
  first.deliver({ type: "event", event: { type: "prompt_done", eventId: 1, sessionId: "s1", epoch: "e1" } });
  await wait();
  assert.equal(session.sent.length, before);
  second.deliver({ type: "event", event: { type: "prompt_done", eventId: 2, sessionId: "s2", epoch: "e1" } });
  await wait();
  const events = session.sent.slice(1).map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "event");
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.sessionId, "s2");
  const snapshots = session.sent.slice(1).map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "snapshot");
  assert.equal(snapshots[0].id, "a1");
  assert.equal(snapshots[1].id, "a2");
});

test("LC-01: browser close during auth await drops both attach and activate with zero side effects", async () => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const client = new FakeClient();
  client.handlers["system.hello"] = compatibleHello();
  client.attachFn = () => { throw new Error("attach after close"); };
  client.handlers["runtime.activate"] = () => { throw new Error("activate after close"); };
  const { gateway } = makeLifecycleGateway(client, {
    authorizer: lifecycleAuthorizer(async () => {
      await barrier;
      return allowLive();
    }),
  });
  const session = await connect(gateway, lifecycleHello);
  session.receive(JSON.stringify({ type: "attach", id: "a1", payload: { sessionId: "s1", attachMode: "existing_only" } }));
  session.receive(JSON.stringify({ type: "activate", id: "act1", payload: { sessionId: "s1" } }));
  await wait();
  session.close(1000, "gone");
  release();
  await wait();
  assert.deepEqual(sideEffectMethods(client), []);
});

test("LC-01: explicit activate calls runtime.activate once and returns the exact identity result", async () => {
  const client = new FakeClient();
  client.handlers["system.hello"] = compatibleHello();
  client.handlers["runtime.activate"] = {
    sessionId: "s1",
    epoch: "e9",
    cwd: "/p",
    projectRoot: "/p",
    workerStatus: "ready",
  };
  const { authorizer, gateway } = makeLifecycleGateway(client);
  const session = await connect(gateway, activateHello);
  session.receive(JSON.stringify({ type: "activate", id: "act1", payload: { sessionId: "s1" } }));
  await wait();
  assert.deepEqual(authorizer.calls, [{ sessionId: "s1", intent: "activate" }]);
  assert.deepEqual(sideEffectMethods(client), ["runtime.activate"]);
  assert.deepEqual(session.lastJson(), {
    type: "response",
    id: "act1",
    payload: {
      ok: true,
      sessionId: "s1",
      result: { sessionId: "s1", epoch: "e9", cwd: "/p", projectRoot: "/p", workerStatus: "ready" },
    },
  });
});

test("LC-01: activate result whose sessionId does not match the authorized identity is rejected", async () => {
  const client = new FakeClient();
  client.handlers["system.hello"] = compatibleHello();
  client.handlers["runtime.activate"] = {
    sessionId: "other",
    epoch: "e9",
    cwd: "/p",
    projectRoot: "/p",
    workerStatus: "ready",
  };
  const { gateway } = makeLifecycleGateway(client);
  const session = await connect(gateway, activateHello);
  session.receive(JSON.stringify({ type: "activate", id: "act1", payload: { sessionId: "s1" } }));
  await wait();
  const res = session.lastJson();
  assert.equal(res.payload.ok, false);
  assert.equal(res.payload.error.code, "internal");
});

test("LC-01: attach result cwd/projectRoot mismatch against authorized identity is rejected", async () => {
  const client = new FakeClient();
  client.handlers["system.hello"] = compatibleHello();
  const sub = new FakeSubscription({
    ...attachResponse("s1"),
    cwd: "/other",
    projectRoot: "/other",
    snapshot: snapshot("s1"),
  });
  client.attachFn = (_params, onPush) => { sub.onPush = onPush; return sub; };
  const { gateway } = makeLifecycleGateway(client);
  const session = await connect(gateway, observeHello);
  session.receive(JSON.stringify({ type: "attach", id: "a1", payload: { sessionId: "s1", attachMode: "existing_only" } }));
  await wait();
  const res = session.lastJson();
  assert.equal(res.type, "response");
  assert.equal(res.payload.ok, false);
  assert.equal(res.payload.error.code, "internal");
  assert.equal(sub.localClosed, true);
});

test("LC-01: two observers of the same session both attach independently", async () => {
  const client = new FakeClient();
  client.handlers["system.hello"] = compatibleHello();
  client.attachFn = (params, onPush) => {
    const sub = new FakeSubscription(attachResponse(params.sessionId));
    sub.onPush = onPush;
    return sub;
  };
  const { gateway } = makeLifecycleGateway(client);
  const first = await connect(gateway, observeHello);
  const second = await connect(gateway, observeHello);
  first.receive(JSON.stringify({ type: "attach", id: "a1", payload: { sessionId: "s1", attachMode: "existing_only" } }));
  second.receive(JSON.stringify({ type: "attach", id: "a2", payload: { sessionId: "s1", attachMode: "existing_only" } }));
  await wait();
  assert.equal(client.calls.filter((call) => call.method === "runtime.attach").length, 2);
  assert.equal(first.sent.slice(1).map((frame) => JSON.parse(frame)).some((frame) => frame.type === "snapshot" && frame.id === "a1"), true);
  assert.equal(second.sent.slice(1).map((frame) => JSON.parse(frame)).some((frame) => frame.type === "snapshot" && frame.id === "a2"), true);
});

test("LC-01: missing attachMode keeps the finite v2 activating path", async () => {
  const client = new FakeClient();
  client.handlers["system.hello"] = compatibleHello();
  client.handlers["runtime.activate"] = { sessionId: "s1", epoch: "e1", cwd: "/p", projectRoot: "/p", workerStatus: "ready" };
  const sub = new FakeSubscription(attachResponse("s1"));
  let attempts = 0;
  client.attachFn = (_params, onPush) => {
    attempts += 1;
    if (attempts === 1) throw rpcError("worker_unavailable", "no active worker", true);
    sub.onPush = onPush;
    return sub;
  };
  const { authorizer, gateway } = makeLifecycleGateway(client);
  const session = await connect(gateway, lifecycleHello);
  session.receive(JSON.stringify({ type: "attach", id: "a1", payload: { sessionId: "s1" } }));
  await wait();
  assert.equal(attempts, 2);
  assert.deepEqual(sideEffectMethods(client), ["runtime.attach", "runtime.activate", "runtime.attach"]);
  assert.equal(authorizer.calls.length, 0, "legacy activating attach is not the new Host-authorized envelope");
  assert.ok(session.sent.some((frame) => JSON.parse(frame).type === "snapshot"));
});

test("LC-01: incompatible sessiond hello does not advertise browser lifecycle features", async () => {
  const client = new FakeClient();
  client.handlers["system.hello"] = { protocolVersion: 2, capabilities: ["runtime.resume"] };
  const { gateway } = makeLifecycleGateway(client);
  const session = await connect(gateway, lifecycleHello);
  assert.equal(session.jsonAt(0).payload.acceptedFeatures, undefined);
});

test("LC-01: capability loss after handshake still fail-closes activate/existing_only with zero RPC", async () => {
  const client = new FakeClient();
  client.handlers["system.hello"] = compatibleHello();
  client.handlers["runtime.activate"] = { sessionId: "s1", epoch: "e1", cwd: "/p", projectRoot: "/p", workerStatus: "ready" };
  client.attachFn = () => { throw new Error("attach must not run"); };
  let agent = true;
  const { gateway } = makeLifecycleGateway(client, {
    resolveCapabilities: async () => ({ sessiond: "up", capabilities: agent ? ["agent"] : [] }),
  });
  const session = await connect(gateway, lifecycleHello);
  assert.deepEqual(session.jsonAt(0).payload.acceptedFeatures, [
    RUNTIME_OBSERVE_EXISTING_FEATURE,
    RUNTIME_EXPLICIT_ACTIVATE_FEATURE,
  ]);
  agent = false;
  session.receive(JSON.stringify({ type: "attach", id: "a1", payload: { sessionId: "s1", attachMode: "existing_only" } }));
  session.receive(JSON.stringify({ type: "activate", id: "act1", payload: { sessionId: "s1" } }));
  await wait();
  const frames = session.sent.slice(1).map((frame) => JSON.parse(frame));
  assert.equal(frames.length, 2);
  assert.equal(frames.every((frame) => frame.payload.ok === false && frame.payload.error.code === "unsupported_capability"), true);
  assert.deepEqual(sideEffectMethods(client), []);
});

test("LC-01: missing/malformed/wrong sessiond build never advertises new features and opens zero attach/activate", async () => {
  const cases = [
    ["missing", { protocolVersion: 2, capabilities: [...SESSIOND_BUILD_CAPABILITIES] }],
    ["malformed", { protocolVersion: 2, capabilities: [...SESSIOND_BUILD_CAPABILITIES], build: { extra: true } }],
    ["wrong", { protocolVersion: 2, capabilities: [...SESSIOND_BUILD_CAPABILITIES], build: { ...SESSIOND_BUILD_IDENTITY, fingerprint: "b".repeat(64) } }],
  ];
  for (const [label, hello] of cases) {
    const client = new FakeClient();
    client.handlers["system.hello"] = hello;
    client.handlers["runtime.activate"] = { sessionId: "s1", epoch: "e1", cwd: "/p", projectRoot: "/p", workerStatus: "ready" };
    client.attachFn = () => { throw new Error(`attach must not run for ${label}`); };
    const { authorizer, gateway } = makeLifecycleGateway(client);
    const session = await connect(gateway, lifecycleHello);
    assert.equal(session.jsonAt(0).payload.acceptedFeatures, undefined, label);
    session.receive(JSON.stringify({ type: "attach", id: "a1", payload: { sessionId: "s1", attachMode: "existing_only" } }));
    session.receive(JSON.stringify({ type: "activate", id: "act1", payload: { sessionId: "s1" } }));
    await wait();
    const frames = session.sent.slice(1).map((frame) => JSON.parse(frame));
    assert.equal(frames.length, 2, label);
    assert.equal(frames.every((frame) => frame.payload.ok === false && frame.payload.error.code === "unsupported_capability"), true, label);
    assert.deepEqual(sideEffectMethods(client), [], label);
    assert.equal(authorizer.calls.length, 0, label);
  }
});

test("LC-01: missing current gate verifier does not advertise new lifecycle features", async () => {
  const client = new FakeClient();
  client.handlers["system.hello"] = compatibleHello();
  const { gateway } = makeLifecycleGateway(client);
  const session = new FakeSession({ verifyGate: undefined });
  await gateway.attach(session, lifecycleHello);
  assert.equal(session.jsonAt(0).payload.acceptedFeatures, undefined);
});

test("LC-01: hung authorizer settles unavailable, releases the serial lane, and ignores late success", async () => {
  const client = new FakeClient();
  client.handlers["system.hello"] = compatibleHello();
  client.handlers["runtime.activate"] = { sessionId: "s1", epoch: "e9", cwd: "/p", projectRoot: "/p", workerStatus: "ready" };
  const sub = new FakeSubscription(attachResponse("s2"));
  client.attachFn = (_params, onPush) => { sub.onPush = onPush; return sub; };
  let lateAuthorize;
  const hung = lifecycleAuthorizer(async (request) => {
    if (request.intent === "activate") {
      return await new Promise((resolve) => { lateAuthorize = resolve; });
    }
    return allowLive(request.sessionId);
  });
  const timers = [];
  const { gateway } = makeLifecycleGateway(client, {
    authorizer: hung,
    lifecycleAuthorizationTimeoutMs: 20,
    setTimeoutFn: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      timers.push(handle);
      return handle;
    },
  });
  const session = await connect(gateway, lifecycleHello);
  session.receive(JSON.stringify({ type: "activate", id: "act1", payload: { sessionId: "s1" } }));
  await wait(40);
  const timeoutFrame = session.sent.slice(1).map((frame) => JSON.parse(frame)).find((frame) => frame.id === "act1");
  assert.equal(timeoutFrame.payload.ok, false);
  assert.equal(timeoutFrame.payload.error.code, "unavailable");
  assert.deepEqual(sideEffectMethods(client), []);
  session.receive(JSON.stringify({ type: "attach", id: "a2", payload: { sessionId: "s2", attachMode: "existing_only" } }));
  await wait();
  assert.equal(session.sent.slice(1).map((frame) => JSON.parse(frame)).some((frame) => frame.type === "snapshot" && frame.id === "a2"), true);
  lateAuthorize(allowLive("s1"));
  await wait();
  assert.equal(client.calls.filter((call) => call.method === "runtime.activate").length, 0);
  for (const handle of timers) clearTimeout(handle);
});

test("LC-01: gate revocation during authorization denies with zero activate/attach", async () => {
  const client = new FakeClient();
  client.handlers["system.hello"] = compatibleHello();
  client.handlers["runtime.activate"] = { sessionId: "s1", epoch: "e1", cwd: "/p", projectRoot: "/p", workerStatus: "ready" };
  client.attachFn = () => { throw new Error("attach must not run after logout"); };
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  let gateOk = true;
  const session = new FakeSession({
    verifyGate: async () => (gateOk ? { ok: true } : { ok: false, error: { code: "unauthorized", message: "session is no longer authorized", retryable: false } }),
  });
  const { gateway } = makeLifecycleGateway(client, {
    authorizer: lifecycleAuthorizer(async () => {
      await barrier;
      return allowLive();
    }),
  });
  await gateway.attach(session, lifecycleHello);
  assert.deepEqual(session.jsonAt(0).payload.acceptedFeatures, [
    RUNTIME_OBSERVE_EXISTING_FEATURE,
    RUNTIME_EXPLICIT_ACTIVATE_FEATURE,
  ]);
  session.receive(JSON.stringify({ type: "attach", id: "a1", payload: { sessionId: "s1", attachMode: "existing_only" } }));
  session.receive(JSON.stringify({ type: "activate", id: "act1", payload: { sessionId: "s1" } }));
  await wait();
  gateOk = false;
  release();
  await wait();
  const frames = session.sent.slice(1).map((frame) => JSON.parse(frame));
  assert.equal(frames.length, 2);
  assert.equal(frames.every((frame) => frame.payload.ok === false && frame.payload.error.code === "unauthorized"), true);
  assert.deepEqual(sideEffectMethods(client), []);
});

test("LC-01: capability resolver hang after handshake fires the 2000ms budget and ignores late resolve", async () => {
  const client = new FakeClient();
  client.handlers["system.hello"] = compatibleHello();
  client.handlers["runtime.activate"] = { sessionId: "s1", epoch: "e9", cwd: "/p", projectRoot: "/p", workerStatus: "ready" };
  const sub = new FakeSubscription(attachResponse("s2"));
  client.attachFn = (_params, onPush) => { sub.onPush = onPush; return sub; };
  let resolveCaps;
  let handshakeDone = false;
  const clock = fakeClock();
  const { gateway } = makeLifecycleGateway(client, {
    lifecycleAuthorizationTimeoutMs: 2000,
    setTimeoutFn: (fn, ms) => clock.setTimeoutFn(fn, ms),
    clearTimeoutFn: (id) => clock.clearTimeoutFn(id),
    resolveCapabilities: async () => {
      if (!handshakeDone) return { sessiond: "up", capabilities: ["agent"] };
      return await new Promise((resolve) => { resolveCaps = resolve; });
    },
  });
  const session = await connect(gateway, lifecycleHello);
  handshakeDone = true;
  session.receive(JSON.stringify({ type: "activate", id: "act1", payload: { sessionId: "s1" } }));
  await wait();
  await clock.advance(2000);
  await wait();
  const timeoutFrame = session.sent.slice(1).map((frame) => JSON.parse(frame)).find((frame) => frame.id === "act1");
  assert.equal(timeoutFrame.payload.ok, false);
  assert.equal(timeoutFrame.payload.error.code, "unavailable");
  assert.deepEqual(sideEffectMethods(client), []);
  handshakeDone = false;
  session.receive(JSON.stringify({ type: "attach", id: "a2", payload: { sessionId: "s2", attachMode: "existing_only" } }));
  await wait();
  resolveCaps({ sessiond: "up", capabilities: ["agent"] });
  await wait();
  assert.equal(session.sent.slice(1).map((frame) => JSON.parse(frame)).some((frame) => frame.type === "snapshot" && frame.id === "a2"), true);
  assert.equal(client.calls.filter((call) => call.method === "runtime.activate").length, 0);
});

test("LC-01: never-settling verifyGate at the final recheck fires the 2000ms budget with zero late RPC", async () => {
  const client = new FakeClient();
  client.handlers["system.hello"] = compatibleHello();
  client.handlers["runtime.activate"] = { sessionId: "s1", epoch: "e9", cwd: "/p", projectRoot: "/p", workerStatus: "ready" };
  const sub = new FakeSubscription(attachResponse("s2"));
  client.attachFn = (_params, onPush) => { sub.onPush = onPush; return sub; };
  let hangFinal = true;
  let gateCalls = 0;
  let lateGate;
  const clock = fakeClock();
  const session = new FakeSession({
    verifyGate: async () => {
      gateCalls += 1;
      if (hangFinal && gateCalls >= 2) return await new Promise((resolve) => { lateGate = resolve; });
      return { ok: true };
    },
  });
  const { gateway } = makeLifecycleGateway(client, {
    lifecycleAuthorizationTimeoutMs: 2000,
    setTimeoutFn: (fn, ms) => clock.setTimeoutFn(fn, ms),
    clearTimeoutFn: (id) => clock.clearTimeoutFn(id),
  });
  await gateway.attach(session, lifecycleHello);
  session.receive(JSON.stringify({ type: "activate", id: "act1", payload: { sessionId: "s1" } }));
  await wait();
  await clock.advance(2000);
  await wait();
  const timeoutFrame = session.sent.slice(1).map((frame) => JSON.parse(frame)).find((frame) => frame.id === "act1");
  assert.equal(timeoutFrame.payload.ok, false);
  assert.equal(timeoutFrame.payload.error.code, "unavailable");
  assert.deepEqual(sideEffectMethods(client), []);
  hangFinal = false;
  session.receive(JSON.stringify({ type: "attach", id: "a2", payload: { sessionId: "s2", attachMode: "existing_only" } }));
  await wait();
  lateGate({ ok: true });
  await wait();
  assert.equal(session.sent.slice(1).map((frame) => JSON.parse(frame)).some((frame) => frame.type === "snapshot" && frame.id === "a2"), true);
  assert.equal(client.calls.filter((call) => call.method === "runtime.activate").length, 0);
});
