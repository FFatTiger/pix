import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { RuntimeCapabilitySet, RuntimeSnapshot, SessiondMethodParams, SessiondRpcRequest, SessiondRuntimeAttachResult } from "@fffattiger/pix-protocol";
import { PROTOCOL_VERSION } from "@fffattiger/pix-protocol";
import { makeRuntimeError, type SessionCatalogPort, type SessionLocatorPort } from "@fffattiger/pix-runtime-core";
import { SessiondApplication } from "../src/application.js";
import { EventJournal } from "../src/journal.js";
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
  streaming: { active: false, phase: "idle" },
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
    async readSessionContext(sessionId) { return { sessionId, entries: [], pageInfo: { hasMore: false } }; },
    async readSessionTree(sessionId) { return { sessionId, roots: [], entryCount: 0 }; },
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
  assert.equal(boundary, baseline + 2);
  assert.equal(pushes.length, 5);
  assert.deepEqual(pushes.map((push) => (push as { event: { eventId: number } }).event.eventId), [baseline + 1, baseline + 2, baseline + 3, baseline + 4, baseline + 5]);
  attached.close();
  await service.shutdown();
});

test("turn busy flips broadcast authoritative global busy session ids", async () => {
  const { service, workers } = harness();
  const activated = await service.activate("s");
  const pushes: Array<{ type: string; event?: { type: string; busySessionIds?: string[] } }> = [];
  const attached = service.prepareAttach({ sessionId: "s", epoch: activated.epoch, lastEventId: 0 });

  workers.workers[0]!.emitEvent({ type: "agent_start", sessionId: "s" });
  await wait();
  assert.equal(service.listRunning().sessions.find((item) => item.sessionId === "s")?.workerStatus, "busy");
  workers.workers[0]!.emitEvent({ type: "agent_end", sessionId: "s" });
  await wait();
  assert.equal(service.listRunning().sessions.find((item) => item.sessionId === "s")?.workerStatus, "ready");
  await attached.flushTo(async (push) => { pushes.push(push as typeof pushes[number]); });
  const started = pushes.find((push) => push.type === "event" && push.event?.type === "running_sessions_changed" && push.event.busySessionIds?.includes("s"));
  assert.ok(started, "agent_start broadcasts s as busy");
  const ended = pushes.find((push) => push.type === "event" && push.event?.type === "running_sessions_changed" && push.event.busySessionIds?.length === 0);
  assert.ok(ended, "agent_end broadcasts an empty busy set");

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

test("extension UI close tombstone removes a pending request and unknown close is a no-op", () => {
  const projection = new SnapshotProjection(snapshot("s"));
  projection.apply({ type: "extension_ui_request", sessionId: "s", request: { id: "ui", method: "confirm", title: "t", message: "m" } });
  assert.equal(projection.snapshot().state.pendingExtensionUi?.length, 1);
  assert.equal(projection.snapshot().state.pendingExtensionUi?.[0]?.id, "ui");
  // canonical close tombstone: removed, never stored.
  projection.apply({ type: "extension_ui_request", sessionId: "s", request: { id: "ui", method: "confirm", title: "t", message: "m", closed: true } });
  assert.equal(projection.snapshot().state.pendingExtensionUi?.length ?? 0, 0);
  // unknown close is an idempotent no-op.
  projection.apply({ type: "extension_ui_request", sessionId: "s", request: { id: "ghost", method: "confirm", title: "t", message: "m", closed: true } });
  assert.equal(projection.snapshot().state.pendingExtensionUi?.length ?? 0, 0);
});

test("extension UI pending request survives detach/reattach; close removes it and cannot resurrect", async () => {
  const { service, workers } = harness();
  await service.activate("s");
  workers.workers[0]!.emitEvent({ type: "extension_ui_request", sessionId: "s", request: { id: "ui-1", method: "confirm", title: "t", message: "m" } });
  await wait();
  let attached = service.attach({ sessionId: "s" });
  assert.equal(attached.result.snapshot.state.pendingExtensionUi?.length, 1);
  assert.equal(attached.result.snapshot.state.pendingExtensionUi?.[0]?.id, "ui-1");
  attached.unsubscribe?.();
  // A second pending request stays while the first closes — only the exact id is removed.
  workers.workers[0]!.emitEvent({ type: "extension_ui_request", sessionId: "s", request: { id: "ui-2", method: "input", title: "t" } });
  workers.workers[0]!.emitEvent({ type: "extension_ui_request", sessionId: "s", request: { id: "ui-1", method: "confirm", title: "t", message: "m", closed: true } });
  await wait();
  attached = service.attach({ sessionId: "s" });
  const pending = attached.result.snapshot.state.pendingExtensionUi ?? [];
  assert.deepEqual(pending.map((request) => request.id), ["ui-2"], "replay of add+close must never resurrect ui-1");
  attached.unsubscribe?.();
  await service.shutdown();
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

test("hasBusyCwd safety query covers exact + descendant; sibling prefix is not a descendant; stopByCwd stays exact", async () => {
  const { service, workers } = harness({ worker: { commandDelayMs: 5_000 } });
  await service.activate("s"); // activation cwd = /cwd/s
  const pending = service.command("s", { type: "prompt", commandId: "busy-desc", message: "long" });
  await wait(10);
  assert.equal(service.hasBusyCwd("/cwd/s").busy, true, "exact busy cwd is busy");
  assert.equal(service.hasBusyCwd("/cwd").busy, true, "ancestor of a busy runtime cwd is busy (descendant containment)");
  assert.equal(service.hasBusyCwd("/cwd/s/sub").busy, false, "a path INSIDE the busy cwd is not itself busy");
  assert.equal(service.hasBusyCwd("/cwd/sx").busy, false, "sibling prefix (/cwd/sx) is NOT a descendant of /cwd/s");
  assert.equal(service.hasBusyCwd("/other").busy, false, "unrelated cwd is not busy");
  assert.equal(service.hasBusyCwd("/cwd/s").sessionIds?.includes("s"), true, "busy session id surfaced");

  // stopByCwd keeps EXACT-match semantics (never descendant): an ancestor
  // stopByCwd must not stop the exact-cwd busy session.
  assert.deepEqual(await service.stopByCwd("/cwd"), [], "ancestor stopByCwd must not stop the exact-cwd session");
  assert.equal(service.hasBusyCwd("/cwd/s").busy, true, "session still busy after ancestor stopByCwd");
  // Exact stopByCwd stops it.
  assert.deepEqual(await service.stopByCwd("/cwd/s"), ["s"]);
  assert.equal(service.hasBusyCwd("/cwd/s").busy, false);
  await pending.catch(() => {});
  await service.shutdown();
  void workers;
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

test("set_auto_retry success refreshes authoritative snapshot before command returns (D2-P4)", async () => {
  const { service, workers } = harness();
  await service.activate("s");
  const before = service.getSnapshot("s");
  assert.equal(before.state.autoRetryEnabled, undefined);
  const snapshotsBefore = workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length;

  const result = await service.command("s", { type: "set_auto_retry", commandId: "retry-1", enabled: true });
  assert.equal(result.result.ok, true);
  assert.equal(result.result.type, "set_auto_retry");

  // sessiond must issue a post-success worker.getSnapshot refresh so the
  // projection converges on autoRetryEnabled=true BEFORE the command returns.
  const snapshotsAfter = workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length;
  assert.ok(snapshotsAfter > snapshotsBefore, "expected post-success worker.getSnapshot refresh");

  const snap = service.getSnapshot("s");
  assert.equal(snap.state.autoRetryEnabled, true);

  // Attach boundary also carries the new flag (sessiond projection authority).
  const attach = service.attach({ sessionId: "s" });
  assert.equal(attach.result.snapshot?.state.autoRetryEnabled, true);
  await service.shutdown();
});

test("set_auto_retry same-id second caller waits for deferred authority refresh with one worker.command", async () => {
  const { service, workers } = harness({
    worker: { postCommandSnapshotDelayMs: 80 },
    service: { commandTimeoutMs: 2_000 },
  });
  await service.activate("s");
  const worker = workers.workers[0]!;
  const command = { type: "set_auto_retry" as const, commandId: "retry-same", enabled: true };

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
  assert.equal(service.getSnapshot("s").state.autoRetryEnabled, true);
  await service.shutdown();
});

test("set_auto_retry successful finalization cleans singleflight and cached retry does not refresh again", async () => {
  const { service, workers } = harness();
  await service.activate("s");
  const command = { type: "set_auto_retry" as const, commandId: "retry-cleanup", enabled: true };
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

test("set_auto_retry refresh failure fail-closes all observers and cached retry", async () => {
  const { service, workers } = harness({
    worker: { dropPostCommandSnapshots: true },
    service: { commandTimeoutMs: 80 },
  });
  await service.activate("s");
  const command = { type: "set_auto_retry" as const, commandId: "retry-fail", enabled: true };

  const first = service.command("s", command);
  await wait(10);
  const second = service.command("s", command);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.result.ok, false);
  assert.equal(b.result.ok, false);
  assert.equal(a.result.type, "set_auto_retry");
  assert.equal(b.result.type, "set_auto_retry");
  assert.equal(a.commandId, "retry-fail");
  assert.deepEqual(a, b);
  if (!a.result.ok) {
    assert.equal(a.result.error.code, "unavailable");
    assert.match(a.result.error.message, /snapshot|authority|timed out/i);
  }

  // Projection must not claim the flag after fail-closed authority refresh.
  assert.notEqual(service.getSnapshot("s").state.autoRetryEnabled, true);

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

test("set_auto_retry wrong result type does not finalize; legitimate frame completes once", async () => {
  const { service, workers } = harness({
    worker: { commandDelayMs: 80 },
    service: { commandTimeoutMs: 500 },
  });
  await service.activate("s");
  const worker = workers.workers[0]!;
  const command = { type: "set_auto_retry" as const, commandId: "retry-wrongtype", enabled: true };

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
  assert.equal(result.commandId, "retry-wrongtype");
  assert.equal(result.result.ok, true);
  assert.equal(result.result.type, "set_auto_retry");
  assert.equal(worker.sent.filter((item) => item.type === "worker.command").length, 1);
  assert.equal(worker.sent.filter((item) => item.type === "worker.getSnapshot").length, snapshotsDuring + 1);
  assert.equal(service.getSnapshot("s").state.autoRetryEnabled, true);
  await service.shutdown();
});

/** D2-P6 fixture snapshot with a deterministic tool catalog + systemPrompt. */
const toolsSnapshot = (sessionId: string, cwd = "/workspace", projectRoot = cwd): RuntimeSnapshot => ({
  ...snapshot(sessionId, cwd, projectRoot),
  state: {
    ...snapshot(sessionId, cwd, projectRoot).state,
    systemPrompt: "fixture system prompt",
    tools: [
      { name: "read", description: "Read a file", active: true },
      { name: "write", description: "Write a file", active: true },
      { name: "edit", description: "Edit a file", active: true },
      { name: "bash", description: "Run a shell command", active: true },
      { name: "grep", description: "Search file contents", active: true },
      { name: "find", description: "Find files", active: true },
      { name: "ls", description: "List a directory", active: true },
    ],
  },
});

const activeToolNames = (state: RuntimeSnapshot["state"]): string[] =>
  (state.tools ?? []).filter((tool) => tool.active).map((tool) => tool.name).sort();

/**
 * A post-conversation authoritative snapshot: 5 messages, non-zero context
 * usage, idle compaction. The fake worker's `compact` mutation trims messages
 * to the last 3, drops messageCount to 3 and shrinks contextUsage so the
 * post-success worker.getSnapshot refresh can be asserted to converge ALL
 * post-compaction fields (the wire compaction_end event only clears activity).
 */
const compactSnapshot = (sessionId: string, cwd = "/workspace", projectRoot = cwd): RuntimeSnapshot => ({
  ...snapshot(sessionId, cwd, projectRoot),
  state: {
    ...snapshot(sessionId, cwd, projectRoot).state,
    messageCount: 5,
    leafId: "entry-5",
    contextUsage: { percent: 72, contextWindow: 200_000, tokens: 144_000 },
  },
});

/**
 * D2 navigate authoritative snapshot: a 3-message session rooted at leaf
 * `nav-3`. The fake worker's navigate to `nav-<keep>` trims the authoritative
 * live snapshot to the first `<keep>` messages and moves the leaf, so a
 * post-success worker.getSnapshot refresh converges leafId/messageCount/history
 * deterministically (the wire carries only a runtime_state_changed signal).
 */
const navigateSnapshot = (sessionId: string, cwd = "/workspace", projectRoot = cwd): RuntimeSnapshot => ({
  ...snapshot(sessionId, cwd, projectRoot),
  state: {
    ...snapshot(sessionId, cwd, projectRoot).state,
    messageCount: 3,
    leafId: "nav-3",
  },
});



test("set_tools success refreshes authoritative snapshot before command returns (D2-P6)", async () => {
  const { service, workers } = harness({ worker: { snapshot: toolsSnapshot("s") } });
  await service.activate("s");
  const before = service.getSnapshot("s");
  assert.deepEqual(activeToolNames(before.state), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
  const snapshotsBefore = workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length;

  const result = await service.command("s", { type: "set_tools", commandId: "tools-1", toolNames: ["read", "edit", "read"] });
  assert.equal(result.result.ok, true);
  assert.equal(result.result.type, "set_tools");

  // sessiond must issue a post-success worker.getSnapshot refresh so the
  // projection converges on the de-duplicated tool selection BEFORE the command
  // returns.
  const snapshotsAfter = workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length;
  assert.ok(snapshotsAfter > snapshotsBefore, "expected post-success worker.getSnapshot refresh");

  const snap = service.getSnapshot("s");
  assert.deepEqual(activeToolNames(snap.state), ["edit", "read"], JSON.stringify(snap.state.tools));
  assert.ok(typeof snap.state.systemPrompt === "string" && snap.state.systemPrompt.length > 0, "subset selection keeps a non-empty system prompt");

  // Attach boundary also carries the new tool selection (sessiond projection authority).
  const attach = service.attach({ sessionId: "s" });
  assert.deepEqual(activeToolNames(attach.result.snapshot!.state), ["edit", "read"]);
  await service.shutdown();
});

test("set_tools all-off clears tools and system prompt in the authoritative snapshot", async () => {
  const { service } = harness({ worker: { snapshot: toolsSnapshot("s") } });
  await service.activate("s");
  const result = await service.command("s", { type: "set_tools", commandId: "tools-off", toolNames: [] });
  assert.equal(result.result.ok, true);
  const snap = service.getSnapshot("s");
  assert.deepEqual(activeToolNames(snap.state), [], JSON.stringify(snap.state.tools));
  assert.equal(snap.state.systemPrompt, "");
  await service.shutdown();
});

test("set_tools same-id second caller waits for deferred authority refresh with one worker.command", async () => {
  const { service, workers } = harness({
    worker: { snapshot: toolsSnapshot("s"), postCommandSnapshotDelayMs: 80 },
    service: { commandTimeoutMs: 2_000 },
  });
  await service.activate("s");
  const worker = workers.workers[0]!;
  const command = { type: "set_tools" as const, commandId: "tools-same", toolNames: ["read"] };

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
  assert.deepEqual(activeToolNames(service.getSnapshot("s").state), ["read"]);
  await service.shutdown();
});

test("set_tools refresh failure fail-closes all observers and cached retry", async () => {
  const { service, workers } = harness({
    worker: { snapshot: toolsSnapshot("s"), dropPostCommandSnapshots: true },
    service: { commandTimeoutMs: 80 },
  });
  await service.activate("s");
  const command = { type: "set_tools" as const, commandId: "tools-fail", toolNames: ["read"] };

  const first = service.command("s", command);
  await wait(10);
  const second = service.command("s", command);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.result.ok, false);
  assert.equal(b.result.ok, false);
  assert.equal(a.result.type, "set_tools");
  assert.equal(b.result.type, "set_tools");
  assert.equal(a.commandId, "tools-fail");
  assert.deepEqual(a, b);
  if (!a.result.ok) {
    assert.equal(a.result.error.code, "unavailable");
    assert.match(a.result.error.message, /snapshot|authority|timed out/i);
  }

  // Projection must not claim the new selection after fail-closed authority refresh.
  const state = service.getSnapshot("s").state;
  assert.ok(!activeToolNames(state).includes("read") || activeToolNames(state).length !== 1, "projection must not claim the failed selection");

  const commandsBeforeRetry = workers.workers[0]!.sent.filter((item) => item.type === "worker.command").length;
  const snapshotsBeforeRetry = workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length;
  const retry = await service.command("s", command);
  assert.deepEqual(retry, a);
  assert.equal(retry.result.ok, false);
  assert.equal(workers.workers[0]!.sent.filter((item) => item.type === "worker.command").length, commandsBeforeRetry, "cached failure must not re-send worker.command");
  assert.equal(workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length, snapshotsBeforeRetry, "cached failure must not re-refresh snapshot");
  await service.shutdown();
});

test("set_tools vs reload different ids remain independent", async () => {
  const { service, workers } = harness({ worker: { snapshot: toolsSnapshot("s") } });
  await service.activate("s");
  const [a, b] = await Promise.all([
    service.command("s", { type: "set_tools", commandId: "tools-a", toolNames: ["read"] }),
    service.command("s", { type: "reload", commandId: "reload-b" }),
  ]);
  assert.equal(a.result.ok, true);
  assert.equal(b.result.ok, true);
  assert.equal(a.commandId, "tools-a");
  assert.equal(b.commandId, "reload-b");
  const workerCommands = workers.workers[0]!.sent.filter((item) => item.type === "worker.command");
  assert.equal(workerCommands.length, 2);
  await service.shutdown();
});

test("reload success refreshes authoritative snapshot with tools/systemPrompt/thinking and final capabilities", async () => {
  const { service, workers } = harness({
    worker: { snapshot: { ...toolsSnapshot("s"), state: { ...toolsSnapshot("s").state, thinkingLevel: "high" as const, thinkingLevelPinned: true } } },
  });
  await service.activate("s");
  const before = service.getSnapshot("s");
  const versionBefore = before.capabilities.version;
  const snapshotsBefore = workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length;

  const result = await service.command("s", { type: "reload", commandId: "reload-1" });
  assert.equal(result.result.ok, true);
  assert.equal(result.result.type, "reload");

  const snapshotsAfter = workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length;
  assert.ok(snapshotsAfter > snapshotsBefore, "expected post-success worker.getSnapshot refresh after reload");

  const snap = service.getSnapshot("s");
  // Reload converges tools + systemPrompt + thinking pin/state AND the final
  // capability set (version bumped by the fake worker reload).
  assert.deepEqual(activeToolNames(snap.state), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
  assert.ok(snap.state.systemPrompt && snap.state.systemPrompt.length > 0, "reload keeps a non-empty system prompt");
  assert.equal(snap.state.thinkingLevel, "high");
  assert.equal(snap.state.thinkingLevelPinned, true);
  assert.ok(snap.capabilities.version > versionBefore, `reload must bump the capability version (${snap.capabilities.version} > ${versionBefore})`);

  // Attach boundary carries the reloaded set.
  const attach = service.attach({ sessionId: "s" });
  assert.ok(attach.result.snapshot!.capabilities.version > versionBefore);
  await service.shutdown();
});

test("reload same-id second caller joins finalization with one worker.command", async () => {
  const { service, workers } = harness({
    worker: { snapshot: toolsSnapshot("s"), postCommandSnapshotDelayMs: 80 },
    service: { commandTimeoutMs: 2_000 },
  });
  await service.activate("s");
  const worker = workers.workers[0]!;
  const command = { type: "reload" as const, commandId: "reload-same" };

  const first = service.command("s", command);
  await wait(30);
  const second = service.command("s", command);
  let firstSettled = false;
  let secondSettled = false;
  void first.then(() => { firstSettled = true; });
  void second.then(() => { secondSettled = true; });
  await wait(20);
  assert.equal(firstSettled, false);
  assert.equal(secondSettled, false, "same-id reload caller must join finalization, not settle early");

  assert.equal(worker.sent.filter((item) => item.type === "worker.command").length, 1, "exactly one worker.command for same reload commandId");

  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.result.ok, true);
  assert.equal(b.result.ok, true);
  assert.deepEqual(a, b);
  await service.shutdown();
});

test("reload refresh failure fail-closes all observers and cached retry", async () => {
  const { service, workers } = harness({
    worker: { snapshot: toolsSnapshot("s"), dropPostCommandSnapshots: true },
    service: { commandTimeoutMs: 80 },
  });
  await service.activate("s");
  const command = { type: "reload" as const, commandId: "reload-fail" };

  const first = service.command("s", command);
  await wait(10);
  const second = service.command("s", command);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.result.ok, false);
  assert.equal(b.result.ok, false);
  assert.equal(a.result.type, "reload");
  assert.equal(b.result.type, "reload");
  assert.equal(a.commandId, "reload-fail");
  assert.deepEqual(a, b);
  if (!a.result.ok) {
    assert.equal(a.result.error.code, "unavailable");
    assert.match(a.result.error.message, /snapshot|authority|timed out/i);
  }
  await service.shutdown();
});

test("compact success refreshes authoritative snapshot with trimmed messages/contextUsage before command returns (D2-P7)", async () => {
  const { service, workers } = harness({ worker: { snapshot: compactSnapshot("s") } });
  await service.activate("s");
  const before = service.getSnapshot("s");
  assert.equal(before.state.messageCount, 5);
  assert.equal(before.state.contextUsage?.percent, 72);
  assert.equal(before.state.leafId, "entry-5");
  // Protocol v2: snapshots are control state only — no transcript history.
  assert.equal("messages" in before, false);
  const snapshotsBefore = workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length;

  const result = await service.command("s", { type: "compact", commandId: "compact-1", customInstructions: "keep decisions" });
  assert.equal(result.result.ok, true);
  assert.equal(result.result.type, "compact");

  // sessiond must issue a post-success worker.getSnapshot refresh so the
  // projection converges the FULL post-compaction snapshot (messages,
  // messageCount, contextUsage) BEFORE the terminal result is released — the
  // compaction_end event alone only clears activity.
  const snapshotsAfter = workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length;
  assert.ok(snapshotsAfter > snapshotsBefore, "expected post-success worker.getSnapshot refresh after compact");

  const snap = service.getSnapshot("s");
  assert.equal(snap.state.messageCount, 3, JSON.stringify(snap.state));
  assert.equal(snap.state.isCompacting, false);
  assert.equal("messages" in snap, false, "snapshot must never carry transcript history");
  assert.equal(snap.state.contextUsage?.percent, 32, JSON.stringify(snap.state.contextUsage));
  assert.equal(snap.state.contextUsage?.tokens, 143_600);

  // Attach boundary also carries the post-compaction projection.
  const attach = service.attach({ sessionId: "s" });
  assert.equal(attach.result.snapshot!.state.messageCount, 3);
  assert.equal("messages" in attach.result.snapshot!, false);
  await service.shutdown();
});

test("compact same-id second caller waits for deferred authority refresh with one worker.command", async () => {
  const { service, workers } = harness({
    worker: { snapshot: compactSnapshot("s"), postCommandSnapshotDelayMs: 80 },
    service: { commandTimeoutMs: 2_000 },
  });
  await service.activate("s");
  const worker = workers.workers[0]!;
  const command = { type: "compact" as const, commandId: "compact-same", customInstructions: "keep decisions" };

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
  assert.equal(workerCommands.length, 1, "exactly one worker.command for same compact commandId");

  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.result.ok, true);
  assert.equal(b.result.ok, true);
  assert.deepEqual(a, b);
  assert.equal(service.getSnapshot("s").state.messageCount, 3);
  await service.shutdown();
});

test("compact refresh failure fail-closes all observers and cached retry", async () => {
  const { service, workers } = harness({
    worker: { snapshot: compactSnapshot("s"), dropPostCommandSnapshots: true },
    service: { commandTimeoutMs: 80 },
  });
  await service.activate("s");
  const command = { type: "compact" as const, commandId: "compact-fail" };

  const first = service.command("s", command);
  await wait(10);
  const second = service.command("s", command);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.result.ok, false);
  assert.equal(b.result.ok, false);
  assert.equal(a.result.type, "compact");
  assert.equal(b.result.type, "compact");
  assert.equal(a.commandId, "compact-fail");
  assert.deepEqual(a, b);
  if (!a.result.ok) {
    assert.equal(a.result.error.code, "unavailable");
    assert.match(a.result.error.message, /snapshot|authority|timed out/i);
  }

  // Projection must NOT claim a compacted (trimmed) state after fail-closed
  // authority refresh: messageCount stays the pre-command authoritative value.
  assert.equal(service.getSnapshot("s").state.messageCount, 5, "projection must not claim the failed compaction");

  const commandsBeforeRetry = workers.workers[0]!.sent.filter((item) => item.type === "worker.command").length;
  const snapshotsBeforeRetry = workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length;
  const retry = await service.command("s", command);
  assert.deepEqual(retry, a);
  assert.equal(retry.result.ok, false);
  assert.equal(workers.workers[0]!.sent.filter((item) => item.type === "worker.command").length, commandsBeforeRetry, "cached failure must not re-send worker.command");
  assert.equal(workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length, snapshotsBeforeRetry, "cached failure must not re-refresh snapshot");
  await service.shutdown();
});

test("compact vs set_tools/reload different ids remain independent", async () => {
  const { service, workers } = harness({ worker: { snapshot: compactSnapshot("s") } });
  await service.activate("s");
  const [a, b, c] = await Promise.all([
    service.command("s", { type: "compact", commandId: "compact-a" }),
    service.command("s", { type: "set_tools", commandId: "tools-b", toolNames: ["read"] }),
    service.command("s", { type: "reload", commandId: "reload-c" }),
  ]);
  assert.equal(a.result.ok, true);
  assert.equal(b.result.ok, true);
  assert.equal(c.result.ok, true);
  assert.equal(a.commandId, "compact-a");
  assert.equal(b.commandId, "tools-b");
  assert.equal(c.commandId, "reload-c");
  const workerCommands = workers.workers[0]!.sent.filter((item) => item.type === "worker.command");
  assert.equal(workerCommands.length, 3);
  await service.shutdown();
});

test("compact wrong result type does not finalize; legitimate frame completes once", async () => {
  const { service, workers } = harness({
    worker: { snapshot: compactSnapshot("s"), commandDelayMs: 80 },
    service: { commandTimeoutMs: 500 },
  });
  await service.activate("s");
  const worker = workers.workers[0]!;
  const command = { type: "compact" as const, commandId: "compact-wrongtype" };

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
      result: { commandId: command.commandId, result: { ok: true, type: "set_tools" } },
    },
  });
  await wait(10);
  const snapshotsDuring = worker.sent.filter((item) => item.type === "worker.getSnapshot").length;
  let settled = false;
  void pending.then(() => { settled = true; });
  await wait(0);
  assert.equal(settled, false, "wrong result type must not resolve or start finalization");

  const result = await pending;
  assert.equal(result.commandId, "compact-wrongtype");
  assert.equal(result.result.ok, true);
  assert.equal(result.result.type, "compact");
  assert.equal(worker.sent.filter((item) => item.type === "worker.command").length, 1);
  // The legitimate frame triggered exactly one post-success refresh.
  assert.equal(worker.sent.filter((item) => item.type === "worker.getSnapshot").length, snapshotsDuring + 1);
  assert.equal(service.getSnapshot("s").state.messageCount, 3);
  await service.shutdown();
});

test("failed/interrupted compact does not trigger authority refresh or cache a false success", async () => {
  const { service, workers } = harness({
    worker: { snapshot: compactSnapshot("s"), commandDelayMs: 80 },
    service: { commandTimeoutMs: 500 },
  });
  await service.activate("s");
  const worker = workers.workers[0]!;
  const command = { type: "compact" as const, commandId: "compact-interrupted" };
  const pending = service.command("s", command);
  await wait(10);
  const wire = worker.sent.find((item) => item.type === "worker.command");
  assert.ok(wire && wire.type === "worker.command");
  const snapshotsBefore = worker.sent.filter((item) => item.type === "worker.getSnapshot").length;
  // The worker answers the compact as FAILED (e.g. aborted / nothing to compact)
  // — this must NOT enter authority finalization, must NOT refresh, and must
  // cache the failure (retry returns the same failure without re-executing). The
  // fake worker's delayed default success is a LATE frame and must be dropped.
  worker.emit({
    type: "worker.commandResult",
    id: wire.id,
    payload: {
      sessionId: "s",
      result: { commandId: command.commandId, result: { ok: false, type: "compact", error: { code: "interrupted", message: "compaction aborted", retryable: true } } },
    },
  });
  const result = await pending;
  assert.equal(result.result.ok, false);
  if (!result.result.ok) {
    assert.equal(result.result.type, "compact");
    assert.equal(result.result.error.code, "interrupted");
  }
  assert.equal(worker.sent.filter((item) => item.type === "worker.getSnapshot").length, snapshotsBefore, "failed compact must NOT trigger an authority snapshot refresh");
  // Projection stays at the pre-command state (no trimmed claim).
  assert.equal(service.getSnapshot("s").state.messageCount, 5);

  // Same commandId retry returns the CACHED failure and never re-executes.
  const commandsBeforeRetry = worker.sent.filter((item) => item.type === "worker.command").length;
  const retry = await service.command("s", command);
  assert.deepEqual(retry, result);
  assert.equal(worker.sent.filter((item) => item.type === "worker.command").length, commandsBeforeRetry, "cached interrupted compact must not re-execute");
  await service.shutdown();
});

test("compact finalization during rekey never writes across epochs and new session can re-admit", async () => {
  const { service, workers } = harness({
    worker: { snapshot: compactSnapshot("s"), postCommandSnapshotDelayMs: 200 },
    service: { commandTimeoutMs: 2_000 },
  });
  await service.activate("s");
  const worker = workers.workers[0]!;
  const command = { type: "compact" as const, commandId: "compact-rekey" };

  const pending = service.command("s", command);
  // Wait until finalization is registered (post-success refresh in flight).
  await wait(30);
  worker.emit({ type: "worker.sessionDiscovered", payload: { sessionId: "real-s", sessionFile: "/sessions/real-s.jsonl", cwd: "/cwd/s" } });
  await wait(10);

  const result = await pending;
  assert.equal(result.commandId, "compact-rekey");
  assert.equal(result.result.ok, false);
  if (!result.result.ok) assert.equal(result.result.error.code, "unavailable");

  // Old id is gone; rekeyed record must not carry the fail-closed result across epoch.
  assert.throws(() => service.getSnapshot("s"));
  assert.equal(service.getSnapshot("real-s").state.messageCount, 5, "no cross-epoch compaction write");

  // Same commandId can be re-admitted in the new epoch (acceptedCommands cleared).
  // The fake worker's liveSnapshot is already trimmed to 3 by the first compact,
  // so the re-admitted compact trims again — the key contract is that the
  // re-admission SUCCEEDS (not carrying the fail-closed cache) and the projection
  // is authoritative (trimmed below the pre-command 5).
  const readmitted = await service.command("real-s", command);
  assert.equal(readmitted.result.ok, true);
  assert.ok(service.getSnapshot("real-s").state.messageCount < 5, "re-admitted compact must trim the authoritative snapshot");
  await service.shutdown();
});

test("compact successful finalization cleans singleflight when worker crashes before its first microtask", async () => {
  const { service, workers } = harness({
    worker: { snapshot: compactSnapshot("s"), commandDelayMs: 5_000 },
    service: { commandTimeoutMs: 500 },
  });
  await service.activate("s");
  const worker = workers.workers[0]!;
  const command = { type: "compact" as const, commandId: "compact-early-crash" };
  const pending = service.command("s", command);
  await wait(10);
  const wire = worker.sent.find((item) => item.type === "worker.command");
  assert.ok(wire && wire.type === "worker.command");

  // Deliver a valid worker success (registers authority finalization), then crash
  // synchronously before its deferred body runs. The final result must be bounded
  // and the singleflight must not remain as permanent busy state.
  worker.emit({
    type: "worker.commandResult",
    id: wire.id,
    payload: {
      sessionId: "s",
      result: { commandId: command.commandId, result: { ok: true, type: "compact" } },
    },
  });
  worker.crash();

  const result = await pending;
  assert.equal(result.commandId, command.commandId);
  assert.equal(result.result.ok, false);
  assert.equal(result.result.type, "compact");
  if (!result.result.ok) assert.equal(result.result.error.code, "unavailable");
  await wait(0);
  assert.equal(service.hasBusyCwd("/cwd/s").busy, false, "settled finalization must be removed after early crash");
  await service.shutdown();
});

test("compaction_end before compact success still converges the full post-compaction snapshot", async () => {
  const { service, workers } = harness({ worker: { snapshot: compactSnapshot("s"), commandDelayMs: 60 } });
  await service.activate("s");
  const worker = workers.workers[0]!;
  const command = { type: "compact" as const, commandId: "compact-event-before" };
  const pending = service.command("s", command);
  await wait(10);
  // A compaction_start/end pair arrives on the wire BEFORE the command result:
  // compaction_end only clears activity and does NOT carry messages/messageCount/
  // contextUsage. The projection must therefore still converge the FULL snapshot
  // via the post-success worker.getSnapshot refresh before the terminal result.
  worker.emitEvent({ type: "compaction_start", sessionId: "s", reason: "manual" });
  worker.emitEvent({ type: "compaction_end", sessionId: "s", aborted: false });
  await wait(10);
  const result = await pending;
  assert.equal(result.result.ok, true);
  assert.equal(result.result.type, "compact");
  const snap = service.getSnapshot("s");
  assert.equal(snap.state.isCompacting, false);
  assert.equal(snap.state.messageCount, 3, "snapshot must converge messageCount after compact (not the event)");
  assert.equal("messages" in snap, false, "snapshot must never carry transcript history");
  assert.equal(snap.state.contextUsage?.percent, 32, "snapshot must converge contextUsage after compact");
  await service.shutdown();
});

test("navigate success refreshes authoritative snapshot with new leaf/messageCount/history before command returns (D2 navigate)", async () => {
  const { service, workers } = harness({ worker: { snapshot: navigateSnapshot("s") } });
  await service.activate("s");
  const before = service.getSnapshot("s");
  assert.equal(before.state.messageCount, 3);
  assert.equal(before.state.leafId, "nav-3");
  assert.equal("messages" in before, false, "snapshot must never carry transcript history");
  const snapshotsBefore = workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length;

  const result = await service.command("s", { type: "navigate_tree", commandId: "nav-1", targetId: "nav-1" });
  assert.equal(result.result.ok, true);
  assert.equal(result.result.type, "navigate_tree");

  // sessiond must issue a post-success worker.getSnapshot refresh so the
  // projection converges the FULL navigated snapshot (leafId + history +
  // messageCount) BEFORE the terminal result is released — the wire carries
  // only a runtime_state_changed signal.
  const snapshotsAfter = workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length;
  assert.ok(snapshotsAfter > snapshotsBefore, "expected post-success worker.getSnapshot refresh after navigate");

  const snap = service.getSnapshot("s");
  assert.equal(snap.state.messageCount, 1, JSON.stringify(snap.state));
  assert.equal(snap.state.leafId, "nav-1", "projection must carry the navigated leaf");
  assert.equal("messages" in snap, false, "snapshot must never carry transcript history");

  // Attach boundary also carries the navigated projection.
  const attach = service.attach({ sessionId: "s" });
  assert.equal(attach.result.snapshot!.state.messageCount, 1);
  assert.equal(attach.result.snapshot!.state.leafId, "nav-1");
  assert.equal("messages" in attach.result.snapshot!, false);
  await service.shutdown();
});

test("navigate same-id second caller waits for deferred authority refresh with one worker.command", async () => {
  const { service, workers } = harness({
    worker: { snapshot: navigateSnapshot("s"), postCommandSnapshotDelayMs: 80 },
    service: { commandTimeoutMs: 2_000 },
  });
  await service.activate("s");
  const worker = workers.workers[0]!;
  const command = { type: "navigate_tree" as const, commandId: "nav-same", targetId: "nav-1" };

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
  assert.equal(workerCommands.length, 1, "exactly one worker.command for same navigate commandId");

  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.result.ok, true);
  assert.equal(b.result.ok, true);
  assert.deepEqual(a, b);
  assert.equal(service.getSnapshot("s").state.messageCount, 1);
  assert.equal(service.getSnapshot("s").state.leafId, "nav-1");
  await service.shutdown();
});

test("navigate successful finalization cleans singleflight and cached retry does not refresh again", async () => {
  const { service, workers } = harness({ worker: { snapshot: navigateSnapshot("s") } });
  await service.activate("s");
  const command = { type: "navigate_tree" as const, commandId: "nav-cleanup", targetId: "nav-1" };
  const first = await service.command("s", command);
  assert.equal(first.result.ok, true);
  const snapshotsAfterSuccess = workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length;

  const retry = await service.command("s", command);
  assert.deepEqual(retry, first);
  assert.equal(
    workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length,
    snapshotsAfterSuccess,
    "completed finalization must be gone: the retry comes from the terminal result cache",
  );
  assert.equal(service.hasBusyCwd("/cwd/s").busy, false);
  await service.shutdown();
});

test("navigate refresh failure fail-closes all observers and cached retry", async () => {
  const { service, workers } = harness({
    worker: { snapshot: navigateSnapshot("s"), dropPostCommandSnapshots: true },
    service: { commandTimeoutMs: 80 },
  });
  await service.activate("s");
  const command = { type: "navigate_tree" as const, commandId: "nav-fail", targetId: "nav-1" };

  const first = service.command("s", command);
  await wait(10);
  const second = service.command("s", command);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.result.ok, false);
  assert.equal(b.result.ok, false);
  assert.equal(a.result.type, "navigate_tree");
  assert.equal(b.result.type, "navigate_tree");
  assert.equal(a.commandId, "nav-fail");
  assert.deepEqual(a, b);
  if (!a.result.ok) {
    assert.equal(a.result.error.code, "unavailable");
    assert.match(a.result.error.message, /snapshot|authority|timed out/i);
  }

  // Projection must NOT claim a navigated state after fail-closed authority
  // refresh: leafId/messageCount stay the pre-command authoritative values.
  assert.equal(service.getSnapshot("s").state.messageCount, 3, "projection must not claim the failed navigation");
  assert.equal(service.getSnapshot("s").state.leafId, "nav-3", "projection must not claim a navigated leaf");

  const commandsBeforeRetry = workers.workers[0]!.sent.filter((item) => item.type === "worker.command").length;
  const snapshotsBeforeRetry = workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length;
  const retry = await service.command("s", command);
  assert.deepEqual(retry, a);
  assert.equal(retry.result.ok, false);
  assert.equal(workers.workers[0]!.sent.filter((item) => item.type === "worker.command").length, commandsBeforeRetry, "cached failure must not re-send worker.command");
  assert.equal(workers.workers[0]!.sent.filter((item) => item.type === "worker.getSnapshot").length, snapshotsBeforeRetry, "cached failure must not re-refresh snapshot");
  await service.shutdown();
});

test("navigate wrong result type does not finalize; legitimate frame completes once", async () => {
  const { service, workers } = harness({
    worker: { snapshot: navigateSnapshot("s"), commandDelayMs: 80 },
    service: { commandTimeoutMs: 500 },
  });
  await service.activate("s");
  const worker = workers.workers[0]!;
  const command = { type: "navigate_tree" as const, commandId: "nav-wrongtype", targetId: "nav-1" };

  const pending = service.command("s", command);
  await wait(10);
  const wire = worker.sent.find((item) => item.type === "worker.command");
  assert.ok(wire && wire.type === "worker.command");
  const wireId = wire.id;

  // Correct wire id + inner commandId but WRONG result type — triple match
  // fails, so no finalization, no cache, no resolve: the waiter keeps waiting.
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
  assert.equal(result.commandId, "nav-wrongtype");
  assert.equal(result.result.ok, true);
  assert.equal(result.result.type, "navigate_tree");
  assert.equal(worker.sent.filter((item) => item.type === "worker.command").length, 1);
  // The legitimate frame triggered exactly one post-success refresh.
  assert.equal(worker.sent.filter((item) => item.type === "worker.getSnapshot").length, snapshotsDuring + 1);
  assert.equal(service.getSnapshot("s").state.leafId, "nav-1");
  await service.shutdown();
});

test("navigate finalization during rekey never writes across epochs and new session can re-admit", async () => {
  const { service, workers } = harness({
    worker: { snapshot: navigateSnapshot("s"), postCommandSnapshotDelayMs: 200 },
    service: { commandTimeoutMs: 2_000 },
  });
  await service.activate("s");
  const worker = workers.workers[0]!;
  const command = { type: "navigate_tree" as const, commandId: "nav-rekey", targetId: "nav-1" };

  const pending = service.command("s", command);
  // Wait until finalization is registered (post-success refresh in flight).
  await wait(30);
  worker.emit({ type: "worker.sessionDiscovered", payload: { sessionId: "real-s", sessionFile: "/sessions/real-s.jsonl", cwd: "/cwd/s" } });
  await wait(10);

  const result = await pending;
  assert.equal(result.commandId, "nav-rekey");
  assert.equal(result.result.ok, false);
  if (!result.result.ok) assert.equal(result.result.error.code, "unavailable");

  // Old id is gone; the rekeyed record must not carry the navigate across epoch.
  assert.throws(() => service.getSnapshot("s"));
  const rekeyed = service.getSnapshot("real-s");
  assert.equal(rekeyed.state.leafId, "nav-3", "no cross-epoch navigate leaf write");
  assert.equal(rekeyed.state.messageCount, 3);

  // Same commandId can be re-admitted in the new epoch (acceptedCommands cleared).
  const readmitted = await service.command("real-s", command);
  assert.equal(readmitted.result.ok, true);
  assert.equal(service.getSnapshot("real-s").state.leafId, "nav-1");
  assert.equal(service.getSnapshot("real-s").state.messageCount, 1);
  await service.shutdown();
});

test("detach before navigate result + reattach sees the navigated snapshot (replay consistent)", async () => {
  const { service, workers } = harness({
    worker: { snapshot: navigateSnapshot("s"), commandDelayMs: 60, postCommandSnapshotDelayMs: 30 },
    service: { commandTimeoutMs: 2_000 },
  });
  await service.activate("s");
  const command = { type: "navigate_tree" as const, commandId: "nav-detach", targetId: "nav-1" };
  const pending = service.command("s", command);
  await wait(10);
  // Detach while the navigate is in flight (before its terminal result).
  service.detach("s");
  const result = await pending;
  assert.equal(result.result.ok, true);
  // A later reattach reads the refreshed projection (authority finalization ran
  // before the result was released) and must see the navigated snapshot.
  const attach = service.attach({ sessionId: "s" });
  assert.equal(attach.result.snapshot!.state.leafId, "nav-1");
  assert.equal(attach.result.snapshot!.state.messageCount, 1);
  assert.equal("messages" in attach.result.snapshot!, false);
  await service.shutdown();
});

test("navigate finalization cleans singleflight when worker crashes before its first microtask", async () => {  const { service, workers } = harness({
    worker: { snapshot: navigateSnapshot("s"), commandDelayMs: 5_000 },
    service: { commandTimeoutMs: 500 },
  });
  await service.activate("s");
  const worker = workers.workers[0]!;
  const command = { type: "navigate_tree" as const, commandId: "nav-early-crash", targetId: "nav-1" };
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
      result: { commandId: command.commandId, result: { ok: true, type: "navigate_tree" } },
    },
  });
  worker.crash();

  const result = await pending;
  assert.equal(result.commandId, command.commandId);
  assert.equal(result.result.ok, false);
  assert.equal(result.result.type, "navigate_tree");
  if (!result.result.ok) assert.equal(result.result.error.code, "unavailable");
  await wait(0);
  assert.equal(service.hasBusyCwd("/cwd/s").busy, false, "settled finalization must be removed after early crash");
  await service.shutdown();
});

test("get_tools is a query and never triggers an authority snapshot refresh", async () => {
  const { service, workers } = harness({ worker: { snapshot: toolsSnapshot("s") } });  await service.activate("s");
  const worker = workers.workers[0]!;
  const snapshotsBefore = worker.sent.filter((item) => item.type === "worker.getSnapshot").length;

  const result = await service.command("s", { type: "get_tools", commandId: "get-tools-1" });
  assert.equal(result.result.ok, true);
  assert.equal(result.result.type, "get_tools");
  assert.equal(worker.sent.filter((item) => item.type === "worker.getSnapshot").length, snapshotsBefore, "get_tools must NOT trigger an authority refresh");
  await service.shutdown();
});

test("steer/follow_up/clear_queue never trigger an authority snapshot refresh (D2-P4)", async () => {
  const { service, workers } = harness();
  await service.activate("s");
  const worker = workers.workers[0]!;
  const snapshotsBefore = worker.sent.filter((item) => item.type === "worker.getSnapshot").length;

  const steer = await service.command("s", { type: "steer", commandId: "steer-1", message: "steer now" });
  assert.equal(steer.result.ok, true);
  const followUp = await service.command("s", { type: "follow_up", commandId: "follow-1", message: "follow now" });
  assert.equal(followUp.result.ok, true);
  const clear = await service.interrupt("s", "clear-1", { type: "clear_queue" });
  assert.equal(clear.result.ok, true);

  // queue_update is the authoritative convergence for the queue; NO post-success
  // snapshot refresh for steer / follow_up / clear_queue (unlike authority commands).
  assert.equal(worker.sent.filter((item) => item.type === "worker.getSnapshot").length, snapshotsBefore);
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
      contextCalls.push({ sessionId, ...(options?.leafId === undefined ? {} : { leafId: options.leafId }), ...(options?.before === undefined ? {} : { before: options.before }), ...(options?.limit === undefined ? {} : { limit: options.limit }) });
      return { sessionId, entries: [], pageInfo: { hasMore: false } };
    },
    async readSessionTree(sessionId) { return { sessionId, roots: [], entryCount: 0 }; },
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

// ---------------------------------------------------------------------------
// D4 session-history delete: stopped/history only, no stop-then-delete.
// ---------------------------------------------------------------------------

const waitUntil = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await wait(2);
  }
};

const busySnapshot = (sessionId: string, state: Partial<RuntimeSnapshot["state"]>): RuntimeSnapshot => ({
  ...snapshot(sessionId),
  state: { ...snapshot(sessionId).state, ...state },
});

/** D4 delete harness: catalog + locator share a file-existence map (mirrors the
 *  real adapter, where delete removes the file and locate then reports absent),
 *  records deletions, and allows an injectable slow/gated deleteSession. */
function deleteHarness(options: {
  deleteSession?: (sessionId: string) => Promise<void>;
  worker?: ConstructorParameters<typeof FakeWorkerFactory>[0];
  service?: ConstructorParameters<typeof SessiondService>[1];
} = {}) {
  const files = new Map<string, boolean>();
  const deleted: string[] = [];
  const locator: SessionLocatorPort = {
    async locate(sessionId) { return { sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, exists: files.get(sessionId) ?? false }; },
    async resolveLeafId() { return "leaf"; },
  };
  const catalog: SessionCatalogPort = {
    async listSessions() { return [...files].filter(([, exists]) => exists).map(([sessionId]) => ({ sessionId, cwd: `/cwd/${sessionId}`, projectRoot: `/cwd/${sessionId}` })); },
    async readSession(sessionId) {
      if (!files.get(sessionId)) throw makeRuntimeError("not_found", `session not found: ${sessionId}`);
      return { sessionId, cwd: `/cwd/${sessionId}`, projectRoot: `/cwd/${sessionId}`, entries: [] };
    },
    async readSessionContext(sessionId) {
      if (!files.get(sessionId)) throw makeRuntimeError("not_found", `session not found: ${sessionId}`);
      return { sessionId, entries: [], pageInfo: { hasMore: false } };
    },
    async readSessionTree(sessionId) {
      if (!files.get(sessionId)) throw makeRuntimeError("not_found", `session not found: ${sessionId}`);
      return { sessionId, roots: [], entryCount: 0 };
    },
    async deleteSession(sessionId) {
      if (!files.get(sessionId)) throw makeRuntimeError("not_found", `session not found: ${sessionId}`);
      if (options.deleteSession) return options.deleteSession(sessionId);
      files.set(sessionId, false);
      deleted.push(sessionId);
    },
  };
  const workers = new FakeWorkerFactory(options.worker);
  const service = new SessiondService({
    sessionLocator: locator,
    activationContext: { async resolve(sessionId, _location, requestedCwd) { return { cwd: requestedCwd ?? `/cwd/${sessionId}`, projectRoot: requestedCwd ?? `/cwd/${sessionId}` }; } },
    workerFactory: workers,
    sessionCatalog: catalog,
  }, { workerStartTimeoutMs: 500, commandTimeoutMs: 500, idleTimeoutMs: 0, ...options.service });
  return { service, workers, files, deleted, seed: (id: string) => files.set(id, true) };
}

test("D4 delete of a non-live session succeeds and invalidates the catalog", async () => {
  const { service, deleted, files, seed } = deleteHarness();
  seed("s1");
  await service.deleteSession("s1");
  assert.deepEqual(deleted, ["s1"]);
  assert.equal(files.get("s1"), false);
  assert.deepEqual(await service.listRunning(), { sessions: [] });
  await service.shutdown();
});

test("D4 delete of a missing session fails with fixed not_found", async () => {
  const { service, deleted } = deleteHarness();
  await assert.rejects(service.deleteSession("missing"), (error: unknown) => {
    const code = error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    assert.equal(code, "not_found", "missing delete must fail with fixed not_found");
    return true;
  });
  assert.deepEqual(deleted, []);
  await service.shutdown();
});

test("D4 delete without a catalog fails closed with unavailable", async () => {
  const locator: SessionLocatorPort = { async locate(id) { return { sessionId: id, sessionFile: `/sessions/${id}.jsonl`, exists: false }; }, async resolveLeafId() { return "leaf"; } };
  const service = new SessiondService({
    sessionLocator: locator,
    activationContext: { async resolve(sessionId, _l, requestedCwd) { return { cwd: requestedCwd ?? `/cwd/${sessionId}`, projectRoot: requestedCwd ?? `/cwd/${sessionId}` }; } },
    workerFactory: new FakeWorkerFactory(),
  }, { workerStartTimeoutMs: 500, commandTimeoutMs: 500, idleTimeoutMs: 0 });
  await assert.rejects(service.deleteSession("s1"), (error: unknown) => {
    assert.ok(error instanceof SessiondError);
    assert.equal(error.code, "unavailable");
    return true;
  });
  await service.shutdown();
});

test("D4 live idle/prompt/bash/compact sessions all reject with session_busy: no stop, no catalog delete, no worker shutdown", async () => {
  const states: { label: string; state?: Partial<RuntimeSnapshot["state"]> }[] = [
    { label: "idle" },
    { label: "prompt", state: { isPromptRunning: true } },
    { label: "bash", state: { isBashRunning: true } },
    { label: "compact", state: { isCompacting: true } },
  ];
  for (const { label, state } of states) {
    const { service, workers, deleted, files, seed } = deleteHarness({
      worker: { readyDelayMs: 0, ...(state === undefined ? {} : { snapshot: busySnapshot("s1", state) }) },
    });
    seed("s1");
    await service.activate("s1");
    await assert.rejects(service.deleteSession("s1"), (error: unknown) => {
      assert.ok(error instanceof SessiondError, `${label}: must reject with a SessiondError`);
      assert.equal(error.code, "session_busy", `${label}: live delete must fail closed with session_busy`);
      assert.equal(error.retryable, false, `${label}: live delete conflict is not retryable`);
      return true;
    });
    assert.deepEqual(deleted, [], `${label}: catalog delete must never run`);
    assert.equal(files.get("s1"), true, `${label}: file must be retained`);
    assert.ok(!workers.workers[0]!.sent.some((item) => item.type === "worker.shutdown"), `${label}: worker must not be shut down`);
    assert.ok(service.listRunning().sessions.some((s) => s.sessionId === "s1"), `${label}: record must remain live`);
    await service.shutdown();
  }
});

test("D4 activation-delete race: in-flight activation wins → delete conflicts with session_busy and removes nothing", async () => {
  const { service, workers, deleted, files, seed } = deleteHarness({ worker: { readyDelayMs: 30 } });
  seed("s1");
  const activation = service.activate("s1");
  await waitUntil(() => service.diagnostics().activations === 1);
  await assert.rejects(service.deleteSession("s1"), (error: unknown) => {
    assert.ok(error instanceof SessiondError);
    assert.equal(error.code, "session_busy", "delete must conflict while an activation is in flight");
    return true;
  });
  const result = await activation;
  assert.equal(result.sessionId, "s1");
  assert.deepEqual(deleted, [], "delete must not remove the file when the activation won");
  assert.equal(files.get("s1"), true, "file must be retained after the activation won");
  assert.equal(workers.starts, 1);
  await service.shutdown();
});

test("D4 activation-delete race: delete commits first → activation fails not_found and starts no worker", async () => {
  let releaseDelete!: () => void;
  let deleteEntered = false;
  const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
  const { service, workers, files, deleted, seed } = deleteHarness({
    deleteSession: async (sessionId) => {
      deleteEntered = true;
      await deleteGate;
      files.set(sessionId, false);
      deleted.push(sessionId);
    },
  });
  seed("s1");
  const del = service.deleteSession("s1");
  await waitUntil(() => deleteEntered);
  // The delete holds the fence inside catalog.deleteSession; an activation
  // issued now must block until the delete commits, then fail not_found.
  const activation = service.activate("s1");
  await wait(20);
  assert.equal(workers.starts, 0, "no worker may start while the delete holds the fence");
  releaseDelete();
  await del;
  await assert.rejects(activation, (error: unknown) => {
    assert.ok(error instanceof SessiondError);
    assert.equal(error.code, "not_found", "activation after delete must fail closed with not_found");
    return true;
  });
  assert.deepEqual(deleted, ["s1"]);
  assert.equal(files.get("s1"), false);
  assert.equal(workers.starts, 0, "no worker may ever start for a deleted session");
  await service.shutdown();
});

test("D4 concurrent delete/delete serializes: exactly one success + one fixed not_found, no wrong-file risk", async () => {
  const { service, files, deleted, seed } = deleteHarness();
  seed("s1");
  const results = await Promise.allSettled([service.deleteSession("s1"), service.deleteSession("s1")]);
  const ok = results.filter((result) => result.status === "fulfilled").length;
  const notFound = results.filter((result) => {
    if (result.status !== "rejected") return false;
    const reason = result.reason as { code?: unknown };
    return reason !== null && typeof reason === "object" && reason.code === "not_found";
  }).length;
  assert.equal(ok, 1, "exactly one concurrent delete must succeed");
  assert.equal(notFound, 1, "the serialized second delete must fail with fixed not_found");
  assert.equal(files.get("s1"), false);
  assert.deepEqual(deleted, ["s1"], "the file must be removed exactly once");
  await service.shutdown();
});

// ---------------------------------------------------------------------------
// D4 fence regression: activate must NOT hold the global mutex across worker
// start (AsyncMutex.runExclusive awaits the callback result). The mutex is held
// only for the synchronous admission; the async operation runs outside the lock.
// ---------------------------------------------------------------------------

test("D4 fence: activate with worker sessionDiscovered rekey completes before workerStartTimeout and leaves no orphan", async () => {
  const { service, workers } = harness({
    worker: (input) => ({ readyDelayMs: 5, discoveredSessionId: `real-${input.sessionId}` }),
  });
  const started = Date.now();
  const result = await service.activate("s-requested");
  const elapsed = Date.now() - started;
  assert.equal(result.sessionId, "real-s-requested", "rekey must land on the authoritative id");
  assert.ok(elapsed < 400, `activate must complete well before workerStartTimeout (500ms); took ${elapsed}ms`);
  assert.equal(workers.starts, 1);
  assert.equal(service.diagnostics().activations, 0, "no activation entry may remain");
  assert.ok(service.listRunning().sessions.some((s) => s.sessionId === "real-s-requested"), "authoritative record must be live");
  await service.shutdown();
});

test("D4 fence: different-id activations with delayed readiness overlap (not service-wide serialized)", async () => {
  const { service, workers } = harness({ worker: { readyDelayMs: 40 } });
  const p1 = service.activate("a");
  const p2 = service.activate("b");
  // Both start() invocations happen as soon as each admission passes the brief
  // synchronous fence — never after the other's worker readiness.
  await wait(10);
  assert.equal(workers.starts, 2, "different-id activations must overlap, not serialize behind one worker start");
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.sessionId, "a");
  assert.equal(r2.sessionId, "b");
  assert.equal(workers.starts, 2);
  await service.shutdown();
});

test("D4 fence: same-id delete during a slow activation fails closed promptly; different-id delete is not blocked", async () => {
  const { service, workers, deleted, seed } = deleteHarness({ worker: { readyDelayMs: 300 } });
  seed("s1");
  seed("s2");
  const activation = service.activate("s1");
  await waitUntil(() => service.diagnostics().activations === 1);

  // Same-id delete: session_busy promptly, without waiting for the worker start.
  const sameStarted = Date.now();
  await assert.rejects(service.deleteSession("s1"), (error: unknown) => {
    assert.ok(error instanceof SessiondError);
    assert.equal(error.code, "session_busy");
    return true;
  });
  // The old (broken) code held the mutex across the 300ms worker start, so the
  // delete waited ~300ms. <250ms still fails old code while being generous for
  // the new prompt fail-closed path under CI load.
  assert.ok(Date.now() - sameStarted < 250, "same-id delete must fail closed promptly, not wait for the worker");

  // Different-id delete: not blocked by s1's slow activation lock.
  const otherStarted = Date.now();
  await service.deleteSession("s2");
  assert.ok(Date.now() - otherStarted < 250, "a different-id delete must not block behind another session's activation");
  assert.deepEqual(deleted, ["s2"]);

  await activation;
  assert.equal(workers.starts, 1);
  await service.shutdown();
});

test("D4 fence: joined same-id activate callers share one operation and only the admitted owner cleans the map", async () => {
  const { service, workers } = harness({ worker: { readyDelayMs: 5 } });
  const [a, b] = await Promise.all([service.activate("same"), service.activate("same")]);
  assert.equal(a.sessionId, "same");
  assert.equal(a.epoch, b.epoch, "joined callers must share the same operation/epoch");
  assert.equal(workers.starts, 1, "exactly one worker starts for joined callers");
  assert.equal(service.diagnostics().activations, 0, "the admitted owner must clean the activation map");
  await service.shutdown();
});

test("D4 fence: a rejected activation cleans its map entry and a retry re-admits cleanly", async () => {
  const locator: SessionLocatorPort = {
    async locate(sessionId) { return { sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, exists: false }; },
    async resolveLeafId() { return "leaf"; },
  };
  const service = new SessiondService({
    sessionLocator: locator,
    activationContext: { async resolve(sessionId, _l, requestedCwd) { return { cwd: requestedCwd ?? `/cwd/${sessionId}`, projectRoot: requestedCwd ?? `/cwd/${sessionId}` }; } },
    workerFactory: new FakeWorkerFactory({ readyDelayMs: 0 }),
  }, { workerStartTimeoutMs: 500, commandTimeoutMs: 500, idleTimeoutMs: 0 });
  const checkReject = async () => {
    await assert.rejects(service.activate("missing"), (error: unknown) => {
      assert.ok(error instanceof SessiondError);
      assert.equal(error.code, "not_found");
      return true;
    });
  };
  await checkReject();
  assert.equal(service.diagnostics().activations, 0, "a rejected activation must clean the map");
  // Retry re-admits cleanly (never stuck on a stale entry).
  await checkReject();
  assert.equal(service.diagnostics().activations, 0);
  await service.shutdown();
});

test("config idle timeout: default is 24h, get/set round-trips, invalid input fails closed", async () => {
  const deps = {
    sessionLocator: {
      async locate(sessionId: string) { return { sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, exists: true }; },
      async resolveLeafId() { return "leaf"; },
    },
    activationContext: { async resolve(sessionId: string, _l: unknown, cwd?: string) { return { cwd: cwd ?? `/cwd/${sessionId}`, projectRoot: cwd ?? `/cwd/${sessionId}` }; } },
    workerFactory: new FakeWorkerFactory(),
  };
  const service = new SessiondService(deps, { workerStartTimeoutMs: 500, commandTimeoutMs: 500 });
  // No explicit option, no settings file → the 1-day default.
  assert.equal(service.getIdleTimeoutMs(), 24 * 60 * 60_000);
  service.setIdleTimeoutMs(3_600_000);
  assert.equal(service.getIdleTimeoutMs(), 3_600_000);
  service.setIdleTimeoutMs(0);
  assert.equal(service.getIdleTimeoutMs(), 0, "0 disables idle reclamation");
  // Invalid input fails closed with the canonical port error.
  assert.throws(() => service.setIdleTimeoutMs(-1), (error: unknown) => {
    assert.ok(error instanceof SessiondError);
    assert.equal(error.code, "invalid_input");
    return true;
  });
  assert.throws(() => service.setIdleTimeoutMs(1.5), (error: unknown) => {
    assert.ok(error instanceof SessiondError);
    assert.equal(error.code, "invalid_input");
    return true;
  });
  await service.shutdown();
});

test("config idle timeout: settings file persists the value across service construction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pix-sessiond-idle-"));
  try {
    const settingsFile = join(dir, "settings.json");
    const deps = {
      sessionLocator: {
        async locate(sessionId: string) { return { sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, exists: true }; },
        async resolveLeafId() { return "leaf"; },
      },
      activationContext: { async resolve(sessionId: string, _l: unknown, cwd?: string) { return { cwd: cwd ?? `/cwd/${sessionId}`, projectRoot: cwd ?? `/cwd/${sessionId}` }; } },
      workerFactory: new FakeWorkerFactory(),
      settingsFile,
    };
    const first = new SessiondService(deps, { workerStartTimeoutMs: 500, commandTimeoutMs: 500 });
    assert.equal(first.getIdleTimeoutMs(), 24 * 60 * 60_000, "no file yet → default 24h");
    first.setIdleTimeoutMs(43_200_000);
    const persisted = JSON.parse(await readFile(settingsFile, "utf8"));
    assert.equal(persisted.idleTimeoutMs, 43_200_000);
    await first.shutdown();
    // A NEW service over the same file picks up the persisted value.
    const second = new SessiondService(deps, { workerStartTimeoutMs: 500, commandTimeoutMs: 500 });
    assert.equal(second.getIdleTimeoutMs(), 43_200_000, "persisted value wins over the 24h default");
    await second.shutdown();
    // Explicit options still win over the file (test override).
    const third = new SessiondService(deps, { workerStartTimeoutMs: 500, commandTimeoutMs: 500, idleTimeoutMs: 0 });
    assert.equal(third.getIdleTimeoutMs(), 0, "explicit option beats persisted value");
    await third.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("config idle timeout: RPC dispatch round-trips through SessiondApplication", async () => {
  const deps = {
    sessionLocator: {
      async locate(sessionId: string) { return { sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, exists: true }; },
      async resolveLeafId() { return "leaf"; },
    },
    activationContext: { async resolve(sessionId: string, _l: unknown, cwd?: string) { return { cwd: cwd ?? `/cwd/${sessionId}`, projectRoot: cwd ?? `/cwd/${sessionId}` }; } },
    workerFactory: new FakeWorkerFactory(),
  };
  const service = new SessiondService(deps, { workerStartTimeoutMs: 500, commandTimeoutMs: 500 });
  const app = new SessiondApplication(service);
  const got = await app.handle("config.getSessionIdleTimeoutMs", {});
  assert.equal(got.idleTimeoutMs, 24 * 60 * 60_000);
  const set = await app.handle("config.setSessionIdleTimeoutMs", { idleTimeoutMs: 7 * 24 * 60 * 60_000 });
  assert.equal(set.idleTimeoutMs, 7 * 24 * 60 * 60_000);
  assert.equal(service.getIdleTimeoutMs(), 7 * 24 * 60 * 60_000);
  await service.shutdown();
});
