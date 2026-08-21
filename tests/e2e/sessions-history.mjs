/**
 * D1A-2 phase 2 E2E — read-only session history with ZERO Workers.
 *
 * Real process path, no fakes on the read side:
 *   seeded Pi SDK JSONL (temp PI_CODING_AGENT_DIR)
 *     → real sessiond daemon (default read-only catalog)
 *     → real Hono Host /v1/sessions* (narrow sessiond RPC client)
 *
 * Guarantees verified:
 *   1. `sessions` capability is advertised while sessiond is up.
 *   2. list / detail / context succeed against real JSONL — read-only.
 *   3. runtime.listRunning is empty and no worker child exists after reads.
 *   4. A read-only context GET (the deep-link request) does NOT start a worker.
 *   5. Continue live (WS attach) is the ONLY path that starts a worker.
 *   6. After sessiond goes down, the `sessions` token is retracted AND the
 *      read routes answer 503.
 *
 * D1 WP-3 extensions (real stack, still zero-worker before the attach step):
 *   7. GET /v1/sessions?limit=&offset= — deterministic newest-first ordering /
 *      slicing plus byte-exact rejection (1e3, 0x, sign, decimal, whitespace,
 *      leading-zero, out-of-range) as fixed 400 INVALID_QUERY.
 *   8. GET context?leafId= — the Host forwards the leaf and the real stack
 *      returns the selected visible branch (trunk vs side) with no leakage;
 *      no Worker is spawned.
 *   9. Session mutation contracts at the correct layer. D4 delete is exercised
 *      through the REAL HTTP route (DELETE /v1/sessions/:id) with the production
 *      mutation seam: stopped/history delete succeeds and removes the file; a
 *      live delete is 409 SESSION_IN_USE with the worker and file retained;
 *      after an explicit runtime.stop the delete succeeds; a request body is
 *      rejected 400; an unauthenticated LAN delete is gated 401 before the
 *      guard/RPC; and while sessiond is down the capability is retracted and
 *      the delete 503s before touching the file. D4 rename is exercised through
 *      the REAL HTTP route (PATCH /v1/sessions/:id) with the production rename
 *      seam: a live attached rename succeeds (sessiond supports live
 *      set_session_name — never busy) and an offline JSONL rename succeeds,
 *      both returning {success:true} with immediate GET/list title, same
 *      id/path/history, honest running-worker state, and fixed fail-closed
 *      invalid-name / query / wrong-method / LAN-auth / down-503 surfaces.
 *  10. A repeated list stays correct and spawns no Worker (no timing asserts).
 *
 * The branched/pagination fixtures are written as raw JSONL in exactly the
 * shape the Pi SDK persists (verified byte-for-byte), because importing the Pi
 * SDK here is forbidden by the architecture gate; the read-only catalog
 * discovers and reads them with zero workers.
 *
 * The temp PI_CODING_AGENT_DIR isolates the run from the user's ~/.pi. The
 * Continue-live worker is the same network-free fixture used by the runtime E2E.
 *
 * Run: npm run test:e2e:sessions
 */
import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "@fffattiger/pix-protocol";
import {
  createHostApp,
  createNodeServer,
  SessiondRuntimeGateway,
  createProductionResources,
  createProductionCatalogs,
  createProductionCapabilityResolver,
  createSessiondSessionsClient,
  createSessiondSessionDeleteClient,
  createSessiondSessionRenameClient,
  PRODUCTION_FULL_CAPABILITIES,
  RESOURCE_DEGRADED_CAPABILITIES,
  PRODUCTION_MAX_UPLOAD_BYTES,
} from "@fffattiger/pix-host";
import { startDaemon } from "@fffattiger/pix-sessiond/daemon";
import { SessiondRpcClient } from "@fffattiger/pix-sessiond/client";
import { createSecureStateBackend } from "@fffattiger/pix-local-authority/state";
import { seedSessionForTests, listSeededSessionIdsForTests } from "@fffattiger/pix-pi-sdk-adapter/testing";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE = resolve(ROOT, "packages/agent-worker/test/fixtures/e2e-runtime-factory.mjs");
const CLIENT_DIST = join(ROOT, "packages", "client", "dist");

const STEP_TIMEOUT_MS = 12_000;

function log(...args) {
  console.error("[pix:e2e:sessions]", ...args);
}
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function freePort() {
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

/**
 * Send an exact HTTP request-target. Node 22.22 fetch normalizes a trailing
 * bare `?` away before it reaches the server, while Node 24/25 preserve it.
 * The Host contract rejects every query delimiter it actually receives, so
 * the cross-version E2E uses node:http for the query-adversarial probes rather
 * than testing Undici's version-specific URL serialization.
 */
async function exactJsonPatch(origin, path, body) {
  const base = new URL(origin);
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return await new Promise((resolvePromise, reject) => {
    const req = httpRequest({
      hostname: base.hostname,
      port: base.port,
      method: "PATCH",
      path,
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(payload)),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("error", reject);
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try { parsed = text.length === 0 ? null : JSON.parse(text); } catch { /* fixed HTTP status remains evidence */ }
        resolvePromise({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

// ---------------------------------------------------------------------------
// Seed real JSONL into a temp agent dir (via the adapter testing helper, so the
// Pi SDK import stays confined to packages/pi-sdk-adapter).
// ---------------------------------------------------------------------------

async function seedSession(projectCwd) {
  return seedSessionForTests({ cwd: projectCwd }).sessionId;
}

// ---------------------------------------------------------------------------
// Deterministic branched/linear JSONL fixtures (D1 WP-3).
//
// The architecture gate forbids importing the Pi SDK outside
// packages/pi-sdk-adapter, so these fixtures are written here as raw JSONL in
// exactly the shape the SDK persists (byte-for-byte verified against a real
// SessionManager.create + appendMessage/branch). The read-only catalog
// (SessionManager.listAll / open) discovers and reads them with zero workers,
// and the file's current leaf (the last entry) drives the no-leafId context.
// ---------------------------------------------------------------------------

const FIXTURE_ENTRY_TS = "2026-08-14T02:07:15.450Z";
const FIXTURE_FILE_TS = FIXTURE_ENTRY_TS.replace(/[:.]/g, "-");

/** Mirror the SDK session-dir encoding (getDefaultSessionDirPath). */
function encodedSessionDir(agentDir, cwd) {
  const resolvedAgentDir = resolve(agentDir);
  const resolvedCwd = resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolvedAgentDir, "sessions", safePath);
}

function fixtureMessage(id, parentId, role, text, timestamp) {
  const message =
    role === "assistant"
      ? {
          role,
          content: [{ type: "text", text }],
          api: "anthropic",
          provider: "anthropic",
          model: "e2e-model",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } },
          stopReason: "stop",
          timestamp,
        }
      : { role, content: text, timestamp };
  return JSON.stringify({ type: "message", id, parentId: parentId ?? null, timestamp: FIXTURE_ENTRY_TS, message });
}

/**
 * Write a deterministic session JSONL file the read-only catalog will
 * discover. `messages` is an ordered list of { id, parentId, role, text,
 * timestamp }. Returns the absolute file path.
 */
async function writeSessionJsonl(agentDir, cwd, sessionId, messages) {
  const dir = encodedSessionDir(agentDir, cwd);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${FIXTURE_FILE_TS}_${sessionId}.jsonl`);
  const header = JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: FIXTURE_ENTRY_TS, cwd: resolve(cwd) });
  await writeFile(file, [header, ...messages.map((m) => fixtureMessage(m.id, m.parentId, m.role, m.text, m.timestamp))].join("\n") + "\n");
  return file;
}

/** Extract the display text of a catalog context entry's message. */
function messageText(entry) {
  const content = entry?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("");
  return "";
}

// ---------------------------------------------------------------------------
// Minimal WS client for the Continue-live attach path
// ---------------------------------------------------------------------------

function attachViaWs(wsUrl, sessionId, timeoutMs = STEP_TIMEOUT_MS) {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(wsUrl);
    let lastMessage = null;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("attach timed out"));
    }, timeoutMs);
    const settle = (fn) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      fn();
    };
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "handshake", id: "hs1", payload: { protocolVersion: PROTOCOL_VERSION, client: { shell: "web", platform: "mac" }, features: [] } }));
    });
    ws.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      lastMessage = message;
      if (message.type === "handshake_ack") {
        ws.send(JSON.stringify({ type: "attach", id: "att1", payload: { sessionId } }));
        return;
      }
      if ((message.type === "snapshot" && message.id === "att1") || (message.type === "response" && message.id === "att1")) {
        settle(() => resolvePromise(message));
      }
    });
    ws.on("error", (error) => settle(() => reject(error)));
    ws.on("close", (code, reason) => {
      if (code !== 1000) settle(() => reject(new Error(`attach ws closed ${code}: ${String(reason ?? "")} last=${JSON.stringify(lastMessage)}`)));
    });
  });
}

// ---------------------------------------------------------------------------
// Stack
// ---------------------------------------------------------------------------

async function bootStack({ agentDir, sessiondDir, projectCwd, hostDir, exposureMode = "local", gate, daemon } = {}) {
  assert.equal(existsSync(FIXTURE), true, `fixture missing: ${FIXTURE}`);
  const clientDist = existsSync(CLIENT_DIST)
    ? CLIENT_DIST
    : await (async (tempDir) => {
        const dist = join(tempDir, "client-dist");
        await mkdir(join(dist, "assets"), { recursive: true });
        const { writeFile } = await import("node:fs/promises");
        await writeFile(join(dist, "index.html"), '<!doctype html><html><body><div id="root"></div></body></html>');
        return dist;
      })(sessiondDir);

  // A second host (e.g. the LAN-auth probe) SHARES the already-running daemon
  // instead of trying to start another instance on the same sessiond directory.
  daemon ??= await startDaemon({
    directory: sessiondDir,
    // Default catalog + locator read from PI_CODING_AGENT_DIR (seeded JSONL).
    // The network-free fixture backs Continue live (open mode, self-contained).
    workerOptions: { workerFactoryModulePath: FIXTURE, stdinEndMs: 1_500, sigtermMs: 1_500, sigkillMs: 1_500 },
    serviceOptions: { idleTimeoutMs: 0, workerStartTimeoutMs: 10_000, commandTimeoutMs: 15_000 },
  });

  // Faithful production wiring: real capability resolver (ping-driven), the
  // narrow sessions client, and the runtime WS gateway sharing the resolver.
  const resolver = createProductionCapabilityResolver({ endpoint: daemon.endpoint, secret: daemon.secret, logger: {} });
  const runtimeWs = new SessiondRuntimeGateway({
    endpoint: daemon.endpoint,
    secret: daemon.secret,
    mode: "local",
    resolveCapabilities: async () => ({
      sessiond: (await resolver.isAvailable()) ? "up" : "down",
      capabilities: await resolver.resolve(),
    }),
    limits: { maxUpload: PRODUCTION_MAX_UPLOAD_BYTES },
    logger: {},
  });
  const production = await createProductionResources({
    allowedRootsEnv: projectCwd,
    cwd: projectCwd,
    endpoint: daemon.endpoint,
    secret: daemon.secret,
    hostDirEnv: hostDir,
    logger: {},
  });
  // Catalogs use the same temp PI_CODING_AGENT_DIR the E2E already isolates;
  // honesty rewrite keeps catalog tokens only while this seam is mounted.
  const catalogs = createProductionCatalogs({
    agentDir: process.env.PI_CODING_AGENT_DIR ?? join(projectCwd, ".pi", "agent"),
    roots: production.deps.allowedRoots,
  });
  const app = createHostApp({
    exposureMode,
    clientDist,
    allowedHosts: ["127.0.0.1"],
    sessiond: resolver,
    capabilities: { full: [...PRODUCTION_FULL_CAPABILITIES], readonly: [...RESOURCE_DEGRADED_CAPABILITIES] },
    // D4: production delete seam — narrow `sessions.delete` RPC client + the
    // shared sessiond `system.ping` mutation guard. Mounted only here (the
    // read-only M1 boot composition still wires no delete route).
    // D4: production rename seam — narrow `sessions.rename` RPC client + the
    // shared sessiond `system.ping` mutation guard; PATCH /v1/sessions/:id is
    // mounted only when this seam is present.
    sessions: {
      client: createSessiondSessionsClient({ endpoint: daemon.endpoint, secret: daemon.secret, timeoutMs: 5_000 }),
      delete: {
        client: createSessiondSessionDeleteClient({ endpoint: daemon.endpoint, secret: daemon.secret, timeoutMs: 5_000 }),
        mutationGuard: production.adapter,
      },
      rename: {
        client: createSessiondSessionRenameClient({ endpoint: daemon.endpoint, secret: daemon.secret, timeoutMs: 5_000 }),
        mutationGuard: production.adapter,
      },
    },
    resources: production.deps,
    catalogs,
    gate: gate ?? { config: { read: () => ({ status: "disabled", source: "e2e" }) } },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    runtimeWs,
    wsMaxPayloadBytes: PRODUCTION_MAX_UPLOAD_BYTES,
  });

  const port = await freePort();
  // LAN exposure must bind a non-loopback address (createNodeServer cross-checks
  // exposureMode against the bind); the health/probe fetch still reaches it via
  // the loopback address.
  const bindHostname = exposureMode === "lan" ? "0.0.0.0" : "127.0.0.1";
  const handle = await createNodeServer(app, { port, hostname: bindHostname });
  const origin = `http://127.0.0.1:${handle.port}`;
  const wsUrl = `ws://127.0.0.1:${handle.port}/v1/runtime`;

  // Wait for health.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${origin}/v1/health`)).ok) break;
    } catch {
      /* retry */
    }
    await delay(50);
  }
  return { daemon, handle, origin, wsUrl, resolver };
}

// ---------------------------------------------------------------------------

async function main() {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await mkdtemp(join(tmpdir(), "pix-e2e-agentdir-"));
  const sessiondParent = await mkdtemp(join(tmpdir(), "pix-e2e-sessiond-"));
  const sessiondDir = join(sessiondParent, "runtime");
  const secureState = createSecureStateBackend();
  const canonicalSessiondDir = await secureState.canonicalizePath(sessiondDir);
  await secureState.ensurePrivateDirectory(canonicalSessiondDir, { requireMode: 0o700 });
  const projectCwd = await mkdtemp(join(tmpdir(), "pix-e2e-project-"));
  // D3A-P0: isolate the Host durable trusted-roots ledger under a canonical
  // temp (never the operator home); a canonical leaf avoids the macOS /var
  // symlink walk that ensurePixHostDir correctly refuses.
  const hostDir = join(realpathSync(tmpdir()), "pix-e2e-host-" + process.pid);
  const canonicalHostDir = await secureState.canonicalizePath(hostDir);
  await secureState.ensurePrivateDirectory(canonicalHostDir, { requireMode: 0o700 });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let stack;
  let exitCode = 0;
  try {
    const sessionId = await seedSession(projectCwd);
    // Sanity: the seeded session is visible to the (default) read-only catalog.
    const seeded = (await listSeededSessionIdsForTests()).includes(sessionId);
    assert.equal(seeded, true, "seeded JSONL must be visible to the read-only catalog");

    // D1 WP-3 fixtures: deterministic pagination + branched sessions written
    // BEFORE the stack boots so the catalog's first scan sees the whole pool.
    // Timestamps are captured after the seeded session's own messages, so the
    // list ordering (newest first) is deterministic:
    //   P1 > P2 > P3 > P4 > BRANCH > seeded
    const FIXTURE_P1 = "e2e-page-0001";
    const FIXTURE_P2 = "e2e-page-0002";
    const FIXTURE_P3 = "e2e-page-0003";
    const FIXTURE_P4 = "e2e-page-0004";
    const FIXTURE_BRANCH = "e2e-branch-0001";
    const FIXTURE_BRANCH_E1 = "branch-root-01";
    const FIXTURE_BRANCH_E2 = "branch-trunk-02";
    const FIXTURE_BRANCH_E3 = "branch-trunk-03";
    const FIXTURE_BRANCH_E4 = "branch-trunk-04";
    const FIXTURE_BRANCH_E5 = "branch-side-05";
    const FIXTURE_BRANCH_E6 = "branch-side-06";
    const FIXTURE_BRANCH_MAIN_LEAF = FIXTURE_BRANCH_E4;
    const FIXTURE_BRANCH_SIDE_LEAF = FIXTURE_BRANCH_E6;
    const BASE = Date.now();
    const linearPair = (id, ts) => [
      { id: `${id}-m1`, parentId: null, role: "user", text: `${id} q1`, timestamp: ts },
      { id: `${id}-m2`, parentId: `${id}-m1`, role: "assistant", text: `${id} a1`, timestamp: ts + 1 },
    ];
    for (const [id, offset] of [[FIXTURE_P1, 5000], [FIXTURE_P2, 4000], [FIXTURE_P3, 3000], [FIXTURE_P4, 2000]]) {
      await writeSessionJsonl(agentDir, projectCwd, id, linearPair(id, BASE + offset));
    }
    // Branched session: trunk root→E1→E2→E3→E4 and a side branch root→E1→E5→E6.
    const branchTs = BASE + 1000;
    await writeSessionJsonl(agentDir, projectCwd, FIXTURE_BRANCH, [
      { id: FIXTURE_BRANCH_E1, parentId: null, role: "user", text: "main q1", timestamp: branchTs },
      { id: FIXTURE_BRANCH_E2, parentId: FIXTURE_BRANCH_E1, role: "assistant", text: "main a1", timestamp: branchTs + 1 },
      { id: FIXTURE_BRANCH_E3, parentId: FIXTURE_BRANCH_E2, role: "user", text: "main q2", timestamp: branchTs + 2 },
      { id: FIXTURE_BRANCH_E4, parentId: FIXTURE_BRANCH_E3, role: "assistant", text: "main a2", timestamp: branchTs + 3 },
      { id: FIXTURE_BRANCH_E5, parentId: FIXTURE_BRANCH_E1, role: "user", text: "branch q1", timestamp: branchTs + 4 },
      { id: FIXTURE_BRANCH_E6, parentId: FIXTURE_BRANCH_E5, role: "assistant", text: "branch a1", timestamp: branchTs + 5 },
    ]);

    stack = await bootStack({ agentDir, sessiondDir, projectCwd, hostDir: canonicalHostDir });
    const rpc = new SessiondRpcClient({ endpoint: stack.daemon.endpoint, secret: stack.daemon.secret, timeoutMs: 5_000 });
    const get = (path) => fetch(`${stack.origin}${path}`).then(async (r) => ({ status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }));

    // 1. `sessions` capability advertised while up (four-surface: bootstrap).
    const boot = await get("/v1/bootstrap");
    assert.equal(boot.status, 200);
    assert.ok(boot.body.capabilities.includes("sessions"), `bootstrap caps must include sessions: ${JSON.stringify(boot.body.capabilities)}`);
    assert.ok(boot.body.capabilities.includes("agent"));
    assert.equal(boot.body.sessiond, "up");

    // 2. list / detail / context succeed against real JSONL.
    const list = await get("/v1/sessions");
    assert.equal(list.status, 200);
    assert.ok(list.body.sessions.some((s) => s.sessionId === sessionId), "list must include seeded session");
    const detail = await get(`/v1/sessions/${sessionId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.session.sessionId, sessionId);
    const context = await get(`/v1/sessions/${sessionId}/context`);
    assert.equal(context.status, 200);
    assert.equal(context.body.context.sessionId, sessionId);
    assert.ok(context.body.context.entries.length >= 2, "context must map seeded entries");

    // 2b. D1 WP-3 pagination: happy ordering/slice + strict invalid 400s.
    const idsOf = (res) => res.body.sessions.map((s) => s.sessionId);
    const fullOrder = [FIXTURE_P1, FIXTURE_P2, FIXTURE_P3, FIXTURE_P4, FIXTURE_BRANCH, sessionId];
    const page0 = await get("/v1/sessions?limit=2&offset=0");
    assert.equal(page0.status, 200);
    assert.deepEqual(idsOf(page0), [FIXTURE_P1, FIXTURE_P2], "limit=2&offset=0 must return the two newest in order");
    const page1 = await get("/v1/sessions?limit=2&offset=1");
    assert.equal(page1.status, 200);
    assert.deepEqual(idsOf(page1), [FIXTURE_P2, FIXTURE_P3], "limit=2&offset=1 must skip one then take two");
    const page3 = await get("/v1/sessions?limit=3&offset=3");
    assert.equal(page3.status, 200);
    assert.deepEqual(idsOf(page3), [FIXTURE_P4, FIXTURE_BRANCH, sessionId], "limit=3&offset=3 must take the tail");
    const tail = await get("/v1/sessions?offset=5");
    assert.equal(tail.status, 200);
    assert.deepEqual(idsOf(tail), [sessionId], "offset=5 must leave the oldest only");
    const one = await get("/v1/sessions?limit=1&offset=5");
    assert.equal(one.status, 200);
    assert.deepEqual(idsOf(one), [sessionId], "limit=1&offset=5 must take the oldest");
    const all = await get("/v1/sessions?limit=1000&offset=0");
    assert.equal(all.status, 200);
    assert.deepEqual(idsOf(all), fullOrder, "limit=1000 must return the whole pool in newest-first order");
    // Boundary-valid values stay 200.
    for (const q of ["limit=1", "limit=1000", "offset=0", "offset=100000", "limit=1&offset=100000"]) {
      const res = await get(`/v1/sessions?${q}`);
      assert.equal(res.status, 200, `boundary query ${q} must be accepted`);
    }
    // Strict invalid values → fixed 400 INVALID_QUERY (byte-exact, no coercion).
    for (const q of [
      "limit=1e3", "limit=0x10", "limit=%2B5", "limit=-5", "limit=5.5",
      "limit=%205", "limit=5%20", "limit=05", "limit=0", "limit=1001",
      "offset=-1", "offset=1e3", "offset=0x1", "offset=05", "offset=100001",
    ]) {
      const res = await get(`/v1/sessions?${q}`);
      assert.equal(res.status, 400, `query ${q} must be a strict 400`);
      assert.equal(res.body.code, "INVALID_QUERY", `query ${q} must report INVALID_QUERY`);
    }

    // 2c. D1 WP-3 GET context with leafId: the Host forwards the leaf and the
    //     real stack returns the selected visible branch, with no Worker.
    const ctxMain = await get(`/v1/sessions/${FIXTURE_BRANCH}/context?leafId=${FIXTURE_BRANCH_MAIN_LEAF}`);
    assert.equal(ctxMain.status, 200);
    assert.equal(ctxMain.body.context.sessionId, FIXTURE_BRANCH);
    assert.equal(ctxMain.body.context.leafId, FIXTURE_BRANCH_MAIN_LEAF, "context must echo the requested leafId");
    assert.deepEqual(ctxMain.body.context.entries.map((e) => e.entryId), [FIXTURE_BRANCH_E1, FIXTURE_BRANCH_E2, FIXTURE_BRANCH_E3, FIXTURE_BRANCH_E4]);
    assert.deepEqual(ctxMain.body.context.entries.map(messageText), ["main q1", "main a1", "main q2", "main a2"]);
    const ctxSide = await get(`/v1/sessions/${FIXTURE_BRANCH}/context?leafId=${FIXTURE_BRANCH_SIDE_LEAF}`);
    assert.equal(ctxSide.status, 200);
    assert.equal(ctxSide.body.context.leafId, FIXTURE_BRANCH_SIDE_LEAF, "context must echo the requested side leafId");
    assert.deepEqual(ctxSide.body.context.entries.map((e) => e.entryId), [FIXTURE_BRANCH_E1, FIXTURE_BRANCH_E5, FIXTURE_BRANCH_E6]);
    assert.deepEqual(ctxSide.body.context.entries.map(messageText), ["main q1", "branch q1", "branch a1"]);
    // No cross-branch leakage: each visible branch excludes the other's entries.
    assert.ok(!JSON.stringify(ctxMain.body.context.entries).includes("branch q1"), "main-branch context must not leak side-branch entries");
    assert.ok(!JSON.stringify(ctxSide.body.context.entries).includes("main q2"), "side-branch context must not leak main-branch entries");
    // No leafId → the file's current leaf (the side branch, last entry).
    const ctxDefault = await get(`/v1/sessions/${FIXTURE_BRANCH}/context`);
    assert.equal(ctxDefault.status, 200);
    assert.equal(ctxDefault.body.context.leafId, FIXTURE_BRANCH_SIDE_LEAF, "no-leafId context must follow the file's current leaf");
    assert.deepEqual(ctxDefault.body.context.entries.map((e) => e.entryId), [FIXTURE_BRANCH_E1, FIXTURE_BRANCH_E5, FIXTURE_BRANCH_E6]);
    const runningAfterLeaf = await rpc.call("runtime.listRunning", {});
    assert.deepEqual(runningAfterLeaf.sessions, [], "leafId context reads must not start a worker");

    // 2d. D1 WP-3 session mutation contracts at the correct layer. This section
    //     is pre-attach (zero-worker), so rename is exercised against the
    //     sessiond RPC seam this E2E already owns: a NON-LIVE rename succeeds as
    //     a real JSONL offline append with canonical name, zero Workers, same
    //     id/path/history, and immediate read/list title. LIVE rename
    //     (set_session_name) is deliberately NOT exercised HERE — this section
    //     stays zero-worker until the attach step (the Host HTTP PATCH route
    //     covers live + offline rename in 5c-1 / 5c-2 after the attach). D4
    //     wires the production daemon's default adapter mutation, so this
    //     RPC-level rename now succeeds as a real JSONL offline append:
    const sessionFileBefore = detail.body.session.sessionFile;
    const renamed = await rpc.call("sessions.rename", { sessionId, name: "  e2e renamed  " });
    assert.deepEqual(renamed, { sessionId, name: "e2e renamed" }, "offline rename returns the canonical trimmed name");
    const readAfterRename = await get(`/v1/sessions/${sessionId}`);
    assert.equal(readAfterRename.status, 200);
    assert.equal(readAfterRename.body.session.title, "e2e renamed", "read observes the new title immediately");
    assert.equal(readAfterRename.body.session.sessionFile, sessionFileBefore, "the rename never rewrites the file path");
    const listAfterRename = await get("/v1/sessions");
    assert.equal(listAfterRename.body.sessions.find((s) => s.sessionId === sessionId)?.title, "e2e renamed", "list observes the new title immediately");
    const runningAfterRename = await rpc.call("runtime.listRunning", {});
    assert.deepEqual(runningAfterRename.sessions, [], "offline rename must not start a Worker");
    const deleteGhost = "nonexistent-delete-00000000-deadbeef";
    try {
      await rpc.call("sessions.delete", { sessionId: deleteGhost });
      assert.fail("delete of a missing session must reject");
    } catch (error) {
      assert.equal(error.code, "not_found", "delete of a missing session must surface not_found");
    }
    // Delete removes the file, drops the session from the list, and the Host
    // read path answers 404 SESSION_NOT_FOUND afterward.
    const branchBefore = await get(`/v1/sessions/${FIXTURE_BRANCH}`);
    assert.equal(branchBefore.status, 200);
    const branchFile = branchBefore.body.session.sessionFile;
    assert.equal(existsSync(branchFile), true, "branch session file must exist before delete");
    const deleted = await rpc.call("sessions.delete", { sessionId: FIXTURE_BRANCH });
    assert.deepEqual(deleted, { sessionId: FIXTURE_BRANCH, deleted: true });
    assert.equal(existsSync(branchFile), false, "delete must remove the session file");
    const branchAfter = await get(`/v1/sessions/${FIXTURE_BRANCH}`);
    assert.equal(branchAfter.status, 404, "deleted session read must be 404");
    assert.equal(branchAfter.body.code, "SESSION_NOT_FOUND");
    const listAfterDelete = await get("/v1/sessions");
    assert.ok(!listAfterDelete.body.sessions.some((s) => s.sessionId === FIXTURE_BRANCH), "deleted session must vanish from the list");

    // 2e. D1 WP-3 repeated list at the real stack: a second list stays correct
    //     and spawns no Worker (no machine-timing assertions).
    const againA = await get("/v1/sessions");
    const againB = await get("/v1/sessions");
    assert.equal(againA.status, 200);
    assert.equal(againB.status, 200);
    assert.deepEqual(idsOf(againA), idsOf(againB), "repeated list must be stable and correct");
    assert.deepEqual(idsOf(againA), [FIXTURE_P1, FIXTURE_P2, FIXTURE_P3, FIXTURE_P4, sessionId], "repeated list must reflect the post-delete pool in order");
    const runningAfterRepeat = await rpc.call("runtime.listRunning", {});
    assert.deepEqual(runningAfterRepeat.sessions, [], "a repeated list must not start a worker");

    // 3. No worker after reads: runtime.listRunning empty + no worker children.
    //    PR#3: worker discovery is authoritative via the in-process daemon
    //    handle — never pgrep/ps/PID files, so it cannot false-green to [] when
    //    pgrep is unavailable.
    const runningAfterReads = await rpc.call("runtime.listRunning", {});
    assert.deepEqual(runningAfterReads.sessions, [], "no worker must be running after read-only requests");
    const workerPidsAfterReads = stack.daemon.diagnostics.workerPids();
    assert.deepEqual(workerPidsAfterReads, [], "no worker child after read-only requests");

    // 4. A read-only context GET (the deep-link request) does not start a worker.
    await get(`/v1/sessions/${sessionId}/context`);
    const runningAfterDeepLink = await rpc.call("runtime.listRunning", {});
    assert.deepEqual(runningAfterDeepLink.sessions, [], "read-only deep-link GET must not start a worker");
    const workerPidsAfterDeepLink = stack.daemon.diagnostics.workerPids();
    assert.deepEqual(workerPidsAfterDeepLink, workerPidsAfterReads, "no new worker child after read-only deep link");

    // 4b. A nonexistent session read AND context return a sanitized 404
    //     SESSION_NOT_FOUND through the REAL stack (catalog not_found →
    //     sessiond boundary → Host), with no id/path/endpoint/secret/stack
    //     leakage, and without starting a worker.
    const ghost = "nonexistent-session-00000000-deadbeef";
    const ghostRead = await get(`/v1/sessions/${ghost}`);
    assert.equal(ghostRead.status, 404, "missing session read must be 404");
    assert.equal(ghostRead.body.code, "SESSION_NOT_FOUND");
    assert.equal(ghostRead.body.message, "Session not found");
    const ghostContext = await get(`/v1/sessions/${ghost}/context`);
    assert.equal(ghostContext.status, 404, "missing session context must be 404");
    assert.equal(ghostContext.body.code, "SESSION_NOT_FOUND");
    assert.equal(ghostContext.body.message, "Session not found");
    // No leakage: the response bodies must never echo the session id, the
    // sessiond socket endpoint path, the shared secret, or any stack trace.
    for (const body of [ghostRead.body, ghostContext.body]) {
      const json = JSON.stringify(body);
      assert.ok(!json.includes(ghost), `404 body must not echo the session id: ${json}`);
      assert.ok(!json.includes(stack.daemon.endpoint), `404 body must not leak the sessiond endpoint: ${json}`);
      assert.ok(!json.includes(stack.daemon.secret), `404 body must not leak the sessiond secret: ${json}`);
      assert.ok(!json.includes(sessiondDir), `404 body must not leak the stack path: ${json}`);
      assert.ok(!/\bat\b.*\(/.test(json) && !json.includes("stack"), `404 body must not leak a stack trace: ${json}`);
    }
    // A 404 read path stays read-only: still zero workers, no new worker child.
    const runningAfter404 = await rpc.call("runtime.listRunning", {});
    assert.deepEqual(runningAfter404.sessions, [], "a missing-session 404 must not start a worker");
    const workerPidsAfter404 = stack.daemon.diagnostics.workerPids();
    assert.deepEqual(workerPidsAfter404, workerPidsAfterDeepLink, "no new worker child after missing-session 404");

    // 5. Continue live (WS attach) is the ONLY path that starts a worker.
    const outcome = await attachViaWs(stack.wsUrl, sessionId);
    assert.equal(outcome.type, "snapshot", "continue-live attach must deliver an initial snapshot");
    assert.equal(outcome.payload.sessionId, sessionId);
    let runningAfterAttach = await rpc.call("runtime.listRunning", {});
    // The activate→worker.ready→snapshot path is async; poll briefly.
    for (let i = 0; i < 40 && runningAfterAttach.sessions.length === 0; i++) {
      await delay(50);
      runningAfterAttach = await rpc.call("runtime.listRunning", {});
    }
    assert.ok(runningAfterAttach.sessions.some((s) => s.sessionId === sessionId), "continue live must start a worker");

    // 5b. D4 session-history delete (HTTP, real Host→sessiond→adapter). The
    //     delete route is sessiond-guarded: live ⇒ 409 SESSION_IN_USE (never
    //     stop-then-delete), stopped/history ⇒ success + file removed, and the
    //     sessiond `system.ping` mutation guard runs before any RPC.
    const del = (path, init = {}) =>
      fetch(`${stack.origin}${path}`, { method: "DELETE", ...init }).then(async (r) => ({ status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }));
    const patch = (path, init = {}) =>
      fetch(`${stack.origin}${path}`, { method: "PATCH", ...init }).then(async (r) => ({ status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }));
    const jsonPatch = (path, body) =>
      patch(path, {
        body: typeof body === "string" ? body : JSON.stringify(body),
        headers: { "content-type": "application/json" },
      });
    // `session.delete` / `session.write` are advertised while sessiond is up (full caps).
    assert.ok(boot.body.capabilities.includes("session.delete"), `full caps must include session.delete: ${JSON.stringify(boot.body.capabilities)}`);
    assert.ok(boot.body.capabilities.includes("session.write"), `full caps must include session.write: ${JSON.stringify(boot.body.capabilities)}`);

    // 5b-1. Live session delete ⇒ 409 SESSION_IN_USE; worker + file retained.
    const liveDetail = await get(`/v1/sessions/${sessionId}`);
    assert.equal(liveDetail.status, 200);
    const liveFile = liveDetail.body.session.sessionFile;
    assert.equal(existsSync(liveFile), true, "live session file must exist before delete");
    const liveDelete = await del(`/v1/sessions/${sessionId}`);
    assert.equal(liveDelete.status, 409, "live session delete must be 409");
    assert.equal(liveDelete.body.code, "SESSION_IN_USE");
    const runningAfterLiveDelete = await rpc.call("runtime.listRunning", {});
    assert.ok(runningAfterLiveDelete.sessions.some((s) => s.sessionId === sessionId), "live delete must not stop the worker");
    assert.equal(existsSync(liveFile), true, "live delete must retain the file");

    // 5c-1. LIVE attached HTTP PATCH rename succeeds (sessiond supports live
    //         rename via set_session_name — never a busy/409), returns strict
    //         {success:true}, and the title overlay is immediately visible to
    //         read/list with the same id/path while the worker stays honest.
    const livePatch = await jsonPatch(`/v1/sessions/${sessionId}`, { name: "  live renamed 😀  " });
    assert.equal(livePatch.status, 200, "live attached rename must succeed");
    assert.deepEqual(livePatch.body, { success: true });
    const liveReadAfter = await get(`/v1/sessions/${sessionId}`);
    assert.equal(liveReadAfter.status, 200);
    assert.equal(liveReadAfter.body.session.title, "live renamed 😀", "read must observe the live rename title immediately");
    assert.equal(liveReadAfter.body.session.sessionFile, liveFile, "live rename never rewrites the file path");
    const liveListAfter = await get("/v1/sessions");
    assert.equal(liveListAfter.body.sessions.find((s) => s.sessionId === sessionId)?.title, "live renamed 😀", "list must observe the live rename title immediately");
    const runningAfterLiveRename = await rpc.call("runtime.listRunning", {});
    assert.ok(runningAfterLiveRename.sessions.some((s) => s.sessionId === sessionId), "live rename must not stop the worker");
    assert.equal(runningAfterLiveRename.sessions.find((s) => s.sessionId === sessionId)?.sessionId, sessionId, "running worker identity stays honest after live rename");

    // 5b-2. After an explicit runtime.stop, delete succeeds and removes the file.
    const stopped = await rpc.call("runtime.stop", { sessionId, reason: "user" });
    assert.equal(stopped.stopped, true);
    for (let i = 0; i < 40; i++) {
      const running = await rpc.call("runtime.listRunning", {});
      if (!running.sessions.some((s) => s.sessionId === sessionId)) break;
      await delay(50);
    }
    const stoppedDelete = await del(`/v1/sessions/${sessionId}`);
    assert.equal(stoppedDelete.status, 200, "delete after explicit stop must succeed");
    assert.deepEqual(stoppedDelete.body, { success: true });
    assert.equal(existsSync(liveFile), false, "delete must remove the file after stop");
    const sessionAfterDelete = await get(`/v1/sessions/${sessionId}`);
    assert.equal(sessionAfterDelete.status, 404, "deleted session read must be 404");

    // 5b-3. HTTP DELETE of a stopped JSONL session (never activated): file /
    //       list / read all reflect the deletion.
    const p1Detail = await get(`/v1/sessions/${FIXTURE_P1}`);
    const p1File = p1Detail.body.session.sessionFile;
    assert.equal(existsSync(p1File), true, "stopped P1 file must exist before delete");
    const p1Delete = await del(`/v1/sessions/${FIXTURE_P1}`);
    assert.equal(p1Delete.status, 200);
    assert.deepEqual(p1Delete.body, { success: true });
    assert.equal(existsSync(p1File), false, "delete must remove the stopped JSONL file");
    const p1After = await get(`/v1/sessions/${FIXTURE_P1}`);
    assert.equal(p1After.status, 404, "deleted P1 read must be 404");
    const listAfterHttpDelete = await get("/v1/sessions");
    assert.ok(!listAfterHttpDelete.body.sessions.some((s) => s.sessionId === FIXTURE_P1), "deleted P1 must vanish from the list");

    // 5b-4. DELETE with a body/force is rejected 400; the file is retained.
    const p2Detail = await get(`/v1/sessions/${FIXTURE_P2}`);
    const p2File = p2Detail.body.session.sessionFile;
    const bodyDelete = await del(`/v1/sessions/${FIXTURE_P2}`, {
      body: JSON.stringify({ force: true }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(bodyDelete.status, 400, "a delete with a body must be 400");
    assert.equal(bodyDelete.body.code, "REQUEST_BODY_NOT_ALLOWED");
    assert.equal(existsSync(p2File), true, "a body-rejected delete must not touch the file");

    // 5c-2. HTTP PATCH offline rename of a stopped JSONL session (never
    //        activated): real JSONL append, canonical trimmed name, same
    //        id/path/history, zero Worker, immediate GET/list title, and the
    //        invalid/query/method surfaces all fail closed with zero RPC effect.
    const p4Detail = await get(`/v1/sessions/${FIXTURE_P4}`);
    const p4File = p4Detail.body.session.sessionFile;
    assert.equal(existsSync(p4File), true, "stopped P4 file must exist before rename");
    const p4Rename = await jsonPatch(`/v1/sessions/${FIXTURE_P4}`, { name: "  offline renamed 🚀  " });
    assert.equal(p4Rename.status, 200, "offline rename must succeed");
    assert.deepEqual(p4Rename.body, { success: true });
    const p4ReadAfter = await get(`/v1/sessions/${FIXTURE_P4}`);
    assert.equal(p4ReadAfter.status, 200);
    assert.equal(p4ReadAfter.body.session.title, "offline renamed 🚀", "read observes the offline rename title immediately");
    assert.equal(p4ReadAfter.body.session.sessionFile, p4File, "offline rename never rewrites the file path");
    assert.deepEqual(p4ReadAfter.body.session.entries.map((e) => e.entryId), [`${FIXTURE_P4}-m1`, `${FIXTURE_P4}-m2`], "rename must preserve the session history");
    const p4ListAfter = await get("/v1/sessions");
    assert.equal(p4ListAfter.body.sessions.find((s) => s.sessionId === FIXTURE_P4)?.title, "offline renamed 🚀", "list observes the offline rename title immediately");
    const runningAfterOfflineRename = await rpc.call("runtime.listRunning", {});
    assert.ok(!runningAfterOfflineRename.sessions.some((s) => s.sessionId === FIXTURE_P4), "offline rename must not start a worker");
    // 5c-3. invalid name / blank / control / query / wrong method / extra field
    //        all fail closed with fixed errors and the file is retained.
    const invalidCases = [
      { body: { name: "   " }, status: 400, code: "INVALID_SESSION_NAME" },
      { body: { name: "a\u0000b" }, status: 400, code: "INVALID_SESSION_NAME" },
      { body: { name: "a".repeat(201) }, status: 400, code: "INVALID_SESSION_NAME" },
      { body: { name: "x", extra: 1 }, status: 400, code: "INVALID_SESSION_NAME" },
      { body: { name: 5 }, status: 400, code: "INVALID_SESSION_NAME" },
      { body: "{not-json", status: 400, code: "INVALID_JSON" },
    ];
    for (const c of invalidCases) {
      const res = await jsonPatch(`/v1/sessions/${FIXTURE_P4}`, c.body);
      assert.equal(res.status, c.status, `rename body ${JSON.stringify(c.body)} must be ${c.status}`);
      assert.equal(res.body.code, c.code);
      assert.equal(existsSync(p4File), true, "an invalid rename must never touch the file");
    }
    for (const q of ["?", "?x", "?force=false"]) {
      const res = await exactJsonPatch(stack.origin, `/v1/sessions/${FIXTURE_P4}${q}`, { name: "x" });
      assert.equal(res.status, 400, `rename query ${q} must be 400`);
      assert.equal(res.body.code, "INVALID_QUERY");
      assert.equal(existsSync(p4File), true, "a query-rejected rename must never touch the file");
    }
    const postRename = await fetch(`${stack.origin}/v1/sessions/${FIXTURE_P4}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    assert.equal(postRename.status, 404, "POST is not a rename surface");
    assert.equal(existsSync(p4File), true, "a wrong-method rename must never touch the file");

    // 5b-5. Auth LAN gate FIRST: an unauthenticated DELETE against a LAN-bound
    //       Host with an enabled gate is rejected before the mutation guard /
    //       RPC, and the session file is retained. (Separate Host-state dir:
    //       the lifetime Host-dir lease is exclusive per host.)
    const lanHostDir = join(realpathSync(tmpdir()), "pix-e2e-host-lan-" + process.pid);
    const canonicalLanHostDir = await secureState.canonicalizePath(lanHostDir);
    await secureState.ensurePrivateDirectory(canonicalLanHostDir, { requireMode: 0o700 });
    let lanStack;
    try {
      lanStack = await bootStack({
        agentDir, sessiondDir, projectCwd, hostDir: canonicalLanHostDir,
        exposureMode: "lan",
        gate: { config: { read: () => ({ status: "enabled", password: "lan-secret", source: "e2e" }) } },
        daemon: stack.daemon, // share the already-running sessiond
      });
      const lanDel = await fetch(`${lanStack.origin}/v1/sessions/${FIXTURE_P3}`, { method: "DELETE" });
      assert.ok(lanDel.status === 401 || lanDel.status === 403, `LAN unauth delete must be rejected, got ${lanDel.status}`);
      const lanPatch = await fetch(`${lanStack.origin}/v1/sessions/${FIXTURE_P3}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "x" }),
      });
      assert.ok(lanPatch.status === 401 || lanPatch.status === 403, `LAN unauth rename must be rejected, got ${lanPatch.status}`);
      // The LAN gate also blocks reads, so verify the file retention on disk
      // directly (the LAN-blocked delete/rename must never touch the JSONL).
      const p3File = join(encodedSessionDir(agentDir, projectCwd), `${FIXTURE_FILE_TS}_${FIXTURE_P3}.jsonl`);
      assert.equal(existsSync(p3File), true, "LAN-blocked delete must retain the file");
    } finally {
      if (lanStack?.handle) {
        try { await lanStack.handle.close(); } catch { /* ignore */ }
      }
      await rm(canonicalLanHostDir, { recursive: true, force: true });
    }

    // 6. sessiond down → `sessions` + `session.delete` + `session.write` retracted
    //    AND routes 503.
    const p3FileBeforeDown = (await get(`/v1/sessions/${FIXTURE_P3}`)).body.session.sessionFile;
    assert.equal(existsSync(p3FileBeforeDown), true, "P3 file must exist before the down-delete probe");
    await stack.daemon.shutdown();
    let downBoot;
    for (let i = 0; i < 40; i++) {
      downBoot = await get("/v1/bootstrap");
      if (!downBoot.body.capabilities.includes("sessions")) break;
      await delay(50);
    }
    assert.ok(!downBoot.body.capabilities.includes("sessions"), "sessions token must be retracted when sessiond is down");
    assert.ok(!downBoot.body.capabilities.includes("session.delete"), "session.delete must be retracted when sessiond is down");
    assert.ok(!downBoot.body.capabilities.includes("session.write"), "session.write must be retracted when sessiond is down");
    assert.deepEqual(downBoot.body.capabilities, [...RESOURCE_DEGRADED_CAPABILITIES]);
    const downList = await get("/v1/sessions");
    assert.equal(downList.status, 503, "read route must answer 503 when sessiond is down");
    assert.equal(downList.body.code, "SESSIONS_UNAVAILABLE");
    // D4: a delete while sessiond is down 503s from the mutation guard BEFORE
    // the RPC/effect — the file is never touched.
    const downDelete = await del(`/v1/sessions/${FIXTURE_P3}`);
    assert.equal(downDelete.status, 503, "delete must 503 when sessiond is down");
    assert.equal(existsSync(p3FileBeforeDown), true, "a down 503 delete must never touch the file");
    // D4: a rename while sessiond is down 503s from the mutation guard BEFORE
    // any query/body parsing or RPC/effect — the file is never touched.
    const downRename = await jsonPatch(`/v1/sessions/${FIXTURE_P3}`, { name: "x" });
    assert.equal(downRename.status, 503, "rename must 503 when sessiond is down");
    assert.equal(downRename.body.code, "MUTATION_UNAVAILABLE");
    assert.equal(existsSync(p3FileBeforeDown), true, "a down 503 rename must never touch the file");

    log(`PASS — session ${sessionId.slice(0, 8)} read-only with zero workers; continue live started a worker; D4 delete (live 409 / stop-then-delete / stopped HTTP / body 400 / LAN auth / down 503) verified; D4 rename (live + offline HTTP PATCH / invalid + query + method fail-closed / LAN auth / down retraction + 503) verified; down retraction + 503 verified`);
  } catch (error) {
    exitCode = 1;
    log("FAIL", error?.stack ?? error);
  } finally {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    // Best-effort cleanup of any worker children spawned by the fixture: the
    // in-process daemon handle is authoritative, so capture the live worker
    // PIDs BEFORE shutdown (after shutdown the records are gone) and SIGKILL
    // them as a safety net.
    const daemonForCleanup = stack?.daemon;
    const workerPidsForCleanup = daemonForCleanup ? daemonForCleanup.diagnostics.workerPids() : [];
    if (stack?.handle) {
      try {
        await stack.handle.close();
      } catch {
        /* ignore */
      }
    }
    if (daemonForCleanup) {
      try {
        await daemonForCleanup.shutdown();
      } catch {
        /* ignore */
      }
    }
    await rm(canonicalHostDir, { recursive: true, force: true });
    for (const pid of workerPidsForCleanup) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
    await rm(agentDir, { recursive: true, force: true });
    await rm(sessiondParent, { recursive: true, force: true });
    await rm(projectCwd, { recursive: true, force: true });
  }
  return exitCode;
}

main().then((code) => {
  process.exitCode = code;
});
