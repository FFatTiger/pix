/**
 * PR#3 manual-port diagnostics: authoritative in-process Worker lifecycle
 * diagnostics for tests/operator internals.
 *
 * - `SessiondService.workerPids()` — unique safe positive PIDs of live Worker
 *   records (starting/ready/busy/stopping/crashed), ascending; no process scan,
 *   no session ids/names/paths.
 * - `SessiondService.diagnostics().workersByStatus` — exact frozen
 *   WorkerStatus keys, zero-filled, sum equals records count; no identifiers in
 *   the stringified snapshot.
 *
 * All assertions are deterministic (gated fakes / bounded waitUntil), never
 * machine-timing asserts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkerToSessiondMessage } from "@fffattiger/pix-protocol";
import { WorkerStatusSchema } from "@fffattiger/pix-protocol";
import type { SessionLocatorPort } from "@fffattiger/pix-runtime-core";
import { SessiondService } from "../src/service.js";
import { FakeWorkerConnection, FakeWorkerFactory } from "../src/testing/fake-worker.js";
import type { FakeWorkerOptions } from "../src/testing/fake-worker.js";
import type { WorkerConnection, WorkerProcessFactory, WorkerStartInput } from "../src/worker.js";

const FROZEN_WORKER_STATUSES = [...WorkerStatusSchema.options];

function harness(factory: WorkerProcessFactory, options: ConstructorParameters<typeof SessiondService>[1] = {}): SessiondService {
  const locator: SessionLocatorPort = {
    async locate(sessionId) { return { sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, exists: true }; },
    async resolveLeafId() { return "leaf"; },
  };
  return new SessiondService({
    sessionLocator: locator,
    activationContext: { async resolve(sessionId, _l, requestedCwd) { return { cwd: requestedCwd ?? `/cwd/${sessionId}`, projectRoot: requestedCwd ?? `/cwd/${sessionId}` }; } },
    workerFactory: factory,
  }, { workerStartTimeoutMs: 1_000, commandTimeoutMs: 1_000, idleTimeoutMs: 0, ...options });
}

/** Factory returning connections with exactly the requested pids (any number, incl. NaN/0/neg/fraction/unsafe/undefined). */
function pidFactory(pids: Array<number | undefined>, options: FakeWorkerOptions = {}): WorkerProcessFactory {
  let i = 0;
  return {
    async start(input: WorkerStartInput): Promise<WorkerConnection> {
      const pid = pids[i++];
      const worker = new FakeWorkerConnection(input, { readyDelayMs: 0, ...options }, 1);
      // redefine the readonly pid to the exact requested value (runtime-only).
      Object.defineProperty(worker, "pid", { value: pid });
      return worker;
    },
  };
}

/** Worker whose close() can be held so `stop` observably parks the record in `stopping`. */
class GatedCloseWorker extends FakeWorkerConnection {
  private held: Promise<void> | null = null;
  private releaseHeld: (() => void) | null = null;
  holdClose(): void {
    if (!this.held) {
      this.held = new Promise<void>((resolve) => { this.releaseHeld = resolve; });
    }
  }
  releaseClose(): void { this.releaseHeld?.(); }
  async close(): Promise<void> {
    if (this.held) await this.held;
    return super.close();
  }
}

function gatedFactory(): { service: SessiondService; workers: GatedCloseWorker[] } {
  const workers: GatedCloseWorker[] = [];
  const factory: WorkerProcessFactory = {
    async start(input: WorkerStartInput) {
      const worker = new GatedCloseWorker(input, { readyDelayMs: 0 }, 30_000 + workers.length);
      workers.push(worker);
      return worker;
    },
  };
  return { service: harness(factory), workers };
}

const waitUntil = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), "waitUntil timed out");
};

const sumOf = (counts: Record<string, number>): number => Object.values(counts).reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------
// workerPids lifecycle
// ---------------------------------------------------------------------------

test("workerPids is empty with no records", async () => {
  const service = harness(pidFactory([]));
  try {
    assert.deepEqual(service.workerPids(), []);
  } finally {
    await service.shutdown();
  }
});

test("workerPids includes a valid pid and excludes an undefined (no child pid) record", async () => {
  const service = harness(pidFactory([undefined, 42]));
  try {
    await service.activate("a"); // undefined pid -> excluded
    await service.activate("b"); // 42 -> included
    assert.deepEqual(service.workerPids(), [42]);
  } finally {
    await service.shutdown();
  }
});

test("workerPids excludes a starting record with no child pid", async () => {
  const service = harness(pidFactory([undefined], { readyDelayMs: 100 }));
  try {
    const activating = service.activate("a");
    await waitUntil(() => service.diagnostics().workersByStatus.starting === 1);
    assert.deepEqual(service.workerPids(), [], "a starting record with no child pid must be excluded");
    await activating;
    assert.deepEqual(service.workerPids(), []);
  } finally {
    await service.shutdown();
  }
});

test("workerPids dedups duplicate pids defensively and sorts ascending", async () => {
  const service = harness(pidFactory([100, 50, 100, 7]));
  try {
    await service.activate("a"); // 100
    await service.activate("b"); // 50
    await service.activate("c"); // 100 (duplicate)
    await service.activate("d"); // 7
    assert.deepEqual(service.workerPids(), [7, 50, 100]);
    assert.equal(service.diagnostics().sessions, 4, "records still exist even though pids dedup");
  } finally {
    await service.shutdown();
  }
});

test("workerPids excludes NaN / zero / negative / fraction / unsafe integers", async () => {
  const pids: Array<number | undefined> = [NaN, 0, -5, 1.5, 2 ** 53, 2 ** 53 - 1];
  const service = harness(pidFactory(pids));
  try {
    for (let i = 0; i < pids.length; i += 1) await service.activate(`s${i}`);
    // Only the max safe integer survives.
    assert.deepEqual(service.workerPids(), [2 ** 53 - 1]);
  } finally {
    await service.shutdown();
  }
});

test("workerPids survives a rekey without duplicating the pid (alias never affects count)", async () => {
  const service = harness(new FakeWorkerFactory({ readyDelayMs: 0, discoveredSessionId: "real-a" }));
  try {
    const created = await service.create({ createRequestId: "cr-a", cwd: "/a", projectRoot: "/a" });
    assert.equal(created.sessionId, "real-a", "rekey binds the authoritative id");
    const pids = service.workerPids();
    assert.equal(pids.length, 1, "one record -> one pid, never duplicated by the rekey alias");
    assert.ok(Number.isSafeInteger(pids[0]!) && pids[0]! > 0);
  } finally {
    await service.shutdown();
  }
});

test("workerPids keeps a crashed record's pid until exact cleanup, then stop removes it", async () => {
  const workers = new FakeWorkerFactory({ readyDelayMs: 0 });
  const service = harness(workers);
  try {
    await service.activate("a");
    const pid = service.workerPids()[0]!;
    assert.ok(pid > 0);
    workers.workers[0]!.crash();
    await waitUntil(() => service.diagnostics().workersByStatus.crashed === 1);
    assert.deepEqual(service.workerPids(), [pid], "crashed record still carries its child pid until cleanup");
    await service.stop("a");
    assert.deepEqual(service.workerPids(), [], "stop removes the crashed record and its pid");
  } finally {
    await service.shutdown();
  }
});

test("workerPids stop cleanup removes the record and pid", async () => {
  const service = harness(pidFactory([77]));
  try {
    await service.activate("a");
    assert.deepEqual(service.workerPids(), [77]);
    assert.equal(await service.stop("a"), true);
    assert.deepEqual(service.workerPids(), []);
    assert.equal(service.diagnostics().sessions, 0);
  } finally {
    await service.shutdown();
  }
});

// ---------------------------------------------------------------------------
// diagnostics().workersByStatus
// ---------------------------------------------------------------------------

test("workersByStatus covers every frozen WorkerStatus key exactly and zero-fills", async () => {
  const service = harness(pidFactory([]));
  try {
    const counts = service.diagnostics().workersByStatus;
    assert.deepEqual(Object.keys(counts).sort(), [...FROZEN_WORKER_STATUSES].sort());
    assert.deepEqual(counts, {
      idle: 0, starting: 0, ready: 0, busy: 0, stopping: 0, stopped: 0, crashed: 0, unavailable: 0,
    });
    assert.equal(sumOf(counts), service.diagnostics().sessions);
  } finally {
    await service.shutdown();
  }
});

test("workersByStatus transitions starting -> ready -> busy via the authoritative worker.status", async () => {
  const workers = new FakeWorkerFactory({ readyDelayMs: 100 });
  const service = harness(workers);
  try {
    const activating = service.activate("a");
    await waitUntil(() => service.diagnostics().workersByStatus.starting === 1);
    assert.equal(service.diagnostics().sessions, 1);
    assert.equal(sumOf(service.diagnostics().workersByStatus), 1);
    await activating;
    const d = service.diagnostics();
    assert.equal(d.workersByStatus.starting, 0);
    assert.equal(d.workersByStatus.ready, 1);
    assert.equal(sumOf(d.workersByStatus), d.sessions);

    workers.workers[0]!.emit({ type: "worker.status", payload: { sessionId: "a", status: "busy" } });
    const d2 = service.diagnostics();
    assert.equal(d2.workersByStatus.busy, 1);
    assert.equal(d2.workersByStatus.ready, 0);
    assert.equal(sumOf(d2.workersByStatus), d2.sessions);
  } finally {
    await service.shutdown();
  }
});

test("workersByStatus counts different sessions with different statuses", async () => {
  const workers = new FakeWorkerFactory({ readyDelayMs: 0 });
  const service = harness(workers);
  try {
    await service.activate("a"); // ready
    await service.activate("b"); // ready
    await service.activate("c"); // ready
    workers.workers[0]!.emit({ type: "worker.status", payload: { sessionId: "a", status: "busy" } });
    workers.workers[1]!.crash();
    await waitUntil(() => service.diagnostics().workersByStatus.crashed === 1);
    const d = service.diagnostics();
    assert.equal(d.workersByStatus.busy, 1);
    assert.equal(d.workersByStatus.ready, 1);
    assert.equal(d.workersByStatus.crashed, 1);
    assert.equal(sumOf(d.workersByStatus), 3);
    assert.equal(d.sessions, 3);
  } finally {
    await service.shutdown();
  }
});

test("workersByStatus parks a stop in `stopping` and clears on exact cleanup", async () => {
  const { service, workers } = gatedFactory();
  try {
    await service.activate("a");
    workers[0]!.holdClose();
    const stopping = service.stop("a");
    await waitUntil(() => service.diagnostics().workersByStatus.stopping === 1);
    assert.equal(service.diagnostics().sessions, 1);
    workers[0]!.releaseClose();
    await stopping;
    const d = service.diagnostics();
    assert.equal(d.workersByStatus.stopping, 0);
    assert.equal(d.sessions, 0);
    assert.deepEqual(service.workerPids(), []);
  } finally {
    await service.shutdown();
  }
});

test("stringified diagnostics snapshot carries no identifiers or PIDs", async () => {
  const workers = new FakeWorkerFactory({ readyDelayMs: 0 });
  const service = harness(workers);
  try {
    await service.activate("session-id-xyz-12345");
    await service.activate("another-id-67890");
    const json = JSON.stringify(service.diagnostics());
    assert.ok(!json.includes("session-id-xyz-12345"), "session id must not leak");
    assert.ok(!json.includes("another-id-67890"), "session id must not leak");
    assert.ok(!json.includes("/cwd/"), "paths must not leak");
    assert.ok(!json.includes("jsonl"), "session files must not leak");
    assert.ok(!/pid/i.test(json), "snapshot must never carry PIDs");
    const parsed = JSON.parse(json) as { workersByStatus: Record<string, number>; sessions: number };
    assert.equal(sumOf(parsed.workersByStatus), parsed.sessions);
    assert.ok(Object.values(parsed.workersByStatus).every((n) => typeof n === "number"));
  } finally {
    await service.shutdown();
  }
});
