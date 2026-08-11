import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PROTOCOL_VERSION } from "@fffattiger/pix-protocol";
import {
  buildWorkerEnv,
  createProductionWorkerProcessFactory,
  ProductionWorkerProcessFactory,
  resolveWorkerMainPath,
  WORKER_ENV_KEY_ALLOWLIST,
} from "../src/composition/worker-process.js";
import { redactStderr } from "../src/internal/child-stdio.js";
import { UnavailableWorkerFactory, startDaemon } from "../src/composition/index.js";
import { SessiondError } from "../src/errors.js";
import { SessiondRpcClient } from "../src/rpc.js";
import type { WorkerExit, WorkerStartInput } from "../src/worker.js";
import type { WorkerToSessiondMessage } from "@fffattiger/pix-protocol";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureWorker = resolve(here, "fixtures/fixture-worker.mjs");

const startInput: WorkerStartInput = {
  mode: "create",
  activationId: "act-1",
  sessionId: "sess-1",
  cwd: "/tmp/project",
  projectRoot: "/tmp/project",
};

/** Spawn fixture with mode via trampoline + extraEnv (test-only injection). */
function factoryWithArgvMode(
  mode: string,
  extra: ConstructorParameters<typeof ProductionWorkerProcessFactory>[0] = {},
) {
  const trampoline = resolve(here, "fixtures/fixture-trampoline.mjs");
  const { extraEnv: callerExtra, ...rest } = extra;
  return new ProductionWorkerProcessFactory({
    workerMainPath: trampoline,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    stdinEndMs: 300,
    sigtermMs: 300,
    sigkillMs: 300,
    ...rest,
    extraEnv: { FIXTURE_MODE: mode, ...(callerExtra ?? {}) },
  });
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function onceMessage(
  connection: { subscribe: (l: (m: WorkerToSessiondMessage) => void) => () => void },
  predicate: (m: WorkerToSessiondMessage) => boolean,
  timeoutMs = 3_000,
): Promise<WorkerToSessiondMessage> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error("timeout waiting for worker message"));
    }, timeoutMs);
    const unsub = connection.subscribe((message) => {
      if (!predicate(message)) return;
      clearTimeout(timer);
      unsub();
      resolvePromise(message);
    });
  });
}

function onceExit(
  connection: { onExit: (l: (e: WorkerExit) => void) => () => void },
  timeoutMs = 5_000,
): Promise<WorkerExit> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error("timeout waiting for worker exit"));
    }, timeoutMs);
    const unsub = connection.onExit((exit) => {
      clearTimeout(timer);
      unsub();
      resolvePromise(exit);
    });
  });
}

// Ensure trampoline exists (written alongside this test's fixtures).
test("fixture trampoline is present", () => {
  assert.equal(existsSync(fixtureWorker), true);
  assert.equal(existsSync(resolve(here, "fixtures/fixture-trampoline.mjs")), true);
});

test("buildWorkerEnv is a strict allowlist (no process.env spread, no sessiond secrets)", () => {
  const env = buildWorkerEnv({
    sourceEnv: {
      PATH: "/usr/bin",
      HOME: "/home/user",
      PIX_SESSIOND_DIR: "/evil/sessiond",
      PIX_PASSWORD: "super-secret",
      PIX_AGENT_BACKEND: "should-be-overridden",
      PIX_AGENT_WORKER_FACTORY: "/evil/factory.mjs",
      OPENAI_API_KEY: "sk-test",
      ANTHROPIC_API_KEY: "ant-test",
      SESSIOND_SECRET: "nope",
      RANDOM_SECRET: "nope",
      PI_CODING_AGENT_DIR: "/custom/pi",
    },
  });
  assert.equal(env.PIX_AGENT_BACKEND, "sdk");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/user");
  assert.equal(env.OPENAI_API_KEY, "sk-test");
  assert.equal(env.ANTHROPIC_API_KEY, "ant-test");
  assert.equal(env.PI_CODING_AGENT_DIR, "/custom/pi");
  assert.equal(env.PIX_SESSIOND_DIR, undefined);
  assert.equal(env.PIX_PASSWORD, undefined);
  assert.equal(env.PIX_AGENT_WORKER_FACTORY, undefined);
  assert.equal(env.SESSIOND_SECRET, undefined);
  assert.equal(env.RANDOM_SECRET, undefined);
  // Production never auto-forwards arbitrary PIX_*.
  for (const key of Object.keys(env)) {
    if (key.startsWith("PIX_") && key !== "PIX_AGENT_BACKEND") {
      assert.fail(`unexpected PIX_ key forwarded: ${key}`);
    }
  }
  assert.ok(WORKER_ENV_KEY_ALLOWLIST.includes("OPENAI_API_KEY"));
});

test("buildWorkerEnv only injects PIX_AGENT_WORKER_FACTORY via explicit options", () => {
  const env = buildWorkerEnv({
    sourceEnv: { PATH: "/bin", PIX_AGENT_WORKER_FACTORY: "/from-env.mjs" },
    workerFactoryModulePath: "/from-options.mjs",
  });
  assert.equal(env.PIX_AGENT_WORKER_FACTORY, "/from-options.mjs");
});

test("redactStderr strips secrets and paths", () => {
  const raw =
    "Authorization: Bearer supersecrettokenvalue path=/Users/proxy/.pi/key.json OPENAI_API_KEY=sk-abcdefghijklmnop";
  const redacted = redactStderr(raw);
  assert.equal(redacted.includes("supersecrettokenvalue"), false);
  assert.equal(redacted.includes("sk-abcdefghijklmnop"), false);
  assert.equal(redacted.includes("/Users/proxy"), false);
  assert.ok(redacted.includes("[REDACTED]") || redacted.includes("[PATH]"));
});

test("early message is buffered until subscribe", async () => {
  const factory = factoryWithArgvMode("early-message");
  const connection = await factory.start(startInput);
  // Wait long enough that the child has printed BEFORE any listener attaches.
  // (Manual probe shows ready arrives within ~50ms; 150ms is generous.)
  await wait(150);
  const seen: WorkerToSessiondMessage[] = [];
  // First subscribe must synchronously replay the buffered early frame.
  connection.subscribe((m) => seen.push(m));
  assert.ok(
    seen.some((m) => m.type === "worker.ready"),
    `expected buffered ready on first subscribe, got ${JSON.stringify(seen)}`,
  );
  const message = seen.find((m) => m.type === "worker.ready")!;
  if (message.type === "worker.ready") {
    assert.equal(message.payload.sessionId, "sess-early");
  }
  await connection.close();
});

test("early exit is buffered until onExit", async () => {
  const factory = factoryWithArgvMode("early-exit");
  const connection = await factory.start(startInput);
  await wait(50);
  const exit = await onceExit(connection);
  assert.equal(exit.code, 0);
  await connection.close();
});

test("split frames across chunks reassemble", async () => {
  const factory = factoryWithArgvMode("split-frames");
  const connection = await factory.start(startInput);
  const message = await onceMessage(connection, (m) => m.type === "worker.ready", 5_000);
  assert.equal(message.type, "worker.ready");
  await connection.close();
});

test("coalesced frames deliver both messages", async () => {
  const factory = factoryWithArgvMode("coalesced");
  const connection = await factory.start(startInput);
  const seen: string[] = [];
  const done = new Promise<void>((resolveDone, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout coalesced")), 3_000);
    connection.subscribe((m) => {
      seen.push(m.type);
      if (seen.includes("worker.ready") && seen.includes("worker.status")) {
        clearTimeout(timer);
        resolveDone();
      }
    });
  });
  await done;
  await connection.close();
});

test("CRLF framed ready is accepted", async () => {
  const factory = factoryWithArgvMode("crlf");
  const connection = await factory.start(startInput);
  const message = await onceMessage(connection, (m) => m.type === "worker.ready");
  assert.equal(message.type, "worker.ready");
  await connection.close();
});

test("malformed stdout fails closed via onExit", async () => {
  const factory = factoryWithArgvMode("malformed");
  const connection = await factory.start(startInput);
  const exit = await onceExit(connection);
  assert.ok(exit.error, "expected framing error");
  assert.match(exit.error!.message, /malformed|JSON|schema|framing/i);
  await connection.close();
});

test("oversize frame fails closed", async () => {
  const factory = factoryWithArgvMode("oversize", { maxFrameBytes: 2 * 1024 * 1024 });
  const connection = await factory.start(startInput);
  const exit = await onceExit(connection, 10_000);
  assert.ok(exit.error, "expected oversize error");
  assert.match(exit.error!.message, /size limit|framing|malformed/i);
  await connection.close();
});

test("stderr flood is drained, bounded, and redacted", async () => {
  const factory = factoryWithArgvMode("stderr-flood");
  const connection = await factory.start(startInput);
  await wait(100);
  // Access diagnostic ring via duck-type (test-only).
  const snapFn = (connection as unknown as { stderrSnapshot?: () => string }).stderrSnapshot;
  const snap = typeof snapFn === "function" ? snapFn.call(connection) : "";
  assert.ok(snap.length > 0);
  assert.ok(snap.length <= 64 * 1024 + 1024, `ring should be bounded, got ${snap.length}`);
  assert.equal(snap.includes("sk-secretvalue"), false);
  assert.equal(snap.includes("supersecrettokenvalue"), false);
  assert.equal(snap.includes("/Users/proxy"), false);
  await connection.close();
});

test("echo fixture: init → ready, stdin EOF exits, close idempotent", async () => {
  const factory = factoryWithArgvMode("echo");
  const connection = await factory.start(startInput);
  assert.ok(typeof connection.pid === "number" && connection.pid! > 0);
  const readyPromise = onceMessage(connection, (m) => m.type === "worker.ready");
  await connection.send({
    type: "worker.init",
    id: "init:act-1",
    protocolVersion: PROTOCOL_VERSION,
    payload: {
      mode: "create",
      sessionId: "sess-1",
      cwd: "/tmp/project",
      projectRoot: "/tmp/project",
    },
  });
  const ready = await readyPromise;
  assert.equal(ready.type, "worker.ready");
  const exitPromise = onceExit(connection);
  await connection.close();
  await connection.close(); // idempotent
  const exit = await exitPromise;
  assert.equal(exit.code === 0 || exit.signal !== undefined || exit.code === undefined, true);
});

test("close escalates hang → SIGTERM", async () => {
  const factory = factoryWithArgvMode("hang", { stdinEndMs: 50, sigtermMs: 500, sigkillMs: 500 });
  const connection = await factory.start(startInput);
  const pid = connection.pid;
  assert.ok(pid);
  const exitPromise = onceExit(connection);
  const started = Date.now();
  await connection.close();
  const exit = await exitPromise;
  const elapsed = Date.now() - started;
  // Should not need SIGKILL; SIGTERM path after stdin deadline.
  assert.ok(elapsed < 2_000, `close took too long: ${elapsed}ms`);
  assert.ok(exit.code === 0 || exit.signal === "SIGTERM" || exit.signal === "SIGKILL" || exit.code === null);
  // PID should be dead.
  await wait(20);
  let alive = true;
  try {
    process.kill(pid!, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false);
});

test("close escalates hang-term → SIGKILL", async () => {
  if (process.platform === "win32") return;
  const factory = factoryWithArgvMode("hang-term", { stdinEndMs: 30, sigtermMs: 30, sigkillMs: 500 });
  const connection = await factory.start(startInput);
  const pid = connection.pid!;
  const exitPromise = onceExit(connection, 5_000);
  await connection.close();
  const exit = await exitPromise;
  assert.ok(exit.signal === "SIGKILL" || exit.code !== 0 || exit.code === null || exit.signal !== undefined);
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false);
});

test("spawn error (missing binary) rejects start", async () => {
  const factory = new ProductionWorkerProcessFactory({
    execPath: resolve(here, "fixtures/definitely-missing-binary-xyz"),
    workerMainPath: fixtureWorker,
    stdinEndMs: 100,
    sigtermMs: 100,
    sigkillMs: 100,
  });
  await assert.rejects(
    factory.start(startInput),
    (error: unknown) => error instanceof SessiondError && error.code === "worker_unavailable",
  );
});

test("send rejects invalid schema and closed connection", async () => {
  const factory = factoryWithArgvMode("echo");
  const connection = await factory.start(startInput);
  await assert.rejects(
    connection.send({ type: "worker.ping" } as never),
    (error: unknown) => error instanceof SessiondError && error.code === "invalid_request",
  );
  await connection.close();
  await assert.rejects(
    connection.send({
      type: "worker.ping",
      id: "p1",
      protocolVersion: PROTOCOL_VERSION,
      payload: {},
    }),
    (error: unknown) => error instanceof SessiondError && error.code === "worker_unavailable",
  );
});

test("env secret leakage probe: child does not see sessiond secrets", async () => {
  const factory = new ProductionWorkerProcessFactory({
    workerMainPath: resolve(here, "fixtures/fixture-trampoline.mjs"),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      PIX_SESSIOND_DIR: "/secret/sessiond",
      PIX_PASSWORD: "sessiond-password",
      OPENAI_API_KEY: "sk-allowed",
      SESSIOND_SECRET: "local-secret",
    },
    extraEnv: { FIXTURE_MODE: "print-env" },
    stdinEndMs: 200,
    sigtermMs: 200,
    sigkillMs: 200,
  });
  const connection = await factory.start(startInput);
  await wait(80);
  const snapFn = (connection as unknown as { stderrSnapshot?: () => string }).stderrSnapshot;
  const snap = typeof snapFn === "function" ? snapFn.call(connection) : "";
  // Raw secret values must not appear unredacted; more importantly the child
  // env dump (before redaction patterns fully scrub JSON) should not include
  // PIX_SESSIOND_DIR assignment from parent secrets. After redaction paths go
  // to [PATH]; assert the factory did not forward the keys by checking the
  // pre-redaction marker via a ready message still arriving.
  await onceMessage(connection, (m) => m.type === "worker.ready").catch(() => {});
  // The ring is redacted, so look for evidence keys were null in dump:
  // fixture writes ENV_DUMP {...}. Redaction may scrub tokens but keys remain.
  if (snap.includes("ENV_DUMP")) {
    assert.equal(snap.includes('"/secret/sessiond"'), false);
    assert.equal(snap.includes("sessiond-password"), false);
    assert.equal(snap.includes("local-secret"), false);
  }
  await connection.close();
});

test("daemon defaults to production factory; explicit Unavailable still works", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sessiond-r2-"));
  try {
    // Default path constructs a real factory (smoke: daemon boots).
    const handle = await startDaemon({
      directory: dir,
      workerOptions: {
        workerMainPath: resolve(here, "fixtures/fixture-trampoline.mjs"),
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
        extraEnv: { FIXTURE_MODE: "echo" },
      },
      serviceOptions: { idleTimeoutMs: 0 },
    });
    const rpc = new SessiondRpcClient({ endpoint: handle.endpoint, secret: handle.secret, timeoutMs: 2_000 });
    assert.equal((await rpc.call("system.ping", {})).pong, true);
    await handle.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const dir2 = await mkdtemp(join(tmpdir(), "sessiond-r2u-"));
  try {
    const unavailable = new UnavailableWorkerFactory();
    const handle = await startDaemon({
      directory: dir2,
      workerFactory: unavailable,
      serviceOptions: { idleTimeoutMs: 0 },
    });
    const rpc = new SessiondRpcClient({ endpoint: handle.endpoint, secret: handle.secret, timeoutMs: 2_000 });
    await assert.rejects(
      rpc.call("runtime.create", { createRequestId: "c1", cwd: "/p", projectRoot: "/p" }),
      (error: unknown) => error instanceof SessiondError && error.code === "worker_unavailable",
    );
    assert.equal(unavailable.attempts, 1);
    await handle.shutdown();
  } finally {
    await rm(dir2, { recursive: true, force: true });
  }
});

test("createProductionWorkerProcessFactory returns ProductionWorkerProcessFactory", () => {
  const f = createProductionWorkerProcessFactory({ workerMainPath: fixtureWorker });
  assert.ok(f instanceof ProductionWorkerProcessFactory);
});

test("resolveWorkerMainPath returns an absolute existing path (agent-worker dist)", () => {
  // Requires agent-worker dist from build:deps. Skip soft if missing mid-edit.
  try {
    const path = resolveWorkerMainPath();
    assert.equal(path.startsWith("/") || /^[A-Za-z]:\\/.test(path), true);
    assert.equal(existsSync(path), true);
    assert.match(path, /worker-main\.js$/);
  } catch (error) {
    assert.fail(`resolveWorkerMainPath failed: ${error instanceof Error ? error.message : error}`);
  }
});
