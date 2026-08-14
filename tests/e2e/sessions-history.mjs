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
 *   9. Session mutation contracts at the correct layer: the Host has no
 *      mutation routes (read-only, D4) — none are invented here. Delete and
 *      rename are exercised directly against the sessiond RPC seam this E2E
 *      already owns. Delete removes the file and the subsequent Host read 404s.
 *      Non-live rename is fixed-unavailable; LIVE rename is deliberately NOT
 *      covered: it requires a Worker (set_session_name command) and would
 *      broaden this slice past zero-worker, so only the non-live contract is
 *      tested (per the WP-3 assignment).
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
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import {
  createHostApp,
  createNodeServer,
  SessiondRuntimeGateway,
  createProductionResources,
  createProductionCatalogs,
  createProductionCapabilityResolver,
  createSessiondSessionsClient,
  PRODUCTION_FULL_CAPABILITIES,
  RESOURCE_DEGRADED_CAPABILITIES,
  PRODUCTION_MAX_UPLOAD_BYTES,
} from "@fffattiger/pix-host";
import { startDaemon } from "@fffattiger/pix-sessiond/daemon";
import { SessiondRpcClient } from "@fffattiger/pix-sessiond/client";
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
function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
async function listChildPids(parentPid) {
  if (process.platform === "win32") return [];
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
  const file = join(dir, `${FIXTURE_ENTRY_TS}_${sessionId}.jsonl`);
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
      ws.send(JSON.stringify({ type: "handshake", id: "hs1", payload: { protocolVersion: 1, client: { shell: "web", platform: "mac" }, features: [] } }));
    });
    ws.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (message.type === "handshake_ack") {
        ws.send(JSON.stringify({ type: "attach", id: "att1", payload: { sessionId } }));
        return;
      }
      if ((message.type === "snapshot" && message.id === "att1") || (message.type === "response" && message.id === "att1")) {
        settle(() => resolvePromise(message));
      }
    });
    ws.on("error", (error) => settle(() => reject(error)));
  });
}

// ---------------------------------------------------------------------------
// Stack
// ---------------------------------------------------------------------------

async function bootStack({ agentDir, sessiondDir, projectCwd, hostDir }) {
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

  const daemon = await startDaemon({
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
    resolveCapabilities: () => resolver.resolve(),
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
    exposureMode: "local",
    clientDist,
    allowedHosts: ["127.0.0.1"],
    sessiond: resolver,
    capabilities: { full: [...PRODUCTION_FULL_CAPABILITIES], readonly: [...RESOURCE_DEGRADED_CAPABILITIES] },
    sessions: { client: createSessiondSessionsClient({ endpoint: daemon.endpoint, secret: daemon.secret, timeoutMs: 5_000 }) },
    resources: production.deps,
    catalogs,
    gate: { config: { read: () => ({ status: "disabled", source: "e2e" }) } },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    runtimeWs,
    wsMaxPayloadBytes: PRODUCTION_MAX_UPLOAD_BYTES,
  });

  const port = await freePort();
  const handle = await createNodeServer(app, { port, hostname: "127.0.0.1" });
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
  const sessiondDir = await mkdtemp(join(tmpdir(), "pix-e2e-sessiond-"));
  const projectCwd = await mkdtemp(join(tmpdir(), "pix-e2e-project-"));
  // D3A-P0: isolate the Host durable trusted-roots ledger under a canonical
  // temp (never the operator home); a canonical leaf avoids the macOS /var
  // symlink walk that ensurePixHostDir correctly refuses.
  const hostDir = join(realpathSync(tmpdir()), "pix-e2e-host-" + process.pid);
  mkdirSync(hostDir, { recursive: false, mode: 0o700 });
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

    stack = await bootStack({ agentDir, sessiondDir, projectCwd, hostDir });
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

    // 2d. D1 WP-3 session mutation contracts at the correct layer. The Host
    //     exposes no mutation routes (read-only by design, D4) — do not invent
    //     any. These are exercised against the sessiond RPC seam this E2E
    //     already owns. Non-live rename is fixed-unavailable (M1 ships no
    //     mutation backend); live rename requires a Worker (set_session_name
    //     command) and is deliberately NOT exercised here — this slice stays
    //     zero-worker, so only the non-live contract is covered.
    try {
      await rpc.call("sessions.rename", { sessionId, name: "renamed" });
      assert.fail("non-live rename must be unavailable");
    } catch (error) {
      assert.equal(error.code, "unavailable", "non-live rename must surface code unavailable");
    }
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
    const runningAfterReads = await rpc.call("runtime.listRunning", {});
    assert.deepEqual(runningAfterReads.sessions, [], "no worker must be running after read-only requests");
    const childrenAfterReads = await listChildPids(process.pid);

    // 4. A read-only context GET (the deep-link request) does not start a worker.
    await get(`/v1/sessions/${sessionId}/context`);
    const runningAfterDeepLink = await rpc.call("runtime.listRunning", {});
    assert.deepEqual(runningAfterDeepLink.sessions, [], "read-only deep-link GET must not start a worker");
    const childrenAfterDeepLink = await listChildPids(process.pid);
    assert.deepEqual(childrenAfterDeepLink, childrenAfterReads, "no new worker child after read-only deep link");

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
    const childrenAfter404 = await listChildPids(process.pid);
    assert.deepEqual(childrenAfter404, childrenAfterDeepLink, "no new worker child after missing-session 404");

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

    // 6. sessiond down → `sessions` retracted AND routes 503.
    await stack.daemon.shutdown();
    let downBoot;
    for (let i = 0; i < 40; i++) {
      downBoot = await get("/v1/bootstrap");
      if (!downBoot.body.capabilities.includes("sessions")) break;
      await delay(50);
    }
    assert.ok(!downBoot.body.capabilities.includes("sessions"), "sessions token must be retracted when sessiond is down");
    assert.deepEqual(downBoot.body.capabilities, [...RESOURCE_DEGRADED_CAPABILITIES]);
    const downList = await get("/v1/sessions");
    assert.equal(downList.status, 503, "read route must answer 503 when sessiond is down");
    assert.equal(downList.body.code, "SESSIONS_UNAVAILABLE");

    log(`PASS — session ${sessionId.slice(0, 8)} read-only with zero workers; continue live started a worker; down retraction + 503 verified`);
  } catch (error) {
    exitCode = 1;
    log("FAIL", error?.stack ?? error);
  } finally {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (stack?.handle) {
      try {
        await stack.handle.close();
      } catch {
        /* ignore */
      }
    }
    if (stack?.daemon) {
      try {
        await stack.daemon.shutdown();
      } catch {
        /* ignore */
      }
    }
    await rm(hostDir, { recursive: true, force: true });
    // Best-effort cleanup of any worker children spawned by the fixture.
    for (const pid of await listChildPids(process.pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
    await rm(agentDir, { recursive: true, force: true });
    await rm(sessiondDir, { recursive: true, force: true });
    await rm(projectCwd, { recursive: true, force: true });
  }
  return exitCode;
}

main().then((code) => {
  process.exitCode = code;
});
