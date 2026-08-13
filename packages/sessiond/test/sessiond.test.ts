import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { RuntimeCapabilitySet, RuntimeSnapshot, SessiondMethodParams, SessiondRpcRequest, SessiondRuntimeAttachResult } from "@fffattiger/pix-protocol";
import { PROTOCOL_VERSION } from "@fffattiger/pix-protocol";
import type { SessionCatalogPort, SessionLocatorPort } from "@fffattiger/pix-runtime-core";
import { SessiondApplication } from "../src/application.js";
import { EventJournal } from "../src/journal.js";
import { acquireInstanceLock, loadOrCreateLocalSecret, sessiondPaths } from "../src/local.js";
import { SnapshotProjection } from "../src/projection.js";
import { SessiondRpcClient, SessiondRpcServer, type SessiondRpcHandler } from "../src/rpc.js";
import { SessiondError } from "../src/errors.js";
import { SessiondService } from "../src/service.js";
import { FakeWorkerFactory } from "../src/testing/fake-worker.js";

const here = dirname(fileURLToPath(import.meta.url));

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

test("worker.init mode is create for create and open for activate", async () => {
  const createHarness = harness({ worker: { readyDelayMs: 0 } });
  await createHarness.service.create({ createRequestId: "c-mode", cwd: "/a", projectRoot: "/a" });
  const createInit = createHarness.workers.workers[0]!.sent.find((item) => item.type === "worker.init");
  assert.equal(createInit?.type === "worker.init" && createInit.payload.mode, "create", "create path must pass mode create");
  await createHarness.service.shutdown();

  const activateHarness = harness({ worker: { readyDelayMs: 0 } });
  await activateHarness.service.activate("s");
  const activateInit = activateHarness.workers.workers[0]!.sent.find((item) => item.type === "worker.init");
  assert.equal(activateInit?.type === "worker.init" && activateInit.payload.mode, "open", "activate path must pass mode open");
  await activateHarness.service.shutdown();
});

test("independent interrupt preempts a long prompt and dedups by commandId", async () => {
  const { service, workers } = harness({ worker: { commandDelayMs: 100 } });
  await service.activate("s");
  const prompt = service.command("s", { type: "prompt", commandId: "p", message: "long" });
  await wait(5);
  // same commandId + same type: returns the same result and sends the worker one interrupt
  const interrupt = await service.interrupt("s", "abort-request", { type: "abort" });
  const duplicateInterrupt = await service.interrupt("s", "abort-request", { type: "abort" });
  // same commandId + different type: fails closed with a non-retryable command_rejected
  const conflicting = await service.interrupt("s", "abort-request", { type: "clear_queue" });
  const result = await prompt;
  assert.deepEqual(interrupt, duplicateInterrupt);
  assert.equal(interrupt.commandId, "abort-request");
  assert.equal(interrupt.result.ok, true);
  assert.equal(conflicting.commandId, "abort-request");
  assert.equal(conflicting.result.ok, false);
  assert.equal(conflicting.result.type, "clear_queue");
  assert.equal(conflicting.result.error.code, "command_rejected");
  assert.equal(conflicting.result.error.retryable, false);
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

test("bash_update output deltas accumulate once without double-joining", () => {
  // bash_update.output is a per-event DELTA (frozen semantic on both Runtime
  // Core and Protocol sides). The projection is the single accumulator: two
  // deltas must join into one cumulative snapshot, exactly once (no duplication).
  const projection = new SnapshotProjection(snapshot("s"));
  projection.apply({ type: "bash_update", sessionId: "s", command: "echo", output: "Hello " });
  assert.equal(projection.snapshot().state.bash?.output, "Hello ");
  projection.apply({ type: "bash_update", sessionId: "s", output: "World" });
  assert.equal(projection.snapshot().state.bash?.output, "Hello World");
  assert.equal(projection.snapshot().state.bash?.updateCount, 2);
  assert.equal(projection.snapshot().state.isBashRunning, true);
  // a final delta with exitCode completes the snapshot; prior accumulation is preserved
  projection.apply({ type: "bash_update", sessionId: "s", output: "!", exitCode: 0 });
  assert.equal(projection.snapshot().state.bash?.output, "Hello World!");
  assert.equal(projection.snapshot().state.bash?.completed, true);
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

test("startup primes authoritative snapshot: attach carries real runtime capabilities", async () => {
  const workerSnapshot = snapshot("s");
  const { service, workers } = harness({ worker: { snapshot: workerSnapshot } });
  await service.activate("s");
  // sessiond proactively fetched the authoritative snapshot during startup, before attach.
  const getSnapshotCalls = workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot");
  assert.ok(getSnapshotCalls.length >= 1, "startup must send worker.getSnapshot");
  // Authoritative capabilities propagate into the projection AND the client attach snapshot.
  assert.deepEqual(service.getSnapshot("s").capabilities, workerSnapshot.capabilities);
  const attach = service.attach({ sessionId: "s" });
  assert.ok(attach.result.snapshot, "attach must carry an initial snapshot");
  assert.deepEqual(attach.result.snapshot!.capabilities, workerSnapshot.capabilities);
  await service.shutdown();
});

test("startup snapshot failure fails closed and rolls back the worker", async () => {
  const { service } = harness({ worker: { ignoreSnapshot: true } });
  await assert.rejects(service.activate("s"));
  // fail-closed: the record never becomes attachable with an empty capability set.
  assert.equal(service.diagnostics().sessions, 0);
  assert.throws(() => service.getSnapshot("s"));
  await service.shutdown();
});

test("startup rejects a snapshot whose inner sessionId mismatches the active record", async () => {
  const { service } = harness({ worker: { snapshotSessionIdOverride: "wrong-session" } });
  await assert.rejects(
    service.activate("s"),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "worker_unavailable",
  );
  assert.equal(service.diagnostics().sessions, 0);
  assert.throws(() => service.getSnapshot("s"));
  await service.shutdown();
});

test("runtime_capabilities_changed updates the projected capability set", async () => {
  const { service, workers } = harness();
  await service.activate("s");
  // primed default snapshot has an empty capability set.
  assert.deepEqual(service.getSnapshot("s").capabilities, { capabilities: [], version: 0 });
  const next: RuntimeCapabilitySet = { capabilities: ["runtime.prompt", "runtime.abort", "runtime.bash"], version: 2 };
  workers.workers[0]!.emitEvent({ type: "runtime_capabilities_changed", sessionId: "s", capabilities: next });
  await wait();
  assert.deepEqual(service.getSnapshot("s").capabilities, next);
  await service.shutdown();
});

test("set_thinking_level success refreshes authoritative snapshot before command returns", async () => {
  const { service, workers } = harness();
  await service.activate("s");
  const before = service.getSnapshot("s");
  assert.equal(before.state.thinkingLevelPinned, undefined);
  const snapshotsBefore = workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length;

  const result = await service.command("s", { type: "set_thinking_level", commandId: "think-1", level: "high" });
  assert.equal(result.result.ok, true);
  assert.equal(result.result.type, "set_thinking_level");

  // sessiond must have issued a post-success worker.getSnapshot refresh.
  const snapshotsAfter = workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length;
  assert.ok(snapshotsAfter > snapshotsBefore, "expected post-success worker.getSnapshot refresh");

  const snap = service.getSnapshot("s");
  assert.equal(snap.state.thinkingLevel, "high");
  assert.equal(snap.state.thinkingLevelPinned, true);

  // Attach boundary also carries the pin (sessiond projection authority).
  const attach = service.attach({ sessionId: "s" });
  assert.equal(attach.result.snapshot?.state.thinkingLevel, "high");
  assert.equal(attach.result.snapshot?.state.thinkingLevelPinned, true);
  await service.shutdown();
});

test("set_thinking_level same-id second caller waits for deferred authority refresh with one worker.command", async () => {
  const { service, workers } = harness({
    worker: { postCommandSnapshotDelayMs: 80 },
    service: { commandTimeoutMs: 2_000 },
  });
  await service.activate("s");
  const worker = workers.workers[0]!;
  const command = { type: "set_thinking_level" as const, commandId: "think-same", level: "high" as const };

  const first = service.command("s", command);
  // Wait until the worker command result path has started the refresh (pending gone).
  await wait(30);
  let firstSettled = false;
  void first.then(() => { firstSettled = true; });
  await wait(0);
  assert.equal(firstSettled, false, "original caller must not settle while refresh is deferred");

  const second = service.command("s", command);
  let secondSettled = false;
  void second.then(() => { secondSettled = true; });
  await wait(20);
  assert.equal(firstSettled, false);
  assert.equal(secondSettled, false, "same-id caller must join finalization, not settle early");

  const workerCommands = worker.sent.filter((item) => item.type === "worker.command");
  assert.equal(workerCommands.length, 1, "exactly one worker.command for same commandId");

  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.result.ok, true);
  assert.equal(b.result.ok, true);
  assert.deepEqual(a, b);
  assert.equal(service.getSnapshot("s").state.thinkingLevel, "high");
  assert.equal(service.getSnapshot("s").state.thinkingLevelPinned, true);
  await service.shutdown();
});

test("set_thinking_level successful finalization cleans singleflight and cached retry does not refresh again", async () => {
  const { service, workers } = harness();
  await service.activate("s");
  const command = { type: "set_thinking_level" as const, commandId: "think-cleanup", level: "medium" as const };
  const first = await service.command("s", command);
  assert.equal(first.result.ok, true);
  const snapshotsAfterSuccess = workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length;

  // A completed finalization must be gone: the retry comes from the terminal
  // result cache and cannot issue another snapshot refresh or leave cwd busy.
  const retry = await service.command("s", command);
  assert.deepEqual(retry, first);
  assert.equal(
    workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length,
    snapshotsAfterSuccess,
  );
  assert.equal(service.hasBusyCwd("/cwd/s").busy, false);
  await service.shutdown();
});

test("set_thinking_level finalization cleans singleflight when worker crashes before its first microtask", async () => {
  const { service, workers } = harness({
    worker: { commandDelayMs: 5_000 },
    service: { commandTimeoutMs: 500 },
  });
  await service.activate("s");
  const worker = workers.workers[0]!;
  const command = { type: "set_thinking_level" as const, commandId: "think-early-crash", level: "high" as const };
  const pending = service.command("s", command);
  await wait(10);
  const wire = worker.sent.find((item) => item.type === "worker.command");
  assert.ok(wire && wire.type === "worker.command");

  // Deliver a valid worker success, which registers authority finalization, then
  // crash synchronously before its deferred body runs. The final result must be
  // bounded and the singleflight must not remain as permanent busy state.
  worker.emit({
    type: "worker.commandResult",
    id: wire.id,
    payload: {
      sessionId: "s",
      result: { commandId: command.commandId, result: { ok: true, type: "set_thinking_level" } },
    },
  });
  worker.crash();

  const result = await pending;
  assert.equal(result.commandId, command.commandId);
  assert.equal(result.result.ok, false);
  assert.equal(result.result.type, "set_thinking_level");
  if (!result.result.ok) assert.equal(result.result.error.code, "unavailable");
  await wait(0);
  assert.equal(service.hasBusyCwd("/cwd/s").busy, false, "settled finalization must be removed after early crash");
  await service.shutdown();
});

test("set_thinking_level concurrent same-id callers share success after authority refresh", async () => {
  const { service, workers } = harness();
  await service.activate("s");
  const command = { type: "set_thinking_level" as const, commandId: "think-join", level: "medium" as const };
  const [a, b] = await Promise.all([
    service.command("s", command),
    service.command("s", command),
  ]);
  assert.equal(a.result.ok, true);
  assert.equal(b.result.ok, true);
  assert.deepEqual(a, b);
  assert.equal(a.result.type, "set_thinking_level");
  assert.equal(service.getSnapshot("s").state.thinkingLevel, "medium");
  assert.equal(service.getSnapshot("s").state.thinkingLevelPinned, true);
  const workerCommands = workers.workers[0]!.sent.filter((item) => item.type === "worker.command");
  assert.equal(workerCommands.length, 1);
  await service.shutdown();
});

test("set_thinking_level refresh failure fail-closes all observers and cached retry", async () => {
  const { service, workers } = harness({
    worker: { dropPostCommandSnapshots: true },
    service: { commandTimeoutMs: 80 },
  });
  await service.activate("s");
  const command = { type: "set_thinking_level" as const, commandId: "think-fail", level: "high" as const };

  const first = service.command("s", command);
  await wait(10);
  const second = service.command("s", command);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.result.ok, false);
  assert.equal(b.result.ok, false);
  assert.equal(a.result.type, "set_thinking_level");
  assert.equal(b.result.type, "set_thinking_level");
  assert.equal(a.commandId, "think-fail");
  assert.deepEqual(a, b);
  if (!a.result.ok) {
    assert.equal(a.result.error.code, "unavailable");
    assert.equal(typeof a.result.error.message, "string");
    // Fixed message — no raw transport dump.
    assert.match(a.result.error.message, /snapshot|thinking|timed out|authority/i);
  }

  // Projection must not claim the pin after fail-closed authority refresh.
  assert.notEqual(service.getSnapshot("s").state.thinkingLevelPinned, true);

  const commandsBeforeRetry = workers.workers[0]!.sent.filter((item) => item.type === "worker.command").length;
  const snapshotsBeforeRetry = workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length;
  const retry = await service.command("s", command);
  assert.deepEqual(retry, a);
  assert.equal(retry.result.ok, false);
  const commandsAfterRetry = workers.workers[0]!.sent.filter((item) => item.type === "worker.command").length;
  const snapshotsAfterRetry = workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length;
  assert.equal(commandsAfterRetry, commandsBeforeRetry, "cached failure must not re-send worker.command");
  assert.equal(snapshotsAfterRetry, snapshotsBeforeRetry, "cached failure must not re-refresh snapshot");
  await service.shutdown();
});

test("set_thinking_level different commandIds remain independent", async () => {
  const { service, workers } = harness();
  await service.activate("s");
  const [a, b] = await Promise.all([
    service.command("s", { type: "set_thinking_level", commandId: "think-a", level: "low" }),
    service.command("s", { type: "set_thinking_level", commandId: "think-b", level: "high" }),
  ]);
  assert.equal(a.result.ok, true);
  assert.equal(b.result.ok, true);
  assert.equal(a.commandId, "think-a");
  assert.equal(b.commandId, "think-b");
  const workerCommands = workers.workers[0]!.sent.filter((item) => item.type === "worker.command");
  assert.equal(workerCommands.length, 2);
  // Last successful refresh wins on the projection (both applied on worker).
  assert.equal(service.getSnapshot("s").state.thinkingLevelPinned, true);
  await service.shutdown();
});

test("set_model success refreshes authoritative snapshot before command returns", async () => {
  const { service, workers } = harness();
  await service.activate("s");
  const before = service.getSnapshot("s");
  assert.equal(before.state.model, null);
  const snapshotsBefore = workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length;

  const result = await service.command("s", { type: "set_model", commandId: "model-1", provider: "openai", modelId: "gpt-5" });
  assert.equal(result.result.ok, true);
  assert.equal(result.result.type, "set_model");

  // sessiond must have issued a post-success worker.getSnapshot refresh.
  const snapshotsAfter = workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length;
  assert.ok(snapshotsAfter > snapshotsBefore, "expected post-success worker.getSnapshot refresh");

  const snap = service.getSnapshot("s");
  assert.equal(snap.state.model?.provider, "openai");
  assert.equal(snap.state.model?.id, "gpt-5");

  // Attach boundary also carries the new model (sessiond projection authority).
  const attach = service.attach({ sessionId: "s" });
  assert.equal(attach.result.snapshot?.state.model?.provider, "openai");
  assert.equal(attach.result.snapshot?.state.model?.id, "gpt-5");
  await service.shutdown();
});

test("set_model same-id second caller waits for deferred authority refresh with one worker.command", async () => {
  const { service, workers } = harness({
    worker: { postCommandSnapshotDelayMs: 80 },
    service: { commandTimeoutMs: 2_000 },
  });
  await service.activate("s");
  const worker = workers.workers[0]!;
  const command = { type: "set_model" as const, commandId: "model-same", provider: "openai", modelId: "gpt-5" as const };

  const first = service.command("s", command);
  await wait(30);
  let firstSettled = false;
  void first.then(() => { firstSettled = true; });
  await wait(0);
  assert.equal(firstSettled, false, "original caller must not settle while refresh is deferred");

  const second = service.command("s", command);
  let secondSettled = false;
  void second.then(() => { secondSettled = true; });
  await wait(20);
  assert.equal(firstSettled, false);
  assert.equal(secondSettled, false, "same-id caller must join finalization, not settle early");

  const workerCommands = worker.sent.filter((item) => item.type === "worker.command");
  assert.equal(workerCommands.length, 1, "exactly one worker.command for same commandId");

  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.result.ok, true);
  assert.equal(b.result.ok, true);
  assert.deepEqual(a, b);
  assert.equal(service.getSnapshot("s").state.model?.provider, "openai");
  assert.equal(service.getSnapshot("s").state.model?.id, "gpt-5");
  await service.shutdown();
});

test("set_model successful finalization cleans singleflight and cached retry does not refresh again", async () => {
  const { service, workers } = harness();
  await service.activate("s");
  const command = { type: "set_model" as const, commandId: "model-cleanup", provider: "anthropic", modelId: "claude-opus-4" as const };
  const first = await service.command("s", command);
  assert.equal(first.result.ok, true);
  const snapshotsAfterSuccess = workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length;

  const retry = await service.command("s", command);
  assert.deepEqual(retry, first);
  assert.equal(
    workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length,
    snapshotsAfterSuccess,
  );
  assert.equal(service.hasBusyCwd("/cwd/s").busy, false);
  await service.shutdown();
});

test("set_model refresh failure fail-closes all observers and cached retry", async () => {
  const { service, workers } = harness({
    worker: { dropPostCommandSnapshots: true },
    service: { commandTimeoutMs: 80 },
  });
  await service.activate("s");
  const command = { type: "set_model" as const, commandId: "model-fail", provider: "openai", modelId: "gpt-5" as const };

  const first = service.command("s", command);
  await wait(10);
  const second = service.command("s", command);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.result.ok, false);
  assert.equal(b.result.ok, false);
  assert.equal(a.result.type, "set_model");
  assert.equal(b.result.type, "set_model");
  assert.equal(a.commandId, "model-fail");
  assert.deepEqual(a, b);
  if (!a.result.ok) {
    assert.equal(a.result.error.code, "unavailable");
    assert.equal(typeof a.result.error.message, "string");
    // Fixed message — no raw transport dump.
    assert.match(a.result.error.message, /snapshot|authority|timed out/i);
  }

  // Projection must not claim the new model after fail-closed authority refresh.
  assert.equal(service.getSnapshot("s").state.model, null);

  const commandsBeforeRetry = workers.workers[0]!.sent.filter((item) => item.type === "worker.command").length;
  const snapshotsBeforeRetry = workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length;
  const retry = await service.command("s", command);
  assert.deepEqual(retry, a);
  assert.equal(retry.result.ok, false);
  const commandsAfterRetry = workers.workers[0]!.sent.filter((item) => item.type === "worker.command").length;
  const snapshotsAfterRetry = workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length;
  assert.equal(commandsAfterRetry, commandsBeforeRetry, "cached failure must not re-send worker.command");
  assert.equal(snapshotsAfterRetry, snapshotsBeforeRetry, "cached failure must not re-refresh snapshot");
  await service.shutdown();
});

test("set_model wrong result type does not finalize; legitimate frame completes once", async () => {
  const { service, workers } = harness({
    worker: { commandDelayMs: 80 },
    service: { commandTimeoutMs: 500 },
  });
  await service.activate("s");
  const worker = workers.workers[0]!;
  const command = { type: "set_model" as const, commandId: "model-wrongtype", provider: "openai", modelId: "gpt-5" as const };

  const pending = service.command("s", command);
  await wait(10);
  const wire = worker.sent.find((item) => item.type === "worker.command");
  assert.ok(wire && wire.type === "worker.command");
  const wireId = wire.id;

  // Correct wire id + inner commandId but WRONG result type — triple match fails,
  // so no finalization, no cache, no resolve: the waiter keeps waiting.
  worker.emit({
    type: "worker.commandResult",
    id: wireId,
    payload: {
      sessionId: "s",
      result: { commandId: command.commandId, result: { ok: true, type: "set_thinking_level" } },
    },
  });
  await wait(10);
  const snapshotsDuring = worker.sent.filter((item) => item.type === "worker.getSnapshot").length;
  let settled = false;
  void pending.then(() => { settled = true; });
  await wait(0);
  assert.equal(settled, false, "wrong result type must not resolve or start finalization");

  const result = await pending;
  assert.equal(result.commandId, "model-wrongtype");
  assert.equal(result.result.ok, true);
  assert.equal(result.result.type, "set_model");
  assert.equal(worker.sent.filter((item) => item.type === "worker.command").length, 1);
  // The legitimate frame triggered exactly one post-success refresh.
  assert.equal(worker.sent.filter((item) => item.type === "worker.getSnapshot").length, snapshotsDuring + 1);
  assert.equal(service.getSnapshot("s").state.model?.id, "gpt-5");
  await service.shutdown();
});

test("set_model finalization during rekey never writes across epochs and new session can re-admit", async () => {
  const { service, workers } = harness({
    worker: { postCommandSnapshotDelayMs: 200 },
    service: { commandTimeoutMs: 2_000 },
  });
  await service.activate("s");
  const worker = workers.workers[0]!;
  const command = { type: "set_model" as const, commandId: "model-rekey", provider: "openai", modelId: "gpt-5" as const };

  const pending = service.command("s", command);
  // Wait until finalization is registered (post-success refresh in flight).
  await wait(30);
  worker.emit({ type: "worker.sessionDiscovered", payload: { sessionId: "real-s", sessionFile: "/sessions/real-s.jsonl", cwd: "/cwd/s" } });
  await wait(10);

  const result = await pending;
  assert.equal(result.commandId, "model-rekey");
  assert.equal(result.result.ok, false);
  if (!result.result.ok) assert.equal(result.result.error.code, "unavailable");

  // Old id is gone; rekeyed record must not carry the fail-closed result across epoch.
  assert.throws(() => service.getSnapshot("s"));
  assert.equal(service.getSnapshot("real-s").state.model, null, "no cross-epoch model write");

  // Same commandId can be re-admitted in the new epoch (acceptedCommands cleared).
  const readmitted = await service.command("real-s", command);
  assert.equal(readmitted.result.ok, true);
  assert.equal(service.getSnapshot("real-s").state.model?.provider, "openai");
  assert.equal(service.getSnapshot("real-s").state.model?.id, "gpt-5");
  await service.shutdown();
});

test("ordinary rename does not issue extra post-command snapshot refresh", async () => {
  const { service, workers } = harness();
  await service.activate("s");
  const snapshotsBefore = workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length;
  const result = await service.command("s", { type: "set_session_name", commandId: "rename-1", name: "Renamed" });
  assert.equal(result.result.ok, true);
  assert.equal(result.result.type, "set_session_name");
  const snapshotsAfter = workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length;
  assert.equal(snapshotsAfter, snapshotsBefore, "non-thinking commands must not refresh snapshot");
  await service.shutdown();
});

test("commandResult with wrong inner commandId is dropped; legitimate frame still completes once", async () => {
  const { service, workers } = harness({
    worker: { commandDelayMs: 80 },
    service: { commandTimeoutMs: 500 },
  });
  await service.activate("s");
  const worker = workers.workers[0]!;
  const command = { type: "set_session_name" as const, commandId: "rename-ok", name: "Final" };

  const pending = service.command("s", command);
  await wait(10);
  const wire = worker.sent.find((item) => item.type === "worker.command");
  assert.ok(wire && wire.type === "worker.command");
  const wireId = wire.id;

  // Correct wire id, wrong inner commandId — must not clear pending / cache / resolve.
  worker.emit({
    type: "worker.commandResult",
    id: wireId,
    payload: {
      sessionId: "s",
      result: {
        commandId: "evil-other-id",
        result: { ok: true, type: "set_session_name" },
      },
    },
  });
  await wait(10);

  let settled = false;
  void pending.then(() => { settled = true; });
  await wait(0);
  assert.equal(settled, false, "malformed inner commandId must not resolve the waiter");

  const result = await pending;
  assert.equal(result.commandId, "rename-ok");
  assert.equal(result.result.ok, true);
  assert.equal(result.result.type, "set_session_name");

  // Cached retry returns the legitimate result exactly once at the worker.
  const retry = await service.command("s", command);
  assert.deepEqual(retry, result);
  assert.equal(worker.sent.filter((item) => item.type === "worker.command").length, 1);
  await service.shutdown();
});

test("commandResult with wrong inner result.type is dropped; legitimate frame still completes once", async () => {
  const { service, workers } = harness({
    worker: { commandDelayMs: 80 },
    service: { commandTimeoutMs: 500 },
  });
  await service.activate("s");
  const worker = workers.workers[0]!;
  const command = { type: "set_session_name" as const, commandId: "rename-type", name: "Typed" };

  const pending = service.command("s", command);
  await wait(10);
  const wire = worker.sent.find((item) => item.type === "worker.command");
  assert.ok(wire && wire.type === "worker.command");

  // Correct wire id + commandId, wrong result.type.
  worker.emit({
    type: "worker.commandResult",
    id: wire.id,
    payload: {
      sessionId: "s",
      result: {
        commandId: "rename-type",
        result: { ok: true, type: "prompt" },
      },
    },
  });
  await wait(10);

  let settled = false;
  void pending.then(() => { settled = true; });
  await wait(0);
  assert.equal(settled, false, "malformed inner result.type must not resolve the waiter");

  const result = await pending;
  assert.equal(result.commandId, "rename-type");
  assert.equal(result.result.ok, true);
  assert.equal(result.result.type, "set_session_name");

  const retry = await service.command("s", command);
  assert.deepEqual(retry, result);
  assert.equal(worker.sent.filter((item) => item.type === "worker.command").length, 1);
  await service.shutdown();
});

test("only malformed commandResult frames time out unavailable without caching wrong result", async () => {
  const { service, workers } = harness({
    worker: { commandDelayMs: 5_000 },
    service: { commandTimeoutMs: 80 },
  });
  await service.activate("s");
  const worker = workers.workers[0]!;
  const command = { type: "set_session_name" as const, commandId: "rename-timeout", name: "Never" };

  const pending = service.command("s", command);
  await wait(10);
  const wire = worker.sent.find((item) => item.type === "worker.command");
  assert.ok(wire && wire.type === "worker.command");

  worker.emit({
    type: "worker.commandResult",
    id: wire.id,
    payload: {
      sessionId: "s",
      result: {
        commandId: "wrong-id",
        result: {
          ok: false,
          type: "set_session_name",
          error: { code: "unavailable", message: "RAW_TRANSPORT_LEAK_SHOULD_NOT_SURFACE", retryable: true },
        },
      },
    },
  });
  worker.emit({
    type: "worker.commandResult",
    id: wire.id,
    payload: {
      sessionId: "s",
      result: {
        commandId: "rename-timeout",
        result: { ok: true, type: "prompt" },
      },
    },
  });

  const result = await pending;
  assert.equal(result.commandId, "rename-timeout");
  assert.equal(result.result.ok, false);
  assert.equal(result.result.type, "set_session_name");
  if (!result.result.ok) {
    assert.equal(result.result.error.code, "unavailable");
    assert.match(result.result.error.message, /timed out/i);
    assert.doesNotMatch(result.result.error.message, /RAW_TRANSPORT_LEAK/);
  }

  // Timeout is cached as unavailable so retries do not re-send; never the malformed payload.
  const commandsBefore = worker.sent.filter((item) => item.type === "worker.command").length;
  const retry = await service.command("s", command);
  assert.deepEqual(retry, result);
  assert.equal(worker.sent.filter((item) => item.type === "worker.command").length, commandsBefore);
  await service.shutdown();
});

test("malformed thinking success does not start snapshot authority or pollute cache/projection", async () => {
  const { service, workers } = harness({
    worker: { commandDelayMs: 5_000 },
    service: { commandTimeoutMs: 100 },
  });
  await service.activate("s");
  const worker = workers.workers[0]!;
  const snapshotsBefore = worker.sent.filter((item) => item.type === "worker.getSnapshot").length;
  const before = service.getSnapshot("s");
  assert.notEqual(before.state.thinkingLevelPinned, true);

  const command = { type: "set_thinking_level" as const, commandId: "think-malformed", level: "high" as const };
  const pending = service.command("s", command);
  await wait(10);
  const wire = worker.sent.find((item) => item.type === "worker.command");
  assert.ok(wire && wire.type === "worker.command");

  // Wrong inner commandId pretending to be a thinking success.
  worker.emit({
    type: "worker.commandResult",
    id: wire.id,
    payload: {
      sessionId: "s",
      result: {
        commandId: "forged-think",
        result: { ok: true, type: "set_thinking_level" },
      },
    },
  });
  // Correct commandId but wrong type (still looks "successful" for another command).
  worker.emit({
    type: "worker.commandResult",
    id: wire.id,
    payload: {
      sessionId: "s",
      result: {
        commandId: "think-malformed",
        result: { ok: true, type: "set_session_name" },
      },
    },
  });
  await wait(20);

  const snapshotsMid = worker.sent.filter((item) => item.type === "worker.getSnapshot").length;
  assert.equal(snapshotsMid, snapshotsBefore, "malformed thinking success must not issue getSnapshot");
  assert.notEqual(service.getSnapshot("s").state.thinkingLevelPinned, true);

  const result = await pending;
  assert.equal(result.commandId, "think-malformed");
  assert.equal(result.result.ok, false);
  assert.equal(result.result.type, "set_thinking_level");
  if (!result.result.ok) {
    assert.equal(result.result.error.code, "unavailable");
    assert.match(result.result.error.message, /timed out/i);
  }

  const snapshotsAfter = worker.sent.filter((item) => item.type === "worker.getSnapshot").length;
  assert.equal(snapshotsAfter, snapshotsBefore, "timeout path must not refresh thinking projection");
  assert.notEqual(service.getSnapshot("s").state.thinkingLevelPinned, true);
  assert.notEqual(service.getSnapshot("s").state.thinkingLevel, "high");

  const commandsBefore = worker.sent.filter((item) => item.type === "worker.command").length;
  const retry = await service.command("s", command);
  assert.deepEqual(retry, result);
  assert.equal(worker.sent.filter((item) => item.type === "worker.command").length, commandsBefore);
  await service.shutdown();
});

test("late commandResult after timeout is dropped and does not overwrite timeout cache", async () => {
  const { service, workers } = harness({
    worker: { commandDelayMs: 5_000 },
    service: { commandTimeoutMs: 60 },
  });
  await service.activate("s");
  const worker = workers.workers[0]!;
  const command = { type: "set_session_name" as const, commandId: "late-frame", name: "Late" };

  const result = await service.command("s", command);
  assert.equal(result.result.ok, false);
  if (!result.result.ok) assert.equal(result.result.error.code, "unavailable");

  const wire = worker.sent.find((item) => item.type === "worker.command");
  assert.ok(wire && wire.type === "worker.command");

  // Late legitimate-looking frame after timeout cleared pending — must be dropped.
  worker.emit({
    type: "worker.commandResult",
    id: wire.id,
    payload: {
      sessionId: "s",
      result: {
        commandId: "late-frame",
        result: { ok: true, type: "set_session_name" },
      },
    },
  });
  await wait(10);

  const retry = await service.command("s", command);
  assert.deepEqual(retry, result);
  assert.equal(retry.result.ok, false);
  if (!retry.result.ok) assert.equal(retry.result.error.code, "unavailable");
  assert.equal(worker.sent.filter((item) => item.type === "worker.command").length, 1);
  await service.shutdown();
});

test("read-only snapshot and catalog operations never activate a worker", async () => {
  const { service, workers } = harness();
  assert.throws(() => service.getSnapshot("missing"));
  const app = new SessiondApplication(service);
  await app.handle("sessions.list", {});
  assert.equal(workers.starts, 0);
});

test("sessions.list forwards cwd/limit/offset and sessions.context forwards leafId to the catalog", async () => {
  const listCalls: Array<Record<string, unknown>> = [];
  const contextCalls: Array<{ sessionId: string; leafId?: string }> = [];
  const catalog: SessionCatalogPort = {
    async listSessions(filter) {
      listCalls.push({ ...(filter?.cwd === undefined ? {} : { cwd: filter.cwd }), ...(filter?.limit === undefined ? {} : { limit: filter.limit }), ...(filter?.offset === undefined ? {} : { offset: filter.offset }) });
      return [];
    },
    async readSession(sessionId) { return { sessionId, cwd: "/workspace", projectRoot: "/workspace", entries: [] }; },
    async readSessionContext(sessionId, options) {
      contextCalls.push({ sessionId, ...(options?.leafId === undefined ? {} : { leafId: options.leafId }) });
      return { sessionId, entries: [] };
    },
    async deleteSession() {},
  };
  const service = new SessiondService(
    { sessionLocator: { async locate(sessionId) { return { sessionId, sessionFile: `/s/${sessionId}.jsonl`, exists: true }; }, async resolveLeafId() { return "leaf"; } }, activationContext: { async resolve(_id, _loc, cwd) { return { cwd: cwd ?? "/w", projectRoot: cwd ?? "/w" }; } }, workerFactory: new FakeWorkerFactory(), sessionCatalog: catalog },
    { workerStartTimeoutMs: 500, commandTimeoutMs: 500, idleTimeoutMs: 0 },
  );
  const app = new SessiondApplication(service);
  try {
    await app.handle("sessions.list", { cwd: "/proj", limit: 5, offset: 10 });
    await app.handle("sessions.context", { sessionId: "s-1", leafId: "entry-7" });
    await app.handle("sessions.context", { sessionId: "s-2" });
    assert.deepEqual(listCalls, [{ cwd: "/proj", limit: 5, offset: 10 }]);
    assert.deepEqual(contextCalls, [{ sessionId: "s-1", leafId: "entry-7" }, { sessionId: "s-2" }]);
  } finally {
    await service.shutdown();
  }
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
  try {
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
  } finally {
    await server.close().catch(() => {});
    await service.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("RPC attach subscription closed settles exactly once on local and remote close", async (t) => {
  if (process.platform === "win32") return t.skip("unix socket test");
  // local close() settles closed
  {
    const directory = await mkdtemp(join(tmpdir(), "sessiond-closed-local-"));
    const endpoint = join(directory, "rpc.sock");
    const { service } = harness();
    const server = new SessiondRpcServer({ endpoint, secret: "a".repeat(40), handler: new SessiondApplication(service) });
    await server.listen();
    try {
      const good = new SessiondRpcClient({ endpoint, secret: "a".repeat(40), timeoutMs: 500 });
      await good.call("system.ping", {});
      const active = await good.call("runtime.activate", { sessionId: "s-local" });
      const subscription = await good.attach({ sessionId: "s-local", epoch: active.epoch, lastEventId: 0 }, async () => {});
      subscription.close();
      await subscription.closed; // resolves without error
    } finally {
      await server.close().catch(() => {});
      await service.shutdown().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  }
  // unexpected server-side close settles closed
  {
    const directory = await mkdtemp(join(tmpdir(), "sessiond-closed-remote-"));
    const endpoint = join(directory, "rpc.sock");
    const { service } = harness();
    const server = new SessiondRpcServer({ endpoint, secret: "a".repeat(40), handler: new SessiondApplication(service) });
    await server.listen();
    try {
      const good = new SessiondRpcClient({ endpoint, secret: "a".repeat(40), timeoutMs: 500 });
      await good.call("system.ping", {});
      const active = await good.call("runtime.activate", { sessionId: "s-remote" });
      const subscription = await good.attach({ sessionId: "s-remote", epoch: active.epoch, lastEventId: 0 }, async () => {});
      await server.close(); // destroys the socket unexpectedly
      await subscription.closed; // resolves without error
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("RPC attach rejects before the attach response arrives", async (t) => {
  if (process.platform === "win32") return t.skip("unix socket test");
  const directory = await mkdtemp(join(tmpdir(), "sessiond-closed-reject-"));
  const endpoint = join(directory, "rpc.sock");
  const { service } = harness();
  const server = new SessiondRpcServer({ endpoint, secret: "a".repeat(40), handler: new SessiondApplication(service) });
  await server.listen();
  try {
    const wrong = new SessiondRpcClient({ endpoint, secret: "a".repeat(40), timeoutMs: 500 });
    // attach to an unknown session → worker_unavailable/worker error before response
    await assert.rejects(wrong.attach({ sessionId: "never" }, async () => {}));
  } finally {
    await server.close().catch(() => {});
    await service.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// RPC disconnect crash-safety (regression for the production fatal chain:
// slow valid RPC > client timeout > late handler completion > server writes on
// a closed writer > fire-and-forget `process` rejection kills the daemon).
// ---------------------------------------------------------------------------

const gatedHandler = (gate: Promise<void>): SessiondRpcHandler => {
  const handler = {
    async handle(method: string, params: unknown): Promise<unknown> {
      if (method === "system.ping") return { pong: true };
      if (method === "runtime.command") {
        await gate;
        const command = (params as { command: { commandId: string } }).command;
        return { commandId: command.commandId, result: { ok: true, type: "set_thinking_level" } };
      }
      return { ok: true };
    },
  } as unknown as SessiondRpcHandler;
  return handler;
};

const commandParams = (id: string): SessiondMethodParams["runtime.command"] => ({
  sessionId: "s",
  command: { commandId: id, type: "prompt", message: "hello" },
});

const commandEnvelope = (id: string): SessiondRpcRequest => ({
  protocolVersion: PROTOCOL_VERSION,
  id,
  method: "runtime.command",
  params: commandParams(id),
});

function collectLines(socket: import("node:net").Socket): { lines: string[]; waitFor(predicate: (line: string) => boolean, timeoutMs?: number): Promise<string> } {
  const lines: string[] = [];
  let buffer = "";
  const waiters: Array<{ pred: (line: string) => boolean; resolve: (line: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      lines.push(line);
      for (let i = 0; i < waiters.length; i += 1) {
        if (waiters[i]!.pred(line)) {
          const waiter = waiters.splice(i, 1)[0]!;
          clearTimeout(waiter.timer);
          waiter.resolve(line);
          i -= 1;
        }
      }
    }
  });
  return {
    lines,
    waitFor(predicate, timeoutMs = 2_000) {
      const existing = lines.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolvePromise, reject) => {
        const waiter = {
          pred: predicate,
          resolve: resolvePromise,
          reject,
          timer: setTimeout(() => {
            const idx = waiters.indexOf(waiter);
            if (idx >= 0) waiters.splice(idx, 1);
            reject(new Error(`timeout waiting for line; saw=${lines.join("|")}`));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
  };
}

test("RPC server survives client timeout + late command completion without unhandled rejection", async (t) => {
  if (process.platform === "win32") return t.skip("unix socket test");
  const directory = await mkdtemp(join(tmpdir(), "sessiond-rpc-late-"));
  const endpoint = join(directory, "rpc.sock");
  let resolveCommand!: () => void;
  const gate = new Promise<void>((resolvePromise) => { resolveCommand = resolvePromise; });
  const logs: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const server = new SessiondRpcServer({ endpoint, secret: "a".repeat(40), handler: gatedHandler(gate), logger: (line) => logs.push(line) });
    await server.listen();
    const client = new SessiondRpcClient({ endpoint, secret: "a".repeat(40), timeoutMs: 120 });
    const late = client.call("runtime.command", commandParams("cc1")).then(
      () => ({ ok: true }),
      () => ({ ok: false }),
    );
    await wait(220); // client timeout fires, socket destroyed; server still gated on the command
    resolveCommand(); // handler completes long after the client gave up → server writes on closed writer
    assert.equal((await late).ok, false, "client must have observed the timeout");
    await wait(60);
    assert.equal((await client.call("system.ping", {})).pong, true, "server must still answer a fresh command");
    assert.ok(logs.some((line) => line.includes("dropped")), "late response must be dropped and logged, not crash");
    await server.close();
    assert.deepEqual(unhandled, [], "no unhandled rejection may escape the server");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await rm(directory, { recursive: true, force: true });
  }
});

test("RPC throwing logger never produces an unhandled rejection (late drop + outer process catch)", async (t) => {
  if (process.platform === "win32") return t.skip("unix socket test");
  const directory = await mkdtemp(join(tmpdir(), "sessiond-rpc-logger-throws-"));
  const endpoint = join(directory, "rpc.sock");
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const logs: string[] = [];
    const throwingLogger = (line: string): void => { logs.push(line); throw new Error("logger boom"); };
    const closeBoom = new Error("attach close boom");
    const flushBoom = new Error("attach flush boom");
    let resolveCommand!: () => void;
    const gate = new Promise<void>((resolvePromise) => { resolveCommand = resolvePromise; });
    const handler: SessiondRpcHandler = {
      async handle(method: string, params: unknown): Promise<unknown> {
        if (method === "system.ping") return { pong: true };
        if (method === "runtime.command") {
          await gate;
          const command = (params as { command: { commandId: string } }).command;
          return { commandId: command.commandId, result: { ok: true, type: "set_thinking_level" } };
        }
        return { ok: true };
      },
      attach() {
        let closeCalls = 0;
        // Attachment whose flush fails AND whose FIRST close() throws: the close()
        // throw escapes the attach catch, so `process` rejects and the fire-and-forget
        // `.catch(error => this.log(...))` runs — with a throwing logger. Later
        // close() calls (socket teardown) are a no-op.
        return {
          result: {
            sessionId: "s", epoch: "e1", lastEventId: 0, cwd: "/w", projectRoot: "/w",
            workerStatus: "ready", resumeStatus: "snapshot", snapshot: snapshot("s", "/w", "/w"),
          } as SessiondRuntimeAttachResult,
          replay: [],
          async flushTo() { throw flushBoom; },
          close() {
            closeCalls += 1;
            if (closeCalls === 1) throw closeBoom;
          },
        };
      },
    } as unknown as SessiondRpcHandler;
    const server = new SessiondRpcServer({ endpoint, secret: "a".repeat(40), handler, logger: throwingLogger });
    await server.listen();
    const lateClient = new SessiondRpcClient({ endpoint, secret: "a".repeat(40), timeoutMs: 120 });
    // (a) late-response drop path: client times out, command completes late → logDrop invokes the throwing logger.
    const late = lateClient.call("runtime.command", commandParams("cc-throw")).then(
      () => ({ ok: true }),
      () => ({ ok: false }),
    );
    await wait(200); // client timeout (120ms) fires, socket destroyed; server still gated
    resolveCommand();
    await late;
    await wait(60);
    // (b) outer process-catch path: attach flush fails AND attachment.close() throws → process rejects → .catch logs with throwing logger.
    const socket = createConnection(endpoint);
    await new Promise<void>((resolvePromise) => socket.once("connect", () => resolvePromise()));
    const reader = collectLines(socket);
    socket.write(`AUTH ${"a".repeat(40)}\n`);
    assert.equal(await reader.waitFor((line) => line === "OK"), "OK");
    socket.write(`${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, id: "att-throw", method: "runtime.attach", params: { sessionId: "s" } })}\n`);
    await reader.waitFor((line) => line.includes("att-throw")); // attach response written; then flush fails and close() throws
    await wait(80);
    socket.destroy();
    // The server must still answer a fresh command.
    const pingClient = new SessiondRpcClient({ endpoint, secret: "a".repeat(40), timeoutMs: 500 });
    assert.equal((await pingClient.call("system.ping", {})).pong, true, "server must survive a throwing logger on every log path");
    assert.ok(logs.length >= 2, `both log paths must have invoked the logger; got ${logs.length}`);
    await server.close();
    assert.deepEqual(unhandled, [], "a throwing logger must never surface an unhandled rejection");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await rm(directory, { recursive: true, force: true });
  }
});

test("RPC server survives a peer closing mid-flight and the late handler completion", async (t) => {
  if (process.platform === "win32") return t.skip("unix socket test");
  const directory = await mkdtemp(join(tmpdir(), "sessiond-rpc-midflight-"));
  const endpoint = join(directory, "rpc.sock");
  let resolveCommand!: () => void;
  const gate = new Promise<void>((resolvePromise) => { resolveCommand = resolvePromise; });
  const server = new SessiondRpcServer({ endpoint, secret: "a".repeat(40), handler: gatedHandler(gate), logger: () => {} });
  await server.listen();
  try {
    const socket = createConnection(endpoint);
    await new Promise<void>((resolvePromise) => socket.once("connect", () => resolvePromise()));
    const reader = collectLines(socket);
    socket.write(`AUTH ${"a".repeat(40)}\n`);
    assert.equal(await reader.waitFor((line) => line === "OK"), "OK");
    socket.write(`${JSON.stringify(commandEnvelope("mid-1"))}\n`);
    await wait(40); // server received and gated the command
    socket.destroy(); // peer vanishes mid-flight
    await wait(40);
    resolveCommand(); // handler completes after the peer is gone
    await wait(60);
    const client = new SessiondRpcClient({ endpoint, secret: "a".repeat(40), timeoutMs: 500 });
    assert.equal((await client.call("system.ping", {})).pong, true, "server must survive and stay responsive");
  } finally {
    await server.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("RPC invalid JSON with a live connection still delivers invalid_request", async (t) => {
  if (process.platform === "win32") return t.skip("unix socket test");
  const directory = await mkdtemp(join(tmpdir(), "sessiond-rpc-invalid-live-"));
  const endpoint = join(directory, "rpc.sock");
  const server = new SessiondRpcServer({ endpoint, secret: "a".repeat(40), handler: gatedHandler(Promise.resolve()), logger: () => {} });
  await server.listen();
  try {
    const socket = createConnection(endpoint);
    await new Promise<void>((resolvePromise) => socket.once("connect", () => resolvePromise()));
    const reader = collectLines(socket);
    socket.write(`AUTH ${"a".repeat(40)}\n`);
    assert.equal(await reader.waitFor((line) => line === "OK"), "OK");
    socket.write("this is not json\n");
    const response = JSON.parse(await reader.waitFor((line) => line.includes("invalid_request")));
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "invalid_request");
    socket.destroy();
  } finally {
    await server.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("RPC invalid JSON then immediate close settles without crashing", async (t) => {
  if (process.platform === "win32") return t.skip("unix socket test");
  const directory = await mkdtemp(join(tmpdir(), "sessiond-rpc-invalid-close-"));
  const endpoint = join(directory, "rpc.sock");
  const server = new SessiondRpcServer({ endpoint, secret: "a".repeat(40), handler: gatedHandler(Promise.resolve()), logger: () => {} });
  await server.listen();
  try {
    const socket = createConnection(endpoint);
    await new Promise<void>((resolvePromise) => socket.once("connect", () => resolvePromise()));
    socket.write(`AUTH ${"a".repeat(40)}\n`);
    await wait(30);
    socket.write("this is not json\n");
    socket.destroy(); // close before the invalid-input failure write is processed
    await wait(50);
    const client = new SessiondRpcClient({ endpoint, secret: "a".repeat(40), timeoutMs: 500 });
    assert.equal((await client.call("system.ping", {})).pong, true, "server must survive an invalid frame followed by immediate close");
  } finally {
    await server.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("RPC invalid schema then immediate close settles without crashing", async (t) => {
  if (process.platform === "win32") return t.skip("unix socket test");
  const directory = await mkdtemp(join(tmpdir(), "sessiond-rpc-schema-close-"));
  const endpoint = join(directory, "rpc.sock");
  const server = new SessiondRpcServer({ endpoint, secret: "a".repeat(40), handler: gatedHandler(Promise.resolve()), logger: () => {} });
  await server.listen();
  try {
    const socket = createConnection(endpoint);
    await new Promise<void>((resolvePromise) => socket.once("connect", () => resolvePromise()));
    socket.write(`AUTH ${"a".repeat(40)}\n`);
    await wait(30);
    socket.write(`${JSON.stringify({ id: "x", method: "system.ping" })}\n`); // missing protocolVersion/params → schema fail
    socket.destroy();
    await wait(50);
    const client = new SessiondRpcClient({ endpoint, secret: "a".repeat(40), timeoutMs: 500 });
    assert.equal((await client.call("system.ping", {})).pong, true, "server must survive a schema-invalid frame followed by immediate close");
  } finally {
    await server.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("RPC live schema-invalid ping result returns a sanitized internal failure, not a timeout", async (t) => {
  if (process.platform === "win32") return t.skip("unix socket test");
  const directory = await mkdtemp(join(tmpdir(), "sessiond-rpc-schema-invalid-"));
  const endpoint = join(directory, "rpc.sock");
  const handler = {
    async handle(method: string): Promise<unknown> {
      if (method === "system.ping") return { pong: false }; // schema-invalid result
      return { ok: true };
    },
  } as unknown as SessiondRpcHandler;
  const server = new SessiondRpcServer({ endpoint, secret: "a".repeat(40), handler, logger: () => {} });
  await server.listen();
  try {
    const client = new SessiondRpcClient({ endpoint, secret: "a".repeat(40), timeoutMs: 800 });
    await assert.rejects(
      client.call("system.ping", {}),
      (error: unknown) => error instanceof SessiondError && error.code === "internal" && error.retryable === false,
    );
  } finally {
    await server.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("RPC runtime.attach without a handler.attach fallback returns a sanitized internal failure, not a timeout", async (t) => {
  if (process.platform === "win32") return t.skip("unix socket test");
  const directory = await mkdtemp(join(tmpdir(), "sessiond-rpc-attach-noattach-"));
  const endpoint = join(directory, "rpc.sock");
  // handler with NO attach(): runtime.attach falls through to dispatchHandler,
  // whose generic result is not a valid attach result -> schema validation fails
  // on the live connection and must surface as a sanitized internal failure.
  const handler = {
    async handle(method: string): Promise<unknown> {
      if (method === "system.ping") return { pong: true };
      return { ok: true };
    },
  } as unknown as SessiondRpcHandler;
  const server = new SessiondRpcServer({ endpoint, secret: "a".repeat(40), handler, logger: () => {} });
  await server.listen();
  try {
    const client = new SessiondRpcClient({ endpoint, secret: "a".repeat(40), timeoutMs: 800 });
    await assert.rejects(
      client.attach({ sessionId: "s" }, async () => {}),
      (error: unknown) => error instanceof SessiondError && error.code === "internal" && error.retryable === false,
    );
  } finally {
    await server.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("RPC schema-invalid result on a closed writer is safely dropped without unhandled rejection", async (t) => {
  if (process.platform === "win32") return t.skip("unix socket test");
  const directory = await mkdtemp(join(tmpdir(), "sessiond-rpc-schema-closed-"));
  const endpoint = join(directory, "rpc.sock");
  let resolveCommand!: () => void;
  const gate = new Promise<void>((resolvePromise) => { resolveCommand = resolvePromise; });
  const handler = {
    async handle(method: string): Promise<unknown> {
      if (method === "system.ping") return { pong: true };
      if (method === "runtime.command") {
        await gate;
        return { pong: false }; // schema-invalid command result
      }
      return { ok: true };
    },
  } as unknown as SessiondRpcHandler;
  const logs: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const server = new SessiondRpcServer({ endpoint, secret: "a".repeat(40), handler, logger: (line) => logs.push(line) });
    await server.listen();
    const socket = createConnection(endpoint);
    await new Promise<void>((resolvePromise) => socket.once("connect", () => resolvePromise()));
    const reader = collectLines(socket);
    socket.write(`AUTH ${"a".repeat(40)}\n`);
    assert.equal(await reader.waitFor((line) => line === "OK"), "OK");
    socket.write(`${JSON.stringify(commandEnvelope("cc-schema"))}\n`);
    await wait(40); // server received and gated the command
    socket.destroy(); // peer gone -> writer closes
    await wait(60); // server observes close
    resolveCommand(); // handler completes with a schema-invalid result on the CLOSED writer
    await wait(80);
    assert.ok(logs.some((line) => line.includes("dropped")), "closed-writer schema failure must be logged as a drop");
    const ping = new SessiondRpcClient({ endpoint, secret: "a".repeat(40), timeoutMs: 500 });
    assert.equal((await ping.call("system.ping", {})).pong, true, "server must stay responsive");
    await server.close();
    assert.deepEqual(unhandled, [], "closed-writer schema failure must not produce an unhandled rejection");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await rm(directory, { recursive: true, force: true });
  }
});

test("RPC logs never echo dynamic SessiondError messages (secret marker probe)", async (t) => {
  if (process.platform === "win32") return t.skip("unix socket test");
  const directory = await mkdtemp(join(tmpdir(), "sessiond-rpc-secret-"));
  const endpoint = join(directory, "rpc.sock");
  const secretMarker = "TOP-SECRET-MARKER-7f3a9c";
  let resolveCommand!: () => void;
  const gate = new Promise<void>((resolvePromise) => { resolveCommand = resolvePromise; });
  const handler = {
    async handle(method: string): Promise<unknown> {
      if (method === "system.ping") return { pong: true };
      if (method === "runtime.command") {
        await gate;
        throw new SessiondError("internal", `command failed with ${secretMarker}`, false);
      }
      return { ok: true };
    },
  } as unknown as SessiondRpcHandler;
  const logs: string[] = [];
  const server = new SessiondRpcServer({ endpoint, secret: "a".repeat(40), handler, logger: (line) => logs.push(line) });
  await server.listen();
  try {
    const socket = createConnection(endpoint);
    await new Promise<void>((resolvePromise) => socket.once("connect", () => resolvePromise()));
    const reader = collectLines(socket);
    socket.write(`AUTH ${"a".repeat(40)}\n`);
    assert.equal(await reader.waitFor((line) => line === "OK"), "OK");
    socket.write(`${JSON.stringify(commandEnvelope("cc-secret"))}\n`);
    await wait(40); // server received and gated the command
    socket.destroy(); // peer gone -> writer closes
    await wait(60);
    resolveCommand(); // handler throws a dynamic-message internal error on the CLOSED writer
    await wait(80);
    assert.ok(logs.some((line) => line.includes("dropped")), "drop must be logged");
    for (const line of logs) {
      assert.equal(line.includes(secretMarker), false, `log leaked dynamic SessiondError message: ${line}`);
    }
    const ping = new SessiondRpcClient({ endpoint, secret: "a".repeat(40), timeoutMs: 500 });
    assert.equal((await ping.call("system.ping", {})).pong, true, "server must stay responsive");
  } finally {
    await server.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("RPC server survives late completion in a child process under Node default throw", async (t) => {
  if (process.platform === "win32") return t.skip("unix socket test");
  const fixture = resolve(here, "fixtures/fixture-rpc-late-crash.mjs");
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise) => {
    const child = spawn(process.execPath, [fixture], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    let settled = false;
    const settle = (code: number | null, diagnostic?: string): void => {
      if (settled) return; // close may follow error; settle exactly once
      settled = true;
      if (diagnostic) stderr += `\n${diagnostic}`;
      child.kill(); // safety no-op: the child has already exited (or failed to spawn)
      resolvePromise({ code, stdout, stderr });
    };
    child.on("error", (error) => settle(-1, String(error)));
    child.on("close", (code) => settle(code));
  });
  assert.equal(result.code, 0, `child exited ${result.code} (unhandled rejection escaped); stderr=${result.stderr}; stdout=${result.stdout}`);
  assert.match(result.stdout, /SURVIVED/);
});
