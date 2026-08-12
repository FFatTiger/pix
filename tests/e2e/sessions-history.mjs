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
 * The temp PI_CODING_AGENT_DIR isolates the run from the user's ~/.pi. The
 * Continue-live worker is the same network-free fixture used by the runtime E2E.
 *
 * Run: npm run test:e2e:sessions
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
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

async function bootStack({ agentDir, sessiondDir, projectCwd }) {
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
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let stack;
  let exitCode = 0;
  try {
    const sessionId = await seedSession(projectCwd);
    // Sanity: the seeded session is visible to the (default) read-only catalog.
    const seeded = (await listSeededSessionIdsForTests()).includes(sessionId);
    assert.equal(seeded, true, "seeded JSONL must be visible to the read-only catalog");

    stack = await bootStack({ agentDir, sessiondDir, projectCwd });
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
