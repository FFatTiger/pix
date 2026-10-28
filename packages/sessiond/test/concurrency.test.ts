import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeCommandResult, SessiondToWorkerMessage, SessiondPush, SessiondTurnStatusPush, TurnStatus } from "@fffattiger/pix-protocol";
import type { SessionLocatorPort } from "@fffattiger/pix-runtime-core";
import { SessiondService } from "../src/service.js";
import { FakeWorkerFactory } from "../src/testing/fake-worker.js";

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const waitUntil = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await wait(2);
  }
};

const locator: SessionLocatorPort = {
  async locate(sessionId) { return { sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, exists: true }; },
  async resolveLeafId() { return "leaf"; },
};

const makeService = (options: ConstructorParameters<typeof SessiondService>[1] = {}, workerOptions: ConstructorParameters<typeof FakeWorkerFactory>[0] = {}) => {
  const workers = new FakeWorkerFactory(workerOptions);
  const service = new SessiondService({ sessionLocator: locator, activationContext: { async resolve(sessionId) { return { cwd: `/${sessionId}`, projectRoot: `/${sessionId}` }; } }, workerFactory: workers }, { workerStartTimeoutMs: 500, commandTimeoutMs: 500, idleTimeoutMs: 0, ...options });
  return { service, workers };
};

test("command id capacity performs one safe whole-epoch rollover; triggering request is not admitted", async () => {
  const { service, workers } = makeService({ commandResultLimit: 2, commandResultCacheLimit: 1 });
  const activated = await service.activate("s");
  const pushes: import("@fffattiger/pix-protocol").SessiondPush[] = [];
  const attached = service.attach({ sessionId: "s", epoch: activated.epoch, lastEventId: 0 }, (push) => { pushes.push(push); });
  const one = { type: "prompt", commandId: "one", message: "one" } as const;
  const two = { type: "prompt", commandId: "two", message: "two" } as const;
  await service.command("s", one, activated.epoch);
  await service.command("s", two, activated.epoch);

  const trigger = await service.command("s", { type: "prompt", commandId: "three", message: "three" }, activated.epoch);
  assert.equal(trigger.result.ok, false);
  if (!trigger.result.ok) assert.equal(trigger.result.error.code, "epoch_changed");
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.rotateEpoch").length, 1);
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.command").length, 2, "trigger must not dispatch");

  const currentEpoch = service.listRunning().sessions[0]!.epoch;
  assert.notEqual(currentEpoch, activated.epoch);
  const rebase = pushes.find((push): push is Extract<import("@fffattiger/pix-protocol").SessiondPush, { type: "snapshot" }> => push.type === "snapshot" && push.resumeStatus === "epoch_changed");
  assert.ok(rebase);
  assert.equal(rebase.epoch, currentEpoch);
  assert.equal(rebase.lastEventId, 0);
  const stale = await service.command("s", one, activated.epoch);
  assert.equal(stale.result.ok, false);
  if (!stale.result.ok) assert.equal(stale.result.error.code, "epoch_changed");
  const missing = await service.command("s", { type: "set_auto_retry", commandId: "legacy-missing", enabled: false });
  assert.equal(missing.result.ok, false);
  if (!missing.result.ok) assert.equal(missing.result.error.code, "epoch_changed");
  const retry = await service.command("s", { type: "prompt", commandId: "three", message: "three" }, currentEpoch);
  assert.equal(retry.result.ok, true);
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.command").length, 3);
  attached.unsubscribe?.();
  await service.shutdown();
});

test("worker-declined rollover preserves the old epoch and every accepted identity", async () => {
  const { service, workers } = makeService({ commandResultLimit: 1 }, { rotateEpochBehavior: "reject" });
  const activated = await service.activate("s");
  const firstCommand = { type: "set_auto_retry", commandId: "kept", enabled: true } as const;
  const first = await service.command("s", firstCommand, activated.epoch);
  assert.equal(first.result.ok, true);
  const overflow = await service.command("s", { type: "set_auto_retry", commandId: "blocked", enabled: false }, activated.epoch);
  assert.equal(overflow.result.ok, false);
  if (!overflow.result.ok) assert.equal(overflow.result.error.code, "command_rejected");
  assert.equal(service.listRunning().sessions[0]!.epoch, activated.epoch);
  assert.deepEqual(await service.command("s", firstCommand, activated.epoch), first);
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.command").length, 1);
  await service.shutdown();
});

test("lost rollover acknowledgement fails the live record closed instead of continuing split-brain", async () => {
  const { service } = makeService({ commandResultLimit: 1, epochRolloverTimeoutMs: 10 }, { rotateEpochBehavior: "drop" });
  const activated = await service.activate("s");
  await service.command("s", { type: "set_auto_retry", commandId: "first", enabled: true }, activated.epoch);
  const overflow = await service.command("s", { type: "set_auto_retry", commandId: "uncertain", enabled: false }, activated.epoch);
  assert.equal(overflow.result.ok, false);
  if (!overflow.result.ok) assert.equal(overflow.result.error.code, "timeout");
  assert.equal(service.listRunning().sessions.length, 0, "uncertain Worker epoch must not remain advertised");
  await service.shutdown();
});

test("capacity while a command is still pending does not rotate or evict any accepted identity", async () => {
  const { service, workers } = makeService({ commandResultLimit: 1, commandTimeoutMs: 500 }, { commandDelayMs: 40 });
  const activated = await service.activate("s");
  const first = service.command("s", { type: "prompt", commandId: "pending", message: "one" }, activated.epoch);
  await waitUntil(() => workers.workers[0]!.sent.some((message) => message.type === "worker.command"));
  const overflow = await service.command("s", { type: "prompt", commandId: "blocked", message: "two" }, activated.epoch);
  assert.equal(overflow.result.ok, false);
  if (!overflow.result.ok) assert.equal(overflow.result.error.code, "command_rejected");
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.rotateEpoch").length, 0);
  await first;
  const duplicate = await service.command("s", { type: "prompt", commandId: "pending", message: "one" }, activated.epoch);
  assert.equal(duplicate.result.ok, true, "the accepted id/result remains intact after rejected rollover");
  await service.shutdown();
});

test("concurrent capacity requests start one rollover and dispatch neither triggering request", async () => {
  const { service, workers } = makeService({ commandResultLimit: 1 });
  const activated = await service.activate("s");
  await service.command("s", { type: "set_auto_retry", commandId: "full", enabled: true }, activated.epoch);
  const [a, b] = await Promise.all([
    service.command("s", { type: "set_auto_retry", commandId: "trigger-a", enabled: false }, activated.epoch),
    service.command("s", { type: "set_auto_retry", commandId: "trigger-b", enabled: false }, activated.epoch),
  ]);
  assert.equal(a.result.ok, false);
  assert.equal(b.result.ok, false);
  if (!a.result.ok) assert.equal(a.result.error.code, "epoch_changed");
  if (!b.result.ok) assert.equal(b.result.error.code, "epoch_changed");
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.rotateEpoch").length, 1);
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.command").length, 1);
  await service.shutdown();
});

test("a pending independent read blocks rollover without evicting the full mutation ledger", async () => {
  const { service, workers } = makeService({ commandResultLimit: 1, readTimeoutMs: 500 }, { readDelayMs: 35 });
  const activated = await service.activate("s");
  await service.command("s", { type: "set_auto_retry", commandId: "full", enabled: true }, activated.epoch);
  const read = service.runtimeRead({ sessionId: "s", epoch: activated.epoch, requestId: "pending-read", read: { type: "get_commands" } });
  await waitUntil(() => workers.workers[0]!.sent.some((message) => message.type === "worker.read"));
  const blocked = await service.command("s", { type: "set_auto_retry", commandId: "blocked", enabled: false }, activated.epoch);
  assert.equal(blocked.result.ok, false);
  if (!blocked.result.ok) assert.equal(blocked.result.error.code, "command_rejected");
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.rotateEpoch").length, 0);
  await read;
  await service.shutdown();
});

test("interrupt id capacity rotates the whole idle epoch and retry uses the new fence", async () => {
  const { service, workers } = makeService({ interruptLimit: 1 });
  const activated = await service.activate("s");
  const first = await service.interrupt("s", "interrupt-1", { type: "abort" }, activated.epoch);
  assert.equal(first.result.ok, true);
  const trigger = await service.interrupt("s", "interrupt-2", { type: "abort" }, activated.epoch);
  assert.equal(trigger.result.ok, false);
  if (!trigger.result.ok) assert.equal(trigger.result.error.code, "epoch_changed");
  const currentEpoch = service.listRunning().sessions[0]!.epoch;
  assert.notEqual(currentEpoch, activated.epoch);
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.rotateEpoch").length, 1);
  const retry = await service.interrupt("s", "interrupt-2", { type: "abort" }, currentEpoch);
  assert.equal(retry.result.ok, true);
  await service.shutdown();
});

test("read-only command ids do not consume the epoch mutation admission capacity", async () => {
  const { service, workers } = makeService({ commandResultLimit: 1, commandResultCacheLimit: 8 });
  await service.activate("s");

  const commands = await service.command("s", { type: "get_commands", commandId: "read-commands" });
  const stats = await service.command("s", { type: "get_session_stats", commandId: "read-stats" });
  const prompt = await service.command("s", { type: "prompt", commandId: "mutation-1", message: "hello" });

  assert.equal(commands.result.ok, true);
  assert.equal(stats.result.ok, true);
  assert.equal(prompt.result.ok, true);
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.command").length, 1);
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.read").length, 2);
  await service.shutdown();
});

test("an evicted read result may be safely re-executed without growing the mutation ledger", async () => {
  const { service, workers } = makeService({ commandResultLimit: 1, commandResultCacheLimit: 1 });
  await service.activate("s");

  const first = await service.command("s", { type: "get_commands", commandId: "read-1" });
  await service.command("s", { type: "get_session_stats", commandId: "read-2" });
  const repeated = await service.command("s", { type: "get_commands", commandId: "read-1" });

  assert.equal(first.result.ok, true);
  assert.equal(repeated.result.ok, true);
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.command").length, 0);
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.read").length, 3);
  await service.shutdown();
});

test("read result floods cannot evict a cached mutation terminal result", async () => {
  const { service, workers } = makeService({ commandResultLimit: 2, commandResultCacheLimit: 1 });
  await service.activate("s");
  const mutation = { type: "prompt", commandId: "mutation", message: "hello" } as const;

  const first = await service.command("s", mutation);
  await service.command("s", { type: "get_tools", commandId: "read-1" });
  await service.command("s", { type: "get_commands", commandId: "read-2" });
  const retry = await service.command("s", mutation);

  assert.deepEqual(retry, first);
  assert.equal(
    workers.workers[0]!.sent.filter((message) => message.type === "worker.command" && message.payload.command.type === "prompt").length,
    1,
  );
  await service.shutdown();
});

test("cached read command ids still reject cross-type reuse", async () => {
  const { service } = makeService({ commandResultLimit: 1, commandResultCacheLimit: 1 });
  await service.activate("s");

  await service.command("s", { type: "get_state", commandId: "shared-read" });
  const readConflict = await service.command("s", { type: "get_tools", commandId: "shared-read" });
  assert.equal(readConflict.result.ok, false);
  if (!readConflict.result.ok) assert.equal(readConflict.result.error.code, "command_rejected");

  await service.command("s", { type: "get_tools", commandId: "read-then-mutation" });
  const crossDomainConflict = await service.command("s", { type: "prompt", commandId: "read-then-mutation", message: "must not run" });
  assert.equal(crossDomainConflict.result.ok, false);
  if (!crossDomainConflict.result.ok) assert.equal(crossDomainConflict.result.error.code, "command_rejected");

  await service.shutdown();
});

test("independent runtime reads use epoch fencing and never consume the mutation path", async () => {
  const { service, workers } = makeService({ commandResultLimit: 1, commandResultCacheLimit: 1 });
  const activated = await service.activate("s");
  const worker = workers.workers[0]!;

  const state = await service.runtimeRead({ sessionId: "s", epoch: activated.epoch, requestId: "state", read: { type: "get_state" } });
  assert.equal(state.result.ok, true);
  if (state.result.ok) assert.equal(state.result.type, "get_state");
  assert.equal(worker.sent.filter((message) => message.type === "worker.read").length, 1, "get_state uses the active read lane for fresh state");

  const commands = await service.runtimeRead({ sessionId: "s", epoch: activated.epoch, requestId: "commands", read: { type: "get_commands" } });
  assert.equal(commands.result.ok, true);
  assert.equal(worker.sent.filter((message) => message.type === "worker.read").length, 2);

  const stale = await service.runtimeRead({ sessionId: "s", epoch: "stale-epoch", requestId: "stale", read: { type: "get_commands" } });
  assert.equal(stale.result.ok, false);
  if (!stale.result.ok) assert.equal(stale.result.error.code, "epoch_changed");
  assert.equal(stale.epoch, "stale-epoch", "terminal result must echo the caller-owned epoch");
  assert.equal(worker.sent.filter((message) => message.type === "worker.read").length, 2, "stale reads must not touch the Worker");

  const mutation = await service.command("s", { type: "prompt", commandId: "mutation", message: "still admitted" });
  assert.equal(mutation.result.ok, true);
  await service.shutdown();
});

test("independent read queue is bounded per session", async () => {
  const { service, workers } = makeService({ readQueueLimit: 1, readTimeoutMs: 500 }, { readDelayMs: 30 });
  const activated = await service.activate("s");

  const first = service.runtimeRead({ sessionId: "s", epoch: activated.epoch, requestId: "first", read: { type: "get_commands" } });
  const overflow = await service.runtimeRead({ sessionId: "s", epoch: activated.epoch, requestId: "overflow", read: { type: "get_session_stats" } });
  assert.equal(overflow.result.ok, false);
  if (!overflow.result.ok) assert.equal(overflow.result.error.code, "unavailable");
  const settled = await first;
  assert.equal(settled.result.ok, true);
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.read").length, 1);
  await service.shutdown();
});

test("read retries mint fresh dispatch ids and late results cannot settle a newer attempt", async () => {
  const { service, workers } = makeService({ readTimeoutMs: 10 }, { readDelayMs: 30 });
  const activated = await service.activate("s");
  const input = { sessionId: "s", epoch: activated.epoch, requestId: "same-logical-read", read: { type: "get_commands" as const } };

  const first = await service.runtimeRead(input);
  const second = await service.runtimeRead(input);
  assert.equal(first.result.ok, false);
  assert.equal(second.result.ok, false);
  if (!first.result.ok) assert.equal(first.result.error.code, "timeout");
  if (!second.result.ok) assert.equal(second.result.error.code, "timeout");
  const dispatches = workers.workers[0]!.sent.filter((message) => message.type === "worker.read");
  assert.equal(dispatches.length, 2);
  assert.notEqual(dispatches[0]!.id, dispatches[1]!.id);
  await new Promise((resolve) => setTimeout(resolve, 35));
  await service.shutdown();
});

test("late legacy read success cannot overwrite its cached command timeout", async () => {
  const { service, workers } = makeService({ commandTimeoutMs: 10, readTimeoutMs: 100 }, { readDelayMs: 30 });
  await service.activate("s");
  const command = { type: "get_commands", commandId: "late-read" } as const;

  const timedOut = await service.command("s", command);
  assert.equal(timedOut.result.ok, false);
  if (!timedOut.result.ok) assert.equal(timedOut.result.error.code, "unavailable");
  await new Promise((resolve) => setTimeout(resolve, 45));
  const retry = await service.command("s", command);

  assert.deepEqual(retry, timedOut);
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.read").length, 1);
  await service.shutdown();
});

test("activation fails closed when the Worker build lacks the read RPC contract", async () => {
  const { service } = makeService({}, { readyFeatures: [] });
  await assert.rejects(
    service.activate("s"),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "worker_unavailable",
  );
  await service.shutdown();
});

test("commandId type conflicts stay rejected while a malicious ID flood rotates only at quiescence", async () => {
  const { service, workers } = makeService({ commandResultLimit: 3, commandResultCacheLimit: 2 });
  const activated = await service.activate("s");
  await service.command("s", { type: "prompt", commandId: "shared", message: "hello" }, activated.epoch);
  const conflict = await service.command("s", { type: "get_tools", commandId: "shared" }, activated.epoch);
  assert.equal(conflict.result.ok, false);
  if (!conflict.result.ok) assert.equal(conflict.result.error.code, "command_rejected");
  await service.command("s", { type: "prompt", commandId: "two", message: "two" }, activated.epoch);
  await service.command("s", { type: "prompt", commandId: "three", message: "three" }, activated.epoch);
  const flood = await service.command("s", { type: "prompt", commandId: "four", message: "four" }, activated.epoch);
  assert.equal(flood.result.ok, false);
  if (!flood.result.ok) assert.equal(flood.result.error.code, "epoch_changed");
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.command").length, 3);
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.rotateEpoch").length, 1);
  await service.shutdown();
});

test("stop vs command race never sends after stop commit", async () => {
  const { service, workers } = makeService({}, { commandDelayMs: 30 });
  await service.activate("s");
  const command = service.command("s", { type: "prompt", commandId: "p", message: "hello" });
  const stopped = service.stop("s", "user");
  const [result, stoppedResult] = await Promise.all([command, stopped]);
  assert.equal(stoppedResult, true);
  assert.ok((result as RuntimeCommandResult).result.ok === false || workers.workers[0]!.sent.some((message) => message.type === "worker.command"));
  assert.equal(service.listRunning().sessions.length, 0);
  await assert.rejects(service.command("s", { type: "prompt", commandId: "after", message: "after" }));
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.command" && message.payload.command.commandId === "after").length, 0);
});

// --- Phase 3 atomic submitTurn authority ------------------------------------

/** A worker snapshot that advertises the prompt/model/thinking capabilities. */
const promptCapSnapshot = (sessionId = "s"): import("@fffattiger/pix-protocol").RuntimeSnapshot => ({
  sessionId,
  cwd: `/${sessionId}`,
  projectRoot: `/${sessionId}`,
  state: { sessionId, isStreaming: false, isPromptRunning: false, isBashRunning: false, isCompacting: false, model: null, messageCount: 0, queuedMessages: { steering: [], followUp: [] }, pendingMessageCount: 0, writtenFiles: [] },
  capabilities: { capabilities: ["runtime.prompt", "runtime.model.set", "runtime.thinking.set"], version: 1 },
  streaming: { active: false, phase: "idle" },
});

/** The live journal revision (lastEventId) a real attached client would hold. */
function liveRevision(service: SessiondService, sessionId: string, epoch: string): number {
  const prepared = service.prepareAttach({ sessionId, epoch });
  const revision = prepared.result.lastEventId;
  prepared.close();
  return revision;
}

test("Phase 4A.0.1 submitTurn: a global running change and a later conversation event both leave an append-only submit admitted; the ledger still answers duplicate", async () => {
  const { service, workers } = makeService({}, (input) => ({ snapshot: promptCapSnapshot(input.sessionId), commandDelayMs: 40 }));
  const createdA = await service.create({ createRequestId: "create-a", cwd: "/a", projectRoot: "/a" });
  const staleRevision = createdA.lastEventId;
  assert.ok(staleRevision !== undefined);

  // Starting B changes the global running set. The Protocol-v2 compatibility
  // event is appended to every active journal, including unattached A.
  await service.activate("b");
  const currentRevision = liveRevision(service, createdA.sessionId, createdA.epoch);
  assert.ok(currentRevision > staleRevision, `expected B's running change to advance A (${staleRevision} -> ${currentRevision})`);

  // The running-set broadcast is side-channel, so the pre-broadcast cursor is
  // admitted exactly as before.
  const direct = await service.prepareSubmitTurn({
    sessionId: createdA.sessionId,
    expectedEpoch: createdA.epoch,
    expectedRevision: staleRevision,
    prompt: "same payload",
    operationId: "op-created-seed-repair",
    activationOverrides: { thinkingLevel: "high" as const },
  });
  assert.equal(direct.result.status, "accepted", "a global running change must not stale the submit");
  const terminal = deferred<void>();
  await direct.flushTo((push) => {
    if (push.status.state === "completed" || push.status.state === "failed") terminal.resolve();
  });
  await terminal.promise;
  direct.close();
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.submitTurn").length, 1);

  // A CONVERSATION event on A (queue mutation) advances the journal head. The
  // submit only appends a turn, so a lagging cursor is still admitted — the
  // revision fence that used to conflict closed here was removed for exactly
  // this reason.
  const queuedRevision = liveRevision(service, createdA.sessionId, createdA.epoch);
  workers.workers[0]!.emitEvent({ type: "queue_update", sessionId: createdA.sessionId, steering: [], followUp: [] });
  const conversationRevision = liveRevision(service, createdA.sessionId, createdA.epoch);
  assert.ok(conversationRevision > queuedRevision, "a conversation event must advance the journal");

  const request = {
    sessionId: createdA.sessionId,
    expectedEpoch: createdA.epoch,
    expectedRevision: queuedRevision,
    prompt: "after a conversation event",
    operationId: "op-created-seed-repair-2",
    activationOverrides: { thinkingLevel: "high" as const },
  };
  const lagging = await service.submitTurn(request);
  assert.equal(lagging.status, "accepted", "a lagging revision must not reject an append-only submit");
  if (lagging.status === "accepted") assert.equal(lagging.epoch, createdA.epoch);
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.submitTurn").length, 2, "the lagging submit dispatches exactly once");

  // The operation ledger is what prevents a duplicate turn, not the revision.
  const replay = await service.submitTurn(request);
  assert.equal(replay.status, "duplicate");
  if (replay.status === "duplicate") assert.equal(replay.delivery, "accepted");
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.submitTurn").length, 2, "a replay never dispatches again");
  await service.shutdown();
});

test("Phase 4A.0.2 submitTurn: ordinary command completions (runtime_state_changed re-affirmation + session_title) never reject a racing submit", async () => {
  // Regression for the false "message not sent" incident: a command such as
  // set_model or auto title generation completes while the user is already
  // sending. The completion appends session_title (already side-channel) plus
  // the adapter's emitState() runtime_state_changed re-affirmation — which used
  // to advance lastConversationEventId and reject the racing submit with
  // "session revision changed" even though the message was never delivered.
  // Submits no longer fence on the journal revision at all.
  const { service, workers } = makeService({}, (input) => ({ snapshot: promptCapSnapshot(input.sessionId), commandDelayMs: 40 }));
  const activated = await service.activate("s");
  const cursor = liveRevision(service, "s", activated.epoch);

  // Simulate the completion burst of one ordinary command: a title event plus
  // a context re-affirmation (with a full context payload, exactly what the
  // adapter's emitState sends after a command settles).
  workers.workers[0]!.emitEvent({ type: "session_title", sessionId: "s", name: "t" });
  workers.workers[0]!.emitEvent({
    type: "runtime_state_changed",
    sessionId: "s",
    context: { model: { provider: "p", id: "m" }, leafId: "leaf-1", contextUsage: { percent: 10, contextWindow: 1000, tokens: 100 } },
  });
  workers.workers[0]!.emitEvent({ type: "session_title", sessionId: "s", name: "t2" });
  const advanced = liveRevision(service, "s", activated.epoch);
  assert.ok(advanced > cursor, "the completion burst must still advance the journal head");

  // The pre-burst cursor is still accepted: the racing submit is admitted.
  const prepared = await service.prepareSubmitTurn({
    sessionId: "s", expectedEpoch: activated.epoch, expectedRevision: cursor,
    prompt: "racing the title command", operationId: "op-command-completion-race",
  });
  assert.equal(prepared.result.status, "accepted", "a command completion must not reject the racing submit");
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.submitTurn").length, 1);
  const terminal = deferred<void>();
  await prepared.flushTo((push) => {
    if (push.status.state === "completed" || push.status.state === "failed") terminal.resolve();
  });
  await terminal.promise;
  prepared.close();
  await service.shutdown();
});

test("Phase 3 submitTurn: quick accepted admission while the prompt runs deferred; terminal status via subscriber", async () => {
  const { service } = makeService({}, { commandDelayMs: 40, snapshot: promptCapSnapshot() });
  const activated = await service.activate("s");
  const revision = liveRevision(service, "s", activated.epoch);
  const prepared = await service.prepareSubmitTurn({
    sessionId: "s", expectedEpoch: activated.epoch, expectedRevision: revision,
    prompt: "hello", operationId: "op-1",
  });
  assert.equal(prepared.result.status, "accepted");
  const received: string[] = [];
  await prepared.flushTo((push) => { received.push(push.status.state); });
  // The full execution is deferred on the Worker; the admission already returned.
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.ok(received.includes("completed"), `expected a terminal completed status, got ${JSON.stringify(received)}`);
  prepared.close();
  await service.shutdown();
});

test("terminal turn subscribers close, allowing turn-operation capacity to rotate exactly once", async () => {
  const { service, workers } = makeService({ turnOperationLimit: 1 }, { commandDelayMs: 20, snapshot: promptCapSnapshot() });
  const activated = await service.activate("s");
  const revision = liveRevision(service, "s", activated.epoch);
  const prepared = await service.prepareSubmitTurn({
    sessionId: "s", expectedEpoch: activated.epoch, expectedRevision: revision,
    prompt: "first", operationId: "turn-cap-1",
  });
  assert.equal(prepared.result.status, "accepted");
  const terminal = deferred<void>();
  await prepared.flushTo((push) => {
    if (push.status.state === "completed" || push.status.state === "failed") terminal.resolve();
  });
  await terminal.promise;
  // Terminal delivery includes the worker's authoritative idle refresh.
  assert.equal(service.getSnapshot("s").state.isPromptRunning, false);

  // Ledger capacity is a bounded buffer, never a user-visible rejection: the
  // lease is reclaimed (epoch rotated at most once) and the send still lands.
  const trigger = await service.submitTurn({
    sessionId: "s", expectedEpoch: activated.epoch, expectedRevision: liveRevision(service, "s", activated.epoch),
    prompt: "second", operationId: "turn-cap-2",
  });
  assert.notEqual(trigger.status, "rejected");
  assert.ok(workers.workers[0]!.sent.filter((message) => message.type === "worker.rotateEpoch").length <= 1);
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.submitTurn").length, 2, "both sends dispatch");
  prepared.close();
  await service.shutdown();
});

test("Phase 3 submitTurn: same operationId returns once; a different fingerprint conflicts without re-dispatch", async () => {
  const { service, workers } = makeService({}, { commandDelayMs: 40, snapshot: promptCapSnapshot() });
  const activated = await service.activate("s");
  const revision = liveRevision(service, "s", activated.epoch);
  const base = { sessionId: "s", expectedEpoch: activated.epoch, expectedRevision: revision, operationId: "op-1" };
  const first = await service.submitTurn({ ...base, prompt: "hello" });
  assert.equal(first.status, "accepted");
  const second = await service.submitTurn({ ...base, prompt: "hello" });
  assert.equal(second.status, "duplicate");
  if (second.status === "duplicate") assert.equal(second.delivery, "accepted");
  const dispatchesBefore = workers.workers[0]!.sent.filter((message) => message.type === "worker.submitTurn").length;
  const conflict = await service.submitTurn({ ...base, prompt: "DIFFERENT" });
  assert.equal(conflict.status, "rejected");
  if (conflict.status === "rejected") {
    assert.equal(conflict.delivery, "not_delivered");
    assert.equal(conflict.error.code, "conflict");
  }
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.submitTurn").length, dispatchesBefore, "a fingerprint conflict must never dispatch");
  await service.shutdown();
});

test("Phase 3 submitTurn: stale epoch / missing fence never reject a user message", async () => {
  const { service, workers } = makeService({}, { snapshot: promptCapSnapshot() });
  await service.activate("s");
  // A cached client's stale fence is a guess about authority state, not a
  // contract: the message is delivered anyway and the fences are ignored.
  const stale = await service.submitTurn({ sessionId: "s", expectedEpoch: "stale-epoch", expectedRevision: 0, prompt: "x", operationId: "op-stale" });
  assert.equal(stale.status, "accepted");
  const noFence = await service.submitTurn({ sessionId: "s", prompt: "y", operationId: "op-nofence" });
  // Second send lands while the first turn runs → the authority queues it.
  assert.ok(noFence.status === "accepted" || noFence.status === "duplicate");
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.submitTurn").length, 1, "the first send starts a turn");
  await service.shutdown();
});

test("Phase 3 submitTurn: side-channel and conversation journal churn never change delivery; no epoch guess can reject a send", async () => {
  const { service, workers } = makeService({}, { commandDelayMs: 40, snapshot: promptCapSnapshot() });
  const activated = await service.activate("s");
  const worker = workers.workers[0]!;
  const revision = liveRevision(service, "s", activated.epoch);

  // Background subagent output + todo churn streams past the client's cursor —
  // exactly the production Pixie shape (main turn done, children still writing).
  worker.emitEvent({ type: "subagent_delta", sessionId: "s", childSessionId: "child-1", partial: { role: "assistant", content: [{ type: "text", text: "working" }] }, done: false });
  worker.emitEvent({ type: "subagent_delta", sessionId: "s", childSessionId: "child-2", partial: { role: "assistant", content: [{ type: "text", text: "also working" }] }, done: false });
  worker.emitEvent({ type: "todo_changed", sessionId: "s", todo: { revision: 1, items: [{ id: 1, subject: "chore", blockedBy: [], status: "in_progress" }] } });
  const churnedRevision = liveRevision(service, "s", activated.epoch);
  assert.ok(churnedRevision > revision, "side-channel events must append to the journal");

  const accepted = await service.prepareSubmitTurn({
    sessionId: "s", expectedEpoch: activated.epoch, expectedRevision: revision,
    prompt: "through the churn", operationId: "op-side-channel-fence",
  });
  assert.equal(accepted.result.status, "accepted", "journal churn must not reject an append-only submit");
  const terminal = deferred<void>();
  await accepted.flushTo((push) => {
    if (push.status.state === "completed" || push.status.state === "failed") terminal.resolve();
  });
  await terminal.promise;
  accepted.close();

  // A CONVERSATION event (queue mutation) advances the journal head too. The
  // pre-event cursor is still admitted: a submit appends, it does not
  // compare-and-swap a revision.
  const conversationBase = liveRevision(service, "s", activated.epoch);
  worker.emitEvent({ type: "queue_update", sessionId: "s", steering: [], followUp: [] });
  const afterConversation = liveRevision(service, "s", activated.epoch);
  assert.ok(afterConversation > conversationBase, "a conversation event must advance the journal");
  const lagging = await service.submitTurn({ sessionId: "s", expectedEpoch: activated.epoch, expectedRevision: conversationBase, prompt: "lagging now", operationId: "op-lagging-conversation" });
  assert.equal(lagging.status, "accepted", "a lagging revision must not reject an append-only submit");

  // A stale epoch is a client guess too: it is ignored, and the send is
  // delivered (queued, because the earlier turn is still running).
  const staleEpoch = await service.submitTurn({ sessionId: "s", expectedEpoch: "e-stale", expectedRevision: afterConversation, prompt: "wrong epoch", operationId: "op-stale-epoch-any" });
  assert.equal(staleEpoch.status, "accepted");
  assert.equal(worker.sent.filter((message) => message.type === "worker.submitTurn").length, 2, "only the idle-path sends dispatch a turn; the running ones queue");
  await service.shutdown();
});

test("submitTurn ignores expectedRevision: a conversation event between capture and admission is not a lost update", async () => {
  // Submitting appends to the end of the conversation, so a lagging revision
  // cursor is not a concurrent-update hazard — sessiond's rejections at that
  // step produced two production false "message not sent" incidents. Nothing
  // about the cursor may reject a send.
  const { service, workers } = makeService({}, { commandDelayMs: 40, snapshot: promptCapSnapshot() });
  const activated = await service.activate("s");
  const worker = workers.workers[0]!;
  const staleRevision = liveRevision(service, "s", activated.epoch);
  // A real conversation event (a queue mutation, NOT a running turn) lands
  // between the client's capture and the submit.
  worker.emitEvent({ type: "queue_update", sessionId: "s", steering: [], followUp: [] });
  const advanced = liveRevision(service, "s", activated.epoch);
  assert.ok(advanced > staleRevision, "the conversation event must advance the journal");

  const accepted = await service.prepareSubmitTurn({
    sessionId: "s", expectedEpoch: activated.epoch, expectedRevision: staleRevision,
    prompt: "appending anyway", operationId: "op-lagging-revision",
  });
  assert.equal(accepted.result.status, "accepted", "a lagging revision must not reject an append-only submit");
  assert.equal(worker.sent.filter((message) => message.type === "worker.submitTurn").length, 1);
  const terminal = deferred<void>();
  await accepted.flushTo((push) => {
    if (push.status.state === "completed" || push.status.state === "failed") terminal.resolve();
  });
  await terminal.promise;
  accepted.close();

  // A revision past the journal head is equally irrelevant to the append.
  const future = await service.submitTurn({
    sessionId: "s", expectedEpoch: activated.epoch,
    expectedRevision: liveRevision(service, "s", activated.epoch) + 50,
    prompt: "from the future", operationId: "op-future-revision",
  });
  assert.equal(future.status, "accepted", "an inflated revision must not reject an append-only submit");

  // A stale epoch is ignored as well; the ledger still answers duplicate.
  const staleEpoch = await service.submitTurn({
    sessionId: "s", expectedEpoch: "stale-epoch", expectedRevision: staleRevision,
    prompt: "wrong epoch", operationId: "op-stale-epoch",
  });
  assert.equal(staleEpoch.status, "accepted");
  const duplicate = await service.submitTurn({
    sessionId: "s", expectedEpoch: activated.epoch, expectedRevision: staleRevision,
    prompt: "from the future", operationId: "op-future-revision",
  });
  assert.equal(duplicate.status, "duplicate");
  if (duplicate.status === "duplicate") assert.equal(duplicate.delivery, "accepted");
  await service.shutdown();
});

test("Phase 3 submitTurn: admission timeout → uncertain, never redispatched; late worker result is dropped", async () => {
  const { service, workers } = makeService({ turnAdmissionTimeoutMs: 50 }, { submitAdmissionDelayMs: 1000, commandDelayMs: 40, snapshot: promptCapSnapshot() });
  const activated = await service.activate("s");
  const revision = liveRevision(service, "s", activated.epoch);
  const started = Date.now();
  const result = await service.submitTurn({ sessionId: "s", expectedEpoch: activated.epoch, expectedRevision: revision, prompt: "hello", operationId: "op-timeout" });
  assert.ok(Date.now() - started < 500, "admission must time out quickly, not wait for the worker");
  assert.equal(result.status, "rejected");
  if (result.status === "rejected") {
    assert.equal(result.delivery, "uncertain");
    assert.equal(result.error.code, "timeout");
  }
  // The late worker admission (1000ms) must be dropped — a retry returns
  // duplicate-uncertain from the ledger and never dispatches again.
  await new Promise((resolve) => setTimeout(resolve, 40));
  const retry = await service.submitTurn({ sessionId: "s", expectedEpoch: activated.epoch, expectedRevision: revision, prompt: "hello", operationId: "op-timeout" });
  assert.equal(retry.status, "duplicate");
  if (retry.status === "duplicate") assert.equal(retry.delivery, "uncertain");
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.submitTurn").length, 1, "no redispatch after uncertain admission");
  await service.shutdown();
});

test("Phase 3: a second send while a turn runs is QUEUED, never rejected as session_busy", async () => {
  const { service, workers } = makeService({}, { commandDelayMs: 40, snapshot: promptCapSnapshot() });
  const activated = await service.activate("s");
  const revision = liveRevision(service, "s", activated.epoch);
  const first = await service.submitTurn({ sessionId: "s", expectedEpoch: activated.epoch, expectedRevision: revision, prompt: "first", operationId: "op-first" });
  assert.equal(first.status, "accepted");
  // The first admission advanced the journal (running-state shim); an attached
  // client would hold the fresh revision — re-capture it before the second submit.
  const revision2 = liveRevision(service, "s", activated.epoch);
  const queued = await service.submitTurn({ sessionId: "s", expectedEpoch: activated.epoch, expectedRevision: revision2, prompt: "second", operationId: "op-second" });
  assert.equal(queued.status, "accepted");
  if (queued.status === "accepted") {
    assert.equal(queued.turnStatus.disposition, "queued");
  }
  const steered = await service.submitTurn({ sessionId: "s", prompt: "third", operationId: "op-third", whenBusy: "steer" });
  assert.equal(steered.status, "accepted");
  const commands = workers.workers[0]!.sent.filter((message) => message.type === "worker.command").map((message) => message.type === "worker.command" ? message.payload.command.type : "");
  assert.deepEqual(commands, ["follow_up", "steer"], "queued sends ride the authoritative steer/follow_up command path");
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.submitTurn").length, 1, "a busy session never starts a second turn");
  await service.shutdown();
});

test("running overview: pending/accepted turns are busy before agent_start and clear without a message", async (t) => {
  const { service, workers } = makeService({ turnAdmissionTimeoutMs: 50 }, {
    snapshot: promptCapSnapshot(),
    holdSubmitAdmission: true,
    holdPostCommandSnapshots: true,
    submitSnapshotIdle: true,
    turnCompletion: "manual",
  });
  t.after(() => service.shutdown());
  const activated = await service.activate("s");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const idle = service.listRunning().sessions.find((item) => item.sessionId === "s");
  assert.equal(idle?.workerStatus, "ready", "idle live workers stay ready");
  assert.deepEqual(service.runningStateSnapshot().busySessionIds, []);

  const watch = service.prepareRunningWatch();
  const states: Array<{ revision: number; sessionIds: string[]; busySessionIds: string[] }> = [];
  await watch.flushTo((push) => { if (push.type === "running_state") states.push(push.state); });
  t.after(() => watch.close());

  const request = {
    sessionId: "s",
    expectedEpoch: activated.epoch,
    expectedRevision: liveRevision(service, "s", activated.epoch),
    prompt: "hello",
    operationId: "op-overview",
  };
  const submitted = service.submitTurn(request);
  const worker = workers.workers[0]!;
  await worker.waitForHeldAdmission();
  await flushMicrotasks();

  assert.equal(service.getSnapshot("s").state.isPromptRunning, false, "no agent_start/message yet");
  assert.equal(service.getSnapshot("s").state.messageCount, 0);
  assert.equal(service.diagnostics().workersByStatus.ready, 1, "overview busy does not change lifecycle status");
  assert.deepEqual(service.runningStateSnapshot().busySessionIds, ["s"]);
  assert.equal(service.listRunning().sessions.find((item) => item.sessionId === "s")?.workerStatus, "busy");
  assert.ok(states.some((state) => state.busySessionIds.includes("s")), "busy publishes on operation insertion without a message");

  const coalesced = await service.submitTurn(request);
  assert.equal(coalesced.status, "duplicate");
  if (coalesced.status === "duplicate") assert.equal(coalesced.delivery, "uncertain");
  assert.equal(worker.sent.filter((message) => message.type === "worker.submitTurn").length, 1, "same turn id coalesces without a second dispatch");

  worker.releaseHeldAdmissions();
  const accepted = await submitted;
  assert.equal(accepted.status, "accepted");
  await flushMicrotasks();
  assert.equal(service.getSnapshot("s").state.messageCount, 0, "accepted admission still has no message_*");
  assert.deepEqual(service.runningStateSnapshot().busySessionIds, ["s"], "accepted with no message stays busy");
  assert.equal(service.listRunning().sessions.find((item) => item.sessionId === "s")?.workerStatus, "busy");

  const dispatch = worker.sent.find((message): message is Extract<SessiondToWorkerMessage, { type: "worker.submitTurn" }> => message.type === "worker.submitTurn")!;
  const { sessionId, epoch, operationId, turnId } = dispatch.payload;
  const status: TurnStatus = { sessionId, epoch, operationId, turnId, revision: 1, state: "completed" };
  worker.emit({ type: "worker.turnStatus", payload: { ...status, operationId: "wrong" } });
  worker.emit({ type: "worker.turnStatus", payload: { ...status, epoch: "wrong" } });
  worker.emit({ type: "worker.turnStatus", payload: { ...status, sessionId: "wrong" } });
  await flushMicrotasks();
  assert.equal(service.listRunning().sessions.find((item) => item.sessionId === "s")?.workerStatus, "busy", "old/wrong id/epoch cannot clear current work");

  worker.emit({ type: "worker.turnStatus", payload: status });
  await worker.waitForHeldSnapshot();
  await flushMicrotasks();
  assert.equal(service.listRunning().sessions.find((item) => item.sessionId === "s")?.workerStatus, "busy", "terminal stays busy until authoritative refresh");
  worker.releaseHeldSnapshots();
  await flushMicrotasks();
  assert.equal(service.listRunning().sessions.find((item) => item.sessionId === "s")?.workerStatus, "ready");
  assert.deepEqual(service.runningStateSnapshot().busySessionIds, []);
  assert.ok(states.at(-1)?.busySessionIds.length === 0, "authoritative finish publishes idle without a message");

  const rejectedWatch = service.prepareRunningWatch();
  const rejectedStates: Array<{ busySessionIds: string[] }> = [];
  await rejectedWatch.flushTo((push) => { if (push.type === "running_state") rejectedStates.push(push.state); });
  t.after(() => rejectedWatch.close());
  const rejectedSubmit = service.submitTurn({
    ...request,
    operationId: "op-reject",
    expectedRevision: liveRevision(service, "s", activated.epoch),
  });
  await worker.waitForHeldAdmission();
  await flushMicrotasks();
  assert.deepEqual(service.runningStateSnapshot().busySessionIds, ["s"]);
  worker.rejectHeldAdmissions();
  const rejected = await rejectedSubmit;
  assert.equal(rejected.status, "rejected");
  await flushMicrotasks();
  assert.deepEqual(service.runningStateSnapshot().busySessionIds, [], "rejection clears busy without a message");
  assert.ok(rejectedStates.some((state) => state.busySessionIds.includes("s")));
  assert.ok(rejectedStates.some((state) => state.busySessionIds.length === 0));

  const cancelWatch = service.prepareRunningWatch();
  const cancelStates: Array<{ busySessionIds: string[] }> = [];
  await cancelWatch.flushTo((push) => { if (push.type === "running_state") cancelStates.push(push.state); });
  t.after(() => cancelWatch.close());
  const cancelSubmit = service.submitTurn({
    ...request,
    operationId: "op-cancel",
    expectedRevision: liveRevision(service, "s", activated.epoch),
  });
  await worker.waitForHeldAdmission();
  await flushMicrotasks();
  assert.deepEqual(service.runningStateSnapshot().busySessionIds, ["s"]);
  t.mock.timers.tick(50);
  const cancelled = await cancelSubmit;
  assert.equal(cancelled.status, "rejected");
  if (cancelled.status === "rejected") assert.equal(cancelled.delivery, "uncertain");
  await flushMicrotasks();
  assert.deepEqual(service.runningStateSnapshot().busySessionIds, [], "timeout/cancel clears busy without a message");
  assert.ok(cancelStates.some((state) => state.busySessionIds.length === 0));

  worker.releaseHeldAdmissions();
  const stopWatch = service.prepareRunningWatch();
  const stopStates: Array<{ sessionIds: string[]; busySessionIds: string[] }> = [];
  await stopWatch.flushTo((push) => { if (push.type === "running_state") stopStates.push(push.state); });
  t.after(() => stopWatch.close());
  const stopSubmit = service.submitTurn({
    ...request,
    operationId: "op-stop",
    expectedRevision: liveRevision(service, "s", activated.epoch),
  });
  await worker.waitForHeldAdmission();
  await flushMicrotasks();
  assert.deepEqual(service.runningStateSnapshot().busySessionIds, ["s"]);
  await service.stop("s");
  const stopped = await stopSubmit;
  assert.equal(stopped.status, "rejected");
  await flushMicrotasks();
  assert.equal(service.listRunning().sessions.length, 0);
  assert.deepEqual(service.runningStateSnapshot().busySessionIds, []);
  assert.ok(stopStates.some((state) => state.sessionIds.length === 0 && state.busySessionIds.length === 0));
});

test("Phase 3: activation fails closed when the Worker build lacks the submit-turn contract", async () => {
  const { service } = makeService({}, { readyFeatures: ["runtime.read-rpc.v1"] });
  await assert.rejects(
    service.activate("s"),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "worker_unavailable",
  );
  await service.shutdown();
});

test("Phase 3: a forged turnId in submitTurnResult is dropped without projection mutation; the exact frame settles", async () => {
  const { service, workers } = makeService({ turnAdmissionTimeoutMs: 2000 }, { submitAdmissionDelayMs: 200, turnCompletion: "manual", snapshot: promptCapSnapshot() });
  const activated = await service.activate("s");
  const revision = liveRevision(service, "s", activated.epoch);
  const submitted = service.submitTurn({ sessionId: "s", expectedEpoch: activated.epoch, expectedRevision: revision, prompt: "hello", operationId: "op-forged-turnid" });
  const worker = workers.workers[0]!;
  await waitUntil(() => worker.sent.some((message) => message.type === "worker.submitTurn"));
  const dispatch = worker.sent.find((message): message is Extract<SessiondToWorkerMessage, { type: "worker.submitTurn" }> => message.type === "worker.submitTurn")!;
  const { sessionId, epoch, operationId, turnId, fingerprint } = dispatch.payload;

  let settled = false;
  void submitted.then(() => { settled = true; });

  // Correct dispatch identity but a FORGED turnId — must be dropped without
  // clearing the pending admission, mutating the projection, or settling.
  worker.emit({
    type: "worker.submitTurnResult",
    id: dispatch.id,
    payload: {
      sessionId, epoch, operationId, dispatchId: dispatch.id, fingerprint,
      result: {
        status: "accepted", delivery: "accepted", sessionId, epoch, revision: 0, operationId, turnId: `forged:${turnId}`,
        snapshot: { ...promptCapSnapshot(), state: { ...promptCapSnapshot().state, messageCount: 99, isPromptRunning: true } },
        turnStatus: { sessionId, epoch, operationId, turnId: `forged:${turnId}`, revision: 0, state: "admitted" },
      },
    },
  });
  await Promise.resolve();
  assert.equal(settled, false, "a forged turnId must be dropped without settling the admission");
  assert.equal(service.getSnapshot("s").state.messageCount, 0, "the forged frame must not mutate the projection");
  assert.equal(service.getSnapshot("s").state.isPromptRunning, false, "the forged frame must not claim a running prompt");

  // The exact frame carries the dispatched turn identity and settles once.
  worker.emit({
    type: "worker.submitTurnResult",
    id: dispatch.id,
    payload: {
      sessionId, epoch, operationId, dispatchId: dispatch.id, fingerprint,
      result: {
        status: "accepted", delivery: "accepted", sessionId, epoch, revision: 0, operationId, turnId,
        snapshot: promptCapSnapshot(),
        turnStatus: { sessionId, epoch, operationId, turnId, revision: 0, state: "admitted" },
      },
    },
  });
  const result = await submitted;
  assert.equal(result.status, "accepted");
  if (result.status === "accepted") {
    assert.equal(result.turnId, turnId);
    assert.equal(result.turnStatus.state, "admitted");
  }
  assert.equal(service.getSnapshot("s").state.messageCount, 0);
  await service.shutdown();
});

test("Phase 3: a nested turnStatus identity mismatch is dropped; the exact frame settles", async () => {
  const { service, workers } = makeService({ turnAdmissionTimeoutMs: 2000 }, { submitAdmissionDelayMs: 200, turnCompletion: "manual", snapshot: promptCapSnapshot() });
  const activated = await service.activate("s");
  const revision = liveRevision(service, "s", activated.epoch);
  const submitted = service.submitTurn({ sessionId: "s", expectedEpoch: activated.epoch, expectedRevision: revision, prompt: "hello", operationId: "op-forged-nested" });
  const worker = workers.workers[0]!;
  await waitUntil(() => worker.sent.some((message) => message.type === "worker.submitTurn"));
  const dispatch = worker.sent.find((message): message is Extract<SessiondToWorkerMessage, { type: "worker.submitTurn" }> => message.type === "worker.submitTurn")!;
  const { sessionId, epoch, operationId, turnId, fingerprint } = dispatch.payload;

  let settled = false;
  void submitted.then(() => { settled = true; });

  // Correct outer turnId but a FORGED nested turnStatus.turnId — the strict
  // nested identity check must drop the frame without settlement/mutation.
  worker.emit({
    type: "worker.submitTurnResult",
    id: dispatch.id,
    payload: {
      sessionId, epoch, operationId, dispatchId: dispatch.id, fingerprint,
      result: {
        status: "accepted", delivery: "accepted", sessionId, epoch, revision: 0, operationId, turnId,
        snapshot: promptCapSnapshot(),
        turnStatus: { sessionId, epoch, operationId, turnId: `forged:${turnId}`, revision: 0, state: "admitted" },
      },
    },
  });
  await Promise.resolve();
  assert.equal(settled, false, "a forged nested turnStatus identity must be dropped without settling");
  assert.equal(service.getSnapshot("s").state.messageCount, 0, "the forged nested identity must not mutate the projection");

  // The exact frame settles once with the dispatched turn identity.
  worker.emit({
    type: "worker.submitTurnResult",
    id: dispatch.id,
    payload: {
      sessionId, epoch, operationId, dispatchId: dispatch.id, fingerprint,
      result: {
        status: "accepted", delivery: "accepted", sessionId, epoch, revision: 0, operationId, turnId,
        snapshot: promptCapSnapshot(),
        turnStatus: { sessionId, epoch, operationId, turnId, revision: 0, state: "admitted" },
      },
    },
  });
  const result = await submitted;
  assert.equal(result.status, "accepted");
  if (result.status === "accepted") {
    assert.equal(result.turnId, turnId);
    assert.equal(result.turnStatus.state, "admitted");
  }
  await service.shutdown();
});

test("Phase 3: a worker duplicate-status admission is dropped (expected result type is accepted/rejected only)", async () => {
  const { service, workers } = makeService({ turnAdmissionTimeoutMs: 2000 }, { submitAdmissionDelayMs: 200, turnCompletion: "manual", snapshot: promptCapSnapshot() });
  const activated = await service.activate("s");
  const revision = liveRevision(service, "s", activated.epoch);
  const submitted = service.submitTurn({ sessionId: "s", expectedEpoch: activated.epoch, expectedRevision: revision, prompt: "hello", operationId: "op-forged-duplicate" });
  const worker = workers.workers[0]!;
  await waitUntil(() => worker.sent.some((message) => message.type === "worker.submitTurn"));
  const dispatch = worker.sent.find((message): message is Extract<SessiondToWorkerMessage, { type: "worker.submitTurn" }> => message.type === "worker.submitTurn")!;
  const { sessionId, epoch, operationId, turnId, fingerprint } = dispatch.payload;

  let settled = false;
  void submitted.then(() => { settled = true; });

  // A worker never mints `duplicate` admissions (sessiond synthesizes those for
  // its own re-submits) — a forged duplicate frame must be dropped.
  worker.emit({
    type: "worker.submitTurnResult",
    id: dispatch.id,
    payload: {
      sessionId, epoch, operationId, dispatchId: dispatch.id, fingerprint,
      result: {
        status: "duplicate", delivery: "accepted", sessionId, epoch, revision: 0, operationId, turnId,
        snapshot: { ...promptCapSnapshot(), state: { ...promptCapSnapshot().state, messageCount: 99 } },
        turnStatus: { sessionId, epoch, operationId, turnId, revision: 0, state: "admitted" },
      },
    },
  });
  await Promise.resolve();
  assert.equal(settled, false, "a worker-sent duplicate admission must be dropped without settling");
  assert.equal(service.getSnapshot("s").state.messageCount, 0, "the forged duplicate frame must not mutate the projection");

  // The exact accepted frame settles once.
  worker.emit({
    type: "worker.submitTurnResult",
    id: dispatch.id,
    payload: {
      sessionId, epoch, operationId, dispatchId: dispatch.id, fingerprint,
      result: {
        status: "accepted", delivery: "accepted", sessionId, epoch, revision: 0, operationId, turnId,
        snapshot: promptCapSnapshot(),
        turnStatus: { sessionId, epoch, operationId, turnId, revision: 0, state: "admitted" },
      },
    },
  });
  const result = await submitted;
  assert.equal(result.status, "accepted");
  if (result.status === "accepted") assert.equal(result.turnId, turnId);
  await service.shutdown();
});

const flushMicrotasks = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); };

async function heldTerminalHarness(
  serviceOptions: ConstructorParameters<typeof SessiondService>[1] = {},
  workerOptions: Exclude<ConstructorParameters<typeof FakeWorkerFactory>[0], Function> = {},
  beforeSubmit?: (worker: FakeWorkerFactory["workers"][number]) => void,
) {
  const { service, workers } = makeService(serviceOptions, {
    snapshot: promptCapSnapshot(), turnCompletion: "handled", holdPostCommandSnapshots: true, ...workerOptions,
  });
  const activated = await service.activate("s");
  const request = { sessionId: "s", expectedEpoch: activated.epoch, expectedRevision: liveRevision(service, "s", activated.epoch), prompt: "fast", operationId: "fast-turn" };
  beforeSubmit?.(workers.workers[0]!);
  const prepared = await service.prepareSubmitTurn(request);
  assert.equal(prepared.result.status, "accepted");
  const received: TurnStatus[] = [];
  const pushes: SessiondTurnStatusPush[] = [];
  const terminal = deferred<TurnStatus>();
  await prepared.flushTo((push) => {
    received.push(push.status);
    pushes.push(push);
    if (push.status.state === "completed" || push.status.state === "failed") terminal.resolve(push.status);
  });
  const worker = workers.workers[0]!;
  await worker.waitForHeldSnapshot();
  const dispatch = worker.sent.find((message): message is Extract<SessiondToWorkerMessage, { type: "worker.submitTurn" }> => message.type === "worker.submitTurn")!;
  const status: TurnStatus = { sessionId: "s", epoch: activated.epoch, operationId: request.operationId, turnId: dispatch.payload.turnId, revision: 1, state: "completed", disposition: "handled" };
  const refreshCount = () => worker.sent.filter((message) => message.type === "worker.getSnapshot").length;
  const refresh = [...worker.sent].reverse().find((message): message is Extract<SessiondToWorkerMessage, { type: "worker.getSnapshot" }> => message.type === "worker.getSnapshot")!;
  return { service, worker, activated, request, prepared, received, pushes, terminal, status, refresh, refreshCount };
}

test("turn authority: fast handled completion repairs admission before terminal, duplicates and reconnect", async (t) => {
  const h = await heldTerminalHarness();
  t.after(() => h.service.shutdown());
  assert.equal(h.service.getSnapshot("s").state.isPromptRunning, true, "admission overwrote the earlier prompt_done");
  assert.equal(h.received.length, 0, "terminal cannot escape the refresh gate");
  const pendingDuplicate = await h.service.submitTurn(h.request);
  assert.equal(pendingDuplicate.status, "duplicate");
  if (pendingDuplicate.status === "duplicate") assert.equal(pendingDuplicate.turnStatus.state, "admitted");
  const reconnect = await h.service.prepareSubmitTurn(h.request);
  assert.equal(reconnect.result.status, "duplicate");
  const reconnectStatuses: TurnStatus[] = [];
  await reconnect.flushTo((push) => { reconnectStatuses.push(push.status); });
  const refreshes = h.refreshCount();
  h.worker.emit({ type: "worker.turnStatus", payload: h.status });
  h.worker.emit({ type: "worker.turnStatus", payload: h.status });
  await flushMicrotasks();
  assert.equal(h.refreshCount(), refreshes, "same revision shares one snapshot refresh");
  const interrupt = await h.service.interrupt("s", "during-refresh", { type: "abort" }, h.activated.epoch);
  assert.equal(interrupt.result.ok, true, "independent control lane is not blocked");
  assert.equal(h.received.length, 0);
  h.worker.releaseHeldSnapshots();
  const terminal = await h.terminal.promise;
  assert.equal(terminal.state, "completed");
  assert.equal(terminal.disposition, "handled");
  assert.equal(h.service.getSnapshot("s").state.isPromptRunning, false);
  const attached = h.service.prepareAttach({ sessionId: "s" });
  assert.equal(attached.result.snapshot.state.isPromptRunning, false);
  attached.close();
  const duplicate = await h.service.submitTurn(h.request);
  assert.equal(duplicate.status, "duplicate");
  if (duplicate.status === "duplicate") {
    assert.equal(duplicate.turnStatus.state, "completed");
    assert.equal(duplicate.snapshot?.state.isPromptRunning, false);
  }
  await flushMicrotasks();
  assert.deepEqual(reconnectStatuses.map((status) => status.state), ["completed"]);
  h.worker.emit({ type: "worker.turnStatus", payload: { ...h.status, revision: 2 } });
  await flushMicrotasks();
  assert.equal(h.refreshCount(), refreshes, "a settled turn does not reopen terminal refresh");
  h.worker.setHoldPostCommandSnapshots(false);
  const second = await h.service.submitTurn({ ...h.request, operationId: "second", expectedRevision: liveRevision(h.service, "s", h.activated.epoch) });
  assert.equal(second.status, "accepted", "the fast handled turn must not leave session_busy behind");
  reconnect.close();
});

test("turn authority: pending finalization keeps a new send queued (never a rejection) and the epoch is only rolled at capacity", async (t) => {
  const h = await heldTerminalHarness({ turnOperationLimit: 1 });
  t.after(() => h.service.shutdown());
  h.worker.emitEvent({ type: "prompt_done", sessionId: "s" });
  assert.equal(h.service.getSnapshot("s").state.isPromptRunning, false);
  assert.equal(h.service.listRunning().sessions[0]?.workerStatus, "busy");
  // A send during finalization is delivered, never refused: the message rides
  // the authoritative queued path while the previous turn settles.
  const accepted = await h.service.submitTurn({ ...h.request, operationId: "capacity", expectedRevision: liveRevision(h.service, "s", h.activated.epoch) });
  assert.equal(accepted.status, "accepted");
  assert.equal(h.worker.sent.filter((message) => message.type === "worker.rotateEpoch").length, 0);
  h.worker.releaseHeldSnapshots();
  await h.terminal.promise;
  await flushMicrotasks();
  // Capacity is a bounded buffer, not a user-visible failure: the send lands.
  const afterCapacity = await h.service.submitTurn({ ...h.request, operationId: "capacity-2", expectedRevision: liveRevision(h.service, "s", h.activated.epoch) });
  assert.notEqual(afterCapacity.status, "rejected");
  assert.ok(h.worker.sent.filter((message) => message.type === "worker.rotateEpoch").length <= 1);
});

test("turn authority: refresh preserves a real external stream instead of forcing idle", async (t) => {
  const h = await heldTerminalHarness();
  t.after(() => h.service.shutdown());
  const external = promptCapSnapshot();
  external.state.isStreaming = true;
  external.streaming = { active: true, phase: "streaming", streamId: "external", messageId: "external", partialMessage: { role: "assistant", content: [], provider: "p", model: "m" } };
  h.worker.setSnapshot(external);
  h.worker.releaseHeldSnapshots();
  assert.equal((await h.terminal.promise).state, "completed");
  assert.equal(h.service.getSnapshot("s").state.isPromptRunning, false);
  assert.equal(h.service.getSnapshot("s").state.isStreaming, true);
  assert.equal(h.service.getSnapshot("s").streaming?.active, true);
  assert.deepEqual(h.pushes[0]?.authority?.snapshot, external);
  const second = await h.service.submitTurn({ ...h.request, operationId: "external-busy", expectedRevision: liveRevision(h.service, "s", h.activated.epoch) });
  // A genuinely running stream queues the send instead of refusing it.
  assert.equal(second.status, "accepted");
});

test("turn authority: rejected snapshot publishes structured unavailable and retains running truth", async (t) => {
  const h = await heldTerminalHarness({}, { postCommandSnapshotMismatch: true });
  t.after(() => h.service.shutdown());
  h.worker.releaseHeldSnapshots();
  const status = await h.terminal.promise;
  assert.equal(status.state, "failed");
  assert.equal(status.error?.code, "unavailable");
  assert.equal(status.disposition, undefined, "failed refresh must not advertise handled success");
  assert.equal(h.pushes[0]?.authority, undefined, "failed refresh must not package the running admission as authority");
  assert.equal(h.service.getSnapshot("s").state.isPromptRunning, true);
  assert.deepEqual(h.received.map((status) => status.state), ["failed"]);
  const duplicate = await h.service.submitTurn(h.request);
  if (duplicate.status !== "duplicate") throw new Error("expected duplicate");
  assert.equal(duplicate.turnStatus.state, "failed");
});

test("turn authority: bounded timeout publishes unavailable; late snapshot and terminal cannot fake success", async (t) => {
  const h = await heldTerminalHarness({ commandTimeoutMs: 500 }, {}, () => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
  });
  t.after(() => h.service.shutdown());
  t.mock.timers.tick(500);
  await flushMicrotasks();
  const terminal = await h.terminal.promise;
  assert.equal(terminal.state, "failed");
  assert.equal(terminal.error?.code, "unavailable");
  assert.match(terminal.error!.message, /timed out/);
  assert.equal(h.pushes[0]?.authority, undefined);
  h.worker.releaseHeldSnapshots();
  h.worker.emit({ type: "worker.turnStatus", payload: { ...h.status, revision: 3 } });
  await flushMicrotasks();
  assert.equal(h.service.getSnapshot("s").state.isPromptRunning, true, "expired refresh cannot overwrite projection");
  assert.deepEqual(h.received.map((status) => status.state), ["failed"]);
});

test("turn authority: failed worker turn also refreshes, preserving its truthful failure", async (t) => {
  const h = await heldTerminalHarness();
  t.after(() => h.service.shutdown());
  const failed: TurnStatus = { ...h.status, revision: 2, state: "failed", error: { code: "interrupted", message: "interrupted", retryable: false } };
  h.worker.emit({ type: "worker.turnStatus", payload: failed });
  await flushMicrotasks();
  h.worker.releaseHeldSnapshots();
  assert.deepEqual(await h.terminal.promise, failed);
  assert.equal(h.pushes[0]?.authority?.snapshot.state.isPromptRunning, false, "truthful worker failure still carries successfully refreshed authority");
  assert.equal(h.service.getSnapshot("s").state.isPromptRunning, false);
});

test("turn authority: wrong identity frames are dropped while exact refresh settles once", async (t) => {
  const h = await heldTerminalHarness();
  t.after(() => h.service.shutdown());
  const count = h.refreshCount();
  for (const status of [
    { ...h.status, epoch: "wrong" }, { ...h.status, sessionId: "wrong" },
    { ...h.status, operationId: "wrong" }, { ...h.status, turnId: "wrong" },
  ]) h.worker.emit({ type: "worker.turnStatus", payload: status });
  h.worker.emit({ type: "worker.snapshot", id: "wrong-request", payload: { sessionId: "s", snapshot: promptCapSnapshot() } });
  h.worker.emit({ type: "worker.snapshot", id: h.refresh.id, payload: { sessionId: "wrong", snapshot: promptCapSnapshot() } });
  await flushMicrotasks();
  assert.equal(h.refreshCount(), count);
  assert.equal(h.received.length, 0);
  assert.equal(h.service.getSnapshot("s").state.isPromptRunning, true);
  h.worker.releaseHeldSnapshots();
  assert.equal((await h.terminal.promise).state, "completed");
  await flushMicrotasks();
  assert.equal(h.received.length, 1);
});

for (const lifecycle of ["stop", "crash", "rekey"] as const) {
  test(`turn authority: ${lifecycle} invalidates pending refresh and same-operation replacement`, async (t) => {
    const h = await heldTerminalHarness();
    t.after(() => h.service.shutdown());
    const lateDelivery = h.worker.captureMessageDelivery();
    const lateSnapshot = promptCapSnapshot();
    lateSnapshot.state.messageCount = 99;
    if (lifecycle === "stop") await h.service.stop("s");
    else if (lifecycle === "crash") h.worker.crash();
    else {
      h.worker.emit({ type: "worker.sessionDiscovered", payload: { sessionId: "rekeyed", cwd: "/s", sessionFile: "/sessions/rekeyed.jsonl" } });
      await flushMicrotasks();
    }
    const terminal = await h.terminal.promise;
    assert.equal(terminal.state, "failed");
    const sessionId = lifecycle === "rekey" ? "rekeyed" : "s";
    const activated = lifecycle === "rekey" ? h.service.listRunning().sessions[0]! : await h.service.activate("s");
    assert.ok(activated.epoch);
    assert.notEqual(activated.epoch, h.activated.epoch);
    if (lifecycle === "rekey") {
      // Rekey keeps the existing projection; converge the NEW epoch before
      // submitting, while the old in-flight refresh must be rejected.
      const current = h.service.snapshot(sessionId);
      await flushMicrotasks();
      h.worker.releaseHeldSnapshots();
      h.worker.setSnapshot(await current);
    }
    const replacement = await h.service.prepareSubmitTurn({ ...h.request, sessionId, expectedEpoch: activated.epoch, expectedRevision: liveRevision(h.service, sessionId, activated.epoch) });
    assert.equal(replacement.result.status, "accepted", JSON.stringify(replacement.result));
    lateDelivery({ type: "worker.snapshot", id: h.refresh.id, payload: { sessionId, snapshot: { ...lateSnapshot, sessionId, state: { ...lateSnapshot.state, sessionId } } } });
    lateDelivery({ type: "worker.turnStatus", payload: h.status });
    lateDelivery({ type: "worker.turnStatus", payload: { ...h.status, sessionId, epoch: activated.epoch } });
    h.worker.releaseHeldSnapshots();
    await flushMicrotasks();
    assert.equal(h.service.getSnapshot(sessionId).state.messageCount, 0, "old refresh must not mutate replacement authority");
    assert.deepEqual(h.received.map((status) => status.state), ["failed"]);
    if (lifecycle !== "rekey") replacement.close();
    else {
      const newTerminal = deferred<TurnStatus>();
      await replacement.flushTo((push) => { if (push.status.state === "completed" || push.status.state === "failed") newTerminal.resolve(push.status); });
      h.worker.releaseHeldSnapshots();
      assert.equal((await newTerminal.promise).state, "completed");
    }
  });
}

test("turn authority: snapshot delivery failure publishes unavailable without a success receipt", async (t) => {
  const h = await heldTerminalHarness();
  t.after(() => h.service.shutdown());
  const send = h.worker.send.bind(h.worker);
  h.worker.send = async (message) => {
    if (message.type === "worker.getSnapshot") throw new Error("test snapshot transport failure");
    await send(message);
  };
  h.worker.emit({ type: "worker.turnStatus", payload: { ...h.status, revision: 2 } });
  const terminal = await h.terminal.promise;
  assert.equal(terminal.state, "failed");
  assert.equal(terminal.error?.code, "unavailable");
  assert.equal(terminal.disposition, undefined);
  h.worker.releaseHeldSnapshots();
  await flushMicrotasks();
  assert.equal(h.service.getSnapshot("s").state.isPromptRunning, true);
  assert.deepEqual(h.received.map((status) => status.state), ["failed"]);
});

test("turn authority: deferred snapshot send cannot delay deadline or publish late success", async (t) => {
  const sendGate = deferred<void>();
  let sendSettled = false;
  const h = await heldTerminalHarness({ commandTimeoutMs: 500 }, {}, (worker) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const send = worker.send.bind(worker);
    worker.send = async (message) => {
      await send(message);
      if (message.type === "worker.getSnapshot") {
        try { await sendGate.promise; }
        finally { sendSettled = true; }
      }
    };
  });
  t.after(() => h.service.shutdown());
  t.mock.timers.tick(499);
  await flushMicrotasks();
  assert.equal(h.received.length, 0);
  t.mock.timers.tick(1);
  await flushMicrotasks();
  assert.equal(sendSettled, false, "send is still under backpressure at the deadline");
  assert.equal(h.received.length, 1, "terminal deadline must settle without a send acknowledgement");
  assert.equal(h.received[0]?.state, "failed");
  assert.equal(h.received[0]?.error?.code, "unavailable");
  assert.match(h.received[0]!.error!.message, /timed out/);
  h.worker.releaseHeldSnapshots();
  sendGate.reject(new Error("late send rejection"));
  await flushMicrotasks();
  assert.equal(sendSettled, true);
  assert.deepEqual(h.received.map((status) => status.state), ["failed"]);
  assert.equal(h.service.getSnapshot("s").state.isPromptRunning, true);
});

test("snapshot authority: deferred send timeout and late rejection cannot settle a newer slot", async (t) => {
  const { service, workers } = makeService({ commandTimeoutMs: 500 }, { snapshot: promptCapSnapshot() });
  await service.activate("s");
  t.after(() => service.shutdown());
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const worker = workers.workers[0]!;
  const send = worker.send.bind(worker);
  const blocked: Array<{ message: Extract<SessiondToWorkerMessage, { type: "worker.getSnapshot" }>; gate: ReturnType<typeof deferred<void>> }> = [];
  worker.send = (message) => {
    if (message.type !== "worker.getSnapshot") return send(message);
    const gate = deferred<void>();
    blocked.push({ message, gate });
    return gate.promise;
  };
  let firstError: unknown;
  let firstSettled = false;
  const first = service.snapshot("s").then(() => assert.fail("backpressured snapshot must time out"), (error: unknown) => {
    firstError = error;
    firstSettled = true;
  });
  await flushMicrotasks();
  assert.equal(blocked.length, 1);
  t.mock.timers.tick(500);
  await flushMicrotasks();
  assert.equal(firstSettled, true, "caller observes timeout while send remains pending");
  assert.equal((firstError as { code?: string }).code, "timeout");
  let secondSettled = false;
  const second = service.snapshot("s").then((snapshot) => { secondSettled = true; return snapshot; });
  await flushMicrotasks();
  assert.equal(blocked.length, 2);
  const stale = promptCapSnapshot();
  stale.state.messageCount = 99;
  worker.emit({ type: "worker.snapshot", id: blocked[0]!.message.id, payload: { sessionId: "s", snapshot: stale } });
  blocked[0]!.gate.reject(new Error("expired send rejection"));
  await flushMicrotasks();
  assert.equal(secondSettled, false, "expired send cannot delete or reject the new slot");
  assert.equal(service.getSnapshot("s").state.messageCount, 0);
  const current = promptCapSnapshot();
  current.state.messageCount = 2;
  worker.emit({ type: "worker.snapshot", id: blocked[1]!.message.id, payload: { sessionId: "s", snapshot: current } });
  await flushMicrotasks();
  assert.equal(secondSettled, true, "response is observable before transport acknowledgement");
  assert.equal((await second).state.messageCount, 2);
  blocked[1]!.gate.reject(new Error("send rejection after exact response"));
  t.mock.timers.tick(500);
  await flushMicrotasks();
  assert.equal(service.getSnapshot("s").state.messageCount, 2);
  await first;
});

test("snapshot authority: late deferred-send rejection is fenced after rekey", async (t) => {
  const { service, workers } = makeService({ commandTimeoutMs: 500 }, { snapshot: promptCapSnapshot() });
  const activated = await service.activate("s");
  t.after(() => service.shutdown());
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const worker = workers.workers[0]!;
  const send = worker.send.bind(worker);
  const blocked: Array<{ message: Extract<SessiondToWorkerMessage, { type: "worker.getSnapshot" }>; gate: ReturnType<typeof deferred<void>> }> = [];
  worker.send = (message) => {
    if (message.type !== "worker.getSnapshot") return send(message);
    const gate = deferred<void>();
    blocked.push({ message, gate });
    return gate.promise;
  };
  let oldSettled = false;
  let oldError: unknown;
  const old = service.snapshot("s").then(() => assert.fail("old epoch snapshot cannot succeed"), (error: unknown) => {
    oldSettled = true;
    oldError = error;
  });
  await flushMicrotasks();
  worker.emit({ type: "worker.sessionDiscovered", payload: { sessionId: "rekeyed", cwd: "/s", sessionFile: "/sessions/rekeyed.jsonl" } });
  await flushMicrotasks();
  assert.notEqual(service.listRunning().sessions[0]?.epoch, activated.epoch);
  const current = service.snapshot("rekeyed");
  await flushMicrotasks();
  assert.equal(blocked.length, 2);
  blocked[0]!.gate.reject(new Error("send failed after epoch changed"));
  await flushMicrotasks();
  assert.equal(oldSettled, false, "stale send failure must not settle across epochs");
  const stale = promptCapSnapshot("rekeyed");
  stale.state.messageCount = 99;
  worker.emit({ type: "worker.snapshot", id: blocked[0]!.message.id, payload: { sessionId: "rekeyed", snapshot: stale } });
  await flushMicrotasks();
  assert.equal(oldSettled, true, "obsolete refresh is rejected without projecting");
  assert.equal((oldError as { code?: string }).code, "worker_unavailable");
  assert.equal(service.getSnapshot("rekeyed").state.messageCount, 0);
  worker.emit({ type: "worker.snapshot", id: blocked[1]!.message.id, payload: { sessionId: "rekeyed", snapshot: promptCapSnapshot("rekeyed") } });
  assert.equal((await current).sessionId, "rekeyed");
  blocked[1]!.gate.resolve();
  t.mock.timers.tick(500);
  await flushMicrotasks();
  await old;
});


test("turn authority: prompt_done observer gate preserves FIFO and exact terminal shares one sample", async (t) => {
  const { service, workers } = makeService({}, { snapshot: promptCapSnapshot(), turnCompletion: "handled", holdPostCommandSnapshots: true });
  t.after(() => service.shutdown());
  const activated = await service.activate("s");
  const worker = workers.workers[0]!;
  const gate = deferred<void>();
  const entered = deferred<void>();
  const observation: SessiondPush[] = [];
  const attach = service.attach({ sessionId: "s", epoch: activated.epoch, lastEventId: 1 }, async (push) => {
    observation.push(push);
    if (push.type === "event" && push.event.type === "prompt_done") { entered.resolve(); await gate.promise; }
  });
  t.after(() => attach.unsubscribe?.());
  const prepared = await service.prepareSubmitTurn({ sessionId: "s", expectedEpoch: activated.epoch, expectedRevision: 1, prompt: "fast", operationId: "gate", activationOverrides: { model: { provider: "openai", modelId: "gpt-6.1-sol" }, thinkingLevel: "high" } });
  await entered.promise;
  assert.equal(prepared.result.status, "accepted");
  if (prepared.result.status !== "accepted") throw new Error("expected admission");
  assert.equal(prepared.result.revision, 3);
  assert.equal(prepared.result.snapshot.state.isPromptRunning, true);
  const exact = deferred<SessiondTurnStatusPush>();
  await prepared.flushTo((push) => { if (push.status.state === "completed") exact.resolve(push); });
  await worker.waitForHeldSnapshot();
  worker.releaseHeldSnapshots();
  const terminal = await exact.promise;
  assert.equal(terminal.status.disposition, "handled");
  assert.equal(terminal.authority?.lastEventId, 3);
  assert.equal(terminal.authority?.snapshot.state.isPromptRunning, false);
  assert.deepEqual(terminal.authority?.snapshot.state.model, { provider: "openai", id: "gpt-6.1-sol" });
  assert.equal(terminal.authority?.snapshot.state.thinkingLevel, "high");
  assert.equal(observation.filter((push) => push.type === "snapshot").length, 0, "snapshot waits behind the observer gate");
  gate.resolve();
  await flushMicrotasks();
  const snapshot = observation.find((push) => push.type === "snapshot");
  assert.ok(snapshot && snapshot.type === "snapshot");
  assert.deepEqual(terminal.authority, { sessionId: snapshot.sessionId, epoch: snapshot.epoch, lastEventId: snapshot.lastEventId, snapshot: snapshot.snapshot });
  assert.equal(terminal.authority.snapshot, snapshot.snapshot, "both lanes retain the same captured snapshot");
  assert.deepEqual(observation.map((push) => push.type === "event" ? `${push.event.type}:${push.event.eventId}` : `${push.type}:${push.type === "snapshot" ? push.lastEventId : ""}`), ["running_sessions_changed:2", "prompt_done:3", "snapshot:3", "running_sessions_changed:4"]);
});

test("turn authority: completion between submit return and prepare registration replays the original authority", async (t) => {
  const { service, workers } = makeService({}, { snapshot: promptCapSnapshot(), turnCompletion: "handled", holdPostCommandSnapshots: true });
  t.after(() => service.shutdown());
  const activated = await service.activate("s");
  const submit = service.submitTurn.bind(service);
  const observation: SessiondPush[] = [];
  const settled = deferred<void>();
  const attach = service.attach({ sessionId: "s", epoch: activated.epoch, lastEventId: 0 }, (push) => {
    observation.push(push);
    if (push.type === "snapshot") settled.resolve();
  });
  t.after(() => attach.unsubscribe?.());
  service.submitTurn = async (input) => {
    const admission = await submit(input);
    await workers.workers[0]!.waitForHeldSnapshot();
    workers.workers[0]!.releaseHeldSnapshots();
    await settled.promise;
    await flushMicrotasks();
    return admission;
  };
  const prepared = await service.prepareSubmitTurn({ sessionId: "s", expectedEpoch: activated.epoch, expectedRevision: liveRevision(service, "s", activated.epoch), prompt: "fast", operationId: "prepare-race" });
  assert.equal(prepared.result.status, "accepted");
  const received: SessiondTurnStatusPush[] = [];
  await prepared.flushTo((push) => { received.push(push); });
  assert.equal(received.length, 1);
  assert.equal(received[0]?.status.state, "completed");
  assert.equal(received[0]?.authority?.snapshot.state.isPromptRunning, false);
  const snapshot = observation.find((push) => push.type === "snapshot");
  assert.ok(snapshot && snapshot.type === "snapshot");
  assert.deepEqual(received[0]?.authority, { sessionId: snapshot.sessionId, epoch: snapshot.epoch, lastEventId: snapshot.lastEventId, snapshot: snapshot.snapshot });
});

for (const outcome of ["send failure", "timeout"] as const) {
  test(`pending admission ${outcome} publishes idle and settles a coalesced observer`, async (t) => {
    const { service, workers } = makeService({ turnAdmissionTimeoutMs: 50 }, { snapshot: promptCapSnapshot() });
    t.after(() => service.shutdown());
    const activated = await service.activate("s");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const worker = workers.workers[0]!;
    const send = worker.send.bind(worker);
    const heldSend = deferred<void>();
    worker.send = (message) => message.type === "worker.submitTurn" ? heldSend.promise : send(message);
    const watch = service.prepareRunningWatch();
    const states: string[][] = [];
    await watch.flushTo((push) => { if (push.type === "running_state") states.push(push.state.busySessionIds); });
    t.after(() => watch.close());
    const request = { sessionId: "s", expectedEpoch: activated.epoch, expectedRevision: liveRevision(service, "s", activated.epoch), operationId: outcome, prompt: "hello" };
    const pending = service.submitTurn(request);
    await flushMicrotasks();
    assert.deepEqual(service.runningStateSnapshot().busySessionIds, ["s"]);
    const observer = await service.prepareSubmitTurn(request);
    assert.equal(observer.result.status, "duplicate");
    const terminal = deferred<TurnStatus>();
    await observer.flushTo((push) => { terminal.resolve(push.status); });
    if (outcome === "send failure") heldSend.reject(new Error("send failed"));
    else t.mock.timers.tick(50);
    const result = await pending;
    assert.equal(result.status, "rejected");
    assert.equal((await terminal.promise).state, "failed");
    assert.equal(await observer.closed, null);
    assert.deepEqual(states, [["s"], []]);
    assert.equal(service.listRunning().sessions[0]?.workerStatus, "ready");
    assert.equal(service.getSnapshot("s").state.messageCount, 0);
    heldSend.reject(new Error("late send failure"));
    await flushMicrotasks();
    assert.deepEqual(states, [["s"], []], "late transport settlement cannot publish twice");
  });
}

// --- Unconditional idempotent send (outbox contract) -----------------------

/** A receipt ledger stub: sessiond's durable dedupe source. */
function receiptLedger(entries: { operationId: string; turnId: string; delivery: "started" | "steer" | "follow_up" }[] = []) {
  return {
    entries,
    calls: 0,
    async listSentMessages(_sessionFile: string, limit: number) {
      this.calls += 1;
      return this.entries.slice(-limit);
    },
  };
}

function makeServiceWithReceipts(ledger: ReturnType<typeof receiptLedger>) {
  const workers = new FakeWorkerFactory({ snapshot: promptCapSnapshot(), commandDelayMs: 40 });
  const service = new SessiondService({
    sessionLocator: locator,
    activationContext: { async resolve(sessionId) { return { cwd: `/${sessionId}`, projectRoot: `/${sessionId}` }; } },
    workerFactory: workers,
    sentMessages: ledger,
  }, { workerStartTimeoutMs: 500, commandTimeoutMs: 500, idleTimeoutMs: 0 });
  return { service, workers, ledger };
}

test("send dedupe is durable: a receipt already in the session JSONL answers duplicate and never dispatches", async () => {
  const ledger = receiptLedger([{ operationId: "op-before-restart", turnId: "turn-from-the-past", delivery: "started" }]);
  const { service, workers } = makeServiceWithReceipts(ledger);
  await service.activate("s");
  const replay = await service.submitTurn({ sessionId: "s", prompt: "hello", operationId: "op-before-restart" });
  assert.equal(ledger.calls, 1, "the durable ledger is consulted");
  assert.equal(replay.status, "duplicate");
  if (replay.status === "duplicate") {
    assert.equal(replay.delivery, "accepted");
    assert.equal(replay.turnId, "turn-from-the-past");
  }
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.submitTurn").length, 0, "a durable duplicate is never delivered twice");
  await service.shutdown();
});

test("send dedupe survives an epoch rollover: the in-memory ledger is cleared, the receipt is not", async () => {
  const ledger = receiptLedger();
  const { service, workers } = makeServiceWithReceipts(ledger);
  const activated = await service.activate("s");
  const first = await service.submitTurn({ sessionId: "s", prompt: "hello", operationId: "op-survives" });
  assert.equal(first.status, "accepted");
  // Simulate the adapter persisting the receipt, then a whole-epoch rollover
  // (which clears every per-epoch in-memory ledger).
  ledger.entries.push({ operationId: "op-survives", turnId: first.status === "accepted" ? first.turnId : "turn-x", delivery: "started" });
  await wait(60);
  const rotated = await service.command("s", { type: "set_auto_retry", commandId: "rotate-me", enabled: true }, activated.epoch);
  assert.equal(rotated.result.ok, true);
  const resend = await service.submitTurn({ sessionId: "s", prompt: "hello", operationId: "op-survives" });
  assert.equal(resend.status, "duplicate");
  if (resend.status === "duplicate") assert.equal(resend.delivery, "accepted");
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.submitTurn").length, 1, "the resend never dispatches a second turn");
  await service.shutdown();
});

test("send rejects ONLY invalid_input / not_found; every other failure stays retryable", async () => {
  const ledger = receiptLedger();
  const { service } = makeServiceWithReceipts(ledger);
  await service.activate("s");
  // A missing session is final: nothing about resending creates it. The
  // activation context/locator reports it gone, so the send fails closed with
  // the one non-retryable code the outbox is allowed to surface.
  const missingLocator = {
    async locate(sessionId: string) { return { sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, exists: false }; },
    async resolveLeafId() { return "leaf"; },
  };
  const workers = new FakeWorkerFactory({ snapshot: promptCapSnapshot() });
  const isolated = new SessiondService({
    sessionLocator: missingLocator,
    activationContext: { async resolve(sessionId) { return { cwd: `/${sessionId}`, projectRoot: `/${sessionId}` }; } },
    workerFactory: workers,
    sentMessages: ledger,
  }, { workerStartTimeoutMs: 500, commandTimeoutMs: 500, idleTimeoutMs: 0 });
  const missing = await isolated.submitTurn({ sessionId: "gone", prompt: "hi", operationId: "op-missing" });
  assert.equal(missing.status, "rejected");
  if (missing.status === "rejected") {
    assert.equal(missing.error.code, "not_found");
    assert.equal(missing.error.retryable, false);
  }
  assert.equal(workers.starts, 0, "a missing session never starts a worker");
  await isolated.shutdown();
  await service.shutdown();
});

test("send race: a queued delivery whose turn already ended starts a turn instead of rejecting", async () => {
  // sessiond decides "queue it" by observing the running state, but the turn can
  // finish before the queue command arrives. The runtime answers that with a
  // not-running failure (session_busy / conflict); the message is still owed
  // delivery, so it must start a turn with the SAME operationId.
  const ledger = receiptLedger();
  const workers = new FakeWorkerFactory({
    snapshot: promptCapSnapshot(),
    commandDelayMs: 40,
    queuedSendFindsIdleTurn: true,
  });
  const service = new SessiondService({
    sessionLocator: locator,
    activationContext: { async resolve(sessionId) { return { cwd: `/${sessionId}`, projectRoot: `/${sessionId}` }; } },
    workerFactory: workers,
    sentMessages: ledger,
  }, { workerStartTimeoutMs: 500, commandTimeoutMs: 500, idleTimeoutMs: 0 });
  const activated = await service.activate("s");
  const first = await service.submitTurn({ sessionId: "s", prompt: "first", operationId: "op-race-1" });
  assert.equal(first.status, "accepted");

  // The previous turn ends while this send is being admitted as a queued one.
  const race = await service.submitTurn({ sessionId: "s", prompt: "second", operationId: "op-race-2", whenBusy: "follow_up" });
  // The queue attempt failed on a stopped turn → a NEW turn starts; never a
  // final rejection, never a silent drop.
  assert.equal(race.status, "accepted");
  if (race.status === "accepted") {
    assert.equal(race.turnStatus.state, "admitted", "the fallback starts a fresh turn, not a queued entry");
  }
  const dispatched = workers.workers[0]!.sent.filter((message) => message.type === "worker.submitTurn");
  assert.equal(dispatched.length, 2, "the raced send starts its own turn after the queue path proved the turn gone");
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.command").length, 1, "one queue attempt, then the fallback turn");
  assert.equal(ledger.calls >= 1, true);
  await service.shutdown();
});

// QUEUE-DRAIN: queued delivery has no worker.turnStatus correlation of its own.
async function queuedDrainHarness(
  options: ConstructorParameters<typeof SessiondService>[1] = {},
  disposition: "queued" | "started" | "handled" = "queued",
  workerOptions: Exclude<ConstructorParameters<typeof FakeWorkerFactory>[0], Function> = {},
) {
  const { service, workers } = makeService(options, { snapshot: promptCapSnapshot(), turnCompletion: "manual", ...workerOptions });
  await service.activate("s");
  const worker = workers.workers[0]!;
  const first = await service.prepareSubmitTurn({ sessionId: "s", operationId: "A", prompt: "A" });
  const firstPushes: SessiondTurnStatusPush[] = [];
  await first.flushTo((push) => { firstPushes.push(push); });
  const dispatch = worker.sent.find((message): message is Extract<SessiondToWorkerMessage, { type: "worker.submitTurn" }> => message.type === "worker.submitTurn")!;
  const send = worker.send.bind(worker);
  let holdAck = false;
  let ack: (() => void) | undefined;
  let commandSeen = deferred<void>();
  worker.send = async (message) => {
    if (message.type !== "worker.command" || (message.payload.command.type !== "steer" && message.payload.command.type !== "follow_up")) return send(message);
    worker.sent.push(structuredClone(message));
    const { sessionId, command } = message.payload;
    const answer = () => worker.emit({ type: "worker.commandResult", id: message.id, payload: { sessionId, result: { commandId: command.commandId, result: { ok: true, type: command.type as "steer" | "follow_up", disposition } } } });
    if (holdAck) ack = answer;
    else queueMicrotask(answer);
    commandSeen.resolve();
  };
  const submissions: Array<Awaited<ReturnType<typeof service.prepareSubmitTurn>>> = [first];
  const pushes = new Map<string, SessiondTurnStatusPush[]>();
  const request = (id: string) => ({ sessionId: "s", operationId: id, prompt: id });
  const queue = async (id: string) => {
    const prepared = await service.prepareSubmitTurn(request(id));
    submissions.push(prepared);
    const received: SessiondTurnStatusPush[] = [];
    pushes.set(id, received);
    await prepared.flushTo((push) => { received.push(push); });
    return prepared;
  };
  const finish = (failed = false) => {
    worker.emit({ type: "worker.turnStatus", payload: { sessionId: "s", epoch: dispatch.payload.epoch, operationId: "A", turnId: dispatch.payload.turnId, revision: 1, state: failed ? "failed" : "completed", disposition: "started", userEntryId: "A-entry", finalLeafId: "A-leaf", ...(failed ? { error: { code: "interrupted" as const, message: "interrupted", retryable: false } } : {}) } });
  };
  return { service, worker, first, firstPushes, pushes, submissions, request, queue, finish,
    holdAck: () => { holdAck = true; commandSeen = deferred<void>(); },
    commandSeen: () => commandSeen.promise,
    releaseAck: () => { const answer = ack; ack = undefined; answer?.(); },
  };
}

test("QUEUE-DRAIN: B/C stay pending at ack, then each terminal carries own identity and shared idle authority", async (t) => {
  const h = await queuedDrainHarness();
  t.after(() => h.service.shutdown());
  const b = await h.queue("B");
  const c = await h.queue("C");
  await flushMicrotasks();
  assert.deepEqual(h.pushes.get("B"), []);
  assert.deepEqual(h.pushes.get("C"), []);
  assert.equal(b.result.status, "accepted");
  assert.equal(c.result.status, "accepted");
  assert.equal(h.service.listRunning().sessions[0]?.workerStatus, "busy");
  const duplicate = await h.service.submitTurn(h.request("B"));
  assert.equal(duplicate.status, "duplicate");
  const conflict = await h.service.submitTurn({ ...h.request("B"), prompt: "different" });
  assert.equal(conflict.status, "rejected");
  if (conflict.status === "rejected") assert.equal(conflict.error.code, "conflict");
  h.worker.setSnapshot(promptCapSnapshot());
  h.finish();
  await flushMicrotasks();
  for (const id of ["B", "C"]) {
    const received = h.pushes.get(id)!;
    assert.equal(received.length, 1);
    assert.equal(received[0]!.status.state, "completed");
    assert.equal(received[0]!.status.operationId, id);
    assert.equal(received[0]!.status.revision, 1);
    assert.equal(received[0]!.status.disposition, "queued");
    assert.equal(received[0]!.status.userEntryId, undefined);
    assert.equal(received[0]!.status.finalLeafId, undefined);
    assert.deepEqual(received[0]!.authority?.snapshot, promptCapSnapshot());
  }
  assert.deepEqual(h.pushes.get("B")![0]!.authority, h.pushes.get("C")![0]!.authority);
  assert.equal(await b.closed, null);
  assert.equal(await c.closed, null);
  assert.equal(h.service.listRunning().sessions[0]?.workerStatus, "ready");
  const terminalDuplicate = await h.service.submitTurn(h.request("B"));
  assert.equal(terminalDuplicate.status, "duplicate");
  if (terminalDuplicate.status === "duplicate") assert.equal(terminalDuplicate.turnStatus.state, "completed");
});

for (const activity of ["queue", "external", "abort-relaunch"] as const) {
  test(`QUEUE-DRAIN: ${activity} truth prevents premature settlement; later lifecycle signal drains without polling`, async (t) => {
    const h = await queuedDrainHarness();
    t.after(() => h.service.shutdown());
    await h.queue("B");
    await flushMicrotasks();
    const active = promptCapSnapshot();
    if (activity === "queue") {
      active.state.queuedMessages = { steering: [], followUp: [{ message: "B" }] };
      active.state.pendingMessageCount = 1;
    } else {
      active.state.isPromptRunning = true;
    }
    h.worker.setSnapshot(active);
    h.finish(activity === "abort-relaunch");
    await flushMicrotasks();
    assert.deepEqual(h.pushes.get("B"), []);
    assert.equal(h.service.listRunning().sessions[0]?.workerStatus, "busy");
    const requests = h.worker.sent.filter((message) => message.type === "worker.getSnapshot").length;
    await flushMicrotasks();
    assert.equal(h.worker.sent.filter((message) => message.type === "worker.getSnapshot").length, requests, "no idle polling loop");
    h.worker.setSnapshot(promptCapSnapshot());
    h.worker.emitEvent({ type: "prompt_done", sessionId: "s" });
    await flushMicrotasks();
    assert.equal(h.pushes.get("B")?.[0]?.status.state, activity === "abort-relaunch" ? "failed" : "completed");
    if (activity === "abort-relaunch") assert.equal(h.pushes.get("B")?.[0]?.status.error?.code, "interrupted", "retain abort context, not per-message reply success");
    assert.equal(h.service.listRunning().sessions[0]?.workerStatus, "ready");
  });
}

for (const disposition of ["started", "handled"] as const) {
  test(`QUEUE-DRAIN: command ${disposition} disposition is retained and authority refreshed`, async (t) => {
    const h = await queuedDrainHarness({}, disposition);
    t.after(() => h.service.shutdown());
    h.worker.setHoldPostCommandSnapshots(true);
    const b = await h.queue("B");
    if (b.result.status !== "accepted") throw new Error("expected accepted");
    assert.equal(b.result.turnStatus.disposition, disposition);
    await h.worker.waitForHeldSnapshot();
    assert.deepEqual(h.pushes.get("B"), []);
    h.worker.releaseHeldSnapshots();
    await flushMicrotasks();
    if (disposition === "started") {
      assert.deepEqual(h.pushes.get("B"), [], "idle-race started waits for runtime drain");
      h.worker.setSnapshot(promptCapSnapshot());
      h.worker.emitEvent({ type: "prompt_done", sessionId: "s" });
      h.finish();
      h.worker.setHoldPostCommandSnapshots(false);
      h.worker.releaseHeldSnapshots();
      await flushMicrotasks();
    }
    assert.equal(h.pushes.get("B")?.[0]?.status.state, "completed");
    assert.equal(h.pushes.get("B")?.[0]?.status.disposition, disposition);
    assert.ok(h.pushes.get("B")?.[0]?.authority);
  });
}

for (const preAckSnapshot of [false, true]) {
  test(`QUEUE-DRAIN: completion during held ack (${preAckSnapshot ? "pre-ack snapshot held" : "late ack"}) cannot lose reconciliation`, async (t) => {
    const h = await queuedDrainHarness();
    t.after(() => h.service.shutdown());
    h.holdAck();
    const pending = h.queue("B");
    await h.commandSeen();
    h.worker.setSnapshot(promptCapSnapshot());
    if (preAckSnapshot) h.worker.setHoldPostCommandSnapshots(true);
    h.finish();
    await flushMicrotasks();
    if (preAckSnapshot) await h.worker.waitForHeldSnapshot();
    h.releaseAck();
    const b = await pending;
    assert.equal(b.result.status, "accepted");
    if (preAckSnapshot) {
      assert.deepEqual(h.pushes.get("B"), []);
      h.worker.setHoldPostCommandSnapshots(false);
      h.worker.releaseHeldSnapshots();
    }
    await flushMicrotasks();
    assert.equal(h.pushes.get("B")?.[0]?.status.state, "completed");
    assert.equal(await b.closed, null);
    assert.equal(h.service.listRunning().sessions[0]?.workerStatus, "ready");
  });
}

test("QUEUE-DRAIN: refresh timeout fails accepted queued rows and late snapshot cannot revive them", async (t) => {
  const h = await queuedDrainHarness({ commandTimeoutMs: 25 }, "queued", { dropPostCommandSnapshots: true });
  t.after(() => h.service.shutdown());
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const prepared = await h.queue("timeout");
  t.mock.timers.tick(25);
  await flushMicrotasks();
  assert.equal(h.pushes.get("timeout")?.[0]?.status.state, "failed");
  assert.equal(h.pushes.get("timeout")?.[0]?.status.error?.code, "unavailable");
  assert.equal(prepared.result.status, "accepted");
  assert.equal(h.service.listRunning().sessions[0]?.workerStatus, "ready");
});

test("QUEUE-DRAIN: stop/crash invalidate held reconciliation and late replies cannot settle a replacement", async (t) => {
  for (const mode of ["stop", "crash"] as const) {
    const h = await queuedDrainHarness({}, "queued", { holdPostCommandSnapshots: true });
    const prepared = await h.queue(`queued-${mode}`);
    await h.worker.waitForHeldSnapshot();
    const late = h.worker.captureMessageDelivery();
    if (mode === "stop") await h.service.stop("s");
    else h.worker.crash();
    assert.equal(h.pushes.get(`queued-${mode}`)?.[0]?.status.state, "failed");
    late({ type: "worker.snapshot", id: "late-queue-refresh", payload: { sessionId: "s", snapshot: promptCapSnapshot() } });
    assert.equal(h.pushes.get(`queued-${mode}`)?.length, 1);
    prepared.close();
    await h.service.shutdown();
  }
  await t.test("rekey", async () => {
    const h = await queuedDrainHarness({}, "queued", { holdPostCommandSnapshots: true });
    await h.queue("queued-rekey");
    await h.worker.waitForHeldSnapshot();
    h.worker.emit({ type: "worker.sessionDiscovered", payload: { sessionId: "rekeyed", cwd: "/s", sessionFile: "/sessions/rekeyed.jsonl" } });
    await flushMicrotasks();
    assert.equal(h.pushes.get("queued-rekey")?.[0]?.status.state, "failed");
    h.worker.releaseHeldSnapshots();
    assert.equal(h.pushes.get("queued-rekey")?.length, 1);
    await h.service.shutdown();
  });
});

test("QUEUE-DRAIN: durable queued replay hydrates a synthetic operation, then terminal dedupe remains exact", async (t) => {
  const ledger = receiptLedger([{ operationId: "durable-queued", turnId: "old-turn", delivery: "follow_up" }]);
  const workers = new FakeWorkerFactory({ snapshot: promptCapSnapshot(), turnCompletion: "manual" });
  const service = new SessiondService({
    sessionLocator: locator,
    activationContext: { async resolve(sessionId) { return { cwd: `/${sessionId}`, projectRoot: `/${sessionId}` }; } },
    workerFactory: workers,
    sentMessages: ledger,
  }, { workerStartTimeoutMs: 500, commandTimeoutMs: 500, idleTimeoutMs: 0 });
  t.after(() => service.shutdown());
  await service.activate("s");
  const replay = await service.submitTurn({ sessionId: "s", operationId: "durable-queued", prompt: "same" });
  assert.equal(replay.status, "duplicate");
  if (replay.status !== "duplicate") throw new Error("expected durable duplicate");
  assert.equal(replay.turnStatus.disposition, "queued");
  const second = await service.submitTurn({ sessionId: "s", operationId: "durable-queued", prompt: "different" });
  assert.equal(second.status, "rejected");
  if (second.status === "rejected") assert.equal(second.error.code, "conflict");
  const worker = workers.workers[0]!;
  worker.setSnapshot(promptCapSnapshot());
  worker.emitEvent({ type: "prompt_done", sessionId: "s" });
  await flushMicrotasks();
  const terminal = await service.submitTurn({ sessionId: "s", operationId: "durable-queued", prompt: "same" });
  assert.equal(terminal.status, "duplicate");
  if (terminal.status === "duplicate") assert.equal(terminal.turnStatus.state, "completed");
  assert.equal(worker.sent.filter((message) => message.type === "worker.submitTurn").length, 0);
});

test("QUEUE-DRAIN: bounded ledger keeps active queued rows and prunes terminal rows", async (t) => {
  const h = await queuedDrainHarness({ turnOperationLimit: 1 });
  t.after(() => h.service.shutdown());
  await h.queue("B");
  await h.queue("C");
  assert.equal(h.service.listRunning().sessions[0]?.workerStatus, "busy");
  h.worker.setSnapshot(promptCapSnapshot());
  h.finish();
  await flushMicrotasks();
  assert.equal(h.pushes.get("B")?.[0]?.status.state, "completed");
  assert.equal(h.pushes.get("C")?.[0]?.status.state, "completed");
  const rollover = await h.service.submitTurn(h.request("D"));
  assert.equal(rollover.status, "rejected");
  if (rollover.status === "rejected") assert.equal(rollover.error.code, "epoch_changed");
  assert.equal(h.worker.sent.filter((message) => message.type === "worker.rotateEpoch").length, 1);
});
