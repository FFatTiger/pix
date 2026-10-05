import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_RUNTIME_QUEUED_BYTES,
  type RuntimeSnapshot,
  type SessiondPush,
  type SessiondTurnStatusPush,
} from "@fffattiger/pix-protocol";
import type { SessionCatalogPort, SessionLocatorPort } from "@fffattiger/pix-runtime-core";
import { makeRuntimeError } from "@fffattiger/pix-runtime-core";
import { EventJournal } from "../src/journal.js";
import { ndjsonQueuedBytes } from "../src/internal/subscriber-queue.js";
import { SessiondApplication } from "../src/application.js";
import { SessiondError } from "../src/errors.js";
import { SessiondRpcClient, SessiondRpcServer } from "../src/rpc.js";
import { SessiondService } from "../src/service.js";
import { FakeWorkerFactory } from "../src/testing/fake-worker.js";

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await wait(2);
  }
};

const snapshot = (sessionId: string, extra: Partial<RuntimeSnapshot["state"]> = {}): RuntimeSnapshot => ({
  sessionId,
  cwd: `/${sessionId}`,
  projectRoot: `/${sessionId}`,
  state: {
    sessionId,
    isStreaming: false,
    isPromptRunning: false,
    isBashRunning: false,
    isCompacting: false,
    model: null,
    messageCount: 0,
    queuedMessages: { steering: [], followUp: [] },
    pendingMessageCount: 0,
    writtenFiles: [],
    ...extra,
  },
  capabilities: { capabilities: ["runtime.prompt", "runtime.model.set", "runtime.thinking.set", "runtime.queue"], version: 1 },
  streaming: { active: false, phase: "idle" },
});

const legalImage = (tag: string, size = 180_000): { type: "image"; data: string; mimeType: "image/png" } => ({
  type: "image",
  data: Buffer.from(`${tag}:${"A".repeat(size)}`).toString("base64").padEnd(Math.ceil((tag.length + 1 + size) / 3) * 4, "="),
  mimeType: "image/png",
});

function harness(options: { worker?: ConstructorParameters<typeof FakeWorkerFactory>[0]; service?: ConstructorParameters<typeof SessiondService>[1] } = {}) {
  const locator: SessionLocatorPort = {
    async locate(sessionId) { return { sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, exists: true }; },
    async resolveLeafId() { return "leaf"; },
  };
  const catalog: SessionCatalogPort = {
    async listSessions() { return []; },
    async readSession(sessionId) { return { sessionId, cwd: "/workspace", projectRoot: "/workspace", entries: [] }; },
    async readSessionContext(sessionId) { return { sessionId, entries: [], pageInfo: { hasMore: false } }; },
    async readSessionThinking(sessionId, entryId) { throw makeRuntimeError("not_found", `session not found: ${sessionId}/${entryId}`); },
    async readSessionTree(sessionId) { return { sessionId, roots: [], entryCount: 0 }; },
    async deleteSession() {},
  };
  const workers = new FakeWorkerFactory(options.worker ?? { snapshot: snapshot("s") });
  const service = new SessiondService({
    sessionLocator: locator,
    activationContext: { async resolve(sessionId, _location, requestedCwd) { return { cwd: requestedCwd ?? `/${sessionId}`, projectRoot: requestedCwd ?? `/${sessionId}` }; } },
    workerFactory: workers,
    sessionCatalog: catalog,
  }, { workerStartTimeoutMs: 500, commandTimeoutMs: 500, idleTimeoutMs: 0, ...options.service });
  return { service, workers };
}

const queueUpdate = (sessionId: string, tag: string, size = 180_000) => ({
  type: "queue_update" as const,
  sessionId,
  steering: [{ message: tag, images: [legalImage(tag, size)] }],
});

test("blocked runtime subscriber preserves two legal image-bearing frames in order", async () => {
  const { service, workers } = harness();
  await service.activate("s");
  const received: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let first = true;
  service.subscribe("s", async (push) => {
    if (push.type !== "event" || push.event.type !== "queue_update") return;
    received.push(push.event.steering?.[0]?.message ?? "");
    if (first) {
      first = false;
      await blocked;
    }
  });
  workers.workers[0]!.emitEvent(queueUpdate("s", "one"));
  workers.workers[0]!.emitEvent(queueUpdate("s", "two"));
  await waitUntil(() => received.length === 1);
  assert.deepEqual(received, ["one"]);
  assert.equal(service.diagnostics().subscribers, 1);
  release();
  await waitUntil(() => received.length === 2);
  assert.deepEqual(received, ["one", "two"]);
  await service.shutdown();
});

test("queued byte overflow closes exactly once before the count limit", async () => {
  const { service, workers } = harness({ service: { subscriberQueueLimit: 256, subscriberQueueByteLimit: 80_000 } });
  await service.activate("s");
  const closed: SessiondError[] = [];
  const attached = service.prepareAttach({ sessionId: "s" });
  void attached.closed.then((error) => { if (error) closed.push(error); });
  let hold!: () => void;
  const blocked = new Promise<void>((resolve) => { hold = resolve; });
  await attached.flushTo(async () => { await blocked; });
  workers.workers[0]!.emitEvent(queueUpdate("s", "a", 40_000));
  workers.workers[0]!.emitEvent(queueUpdate("s", "b", 40_000));
  workers.workers[0]!.emitEvent(queueUpdate("s", "c", 40_000));
  const error = await attached.closed;
  assert.ok(error instanceof SessiondError);
  assert.equal(error.code, "unavailable");
  assert.equal(closed.length, 1);
  assert.equal(service.diagnostics().subscribers, 0);
  hold();
  await wait();
  assert.equal(closed.length, 1, "overflow must settle closed exactly once");
  await service.shutdown();
});

test("prepared attachment overflow before flush rejects flush and settles closed", async () => {
  const { service, workers } = harness({ service: { subscriberQueueLimit: 256, subscriberQueueByteLimit: 80_000 } });
  await service.activate("s");
  const attached = service.prepareAttach({ sessionId: "s" });
  workers.workers[0]!.emitEvent(queueUpdate("s", "a", 40_000));
  workers.workers[0]!.emitEvent(queueUpdate("s", "b", 40_000));
  workers.workers[0]!.emitEvent(queueUpdate("s", "c", 40_000));
  await wait();
  await assert.rejects(
    () => attached.flushTo(async () => {}),
    (error: unknown) => error instanceof SessiondError && error.code === "unavailable",
  );
  const closed = await attached.closed;
  assert.ok(closed instanceof SessiondError);
  assert.equal(closed.code, "unavailable");
  assert.equal(service.diagnostics().subscribers, 0);
  await service.shutdown();
});

test("turn authority subscriber with image snapshot overflows bytes independently of count", async () => {
  const image = legalImage("authority", 70_000);
  const { service, workers } = harness({
    worker: { snapshot: snapshot("s"), turnCompletion: "manual", holdPostCommandSnapshots: true },
    service: { subscriberQueueLimit: 256, subscriberQueueByteLimit: 80_000 },
  });
  const activated = await service.activate("s");
  const preparedAttach = service.prepareAttach({ sessionId: "s" });
  const revision = preparedAttach.result.lastEventId;
  preparedAttach.close();
  const prepared = await service.prepareSubmitTurn({
    sessionId: "s",
    expectedEpoch: activated.epoch,
    expectedRevision: revision,
    prompt: "fast",
    operationId: "op-bytes",
  });
  assert.equal(prepared.result.status, "accepted");
  let hold!: () => void;
  const blocked = new Promise<void>((resolve) => { hold = resolve; });
  await prepared.flushTo(async () => { await blocked; });
  const worker = workers.workers[0]!;
  const dispatch = worker.sent.find((message) => message.type === "worker.submitTurn");
  assert.ok(dispatch && dispatch.type === "worker.submitTurn");
  worker.emit({
    type: "worker.turnStatus",
    payload: {
      sessionId: "s",
      epoch: activated.epoch,
      operationId: "op-bytes",
      turnId: dispatch.payload.turnId,
      revision: 1,
      state: "completed",
      disposition: "handled",
    },
  });
  await worker.waitForHeldSnapshot();
  worker.setSnapshot(snapshot("s", {
    queuedMessages: { steering: [{ message: "img", images: [image] }], followUp: [] },
    pendingMessageCount: 1,
  }));
  worker.releaseHeldSnapshots();
  const error = await prepared.closed;
  assert.ok(error instanceof SessiondError);
  assert.equal(error.code, "unavailable");
  hold();
  await service.shutdown();
});

test("journal 10 MiB eviction still reports an explicit gap", () => {
  const journal = new EventJournal({ maxEvents: 100, maxBytes: 10 * 1024 * 1024 });
  assert.equal(journal.maxBytes, 10 * 1024 * 1024);
  const payload = { type: "extension_error" as const, sessionId: "s", error: "x".repeat(3 * 1024 * 1024) };
  journal.append("e", payload);
  journal.append("e", payload);
  journal.append("e", payload);
  journal.append("e", payload);
  assert.equal(journal.replayAfter(0).gap, true);
  assert.ok(journal.bytes <= 10 * 1024 * 1024);
});

test("queued NDJSON bytes include the trailing newline of the wire envelope", () => {
  const push: SessiondPush = { type: "event", event: { type: "agent_start", sessionId: "s", epoch: "e", eventId: 1 } };
  assert.equal(ndjsonQueuedBytes(push), Buffer.byteLength(JSON.stringify(push), "utf8") + 1);
  const turn: SessiondTurnStatusPush = {
    type: "turn_status",
    status: { sessionId: "s", epoch: "e", operationId: "op", turnId: "t", revision: 0, state: "admitted" },
  };
  assert.equal(ndjsonQueuedBytes(turn), Buffer.byteLength(JSON.stringify(turn), "utf8") + 1);
  assert.equal(MAX_RUNTIME_QUEUED_BYTES, 2 * (16_097_152 + 1));
});

test("RPC attach overflow after flush destroys the socket and settles client.closed", async (t) => {
  if (process.platform === "win32") return t.skip("unix socket test");
  const directory = await mkdtemp(join(tmpdir(), "sessiond-sub-bytes-"));
  const endpoint = join(directory, "rpc.sock");
  const { service, workers } = harness({ service: { subscriberQueueLimit: 256, subscriberQueueByteLimit: 80_000 } });
  await service.activate("s");
  const server = new SessiondRpcServer({ endpoint, secret: "a".repeat(40), handler: new SessiondApplication(service) });
  await server.listen();
  const client = new SessiondRpcClient({ endpoint, secret: "a".repeat(40), timeoutMs: 2_000 });
  let hold!: () => void;
  const blocked = new Promise<void>((resolve) => { hold = resolve; });
  try {
    const subscription = await client.attach({ sessionId: "s" }, async () => { await blocked; });
    workers.workers[0]!.emitEvent(queueUpdate("s", "a", 40_000));
    workers.workers[0]!.emitEvent(queueUpdate("s", "b", 40_000));
    workers.workers[0]!.emitEvent(queueUpdate("s", "c", 40_000));
    await subscription.closed;
    assert.equal(service.diagnostics().subscribers, 0);
  } finally {
    hold();
    await server.close().catch(() => {});
    await service.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("RPC attach listener throw after flush settles client.closed", async (t) => {
  if (process.platform === "win32") return t.skip("unix socket test");
  const directory = await mkdtemp(join(tmpdir(), "sessiond-sub-throw-"));
  const endpoint = join(directory, "rpc.sock");
  const { service, workers } = harness();
  await service.activate("s");
  const server = new SessiondRpcServer({ endpoint, secret: "a".repeat(40), handler: new SessiondApplication(service) });
  await server.listen();
  const client = new SessiondRpcClient({ endpoint, secret: "a".repeat(40), timeoutMs: 2_000 });
  try {
    const subscription = await client.attach({ sessionId: "s" }, () => { throw new Error("listener boom"); });
    workers.workers[0]!.emitEvent({ type: "agent_start", sessionId: "s" });
    await subscription.closed;
    await waitUntil(() => service.diagnostics().subscribers === 0);
  } finally {
    await server.close().catch(() => {});
    await service.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("RPC turn status overflow after admission settles client.closed", async (t) => {
  if (process.platform === "win32") return t.skip("unix socket test");
  const directory = await mkdtemp(join(tmpdir(), "sessiond-turn-bytes-"));
  const endpoint = join(directory, "rpc.sock");
  const { service, workers } = harness({
    worker: { snapshot: snapshot("s"), turnCompletion: "manual", holdPostCommandSnapshots: true },
    service: { subscriberQueueLimit: 256, subscriberQueueByteLimit: 80_000 },
  });
  const activated = await service.activate("s");
  const attached = service.prepareAttach({ sessionId: "s" });
  const revision = attached.result.lastEventId;
  attached.close();
  const server = new SessiondRpcServer({ endpoint, secret: "a".repeat(40), handler: new SessiondApplication(service) });
  await server.listen();
  const client = new SessiondRpcClient({ endpoint, secret: "a".repeat(40), timeoutMs: 5_000 });
  let hold!: () => void;
  const blocked = new Promise<void>((resolve) => { hold = resolve; });
  try {
    const subscription = await client.submitTurn(
      { sessionId: "s", expectedEpoch: activated.epoch, expectedRevision: revision, prompt: "fast", operationId: "rpc-bytes" },
      async () => { await blocked; },
    );
    assert.equal(subscription.response.status, "accepted");
    const worker = workers.workers[0]!;
    const dispatch = worker.sent.find((message) => message.type === "worker.submitTurn");
    assert.ok(dispatch && dispatch.type === "worker.submitTurn");
    worker.emit({
      type: "worker.turnStatus",
      payload: {
        sessionId: "s",
        epoch: activated.epoch,
        operationId: "rpc-bytes",
        turnId: dispatch.payload.turnId,
        revision: 1,
        state: "completed",
        disposition: "handled",
      },
    });
    await worker.waitForHeldSnapshot();
    worker.setSnapshot(snapshot("s", {
      queuedMessages: { steering: [{ message: "img", images: [legalImage("turn", 70_000)] }], followUp: [] },
      pendingMessageCount: 1,
    }));
    worker.releaseHeldSnapshots();
    await subscription.closed;
  } finally {
    hold();
    await server.close().catch(() => {});
    await service.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

for (const phase of ["before", "after"] as const) {
  test(`prepared subscriptions close exactly once ${phase} flush`, async () => {
    const { service } = harness({ worker: { snapshot: snapshot("s"), turnCompletion: "manual" } });
    const activated = await service.activate("s");
    const attached = service.prepareAttach({ sessionId: "s" });
    const turn = await service.prepareSubmitTurn({ sessionId: "s", expectedEpoch: activated.epoch, expectedRevision: attached.result.lastEventId, operationId: "close", prompt: "hello" });
    const watch = service.prepareRunningWatch();
    try {
      for (const prepared of [attached, turn, watch]) {
        let settlements = 0;
        void prepared.closed.then(() => { settlements += 1; });
        if (phase === "after") await prepared.flushTo(() => {});
        prepared.close();
        prepared.close();
        assert.equal(await prepared.closed, null);
        assert.equal(settlements, 1);
        if (phase === "before") await assert.rejects(prepared.flushTo(() => {}), { code: "unavailable" });
      }
      assert.equal(service.diagnostics().subscribers, 0);
    } finally { await service.shutdown(); }
  });
}

for (const phase of ["before", "after"] as const) {
  test(`running watch byte overflow ${phase} flush settles closed`, async () => {
    const { service } = harness({ service: { subscriberQueueByteLimit: 1 } });
    const watch = service.prepareRunningWatch();
    if (phase === "after") await watch.flushTo(() => {});
    try {
      await service.activate("s");
      assert.equal((await watch.closed)?.code, "unavailable");
      if (phase === "before") await assert.rejects(watch.flushTo(() => {}), { code: "unavailable" });
      watch.close();
    } finally { await service.shutdown(); }
  });
}

test("buffered turn listener rejection settles closed and releases the subscriber", async () => {
  const { service, workers } = harness({ worker: { snapshot: snapshot("s"), turnCompletion: "manual", holdPostCommandSnapshots: true } });
  const activated = await service.activate("s");
  const attached = service.prepareAttach({ sessionId: "s" });
  const revision = attached.result.lastEventId;
  attached.close();
  const turn = await service.prepareSubmitTurn({ sessionId: "s", expectedEpoch: activated.epoch, expectedRevision: revision, operationId: "buffered-reject", prompt: "hello" });
  const worker = workers.workers[0]!;
  const dispatch = worker.sent.find((message) => message.type === "worker.submitTurn");
  assert.ok(dispatch?.type === "worker.submitTurn");
  worker.emit({ type: "worker.turnStatus", payload: { ...dispatch.payload, revision: 1, state: "running" } });
  try {
    const boom = new Error("buffered listener rejected");
    await assert.rejects(turn.flushTo(() => { throw boom; }), boom);
    assert.equal((await turn.closed)?.code, "unavailable");
    turn.close();
  } finally { await service.shutdown(); }
});

test("close during attachment replay stops the flush before later frames", async () => {
  const { service, workers } = harness();
  const activated = await service.activate("s");
  workers.workers[0]!.emitEvent(queueUpdate("s", "first", 20));
  workers.workers[0]!.emitEvent(queueUpdate("s", "second", 20));
  const attached = service.prepareAttach({ sessionId: "s", epoch: activated.epoch, lastEventId: 0 });
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let deliveries = 0;
  const flushing = attached.flushTo(async () => { deliveries += 1; entered(); await blocked; });
  const rejected = assert.rejects(flushing, { code: "unavailable" });
  await started;
  attached.close();
  assert.equal(await attached.closed, null);
  release();
  await rejected;
  assert.equal(deliveries, 1);
  await service.shutdown();
});
