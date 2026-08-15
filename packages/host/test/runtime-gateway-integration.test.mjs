import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Real sessiond surface (test-only — never imported by host production code).
import { SessiondService, SessiondApplication, SessiondRpcServer } from "@fffattiger/pix-sessiond";
import { FakeWorkerFactory } from "@fffattiger/pix-sessiond/testing";
import { SessiondRuntimeGateway } from "../dist/index.js";

const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const SECRET = "a".repeat(40);

const snapshot = (sessionId) => ({
  sessionId,
  cwd: "/p",
  projectRoot: "/p",
  state: { sessionId, isStreaming: false, isPromptRunning: false, isBashRunning: false, isCompacting: false, model: null, messageCount: 0 },
  capabilities: { capabilities: ["runtime.prompt", "runtime.abort"], version: 1 },
  streaming: { active: false, phase: "idle" },
  messages: [],
});

function harness(workerOptions = {}) {
  const locations = new Map();
  const locator = {
    async locate(sessionId) {
      return { sessionId, sessionFile: locations.get(sessionId) ?? `/sessions/${sessionId}.jsonl`, exists: true };
    },
    async resolveLeafId() {
      return "leaf";
    },
  };
  const catalog = {
    async listSessions() {
      return [];
    },
    async readSession(sessionId) {
      return { sessionId, cwd: "/p", projectRoot: "/p", entries: [] };
    },
    async readSessionContext(sessionId) {
      return { sessionId, entries: [] };
    },
    async readSessionTree(sessionId) {
      return { sessionId, roots: [], entryCount: 0 };
    },
    async deleteSession() {},
  };
  // Per-worker snapshot whose sessionId matches the real session, so projection
  // rekey/replace and getSnapshot stay consistent.
  const baseOptions = typeof workerOptions === "function" ? workerOptions : { ...workerOptions };
  const factoryOptions = (input) => {
    const extra = typeof baseOptions === "function" ? baseOptions(input) : baseOptions;
    return { snapshot: snapshot(input.sessionId), ...extra };
  };
  const workers = new FakeWorkerFactory(factoryOptions);
  const service = new SessiondService(
    {
      sessionLocator: locator,
      activationContext: { async resolve(_sessionId, _location, requestedCwd) { return { cwd: requestedCwd ?? "/p", projectRoot: requestedCwd ?? "/p" }; } },
      workerFactory: workers,
      sessionCatalog: catalog,
    },
    { workerStartTimeoutMs: 500, commandTimeoutMs: 500, idleTimeoutMs: 0 },
  );
  return { service, workers };
}

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
    for (const fn of [...this.closeListeners]) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    this.closeListeners.clear();
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
  json(i) {
    return JSON.parse(this.sent[i]);
  }
}

const hello = JSON.stringify({ type: "handshake", payload: { protocolVersion: 1, client: { shell: "web", platform: "mac" }, features: [] } });

async function startServer(service) {
  const directory = await mkdtemp(join(tmpdir(), "h1-integ-"));
  const endpoint = join(directory, "rpc.sock");
  const server = new SessiondRpcServer({ endpoint, secret: SECRET, handler: new SessiondApplication(service) });
  await server.listen();
  return { server, endpoint, directory };
}

async function connectGateway(endpoint, secret = SECRET) {
  const gateway = new SessiondRuntimeGateway({ endpoint, secret, mode: "local", capabilities: [], now: () => 1_700_000_000_000 });
  const session = new FakeSession();
  await gateway.attach(session, hello);
  return { gateway, session };
}

test("integration: create → attach (initial snapshot id) → command correlation → getSnapshot → stop", async (t) => {
  if (process.platform === "win32") return t.skip("unix socket test");
  const { service } = harness();
  const { server, endpoint, directory } = await startServer(service);
  try {
    const { session } = await connectGateway(endpoint);
    assert.equal(session.json(0).type, "handshake_ack");

    // create
    session.receive(JSON.stringify({ type: "create", id: "c1", payload: { createRequestId: "cr1", cwd: "/p", projectRoot: "/p" } }));
    await wait(30);
    const createRes = session.sent.map((f) => JSON.parse(f)).find((m) => m.type === "response" && m.id === "c1");
    assert.ok(createRes, "create response");
    assert.equal(createRes.payload.ok, true);
    const sessionId = createRes.payload.result.sessionId;

    // attach → initial snapshot echoes the attach request id
    session.receive(JSON.stringify({ type: "attach", id: "att1", payload: { sessionId } }));
    await wait(20);
    const snap = session.sent.map((f) => JSON.parse(f)).find((m) => m.type === "snapshot");
    assert.ok(snap, "initial snapshot");
    assert.equal(snap.id, "att1");
    assert.equal(snap.payload.sessionId, sessionId);

    // command correlation (prompt resolves quickly)
    session.receive(JSON.stringify({ type: "command", id: "cmd1", payload: { sessionId, command: { commandId: "cmd-1", type: "prompt", message: "hi" } } }));
    await wait(30);
    const cmdRes = session.sent.map((f) => JSON.parse(f)).find((m) => m.type === "response" && m.id === "cmd1");
    assert.ok(cmdRes, "command response");
    assert.equal(cmdRes.payload.result.commandId, "cmd-1");

    // getSnapshot
    session.receive(JSON.stringify({ type: "getSnapshot", id: "gs1", payload: { sessionId } }));
    await wait(20);
    const gsRes = session.sent.map((f) => JSON.parse(f)).find((m) => m.type === "response" && m.id === "gs1");
    assert.ok(gsRes, "getSnapshot response");
    assert.equal(gsRes.payload.ok, true);

    // stop closes the attach subscription and stops the session
    session.receive(JSON.stringify({ type: "stop", id: "st1", payload: { sessionId } }));
    await wait(20);
    const stRes = session.sent.map((f) => JSON.parse(f)).find((m) => m.type === "response" && m.id === "st1");
    assert.ok(stRes && stRes.payload.result.stopped === true, "stop response");
  } finally {
    await server.close();
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("integration: cold attach without create activates then attaches", async (t) => {
  if (process.platform === "win32") return t.skip("unix socket test");
  const { service } = harness();
  const { server, endpoint, directory } = await startServer(service);
  try {
    const { session } = await connectGateway(endpoint);
    // attach to a never-created session → worker_unavailable → activate → retry
    session.receive(JSON.stringify({ type: "attach", id: "att-cold", payload: { sessionId: "preexisting" } }));
    await wait(40);
    const snap = session.sent.map((f) => JSON.parse(f)).find((m) => m.type === "snapshot");
    assert.ok(snap, "cold attach delivered a snapshot after activate");
    assert.equal(snap.id, "att-cold");
  } finally {
    await server.close();
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("integration: interrupt correlates end-to-end (R0 commandId)", async (t) => {
  if (process.platform === "win32") return t.skip("unix socket test");
  const { service } = harness({ commandDelayMs: 200 });
  const { server, endpoint, directory } = await startServer(service);
  try {
    const { session } = await connectGateway(endpoint);
    session.receive(JSON.stringify({ type: "create", id: "c1", payload: { createRequestId: "cr1", cwd: "/p", projectRoot: "/p" } }));
    await wait(30);
    const sessionId = session.sent.map((f) => JSON.parse(f)).find((m) => m.type === "response" && m.id === "c1").payload.result.sessionId;
    session.receive(JSON.stringify({ type: "attach", id: "att1", payload: { sessionId } }));
    await wait(20);
    // start a long prompt, then abort it
    session.receive(JSON.stringify({ type: "command", id: "cmd1", payload: { sessionId, command: { commandId: "long", type: "prompt", message: "go" } } }));
    await wait(20);
    session.receive(JSON.stringify({ type: "interrupt", id: "int1", payload: { sessionId, commandId: "ci-abort", interrupt: { type: "abort" } } }));
    await wait(40);
    const ir = session.sent.map((f) => JSON.parse(f)).find((m) => m.type === "interrupt_result");
    assert.ok(ir, "interrupt_result");
    assert.equal(ir.id, "int1");
    assert.equal(ir.payload.commandId, "ci-abort");
    assert.equal(ir.payload.interruptType, "abort");
  } finally {
    await server.close();
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("integration: wrong secret fails sanitized (no leak)", async (t) => {
  if (process.platform === "win32") return t.skip("unix socket test");
  const { service } = harness();
  const { server, endpoint, directory } = await startServer(service);
  try {
    const { session } = await connectGateway(endpoint, "b".repeat(40));
    session.receive(JSON.stringify({ type: "create", id: "c1", payload: { createRequestId: "cr1", cwd: "/p", projectRoot: "/p" } }));
    await wait(30);
    const res = session.sent.map((f) => JSON.parse(f)).find((m) => m.type === "response" && m.id === "c1");
    assert.ok(res);
    assert.equal(res.payload.ok, false);
    // sanitized: never echoes the secret or a raw stack
    assert.ok(!JSON.stringify(res.payload.error).includes(SECRET));
  } finally {
    await server.close();
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("integration: closing the gateway/browser leaves sessiond RPC alive (no daemon stop)", async (t) => {
  if (process.platform === "win32") return t.skip("unix socket test");
  const { service } = harness();
  const { server, endpoint, directory } = await startServer(service);
  try {
    const { session } = await connectGateway(endpoint);
    session.receive(JSON.stringify({ type: "create", id: "c1", payload: { createRequestId: "cr1", cwd: "/p", projectRoot: "/p" } }));
    await wait(30);
    // Simulate Host restart: close the browser socket (gateway releases only its WS/RPC).
    session.close();
    await wait(20);
    // The sessiond RPC server must still answer an authenticated call.
    const { SessiondRpcClient } = await import("@fffattiger/pix-sessiond/client");
    const probe = new SessiondRpcClient({ endpoint, secret: SECRET, timeoutMs: 500 });
    assert.equal((await probe.call("system.ping", {})).pong, true);
  } finally {
    await server.close();
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
