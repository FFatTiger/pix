/**
 * User-stop queue surgery: an abort interrupt must drop the assistant's
 * still-queued messages from the target's runtime queue (the SDK keeps them
 * across an abort and they would revive the stopped session) while re-queueing
 * the user's own messages in their original order. Server-side authority in
 * sessiond — the same discipline the composer applies client-side for recall.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import type { RuntimeSnapshot } from "@fffattiger/pix-protocol";
import { ASSISTANT_SENT_MESSAGE_PREFIX } from "@fffattiger/pix-protocol";
import type { SessionCatalogPort, SessionLocatorPort } from "@fffattiger/pix-runtime-core";
import { SessiondService } from "../src/service.js";
import { FakeWorkerFactory } from "../src/testing/fake-worker.js";
import { FileWorkspaceStateStore } from "../src/workspace-state.js";

const PREFIX = ASSISTANT_SENT_MESSAGE_PREFIX;
const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const snapshot = (sessionId: string, cwd = "/workspace", projectRoot = cwd): RuntimeSnapshot => ({
  sessionId, cwd, projectRoot,
  state: { sessionId, isStreaming: false, isPromptRunning: false, isBashRunning: false, isCompacting: false, model: null, messageCount: 0, queuedMessages: { steering: [], followUp: [] }, pendingMessageCount: 0, writtenFiles: [] },
  capabilities: { capabilities: ["runtime.prompt", "runtime.abort", "runtime.queue"], version: 1 },
  streaming: { active: false, phase: "idle" },
});

function harness(workerOptions: ConstructorParameters<typeof FakeWorkerFactory>[0] = {}) {
  const stateDir = mkdtempSync(`${tmpdir()}/pix-queue-drop-`);
  const locator: SessionLocatorPort = {
    async locate(sessionId) { return { sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, exists: true }; },
    async resolveLeafId() { return "leaf"; },
  };
  const catalog: SessionCatalogPort = {
    async listSessions() { return []; },
    async readSession(sessionId) { return { sessionId, cwd: "/workspace", projectRoot: "/workspace", entries: [] }; },
    async readSessionContext(sessionId) { return { sessionId, entries: [], pageInfo: { hasMore: false } }; },
    async readSessionThinking() { throw { code: "not_found", message: "session not found", retryable: false }; },
    async readSessionTree(sessionId) { return { sessionId, roots: [], entryCount: 0 }; },
    async deleteSession() {},
  };
  const workers = new FakeWorkerFactory(workerOptions);
  const service = new SessiondService({
    sessionLocator: locator,
    activationContext: { async resolve(sessionId) { return { cwd: `/cwd/${sessionId}`, projectRoot: `/cwd/${sessionId}` }; } },
    workerFactory: workers,
    sessionCatalog: catalog,
    workspaceState: new FileWorkspaceStateStore(stateDir),
  }, { workerStartTimeoutMs: 500, commandTimeoutMs: 500, idleTimeoutMs: 0 });
  return { service, workers };
}

/** The worker.command frames the surgery issued, in order. */
function surgeryCommands(worker: { sent: Array<{ type: string; payload?: unknown }> }): Array<{ type: string; message?: string }> {
  return worker.sent
    .filter((item) => item.type === "worker.command")
    .map((item) => item.payload as { command: { type: string; commandId: string; message?: string } })
    .filter((payload) => payload.command.commandId.startsWith("assistant-queue-drop:"))
    .map((payload) => payload.command.message === undefined
      ? { type: payload.command.type }
      : { type: payload.command.type, message: payload.command.message });
}

async function queueOn(record: { sessionId: string }, worker: FakeWorkerFactory["workers"][number], messages: string[]): Promise<void> {
  worker.emitEvent({
    type: "queue_update",
    sessionId: record.sessionId,
    steering: [],
    followUp: messages.map((message) => ({ message })),
  });
  await wait();
}

test("an abort drops queued assistant messages and re-queues the user's own in order", async () => {
  const { service, workers } = harness();
  const activated = await service.activate("s");
  const worker = workers.workers[0]!;
  await queueOn({ sessionId: "s" }, worker, [
    "user first",
    `${PREFIX}\n\npixie queued task`,
    "user second",
  ]);

  const result = await service.interrupt("s", "stop-1", { type: "abort" }, activated.epoch);

  assert.equal(result.result.ok, true, "the abort itself still goes through");
  const commands = surgeryCommands(worker);
  assert.deepEqual(commands, [
    { type: "clear_queue" },
    { type: "follow_up", message: "user first" },
    { type: "follow_up", message: "user second" },
  ], "clear once, then re-queue ONLY the user's messages in their original order");
  assert.equal(worker.sent.some((item) => item.type === "worker.interrupt"), true, "the abort interrupt is still delivered");
  await service.shutdown();
});

test("an abort with no assistant-marked queued message issues no surgery commands", async () => {
  const { service, workers } = harness();
  const activated = await service.activate("s");
  const worker = workers.workers[0]!;
  await queueOn({ sessionId: "s" }, worker, ["plain user message"]);
  await service.interrupt("s", "stop-2", { type: "abort" }, activated.epoch);
  assert.deepEqual(surgeryCommands(worker), [], "user-only queues are untouched");
  await service.shutdown();
});

test("steering-lane assistant messages are dropped too and user steering order is preserved", async () => {
  const { service, workers } = harness();
  const activated = await service.activate("s");
  const worker = workers.workers[0]!;
  worker.emitEvent({
    type: "queue_update",
    sessionId: "s",
    steering: [{ message: "user steer" }, { message: `${PREFIX}\n\npixie steer task` }],
    followUp: [{ message: "user follow" }],
  });
  await wait();
  await service.interrupt("s", "stop-3", { type: "abort" }, activated.epoch);
  assert.deepEqual(surgeryCommands(worker), [
    { type: "clear_queue" },
    { type: "follow_up", message: "user steer" },
    { type: "follow_up", message: "user follow" },
  ], "steering first then follow-up, assistant items removed, user order kept");
  await service.shutdown();
});

test("non-abort interrupts never trigger the surgery", async () => {
  const { service, workers } = harness();
  const activated = await service.activate("s");
  const worker = workers.workers[0]!;
  await queueOn({ sessionId: "s" }, worker, [`${PREFIX}\n\npixie queued task`]);
  await service.interrupt("s", "bash-1", { type: "abort_bash" }, activated.epoch);
  await service.interrupt("s", "compact-1", { type: "abort_compaction" }, activated.epoch);
  assert.deepEqual(surgeryCommands(worker), [], "only a turn abort is a user stop");
  await service.shutdown();
});

test("a clear_queue failure degrades to no surgery (queue untouched, abort proceeds)", async () => {
  const { service, workers } = harness({ failCommandTypes: ["clear_queue"] });
  const activated = await service.activate("s");
  const worker = workers.workers[0]!;
  await queueOn({ sessionId: "s" }, worker, ["user first", `${PREFIX}\n\npixie queued task`]);
  const result = await service.interrupt("s", "stop-4", { type: "abort" }, activated.epoch);
  assert.equal(result.result.ok, true, "the abort is never blocked by the surgery");
  assert.deepEqual(surgeryCommands(worker), [{ type: "clear_queue" }], "no re-queue runs after a failed clear");
  await service.shutdown();
});
