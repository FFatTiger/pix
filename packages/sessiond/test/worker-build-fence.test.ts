import assert from "node:assert/strict";
import test from "node:test";
import type { SessionCatalogPort, SessionLocatorPort } from "@fffattiger/pix-runtime-core";
import {
  SESSIOND_BUILD_IDENTITY,
  WORKER_BUILD_IDENTITY,
  type WorkerBuild,
} from "@fffattiger/pix-protocol";
import { SessiondService } from "../src/service.js";
import { FakeWorkerFactory } from "../src/testing/fake-worker.js";

/**
 * Phase 7A Worker build fence: sessiond validates the EXACT expected Worker
 * build contract on `worker.ready` BEFORE it advertises or dispatches anything
 * on the Worker. Unknown/older/malformed builds fail the startup closed with
 * bounded cleanup; a late ready frame with a bad build is dropped, never
 * projected. Existing read/submit/identity fencing is preserved (the fence
 * runs before rekey/projection priming, which still apply afterwards).
 */

function harness(options: {
  worker?: ConstructorParameters<typeof FakeWorkerFactory>[0];
  service?: ConstructorParameters<typeof SessiondService>[1];
} = {}) {
  const locator: SessionLocatorPort = {
    async locate(sessionId) { return { sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, exists: true }; },
    async resolveLeafId() { return "leaf"; },
  };
  const catalog: SessionCatalogPort = {
    async listSessions() { return []; },
    async readSession(sessionId) { return { sessionId, cwd: "/workspace", projectRoot: "/workspace", entries: [] }; },
    async readSessionContext(sessionId) { return { sessionId, entries: [], pageInfo: { hasMore: false } }; },
    async readSessionThinking(sessionId, entryId) { throw { code: "not_found" as const, message: `session not found: ${sessionId}/${entryId}`, retryable: false }; },
    async readSessionTree(sessionId) { return { sessionId, roots: [], entryCount: 0 }; },
    async deleteSession() {},
  };
  const workers = new FakeWorkerFactory(options.worker);
  const service = new SessiondService({
    sessionLocator: locator,
    activationContext: { async resolve(sessionId) { return { cwd: `/cwd/${sessionId}`, projectRoot: `/cwd/${sessionId}` }; } },
    workerFactory: workers,
    sessionCatalog: catalog,
  }, { workerStartTimeoutMs: 500, commandTimeoutMs: 500, idleTimeoutMs: 0, ...options.service });
  return { service, workers };
}

const REJECTION = /build contract rejected/;

test("worker.ready with the exact expected build activates and worker.init carries the sessiond build identity", async () => {
  const { service, workers } = harness();
  const activated = await service.activate("fence-exact");
  assert.equal(activated.workerStatus, "ready");
  const worker = workers.workers[0]!;
  assert.equal(worker.lastInitBuild, SESSIOND_BUILD_IDENTITY);
  await service.shutdown();
});

test("worker.ready without a build block fails the startup closed (missing_build) with bounded cleanup", async () => {
  // `readyBuild: null` instructs the fake to emit the ready frame with NO
  // build block at all — a pre-fence Worker dist.
  const { service, workers } = harness({ worker: { readyBuild: null } });
  await assert.rejects(
    service.activate("fence-missing"),
    (error) => error instanceof Error && /build contract rejected \(missing_build\)/.test(error.message),
  );
  assert.equal(workers.starts, 1);
  // Bounded cleanup: the record is gone and nothing is advertised — no
  // half-admitted session remains over the rejected Worker.
  assert.equal((await service.listRunning()).sessions.length, 0);
  await service.shutdown();
});

test("worker.ready with an unknown/older Worker contract generation fails closed (worker_contract)", async () => {
  const stale: WorkerBuild = { ...WORKER_BUILD_IDENTITY, workerContract: WORKER_BUILD_IDENTITY.workerContract + 1 };
  const { service, workers } = harness({ worker: { readyBuild: stale } });
  await assert.rejects(
    service.activate("fence-stale-contract"),
    (error) => error instanceof Error && /build contract rejected \(worker_contract\)/.test(error.message),
  );
  assert.equal((await service.listRunning()).sessions.length, 0);
  await service.shutdown();
});

test("worker.ready with an unknown adapter contract generation fails closed (adapter_contract)", async () => {
  const stale: WorkerBuild = { ...WORKER_BUILD_IDENTITY, adapterContract: WORKER_BUILD_IDENTITY.adapterContract + 1 };
  const { service } = harness({ worker: { readyBuild: stale } });
  await assert.rejects(
    service.activate("fence-stale-adapter"),
    (error) => error instanceof Error && /build contract rejected \(adapter_contract\)/.test(error.message),
  );
  await service.shutdown();
});

test("worker.ready with a different capability fingerprint fails closed (fingerprint)", async () => {
  const drift: WorkerBuild = { ...WORKER_BUILD_IDENTITY, fingerprint: "d".repeat(64) };
  const { service } = harness({ worker: { readyBuild: drift } });
  await assert.rejects(
    service.activate("fence-fingerprint"),
    (error) => error instanceof Error && /build contract rejected \(fingerprint\)/.test(error.message),
  );
  await service.shutdown();
});

test("worker.ready with a malformed build block fails closed (malformed_build), never permissive", async () => {
  const { service } = harness({ worker: { readyBuild: { workerContract: "2", adapterContract: 1, fingerprint: "nope" } } });
  await assert.rejects(
    service.activate("fence-malformed"),
    (error) => error instanceof Error && /build contract rejected \(malformed_build\)/.test(error.message),
  );
  await service.shutdown();
});

test("mixed dist: a newer sessiond build (expectedWorkerBuild override) rejects the current worker dist", async () => {
  const future: WorkerBuild = {
    ...WORKER_BUILD_IDENTITY,
    workerContract: WORKER_BUILD_IDENTITY.workerContract + 1,
    fingerprint: "e".repeat(64),
  };
  const { service, workers } = harness({ service: { expectedWorkerBuild: future } });
  // The worker dist still reports the (now old) canonical identity.
  await assert.rejects(
    service.activate("fence-mixed-dist"),
    (error) => error instanceof Error && REJECTION.test(error.message),
  );
  assert.equal((await service.listRunning()).sessions.length, 0);
  await service.shutdown();
});

test("a LATE worker.ready with a bad build is dropped: the session stays ready and commands still dispatch", async () => {
  const { service, workers } = harness();
  await service.activate("fence-late");
  const worker = workers.workers[0]!;
  // A late ready carrying a mismatched build must NOT crash, re-project, or
  // tear down the session (startup already settled; the frame is invalid).
  worker.emit({
    type: "worker.ready",
    payload: { sessionId: "fence-late", workerStatus: "ready", build: { ...WORKER_BUILD_IDENTITY, fingerprint: "f".repeat(64) } },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const running = await service.listRunning();
  assert.equal(running.sessions.length, 1);
  const result = await service.command("fence-late", { type: "get_commands", commandId: "cmd-late" });
  assert.equal(result.result.ok, true);
  await service.shutdown();
});

test("the fence runs BEFORE rekey/projection: a bad build on a create-path rekey still fails the startup", async () => {
  const stale: WorkerBuild = { ...WORKER_BUILD_IDENTITY, workerContract: 99 };
  const { service } = harness({ worker: { discoveredSessionId: "real-id", readyBuild: stale } });
  await assert.rejects(
    service.create({ createRequestId: "fence-rekey", cwd: "/w", projectRoot: "/w" }),
    (error) => error instanceof Error && REJECTION.test(error.message),
  );
  assert.equal((await service.listRunning()).sessions.length, 0);
  await service.shutdown();
});
