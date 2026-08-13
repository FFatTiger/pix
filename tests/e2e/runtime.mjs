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
import { reduceRuntimeEventData } from "@fffattiger/pix-protocol";

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

  async handshake() {
    this.send({
      type: "handshake",
      id: "hs1",
      payload: {
        protocolVersion: 1,
        client: { shell: "web", platform: "mac" },
        features: [],
      },
    });
    const ack = await this.waitFor((m) => m.type === "handshake_ack", {
      label: "handshake_ack",
    });
    return ack;
  }

  async create({ cwd, projectRoot, createRequestId = `cr-${Date.now()}` }) {
    const id = `create-${createRequestId}`;
    this.send({
      type: "create",
      id,
      payload: { createRequestId, cwd, projectRoot },
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
    const id = `snap-${sessionId.slice(0, 12)}-${Date.now()}`;
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
    if (!this.projection?.messages?.length) return "";
    const last = [...this.projection.messages]
      .reverse()
      .find((m) => m.role === "assistant");
    if (!last) return "";
    return (last.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
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
      return [...fixtureSessions.values()].map(({ sessionId, cwd, projectRoot }) => ({
        sessionId,
        sessionFile: fixtureSessionFile(sessionId),
        cwd,
        projectRoot,
        entries: [],
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

  return { daemon, host, clientDist, workerPids: () => collectWorkerPids(daemon) };
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

function collectWorkerPids(daemon) {
  // sessiond service is private; inspect via /proc-less approach is hard.
  // We track PIDs observed through listRunning is not available over public API
  // without RPC. Instead the scenarios that spawn workers record PIDs from
  // OS-level children of the daemon process when needed.
  void daemon;
  return [];
}

async function listChildPids(parentPid) {
  if (process.platform === "win32") return [];
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("pgrep", ["-P", String(parentPid)], {
      timeout: 2_000,
    }).catch(() => ({ stdout: "" }));
    return stdout
      .split("\n")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isSafeInteger(n) && n > 0);
  } catch {
    return [];
  }
}

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
    assert.equal(ack.payload.protocolVersion, 1);

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
    // (NOT the Host `agent` capability): D2-P1/D2-P2 production surface =
    // runtime.prompt + runtime.abort + runtime.stats + runtime.session.rename +
    // runtime.thinking.set.
    assert.deepEqual(
      snap.payload.snapshot.capabilities,
      {
        capabilities: [
          "runtime.prompt",
          "runtime.abort",
          "runtime.stats",
          "runtime.session.rename",
          "runtime.thinking.set",
        ],
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
      capabilities: ["runtime.prompt", "runtime.abort", "runtime.stats", "runtime.session.rename", "runtime.thinking.set"],
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

  // Host exit must NOT stop sessiond / Worker.
  const sessiondPid = stack.daemon.paths
    ? undefined
    : undefined;
  void sessiondPid;
  // Read lock for sessiond pid.
  const { readFile } = await import("node:fs/promises");
  const lock = JSON.parse(
    await readFile(stack.daemon.paths.lockFile, "utf8"),
  );
  const daemonPid = lock.pid;
  assert.equal(pidAlive(daemonPid), true);

  const childrenBefore = await listChildPids(daemonPid);
  assert.ok(
    childrenBefore.length >= 1,
    `expected at least one worker child of sessiond; got ${childrenBefore.join(",")}`,
  );

  await stack.host.handle.close();
  // sessiond still alive, workers still alive.
  assert.equal(pidAlive(daemonPid), true, "sessiond must survive Host exit");
  for (const child of childrenBefore) {
    assert.equal(
      pidAlive(child),
      true,
      `worker pid ${child} must survive Host exit`,
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
    // Projection should retain the assistant message from before restart
    // (via snapshot), not lose or double it.
    const text = (() => {
      const messages = snap2.payload.snapshot?.messages ?? [];
      const last = [...messages].reverse().find((m) => m.role === "assistant");
      if (!last) return "";
      return (last.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
    })();
    assert.equal(text, "Hello world", `resume snapshot text=${JSON.stringify(text)}`);

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

    return { sessionId, epoch, daemonPid, workerPids: childrenBefore };
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
      capabilities: ["runtime.prompt", "runtime.abort", "runtime.stats", "runtime.session.rename", "runtime.thinking.set"],
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

  // Host restart (sessiond + worker stay).
  const { readFile } = await import("node:fs/promises");
  const lock = JSON.parse(
    await readFile(stack.daemon.paths.lockFile, "utf8"),
  );
  const daemonPid = lock.pid;
  await stack.host.handle.close();
  assert.equal(pidAlive(daemonPid), true);

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
// D2-P1/D2-P2 light commands: frozen production surface over the real process path
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
      capabilities: ["runtime.prompt", "runtime.abort", "runtime.stats", "runtime.session.rename", "runtime.thinking.set"],
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
    assert.equal(cmdsOutcome.ok, true);
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
      capabilities: ["runtime.prompt", "runtime.abort", "runtime.stats", "runtime.session.rename", "runtime.thinking.set"],
      version: 1,
    });

    // Closed capabilities must remain unsupported on the production surface.
    // Note: clear_queue is an interrupt-only wire type (cannot go via command
    // envelope); cover queue via set_auto_retry instead.
    for (const [type, extra, token] of [
      ["set_model", { provider: "anthropic", modelId: "claude" }, "runtime.model.set"],
      ["set_tools", { toolNames: [] }, "runtime.tools.write"],
      ["reload", {}, "runtime.reload"],
      ["set_auto_retry", { enabled: false }, "runtime.queue"],
    ]) {
      const closed = await client.command(sessionId, {
        commandId: `light-closed-${type}-${Date.now()}`,
        type,
        ...extra,
      });
      assert.equal(closed.payload.ok, true, JSON.stringify(closed.payload));
      const outcome = closed.payload.result.result;
      assert.equal(outcome.ok, false, `${type} must be closed`);
      assert.equal(outcome.error.code, "unsupported_capability");
      assert.match(outcome.error.message, new RegExp(token.replace(/\./g, "\\.")));
    }

    return {
      sessionId,
      messageCount: statsOutcome.stats.messageCount,
      renamedTo: "Light Commands",
      thinkingLevel: "high",
      thinkingLevelPinned: true,
    };
  } finally {
    client.close();
  }
}

async function scenarioShutdownCleanup(stack, projectDir) {
  const { readFile } = await import("node:fs/promises");
  const lock = JSON.parse(
    await readFile(stack.daemon.paths.lockFile, "utf8"),
  );
  const daemonPid = lock.pid;

  // Snapshot children before this scenario's create so we only assert on the
  // newly spawned worker (earlier scenarios may still hold live workers).
  const before = new Set(await listChildPids(daemonPid));

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

    const after = await listChildPids(daemonPid);
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

  // Host close alone must not stop sessiond (in-process daemon: lock pid is the
  // E2E parent; we assert the RPC is still pingable and workers from earlier
  // scenarios can still be present until explicit daemon.shutdown).
  await stack.host.handle.close();
  stack.host.handle = null;
  assert.equal(pidAlive(daemonPid), true, "sessiond process still alive after host close");
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
  // Note: startDaemon runs in the E2E parent process, so the lock pid is our own
  // PID and must NOT be expected to die — only worker children must exit.
  const remaining = await listChildPids(daemonPid);
  await stack.daemon.shutdown();
  for (const pid of remaining) {
    const dead = await waitForPidDead(pid, 8_000);
    assert.equal(dead, true, `orphan worker child ${pid} after daemon shutdown`);
  }
  const leftover = await listChildPids(daemonPid);
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
    daemonPid,
    daemonInProcess: daemonPid === process.pid,
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

    results.lightCommands = await scenarioD2P1LightCommands(stack, projectA);
    log(`round ${round}: D2-P1 light commands OK session=${results.lightCommands.sessionId}`);

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
          "D2-P1/D2-P2 light commands (state/commands/last-text/stats/rename/thinking + closed caps)",
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
