import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeSnapshot, SessiondRpcRequest } from "@fffattiger/pix-protocol";
import type { SessionCatalogPort, SessionLocatorPort } from "@fffattiger/pix-runtime-core";
import { SessiondApplication } from "../src/application.js";
import { EventJournal } from "../src/journal.js";
import { acquireInstanceLock, loadOrCreateLocalSecret, sessiondPaths } from "../src/local.js";
import { SnapshotProjection } from "../src/projection.js";
import { SessiondRpcClient, SessiondRpcServer } from "../src/rpc.js";
import { SessiondService } from "../src/service.js";
import { FakeWorkerFactory } from "../src/testing/fake-worker.js";

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const snapshot = (sessionId: string, cwd = "/workspace", projectRoot = cwd): RuntimeSnapshot => ({
  sessionId, cwd, projectRoot,
  state: { sessionId, isStreaming: false, isPromptRunning: false, isBashRunning: false, isCompacting: false, model: null, messageCount: 0, queuedMessages: { steering: [], followUp: [] }, pendingMessageCount: 0, writtenFiles: [] },
  capabilities: { capabilities: ["runtime.prompt", "runtime.abort", "runtime.bash", "runtime.bash.abort", "runtime.compact", "runtime.compact.abort", "runtime.queue"], version: 1 },
  streaming: { active: false, phase: "idle" }, messages: [],
});

function harness(options: { worker?: ConstructorParameters<typeof FakeWorkerFactory>[0]; service?: ConstructorParameters<typeof SessiondService>[1] } = {}) {
  const locations = new Map<string, { sessionFile: string; exists: boolean }>();
  const locator: SessionLocatorPort = {
    async locate(sessionId) { return { sessionId, sessionFile: locations.get(sessionId)?.sessionFile ?? `/sessions/${sessionId}.jsonl`, exists: locations.get(sessionId)?.exists ?? true }; },
    async resolveLeafId() { return "leaf"; },
  };
  const catalog: SessionCatalogPort = {
    async listSessions() { return []; },
    async readSession(sessionId) { return { sessionId, cwd: "/workspace", projectRoot: "/workspace", entries: [] }; },
    async readSessionContext(sessionId) { return { sessionId, entries: [] }; },
    async deleteSession() {},
  };
  const workers = new FakeWorkerFactory(options.worker);
  const service = new SessiondService({
    sessionLocator: locator,
    activationContext: { async resolve(sessionId, location, requestedCwd) { return { cwd: requestedCwd ?? `/cwd/${sessionId}`, projectRoot: requestedCwd ?? `/cwd/${sessionId}` }; } },
    workerFactory: workers,
    sessionCatalog: catalog,
  }, { workerStartTimeoutMs: 500, commandTimeoutMs: 500, idleTimeoutMs: 0, ...options.service });
  return { service, workers, locations, locator };
}

test("20 concurrent activations start exactly one worker", async () => {
  const { service, workers } = harness({ worker: { readyDelayMs: 5 } });
  const results = await Promise.all(Array.from({ length: 20 }, () => service.activate("same")));
  assert.equal(workers.starts, 1);
  assert.equal(new Set(results.map((result) => result.epoch)).size, 1);
  await service.shutdown();
});

test("createRequestId is idempotent while distinct creates remain distinct and may start concurrently", async () => {
  const { service, workers } = harness({ worker: (input, index) => ({ readyDelayMs: 5, discoveredSessionId: `real-${index}-${input.activationId.slice(0, 4)}` }) });
  const input = { createRequestId: "create-a", cwd: "/a", projectRoot: "/a" } as const;
  const [first, duplicate, second] = await Promise.all([service.create(input), service.create(input), service.create({ createRequestId: "create-b", cwd: "/b", projectRoot: "/b" })]);
  assert.equal(first.sessionId, duplicate.sessionId);
  assert.notEqual(first.sessionId, second.sessionId);
  assert.equal(workers.starts, 2);
  await service.shutdown();
});

test("duplicate commandId before and after result executes once", async () => {
  const { service, workers } = harness({ worker: { commandDelayMs: 15 } });
  await service.activate("s");
  const command = { type: "prompt", commandId: "cmd", message: "hello" } as const;
  const [a, b] = await Promise.all([service.command("s", command), service.command("s", command)]);
  const c = await service.command("s", command);
  assert.deepEqual(a, b); assert.deepEqual(b, c);
  assert.equal(workers.workers[0]!.sent.filter((item) => item.type === "worker.command").length, 1);
  await service.shutdown();
});

test("independent interrupt preempts a long prompt", async () => {
  const { service, workers } = harness({ worker: { commandDelayMs: 100 } });
  await service.activate("s");
  const prompt = service.command("s", { type: "prompt", commandId: "p", message: "long" });
  await wait(5);
  const interrupt = await service.interrupt("s", { type: "abort" }, "abort-request");
  const duplicateInterrupt = await service.interrupt("s", { type: "abort" }, "abort-request");
  const result = await prompt;
  assert.deepEqual(interrupt, duplicateInterrupt);
  assert.equal(interrupt.ok, true);
  assert.equal(workers.workers[0]!.sent.filter((item) => item.type === "worker.interrupt").length, 1);
  assert.equal(result.result.ok, false);
  assert.equal(result.result.error.code, "interrupted");
  assert.ok(workers.workers[0]!.sent.findIndex((item) => item.type === "worker.interrupt") > -1);
  await service.shutdown();
});

test("attach subscribes before replay boundary and receives later events without loss", async () => {
  const { service, workers } = harness();
  const activated = await service.activate("s");
  const baseline = service.attach({ sessionId: "s" }).result.lastEventId;
  workers.workers[0]!.emitEvent({ type: "agent_start", sessionId: "s" });
  const pushes: unknown[] = [];
  const attached = service.prepareAttach({ sessionId: "s", epoch: activated.epoch, lastEventId: baseline }, () => {
    workers.workers[0]!.emitEvent({ type: "agent_end", sessionId: "s" });
  });
  const boundary = attached.result.lastEventId;
  assert.equal(attached.result.snapshot.state.isPromptRunning, false);
  await attached.flushTo(async (push) => { pushes.push(push); });
  workers.workers[0]!.emitEvent({ type: "agent_settled", sessionId: "s" });
  await wait();
  assert.equal(boundary, baseline + 1);
  assert.equal(pushes.length, 3);
  assert.deepEqual(pushes.map((push) => (push as { event: { eventId: number } }).event.eventId), [baseline + 1, baseline + 2, baseline + 3]);
  attached.close();
  await service.shutdown();
});

test("journal count and byte eviction report gaps", () => {
  const byCount = new EventJournal({ maxEvents: 2, maxBytes: 10_000 });
  byCount.append("e", { type: "agent_start", sessionId: "s" });
  byCount.append("e", { type: "agent_end", sessionId: "s" });
  byCount.append("e", { type: "agent_settled", sessionId: "s" });
  assert.equal(byCount.replayAfter(0).gap, true);
  assert.deepEqual(byCount.replayAfter(1).events.map((event) => event.eventId), [2, 3]);
  const byBytes = new EventJournal({ maxEvents: 100, maxBytes: 120 });
  byBytes.append("e", { type: "extension_error", sessionId: "s", error: "x".repeat(100) });
  assert.equal(byBytes.size, 0);
});

test("event cursor fails closed before unsafe overflow", () => {
  const journal = new EventJournal();
  journal.setNextEventIdForTest(Number.MAX_SAFE_INTEGER);
  const last = journal.append("epoch", { type: "agent_start", sessionId: "s" });
  assert.equal(last.eventId, Number.MAX_SAFE_INTEGER);
  assert.throws(() => journal.append("epoch", { type: "agent_end", sessionId: "s" }), /cursor exhausted/);
});

test("epoch mismatch and journal gap return authoritative full snapshots", async () => {
  const { service, workers } = harness({ service: { journal: { maxEvents: 1, maxBytes: 10_000 } } });
  const active = await service.activate("s");
  workers.workers[0]!.emitEvent({ type: "agent_start", sessionId: "s" });
  workers.workers[0]!.emitEvent({ type: "agent_end", sessionId: "s" });
  const gap = service.attach({ sessionId: "s", epoch: active.epoch, lastEventId: 0 }).result;
  const changed = service.attach({ sessionId: "s", epoch: "old", lastEventId: 0 }).result;
  assert.equal(gap.resumeStatus, "gap");
  assert.equal(changed.resumeStatus, "epoch_changed");
  assert.equal(gap.cwd, "/cwd/s"); assert.equal(gap.snapshot.cwd, "/cwd/s");
  await service.shutdown();
});

test("snapshot projection recovers streaming queue extension bash compaction and written files", () => {
  const projection = new SnapshotProjection(snapshot("s"));
  projection.apply({ type: "message_start", sessionId: "s", streamId: "stream", messageId: "msg", message: { role: "assistant", model: "m", provider: "p" } });
  projection.apply({ type: "message_update", sessionId: "s", streamId: "stream", messageId: "msg", delta: { role: "assistant", delta: { type: "text", text: "hello" } } });
  projection.apply({ type: "queue_update", sessionId: "s", steering: [{ message: "next" }], followUp: [] });
  projection.apply({ type: "extension_ui_request", sessionId: "s", request: { id: "ui", method: "confirm", title: "t", message: "m" } });
  projection.apply({ type: "tool_execution_end", sessionId: "s", toolCallId: "t", writtenFiles: ["/a"] });
  assert.equal(projection.snapshot().streaming?.partialMessage?.role, "assistant");
  assert.equal(projection.snapshot().state.pendingMessageCount, 1);
  assert.equal(projection.snapshot().state.pendingExtensionUi?.length, 1);
  assert.deepEqual(projection.snapshot().state.writtenFiles, ["/a"]);
});

test("worker crash is isolated and stale events after reactivation are rejected", async () => {
  const { service, workers } = harness();
  await Promise.all([service.activate("a"), service.activate("b")]);
  const old = workers.workers[0]!;
  old.crash(); await wait();
  assert.deepEqual(service.listRunning().sessions.map((item) => item.sessionId), ["b"]);
  await service.activate("a");
  old.emitEvent({ type: "agent_start", sessionId: "a" });
  assert.equal(service.getSnapshot("a").state.isPromptRunning, false);
  assert.equal(service.listRunning().sessions.length, 2);
  await service.shutdown();
});

test("re-key collisions fail startup without replacing the active session", async () => {
  const { service, workers } = harness({ worker: (input, index) => ({ readyDelayMs: index === 0 ? 0 : 5, ...(index === 1 ? { discoveredSessionId: "existing" } : {}) }) });
  await service.activate("existing");
  await assert.rejects(service.create({ createRequestId: "collision", cwd: "/new", projectRoot: "/new" }));
  assert.equal(service.listRunning().sessions.filter((item) => item.sessionId === "existing").length, 1);
  assert.equal(workers.starts, 2);
  await service.shutdown();
});

test("worker startup failure rolls back registry", async () => {
  const { service } = harness({ worker: { failStart: true } });
  await assert.rejects(service.activate("s"));
  assert.equal(service.diagnostics().sessions, 0);
});

test("read-only snapshot and catalog operations never activate a worker", async () => {
  const { service, workers } = harness();
  assert.throws(() => service.getSnapshot("missing"));
  const app = new SessiondApplication(service);
  await app.handle("sessions.list", {});
  assert.equal(workers.starts, 0);
});

test("slow subscribers are bounded and removed without blocking authority", async () => {
  const { service, workers } = harness({ service: { subscriberQueueLimit: 2 } });
  await service.activate("s");
  service.subscribe("s", async () => new Promise(() => {}));
  for (let index = 0; index < 10; index += 1) workers.workers[0]!.emitEvent({ type: "runtime_state_changed", sessionId: "s" });
  await wait();
  assert.equal(service.diagnostics().subscribers, 0);
  assert.equal(service.getSnapshot("s").sessionId, "s");
  await service.shutdown();
});

test("instance lock rejects a second live instance and recovers stale locks with private permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sessiond-lock-"));
  const paths = sessiondPaths(directory);
  const first = await acquireInstanceLock(paths);
  await assert.rejects(acquireInstanceLock(paths));
  const mode = (await stat(paths.lockFile)).mode & 0o777;
  assert.equal(mode, 0o600);
  await first.release();
  await writeFile(paths.lockFile, JSON.stringify({ pid: 999_999_999, instanceId: "stale" }), { mode: 0o600 });
  const recovered = await acquireInstanceLock(paths);
  await recovered.release(); await rm(directory, { recursive: true, force: true });
});

test("local secret is stable and private", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sessiond-secret-"));
  const paths = sessiondPaths(directory);
  const one = await loadOrCreateLocalSecret(paths); const two = await loadOrCreateLocalSecret(paths);
  assert.equal(one, two); assert.ok(one.length >= 32); assert.equal((await stat(paths.secretFile)).mode & 0o777, 0o600);
  await rm(directory, { recursive: true, force: true });
});

test("RPC authenticates locally and rejects the wrong secret", async (t) => {
  if (process.platform === "win32") return t.skip("unix socket test");
  const directory = await mkdtemp(join(tmpdir(), "sessiond-rpc-"));
  const endpoint = join(directory, "rpc.sock");
  const { service } = harness();
  const server = new SessiondRpcServer({ endpoint, secret: "a".repeat(40), handler: new SessiondApplication(service) });
  await server.listen();
  const good = new SessiondRpcClient({ endpoint, secret: "a".repeat(40), timeoutMs: 500 });
  assert.equal((await good.call("system.ping", {})).pong, true);
  const active = await good.call("runtime.activate", { sessionId: "rpc-session" });
  const order: number[] = [];
  const subscription = await good.attach({ sessionId: "rpc-session", epoch: active.epoch, lastEventId: 0 }, async (push) => {
    if (push.type === "event") order.push(push.event.eventId);
  });
  assert.equal(subscription.response.sessionId, "rpc-session");
  const worker = (service as unknown as { diagnostics(): unknown });
  void worker;
  subscription.close();
  await wait();
  assert.equal(service.diagnostics().subscribers, 0);
  assert.equal(service.listRunning().sessions.length, 1);
  const bad = new SessiondRpcClient({ endpoint, secret: "b".repeat(40), timeoutMs: 500 });
  await assert.rejects(bad.call("system.ping", {}));
  await server.close(); await rm(directory, { recursive: true, force: true });
});
