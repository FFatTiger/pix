import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { seedSessionForTests } from "@fffattiger/pix-pi-sdk-adapter/testing";
import { PROTOCOL_VERSION, SESSIOND_RPC_METHODS } from "@fffattiger/pix-protocol";
import { makeRuntimeError, type SessionCatalogPort, type SessionDetail, type SessionLocatorPort } from "@fffattiger/pix-runtime-core";
import { SessiondError } from "../src/errors.js";
import { instanceAlive, readInstanceLock, sessiondPaths } from "../src/control.js";
import { SessiondRpcClient } from "../src/rpc.js";
import type { ActivationContextProvider } from "../src/service.js";
import { FakeWorkerFactory } from "../src/testing/fake-worker.js";
import { UnavailableWorkerFactory, startDaemon } from "../src/composition/index.js";

const isWindows = process.platform === "win32";
const tempDir = (): Promise<string> => mkdtemp(join(tmpdir(), "sessiond-daemon-"));
const cleanup = async (dir: string): Promise<void> => {
  await rm(dir, { recursive: true, force: true });
};
const client = (handle: { endpoint: string; secret: string }): SessiondRpcClient =>
  new SessiondRpcClient({ endpoint: handle.endpoint, secret: handle.secret, timeoutMs: 2_000 });

/**
 * Leave a real Unix socket file behind with NO live listener, mimicking a
 * daemon killed (SIGKILL) mid-run. A graceful close would unlink it, so we
 * hard-kill a child that bound the socket.
 */
async function leaveDeadSocket(endpoint: string): Promise<void> {
  const script = `const{createServer}=require("node:net");const s=createServer(()=>{});s.listen(${JSON.stringify(endpoint)},()=>process.stdout.write("ready"));`;
  const child = spawn(process.execPath, ["--input-type=commonjs", "-e", script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("stale-socket child did not signal ready")), 2_000);
    child.stdout?.on("data", () => {
      clearTimeout(timer);
      resolve();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

test("daemon serves system.ping and system.hello", async () => {
  const dir = await tempDir();
  try {
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    const rpc = client(handle);
    const ping = await rpc.call("system.ping", {});
    assert.equal(ping.pong, true);
    assert.equal(typeof ping.serverTime, "number");
    const hello = await rpc.call("system.hello", {});
    assert.equal(hello.protocolVersion, PROTOCOL_VERSION);
    await handle.shutdown();
  } finally {
    await cleanup(dir);
  }
});

test("a second daemon on the same directory is rejected as a conflict (single instance)", async () => {
  const dir = await tempDir();
  try {
    const first = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    await assert.rejects(
      startDaemon({ directory: dir }),
      (error) => error instanceof SessiondError && error.code === "conflict",
    );
    assert.equal(first.instanceId.length > 0, true);
    await first.shutdown();
  } finally {
    await cleanup(dir);
  }
});

test("stale socket is recovered before listen so the daemon boots", async (t) => {
  if (isWindows) return t.skip("unix domain socket debris recovery");
  const dir = await tempDir();
  const paths = sessiondPaths(dir);
  try {
    await leaveDeadSocket(paths.endpoint);
    await stat(paths.endpoint); // dead debris present, no listener

    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    const rpc = client(handle);
    assert.equal((await rpc.call("system.ping", {})).pong, true);
    await handle.shutdown();
  } finally {
    await cleanup(dir);
  }
});

test("shutdown removes the instance lock and socket", async (t) => {
  const dir = await tempDir();
  try {
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    await handle.shutdown();
    await assert.rejects(stat(handle.paths.lockFile), (error) => (error as NodeJS.ErrnoException).code === "ENOENT");
    if (!isWindows) {
      await assert.rejects(stat(handle.paths.endpoint), (error) => (error as NodeJS.ErrnoException).code === "ENOENT");
    }
  } finally {
    await cleanup(dir);
  }
});

test("shutdown is idempotent and resolves closed", async () => {
  const dir = await tempDir();
  try {
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    await handle.shutdown();
    await handle.shutdown();
    await handle.closed;
  } finally {
    await cleanup(dir);
  }
});

test("unavailable worker runtime rejects create without starting a worker", async () => {
  const dir = await tempDir();
  try {
    const factory = new UnavailableWorkerFactory();
    const handle = await startDaemon({ directory: dir, workerFactory: factory, serviceOptions: { idleTimeoutMs: 0 } });
    const rpc = client(handle);
    await assert.rejects(
      rpc.call("runtime.create", { createRequestId: "create-m1", cwd: "/project", projectRoot: "/project" }),
      (error) => error instanceof SessiondError && error.code === "worker_unavailable",
    );
    // start() was attempted exactly once and never produced a live worker.
    assert.equal(factory.attempts, 1);
    assert.equal((await rpc.call("runtime.listRunning", {})).sessions.length, 0);
    // The control/read surface still works.
    assert.equal((await rpc.call("system.ping", {})).pong, true);
    await handle.shutdown();
  } finally {
    await cleanup(dir);
  }
});

test("control surface reports liveness tied to the lock", async () => {
  const dir = await tempDir();
  const paths = sessiondPaths(dir);
  try {
    assert.equal(await instanceAlive(paths), false);
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    const lock = await readInstanceLock(paths);
    assert.equal(lock?.instanceId, handle.instanceId);
    assert.equal(typeof lock?.pid, "number");
    assert.equal(await instanceAlive(paths), true);
    await handle.shutdown();
    assert.equal(await instanceAlive(paths), false);
  } finally {
    await cleanup(dir);
  }
});

test("a very-early signal during startup shuts down gracefully and leaves no brick", async (t) => {
  if (isWindows) return t.skip("unix signal delivery during startup");
  const dir = await tempDir();
  // The child imports the compiled composition root, installs runDaemon's signal
  // handlers, then SIGINTs itself on the next tick while startup is delayed.
  const moduleUrl = new URL("../src/composition/index.js", import.meta.url).href;
  const childScript = `import { runDaemon } from ${JSON.stringify(moduleUrl)};
setImmediate(() => process.kill(process.pid, "SIGINT"));
const code = await runDaemon({ directory: process.argv[2], __testStartupDelayMs: 100, serviceOptions: { idleTimeoutMs: 0 } });
process.exitCode = code;
`;
  const scriptPath = join(dir, "child.mjs");
  try {
    await writeFile(scriptPath, childScript);
    const child = spawn(process.execPath, [scriptPath, dir], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const code = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("daemon child did not exit in time")); }, 5_000);
      child.once("exit", (c) => { clearTimeout(timer); resolve(c ?? -1); });
    });
    assert.equal(code, 0, `daemon child exited ${code}; stderr: ${stderr}`);
    // No brick: the instance lock was released by graceful shutdown.
    assert.equal(await instanceAlive(sessiondPaths(dir)), false);
    // Recovery: a fresh start on the same directory succeeds.
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    await handle.shutdown();
  } finally {
    await cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Production cold-open activation cwd resolution (fix/sessiond-activation-cwd)
//
// The production composition derives an open session's cwd/projectRoot from the
// SAME catalog instance backing the sessionCatalog dependency. These tests go
// through the real RPC server + daemon with a recording fake worker factory so
// they exercise the composition path (buildDependencies -> SessiondService ->
// RPC), not just the resolver helper in isolation.
// ---------------------------------------------------------------------------

interface ActivationHarness {
  handle: Awaited<ReturnType<typeof startDaemon>>;
  rpc: SessiondRpcClient;
  workers: FakeWorkerFactory;
  readCalls: () => number;
  dir: string;
}

/** startDaemon with a recording worker, an always-existing locator and an injectable catalog. */
async function activationHarness(options: {
  catalog?: SessionCatalogPort | null;
  readSession?: (sessionId: string) => SessionDetail;
  activationContext?: ActivationContextProvider;
} = {}): Promise<ActivationHarness> {
  const dir = await tempDir();
  let readCalls = 0;
  const defaultCatalog: SessionCatalogPort = {
    async listSessions() { return []; },
    async readSession(sessionId) {
      readCalls += 1;
      return options.readSession
        ? options.readSession(sessionId)
        : { sessionId, cwd: "/real/project", projectRoot: "/real/project", entries: [] };
    },
    async readSessionContext() { return { sessionId: "", entries: [], pageInfo: { hasMore: false } }; },
    async readSessionTree() { return { sessionId: "", roots: [], entryCount: 0 }; },
    async deleteSession() {},
  };
  const locator: SessionLocatorPort = {
    async locate(sessionId) { return { sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, exists: true }; },
    async resolveLeafId() { return "leaf"; },
  };
  const workers = new FakeWorkerFactory({ readyDelayMs: 0 });
  const handle = await startDaemon({
    directory: dir,
    workerFactory: workers,
    sessionLocator: locator,
    sessionCatalog: options.catalog === undefined ? defaultCatalog : options.catalog,
    ...(options.activationContext === undefined ? {} : { activationContext: options.activationContext }),
    serviceOptions: { idleTimeoutMs: 0 },
  });
  return { handle, rpc: client(handle), workers, readCalls: () => readCalls, dir };
}

test("runtime.activate cold-open derives worker cwd/projectRoot from the session catalog", async () => {
  const h = await activationHarness();
  try {
    const result = await h.rpc.call("runtime.activate", { sessionId: "cold" });
    assert.equal(result.cwd, "/real/project");
    assert.equal(result.projectRoot, "/real/project");
    assert.equal(h.workers.starts, 1);
    const started = h.workers.workers[0]!;
    assert.equal(started.input.mode, "open");
    assert.equal(started.input.cwd, "/real/project");
    assert.equal(started.input.projectRoot, "/real/project");
    const init = started.sent.find((message) => message.type === "worker.init");
    assert.equal(init?.type, "worker.init");
    if (init?.type === "worker.init") {
      assert.equal(init.payload.cwd, "/real/project");
      assert.equal(init.payload.projectRoot, "/real/project");
    }
    assert.equal(h.readCalls(), 1, "readSession must be consulted exactly once");
  } finally {
    await h.handle.shutdown();
    await cleanup(h.dir);
  }
});

test("runtime.activate with an explicit cwd overrides the catalog and skips readSession", async () => {
  const h = await activationHarness();
  try {
    const result = await h.rpc.call("runtime.activate", { sessionId: "cold", cwd: "/override" });
    assert.equal(result.cwd, "/override");
    assert.equal(result.projectRoot, "/override");
    assert.equal(h.workers.starts, 1);
    assert.equal(h.workers.workers[0]!.input.cwd, "/override");
    assert.equal(h.workers.workers[0]!.input.projectRoot, "/override");
    assert.equal(h.readCalls(), 0, "explicit cwd must not consult the catalog");
  } finally {
    await h.handle.shutdown();
    await cleanup(h.dir);
  }
});

test("sessionCatalog:null fails activation closed with a fixed error and no worker", async () => {
  const h = await activationHarness({ catalog: null });
  try {
    await assert.rejects(
      h.rpc.call("runtime.activate", { sessionId: "cold-secret" }),
      (error: unknown) => {
        assert.ok(error instanceof SessiondError);
        assert.equal(error.code, "unavailable");
        assert.equal(error.message, "session catalog is unavailable");
        assert.ok(!error.message.includes("cold-secret"), "must not echo the session id");
        assert.ok(!error.message.includes("/"), "must not echo any path");
        return true;
      },
    );
    assert.equal(h.workers.starts, 0, "fail-closed activation must not start a worker");
  } finally {
    await h.handle.shutdown();
    await cleanup(h.dir);
  }
});

test("catalog not_found survives the RPC boundary sanitized and starts no worker", async () => {
  const h = await activationHarness({
    readSession(sessionId) {
      throw makeRuntimeError("not_found", `session not found: ${sessionId}@secret/path`);
    },
  });
  try {
    await assert.rejects(
      h.rpc.call("runtime.activate", { sessionId: "victim-id" }),
      (error: unknown) => {
        assert.ok(error instanceof SessiondError);
        assert.equal(error.code, "not_found", "canonical not_found must survive the boundary");
        assert.equal(error.message, "session not found", "message must be the fixed sanitized canonical message");
        assert.ok(!error.message.includes("victim-id"));
        assert.ok(!error.message.includes("secret"));
        assert.ok(!error.message.includes("/"));
        return true;
      },
    );
    assert.equal(h.workers.starts, 0);
  } finally {
    await h.handle.shutdown();
    await cleanup(h.dir);
  }
});

test("catalog returning a relative/empty/NUL cwd or projectRoot fails activation closed with no echo", async () => {
  const cases = [
    { field: "cwd", value: "rel/path" },
    { field: "cwd", value: "" },
    { field: "cwd", value: "/abs\0path" },
    { field: "projectRoot", value: "relative" },
    { field: "projectRoot", value: "" },
    { field: "projectRoot", value: "/abs\0root" },
  ] as const;
  for (const { field, value } of cases) {
    const h = await activationHarness({
      readSession(sessionId) {
        const detail: SessionDetail = { sessionId, cwd: "/abs", projectRoot: "/abs", entries: [] };
        if (field === "cwd") detail.cwd = value;
        else detail.projectRoot = value;
        return detail;
      },
    });
    try {
      await assert.rejects(
        h.rpc.call("runtime.activate", { sessionId: "cold" }),
        (error: unknown) => {
          assert.ok(error instanceof SessiondError);
          assert.equal(error.code, "internal");
          assert.equal(
            error.message,
            field === "cwd" ? "session catalog returned an invalid cwd" : "session catalog returned an invalid projectRoot",
          );
          if (value !== "") {
            assert.ok(!error.message.includes(value), `must not echo the offending ${field} value`);
          }
          return true;
        },
      );
      assert.equal(h.workers.starts, 0, `invalid ${field} must fail closed with no worker`);
    } finally {
      await h.handle.shutdown();
      await cleanup(h.dir);
    }
  }
});

test("explicit activationContext override wins even when sessionCatalog is null", async () => {
  const h = await activationHarness({
    catalog: null,
    activationContext: { async resolve() { return { cwd: "/override-root", projectRoot: "/override-root" }; } },
  });
  try {
    const result = await h.rpc.call("runtime.activate", { sessionId: "cold" });
    assert.equal(result.cwd, "/override-root");
    assert.equal(result.projectRoot, "/override-root");
    assert.equal(h.workers.starts, 1);
    assert.equal(h.workers.workers[0]!.input.cwd, "/override-root");
    assert.equal(h.readCalls(), 0);
  } finally {
    await h.handle.shutdown();
    await cleanup(h.dir);
  }
});

test("sessions.resolve and runtime.activate share the catalog-derived resolver (resolve is zero-worker)", async () => {
  const h = await activationHarness();
  try {
    const resolved = await h.rpc.call("sessions.resolve", { sessionId: "cold" });
    assert.equal(resolved.sessionId, "cold");
    assert.equal(resolved.sessionFile, "/sessions/cold.jsonl");
    assert.equal(resolved.cwd, "/real/project");
    assert.equal(resolved.projectRoot, "/real/project");
    assert.equal(h.workers.starts, 0, "sessions.resolve must never start a worker");
    assert.equal(h.readCalls(), 1);

    const activated = await h.rpc.call("runtime.activate", { sessionId: "cold" });
    assert.equal(activated.cwd, "/real/project");
    assert.equal(activated.projectRoot, "/real/project");
    assert.equal(h.workers.starts, 1);
    assert.equal(h.workers.workers[0]!.input.cwd, "/real/project");
    assert.equal(h.readCalls(), 2, "one readSession per resolution path");
  } finally {
    await h.handle.shutdown();
    await cleanup(h.dir);
  }
});

// ---------------------------------------------------------------------------
// Production default wiring (WP-2): catalog + locator + catalog-derived
// activation context share ONE Pi SDK session store.
//
// With NO sessionCatalog/sessionLocator overrides, buildDependencies wires the
// shared adapter pair (`createPiSdkSessionPorts`). This test drives that real
// production path end-to-end against a real Pi SDK session seeded into a temp
// PI_CODING_AGENT_DIR: sessions.resolve (locate) then runtime.activate
// (catalog-derived context) both resolve from the shared store, and the worker
// opens with the cwd recorded in the session catalog.
// ---------------------------------------------------------------------------

test("default wiring uses the shared Pi SDK session pair end-to-end (real SDK)", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "sessiond-agent-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const dir = await tempDir();
  try {
    const cwd = join(agentDir, "workspace");
    await mkdir(cwd, { recursive: true });
    const { sessionId } = seedSessionForTests({ cwd });
    const workers = new FakeWorkerFactory({ readyDelayMs: 0 });
    // No sessionCatalog/sessionLocator overrides → the production default pair.
    const handle = await startDaemon({ directory: dir, workerFactory: workers, serviceOptions: { idleTimeoutMs: 0 } });
    const rpc = client(handle);
    try {
      const resolved = await rpc.call("sessions.resolve", { sessionId });
      assert.equal(resolved.sessionId, sessionId);
      assert.equal(resolved.cwd, cwd);
      assert.equal(resolved.projectRoot, cwd);
      assert.ok(typeof resolved.sessionFile === "string" && resolved.sessionFile.endsWith(".jsonl"));
      assert.equal(workers.starts, 0, "sessions.resolve is zero-worker");

      const activated = await rpc.call("runtime.activate", { sessionId });
      assert.equal(activated.cwd, cwd);
      assert.equal(activated.projectRoot, cwd);
      assert.equal(workers.workers[0]?.input.cwd, cwd);
      assert.equal(workers.workers[0]?.input.projectRoot, cwd);
    } finally {
      await handle.shutdown();
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await cleanup(dir);
    await rm(agentDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// D4 session-rename production wiring: the daemon's default catalog + locator +
// mutation come from ONE createPiSdkSessionPorts() result, so a real JSONL
// offline rename is immediately visible to list/read with zero Workers and
// unchanged identity/history/context; sessionMutation:null fails closed.
// ---------------------------------------------------------------------------

test("daemon real default adapter: JSONL offline rename, zero workers, same path/id/history/context, immediate read/list", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "sessiond-rename-agent-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const dir = await tempDir();
  try {
    const cwd = join(agentDir, "workspace");
    await mkdir(cwd, { recursive: true });
    const { sessionId } = seedSessionForTests({ cwd });
    const workers = new FakeWorkerFactory({ readyDelayMs: 0 });
    const handle = await startDaemon({ directory: dir, workerFactory: workers, serviceOptions: { idleTimeoutMs: 0 } });
    const rpc = client(handle);
    try {
      const before = await rpc.call("sessions.read", { sessionId });
      assert.equal(before.sessionId, sessionId);
      const sessionFile = before.sessionFile;
      assert.ok(typeof sessionFile === "string" && sessionFile.endsWith(".jsonl"));

      const renamed = await rpc.call("sessions.rename", { sessionId, name: "  Canonical Renamed  " });
      assert.deepEqual(renamed, { sessionId, name: "Canonical Renamed" }, "the RPC returns the canonical trimmed name");

      // Zero Workers: offline rename is a pure JSONL append.
      assert.deepEqual((await rpc.call("runtime.listRunning", {})).sessions, []);
      assert.equal(workers.starts, 0);

      // Same path / id / history / context; title reflects the rename immediately.
      const after = await rpc.call("sessions.read", { sessionId });
      assert.equal(after.sessionId, sessionId, "session id is unchanged");
      assert.equal(after.sessionFile, sessionFile, "the session file path is unchanged");
      assert.equal(after.title, "Canonical Renamed", "read observes the new title immediately");
      const context = await rpc.call("sessions.context", { sessionId });
      assert.equal(context.sessionId, sessionId);
      assert.ok(context.entries.length >= 2, "history is preserved");
      const list = await rpc.call("sessions.list", {});
      const item = list.sessions.find((s: { sessionId: string }) => s.sessionId === sessionId);
      assert.equal(item?.title, "Canonical Renamed", "list observes the new title immediately");

      // The JSONL file really carries the appended session_info (title source of truth).
      const raw = await readFile(sessionFile, "utf8");
      assert.ok(raw.includes("Canonical Renamed"), "the JSONL must contain the appended session_info title");
    } finally {
      await handle.shutdown();
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await cleanup(dir);
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("daemon sessionMutation:null disables offline rename fail-closed with fixed unavailable", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "sessiond-nullmut-agent-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const dir = await tempDir();
  try {
    const cwd = join(agentDir, "workspace");
    await mkdir(cwd, { recursive: true });
    const { sessionId } = seedSessionForTests({ cwd });
    const workers = new FakeWorkerFactory({ readyDelayMs: 0 });
    const handle = await startDaemon({ directory: dir, workerFactory: workers, sessionMutation: null, serviceOptions: { idleTimeoutMs: 0 } });
    const rpc = client(handle);
    try {
      await assert.rejects(
        rpc.call("sessions.rename", { sessionId, name: "Nope" }),
        (error: unknown) => {
          assert.ok(error instanceof SessiondError);
          assert.equal(error.code, "unavailable");
          assert.equal(error.message, "session mutation is unavailable");
          assert.ok(!String(error.message).includes(sessionId), "no raw id may echo");
          return true;
        },
      );
      // Nothing changed: the title stays undefined and zero workers ran.
      const after = await rpc.call("sessions.read", { sessionId });
      assert.equal(after.title, undefined);
      assert.equal(workers.starts, 0);
      assert.deepEqual((await rpc.call("runtime.listRunning", {})).sessions, []);
    } finally {
      await handle.shutdown();
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await cleanup(dir);
    await rm(agentDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PR#3 manual-port diagnostics: `DaemonHandle.diagnostics` is an @internal
// in-process surface that delegates the live service. Handle-only — never a
// Protocol DTO, RPC method, hello field, Host /health, CLI JSON, or capability.
// ---------------------------------------------------------------------------

test("daemon.diagnostics exposes authoritative worker PIDs and bounded counts (delegates live service)", async () => {
  const dir = await tempDir();
  try {
    const workers = new FakeWorkerFactory({ readyDelayMs: 0 });
    const handle = await startDaemon({ directory: dir, workerFactory: workers, serviceOptions: { idleTimeoutMs: 0 } });
    const rpc = client(handle);
    try {
      // Empty before any worker.
      assert.deepEqual(handle.diagnostics.workerPids(), []);
      const snap0 = handle.diagnostics.snapshot();
      assert.equal(snap0.sessions, 0);
      assert.equal(Object.values(snap0.workersByStatus).reduce((a, b) => a + b, 0), 0);

      const created = await rpc.call("runtime.create", { createRequestId: "diag-cr", cwd: "/p", projectRoot: "/p" });
      const sessionId = created.sessionId as string;
      // Worker spawned: authoritative child pid reported.
      const pids = handle.diagnostics.workerPids();
      assert.equal(pids.length, 1);
      assert.ok(Number.isSafeInteger(pids[0]!) && pids[0]! > 0);
      const snap1 = handle.diagnostics.snapshot();
      assert.equal(snap1.sessions, 1);
      assert.equal(snap1.workersByStatus.ready, 1);
      // No identifiers or PIDs in the stringified snapshot.
      const json = JSON.stringify(snap1);
      assert.ok(!json.includes(sessionId), "session id must not leak into snapshot");
      assert.ok(!json.includes("/p"), "paths must not leak into snapshot");
      assert.ok(!/pid/i.test(json), "snapshot must not carry PIDs");

      // Exact cleanup: stop removes the record and pid.
      await rpc.call("runtime.stop", { sessionId });
      assert.deepEqual(handle.diagnostics.workerPids(), []);
      assert.equal(handle.diagnostics.snapshot().sessions, 0);
    } finally {
      await handle.shutdown();
    }
  } finally {
    await cleanup(dir);
  }
});

test("daemon.diagnostics is handle-only: no RPC/hello gains, and shutdown leaves no leak", async () => {
  const dir = await tempDir();
  try {
    const workers = new FakeWorkerFactory({ readyDelayMs: 0 });
    const handle = await startDaemon({ directory: dir, workerFactory: workers, serviceOptions: { idleTimeoutMs: 0 } });
    const rpc = client(handle);
    try {
      await rpc.call("runtime.create", { createRequestId: "diag-cr2", cwd: "/p", projectRoot: "/p" });
      assert.equal(handle.diagnostics.workerPids().length, 1);
      // No diagnostics/PID method on the public RPC surface.
      assert.ok(!SESSIOND_RPC_METHODS.some((m) => /diagnostic|pid/i.test(m)));
      // system.hello carries no diagnostics/pid fields.
      const hello = await rpc.call("system.hello", {});
      const helloJson = JSON.stringify(hello);
      assert.ok(!/diagnostic|pid/i.test(helloJson), `hello leaked a diagnostics surface: ${helloJson}`);
    } finally {
      await handle.shutdown();
    }
    // After shutdown: no workers, no leaked records; the handle surface stays callable.
    assert.deepEqual(handle.diagnostics.workerPids(), []);
    assert.equal(handle.diagnostics.snapshot().sessions, 0);
  } finally {
    await cleanup(dir);
  }
});
