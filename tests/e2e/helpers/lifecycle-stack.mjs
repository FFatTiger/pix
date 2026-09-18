/**
 * Lifecycle E2E stack (LC-00 layer 2 test helper).
 *
 * Boots the REAL production process chain with the REAL Pi SDK worker:
 *   temp agentDir (models.json/settings.json/seeded JSONL)
 *     → real sessiond daemon (startDaemon, production worker process factory,
 *       NO PIX_AGENT_WORKER_FACTORY injection — workers run the SDK adapter)
 *     → real Hono Host (createHostApp + production resources/catalogs/gate)
 *
 * Mirrors tests/e2e/sessions-history.mjs bootStack, minus every fake: no
 * workerFactoryModulePath, PIX_AGENT_WORKER_FACTORY explicitly cleared from
 * the daemon env source, isolated agentDir/sessiondDir/hostDir/cwd. All waits
 * bounded; cleanup of owned processes (worker PIDs via the authoritative
 * in-process daemon handle) even on failure.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createHash } from "node:crypto";
import {
  PROTOCOL_VERSION,
  RUNTIME_EXPLICIT_ACTIVATE_FEATURE,
  RUNTIME_OBSERVE_EXISTING_FEATURE,
  RUNTIME_READ_RPC_FEATURE,
  RUNTIME_RUNNING_WATCH_FEATURE,
  RUNTIME_SUBMIT_TURN_FEATURE,
  reduceRuntimeEventData,
} from "@fffattiger/pix-protocol";
import {
  createHostApp,
  createNodeServer,
  SessiondRuntimeGateway,
  createProductionResources,
  createProductionCatalogs,
  createProductionCapabilityResolver,
  createSessiondSessionsClient,
  createRuntimeWorkspaceAuthorizer,
  PRODUCTION_FULL_CAPABILITIES,
  RESOURCE_DEGRADED_CAPABILITIES,
  PRODUCTION_MAX_UPLOAD_BYTES,
} from "@fffattiger/pix-host";
import { startDaemon } from "@fffattiger/pix-sessiond/daemon";
import { SessiondRpcClient } from "@fffattiger/pix-sessiond/client";

export const STEP_TIMEOUT_MS = 12_000;
/** Production sessiond default (service.ts). Do not raise this in the harness. */
export const WORKER_START_TIMEOUT_MS = 10_000;
/** Bounded test wait for a gated provider turn; not a production RPC override. */
export const COMMAND_TIMEOUT_MS = 90_000;
/** Whole-suite hard deadline. Individual waits stay at their own budgets. */
export const SUITE_DEADLINE_MS = 8 * 60_000;
export const LIFECYCLE_FEATURES = [
  RUNTIME_RUNNING_WATCH_FEATURE,
  RUNTIME_READ_RPC_FEATURE,
  RUNTIME_SUBMIT_TURN_FEATURE,
  RUNTIME_OBSERVE_EXISTING_FEATURE,
  RUNTIME_EXPLICIT_ACTIVATE_FEATURE,
];

export function log(...args) {
  console.error("[pix:e2e:lifecycle]", ...args);
}

export function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export async function freePort() {
  const { createServer } = await import("node:net");
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

/** Temporary dirs for a fully isolated lifecycle run. */
export async function makeIsolatedDirs(prefix = "px-lc") {
  const agentDir = await mkdtemp(join(tmpdir(), `${prefix}-agentdir-`));
  const sessiondDir = await mkdtemp(join(tmpdir(), `${prefix}-sessiond-`));
  const projectCwd = await mkdtemp(join(tmpdir(), `${prefix}-project-`));
  // Canonical temp leaf (avoids the macOS /var symlink walk ensurePixHostDir refuses).
  const hostDir = join(realpathSync(tmpdir()), `${prefix}-host-${process.pid}-${Date.now()}`);
  mkdirSync(hostDir, { recursive: false, mode: 0o700 });
  return { agentDir, sessiondDir, projectCwd, hostDir };
}

/**
 * Write the loopback stub provider into the isolated agentDir:
 * models.json (openai-completions, literal no-op key, loopback baseUrl) plus
 * settings.json defaults so worker open/create resolves the stub model even
 * without explicit activation overrides.
 *
 * `options.extraModels` adds further model ids behind the SAME loopback
 * provider (multi-tab / multi-model E2Es); each entry may carry its own
 * display name so a browser tab can identify the model it is showing.
 */
export async function writeStubProviderConfig(
  agentDir,
  providerPort,
  providerId = "pix-e2e-stub",
  modelId = "stub-model",
  options = {},
) {
  const { writeFile } = await import("node:fs/promises");
  const stubModel = (id, name) => ({
    id,
    name,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4_096,
  });
  const models = [stubModel(modelId, options.defaultName ?? "Loopback Stub Model")];
  for (const extra of options.extraModels ?? []) {
    if (extra.id === modelId || models.some((model) => model.id === extra.id)) continue;
    models.push(stubModel(extra.id, extra.name ?? extra.id));
  }
  await writeFile(
    join(agentDir, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          [providerId]: {
            name: "Pix E2E Loopback Stub",
            baseUrl: `http://127.0.0.1:${providerPort}/v1`,
            apiKey: "stub-not-a-real-key",
            api: "openai-completions",
            models,
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(agentDir, "settings.json"),
    `${JSON.stringify(
      {
        defaultProvider: providerId,
        defaultModel: modelId,
        defaultThinkingLevel: "off",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { providerId, modelId };
}

/**
 * Boot the real stack. Requires process.env.PI_CODING_AGENT_DIR to already
 * point at the isolated agentDir (the daemon forwards it to workers). Clears
 * PIX_AGENT_WORKER_FACTORY first: buildWorkerEnv would otherwise forward a
 * leaked injection path from this process's env.
 */
export async function bootLifecycleStack({ sessiondDir, projectCwd, hostDir, clientDist }) {
  assert.ok(process.env.PI_CODING_AGENT_DIR, "PI_CODING_AGENT_DIR must point at the isolated agentDir");
  delete process.env.PIX_AGENT_WORKER_FACTORY;
  assert.equal(process.env.PIX_AGENT_WORKER_FACTORY, undefined, "worker factory injection must stay cleared");

  const daemon = await startDaemon({
    directory: sessiondDir,
    // NO workerFactoryModulePath: workers run the production SDK adapter.
    workerOptions: { stdinEndMs: 1_500, sigtermMs: 1_500, sigkillMs: 1_500 },
    serviceOptions: {
      idleTimeoutMs: 0,
      // Production default 10s worker start — leave it visible if a long JSONL exceeds it.
      workerStartTimeoutMs: WORKER_START_TIMEOUT_MS,
      commandTimeoutMs: COMMAND_TIMEOUT_MS,
    },
  });

  const resolver = createProductionCapabilityResolver({ endpoint: daemon.endpoint, secret: daemon.secret, logger: {} });
  const production = await createProductionResources({
    allowedRootsEnv: projectCwd,
    cwd: projectCwd,
    endpoint: daemon.endpoint,
    secret: daemon.secret,
    hostDirEnv: hostDir,
    logger: {},
  });
  const catalogs = createProductionCatalogs({
    agentDir: process.env.PI_CODING_AGENT_DIR,
    roots: production.deps.allowedRoots,
  });
  // One trusted sessiond client for the runtime gateway AND the Host-owned
  // exact-session authorizer (same composition as production host-runner).
  // Production host-runner constructs this client with no timeout override
  // (submitTurn default 15s, call default 10s). Do not invent a longer test-only
  // RPC budget — slow cold starts must stay visible as phase evidence.
  const sessiondClient = new SessiondRpcClient({ endpoint: daemon.endpoint, secret: daemon.secret });
  const runtimeWs = new SessiondRuntimeGateway({
    client: sessiondClient,
    mode: "local",
    resolveCapabilities: async () => ({
      sessiond: (await resolver.isAvailable()) ? "up" : "down",
      capabilities: await resolver.resolve(),
    }),
    runtimeWorkspaceAuthorizer: createRuntimeWorkspaceAuthorizer({
      client: sessiondClient,
      roots: production.deps.allowedRoots,
    }),
    limits: { maxUpload: PRODUCTION_MAX_UPLOAD_BYTES },
    logger: {},
  });
  const app = createHostApp({
    exposureMode: "local",
    clientDist,
    allowedHosts: ["127.0.0.1"],
    sessiond: resolver,
    capabilities: { full: [...PRODUCTION_FULL_CAPABILITIES], readonly: [...RESOURCE_DEGRADED_CAPABILITIES] },
    resources: production.deps,
    catalogs,
    sessions: {
      client: createSessiondSessionsClient({ endpoint: daemon.endpoint, secret: daemon.secret, timeoutMs: 5_000 }),
      roots: production.deps.allowedRoots,
    },
    gate: { config: { read: () => ({ status: "disabled", source: "e2e" }) } },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    runtimeWs,
    wsMaxPayloadBytes: PRODUCTION_MAX_UPLOAD_BYTES,
  });

  const port = await freePort();
  const handle = await createNodeServer(app, { port, hostname: "127.0.0.1" });
  const origin = `http://127.0.0.1:${handle.port}`;
  const wsUrl = `ws://127.0.0.1:${handle.port}/v1/runtime`;

  const deadline = Date.now() + 10_000;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${origin}/v1/health`)).ok) {
        healthy = true;
        break;
      }
    } catch {
      /* retry */
    }
    await delay(50);
  }
  assert.equal(healthy, true, `lifecycle stack health check timed out at ${origin}`);
  const rpc = new SessiondRpcClient({ endpoint: daemon.endpoint, secret: daemon.secret, timeoutMs: 5_000 });
  const identity = await readServedClientIdentity(origin, clientDist);
  log(
    `stack identity source=${identity.sourceCommit.slice(0, 12)} servedJs=${identity.servedJsHash.slice(0, 12)}… fileJs=${identity.fileJsHash.slice(0, 12)}… daemon=${daemon.instanceId.slice(0, 12)}`,
  );
  return { daemon, handle, origin, wsUrl, rpc, resolver, identity };
}

export async function readServedClientIdentity(origin, clientDist) {
  const htmlResponse = await fetch(`${origin}/`);
  assert.equal(htmlResponse.ok, true, `served index.html must be 200 (got ${htmlResponse.status})`);
  const html = await htmlResponse.text();
  const match = html.match(/src="(\/assets\/index-[^\"]+\.js)"/);
  assert.ok(match, "served index.html must reference a hashed Client JS asset");
  const assetPath = match[1];
  const jsResponse = await fetch(`${origin}${assetPath}`);
  assert.equal(jsResponse.ok, true, `served ${assetPath} must be 200 (got ${jsResponse.status})`);
  const jsBytes = Buffer.from(await jsResponse.arrayBuffer());
  const servedJsHash = createHash("sha256").update(jsBytes).digest("hex");
  const fileName = assetPath.split("/").pop();
  const filePath = join(clientDist, "assets", fileName);
  const fileJsHash = sha256File(filePath);
  assert.equal(servedJsHash, fileJsHash, `served Client JS hash must match dist file ${filePath}`);
  let sourceCommit = "unknown";
  try {
    const { execFileSync } = await import("node:child_process");
    sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT_FROM_HELPER(), encoding: "utf8" }).trim();
  } catch {
    sourceCommit = "unknown";
  }
  return { assetPath, servedJsHash, fileJsHash, sourceCommit, bytes: jsBytes.length };
}

function ROOT_FROM_HELPER() {
  return join(import.meta.dirname, "..", "..");
}

/**
 * Deterministic cleanup of everything the stack owns: HTTP server, daemon
 * (workers first via the authoritative PID list), temp dirs. Safe to call
 * twice and on partial boots.
 */
async function withTimeout(promise, ms, label) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label ?? "teardown"} timeout ${ms}ms`)), ms);
      }),
    ]);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function teardownLifecycleStack(stack, dirs) {
  const failures = [];
  const workerPids = stack?.daemon ? [...stack.daemon.diagnostics.workerPids()] : [];
  if (stack?.handle) {
    const closed = await withTimeout(stack.handle.close(), 3_000, "host.close");
    if (!closed.ok) failures.push(closed.error);
  }
  if (stack?.daemon) {
    const stopped = await withTimeout(stack.daemon.shutdown(), 5_000, "daemon.shutdown");
    if (!stopped.ok) failures.push(stopped.error);
  }
  for (const pid of workerPids) {
    if (!pidAlive(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  const leftover = workerPids.filter((pid) => pidAlive(pid));
  if (leftover.length > 0) failures.push(`owned worker PIDs still alive after SIGKILL: ${leftover.join(",")}`);
  if (dirs) {
    for (const dir of [dirs.agentDir, dirs.sessiondDir, dirs.projectCwd, dirs.hostDir]) {
      const removed = await withTimeout(rm(dir, { recursive: true, force: true }), 2_000, `rm ${dir}`);
      if (!removed.ok) failures.push(removed.error);
    }
  }
  return { failures, workerPids };
}

/**
 * Wait until the client stream goes quiet (no new frames for quietMs), so
 * epoch/revision fences captured from the live stream match the journal at
 * submit time. Bounded; never a correctness assertion on timing.
 */
export async function settleQuiet(client, { quietMs = 250, timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastCount = client.messages.length;
  let lastChange = Date.now();
  while (Date.now() < deadline) {
    await delay(50);
    if (client.messages.length !== lastCount) {
      lastCount = client.messages.length;
      lastChange = Date.now();
      continue;
    }
    if (Date.now() - lastChange >= quietMs) return;
  }
}

/**
 * Fenced submit: captures epoch/lastEventId AFTER a quiet settle and retries
 * the SAME operationId (idempotent admission) if an in-flight event staled the
 * fence (bounded attempts, never a new prompt/operation).
 */
export async function submitFenced(client, sessionId, { prompt, operationId, activationOverrides }) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await settleQuiet(client);
    const result = await client.submitTurn(sessionId, {
      prompt,
      operationId,
      ...(activationOverrides === undefined ? {} : { activationOverrides }),
      expectedEpoch: client.epoch,
      expectedRevision: client.lastEventId,
    });
    if (result.payload.status !== "rejected") return result;
    lastError = result.payload.error;
    if (lastError?.code !== "conflict" && lastError?.code !== "epoch_changed") break;
  }
  throw new Error(`submit ${operationId} rejected: ${JSON.stringify(lastError)}`);
}

/**
 * Cold submit to an inactive session: no attach, no activate, no epoch fence.
 * sessiond must cold-activate from catalog identity. Used to prove submit_turn
 * is the admission authority (lifecycle-reassessment §4.2 / §5.2).
 */
export async function submitUnfenced(client, sessionId, { prompt, operationId, activationOverrides }) {
  return client.submitTurn(sessionId, {
    prompt,
    operationId,
    ...(activationOverrides === undefined ? {} : { activationOverrides }),
  });
}

// ---------------------------------------------------------------------------
// Minimal browser-like runtime WS client (frame contract from tests/e2e/runtime.mjs)
// ---------------------------------------------------------------------------

export class RuntimeWsClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.messages = [];
    this.waiters = new Set();
    this.closed = null;
    this.projection = null;
    this.epoch = undefined;
    this.lastEventId = undefined;
    this.msgSeq = 0;
  }

  async connect(timeoutMs = STEP_TIMEOUT_MS) {
    this.ws = new WebSocket(this.url);
    this.ws.on("message", (data) => {
      let parsed;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        return;
      }
      this.messages.push(parsed);
      this._applyProjection(parsed);
      for (const waiter of [...this.waiters]) {
        if (waiter.pred(parsed)) {
          this.waiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(parsed);
        }
      }
    });
    this.ws.on("close", (code, reason) => {
      this.closed = { code, reason: String(reason ?? "") };
      for (const waiter of [...this.waiters]) {
        this.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`ws closed (${code}:${String(reason ?? "")}) while waiting: ${waiter.label}`));
      }
    });
    this.ws.on("error", () => {
      /* surfaced via close/waiters */
    });
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`ws connect timeout to ${this.url}`)), timeoutMs);
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
    const start = afterIndex === undefined ? 0 : afterIndex;
    const hit = this.messages.slice(start).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(entry);
        const types = this.messages.map((m) => m.type).slice(-20).join(",");
        reject(new Error(`timeout waiting for ${label} (last types: ${types || "none"})`));
      }, timeoutMs);
      const entry = { pred, resolve: resolvePromise, reject, timer, label };
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
    const ack = await this.waitFor((m) => m.type === "handshake_ack", { label: "handshake_ack" });
    this.acceptedFeatures = Array.isArray(ack.payload?.acceptedFeatures) ? ack.payload.acceptedFeatures : [];
    return ack;
  }

  requireAcceptedFeatures(required) {
    const accepted = new Set(this.acceptedFeatures ?? []);
    const missing = required.filter((feature) => !accepted.has(feature));
    assert.equal(missing.length, 0, `handshake must accept ${required.join(",")}; accepted=${JSON.stringify(this.acceptedFeatures ?? [])}`);
    return this.acceptedFeatures;
  }

  async attach(sessionId, resume, { existingOnly = false } = {}) {
    const id = `attach-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const payload = resume && resume.epoch !== undefined ? { sessionId, epoch: resume.epoch, lastEventId: resume.lastEventId } : { sessionId };
    if (existingOnly) payload.attachMode = "existing_only";
    this.send({ type: "attach", id, payload });
    const outcome = await this.waitFor(
      (m) => (m.type === "snapshot" && m.id === id) || (m.type === "response" && m.id === id),
      { label: `attach ${id}` },
    );
    if (outcome.type === "response") {
      assert.equal(outcome.payload.ok, true, JSON.stringify(outcome.payload));
    }
    return outcome;
  }

  async submitTurn(sessionId, { prompt, operationId, activationOverrides, expectedEpoch, expectedRevision }) {
    const id = `submit-${operationId}`;
    const afterIndex = this.messages.length;
    this.send({
      type: "submit_turn",
      id,
      payload: {
        sessionId,
        prompt,
        operationId,
        ...(activationOverrides === undefined ? {} : { activationOverrides }),
        ...(expectedEpoch === undefined ? {} : { expectedEpoch }),
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      },
    });
    return this.waitFor(
      (m) => m.type === "submit_turn_result" && m.id === id,
      { label: `submit_turn ${operationId}`, timeoutMs: COMMAND_TIMEOUT_MS, afterIndex },
    );
  }

  async waitForTurnTerminal(sessionId, operationId, { afterIndex = 0, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
    return this.waitFor(
      (m) => {
        if (m.type !== "turn_status" || m.payload?.sessionId !== sessionId || m.payload?.operationId !== operationId) return false;
        const state = m.payload?.state ?? m.payload?.status?.state;
        return state === "completed" || state === "failed";
      },
      { label: `turn terminal ${operationId}`, timeoutMs, afterIndex },
    );
  }

  async stop(sessionId, reason = "user") {
    const id = `stop-${sessionId.slice(0, 12)}`;
    this.send({ type: "stop", id, payload: { sessionId, reason } });
    return this.waitFor((m) => m.type === "response" && m.id === id, { label: `stop ${id}` });
  }

  async detach(sessionId) {
    const id = `detach-${sessionId.slice(0, 12)}`;
    this.send({ type: "detach", id, payload: { sessionId } });
    return this.waitFor((m) => m.type === "response" && m.id === id, { label: `detach ${id}` });
  }

  async getSnapshot(sessionId) {
    const id = `snap-${sessionId.slice(0, 12)}-${Date.now()}-${this.msgSeq++}`;
    this.send({ type: "getSnapshot", id, payload: { sessionId } });
    const res = await this.waitFor((m) => m.type === "response" && m.id === id, { label: `getSnapshot ${id}` });
    assert.equal(res.payload.ok, true, JSON.stringify(res.payload));
    return res.payload.result;
  }

  eventsFor(sessionId) {
    return this.messages.filter((m) => m.type === "event" && m.payload?.sessionId === sessionId).map((m) => m.payload);
  }

  eventTypes(sessionId) {
    return this.eventsFor(sessionId).map((e) => e.type);
  }

  close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, "client done");
    }
  }

  _applyProjection(message) {
    if (message.type === "snapshot" && message.payload?.snapshot) {
      this.projection = structuredClone(message.payload.snapshot);
      this.epoch = message.payload.epoch;
      this.lastEventId = message.payload.lastEventId;
      return;
    }
    if (message.type === "event" && message.payload && this.projection) {
      try {
        this.projection = reduceRuntimeEventData(this.projection, message.payload);
      } catch {
        /* projection issues surface via explicit assertions */
      }
      if (typeof message.payload.eventId === "number") this.lastEventId = message.payload.eventId;
      if (typeof message.payload.epoch === "string") this.epoch = message.payload.epoch;
    }
  }
}
