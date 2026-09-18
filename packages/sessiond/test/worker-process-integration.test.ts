/**
 * Real R1 worker-main integration via ProductionWorkerProcessFactory.
 * Uses the agent-worker package export + PIX_AGENT_WORKER_FACTORY fixture
 * (no network). Production SDK composition is construct-only smoke.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PROTOCOL_VERSION, SESSIOND_BUILD_IDENTITY } from "@fffattiger/pix-protocol";
import {
  ProductionWorkerProcessFactory,
  createProductionWorkerProcessFactory,
  resolveWorkerMainPath,
} from "../src/composition/worker-process.js";
import type { WorkerExit, WorkerStartInput } from "../src/worker.js";
import type { WorkerToSessiondMessage } from "@fffattiger/pix-protocol";

const here = dirname(fileURLToPath(import.meta.url));
/** Climb to the sessiond package root from either src or dist-test paths. */
function findSessiondRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    const manifest = resolve(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const name = JSON.parse(readFileSync(manifest, "utf8")).name as string | undefined;
        if (name === "@fffattiger/pix-sessiond") return dir;
      } catch {
        // keep climbing
      }
    }
    dir = resolve(dir, "..");
  }
  return resolve(start, "..");
}
const sessiondRoot = findSessiondRoot(here);
const workspaceRoot = resolve(sessiondRoot, "..", "..");
// agent-worker test fixture (network-free factory for worker-main).
const agentWorkerFixture = resolve(
  workspaceRoot,
  "packages/agent-worker/test/fixtures/child-worker-factory.mjs",
);

const startInput: WorkerStartInput = {
  mode: "create",
  activationId: "act-r1",
  sessionId: "sess-provisional",
  cwd: "/tmp/r2-project",
  projectRoot: "/tmp/r2-project",
};

function onceMessage(
  connection: { subscribe: (l: (m: WorkerToSessiondMessage) => void) => () => void },
  predicate: (m: WorkerToSessiondMessage) => boolean,
  timeoutMs = 8_000,
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
  timeoutMs = 8_000,
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

test("resolveWorkerMainPath is cwd-independent absolute dist path", () => {
  const path = resolveWorkerMainPath();
  assert.equal(existsSync(path), true);
  assert.match(path, /worker-main\.js$/);
  assert.equal(path.includes("pix-agent-worker") || path.includes("agent-worker"), true);
});

test("production factory constructs without spawning (SDK composition smoke)", () => {
  // Must not touch the network: only construct the factory that would spawn
  // the real worker-main with PIX_AGENT_BACKEND=sdk.
  const factory = createProductionWorkerProcessFactory();
  assert.ok(factory instanceof ProductionWorkerProcessFactory);
});

test("real worker-main: init → ready (rekey), snapshot, stdin EOF exits", async (t) => {
  if (!existsSync(agentWorkerFixture)) {
    return t.skip(`agent-worker fixture missing: ${agentWorkerFixture}`);
  }
  let workerMain: string;
  try {
    workerMain = resolveWorkerMainPath();
  } catch (error) {
    return t.skip(`worker-main not built: ${error instanceof Error ? error.message : error}`);
  }

  const factory = new ProductionWorkerProcessFactory({
    workerMainPath: workerMain,
    workerFactoryModulePath: agentWorkerFixture,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
    },
    stdinEndMs: 2_000,
    sigtermMs: 1_000,
    sigkillMs: 1_000,
    // Neutral cwd distinct from project path — worker.init carries the real cwd.
    spawnCwd: resolve(here, ".."),
  });

  const connection = await factory.start(startInput);
  assert.ok(connection.pid && connection.pid > 0);

  const messages: WorkerToSessiondMessage[] = [];
  connection.subscribe((m) => messages.push(m));
  const readyPromise = onceMessage(connection, (m) => m.type === "worker.ready");

  await connection.send({
    type: "worker.init",
    id: "init:act-r1",
    protocolVersion: PROTOCOL_VERSION,
    payload: {
      mode: "create",
      sessionId: "sess-provisional",
      epoch: "epoch-integration-1",
      cwd: "/tmp/r2-project",
      projectRoot: "/tmp/r2-project",
      build: SESSIOND_BUILD_IDENTITY,
    },
  });

  const ready = await readyPromise;
  assert.equal(ready.type, "worker.ready");
  if (ready.type === "worker.ready") {
    // Fixture create() returns sess-created-real (rekey path).
    assert.equal(ready.payload.sessionId, "sess-created-real");
    assert.equal(ready.payload.workerStatus, "ready");
  }

  // Optional sessionDiscovered may arrive before ready.
  const discovered = messages.find((m) => m.type === "worker.sessionDiscovered");
  if (discovered && discovered.type === "worker.sessionDiscovered") {
    assert.equal(discovered.payload.sessionId, "sess-created-real");
  }

  // Snapshot round-trip.
  const snapPromise = onceMessage(connection, (m) => m.type === "worker.snapshot");
  await connection.send({
    type: "worker.getSnapshot",
    id: "snap:1",
    protocolVersion: PROTOCOL_VERSION,
    payload: { sessionId: "sess-created-real" },
  });
  const snap = await snapPromise;
  assert.equal(snap.type, "worker.snapshot");

  // stdin EOF (via close) must let R1 worker exit cleanly.
  const exitPromise = onceExit(connection);
  await connection.close();
  const exit = await exitPromise;
  // Graceful EOF → exit 0 (or signal-less code 0).
  assert.ok(
    exit.code === 0 || exit.code === undefined || exit.signal === "SIGTERM",
    `unexpected exit: ${JSON.stringify(exit)}`,
  );
});

test("real worker-main: prompt stream with no-network fixture", async (t) => {
  if (!existsSync(agentWorkerFixture)) {
    return t.skip(`agent-worker fixture missing: ${agentWorkerFixture}`);
  }
  let workerMain: string;
  try {
    workerMain = resolveWorkerMainPath();
  } catch (error) {
    return t.skip(`worker-main not built: ${error instanceof Error ? error.message : error}`);
  }

  const factory = new ProductionWorkerProcessFactory({
    workerMainPath: workerMain,
    workerFactoryModulePath: agentWorkerFixture,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    stdinEndMs: 2_000,
    sigtermMs: 1_000,
    sigkillMs: 1_000,
  });

  const connection = await factory.start({
    ...startInput,
    sessionId: "sess-prompt",
    activationId: "act-prompt",
  });

  const inbox: WorkerToSessiondMessage[] = [];
  connection.subscribe((m) => inbox.push(m));
  const exitPromise = onceExit(connection);

  const waitFor = (pred: (m: WorkerToSessiondMessage) => boolean, ms = 5_000) =>
    new Promise<WorkerToSessiondMessage>((resolvePromise, reject) => {
      const start = Date.now();
      const tick = () => {
        const hit = inbox.find(pred);
        if (hit) {
          resolvePromise(hit);
          return;
        }
        if (Date.now() - start > ms) {
          reject(new Error(`timeout; saw=${inbox.map((m) => m.type).join(",")}`));
          return;
        }
        setTimeout(tick, 15);
      };
      tick();
    });

  await connection.send({
    type: "worker.init",
    id: "init:act-prompt",
    protocolVersion: PROTOCOL_VERSION,
    payload: {
      mode: "create",
      sessionId: "sess-prompt",
      epoch: "epoch-integration-prompt",
      cwd: "/tmp/r2-project",
      projectRoot: "/tmp/r2-project",
      build: SESSIOND_BUILD_IDENTITY,
    },
  });
  await waitFor((m) => m.type === "worker.ready");

  await connection.send({
    type: "worker.command",
    id: "cmd:1",
    protocolVersion: PROTOCOL_VERSION,
    payload: {
      sessionId: "sess-created-real",
      epoch: "epoch-integration-prompt",
      command: {
        type: "prompt",
        commandId: "browser-cmd-1",
        message: "hello",
      },
    },
  });

  const result = await waitFor((m) => m.type === "worker.commandResult");
  assert.equal(result.type, "worker.commandResult");
  if (result.type === "worker.commandResult") {
    assert.equal(result.payload.result.commandId, "browser-cmd-1");
    assert.equal(result.payload.result.result.ok, true);
  }
  const events = inbox
    .filter((m): m is Extract<WorkerToSessiondMessage, { type: "worker.event" }> => m.type === "worker.event")
    .map((m) => m.payload.event.type);
  assert.ok(events.includes("agent_start") || events.includes("prompt_done"));

  await connection.close();
  await exitPromise.catch(() => {});
});
