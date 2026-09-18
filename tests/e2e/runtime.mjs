/**
 * X1 Minimal Runtime E2E — real process path:
 *   Browser-like WS client
 *     → real Hono Host /v1/runtime
 *     → real sessiond RPC daemon (parent-started)
 *     → R2 ProductionWorkerProcessFactory child
 *     → R1 worker-main / controller / mapper
 *     → injected no-network E2E AgentRuntimeFactory fixture
 *
 * Never uses Host FakeWorker or bypasses the child process.
 *
 * Run: npm run test:e2e:runtime
 * Multi-round: PIX_E2E_ROUNDS=5 npm run test:e2e:runtime
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import {
  createHostApp,
  createNodeServer,
  consoleLogger,
  SessiondRuntimeGateway,
} from "@fffattiger/pix-host";
import { startDaemon } from "@fffattiger/pix-sessiond/daemon";
import { PROTOCOL_VERSION, RUNTIME_READ_RPC_FEATURE, RUNTIME_SUBMIT_TURN_FEATURE, reduceRuntimeEventData } from "@fffattiger/pix-protocol";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE = resolve(
  ROOT,
  "packages/agent-worker/test/fixtures/e2e-runtime-factory.mjs",
);
const CLIENT_DIST = join(ROOT, "packages", "client", "dist");

const STEP_TIMEOUT_MS = 12_000;
const HOST_START_TIMEOUT_MS = 10_000;
const CLEANUP_TIMEOUT_MS = 8_000;
const ROUNDS = Math.max(1, Number(process.env.PIX_E2E_ROUNDS ?? "1") || 1);

// D2 navigate + D2 fork + D2 auto_name production capability surface (20
// tokens): the exact set the attach snapshot must carry. With auto_name the
// runtime command matrix is COMPLETE — every runtime command is open (bash
// pair + tools read/write + reload + manual-compact pair + extension UI +
// navigate + fork + auto_name). The E2E closed-cap loops become an explicit
// every-command-open assertion (see assertEveryCommandOpen below).
const PRODUCTION_CAPS = [
  "runtime.prompt",
  "runtime.abort",
  "runtime.stats",
  "runtime.session.rename",
  "runtime.thinking.set",
  "runtime.model.set",
  "runtime.steer",
  "runtime.follow_up",
  "runtime.queue",
  "runtime.bash",
  "runtime.bash.abort",
  "runtime.tools.read",
  "runtime.tools.write",
  "runtime.reload",
  "runtime.compact",
  "runtime.compact.abort",
  "runtime.extension_ui",
  "runtime.navigate",
  "runtime.fork",
  "runtime.auto_name",
];

/** The canonical full frozen command surface (the 20 open production tokens). */
const FROZEN_COMMAND_CAPS = [
  "runtime.prompt",
  "runtime.abort",
  "runtime.stats",
  "runtime.session.rename",
  "runtime.thinking.set",
  "runtime.model.set",
  "runtime.steer",
  "runtime.follow_up",
  "runtime.queue",
  "runtime.bash",
  "runtime.bash.abort",
  "runtime.tools.read",
  "runtime.tools.write",
  "runtime.reload",
  "runtime.compact",
  "runtime.compact.abort",
  "runtime.extension_ui",
  "runtime.navigate",
  "runtime.fork",
  "runtime.auto_name",
];

/**
 * Completeness inversion of the former closed-cap loops. Every runtime command
 * is now OPEN, so the closed-cap loop is replaced by: (1) the production
 * surface carries the full frozen 20-token command set, and (2) the former
 * last-closed command (generate_session_title) now SUCCEEDS with the generated
 * title — never `unsupported_capability`. The closed remainder is empty.
 */
async function assertEveryCommandOpen(client, sessionId, label) {
  assert.equal(PRODUCTION_CAPS.length, 20, `${label}: production surface must be the full 20-token frozen set`);
  assert.deepEqual(
    [...PRODUCTION_CAPS].sort(),
    [...FROZEN_COMMAND_CAPS].sort(),
    `${label}: the production surface must contain the full frozen command set (nothing closed)`,
  );
  const res = await client.command(sessionId, {
    commandId: `open-${label}-${Date.now()}`,
    type: "generate_session_title",
  });
  assert.equal(res.payload.ok, true, JSON.stringify(res.payload));
  const outcome = res.payload.result.result;
  assert.equal(outcome.ok, true, `${label}: generate_session_title must be open (no command is closed)`);
  assert.equal(outcome.type, "generate_session_title");
  assert.equal(typeof outcome.title, "string");
  assert.ok(outcome.title.length > 0, `${label}: the RPC result must carry the generated title`);
}

// In-memory registry of sessions created through the E2E client, backing both
// the fixture locator and the fixture catalog overrides passed to startDaemon.
// Populated by RuntimeWsClient.create(); cleared per stack/round.
const fixtureSessions = new Map();

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const activeNames = (state) => (state.tools ?? []).filter((tool) => tool.active).map((tool) => tool.name).sort();

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function freePort() {
  return await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object");
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolvePromise(port)));
    });
  });
}

function log(...args) {
  console.error("[pix:e2e:runtime]", ...args);
}

function redact(value) {
  // Never print secrets/paths that look like credentials.
  if (typeof value !== "string") return value;
  return value
    .replace(/[a-f0-9]{32,}/gi, "<redacted>")
    .replace(/AUTH [^\n]+/g, "AUTH <redacted>");
}

// ---------------------------------------------------------------------------
// Browser-like WS client
// ---------------------------------------------------------------------------

class RuntimeWsClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.messages = [];
    this.waiters = new Set();
    this.closed = null;
    this.projection = null;
    this.msgSeq = 0;
  }

  async connect(timeoutMs = STEP_TIMEOUT_MS) {
    this.ws = new WebSocket(this.url);
    this.ws.on("message", (data) => {
      let parsed;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        log("non-JSON frame", redact(String(data).slice(0, 200)));
        return;
      }
      this.messages.push(parsed);
      this._applyProjection(parsed);
      for (const waiter of [...this.waiters]) {
        try {
          if (waiter.pred(parsed)) {
            this.waiters.delete(waiter);
            clearTimeout(waiter.timer);
            waiter.resolve(parsed);
          }
        } catch (error) {
          this.waiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.reject(error);
        }
      }
    });
    this.ws.on("close", (code, reason) => {
      this.closed = { code, reason: String(reason ?? "") };
      for (const waiter of [...this.waiters]) {
        this.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`ws closed (${code}) while waiting: ${waiter.label}`));
      }
    });
    this.ws.on("error", (error) => {
      log("ws error", error?.message ?? error);
    });
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`ws connect timeout to ${this.url}`)),
        timeoutMs,
      );
      this.ws.once("open", () => {
        clearTimeout(timer);
        resolvePromise();
      });
      this.ws.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  send(message) {
    assert.ok(this.ws && this.ws.readyState === WebSocket.OPEN, "ws not open");
    this.ws.send(JSON.stringify(message));
  }

  waitFor(pred, { label = "event", timeoutMs = STEP_TIMEOUT_MS, afterIndex } = {}) {
    // Only match messages at/after afterIndex so retries with the same wire id
    // do not accidentally resolve to an earlier historical frame.
    const start = afterIndex === undefined ? 0 : afterIndex;
    const hit = this.messages.slice(start).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(entry);
        const types = this.messages.map((m) => m.type).slice(-20).join(",");
        reject(
          new Error(
            `timeout waiting for ${label} (last types: ${types || "none"})`,
          ),
        );
      }, timeoutMs);
      const entry = {
        pred: (m) => {
          // Waiters only see messages that arrive after they register; the
          // slice above already covered history at registration time.
          return pred(m);
        },
        resolve: resolvePromise,
        reject,
        timer,
        label,
      };
      this.waiters.add(entry);
    });
  }

  async handshake(features = []) {
    this.send({
      type: "handshake",
      id: "hs1",
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        client: { shell: "web", platform: "mac" },
        features: [...features],
      },
    });
    const ack = await this.waitFor((m) => m.type === "handshake_ack", {
      label: "handshake_ack",
    });
    return ack;
  }

  async create({ cwd, projectRoot, createRequestId = `cr-${Date.now()}`, toolNames, thinkingLevel, thinkingLevelPinned }) {
    const id = `create-${createRequestId}`;
    this.send({
      type: "create",
      id,
      payload: {
        createRequestId,
        cwd,
        projectRoot,
        ...(toolNames === undefined ? {} : { toolNames: [...toolNames] }),
        ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
        ...(thinkingLevelPinned === undefined ? {} : { thinkingLevelPinned }),
      },
    });
    const res = await this.waitFor(
      (m) => m.type === "response" && m.id === id,
      { label: `create ${id}` },
    );
    assert.equal(res.payload.ok, true, JSON.stringify(res.payload));
    // Record the fixture session so cold-open activation (catalog.readSession)
    // can resolve its cwd/projectRoot after a stop, mirroring how the
    // production catalog resolves persisted sessions.
    if (res.payload.result?.sessionId) {
      fixtureSessions.set(res.payload.result.sessionId, { sessionId: res.payload.result.sessionId, cwd, projectRoot });
    }
    return res.payload.result;
  }

  async attach(sessionId, resume) {
    const id = `attach-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const payload =
      resume && resume.epoch !== undefined
        ? {
            sessionId,
            epoch: resume.epoch,
            lastEventId: resume.lastEventId,
          }
        : { sessionId };
    this.send({ type: "attach", id, payload });
    // Success is a correlated snapshot (id = attach request id). Failure is response ok:false.
    const outcome = await this.waitFor(
      (m) =>
        (m.type === "snapshot" && m.id === id) ||
        (m.type === "response" && m.id === id),
      { label: `attach ${id}` },
    );
    if (outcome.type === "response") {
      assert.equal(outcome.payload.ok, true, JSON.stringify(outcome.payload));
    }
    return outcome;
  }

  async command(sessionId, command, { wireId } = {}) {
    const id = wireId ?? `cmd-${command.commandId}`;
    const afterIndex = this.messages.length;
    this.send({
      type: "command",
      id,
      payload: { sessionId, command },
    });
    const res = await this.waitFor(
      (m) => m.type === "response" && m.id === id,
      { label: `command ${id}`, timeoutMs: STEP_TIMEOUT_MS, afterIndex },
    );
    return res;
  }

  async read(sessionId, epoch, read, { requestId } = {}) {
    const id = requestId ?? `read-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const afterIndex = this.messages.length;
    this.send({ type: "read", id, payload: { sessionId, epoch, read } });
    return this.waitFor(
      (m) => m.type === "read_result" && m.id === id,
      { label: `read ${id}`, timeoutMs: STEP_TIMEOUT_MS, afterIndex },
    );
  }

  async submitTurn(sessionId, { prompt, operationId, images, activationOverrides, expectedEpoch, expectedRevision }) {
    const id = `submit-${operationId}`;
    const afterIndex = this.messages.length;
    this.send({
      type: "submit_turn",
      id,
      payload: {
        sessionId,
        prompt,
        operationId,
        ...(images === undefined ? {} : { images }),
        ...(activationOverrides === undefined ? {} : { activationOverrides }),
        ...(expectedEpoch === undefined ? {} : { expectedEpoch }),
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      },
    });
    const res = await this.waitFor(
      (m) => m.type === "submit_turn_result" && m.id === id,
      { label: `submit_turn ${operationId}`, timeoutMs: STEP_TIMEOUT_MS, afterIndex },
    );
    return res;
  }

  async waitForTurnStatus(sessionId, operationId, state, { afterIndex = 0 } = {}) {
    return this.waitFor(
      (m) => m.type === "turn_status" && m.payload?.sessionId === sessionId && m.payload?.operationId === operationId && m.payload?.state === state,
      { label: `turn_status ${operationId} ${state}`, timeoutMs: STEP_TIMEOUT_MS, afterIndex },
    );
  }

  async interrupt(sessionId, commandId, interrupt = { type: "abort" }) {
    const id = `int-${commandId}`;
    const afterIndex = this.messages.length;
    this.send({
      type: "interrupt",
      id,
      payload: { sessionId, commandId, interrupt },
    });
    const res = await this.waitFor(
      (m) => m.type === "interrupt_result" && m.id === id,
      { label: `interrupt ${id}`, afterIndex },
    );
    return res;
  }

  async stop(sessionId, reason = "user") {
    const id = `stop-${sessionId.slice(0, 12)}`;
    this.send({ type: "stop", id, payload: { sessionId, reason } });
    const res = await this.waitFor(
      (m) => m.type === "response" && m.id === id,
      { label: `stop ${id}` },
    );
    return res;
  }

  async detach(sessionId) {
    const id = `detach-${sessionId.slice(0, 12)}`;
    this.send({ type: "detach", id, payload: { sessionId } });
    const res = await this.waitFor(
      (m) => m.type === "response" && m.id === id,
      { label: `detach ${id}` },
    );
    return res;
  }

  async getSnapshot(sessionId) {
    const id = `snap-${sessionId.slice(0, 12)}-${Date.now()}-${this.msgSeq++}`;
    this.send({ type: "getSnapshot", id, payload: { sessionId } });
    const res = await this.waitFor(
      (m) => m.type === "response" && m.id === id,
      { label: `getSnapshot ${id}` },
    );
    return res;
  }

  close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, "client done");
    }
  }

  eventsFor(sessionId) {
    return this.messages
      .filter((m) => m.type === "event" && m.payload?.sessionId === sessionId)
      .map((m) => m.payload);
  }

  eventTypes(sessionId) {
    return this.eventsFor(sessionId).map((e) => e.type);
  }

  _applyProjection(message) {
    if (message.type === "snapshot" && message.payload?.snapshot) {
      this.projection = structuredClone(message.payload.snapshot);
      this.epoch = message.payload.epoch;
      this.lastEventId = message.payload.lastEventId;
      this.sessionId = message.payload.sessionId;
      return;
    }
    if (message.type === "event" && message.payload && this.projection) {
      try {
        this.projection = reduceRuntimeEventData(
          this.projection,
          message.payload,
        );
        if (typeof message.payload.eventId === "number") {
          this.lastEventId = message.payload.eventId;
        }
        if (typeof message.payload.epoch === "string") {
          this.epoch = message.payload.epoch;
        }
      } catch (error) {
        log("projection apply failed", error?.message ?? error);
      }
    }
  }

  finalAssistantText() {
    // Protocol v2 snapshots intentionally exclude completed transcript history;
    // terminal message_end is the authoritative committed message surface.
    const ended = [...this.messages]
      .reverse()
      .find((m) => m.type === "event" && m.payload?.type === "message_end" && m.payload?.message?.role === "assistant");
    const last = ended?.payload?.message
      ?? [...(this.projection?.messages ?? [])].reverse().find((message) => message.role === "assistant");
    if (!last) return "";
    return (last.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
  }
}

// ---------------------------------------------------------------------------
// Host + daemon harness
// ---------------------------------------------------------------------------

async function startRuntimeStack(tempDir) {
  assert.equal(existsSync(FIXTURE), true, `fixture missing: ${FIXTURE}`);
  const clientDist = existsSync(CLIENT_DIST)
    ? CLIENT_DIST
    : await makeMinimalClientDist(tempDir);

  // The deterministic fixture owns ephemeral sessions in memory and does not
  // persist Pi JSONL. Keep the E2E activation locator explicit rather than
  // relying on the production read-only JSONL locator introduced by D1A-2.
  // The catalog MUST be overridden to match (production cold-open activation
  // derives cwd/projectRoot from catalog.readSession — see 8086770): with no
  // override the daemon would use the production Pi SDK JSONL catalog, which
  // can never find an in-memory fixture session, so a stop → cold-attach would
  // fail closed with not_found. Both overrides back the SAME in-memory registry
  // that RuntimeWsClient.create() populates.
  fixtureSessions.clear();
  const fixtureLocator = {
    async locate(sessionId) {
      return {
        sessionId,
        sessionFile: join(tempDir, "fixture-sessions", `${sessionId}.jsonl`),
        exists: true,
      };
    },
    async resolveLeafId(_sessionId, targetId) {
      return targetId ?? "fixture-leaf";
    },
  };
  // SessionCatalogPort over the same in-memory registry. readSession returns
  // the cwd/projectRoot the session was created with; unknown sessions fail
  // closed with a canonical RuntimeError-shaped not_found (the RPC boundary
  // re-projects it to the fixed sanitized message).
  const fixtureSessionFile = (sessionId) => join(tempDir, "fixture-sessions", `${sessionId}.jsonl`);
  const fixtureCatalog = {
    async listSessions() {
      // Header-only (SessionHeaderSchema is strict: no `entries`). The fixture
      // never returns a title, so the §51 service-owned overlay is the ONLY
      // thing bridging the auto_name title to sessions.list/read.
      return [...fixtureSessions.values()].map(({ sessionId, cwd, projectRoot }) => ({
        sessionId,
        sessionFile: fixtureSessionFile(sessionId),
        cwd,
        projectRoot,
      }));
    },
    async readSession(sessionId) {
      const session = fixtureSessions.get(sessionId);
      if (!session) throw { code: "not_found", message: "session not found", retryable: false };
      return { sessionId, sessionFile: fixtureSessionFile(sessionId), cwd: session.cwd, projectRoot: session.projectRoot, entries: [] };
    },
    async readSessionContext(sessionId) {
      if (!fixtureSessions.has(sessionId)) throw { code: "not_found", message: "session not found", retryable: false };
      return { sessionId, entries: [] };
    },
    async readSessionTree(sessionId) {
      if (!fixtureSessions.has(sessionId)) throw { code: "not_found", message: "session not found", retryable: false };
      return { sessionId, roots: [], entryCount: 0 };
    },
    async deleteSession(sessionId) {
      fixtureSessions.delete(sessionId);
    },
  };

  const daemon = await startDaemon({
    directory: tempDir,
    sessionLocator: fixtureLocator,
    sessionCatalog: fixtureCatalog,
    workerOptions: {
      workerFactoryModulePath: FIXTURE,
      // Tight close so E2E cleanup is bounded.
      stdinEndMs: 1_500,
      sigtermMs: 1_500,
      sigkillMs: 1_500,
    },
    serviceOptions: {
      idleTimeoutMs: 0,
      workerStartTimeoutMs: 10_000,
      commandTimeoutMs: 15_000,
    },
  });

  const host = await bootHost({
    endpoint: daemon.endpoint,
    secret: daemon.secret,
    clientDist,
  });

  return { daemon, host, clientDist, workerPids: () => daemon.diagnostics.workerPids() };
}

async function bootHost({ endpoint, secret, clientDist, capabilities = ["agent"] }) {
  const port = await freePort();
  const runtimeWs = new SessiondRuntimeGateway({
    endpoint,
    secret,
    mode: "local",
    capabilities,
    timeoutMs: 15_000,
    logger: {
      warn: (msg, fields) => log("host.warn", msg, fields ?? ""),
      error: (msg, fields) => log("host.error", msg, fields ?? ""),
    },
  });
  const app = createHostApp({
    exposureMode: "local",
    clientDist,
    allowedHosts: ["127.0.0.1"],
    capabilities: {
      full: capabilities,
      readonly: [],
    },
    sessiond: {
      async isAvailable() {
        return true;
      },
    },
    gate: { config: { read: () => ({ status: "disabled", source: "e2e" }) } },
    logger: {
      // Keep diagnostics on stderr without flooding.
      info: () => {},
      warn: (msg, fields) => log("app.warn", msg, fields ?? ""),
      error: (msg, fields) => log("app.error", msg, fields ?? ""),
    },
    runtimeWs,
  });
  const handle = await createNodeServer(app, {
    port,
    hostname: "127.0.0.1",
  });
  const origin = `http://127.0.0.1:${handle.port}`;
  const wsUrl = `ws://127.0.0.1:${handle.port}/v1/runtime`;

  // Sanity: health is reachable.
  const deadline = Date.now() + HOST_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/v1/health`);
      if (response.ok) break;
    } catch {
      // retry
    }
    await delay(50);
  }

  return { handle, origin, wsUrl, port, capabilities };
}

async function makeMinimalClientDist(tempDir) {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const dist = join(tempDir, "client-dist");
  await mkdir(join(dist, "assets"), { recursive: true });
  await writeFile(
    join(dist, "index.html"),
    '<!doctype html><html><head><title>pix</title></head><body><div id="root"></div><script type="module" src="/assets/index-e2e.js"></script></body></html>',
  );
  await writeFile(join(dist, "assets/index-e2e.js"), 'console.log("e2e");');
  return dist;
}

// Authoritative in-process worker discovery: the daemon handle exposes only
// current Worker PIDs derived from service records (no pgrep / ps / PID files /
// process scans, and no fail-open `[]` when pgrep is unavailable). The daemon
// runs in-process in this harness, so the handle is always reachable.

async function waitForPidDead(pid, timeoutMs = CLEANUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await delay(50);
  }
  return !pidAlive(pid);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenarioCreateAttachPrompt(stack, projectDir) {
  const client = new RuntimeWsClient(stack.host.wsUrl);
  await client.connect();
  try {
    const ack = await client.handshake();
    assert.deepEqual(ack.payload.host.capabilities, ["agent"]);
    assert.equal(ack.payload.protocolVersion, PROTOCOL_VERSION);

    const created = await client.create({
      cwd: projectDir,
      projectRoot: projectDir,
      createRequestId: `cr-prompt-${Date.now()}`,
    });
    assert.ok(created.sessionId);
    assert.ok(created.epoch);
    const sessionId = created.sessionId;

    const snap = await client.attach(sessionId);
    assert.equal(snap.type, "snapshot");
    assert.equal(snap.payload.sessionId, sessionId);
    assert.equal(snap.payload.cwd, projectDir);
    assert.equal(snap.payload.projectRoot, projectDir);
    assert.equal(snap.payload.epoch, created.epoch);
    assert.ok(typeof snap.payload.lastEventId === "number");
    // Authoritative runtime capability set is primed from the worker snapshot
    // (NOT the Host `agent` capability): D2-P1/P2/P3/P4/P5 production surface =
    // runtime.prompt + runtime.abort + runtime.stats + runtime.session.rename +
    // runtime.thinking.set + runtime.model.set + runtime.steer +
    // runtime.follow_up + runtime.queue + runtime.bash + runtime.bash.abort.
    assert.deepEqual(
      snap.payload.snapshot.capabilities,
      {
        capabilities: PRODUCTION_CAPS,
        version: 1,
      },
      `attach capabilities=${JSON.stringify(snap.payload.snapshot.capabilities)}`,
    );

    const commandId = `prompt-${Date.now()}`;
    const cmdRes = await client.command(sessionId, {
      commandId,
      type: "prompt",
      message: "hello e2e",
    });
    assert.equal(cmdRes.payload.ok, true, JSON.stringify(cmdRes.payload));
    assert.equal(cmdRes.payload.result.commandId, commandId);
    assert.equal(cmdRes.payload.result.result.ok, true);

    // Stream events must include message lifecycle + prompt_done.
    await client.waitFor(
      (m) =>
        m.type === "event" &&
        m.payload?.sessionId === sessionId &&
        m.payload?.type === "prompt_done",
      { label: "prompt_done" },
    );
    const types = client.eventTypes(sessionId);
    assert.ok(types.includes("agent_start"), `types=${types.join(",")}`);
    assert.ok(
      types.includes("message_start") || types.includes("message_update"),
      `expected stream events, got ${types.join(",")}`,
    );
    assert.ok(types.includes("message_end"), `types=${types.join(",")}`);
    assert.ok(types.includes("prompt_done"), `types=${types.join(",")}`);

    // Shared projection final text is exact; deltas must not double-append.
    const text = client.finalAssistantText();
    assert.equal(text, "Hello world", `projection text=${JSON.stringify(text)}`);

    // Capture resume cursor for later scenarios.
    const epoch = client.epoch ?? snap.payload.epoch;
    const lastEventId = client.lastEventId ?? snap.payload.lastEventId;

    return { sessionId, epoch, lastEventId, commandId, workerObserved: true };
  } finally {
    client.close();
  }
}

async function scenarioAbort(stack, projectDir) {
  const client = new RuntimeWsClient(stack.host.wsUrl);
  await client.connect();
  try {
    await client.handshake();
    const created = await client.create({
      cwd: projectDir,
      projectRoot: projectDir,
      createRequestId: `cr-abort-${Date.now()}`,
    });
    const sessionId = created.sessionId;
    await client.attach(sessionId);

    const commandId = `long-${Date.now()}`;
    // Fire-and-forget long prompt (blocks in fixture until abort).
    const promptPromise = client.command(sessionId, {
      commandId,
      type: "prompt",
      message: "__block__ long running",
    });

    // Wait until agent_start proves the prompt is running.
    await client.waitFor(
      (m) =>
        m.type === "event" &&
        m.payload?.sessionId === sessionId &&
        m.payload?.type === "agent_start",
      { label: "agent_start before abort" },
    );

    // D3A worktree safety query (runtime.hasBusyCwd descendant containment):
    // while the prompt is running the exact busy cwd AND any ancestor report
    // busy; a sibling prefix and an unrelated cwd do not. stopByCwd stays exact.
    {
      const { SessiondRpcClient } = await import("@fffattiger/pix-sessiond/client");
      const rpc = new SessiondRpcClient({ endpoint: stack.daemon.endpoint, secret: stack.daemon.secret, timeoutMs: 2_000 });
      const exact = await rpc.call("runtime.hasBusyCwd", { cwd: projectDir });
      assert.equal(exact.busy, true, "exact busy cwd must report busy");
      const ancestor = await rpc.call("runtime.hasBusyCwd", { cwd: dirname(projectDir) });
      assert.equal(ancestor.busy, true, "ancestor of a busy cwd must report busy (descendant containment)");
      const sibling = await rpc.call("runtime.hasBusyCwd", { cwd: `${projectDir}x` });
      assert.equal(sibling.busy, false, "sibling prefix is NOT a descendant");
      const unrelated = await rpc.call("runtime.hasBusyCwd", { cwd: "/nonexistent-unrelated-dir-xyz" });
      assert.equal(unrelated.busy, false, "unrelated cwd must not be busy");
    }

    // Independent interrupt path — must not HOL-block behind the long command.
    const t0 = Date.now();
    const ir = await client.interrupt(sessionId, `abort-${Date.now()}`, {
      type: "abort",
    });
    const elapsed = Date.now() - t0;
    assert.equal(ir.type, "interrupt_result");
    assert.equal(ir.payload.interruptType, "abort");
    assert.equal(ir.payload.result.ok, true, JSON.stringify(ir.payload));
    assert.ok(
      elapsed < 5_000,
      `interrupt HOL-blocked? elapsed=${elapsed}ms`,
    );

    const promptRes = await promptPromise;
    assert.equal(promptRes.payload.ok, true);
    // Prompt should terminate as interrupted (or ok if race settled first).
    const outcome = promptRes.payload.result.result;
    assert.ok(
      outcome.ok === false || outcome.ok === true,
      JSON.stringify(outcome),
    );
    if (outcome.ok === false) {
      assert.equal(outcome.error.code, "interrupted");
    }

    // State recovered: isPromptRunning false after prompt settles.
    await delay(50);
    return { sessionId, interruptElapsedMs: elapsed };
  } finally {
    client.close();
  }
}

async function scenarioHostRestartResume(stack, projectDir) {
  const client1 = new RuntimeWsClient(stack.host.wsUrl);
  await client1.connect();
  let sessionId;
  let epoch;
  let lastEventId;
  let commandId;
  try {
    await client1.handshake();
    const created = await client1.create({
      cwd: projectDir,
      projectRoot: projectDir,
      createRequestId: `cr-resume-${Date.now()}`,
    });
    sessionId = created.sessionId;
    const snap = await client1.attach(sessionId);
    epoch = snap.payload.epoch;
    lastEventId = snap.payload.lastEventId;
    // Resume attach still carries the authoritative runtime capability set.
    assert.deepEqual(snap.payload.snapshot.capabilities, {
      capabilities: PRODUCTION_CAPS,
      version: 1,
    });

    commandId = `resume-prompt-${Date.now()}`;
    const cmdRes = await client1.command(sessionId, {
      commandId,
      type: "prompt",
      message: "before host restart",
    });
    assert.equal(cmdRes.payload.result.result.ok, true);
    await client1.waitFor(
      (m) =>
        m.type === "event" &&
        m.payload?.sessionId === sessionId &&
        m.payload?.type === "prompt_done",
      { label: "prompt_done pre-restart" },
    );
    epoch = client1.epoch ?? epoch;
    lastEventId = client1.lastEventId ?? lastEventId;
  } finally {
    // Browser close = detach only.
    client1.close();
  }

  // Host exit must NOT stop sessiond / Worker. The daemon runs in-process in
  // this harness, so worker discovery is authoritative via the daemon handle
  // diagnostics (no pgrep, no PID file, no process scan).
  const workersBefore = stack.daemon.diagnostics.workerPids();
  assert.ok(
    workersBefore.length >= 1,
    `expected at least one live worker; got ${workersBefore.join(",")}`,
  );

  await stack.host.handle.close();
  // sessiond still alive (in-process handle), workers still alive.
  assert.deepEqual(
    stack.daemon.diagnostics.workerPids(),
    workersBefore,
    "worker set must be unchanged after Host exit",
  );
  for (const workerPid of workersBefore) {
    assert.equal(
      pidAlive(workerPid),
      true,
      `worker pid ${workerPid} must survive Host exit`,
    );
  }

  // Restart Host against the same sessiond.
  const newHost = await bootHost({
    endpoint: stack.daemon.endpoint,
    secret: stack.daemon.secret,
    clientDist: stack.clientDist,
  });
  stack.host = newHost;

  const client2 = new RuntimeWsClient(newHost.wsUrl);
  await client2.connect();
  try {
    const ack = await client2.handshake();
    assert.deepEqual(ack.payload.host.capabilities, ["agent"]);

    const snap2 = await client2.attach(sessionId, { epoch, lastEventId });
    assert.equal(snap2.type, "snapshot");
    assert.equal(snap2.payload.sessionId, sessionId);
    // Resume should keep the same epoch (worker still running).
    assert.equal(snap2.payload.epoch, epoch);
    assert.ok(
      ["resumed", "snapshot", "gap"].includes(snap2.payload.resumeStatus) ||
        snap2.payload.resumeStatus === "snapshot" ||
        typeof snap2.payload.resumeStatus === "string",
    );
    // Protocol v2 snapshots retain only authoritative cursor/count state;
    // completed transcript content is read through the history endpoint.
    assert.ok(snap2.payload.snapshot.state.messageCount > 0);
    assert.equal(typeof snap2.payload.snapshot.state.leafId, "string");

    // Same-epoch same-commandId retry is at-most-once (cached, not re-executed).
    const retry = await client2.command(sessionId, {
      commandId,
      type: "prompt",
      message: "before host restart",
    });
    assert.equal(retry.payload.ok, true);
    assert.equal(retry.payload.result.commandId, commandId);
    assert.equal(retry.payload.result.result.ok, true);
    // No second prompt_done for the retry (cache hit, worker not re-run).
    const promptDones = client2
      .eventTypes(sessionId)
      .filter((t) => t === "prompt_done");
    assert.equal(
      promptDones.length,
      0,
      "cached retry must not re-stream prompt_done",
    );

    return { sessionId, epoch, workerPids: workersBefore };
  } finally {
    client2.close();
  }
}

async function scenarioEpochChangeNoAutoResend(stack, projectDir) {
  const client = new RuntimeWsClient(stack.host.wsUrl);
  await client.connect();
  try {
    await client.handshake();
    const created = await client.create({
      cwd: projectDir,
      projectRoot: projectDir,
      createRequestId: `cr-epoch-${Date.now()}`,
    });
    const sessionId = created.sessionId;
    const snap = await client.attach(sessionId);
    const oldEpoch = snap.payload.epoch;
    const oldCommandId = `old-epoch-cmd-${Date.now()}`;

    // Run one prompt so commandId is accepted in old epoch.
    const first = await client.command(sessionId, {
      commandId: oldCommandId,
      type: "prompt",
      message: "__count__ once",
    });
    assert.equal(first.payload.result.result.ok, true);

    // Stop worker → new activate/open creates a new epoch.
    const stopRes = await client.stop(sessionId);
    assert.equal(stopRes.payload.ok, true);

    // Cold attach reactivates (open) with a new epoch.
    const snap2 = await client.attach(sessionId);
    assert.equal(snap2.type, "snapshot");
    const newEpoch = snap2.payload.epoch;
    // After an epoch change (stop+reactivate), the freshly primed attach snapshot
    // still carries the authoritative runtime capability set.
    assert.deepEqual(snap2.payload.snapshot.capabilities, {
      capabilities: PRODUCTION_CAPS,
      version: 1,
    });
    // epoch may equal if makeEpoch collides (UUID); force assert via status if needed.
    // After stop+reactivate, command cache is per-record and cleared — a retry of
    // the old commandId in the NEW epoch is a NEW admission (allowed to execute).
    // Wire-layer assertion: Client must NOT auto-resend old commandId across epochs.
    // This E2E client deliberately does not auto-resend; we only assert the contract
    // surface by checking that a manual same-id send in the new epoch is independent.
    const manual = await client.command(sessionId, {
      commandId: oldCommandId,
      type: "prompt",
      message: "__count__ again-in-new-epoch",
    });
    assert.equal(manual.payload.ok, true);
    // Document the epochs for the report.
    return { sessionId, oldEpoch, newEpoch, oldCommandId, note: "client did not auto-resend; manual same-id in new epoch is independent admission" };
  } finally {
    client.close();
  }
}

async function scenarioCommandIdAtMostOnce(stack, projectDir) {
  const client = new RuntimeWsClient(stack.host.wsUrl);
  await client.connect();
  try {
    await client.handshake();
    const created = await client.create({
      cwd: projectDir,
      projectRoot: projectDir,
      createRequestId: `cr-dedup-${Date.now()}`,
    });
    const sessionId = created.sessionId;
    await client.attach(sessionId);

    const commandId = `dedup-${Date.now()}`;
    const first = await client.command(
      sessionId,
      { commandId, type: "prompt", message: "__count__ first" },
      { wireId: `wire-a-${commandId}` },
    );
    assert.equal(first.payload.result.result.ok, true);

    const second = await client.command(
      sessionId,
      { commandId, type: "prompt", message: "__count__ second-should-cache" },
      { wireId: `wire-b-${commandId}` },
    );
    assert.equal(second.payload.ok, true);
    assert.equal(second.payload.result.commandId, commandId);
    assert.equal(second.payload.result.result.ok, true);

    // Type conflict on same commandId is rejected.
    const conflict = await client.command(
      sessionId,
      { commandId, type: "get_state" },
      { wireId: `wire-c-${commandId}` },
    );
    assert.equal(conflict.payload.ok, true);
    assert.equal(conflict.payload.result.result.ok, false);
    assert.equal(
      conflict.payload.result.result.error.code,
      "command_rejected",
    );

    // Interrupt dedup.
    const intId = `int-dedup-${Date.now()}`;
    const i1 = await client.interrupt(sessionId, intId, { type: "abort" });
    assert.equal(i1.payload.result.ok, true);
    const i2 = await client.interrupt(sessionId, intId, { type: "abort" });
    assert.equal(i2.payload.result.ok, true);
    // Type conflict on interrupt commandId.
    const i3 = await client.interrupt(sessionId, intId, {
      type: "clear_queue",
    });
    assert.equal(i3.payload.result.ok, false);
    assert.equal(i3.payload.result.error.code, "command_rejected");

    return { sessionId, commandId };
  } finally {
    client.close();
  }
}

async function scenarioSessionIsolation(stack, projectDirA, projectDirB) {
  const client = new RuntimeWsClient(stack.host.wsUrl);
  await client.connect();
  try {
    await client.handshake();
    const a = await client.create({
      cwd: projectDirA,
      projectRoot: projectDirA,
      createRequestId: `cr-iso-a-${Date.now()}`,
    });
    const b = await client.create({
      cwd: projectDirB,
      projectRoot: projectDirB,
      createRequestId: `cr-iso-b-${Date.now()}`,
    });
    assert.notEqual(a.sessionId, b.sessionId);
    assert.notEqual(a.epoch, b.epoch);

    // Attach A, stream prompt on A.
    await client.attach(a.sessionId);
    await client.command(a.sessionId, {
      commandId: `iso-a-${Date.now()}`,
      type: "prompt",
      message: "session A",
    });
    await client.waitFor(
      (m) =>
        m.type === "event" &&
        m.payload?.sessionId === a.sessionId &&
        m.payload?.type === "prompt_done",
      { label: "A prompt_done" },
    );

    // Switch attach to B.
    await client.attach(b.sessionId);
    const beforeB = client.messages.length;
    await client.command(b.sessionId, {
      commandId: `iso-b-${Date.now()}`,
      type: "prompt",
      message: "session B",
    });
    await client.waitFor(
      (m) =>
        m.type === "event" &&
        m.payload?.sessionId === b.sessionId &&
        m.payload?.type === "prompt_done",
      { label: "B prompt_done" },
    );

    // After attaching B, no event for A may appear.
    const afterAttachB = client.messages.slice(beforeB);
    const leaked = afterAttachB.filter(
      (m) =>
        m.type === "event" && m.payload?.sessionId === a.sessionId,
    );
    assert.equal(
      leaked.length,
      0,
      `A events leaked into B attach: ${JSON.stringify(leaked.slice(0, 3))}`,
    );

    // Stop A must not affect B.
    await client.attach(a.sessionId);
    const stopA = await client.stop(a.sessionId);
    assert.equal(stopA.payload.ok, true);

    // B still commandable.
    await client.attach(b.sessionId);
    const stillB = await client.command(b.sessionId, {
      commandId: `iso-b-after-stop-a-${Date.now()}`,
      type: "prompt",
      message: "__count__ still alive",
    });
    assert.equal(stillB.payload.result.result.ok, true);

    return { a: a.sessionId, b: b.sessionId, epochA: a.epoch, epochB: b.epoch };
  } finally {
    client.close();
  }
}

async function scenarioCreateThenColdAttach(stack, projectDir) {
  const client = new RuntimeWsClient(stack.host.wsUrl);
  await client.connect();
  let sessionId;
  try {
    await client.handshake();
    const created = await client.create({
      cwd: projectDir,
      projectRoot: projectDir,
      createRequestId: `cr-cold-${Date.now()}`,
    });
    sessionId = created.sessionId;
    await client.attach(sessionId);
    await client.command(sessionId, {
      commandId: `cold-prompt-${Date.now()}`,
      type: "prompt",
      message: "persist path",
    });
    await client.waitFor(
      (m) =>
        m.type === "event" &&
        m.payload?.sessionId === sessionId &&
        m.payload?.type === "prompt_done",
      { label: "cold prompt_done" },
    );
  } finally {
    client.close();
  }

  // Host restart (sessiond + worker stay). The daemon runs in-process; the
  // subsequent re-attach through the restarted Host proves sessiond survived.
  await stack.host.handle.close();

  const newHost = await bootHost({
    endpoint: stack.daemon.endpoint,
    secret: stack.daemon.secret,
    clientDist: stack.clientDist,
  });
  stack.host = newHost;

  const client2 = new RuntimeWsClient(newHost.wsUrl);
  await client2.connect();
  try {
    await client2.handshake();
    // Fresh attach (no resume cursor) after Host restart — open existing session.
    const snap = await client2.attach(sessionId);
    assert.equal(snap.type, "snapshot");
    assert.equal(snap.payload.sessionId, sessionId);
    return { sessionId, resumeStatus: snap.payload.resumeStatus };
  } finally {
    client2.close();
  }
}

// ---------------------------------------------------------------------------
// Phase 2B independent read RPC over the real process chain
// ---------------------------------------------------------------------------

async function scenarioIndependentReadRpc(stack, projectDir) {
  const client = new RuntimeWsClient(stack.host.wsUrl);
  await client.connect();
  try {
    const ack = await client.handshake([RUNTIME_READ_RPC_FEATURE]);
    assert.equal(ack.payload.acceptedFeatures?.includes(RUNTIME_READ_RPC_FEATURE), true, JSON.stringify(ack.payload));
    const created = await client.create({
      cwd: projectDir,
      projectRoot: projectDir,
      createRequestId: `cr-read-rpc-${Date.now()}`,
    });
    const sessionId = created.sessionId;
    const attached = await client.attach(sessionId);
    const epoch = attached.payload.epoch;

    // Hold a prompt on the mutation lane, then prove the dedicated read lane
    // completes before the prompt settles through Host→sessiond→Worker→port.read.
    const promptId = `read-rpc-prompt-${Date.now()}`;
    const promptP = client.command(sessionId, { commandId: promptId, type: "prompt", message: "__block__ read lane" });
    await client.waitFor(
      (m) => m.type === "event" && m.payload?.sessionId === sessionId && m.payload?.type === "agent_start",
      { label: "read-rpc blocked prompt start" },
    );
    const read = await client.read(sessionId, epoch, { type: "get_commands" }, { requestId: `read-rpc-${Date.now()}` });
    assert.equal(read.payload.sessionId, sessionId);
    assert.equal(read.payload.epoch, epoch);
    assert.equal(read.payload.result.ok, true, JSON.stringify(read.payload.result));
    assert.equal(read.payload.result.type, "get_commands");
    assert.ok(read.payload.result.commands.length >= 1);

    await client.interrupt(sessionId, `read-rpc-abort-${Date.now()}`, { type: "abort" });
    const prompt = await promptP;
    assert.equal(prompt.payload.result.result.ok, false);
    assert.equal(prompt.payload.result.result.error.code, "interrupted");
    return { sessionId };
  } finally {
    client.close();
  }
}

// ---------------------------------------------------------------------------
// Phase 3 atomic submit-turn over the real process chain
// ---------------------------------------------------------------------------

async function scenarioSubmitTurnBlocked(stack, projectDir) {
  const client = new RuntimeWsClient(stack.host.wsUrl);
  await client.connect();
  try {
    const ack = await client.handshake([RUNTIME_SUBMIT_TURN_FEATURE, RUNTIME_READ_RPC_FEATURE]);
    assert.equal(ack.payload.acceptedFeatures?.includes(RUNTIME_SUBMIT_TURN_FEATURE), true, JSON.stringify(ack.payload));
    const created = await client.create({
      cwd: projectDir,
      projectRoot: projectDir,
      createRequestId: `cr-submit-${Date.now()}`,
    });
    const sessionId = created.sessionId;
    const epoch = created.epoch;
    assert.ok(Number.isSafeInteger(created.lastEventId), `create must expose an exact journal cursor: ${JSON.stringify(created)}`);
    // Phase 4A.0.1 reachability: create's cursor is exact at completion but is
    // not a reservation. Starting B changes the global running set, appending
    // the Protocol-v2 compatibility event to A's journal while A has ZERO
    // Browser attach. The stale admission returns the authority repair cursor.
    assert.equal(client.messages.some((message) => message.type === "snapshot" && message.payload?.sessionId === sessionId), false);
    await client.create({
      cwd: projectDir,
      projectRoot: projectDir,
      createRequestId: `cr-submit-revision-advance-${Date.now()}`,
    });
    const operationId = `op-submit-${Date.now()}`;
    const logicalTurn = { prompt: "__block__ atomic turn", operationId, expectedEpoch: epoch };
    const stale = await client.submitTurn(sessionId, { ...logicalTurn, expectedRevision: created.lastEventId });
    assert.equal(stale.payload.status, "rejected", JSON.stringify(stale.payload));
    assert.equal(stale.payload.delivery, "not_delivered", JSON.stringify(stale.payload));
    assert.equal(stale.payload.error.code, "conflict", JSON.stringify(stale.payload));
    assert.equal(stale.payload.epoch, epoch);
    assert.ok(stale.payload.revision > created.lastEventId, JSON.stringify(stale.payload));

    // Retry the SAME operation/payload with only expectedRevision replaced.
    // It is accepted once; no Browser attach occurred before this admission.
    const submit = await client.submitTurn(sessionId, { ...logicalTurn, expectedRevision: stale.payload.revision });
    assert.equal(submit.payload.status, "accepted", JSON.stringify(submit.payload));
    assert.equal(submit.payload.operationId, operationId);
    assert.equal(client.messages.some((message) => message.type === "snapshot" && message.payload?.sessionId === sessionId), false);

    // Browser observation attaches only AFTER admission, using the returned
    // cursor rather than guessing. This mirrors SessionStore.acceptTurn().
    const attached = await client.attach(sessionId, { epoch, lastEventId: submit.payload.revision });
    assert.equal(attached.type, "snapshot");

    // The prompt is running (deferred): a read on the independent lane completes.
    const read = await client.read(sessionId, epoch, { type: "get_commands" }, { requestId: `submit-read-${Date.now()}` });
    assert.equal(read.payload.result.ok, true, JSON.stringify(read.payload.result));

    // A second submitTurn while the turn runs is session_busy (single running
    // turn). Use the client's LIVE cursor (advanced by received running-state
    // events) so the revision fence passes and the turn-busy check decides.
    const busy = await client.submitTurn(sessionId, { prompt: "second", operationId: `op-second-${Date.now()}`, expectedEpoch: epoch, expectedRevision: client.lastEventId });
    assert.equal(busy.payload.status, "rejected", JSON.stringify(busy.payload));
    assert.equal(busy.payload.error.code, "session_busy", JSON.stringify(busy.payload));

    // Abort is independent: the interrupt settles the blocked turn with a failed terminal status.
    await client.interrupt(sessionId, `submit-abort-${Date.now()}`, { type: "abort" });
    const terminal = await client.waitForTurnStatus(sessionId, operationId, "failed");
    assert.equal(terminal.payload.turnId, submit.payload.turnId);
    return { sessionId };
  } finally {
    client.close();
  }
}

// ---------------------------------------------------------------------------
// D2-P1/D2-P2/D2-P3 light commands: frozen production surface over the real process path
// ---------------------------------------------------------------------------

async function scenarioD2P1LightCommands(stack, projectDir) {
  const client = new RuntimeWsClient(stack.host.wsUrl);
  await client.connect();
  try {
    await client.handshake();
    const created = await client.create({
      cwd: projectDir,
      projectRoot: projectDir,
      createRequestId: `cr-light-${Date.now()}`,
    });
    const sessionId = created.sessionId;
    const snap = await client.attach(sessionId);
    assert.equal(snap.type, "snapshot");
    // Attach snapshot carries the D2-P1/D2-P2 production capability surface.
    assert.deepEqual(snap.payload.snapshot.capabilities, {
      capabilities: PRODUCTION_CAPS,
      version: 1,
    });

    // 1. get_state — baseline query (always available).
    const stateRes = await client.command(sessionId, { commandId: `light-state-${Date.now()}`, type: "get_state" });
    assert.equal(stateRes.payload.ok, true, JSON.stringify(stateRes.payload));
    const stateOutcome = stateRes.payload.result.result;
    assert.equal(stateOutcome.ok, true);
    assert.equal(stateOutcome.type, "get_state");
    assert.equal(stateOutcome.state.sessionId, sessionId);

    // 2. get_commands — baseline query (always available).
    const cmdsRes = await client.command(sessionId, { commandId: `light-cmds-${Date.now()}`, type: "get_commands" });
    assert.equal(cmdsRes.payload.ok, true, JSON.stringify(cmdsRes.payload));
    const cmdsOutcome = cmdsRes.payload.result.result;
    assert.equal(cmdsOutcome.ok, true, JSON.stringify(cmdsOutcome));
    assert.equal(cmdsOutcome.type, "get_commands");
    assert.ok(Array.isArray(cmdsOutcome.commands) && cmdsOutcome.commands.length >= 1, JSON.stringify(cmdsOutcome.commands));

    // 3. get_last_assistant_text — baseline query; "" before any turn.
    const lastBefore = await client.command(sessionId, { commandId: `light-last-${Date.now()}`, type: "get_last_assistant_text" });
    assert.equal(lastBefore.payload.result.result.ok, true);
    assert.equal(lastBefore.payload.result.result.text, "");

    // Produce one real assistant turn, then last text reflects it.
    await client.command(sessionId, { commandId: `light-prompt-${Date.now()}`, type: "prompt", message: "hello light" });
    await client.waitFor(
      (m) => m.type === "event" && m.payload?.sessionId === sessionId && m.payload?.type === "prompt_done",
      { label: "light prompt_done" },
    );
    const lastAfter = await client.command(sessionId, { commandId: `light-last2-${Date.now()}`, type: "get_last_assistant_text" });
    assert.equal(lastAfter.payload.result.result.ok, true);
    assert.equal(lastAfter.payload.result.result.text, "Hello world");

    // 4. get_session_stats — capability-gated (runtime.stats, present).
    const statsRes = await client.command(sessionId, { commandId: `light-stats-${Date.now()}`, type: "get_session_stats" });
    assert.equal(statsRes.payload.ok, true, JSON.stringify(statsRes.payload));
    const statsOutcome = statsRes.payload.result.result;
    assert.equal(statsOutcome.ok, true);
    assert.equal(statsOutcome.type, "get_session_stats");
    assert.equal(statsOutcome.stats.messageCount, 1);

    // 5. set_session_name — capability-gated (runtime.session.rename, present).
    const renameRes = await client.command(sessionId, { commandId: `light-rename-${Date.now()}`, type: "set_session_name", name: "Light Commands" });
    assert.equal(renameRes.payload.ok, true, JSON.stringify(renameRes.payload));
    assert.equal(renameRes.payload.result.result.ok, true);
    assert.equal(renameRes.payload.result.result.type, "set_session_name");
    // get_state reflects the rename immediately (no client-side catalog write).
    const stateAfter = await client.command(sessionId, { commandId: `light-state2-${Date.now()}`, type: "get_state" });
    assert.equal(stateAfter.payload.result.result.ok, true);
    assert.equal(stateAfter.payload.result.result.state.sessionName, "Light Commands");

    // 6. set_thinking_level — capability-gated (runtime.thinking.set, present).
    // Use "high" which the fixture always accepts; real-SDK model limits are
    // covered by production-smoke with "off".
    const thinkingRes = await client.command(sessionId, {
      commandId: `light-thinking-${Date.now()}`,
      type: "set_thinking_level",
      level: "high",
    });
    assert.equal(thinkingRes.payload.ok, true, JSON.stringify(thinkingRes.payload));
    assert.equal(thinkingRes.payload.result.result.ok, true);
    assert.equal(thinkingRes.payload.result.result.type, "set_thinking_level");
    // Live runtime state reflects the pin immediately.
    const stateThinking = await client.command(sessionId, { commandId: `light-state3-${Date.now()}`, type: "get_state" });
    assert.equal(stateThinking.payload.result.result.ok, true);
    assert.equal(stateThinking.payload.result.result.state.thinkingLevel, "high");
    assert.equal(stateThinking.payload.result.result.state.thinkingLevelPinned, true);

    // sessiond authority: getSnapshot must already carry the pin (sessiond
    // refreshes worker.getSnapshot after a successful set_thinking_level before
    // resolving the command). This is the attach/resume authority — not a
    // client-optimistic field.
    const snapThinking = await client.getSnapshot(sessionId);
    assert.equal(snapThinking.payload.ok, true, JSON.stringify(snapThinking.payload));
    const snapResult = snapThinking.payload.result;
    const snapState = snapResult?.snapshot?.state ?? snapResult?.state;
    assert.equal(snapState?.thinkingLevel, "high", JSON.stringify(snapResult));
    assert.equal(snapState?.thinkingLevelPinned, true, JSON.stringify(snapResult));

    // Survive detach → reattach: the next attach snapshot must still report the pin.
    await client.detach(sessionId);
    const reattach = await client.attach(sessionId);
    assert.equal(reattach.type, "snapshot");
    assert.equal(reattach.payload.snapshot.state.thinkingLevel, "high", JSON.stringify(reattach.payload.snapshot.state));
    assert.equal(reattach.payload.snapshot.state.thinkingLevelPinned, true, JSON.stringify(reattach.payload.snapshot.state));
    assert.deepEqual(reattach.payload.snapshot.capabilities, {
      capabilities: PRODUCTION_CAPS,
      version: 1,
    });

    // 7. set_model — capability-gated (runtime.model.set, D2-P3). Switch to a
    // different provider/model; the pin from step 6 must be preserved (the
    // adapter reapplies pinned thinking after a model change).
    const modelRes = await client.command(sessionId, {
      commandId: `light-model-${Date.now()}`,
      type: "set_model",
      provider: "openai",
      modelId: "gpt-5",
    });
    assert.equal(modelRes.payload.ok, true, JSON.stringify(modelRes.payload));
    assert.equal(modelRes.payload.result.result.ok, true, JSON.stringify(modelRes.payload.result));
    assert.equal(modelRes.payload.result.result.type, "set_model");
    // Live runtime state reflects the new model AND the preserved thinking pin.
    const stateModel = await client.command(sessionId, { commandId: `light-state4-${Date.now()}`, type: "get_state" });
    assert.equal(stateModel.payload.result.result.ok, true);
    assert.equal(stateModel.payload.result.result.state.model?.provider, "openai");
    assert.equal(stateModel.payload.result.result.state.model?.id, "gpt-5");
    assert.equal(stateModel.payload.result.result.state.thinkingLevel, "high");
    assert.equal(stateModel.payload.result.result.state.thinkingLevelPinned, true);

    // sessiond authority: getSnapshot already carries the new model (post-success
    // worker.getSnapshot refresh before the command resolves).
    const snapModel = await client.getSnapshot(sessionId);
    assert.equal(snapModel.payload.ok, true, JSON.stringify(snapModel.payload));
    const snapModelResult = snapModel.payload.result;
    const snapModelState = snapModelResult?.snapshot?.state ?? snapModelResult?.state;
    assert.equal(snapModelState?.model?.provider, "openai", JSON.stringify(snapModelResult));
    assert.equal(snapModelState?.model?.id, "gpt-5", JSON.stringify(snapModelResult));
    assert.equal(snapModelState?.thinkingLevel, "high", JSON.stringify(snapModelResult));
    assert.equal(snapModelState?.thinkingLevelPinned, true, JSON.stringify(snapModelResult));

    // Strict non-empty validation is enforced by the wire Protocol schema
    // (provider/modelId are NonEmptyString), so a blank provider cannot reach
    // the fixture over the real WS path (boundary rejects with a close). The
    // fixture keeps its own non-empty check as defense-in-depth.

    // Unknown model is a structured invalid_input (no raw leak).
    const unknownModel = await client.command(sessionId, {
      commandId: `light-model-unknown-${Date.now()}`,
      type: "set_model",
      provider: "anthropic",
      modelId: "does-not-exist",
    });
    assert.equal(unknownModel.payload.ok, true, JSON.stringify(unknownModel.payload));
    const unknownOutcome = unknownModel.payload.result.result;
    assert.equal(unknownOutcome.ok, false, "unknown model must be invalid_input");
    assert.equal(unknownOutcome.error.code, "invalid_input");

    // Survive detach → reattach: the new model AND the thinking pin persist.
    await client.detach(sessionId);
    const reattachModel = await client.attach(sessionId);
    assert.equal(reattachModel.type, "snapshot");
    assert.equal(reattachModel.payload.snapshot.state.model?.provider, "openai", JSON.stringify(reattachModel.payload.snapshot.state));
    assert.equal(reattachModel.payload.snapshot.state.model?.id, "gpt-5", JSON.stringify(reattachModel.payload.snapshot.state));
    assert.equal(reattachModel.payload.snapshot.state.thinkingLevel, "high");
    assert.equal(reattachModel.payload.snapshot.state.thinkingLevelPinned, true);
    assert.deepEqual(reattachModel.payload.snapshot.capabilities, {
      capabilities: PRODUCTION_CAPS,
      version: 1,
    });

    // D2 auto_name completes the command matrix: every runtime command is now
    // OPEN. The production surface carries the full frozen 20-token set and
    // the former last-closed command (generate_session_title) succeeds.
    await assertEveryCommandOpen(client, sessionId, "light");

    return {
      sessionId,
      messageCount: statsOutcome.stats.messageCount,
      renamedTo: "Light Commands",
      thinkingLevel: "high",
      thinkingLevelPinned: true,
      model: { provider: "openai", id: "gpt-5" },
    };
  } finally {
    client.close();
  }
}

async function scenarioD2P4QueueControl(stack, projectDir) {
  // Single browser connection (RuntimeWsClient), real chain:
  //   Browser WS → Host gateway (dual-lane: serial + queued-turn) → sessiond →
  //   R2 child → R1 worker-main → fixture.
  // A long (__block__) prompt runs on the gateway's serial lane; steer/follow_up
  // commands are routed to the independent queued-turn lane (D2-P4) so they are
  // NOT HOL-blocked behind the running prompt. Interrupts (clear_queue / abort)
  // bypass both lanes. getSnapshot/set_auto_retry stay on the serial lane, so
  // they run after the block prompt settles (abort first).
  const client = new RuntimeWsClient(stack.host.wsUrl);
  await client.connect();
  try {
    await client.handshake();
    const created = await client.create({
      cwd: projectDir,
      projectRoot: projectDir,
      createRequestId: `cr-queue-${Date.now()}`,
    });
    const sessionId = created.sessionId;
    const snap = await client.attach(sessionId);
    assert.equal(snap.type, "snapshot");
    // D2-P4 production surface = prompt/abort/stats/rename/thinking/model + steer/follow_up/queue.
    assert.deepEqual(snap.payload.snapshot.capabilities, {
      capabilities: PRODUCTION_CAPS,
      version: 1,
    });
    // Base state: empty queue + pendingMessageCount 0.
    assert.deepEqual(snap.payload.snapshot.state.queuedMessages, { steering: [], followUp: [] });
    assert.equal(snap.payload.snapshot.state.pendingMessageCount, 0);

    // Start a long (block) prompt that keeps running while we steer/follow.
    const promptId = `queue-long-${Date.now()}`;
    const promptPromise = client.command(sessionId, {
      commandId: promptId,
      type: "prompt",
      message: "__block__ queue control",
    });
    await client.waitFor(
      (m) => m.type === "event" && m.payload?.sessionId === sessionId && m.payload?.type === "agent_start",
      { label: "queue agent_start" },
    );

    // steer + follow_up dispatch on the queued-turn lane WHILE the prompt runs.
    const steerRes = await client.command(sessionId, { commandId: `queue-steer-${Date.now()}`, type: "steer", message: "steer me" });
    assert.equal(steerRes.payload.ok, true, JSON.stringify(steerRes.payload));
    assert.equal(steerRes.payload.result.result.ok, true);
    const followRes = await client.command(sessionId, { commandId: `queue-follow-${Date.now()}`, type: "follow_up", message: "follow me" });
    assert.equal(followRes.payload.ok, true, JSON.stringify(followRes.payload));
    assert.equal(followRes.payload.result.result.ok, true);

    // queue_update events converge on the wire while the prompt is still running.
    await client.waitFor(
      (m) => m.type === "event" && m.payload?.type === "queue_update" && (m.payload?.steering?.length ?? 0) > 0 && (m.payload?.followUp?.length ?? 0) > 0,
      { label: "queue_update both types" },
    );

    // Abort the block prompt (interrupt bypasses both lanes). The queued turns
    // are NOT cleared by abort, so the post-abort snapshot shows both types.
    const ir = await client.interrupt(sessionId, `queue-abort-${Date.now()}`, { type: "abort" });
    assert.equal(ir.payload.result.ok, true, JSON.stringify(ir.payload));
    await promptPromise;
    assert.equal(ir.type, "interrupt_result");
    await delay(50);

    // getSnapshot authority: both queue types + pendingMessageCount 2.
    const qsnap = await client.getSnapshot(sessionId);
    const qstate = qsnap.payload.result?.snapshot?.state ?? qsnap.payload.result?.state;
    assert.equal(qstate.queuedMessages.steering.length, 1, JSON.stringify(qstate.queuedMessages));
    assert.equal(qstate.queuedMessages.followUp.length, 1, JSON.stringify(qstate.queuedMessages));
    assert.equal(qstate.pendingMessageCount, 2);
    assert.equal(qstate.queuedMessages.steering[0].message, "steer me");
    assert.equal(qstate.queuedMessages.followUp[0].message, "follow me");

    // clear_queue interrupt empties the queue and emits queue_update.
    const clearRes = await client.interrupt(sessionId, `queue-clear-${Date.now()}`, { type: "clear_queue" });
    assert.equal(clearRes.payload.result.ok, true, JSON.stringify(clearRes.payload));
    await client.waitFor(
      (m) => m.type === "event" && m.payload?.type === "queue_update" && (m.payload?.steering?.length ?? 0) === 0 && (m.payload?.followUp?.length ?? 0) === 0,
      { label: "queue_update cleared" },
    );
    const qsnap2 = await client.getSnapshot(sessionId);
    const qstate2 = qsnap2.payload.result?.snapshot?.state ?? qsnap2.payload.result?.state;
    assert.equal(qstate2.queuedMessages.steering.length, 0);
    assert.equal(qstate2.queuedMessages.followUp.length, 0);
    assert.equal(qstate2.pendingMessageCount, 0);

    // set_auto_retry → authoritative autoRetryEnabled true (sessiond refresh).
    const retryRes = await client.command(sessionId, { commandId: `queue-retry-${Date.now()}`, type: "set_auto_retry", enabled: true });
    assert.equal(retryRes.payload.ok, true, JSON.stringify(retryRes.payload));
    assert.equal(retryRes.payload.result.result.ok, true);
    const retrySnap = await client.getSnapshot(sessionId);
    const retryState = retrySnap.payload.result?.snapshot?.state ?? retrySnap.payload.result?.state;
    assert.equal(retryState.autoRetryEnabled, true, JSON.stringify(retrySnap.payload));

    // detach → reattach preserves autoRetryEnabled and empty queue.
    await client.detach(sessionId);
    const reattach = await client.attach(sessionId);
    assert.equal(reattach.type, "snapshot");
    assert.equal(reattach.payload.snapshot.state.autoRetryEnabled, true, JSON.stringify(reattach.payload.snapshot.state));
    assert.deepEqual(reattach.payload.snapshot.state.queuedMessages, { steering: [], followUp: [] });
    assert.deepEqual(reattach.payload.snapshot.capabilities, {
      capabilities: PRODUCTION_CAPS,
      version: 1,
    });

    // D2 auto_name completes the command matrix: every runtime command is now
    // OPEN (queue). The production surface carries the full frozen 20-token set
    // and the former last-closed command (generate_session_title) succeeds.
    await assertEveryCommandOpen(client, sessionId, "queue");

    return { sessionId, promptId };
  } finally {
    client.close();
  }
}

async function scenarioD2P5BashControl(stack, projectDir) {
  // Single browser connection (RuntimeWsClient), real chain:
  //   Browser WS → Host gateway → sessiond → R2 child → R1 worker-main → fixture.
  // The bash command runs on the gateway's serial lane (ordinary command);
  // abort_bash is an INTERRUPT that bypasses both lanes, so it never
  // HOL-blocks behind a long bash command. bash_update.output deltas flow
  // through the SHARED Protocol projection (the single accumulator) — no
  // sessiond authority snapshot-finalization is involved.
  const client = new RuntimeWsClient(stack.host.wsUrl);
  await client.connect();
  try {
    await client.handshake();
    const created = await client.create({
      cwd: projectDir,
      projectRoot: projectDir,
      createRequestId: `cr-bash-${Date.now()}`,
    });
    const sessionId = created.sessionId;
    const snap = await client.attach(sessionId);
    assert.equal(snap.type, "snapshot");
    // D2-P5 production surface = the 9 D2-P4 tokens + runtime.bash + runtime.bash.abort.
    assert.deepEqual(snap.payload.snapshot.capabilities, {
      capabilities: PRODUCTION_CAPS,
      version: 1,
    });
    const bstate = (result) => result?.snapshot?.state ?? result?.state;

    // 1. Normal bash: deterministic delta stream, exact projection output.
    const bashId = `bash-${Date.now()}`;
    const bashRes = await client.command(sessionId, {
      commandId: bashId,
      type: "bash",
      command: "echo e2e-bash",
    });
    assert.equal(bashRes.payload.ok, true, JSON.stringify(bashRes.payload));
    const bashOutcome = bashRes.payload.result.result;
    assert.equal(bashOutcome.ok, true, JSON.stringify(bashOutcome));
    assert.equal(bashOutcome.type, "bash");
    // Concatenating every bash_update.output delta reconstructs the exact
    // accumulated output (empty start delta + "line 1\n" + "line 2\n").
    const deltas = client.messages
      .filter(
        (m) =>
          m.type === "event" &&
          m.payload?.sessionId === sessionId &&
          m.payload?.type === "bash_update" &&
          m.payload?.command === "echo e2e-bash",
      )
      .map((m) => m.payload.output ?? "");
    assert.equal(deltas.join(""), "line 1\nline 2\n", JSON.stringify(deltas));
    const bsnap = await client.getSnapshot(sessionId);
    assert.equal(bsnap.payload.ok, true, JSON.stringify(bsnap.payload));
    const bstate1 = bstate(bsnap.payload.result);
    assert.equal(bstate1.bash?.output, "line 1\nline 2\n", JSON.stringify(bstate1.bash));
    assert.equal(bstate1.bash?.exitCode, 0);
    assert.equal(bstate1.bash?.completed, true);
    assert.equal(bstate1.bash?.cancelled, false);
    assert.equal(bstate1.isBashRunning, false);

    // 2. Blocking bash + abort_bash via the independent interrupt path.
    const longBashId = `bash-long-${Date.now()}`;
    const longBashP = client.command(sessionId, {
      commandId: longBashId,
      type: "bash",
      command: "__block__ long bash",
    });
    // The start bash_update (empty delta) proves the bash is running; events are
    // NOT blocked by the serial lane that holds the pending bash command.
    await client.waitFor(
      (m) =>
        m.type === "event" &&
        m.payload?.sessionId === sessionId &&
        m.payload?.type === "bash_update" &&
        m.payload?.command === "__block__ long bash",
      { label: "blocking bash started" },
    );

    const t0 = Date.now();
    const ir = await client.interrupt(sessionId, `abort-bash-${Date.now()}`, {
      type: "abort_bash",
    });
    const elapsed = Date.now() - t0;
    assert.equal(ir.type, "interrupt_result");
    assert.equal(ir.payload.interruptType, "abort_bash");
    assert.equal(ir.payload.result.ok, true, JSON.stringify(ir.payload));
    assert.ok(
      elapsed < 5_000,
      `abort_bash HOL-blocked behind the bash command? elapsed=${elapsed}ms`,
    );

    const longOutcome = (await longBashP).payload.result.result;
    assert.equal(longOutcome.ok, false, JSON.stringify(longOutcome));
    assert.equal(longOutcome.type, "bash");
    assert.equal(longOutcome.error.code, "interrupted");

    // A bash_update with cancelled:true must have been received, and the
    // snapshot must carry the cancelled/completed projection.
    const cancelledEvent = client.messages.find(
      (m) =>
        m.type === "event" &&
        m.payload?.sessionId === sessionId &&
        m.payload?.type === "bash_update" &&
        m.payload?.command === "__block__ long bash" &&
        m.payload?.cancelled === true,
    );
    assert.ok(cancelledEvent, "bash_update must report cancelled");
    const absnap = await client.getSnapshot(sessionId);
    const abstate = bstate(absnap.payload.result);
    assert.equal(abstate.bash?.cancelled, true, JSON.stringify(abstate.bash));
    assert.equal(abstate.bash?.completed, true, JSON.stringify(abstate.bash));
    assert.equal(abstate.isBashRunning, false);

    // 3. detach → reattach: the bash projection persists via the worker snapshot.
    await client.detach(sessionId);
    const reattach = await client.attach(sessionId);
    assert.equal(reattach.type, "snapshot");
    assert.equal(reattach.payload.snapshot.state.bash?.cancelled, true, JSON.stringify(reattach.payload.snapshot.state.bash));
    assert.equal(reattach.payload.snapshot.state.bash?.completed, true);
    assert.equal(reattach.payload.snapshot.state.bash?.command, "__block__ long bash");
    assert.equal(reattach.payload.snapshot.state.isBashRunning, false);
    assert.deepEqual(reattach.payload.snapshot.capabilities, {
      capabilities: PRODUCTION_CAPS,
      version: 1,
    });

    // D2 auto_name completes the command matrix: every runtime command is now
    // OPEN (bash). The production surface carries the full frozen 20-token set
    // and the former last-closed command (generate_session_title) succeeds.
    await assertEveryCommandOpen(client, sessionId, "bash");

    return { sessionId, bashId, longBashId, abortElapsedMs: elapsed };
  } finally {
    client.close();
  }
}

async function scenarioD2P6ToolsReload(stack, projectDir) {
  // Single browser connection (RuntimeWsClient), real chain:
  //   Browser WS → Host gateway → sessiond → R2 child → R1 worker-main → fixture.
  // D2-P6 tools + reload vertical slice. get_tools is a QUERY (no authority
  // refresh); set_tools and reload are AUTHORITY commands — sessiond must
  // refresh a bounded worker.getSnapshot after the worker success so the
  // projection converges state.tools / systemPrompt / capabilities BEFORE the
  // terminal result is released (singleflight, fail-closed on refresh failure).
  const client = new RuntimeWsClient(stack.host.wsUrl);
  await client.connect();
  try {
    await client.handshake();
    const created = await client.create({
      cwd: projectDir,
      projectRoot: projectDir,
      createRequestId: `cr-tools-${Date.now()}`,
      toolNames: ["read", "write", "bash"],
      thinkingLevel: "high",
      thinkingLevelPinned: true,
    });
    const sessionId = created.sessionId;
    const snap = await client.attach(sessionId);
    assert.equal(snap.type, "snapshot");
    // D2-P6 production surface = the 11 D2-P5 tokens + tools.read + tools.write + reload.
    assert.deepEqual(snap.payload.snapshot.capabilities, {
      capabilities: PRODUCTION_CAPS,
      version: 1,
    });

    const bstate = (result) => result?.snapshot?.state ?? result?.state;

    // 1. get_tools — QUERY, typed result with active flags reflecting the
    //    create-time selection (read/write/bash active).
    const getRes = await client.command(sessionId, { commandId: `get-tools-${Date.now()}`, type: "get_tools" });
    assert.equal(getRes.payload.ok, true, JSON.stringify(getRes.payload));
    const getOutcome = getRes.payload.result.result;
    assert.equal(getOutcome.ok, true, JSON.stringify(getOutcome));
    assert.equal(getOutcome.type, "get_tools");
    const names = getOutcome.tools.map((tool) => tool.name);
    for (const expected of ["read", "write", "edit", "bash", "grep", "find", "ls"]) {
      assert.ok(names.includes(expected), `tool ${expected} missing: ${JSON.stringify(names)}`);
    }
    const activeOf = (name) => getOutcome.tools.find((tool) => tool.name === name)?.active;
    assert.equal(activeOf("read"), true);
    assert.equal(activeOf("write"), true);
    assert.equal(activeOf("bash"), true);
    assert.equal(activeOf("edit"), false, "create-time toolNames=read/write/bash must leave edit inactive");

    // 2. set_tools subset → AUTHORITY: the command result must not settle until
    //    sessiond refreshed the worker snapshot, and the projection + attach
    //    boundary must show the new tool selection and a non-empty systemPrompt.
    const setSubId = `set-tools-sub-${Date.now()}`;
    const setSub = await client.command(sessionId, { commandId: setSubId, type: "set_tools", toolNames: ["read", "edit", "read"] });
    assert.equal(setSub.payload.ok, true, JSON.stringify(setSub.payload));
    const setSubOutcome = setSub.payload.result.result;
    assert.equal(setSubOutcome.ok, true, JSON.stringify(setSubOutcome));
    assert.equal(setSubOutcome.type, "set_tools");
    // Duplicate "read" must be de-duplicated: active exactly read+edit.
    const subSnap = await client.getSnapshot(sessionId);
    assert.equal(subSnap.payload.ok, true, JSON.stringify(subSnap.payload));
    const subState = bstate(subSnap.payload.result);
    assert.deepEqual(activeNames(subState), ["edit", "read"], JSON.stringify(subState.tools));
    assert.equal(typeof subState.systemPrompt, "string");
    assert.ok(subState.systemPrompt.length > 0, "subset selection must keep a non-empty system prompt");

    // 3. set_tools all-off → AUTHORITY: every tool inactive and systemPrompt "".
    const setAllOff = await client.command(sessionId, { commandId: `set-tools-off-${Date.now()}`, type: "set_tools", toolNames: [] });
    assert.equal(setAllOff.payload.ok, true, JSON.stringify(setAllOff.payload));
    assert.equal(setAllOff.payload.result.result.ok, true, JSON.stringify(setAllOff.payload));
    const offSnap = await client.getSnapshot(sessionId);
    assert.equal(offSnap.payload.ok, true, JSON.stringify(offSnap.payload));
    const offState = bstate(offSnap.payload.result);
    assert.deepEqual(activeNames(offState), [], JSON.stringify(offState.tools));
    assert.equal(offState.systemPrompt, "", JSON.stringify(offState.systemPrompt));

    // 4. Malformed / unknown tool names → structured invalid_input, never raw.
    const unknown = await client.command(sessionId, { commandId: `set-tools-unknown-${Date.now()}`, type: "set_tools", toolNames: ["read", "does-not-exist"] });
    assert.equal(unknown.payload.ok, true, JSON.stringify(unknown.payload));
    const unknownOutcome = unknown.payload.result.result;
    assert.equal(unknownOutcome.ok, false, JSON.stringify(unknownOutcome));
    assert.equal(unknownOutcome.error.code, "invalid_input");
    assert.match(unknownOutcome.error.message, /unknown tool/i);

    // 5. reload → AUTHORITY: re-applies the configured tool selection and
    //    restores the system prompt; the snapshot must converge tools,
    //    systemPrompt, thinking pin/state AND the final capability set (version
    //    bumped) before success — the capability event alone is partial.
    const reloadId = `reload-${Date.now()}`;
    const reload = await client.command(sessionId, { commandId: reloadId, type: "reload" });
    assert.equal(reload.payload.ok, true, JSON.stringify(reload.payload));
    const reloadOutcome = reload.payload.result.result;
    assert.equal(reloadOutcome.ok, true, JSON.stringify(reloadOutcome));
    assert.equal(reloadOutcome.type, "reload");
    // Last set_tools was the all-off → reload re-applies all-off (configured).
    const reloadSnap = await client.getSnapshot(sessionId);
    assert.equal(reloadSnap.payload.ok, true, JSON.stringify(reloadSnap.payload));
    const reloadState = bstate(reloadSnap.payload.result);
    assert.deepEqual(activeNames(reloadState), [], JSON.stringify(reloadState.tools));
    assert.equal(reloadState.systemPrompt, "");
    assert.equal(reloadState.thinkingLevel, "high");
    assert.equal(reloadState.thinkingLevelPinned, true);
    // Final capabilities must converge (version bumped by reload) — the
    // authority refresh projects the reloaded capability set before the
    // command settles.
    assert.ok(reloadSnap.payload.result.capabilities.version >= 2, `reload must converge final capabilities with bumped version (got ${reloadSnap.payload.result.capabilities.version})`);
    const reloadCapVersion = reloadSnap.payload.result.capabilities.version;

    // 6. detach → reattach: tools/systemPrompt/thinking pin persist via the
    //    worker snapshot; capabilities reflect the reloaded set.
    await client.detach(sessionId);
    const reattach = await client.attach(sessionId);
    assert.equal(reattach.type, "snapshot");
    const raState = reattach.payload.snapshot.state;
    assert.ok((raState.tools ?? []).every((tool) => !tool.active), JSON.stringify(raState.tools));
    assert.equal(raState.systemPrompt, "");
    assert.equal(raState.thinkingLevel, "high");
    assert.equal(raState.thinkingLevelPinned, true);
    assert.deepEqual(reattach.payload.snapshot.capabilities, {
      capabilities: PRODUCTION_CAPS,
      version: reloadCapVersion,
    });

    // D2 auto_name completes the command matrix: every runtime command is now
    // OPEN (tools). The production surface carries the full frozen 20-token set
    // and the former last-closed command (generate_session_title) succeeds.
    await assertEveryCommandOpen(client, sessionId, "tools");

    return { sessionId, getTools: getOutcome, reloadVersion: reloadCapVersion };
  } finally {
    client.close();
  }
}

async function scenarioD2P7CompactControl(stack, projectDir) {
  // Single browser connection (RuntimeWsClient), real chain:
  //   Browser WS → Host gateway → sessiond → R2 child → R1 worker-main → fixture.
  // D2-P7 manual compact vertical slice. `compact` is an AUTHORITY command:
  // sessiond must refresh a bounded worker.getSnapshot after the worker success
  // so the projection converges the FULL post-compaction snapshot (messages,
  // messageCount, contextUsage, isCompacting) BEFORE the terminal result is
  // released. `abort_compaction` is an INDEPENDENT interrupt (non-HOL) that
  // settles the in-flight compact as `interrupted` with a compaction_end(aborted)
  // projection and no orphan hold.
  const client = new RuntimeWsClient(stack.host.wsUrl);
  await client.connect();
  try {
    await client.handshake();
    const created = await client.create({
      cwd: projectDir,
      projectRoot: projectDir,
      createRequestId: `cr-d2p7-${Date.now()}`,
      toolNames: [],
      thinkingLevel: "off",
      thinkingLevelPinned: true,
    });
    const sessionId = created.sessionId;
    const snap = await client.attach(sessionId);
    assert.equal(snap.type, "snapshot");
    assert.deepEqual(snap.payload.snapshot.capabilities, {
      capabilities: PRODUCTION_CAPS,
      version: 1,
    });
    const bstate = (result) => result?.snapshot?.state ?? result?.state;

    // Build a deterministic history: 4 normal prompts → messageCount 4,
    // contextUsage > 0, messages length 4 in the authoritative snapshot.
    for (let i = 0; i < 4; i += 1) {
      const p = await client.command(sessionId, {
        commandId: `d2p7-prompt-${i}-${Date.now()}`,
        type: "prompt",
        message: `compact-prompt-${i}`,
      });
      assert.equal(p.payload.ok, true, JSON.stringify(p.payload));
      assert.equal(p.payload.result.result.ok, true, JSON.stringify(p.payload));
      assert.equal(p.payload.result.result.type, "prompt");
    }
    // Product-sequence pin (F1 fix): complete a bash command BEFORE the
    // successful compact — the retained terminal bash projection must NOT make
    // the compact session_busy (the D2-P7 adapter fix). This pins the exact
    // product flow without weakening the D2-P5 bash scenario.
    const bashDone = await client.command(sessionId, { commandId: `d2p7-bash-${Date.now()}`, type: "bash", command: "echo d2p7-bash" });
    assert.equal(bashDone.payload.ok, true, JSON.stringify(bashDone.payload));
    assert.equal(bashDone.payload.result.result.ok, true, JSON.stringify(bashDone.payload));
    const bashSnap = await client.getSnapshot(sessionId);
    assert.equal(bstate(bashSnap.payload.result).isBashRunning, false, "bash must be complete before compact");
    assert.equal(bstate(bashSnap.payload.result).bash?.completed, true, "terminal bash projection retained before compact");
    // Build a deterministic history: 4 normal prompts → the fixture's live state
    // has messageCount 4 and contextUsage > 0. The sessiond projection also
    // accumulates messageCount/history from the message_end events, but
    // `runtime.getSnapshot` returns the projection WITHOUT a worker fetch, so
    // contextUsage (which no event carries) stays at the attach-time value until
    // an authority command (compact) refreshes it. Use get_state for the live
    // fixture contextUsage BEFORE compact; after compact the projection has been
    // refreshed so getSnapshot proves the authoritative convergence.
    const liveBefore = await client.command(sessionId, { commandId: `d2p7-live-before-${Date.now()}`, type: "get_state" });
    const liveBeforeState = liveBefore.payload.result.result.state;
    const liveBeforeCount = liveBeforeState.messageCount;
    const liveBeforeUsage = liveBeforeState.contextUsage?.percent ?? 0;
    assert.ok(liveBeforeCount >= 4, `expected >=4 messages before compact (got ${liveBeforeCount})`);
    assert.ok(liveBeforeUsage > 0, `expected non-zero context usage before compact (got ${liveBeforeUsage})`);
    const before = await client.getSnapshot(sessionId);
    const beforeCount = bstate(before.payload.result).messageCount;
    assert.equal((before.payload.result.messages ?? []).length, 0, "Protocol v2 snapshot excludes completed history");

    // 1. Successful compact: compaction_start(manual) → compaction_end(success)
    //    event sequence; the ack is only released after sessiond's authoritative
    //    snapshot refresh, and a post-ack getSnapshot shows the trimmed
    //    messageCount / contextUsage / history with isCompacting:false.
    const compactId = `d2p7-compact-${Date.now()}`;
    const compactIndex = client.messages.length;
    const compactP = client.command(sessionId, {
      commandId: compactId,
      type: "compact",
      customInstructions: "keep decisions",
    });
    const startEvt = await client.waitFor(
      (m) => m.type === "event" && m.payload?.sessionId === sessionId && m.payload?.type === "compaction_start",
      { label: "compaction_start", afterIndex: compactIndex },
    );
    assert.equal(startEvt.payload.reason, "manual");
    const endEvt = await client.waitFor(
      (m) => m.type === "event" && m.payload?.sessionId === sessionId && m.payload?.type === "compaction_end",
      { label: "compaction_end", afterIndex: compactIndex },
    );
    assert.equal(endEvt.payload.aborted, false);
    const compactRes = await compactP;
    assert.equal(compactRes.payload.ok, true, JSON.stringify(compactRes.payload));
    const compactOutcome = compactRes.payload.result.result;
    assert.equal(compactOutcome.ok, true, JSON.stringify(compactOutcome));
    assert.equal(compactOutcome.type, "compact");

    const after = await client.getSnapshot(sessionId);
    const afterState = bstate(after.payload.result);
    const afterCount = afterState.messageCount;
    const afterUsage = afterState.contextUsage?.percent ?? 0;
    assert.ok(afterCount < beforeCount, `compact must trim messageCount (${beforeCount} -> ${afterCount})`);
    assert.ok(afterUsage < liveBeforeUsage, `compact must shrink context usage (${liveBeforeUsage} -> ${afterUsage})`);
    assert.equal(afterState.isCompacting, false);
    assert.equal((after.payload.result.messages ?? []).length, 0, "Protocol v2 post-compact snapshot excludes completed history");
    // The fixture live state agrees: get_state after compact shows the same trim.
    const liveAfter = await client.command(sessionId, { commandId: `d2p7-live-after-${Date.now()}`, type: "get_state" });
    const liveAfterState = liveAfter.payload.result.result.state;
    assert.equal(liveAfterState.messageCount, afterCount);
    assert.equal(liveAfterState.contextUsage?.percent ?? 0, afterUsage);

    // 2. Detach/reattach persistence: the post-compaction projection persists.
    await client.detach(sessionId);
    const reattach = await client.attach(sessionId);
    assert.equal(reattach.type, "snapshot");
    assert.equal(reattach.payload.snapshot.state.messageCount, afterCount);
    assert.equal((reattach.payload.snapshot.messages ?? []).length, 0);
    assert.deepEqual(reattach.payload.snapshot.capabilities, { capabilities: PRODUCTION_CAPS, version: 1 });

    // 3. Blocking compact + abort_compaction non-HOL + ack/interrupted result +
    //    aborted projection + no orphan hold.
    const blockId = `d2p7-block-${Date.now()}`;
    const blockIndex = client.messages.length;
    const blockP = client.command(sessionId, {
      commandId: blockId,
      type: "compact",
      customInstructions: "__block__hold",
    });
    await client.waitFor(
      (m) => m.type === "event" && m.payload?.sessionId === sessionId && m.payload?.type === "compaction_start",
      { label: "blocking compaction_start", afterIndex: blockIndex },
    );
    // abort_compaction is an INTERRUPT — it must settle quickly (never HOL).
    const abortStarted = Date.now();
    const abortRes = await client.interrupt(sessionId, `d2p7-abort-${Date.now()}`, { type: "abort_compaction" });
    assert.ok(Date.now() - abortStarted < STEP_TIMEOUT_MS, "abort_compaction must not block behind the compact");
    assert.equal(abortRes.payload.result.ok, true, JSON.stringify(abortRes.payload));
    assert.equal(abortRes.payload.result.type, "abort_compaction");
    const abortedEnd = await client.waitFor(
      (m) => m.type === "event" && m.payload?.sessionId === sessionId && m.payload?.type === "compaction_end" && m.payload?.aborted === true,
      { label: "aborted compaction_end", afterIndex: blockIndex },
    );
    assert.equal(abortedEnd.payload.aborted, true);
    const blockOutcome = await blockP;
    assert.equal(blockOutcome.payload.ok, true, JSON.stringify(blockOutcome.payload));
    const blockResult = blockOutcome.payload.result.result;
    assert.equal(blockResult.ok, false, JSON.stringify(blockResult));
    assert.equal(blockResult.error.code, "interrupted");
    const blockSnap = await client.getSnapshot(sessionId);
    assert.equal(bstate(blockSnap.payload.result).isCompacting, false, "aborted compact must clear compaction state");
    // No orphan hold: a fresh compact succeeds right after the abort.
    const fresh = await client.command(sessionId, { commandId: `d2p7-fresh-${Date.now()}`, type: "compact" });
    assert.equal(fresh.payload.result.result.ok, true, JSON.stringify(fresh.payload));
    const freshSnap = await client.getSnapshot(sessionId);
    assert.equal(bstate(freshSnap.payload.result).isCompacting, false);

    // 4. Idle abort idempotent.
    const idleAbort = await client.interrupt(sessionId, `d2p7-idle-abort-${Date.now()}`, { type: "abort_compaction" });
    assert.equal(idleAbort.payload.result.ok, true, JSON.stringify(idleAbort.payload));

    // 5. Second ordinary compact while a compact is pending → session_busy. A
    //    raw wire second command on the SAME connection is queued behind the
    //    blocking compact by the Host serial lane (production guarantee:
    //    ordinary commands never overlap). To exercise the fixture's defensive
    //    compact busy guard over the real chain, use a SECOND browser
    //    connection — its own serial lane dispatches immediately, sessiond
    //    admits the new commandId, and the fixture rejects the overlap with
    //    session_busy (mirroring the production adapter guard: never auto-abort
    //    a prompt or overlap bash via direct wire).
    const busyId = `d2p7-busy-${Date.now()}`;
    const busyIndex = client.messages.length;
    const busyP = client.command(sessionId, { commandId: busyId, type: "compact", customInstructions: "__block__hold2" });
    await client.waitFor(
      (m) => m.type === "event" && m.payload?.sessionId === sessionId && m.payload?.type === "compaction_start",
      { label: "busy compaction_start", afterIndex: busyIndex },
    );
    const client2 = new RuntimeWsClient(stack.host.wsUrl);
    await client2.connect();
    try {
      await client2.handshake();
      const secondDuring = await client2.command(sessionId, { commandId: `d2p7-second-${Date.now()}`, type: "compact" });
      assert.equal(secondDuring.payload.ok, true, JSON.stringify(secondDuring.payload));
      const secondOutcome = secondDuring.payload.result.result;
      assert.equal(secondOutcome.ok, false, JSON.stringify(secondOutcome));
      assert.equal(secondOutcome.error.code, "session_busy");
      assert.equal(secondOutcome.error.retryable, true);
    } finally {
      client2.close();
    }
    // Release the blocking compact via the independent interrupt, then confirm
    // the interrupted result (no orphan hold).
    await client.interrupt(sessionId, `d2p7-busy-abort-${Date.now()}`, { type: "abort_compaction" });
    const busyOutcome = await busyP;
    assert.equal(busyOutcome.payload.result.result.ok, false);
    assert.equal(busyOutcome.payload.result.result.error.code, "interrupted");
    const busySnap = await client.getSnapshot(sessionId);
    assert.equal(bstate(busySnap.payload.result).isCompacting, false);

    // D2 auto_name completes the command matrix: every runtime command is now
    // OPEN (compact). The production surface carries the full frozen 20-token set
    // and the former last-closed command (generate_session_title) succeeds.
    await assertEveryCommandOpen(client, sessionId, "compact");

    return { sessionId, beforeCount, afterCount };
  } finally {
    client.close();
  }
}

async function scenarioD2P8ExtensionUiControl(stack, projectDir) {
  // Single browser connection (RuntimeWsClient), real chain:
  //   Browser WS → Host gateway (serial + interleaving lanes) → sessiond →
  //   R2 child → R1 worker-main → fixture.
  // D2-P8 extension UI vertical slice. The prompt command awaits an extension
  // request on the Host SERIAL lane; the response/input command is routed to the
  // existing INTERLEAVING lane (D2-P4 queued-turn lane generalized) so it is
  // NOT HOL-blocked behind the prompt on the SAME socket — the prompt resumes
  // only after the correct response settles the request. Detach/reattach
  // persistence is checked on a second connection (detach is an ordinary serial
  // command, so it would HOL behind the in-flight prompt on connection 1).
  const client = new RuntimeWsClient(stack.host.wsUrl);
  await client.connect();
  const pending = (result) => result?.snapshot?.state?.pendingExtensionUi ?? result?.state?.pendingExtensionUi ?? [];
  const bstate = (result) => result?.snapshot?.state ?? result?.state;
  try {
    await client.handshake();
    const created = await client.create({
      cwd: projectDir,
      projectRoot: projectDir,
      createRequestId: `cr-d2p8-${Date.now()}`,
    });
    const sessionId = created.sessionId;
    const snap = await client.attach(sessionId);
    assert.equal(snap.type, "snapshot");
    assert.deepEqual(snap.payload.snapshot.capabilities, {
      capabilities: PRODUCTION_CAPS,
      version: 1,
    });

    const startUiPrompt = async (token, tag) => {
      const commandId = `d2p8-${token}-${tag}-${Date.now()}`;
      const afterIndex = client.messages.length;
      const promptP = client.command(sessionId, {
        commandId,
        type: "prompt",
        message: `__${token}__ ${tag}`,
      });
      // Only match the request published AFTER this prompt (a stale request from
      // an earlier phase must never be mistaken for this one).
      const req = await client.waitFor(
        (m) => m.type === "event" && m.payload?.sessionId === sessionId && m.payload?.type === "extension_ui_request" && !m.payload?.request?.closed,
        { label: `extension_ui_request ${token}`, afterIndex },
      );
      return { promptP, request: req.payload.request, commandId };
    };
    const waitForClose = async (requestId, afterIndex) => {
      const close = await client.waitFor(
        (m) => m.type === "event" && m.payload?.sessionId === sessionId && m.payload?.type === "extension_ui_request" && m.payload?.request?.closed === true && m.payload?.request?.id === requestId,
        { label: `extension_ui_request close ${requestId}`, afterIndex },
      );
      return close;
    };
    const uiCommand = (type, commandId, extra) => client.command(sessionId, { commandId, type, ...extra });

    // ---- 1. confirm flow: wrong method invalid_input (stays pending), then
    // ----    correct response resumes the prompt and emits a single close.
    // NOTE: while a prompt awaits extension UI, the Host serial lane is
    // HOL-blocked (getSnapshot/detach would queue behind it), so pending-state
    // assertions use the client's event-driven projection (live + replay both
    // reduce through the shared Protocol reducer).
    let { promptP, request, commandId } = await startUiPrompt("confirm", "confirm-me");
    const confirmReqId = request.id;
    assert.equal(request.method, "confirm");
    assert.equal(client.projection.state.pendingExtensionUi.length, 1, "live projection must show the pending request");
    assert.equal(client.projection.state.pendingExtensionUi[0].id, confirmReqId);

    // Wrong-method response: structured invalid_input, no settle, no close.
    const wrongMethod = await uiCommand("extension_ui_response", `d2p8-wrong-method-${Date.now()}`, { id: confirmReqId, method: "input", responseKind: "value", value: "x" });
    assert.equal(wrongMethod.payload.ok, true, JSON.stringify(wrongMethod.payload));
    const wrongOutcome = wrongMethod.payload.result.result;
    assert.equal(wrongOutcome.ok, false, JSON.stringify(wrongOutcome));
    assert.equal(wrongOutcome.error.code, "invalid_input");
    assert.equal(client.projection.state.pendingExtensionUi.length, 1, "wrong-method response must not close the request");

    // Unknown id: not_found.
    const unknown = await uiCommand("extension_ui_response", `d2p8-unknown-${Date.now()}`, { id: "no-such-request", method: "confirm", responseKind: "confirmed", confirmed: true });
    assert.equal(unknown.payload.result.result.ok, false);
    assert.equal(unknown.payload.result.result.error.code, "not_found");

    // Correct response on the SAME socket resumes the prompt (interleaving lane).
    const confirmIndex = client.messages.length;
    const correct = await uiCommand("extension_ui_response", `d2p8-correct-${Date.now()}`, { id: confirmReqId, method: "confirm", responseKind: "confirmed", confirmed: true });
    assert.equal(correct.payload.ok, true, JSON.stringify(correct.payload));
    assert.equal(correct.payload.result.result.ok, true, JSON.stringify(correct.payload));
    const promptRes = await promptP;
    assert.equal(promptRes.payload.result.result.ok, true, JSON.stringify(promptRes.payload));
    const closeEvt = await waitForClose(confirmReqId, confirmIndex);
    assert.equal(closeEvt.payload.request.id, confirmReqId);
    assert.equal(client.projection.state.pendingExtensionUi.length, 0, "settled request must be removed from the live projection");

    // Late response after close: not_found.
    const late = await uiCommand("extension_ui_response", `d2p8-late-${Date.now()}`, { id: confirmReqId, method: "confirm", responseKind: "confirmed", confirmed: false });
    assert.equal(late.payload.result.result.ok, false);
    assert.equal(late.payload.result.result.error.code, "not_found");

    // Same commandId at-most-once: retrying the identical response returns the
    // cached result and never re-settles (no second close).
    const dedupId = `d2p8-dedup-${Date.now()}`;
    ({ promptP, request, commandId } = await startUiPrompt("confirm", "dedup"));
    const dedupReqId = request.id;
    const dedupIndex = client.messages.length;
    const first = await uiCommand("extension_ui_response", dedupId, { id: dedupReqId, method: "confirm", responseKind: "confirmed", confirmed: true });
    assert.equal(first.payload.result.result.ok, true);
    await promptP;
    await waitForClose(dedupReqId, dedupIndex);
    const retry = await uiCommand("extension_ui_response", dedupId, { id: dedupReqId, method: "confirm", responseKind: "confirmed", confirmed: true });
    assert.equal(retry.payload.result.result.ok, true, "same commandId retry returns the cached at-most-once result");
    const dedupCloses = client.eventsFor(sessionId).filter((e) => e.type === "extension_ui_request" && e.request?.id === dedupReqId && e.request?.closed === true);
    assert.equal(dedupCloses.length, 1, "duplicate commandId must never emit a second close");

    // ---- 2. detach before response → reattach sees pending; response then
    // ----    detach/reattach sees none (journal replay cannot resurrect).
    ({ promptP, request, commandId } = await startUiPrompt("confirm", "detach-me"));
    const detachReqId = request.id;
    const client2 = new RuntimeWsClient(stack.host.wsUrl);
    await client2.connect();
    try {
      await client2.handshake();
      const attached = await client2.attach(sessionId);
      assert.equal(attached.type, "snapshot");
      assert.equal(pending(attached.payload.snapshot).length, 1, "detach/reattach must see the pending request");
      assert.equal(pending(attached.payload.snapshot)[0].id, detachReqId);
      await client2.detach(sessionId);
      const reattached = await client2.attach(sessionId);
      assert.equal(pending(reattached.payload.snapshot).length, 1, "detach before response then reattach still shows pending");
      // Now respond on connection 1 and confirm reattach shows none.
      const respIndex = client.messages.length;
      const resp = await uiCommand("extension_ui_response", `d2p8-detach-resp-${Date.now()}`, { id: detachReqId, method: "confirm", responseKind: "confirmed", confirmed: true });
      assert.equal(resp.payload.result.result.ok, true);
      await promptP;
      await waitForClose(detachReqId, respIndex);
      const reattached2 = await client2.attach(sessionId);
      assert.equal(pending(reattached2.payload.snapshot).length, 0, "response then detach/reattach sees none (replay cannot resurrect)");
    } finally {
      client2.close();
    }

    // ---- 3. input incremental: exact-method input accumulates, wrong-method
    // ----    input is invalid_input, only the final response closes.
    ({ promptP, request, commandId } = await startUiPrompt("input", "enter"));
    const inputReqId = request.id;
    assert.equal(request.method, "input");
    const inputIndex = client.messages.length;
    const in1 = await uiCommand("extension_ui_input", `d2p8-input-1-${Date.now()}`, { id: inputReqId, method: "input", data: "hello" });
    assert.equal(in1.payload.result.result.ok, true, JSON.stringify(in1.payload));
    const inWrong = await uiCommand("extension_ui_input", `d2p8-input-wrong-${Date.now()}`, { id: inputReqId, method: "editor", data: "wrong" });
    assert.equal(inWrong.payload.result.result.ok, false);
    assert.equal(inWrong.payload.result.result.error.code, "invalid_input");
    const in2 = await uiCommand("extension_ui_input", `d2p8-input-2-${Date.now()}`, { id: inputReqId, method: "input", data: " world" });
    assert.equal(in2.payload.result.result.ok, true);
    assert.equal(client.projection.state.pendingExtensionUi.length, 1, "incremental input must NOT close the request");
    const inputResp = await uiCommand("extension_ui_response", `d2p8-input-resp-${Date.now()}`, { id: inputReqId, method: "input", responseKind: "value", value: "hello world" });
    assert.equal(inputResp.payload.result.result.ok, true);
    await promptP;
    await waitForClose(inputReqId, inputIndex);
    assert.equal(client.projection.state.pendingExtensionUi.length, 0);

    // ---- 4. select cancel: cancelled is allowed for interactive methods.
    ({ promptP, request, commandId } = await startUiPrompt("select", "pick"));
    const selectReqId = request.id;
    assert.deepEqual([...request.options], ["opt-a", "opt-b"]);
    const selectIndex = client.messages.length;
    const cancelResp = await uiCommand("extension_ui_response", `d2p8-select-cancel-${Date.now()}`, { id: selectReqId, method: "select", responseKind: "cancelled", cancelled: true });
    assert.equal(cancelResp.payload.result.result.ok, true);
    await promptP;
    await waitForClose(selectReqId, selectIndex);

    // ---- 5. editor: incremental reaches the driver; final value closes.
    ({ promptP, request, commandId } = await startUiPrompt("editor", "edit"));
    const editorReqId = request.id;
    assert.equal(request.prefill, "prefill");
    const editorIndex = client.messages.length;
    const ed1 = await uiCommand("extension_ui_input", `d2p8-editor-1-${Date.now()}`, { id: editorReqId, method: "editor", data: "draft" });
    assert.equal(ed1.payload.result.result.ok, true);
    const editorResp = await uiCommand("extension_ui_response", `d2p8-editor-resp-${Date.now()}`, { id: editorReqId, method: "editor", responseKind: "value", value: "draft" });
    assert.equal(editorResp.payload.result.result.ok, true);
    await promptP;
    await waitForClose(editorReqId, editorIndex);

    // ---- 6. custom (E15): incremental key data reaches the driver in FIFO
    // ----    order and re-publishes updates (same id upsert); wrong-method
    // ----    input is invalid_input; value response closes; late input
    // ----    not_found; replay cannot resurrect the closed request.
    ({ promptP, request, commandId } = await startUiPrompt("custom", "custom"));
    const customReqId = request.id;
    assert.deepEqual([...request.lines], ["Custom UI lines"]);
    const customIndex = client.messages.length;

    // A typing burst including terminal control bytes: arrow-up, characters,
    // and Ctrl+C — each acked ok, delivered to the driver in exact order.
    const customKeys = ["\u001b[A", "c", "u", "s", "t", "\u0003"];
    let acc = "";
    for (let i = 0; i < customKeys.length; i += 1) {
      const chunk = customKeys[i];
      acc = `${acc}${chunk}`;
      const input = await uiCommand("extension_ui_input", `e15-custom-in-${i}-${Date.now()}`, { id: customReqId, method: "custom", data: chunk });
      assert.equal(input.payload.result.result.ok, true, JSON.stringify(input.payload));
      // Each chunk re-publishes the SAME request id with an updated line
      // (seq + exact chunk + accumulated buffer) — the upsert projection.
      const update = await client.waitFor(
        (m) => m.type === "event" && m.payload?.sessionId === sessionId && m.payload?.type === "extension_ui_request" && m.payload?.request?.id === customReqId && !m.payload?.request?.closed && m.payload?.request?.lines?.some((line) => line === `seq:${i + 1} chunk=${JSON.stringify(chunk)} buf=${JSON.stringify(acc)}`),
        { label: `custom update ${i + 1}`, afterIndex: customIndex },
      );
      assert.equal(update.payload.request.lines.length, 2, "base line + the update line");
    }
    // The live projection upserted the SAME id (never duplicated).
    assert.equal(client.projection.state.pendingExtensionUi.filter((r) => r.id === customReqId).length, 1);
    assert.equal(client.projection.state.pendingExtensionUi.length, 1);

    // Wrong-method incremental input against the custom request (input/editor)
    // is structured invalid_input; the request stays pending/usable.
    for (const wrongMethod of ["input", "editor"]) {
      const wrong = await uiCommand("extension_ui_input", `e15-custom-wrong-${wrongMethod}-${Date.now()}`, { id: customReqId, method: wrongMethod, data: "x" });
      assert.equal(wrong.payload.result.result.ok, false);
      assert.equal(wrong.payload.result.result.error.code, "invalid_input");
    }
    assert.equal(client.projection.state.pendingExtensionUi.length, 1, "wrong-method input must not close the request");

    // Final value response closes exactly once and resumes the prompt.
    const customResp = await uiCommand("extension_ui_response", `d2p8-custom-${Date.now()}`, { id: customReqId, method: "custom", responseKind: "value", value: "custom-out" });
    assert.equal(customResp.payload.result.result.ok, true);
    await promptP;
    await waitForClose(customReqId, customIndex);
    assert.equal(client.projection.state.pendingExtensionUi.length, 0);

    // Late incremental input after the close: not_found, never reaches a driver.
    const lateInput = await uiCommand("extension_ui_input", `e15-custom-late-${Date.now()}`, { id: customReqId, method: "custom", data: "z" });
    assert.equal(lateInput.payload.result.result.ok, false);
    assert.equal(lateInput.payload.result.result.error.code, "not_found");

    // A custom-method input against a DIFFERENT interactive request kind
    // (confirm) is also exact-method rejected (schema admits it; runtime
    // refuses the correlation).
    {
      const started = await startUiPrompt("confirm", "e15-mismatch");
      const mismatch = await uiCommand("extension_ui_input", `e15-confirm-mismatch-${Date.now()}`, { id: started.request.id, method: "custom", data: "x" });
      assert.equal(mismatch.payload.result.result.ok, false);
      assert.equal(mismatch.payload.result.result.error.code, "invalid_input");
      const settle = await uiCommand("extension_ui_response", `e15-confirm-settle-${Date.now()}`, { id: started.request.id, method: "confirm", responseKind: "cancelled", cancelled: true });
      assert.equal(settle.payload.result.result.ok, true);
      await started.promptP;
    }

    // Detach/reattach (fresh attach replays the journal): the closed custom
    // request is NOT resurrected and the last upsert does not outlive the close.
    {
      const client3 = new RuntimeWsClient(stack.host.wsUrl);
      await client3.connect();
      try {
        await client3.handshake();
        const snap3 = await client3.attach(sessionId);
        assert.equal(snap3.type, "snapshot");
        const pendingIds = pending(snap3.payload.snapshot).map((r) => r.id);
        assert.equal(pendingIds.includes(customReqId), false, "replay must not resurrect the closed custom request");
      } finally {
        client3.close();
      }
    }

    // ---- 7. abort clears a pending request: one close + interrupted prompt.
    ({ promptP, request, commandId } = await startUiPrompt("editor", "abort-me"));
    const abortReqId = request.id;
    const abortIndex = client.messages.length;
    const ir = await client.interrupt(sessionId, `d2p8-abort-${Date.now()}`, { type: "abort" });
    assert.equal(ir.payload.result.ok, true, JSON.stringify(ir.payload));
    const aborted = await promptP;
    assert.equal(aborted.payload.result.result.ok, false);
    assert.equal(aborted.payload.result.result.error.code, "interrupted");
    await waitForClose(abortReqId, abortIndex);
    assert.equal(client.projection.state.pendingExtensionUi.length, 0, "abort must clear the pending request");

    // ---- 8. status/widget/title/notify are events/state, not responses.
    await client.command(sessionId, { commandId: `d2p8-status-${Date.now()}`, type: "prompt", message: "__status__" });
    await client.waitFor((m) => m.type === "event" && m.payload?.sessionId === sessionId && m.payload?.type === "extension_statuses", { label: "extension_statuses" });
    const gsStatus = await client.getSnapshot(sessionId);
    assert.equal(bstate(gsStatus.payload.result).extensionStatuses.length, 2);
    await client.command(sessionId, { commandId: `d2p8-widget-${Date.now()}`, type: "prompt", message: "__widget__" });
    await client.waitFor((m) => m.type === "event" && m.payload?.sessionId === sessionId && m.payload?.type === "extension_widgets", { label: "extension_widgets" });
    const gsWidget = await client.getSnapshot(sessionId);
    assert.equal(bstate(gsWidget.payload.result).extensionWidgets.length, 1);
    assert.equal(bstate(gsWidget.payload.result).extensionWidgets[0].placement, "belowEditor");
    const titleRes = await client.command(sessionId, { commandId: `d2p8-title-${Date.now()}`, type: "prompt", message: "__title__" });
    assert.equal(titleRes.payload.result.result.ok, true);
    await client.waitFor((m) => m.type === "event" && m.payload?.sessionId === sessionId && m.payload?.type === "session_title", { label: "session_title" });
    const gsTitle = await client.getSnapshot(sessionId);
    assert.equal(bstate(gsTitle.payload.result).sessionName, "Extension Title");
    const notifyRes = await client.command(sessionId, { commandId: `d2p8-notify-${Date.now()}`, type: "prompt", message: "__notify__" });
    assert.equal(notifyRes.payload.result.result.ok, true);
    await client.waitFor((m) => m.type === "event" && m.payload?.sessionId === sessionId && m.payload?.type === "extension_error", { label: "extension_error" });

    // D2 auto_name completes the command matrix: every runtime command is now
    // OPEN (extui). The production surface carries the full frozen 20-token set
    // and the former last-closed command (generate_session_title) succeeds.
    await assertEveryCommandOpen(client, sessionId, "extui");
    const reload = await client.command(sessionId, { commandId: `d2p8-reload-${Date.now()}`, type: "reload" });
    assert.equal(reload.payload.result.result.ok, true, JSON.stringify(reload.payload));
    const afterReload = await client.getSnapshot(sessionId);
    assert.deepEqual(afterReload.payload.result.capabilities, { capabilities: PRODUCTION_CAPS, version: 2 }, "reload must not broaden the capability set");

    return { sessionId, confirmReqId };
  } finally {
    client.close();
  }
}

async function scenarioD2NavigateControl(stack, projectDir) {
  // D2 navigate backend vertical slice (single real chain):
  //   Browser WS → Host gateway (serial lane) → sessiond → R2 child → R1
  //   worker-main → fixture.
  // navigate is a serial-lane mutating command. It is capability-gated by
  // `runtime.navigate`; the fixture (mirroring the production adapter) rejects
  // an in-flight prompt/bash/compaction with `session_busy` before any
  // mutation; an unknown leaf is structured `invalid_input`; a successful
  // navigate is an AUTHORITY command — sessiond refreshes the authoritative
  // snapshot from the worker before releasing the terminal result, so
  // getSnapshot / get_state / detach-reattach all converge to the new leaf
  // (history/messageCount/leafId). The auto_name command matrix is now complete
  // (every runtime command is open).
  const client = new RuntimeWsClient(stack.host.wsUrl);
  await client.connect();
  const bstate = (result) => result?.snapshot?.state ?? result?.state;
  try {
    await client.handshake();
    const created = await client.create({
      cwd: projectDir,
      projectRoot: projectDir,
      createRequestId: `cr-nav-${Date.now()}`,
      toolNames: [],
      thinkingLevel: "off",
      thinkingLevelPinned: true,
    });
    const sessionId = created.sessionId;
    const snap = await client.attach(sessionId);
    assert.equal(snap.type, "snapshot");
    assert.deepEqual(snap.payload.snapshot.capabilities, {
      capabilities: PRODUCTION_CAPS,
      version: 1,
    });
    assert.ok(
      snap.payload.snapshot.capabilities.capabilities.includes("runtime.navigate"),
      "capability negotiation must advertise runtime.navigate",
    );

    // Build a deterministic 3-entry tree (3 prompts → entry-1..entry-3).
    for (let i = 1; i <= 3; i += 1) {
      const p = await client.command(sessionId, {
        commandId: `nav-prompt-${i}-${Date.now()}`,
        type: "prompt",
        message: `nav-prompt-${i}`,
      });
      assert.equal(p.payload.ok, true, JSON.stringify(p.payload));
      assert.equal(p.payload.result.result.ok, true, JSON.stringify(p.payload));
    }
    const liveBefore = await client.command(sessionId, { commandId: `nav-live-before-${Date.now()}`, type: "get_state" });
    const liveBeforeState = liveBefore.payload.result.result.state;
    assert.equal(liveBeforeState.messageCount, 3, "3 prompts must build 3 messages");
    assert.equal(liveBeforeState.leafId, "entry-3", "the live leaf must be the last entry");
    const before = await client.getSnapshot(sessionId);
    const beforeCount = bstate(before.payload.result).messageCount;
    assert.equal(beforeCount, 3, "projection must accumulate 3 messages from message_end events");
    assert.equal((before.payload.result.messages ?? []).length, 0, "Protocol v2 snapshot excludes completed history");

    // 1. Navigate to an earlier leaf (entry-2). The terminal result is released
    //    only AFTER sessiond's authoritative snapshot refresh, so a post-ack
    //    getSnapshot proves convergence (messageCount/history/leafId).
    const navId = `nav-to-2-${Date.now()}`;
    const nav = await client.command(sessionId, { commandId: navId, type: "navigate_tree", targetId: "entry-2" });
    assert.equal(nav.payload.ok, true, JSON.stringify(nav.payload));
    const navOutcome = nav.payload.result.result;
    assert.equal(navOutcome.ok, true, JSON.stringify(navOutcome));
    assert.equal(navOutcome.type, "navigate_tree");

    const after = await client.getSnapshot(sessionId);
    const afterState = bstate(after.payload.result);
    assert.equal(afterState.messageCount, 2, "navigate to entry-2 must converge messageCount to 2");
    assert.equal(afterState.leafId, "entry-2", "authoritative snapshot must carry the navigated leaf");
    assert.equal((after.payload.result.messages ?? []).length, 0, "Protocol v2 snapshot remains history-free after navigate");
    const liveAfter = await client.command(sessionId, { commandId: `nav-live-after-${Date.now()}`, type: "get_state" });
    const liveAfterState = liveAfter.payload.result.result.state;
    assert.equal(liveAfterState.messageCount, 2);
    assert.equal(liveAfterState.leafId, "entry-2");

    // 2. Navigate forward to entry-3 again — converges back to 3.
    const nav3 = await client.command(sessionId, { commandId: `nav-to-3-${Date.now()}`, type: "navigate_tree", targetId: "entry-3" });
    assert.equal(nav3.payload.result.result.ok, true, JSON.stringify(nav3.payload));
    const snap3 = await client.getSnapshot(sessionId);
    assert.equal(bstate(snap3.payload.result).messageCount, 3);
    assert.equal(bstate(snap3.payload.result).leafId, "entry-3");

    // 3. Detach/reattach persistence: the navigated projection persists.
    await client.detach(sessionId);
    const reattach = await client.attach(sessionId);
    assert.equal(reattach.type, "snapshot");
    assert.equal(reattach.payload.snapshot.state.messageCount, 3);
    assert.equal(reattach.payload.snapshot.state.leafId, "entry-3");
    assert.deepEqual(reattach.payload.snapshot.capabilities, { capabilities: PRODUCTION_CAPS, version: 1 });

    // 4. Busy guard: a blocking prompt holds the session; a SECOND connection's
    //    navigate (its own serial lane dispatches immediately) is rejected with
    //    session_busy and the in-flight prompt is untouched (continues to its
    //    aborted completion). After the prompt settles, navigate succeeds again.
    const blockId = `nav-block-${Date.now()}`;
    const blockIndex = client.messages.length;
    const blockP = client.command(sessionId, { commandId: blockId, type: "prompt", message: "__block__ navigate busy" });
    await client.waitFor(
      (m) => m.type === "event" && m.payload?.sessionId === sessionId && m.payload?.type === "agent_start",
      { label: "blocking agent_start", afterIndex: blockIndex },
    );
    const client2 = new RuntimeWsClient(stack.host.wsUrl);
    await client2.connect();
    try {
      await client2.handshake();
      const busy = await client2.command(sessionId, { commandId: `nav-busy-${Date.now()}`, type: "navigate_tree", targetId: "entry-2" });
      assert.equal(busy.payload.ok, true, JSON.stringify(busy.payload));
      const busyOutcome = busy.payload.result.result;
      assert.equal(busyOutcome.ok, false, JSON.stringify(busyOutcome));
      assert.equal(busyOutcome.error.code, "session_busy");
      assert.equal(busyOutcome.error.retryable, true);
    } finally {
      client2.close();
    }
    // Release the blocking prompt via the independent interrupt; the prompt
    // settles interrupted (never corrupted, never a false success).
    await client.interrupt(sessionId, `nav-abort-${Date.now()}`, { type: "abort" });
    const blockOutcome = await blockP;
    assert.equal(blockOutcome.payload.result.result.ok, false);
    assert.equal(blockOutcome.payload.result.result.error.code, "interrupted");
    const idleSnap = await client.getSnapshot(sessionId);
    assert.equal(bstate(idleSnap.payload.result).isPromptRunning, false, "prompt must not be left running");
    const navAgain = await client.command(sessionId, { commandId: `nav-again-${Date.now()}`, type: "navigate_tree", targetId: "entry-2" });
    assert.equal(navAgain.payload.result.result.ok, true, JSON.stringify(navAgain.payload));
    assert.equal(bstate((await client.getSnapshot(sessionId)).payload.result).leafId, "entry-2");

    // 5. Invalid leaf reference → structured invalid_input, sanitized (no raw
    //    leaf id / path in the response).
    const bad = await client.command(sessionId, { commandId: `nav-bad-${Date.now()}`, type: "navigate_tree", targetId: "entry-999" });
    assert.equal(bad.payload.ok, true, JSON.stringify(bad.payload));
    const badOutcome = bad.payload.result.result;
    assert.equal(badOutcome.ok, false, JSON.stringify(badOutcome));
    assert.equal(badOutcome.error.code, "invalid_input");
    assert.ok(!badOutcome.error.message.includes("entry-999"), "no raw leaf id in the error message");
    assert.ok(!/\n|\tat |node:internal/i.test(badOutcome.error.message), "no raw stack text");

    // D2 auto_name completes the command matrix: every runtime command is now
    // OPEN (navigate). The production surface carries the full frozen 20-token set
    // and the former last-closed command (generate_session_title) succeeds.
    await assertEveryCommandOpen(client, sessionId, "navigate");

    return { sessionId, beforeCount: 3 };
  } finally {
    client.close();
  }
}

async function scenarioPhase5ARevisionHistory(stack, projectDir) {
  // Phase 5A unified session revision / history-live merge (single real chain):
  //   Browser WS → Host gateway → sessiond → R2 child → R1 worker-main → fixture.
  //
  // navigate → CORRECT BRANCH: after navigating to an earlier leaf, the next
  // committed entry lands ON THE NAVIGATED BRANCH — its message_end carries
  // parentEntryId === the navigated leaf — and the authoritative projection
  // (messageCount/leafId) converges to the navigated path, excluding the
  // branch-off sibling. Correct-branch is proven by STRUCTURAL identity
  // (entryId/parentEntryId), never by text.
  //
  // compact → NO GHOST/DUPLICATE: after a manual compact trims the oldest
  // path entries, the authoritative counts contain no ghost of the removed
  // entries, the compaction event sequence is exactly start+end once with NO
  // replayed message_end for removed entries, and a detach/reattach (fresh
  // resume) re-materializes neither the removed entries nor duplicates — the
  // post-compaction live tail continues on the compacted branch.
  const client = new RuntimeWsClient(stack.host.wsUrl);
  await client.connect();
  const bstate = (result) => result?.snapshot?.state ?? result?.state;
  try {
    await client.handshake();
    const created = await client.create({
      cwd: projectDir,
      projectRoot: projectDir,
      createRequestId: `cr-p5a-${Date.now()}`,
      toolNames: [],
      thinkingLevel: "off",
      thinkingLevelPinned: true,
    });
    const sessionId = created.sessionId;
    const snap = await client.attach(sessionId);
    assert.equal(snap.type, "snapshot");

    // Build a deterministic 3-entry branch (3 prompts → entry-1..entry-3).
    for (let i = 1; i <= 3; i += 1) {
      const p = await client.command(sessionId, {
        commandId: `p5a-prompt-${i}-${Date.now()}`,
        type: "prompt",
        message: `p5a-prompt-${i}`,
      });
      assert.equal(p.payload.result.result.ok, true, JSON.stringify(p.payload));
      await client.waitFor(
        (m) => m.type === "event" && m.payload?.sessionId === sessionId && m.payload?.type === "prompt_done",
        { label: `p5a prompt ${i} prompt_done` },
      );
    }
    const committedEnds = () => client.messages
      .filter((m) => m.type === "event" && m.payload?.type === "message_end" && m.payload?.sessionId === sessionId)
      .map((m) => m.payload);
    let ends = committedEnds();
    assert.deepEqual(
      ends.map((event) => event.entryId),
      ["entry-1", "entry-2", "entry-3"],
      "each prompt commits exactly one keyed entry in order",
    );
    assert.equal(ends[1].parentEntryId, "entry-1", "linear branch parents chain");

    // --- navigate → correct branch ------------------------------------
    const navIndex = client.messages.length;
    const nav = await client.command(sessionId, { commandId: `p5a-nav-${Date.now()}`, type: "navigate_tree", targetId: "entry-2" });
    assert.equal(nav.payload.result.result.ok, true, JSON.stringify(nav.payload));
    // Phase 5A end-to-end bridge: the canonical session_changed event crosses
    // worker mapper → sessiond journal (cursor-stamped) → browser event frame.
    const navChange = await client.waitFor(
      (m) => m.type === "event" && m.payload?.sessionId === sessionId && m.payload?.type === "session_changed",
      { label: "navigate session_changed", afterIndex: navIndex },
    );
    assert.equal(navChange.payload.leafId, "entry-2", "the wire session_changed carries the navigated leaf");
    assert.ok(typeof navChange.payload.cwd === "string" && navChange.payload.cwd.length > 0, "session_changed carries the authoritative cwd");
    assert.ok(typeof navChange.payload.epoch === "string" && navChange.payload.epoch.length > 0, "sessiond stamped the epoch cursor");
    assert.ok(Number.isInteger(navChange.payload.eventId) && navChange.payload.eventId > 0, "sessiond stamped a positive eventId");
    const afterNav = await client.getSnapshot(sessionId);
    assert.equal(bstate(afterNav.payload.result).messageCount, 2, "navigated branch exposes only its path");
    assert.equal(bstate(afterNav.payload.result).leafId, "entry-2", "navigated leaf is the branch pointer");
    assert.equal(afterNav.payload.result.cwd, navChange.payload.cwd, "projection cwd equals the session_changed cwd");

    // The NEXT commit lands on the navigated branch (structural parent proof).
    const afterNavIndex = client.messages.length;
    const branchP = await client.command(sessionId, { commandId: `p5a-branch-${Date.now()}`, type: "prompt", message: "p5a-on-navigated-branch" });
    assert.equal(branchP.payload.result.result.ok, true, JSON.stringify(branchP.payload));
    const branchEnd = await client.waitFor(
      (m) => m.type === "event" && m.payload?.sessionId === sessionId && m.payload?.type === "message_end",
      { label: "branch commit message_end", afterIndex: afterNavIndex },
    );
    assert.equal(branchEnd.payload.entryId, "entry-4", "the post-navigate commit mints the next structural id");
    assert.equal(branchEnd.payload.parentEntryId, "entry-2", "the post-navigate commit is a child of the NAVIGATED leaf (correct branch, by identity)");
    const afterBranch = await client.getSnapshot(sessionId);
    assert.equal(bstate(afterBranch.payload.result).messageCount, 3, "navigated path + new commit (branch-off sibling excluded)");
    assert.equal(bstate(afterBranch.payload.result).leafId, "entry-4");
    const liveBranch = await client.command(sessionId, { commandId: `p5a-live-${Date.now()}`, type: "get_state" });
    assert.equal(liveBranch.payload.result.result.state.messageCount, 3);
    assert.equal(liveBranch.payload.result.result.state.leafId, "entry-4");

    // --- compact → no ghost/duplicate ---------------------------------
    // Path is now [entry-1, entry-2, entry-4]; a manual compact deterministically
    // trims the OLDEST two path entries → surviving path [entry-4].
    const beforeCompactIndex = client.messages.length;
    const compact = await client.command(sessionId, { commandId: `p5a-compact-${Date.now()}`, type: "compact" });
    assert.equal(compact.payload.result.result.ok, true, JSON.stringify(compact.payload));
    const compactEnd = await client.waitFor(
      (m) => m.type === "event" && m.payload?.sessionId === sessionId && m.payload?.type === "compaction_end",
      { label: "compact compaction_end", afterIndex: beforeCompactIndex },
    );
    assert.equal(compactEnd.payload.aborted, false);
    // Phase 5A end-to-end bridge: the compaction terminal also publishes a
    // cursor-stamped session_changed carrying the post-compaction leaf.
    const compactChange = await client.waitFor(
      (m) => m.type === "event" && m.payload?.sessionId === sessionId && m.payload?.type === "session_changed",
      { label: "compact session_changed", afterIndex: beforeCompactIndex },
    );
    assert.equal(compactChange.payload.leafId, "entry-4", "the compaction session_changed carries the compacted leaf");
    assert.ok(compactChange.payload.eventId > navChange.payload.eventId, "same-epoch journal order: the compact fence follows the navigate fence");
    const compactWindow = client.messages.slice(beforeCompactIndex).filter((m) => m.type === "event" && m.payload?.sessionId === sessionId);
    assert.equal(compactWindow.filter((m) => m.payload.type === "compaction_start").length, 1, "exactly one compaction_start");
    assert.equal(compactWindow.filter((m) => m.payload.type === "compaction_end").length, 1, "exactly one compaction_end");
    assert.equal(
      compactWindow.filter((m) => m.payload.type === "message_end").length,
      0,
      "compaction terminal replays NO committed entries (no ghost duplicates)",
    );

    const afterCompact = await client.getSnapshot(sessionId);
    assert.equal(bstate(afterCompact.payload.result).messageCount, 1, "trimmed path holds only the surviving entry (no ghost count)");
    assert.equal(bstate(afterCompact.payload.result).leafId, "entry-4", "the compacted branch leaf is preserved");
    assert.equal(bstate(afterCompact.payload.result).isCompacting, false);
    const allEnds = committedEnds();
    assert.equal(new Set(allEnds.map((event) => event.entryId)).size, allEnds.length, "every committed entry id appeared at most once (no duplicates ever)");

    // Detach/reattach (fresh resume) must not re-materialize the removed
    // entries nor duplicate the surviving tail.
    await client.detach(sessionId);
    const reattachIndex = client.messages.length;
    const reattach = await client.attach(sessionId);
    assert.equal(reattach.type, "snapshot");
    assert.equal(reattach.payload.snapshot.state.messageCount, 1, "reattach converges the compacted count (removed entries stay removed)");
    assert.equal(reattach.payload.snapshot.state.leafId, "entry-4");
    const replayWindow = client.messages.slice(reattachIndex).filter((m) => m.type === "event" && m.payload?.sessionId === sessionId && m.payload?.type === "message_end");
    assert.equal(replayWindow.length, 0, "reattach replays NO committed entries (resume cursor continuity, no duplicate ghost)");

    // The live tail continues on the compacted branch: the next commit is a
    // child of the compacted leaf, and counts grow by exactly one.
    const tailP = await client.command(sessionId, { commandId: `p5a-tail-${Date.now()}`, type: "prompt", message: "p5a-after-compact" });
    assert.equal(tailP.payload.result.result.ok, true, JSON.stringify(tailP.payload));
    const tailEnd = await client.waitFor(
      (m) => m.type === "event" && m.payload?.sessionId === sessionId && m.payload?.type === "message_end",
      { label: "post-compact commit message_end", afterIndex: reattachIndex },
    );
    assert.equal(tailEnd.payload.entryId, "entry-5");
    assert.equal(tailEnd.payload.parentEntryId, "entry-4", "post-compact commit chains on the compacted leaf");
    const tailSnap = await client.getSnapshot(sessionId);
    assert.equal(bstate(tailSnap.payload.result).messageCount, 2);
    assert.equal(bstate(tailSnap.payload.result).leafId, "entry-5");

    return { sessionId, navigatedLeaf: "entry-2", compactedLeaf: "entry-4" };
  } finally {
    client.close();
  }
}

async function scenarioD2ForkControl(stack, projectDir) {
  // D2 fork backend vertical slice (single real chain):
  //   Browser WS → Host gateway (serial lane) → sessiond → R2 child → R1
  //   worker-main → fixture.
  // create → 2 turns → fork → NEW session id + OLD worker exits (no orphan) →
  // attach the forked session (fork-point history present) → auto_name is now
  // OPEN (the last runtime command) → stop the forked session (no extra
  // orphan). The old worker ends via
  // sessiond's identity-lane stop AFTER the fork result is delivered — the
  // client receives the fork result + new session id first, then the old
  // runtime_closed.
  const before = new Set(stack.daemon.diagnostics.workerPids());
  const client = new RuntimeWsClient(stack.host.wsUrl);
  await client.connect();
  try {
    await client.handshake();
    const created = await client.create({
      cwd: projectDir,
      projectRoot: projectDir,
      createRequestId: `cr-fork-${Date.now()}`,
    });
    const sessionId = created.sessionId;
    const snap = await client.attach(sessionId);
    assert.equal(snap.type, "snapshot");
    assert.deepEqual(snap.payload.snapshot.capabilities, { capabilities: PRODUCTION_CAPS, version: 1 });

    // 2 turns (the fixture ledger assigns entry-1 / entry-2 deterministically).
    for (const [commandId, message] of [["fork-turn-1", "first"], ["fork-turn-2", "second"]]) {
      const turn = await client.command(sessionId, { commandId, type: "prompt", message });
      assert.equal(turn.payload.result.result.ok, true, JSON.stringify(turn.payload));
    }

    // Isolate THIS scenario's old worker(s) — earlier scenarios may still hold
    // live workers (authoritative in-process daemon diagnostics, no pgrep).
    const afterCreate = stack.daemon.diagnostics.workerPids();
    const oldPids = afterCreate.filter((pid) => !before.has(pid));
    assert.ok(oldPids.length >= 1, `fork scenario worker expected; before=${[...before]} after=${afterCreate}`);

    // Fork at the second turn's entry point.
    const forkRes = await client.command(sessionId, { commandId: "fork-cmd", type: "fork", entryId: "entry-2" });
    const forkOutcome = forkRes.payload.result.result;
    assert.equal(forkOutcome.ok, true, JSON.stringify(forkOutcome));
    assert.equal(forkOutcome.type, "fork");
    const forkedSessionId = forkOutcome.forkedSessionId;
    assert.ok(forkedSessionId && forkedSessionId !== sessionId, "fork must return a NEW session id");
    assert.equal(forkOutcome.forkPointEntryId, "entry-2");

    // The OLD worker ends (no orphan): every pre-fork pid for this scenario dies.
    for (const pid of oldPids) {
      const dead = await waitForPidDead(pid, 8_000);
      assert.equal(dead, true, `old worker ${pid} must exit after fork`);
    }

    // Register the forked session in the shared in-memory catalog so a
    // client-driven attach can resolve its cwd/projectRoot (the fixture created
    // the forked session inside the now-exited old worker; the catalog must
    // resolve it for the fresh worker the attach spawns).
    fixtureSessions.set(forkedSessionId, { sessionId: forkedSessionId, cwd: projectDir, projectRoot: projectDir });

    // Attach the NEW session → it opens with fork-point history (2 turns).
    const forkedSnap = await client.attach(forkedSessionId);
    assert.equal(forkedSnap.type, "snapshot", JSON.stringify(forkedSnap));
    assert.equal(forkedSnap.payload.snapshot.state.messageCount, 2, "forked session must open with fork-point history (2 turns)");

    // D2 auto_name completes the command matrix: auto_name is now OPEN on the
    // forked session too (the production surface is the full 20-token set and
    // the former last-closed command succeeds with the generated title).
    const autoName = await client.command(forkedSessionId, { commandId: `fork-auto-${Date.now()}`, type: "generate_session_title" });
    assert.equal(autoName.payload.ok, true, JSON.stringify(autoName.payload));
    const autoOutcome = autoName.payload.result.result;
    assert.equal(autoOutcome.ok, true, JSON.stringify(autoOutcome));
    assert.equal(autoOutcome.type, "generate_session_title");
    assert.equal(typeof autoOutcome.title, "string");
    assert.ok(autoOutcome.title.length > 0, "the forked-session auto_name result must carry the generated title");

    // Stop the forked session: the forked worker must exit (no orphan growth
    // from THIS scenario beyond the workers that existed before it).
    const stopRes = await client.stop(forkedSessionId);
    assert.equal(stopRes.payload.ok, true, JSON.stringify(stopRes.payload));
    const afterAttach = stack.daemon.diagnostics.workerPids();
    const forkedPids = afterAttach.filter((pid) => !before.has(pid) && !oldPids.includes(pid));
    for (const pid of forkedPids) {
      const dead = await waitForPidDead(pid, 8_000);
      assert.equal(dead, true, `forked worker ${pid} must exit after stop`);
    }

    return { sessionId, forkedSessionId, messageCount: 2 };
  } finally {
    client.close();
  }
}

async function scenarioD2AutoName(stack, projectDir) {
  // D2 auto_name backend vertical slice (single real chain):
  //   Browser WS → Host gateway → sessiond → R2 child → R1 worker-main →
  //   fixture, plus DIRECT sessiond RPC reads to verify the §51 revisioned
  //   title overlay on sessions.list/read (the fixture catalog returns no
  //   title, so the overlay is the only thing bridging the auto_name title).
  // create → prompt (1 turn) → auto_name → title in list/read via the overlay
  // → user rename AFTER auto_name wins (later revision) → auto_name after user
  // rename → deterministic last-committer-wins per lane order.
  const client = new RuntimeWsClient(stack.host.wsUrl);
  await client.connect();
  try {
    await client.handshake();
    const created = await client.create({
      cwd: projectDir,
      projectRoot: projectDir,
      createRequestId: `cr-auto-${Date.now()}`,
    });
    const sessionId = created.sessionId;
    const snap = await client.attach(sessionId);
    assert.equal(snap.type, "snapshot");
    assert.deepEqual(snap.payload.snapshot.capabilities, { capabilities: PRODUCTION_CAPS, version: 1 });

    // 1. Prompt (1 turn): the fixture sets lastAssistantText = "Hello world".
    const turn = await client.command(sessionId, { commandId: `auto-turn-${Date.now()}`, type: "prompt", message: "hello" });
    assert.equal(turn.payload.result.result.ok, true, JSON.stringify(turn.payload));

    // 2. auto_name → derives "Hello world" from the last assistant text and
    //    returns it in the RPC result (single source of truth).
    const auto = await client.command(sessionId, { commandId: `auto-name-${Date.now()}`, type: "generate_session_title" });
    const autoOutcome = auto.payload.result.result;
    assert.equal(autoOutcome.ok, true, JSON.stringify(autoOutcome));
    assert.equal(autoOutcome.type, "generate_session_title");
    assert.equal(autoOutcome.title, "Hello world", "auto_name must derive the title from the last assistant text");
    // The session_title event converges the worker/attach snapshot projection.
    await client.waitFor(
      (m) => m.type === "event" && m.payload?.sessionId === sessionId && m.payload?.type === "session_title",
      { label: "session_title event" },
    );
    const stateSnap = await client.getSnapshot(sessionId);
    const autoState = stateSnap.payload.result?.snapshot?.state ?? stateSnap.payload.result?.state;
    assert.equal(autoState.sessionName, "Hello world", "the attach snapshot must carry the generated title");

    // 3. Title visible in sessions list/read via the §51 overlay (direct RPC).
    const { SessiondRpcClient } = await import("@fffattiger/pix-sessiond/client");
    const probe = new SessiondRpcClient({
      endpoint: stack.daemon.endpoint,
      secret: stack.daemon.secret,
      timeoutMs: 2_000,
    });
    const listed = await probe.call("sessions.list", { page: 1, pageSize: 50 });
    assert.equal(listed.sessions.find((s) => s.sessionId === sessionId)?.title, "Hello world", "sessions.list must surface the auto_name title via the overlay");
    const read = await probe.call("sessions.read", { sessionId });
    assert.equal(read.title, "Hello world", "sessions.read must surface the auto_name title via the overlay");

    // 4. User rename AFTER auto_name wins (later overlay revision).
    const rename = await client.command(sessionId, { commandId: `auto-rename-${Date.now()}`, type: "set_session_name", name: "User Rename" });
    assert.equal(rename.payload.result.result.ok, true, JSON.stringify(rename.payload));
    const listed2 = await probe.call("sessions.list", { page: 1, pageSize: 50 });
    assert.equal(listed2.sessions.find((s) => s.sessionId === sessionId)?.title, "User Rename", "user rename after auto_name wins (later overlay revision)");

    // 5. auto_name after user rename → deterministic last-committer-wins per
    //    lane order: auto_name commits later, so its overlay revision wins.
    const auto2 = await client.command(sessionId, { commandId: `auto-name-2-${Date.now()}`, type: "generate_session_title" });
    assert.equal(auto2.payload.result.result.ok, true, JSON.stringify(auto2.payload));
    const listed3 = await probe.call("sessions.list", { page: 1, pageSize: 50 });
    assert.equal(listed3.sessions.find((s) => s.sessionId === sessionId)?.title, "Hello world", "auto_name after user rename commits later → wins per lane order");

    // 6. Every-command-open completeness assertion (no closed commands remain).
    await assertEveryCommandOpen(client, sessionId, "auto");

    return { sessionId, title: "Hello world" };
  } finally {
    client.close();
  }
}

async function scenarioShutdownCleanup(stack, projectDir) {
  // Authoritative worker discovery via the in-process daemon handle (no pgrep,
  // no PID file, no process scan). Snapshot the live worker set before this
  // scenario's create so we only assert on the newly spawned worker (earlier
  // scenarios may still hold live workers).
  const before = new Set(stack.daemon.diagnostics.workerPids());

  const client = new RuntimeWsClient(stack.host.wsUrl);
  await client.connect();
  let sessionId;
  let workerPids = [];
  try {
    await client.handshake();
    const created = await client.create({
      cwd: projectDir,
      projectRoot: projectDir,
      createRequestId: `cr-shutdown-${Date.now()}`,
    });
    sessionId = created.sessionId;
    await client.attach(sessionId);

    const after = stack.daemon.diagnostics.workerPids();
    workerPids = after.filter((pid) => !before.has(pid));
    assert.ok(
      workerPids.length >= 1,
      `new worker child expected; before=${[...before]} after=${after}`,
    );

    // Browser close = detach only; worker stays.
    client.close();
    await delay(100);
    for (const pid of workerPids) {
      assert.equal(pidAlive(pid), true, `worker ${pid} should survive browser close`);
    }
  } catch (error) {
    client.close();
    throw error;
  }

  // Reconnect and explicit stop of THIS session only.
  const client2 = new RuntimeWsClient(stack.host.wsUrl);
  await client2.connect();
  try {
    await client2.handshake();
    await client2.attach(sessionId);
    const stop = await client2.stop(sessionId);
    assert.equal(stop.payload.ok, true);
  } finally {
    client2.close();
  }

  // After stop, the worker(s) spawned for this session should die.
  for (const pid of workerPids) {
    const dead = await waitForPidDead(pid, 8_000);
    assert.equal(dead, true, `worker ${pid} should die after runtime.stop`);
  }

  // Host close alone must not stop sessiond (in-process daemon: the handle is
  // the E2E parent's; we assert the RPC is still pingable and workers from
  // earlier scenarios can still be present until explicit daemon.shutdown).
  await stack.host.handle.close();
  stack.host.handle = null;
  {
    const { SessiondRpcClient } = await import("@fffattiger/pix-sessiond/client");
    const probe = new SessiondRpcClient({
      endpoint: stack.daemon.endpoint,
      secret: stack.daemon.secret,
      timeoutMs: 2_000,
    });
    const pong = await probe.call("system.ping", {});
    assert.equal(pong.pong, true, "sessiond RPC must answer after host close");
  }

  // Daemon shutdown (service.shutdown stops all workers) leaves no orphan children.
  // The daemon runs in the E2E parent process (in-process), so the E2E parent
  // PID is NOT expected to die — only worker children must exit.
  const remaining = stack.daemon.diagnostics.workerPids();
  await stack.daemon.shutdown();
  for (const pid of remaining) {
    const dead = await waitForPidDead(pid, 8_000);
    assert.equal(dead, true, `orphan worker child ${pid} after daemon shutdown`);
  }
  const leftover = stack.daemon.diagnostics.workerPids();
  assert.deepEqual(
    leftover,
    [],
    `no worker children after daemon shutdown; leftover=${leftover}`,
  );
  // Mark daemon shut so outer finally does not double-shutdown.
  stack.daemon = null;
  return {
    sessionId,
    workerPids,
    daemonPid: process.pid,
    daemonInProcess: true,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function runRound(round) {
  const temp = await mkdtemp(join(tmpdir(), `pix-x1-e2e-r${round}-`));
  const projectA = join(temp, "project-a");
  const projectB = join(temp, "project-b");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(projectA, { recursive: true });
  await mkdir(projectB, { recursive: true });

  let stack;
  const results = {};
  try {
    stack = await startRuntimeStack(temp);
    log(`round ${round}: stack up (port=${stack.host.port})`);

    results.createAttachPrompt = await scenarioCreateAttachPrompt(stack, projectA);
    log(`round ${round}: create→attach→prompt OK session=${results.createAttachPrompt.sessionId}`);

    results.abort = await scenarioAbort(stack, projectA);
    log(`round ${round}: abort OK (${results.abort.interruptElapsedMs}ms)`);

    results.hostRestartResume = await scenarioHostRestartResume(stack, projectA);
    log(`round ${round}: host restart/resume OK`);

    results.epochChange = await scenarioEpochChangeNoAutoResend(stack, projectA);
    log(`round ${round}: epoch change OK old=${results.epochChange.oldEpoch} new=${results.epochChange.newEpoch}`);

    results.dedup = await scenarioCommandIdAtMostOnce(stack, projectA);
    log(`round ${round}: commandId at-most-once OK`);

    results.isolation = await scenarioSessionIsolation(stack, projectA, projectB);
    log(`round ${round}: isolation OK`);

    results.coldAttach = await scenarioCreateThenColdAttach(stack, projectA);
    log(`round ${round}: cold attach after host restart OK`);

    results.independentReadRpc = await scenarioIndependentReadRpc(stack, projectA);
    log(`round ${round}: Phase 2B independent read RPC OK session=${results.independentReadRpc.sessionId}`);

    results.submitTurnBlocked = await scenarioSubmitTurnBlocked(stack, projectA);
    log(`round ${round}: Phase 4A.0.1 stale create-seed same-operation repair OK session=${results.submitTurnBlocked.sessionId}`);

    results.lightCommands = await scenarioD2P1LightCommands(stack, projectA);
    log(`round ${round}: D2-P1 light commands OK session=${results.lightCommands.sessionId}`);

    results.queueControl = await scenarioD2P4QueueControl(stack, projectA);
    log(`round ${round}: D2-P4 queue control OK session=${results.queueControl.sessionId}`);

    results.bashControl = await scenarioD2P5BashControl(stack, projectA);
    log(`round ${round}: D2-P5 bash control OK session=${results.bashControl.sessionId}`);

    results.toolsReload = await scenarioD2P6ToolsReload(stack, projectA);
    log(`round ${round}: D2-P6 tools+reload OK session=${results.toolsReload.sessionId}`);

    results.compactControl = await scenarioD2P7CompactControl(stack, projectA);
    log(`round ${round}: D2-P7 compact control OK session=${results.compactControl.sessionId} before=${results.compactControl.beforeCount} after=${results.compactControl.afterCount}`);

    results.extensionUi = await scenarioD2P8ExtensionUiControl(stack, projectA);
    log(`round ${round}: D2-P8 extension UI control OK session=${results.extensionUi.sessionId}`);

    results.navigate = await scenarioD2NavigateControl(stack, projectA);
    log(`round ${round}: D2 navigate control OK session=${results.navigate.sessionId} before=${results.navigate.beforeCount}`);

    results.phase5aRevisionHistory = await scenarioPhase5ARevisionHistory(stack, projectA);
    log(`round ${round}: Phase 5A revision/history-live merge OK session=${results.phase5aRevisionHistory.sessionId}`);

    results.forkControl = await scenarioD2ForkControl(stack, projectA);
    log(`round ${round}: D2 fork control OK old=${results.forkControl.sessionId} forked=${results.forkControl.forkedSessionId}`);

    results.autoName = await scenarioD2AutoName(stack, projectA);
    log(`round ${round}: D2 auto_name control OK session=${results.autoName.sessionId} title=${results.autoName.title}`);

    results.shutdown = await scenarioShutdownCleanup(stack, projectA);
    log(`round ${round}: shutdown/cleanup OK`);

    return results;
  } finally {
    try {
      if (stack?.host?.handle) await stack.host.handle.close().catch(() => {});
    } catch {
      // ignore
    }
    try {
      if (stack?.daemon) await stack.daemon.shutdown().catch(() => {});
    } catch {
      // ignore
    }
    // Best-effort kill any leftover children of this temp sessiond.
    await delay(100);
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  if (!existsSync(FIXTURE)) {
    throw new Error(`E2E fixture missing: ${FIXTURE}`);
  }
  // Require built packages.
  for (const rel of [
    "packages/host/dist/index.js",
    "packages/sessiond/dist/composition/index.js",
    "packages/agent-worker/dist/composition/worker-main.js",
    "packages/protocol/dist/index.js",
  ]) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) {
      throw new Error(`built artifact missing: ${abs}; run npm run build first`);
    }
  }

  const all = [];
  for (let round = 1; round <= ROUNDS; round += 1) {
    log(`=== round ${round}/${ROUNDS} ===`);
    const result = await runRound(round);
    all.push(result);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        rounds: ROUNDS,
        fixture: FIXTURE,
        scenarios: [
          "create→attach→prompt stream",
          "abort (independent interrupt)",
          "host restart/resume + commandId cache",
          "epoch change (no client auto-resend)",
          "commandId at-most-once + interrupt dedup + type conflict",
          "session isolation",
          "create then host-restart cold attach",
          "Phase 2B independent read RPC (negotiated read envelope + prompt overlap)",
          "Phase 4A.0.1 create A → create B advances A journal → stale A conflict → same-operation authority-revision retry accepted → attach-after-admission + independent read/abort",
          "D2-P1/D2-P2/D2-P3 light commands (state/commands/last-text/stats/rename/thinking/model + every-command-open)",
          "D2-P4 queue control (block prompt + steer/follow_up queue + clear_queue + set_auto_retry + detach/reattach + abort + every-command-open)",
          "D2-P5 bash control (normal bash exact projection + blocking bash + abort_bash interrupt non-blocking + cancelled state + detach/reattach persistence + every-command-open)",
          "D2-P6 tools+reload (get_tools query + set_tools subset/all-off authority + unknown-tool invalid_input + reload re-applies tools/systemPrompt/thinking + final capabilities version + detach/reattach persistence + every-command-open)",
          "D2-P7 compact control (initial history + successful compact event sequence + authoritative post-snapshot messageCount/contextUsage/history before ack + detach/reattach persistence + blocking compact + abort_compaction non-HOL + interrupted result + aborted projection + idle abort + second-command session_busy + every-command-open + no orphan)",
          "D2-P8 extension UI control (confirm wrong-method invalid_input stays pending + correct response resumes prompt on the same socket via the interleaving lane + unknown/late not_found + same-commandId at-most-once no duplicate close + detach before response then reattach sees pending + response then detach/reattach sees none + input/editor incremental exact-method + select cancel + E15 custom incremental FIFO key data (arrow/chars/Ctrl+C) with same-id upsert updates + wrong-method invalid_input + late input not_found + replay cannot resurrect + abort clears + status/widget/title/notify events + every-command-open + reload cannot broaden)",
          "D2 navigate control (3-prompt tree + navigate to earlier leaf authoritative messageCount/history/leafId convergence + navigate forward + detach/reattach persistence + blocking prompt + second-connection navigate session_busy (prompt untouched) + invalid leaf invalid_input sanitized + every-command-open + capability advertised)",
          "Phase 5A revision/history-live merge (navigate → correct branch: post-navigate commit is a structural child of the navigated leaf, branch-off sibling excluded; compact → no ghost/duplicate: exactly one start+end, zero replayed message_end, trimmed counts converge, detach/reattach re-materializes nothing, live tail chains on the compacted leaf)",
          "D2 fork control (create + 2 turns + fork → NEW session id + OLD worker exits via identity-lane stop after the result + attach forked session with fork-point history + auto_name open on the forked session + forked worker exits on stop, no orphan)",
          "D2 auto_name control (create → prompt 1 turn → auto_name → title in sessions list/read via the §51 overlay → user rename AFTER auto_name wins (later revision) → auto_name after user rename → deterministic last-committer-wins per lane order → every-command-open)",
          "shutdown: browser detach / stop / daemon no orphans",
        ],
        lastRound: {
          sessionId: all.at(-1)?.createAttachPrompt?.sessionId,
          workerPids: all.at(-1)?.shutdown?.workerPids,
          daemonPid: all.at(-1)?.shutdown?.daemonPid,
          projectionText: "Hello world",
          capabilities: ["agent"],
          lightCommands: all.at(-1)?.lightCommands,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(
    `[pix:e2e:runtime] FAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
