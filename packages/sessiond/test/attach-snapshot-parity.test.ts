import assert from "node:assert/strict";
import test from "node:test";
import { reduceRuntimeEventData, type RuntimeEventData, type RuntimeSnapshot } from "@fffattiger/pix-protocol";
import { makeRuntimeError, type SessionCatalogPort, type SessionLocatorPort } from "@fffattiger/pix-runtime-core";
import { SessiondService } from "../src/service.js";
import { FakeWorkerFactory, type FakeWorkerOptions } from "../src/testing/fake-worker.js";

/**
 * Narrow regression for the real "first Ask does not refresh / does not show"
 * bug: the startup prime (worker.getSnapshot) is the authoritative initial
 * projection, so the journal base must be established at ITS cursor. Otherwise
 * a same-epoch reattach rebuilds from the pre-prime default (capabilities v0,
 * no tools/system prompt) plus every journaled event, silently degrading the
 * resumed session, and the attach result reports the journal HEAD as the cursor
 * of a snapshot that was actually reconstructed at the client cursor (the
 * client then drops the replay it still needed).
 */

const extensionUiSnapshot = (sessionId: string): RuntimeSnapshot => ({
  sessionId,
  cwd: "/workspace",
  projectRoot: "/workspace",
  state: {
    sessionId,
    isStreaming: false,
    isPromptRunning: false,
    isBashRunning: false,
    isCompacting: false,
    model: { provider: "fake", id: "cap-v1" },
    messageCount: 0,
    queuedMessages: { steering: [], followUp: [] },
    pendingMessageCount: 0,
    writtenFiles: [],
    systemPrompt: "You are the cap-v1 runtime.",
    tools: [{ name: "compile", active: true }, { name: "ask_user", active: true }],
  },
  capabilities: { capabilities: ["runtime.prompt", "runtime.abort", "runtime.extension_ui"], version: 2 },
  streaming: { active: false, phase: "idle" },
});

const questionnaire = {
  id: "ask-1",
  method: "questionnaire" as const,
  questions: [{ header: "Scope", question: "Which files?", options: [{ label: "src", description: "source files" }, { label: "docs", description: "documentation" }], multiSelect: false }],
};

const assistantStart = (sessionId: string, n: number): RuntimeEventData => ({
  type: "message_start",
  sessionId,
  streamId: `stream-${n}`,
  messageId: `msg-${n}`,
  message: { role: "assistant", content: [] },
});
const assistantEnd = (sessionId: string, n: number): RuntimeEventData => ({
  type: "message_end",
  sessionId,
  streamId: `stream-${n}`,
  messageId: `msg-${n}`,
  message: { role: "assistant", content: [{ type: "text", text: `reply ${n}` }], model: "cap-v1", provider: "fake" },
  entryId: `entry-${n}`,
});

function harness(worker: FakeWorkerOptions) {
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
  const workers = new FakeWorkerFactory(worker);
  const service = new SessiondService({
    sessionLocator: locator,
    activationContext: { async resolve(sessionId, _location, requestedCwd) { return { cwd: requestedCwd ?? `/cwd/${sessionId}`, projectRoot: requestedCwd ?? `/cwd/${sessionId}` }; } },
    workerFactory: workers,
    sessionCatalog: catalog,
  }, { workerStartTimeoutMs: 500, commandTimeoutMs: 500, idleTimeoutMs: 0 });
  return { service, workers };
}

/**
 * create() with a rekeyed session id, the runtime's capability-v1 truth, and
 * three events journaled BEFORE the prime response: an in-flight assistant
 * message pair (so a double-applied base is visible as an extra message) and a
 * live questionnaire request (the Ask gate).
 */
async function primedCreate() {
  const sessionId = "real-ask";
  const { service, workers } = harness({
    discoveredSessionId: sessionId,
    snapshot: extensionUiSnapshot(sessionId),
    eventsBeforeReady: [assistantStart(sessionId, 1), assistantEnd(sessionId, 1), { type: "extension_ui_request", sessionId, request: questionnaire }],
  });
  const created = await service.create({ createRequestId: "ask-1", cwd: "/workspace", projectRoot: "/workspace" });
  const worker = workers.workers[0]!;
  // create() returns the journal cursor AFTER the prime: the primed base.
  return { service, worker, created, sessionId: created.sessionId, base: created.lastEventId ?? 0 };
}

const replayedIds = (prepared: { replay: readonly { type: string; event?: { eventId: number } }[] }): number[] =>
  prepared.replay.map((push) => (push.type === "event" && push.event !== undefined ? push.event.eventId : -1));

test("prime establishes the journal base: reattach at the current cursor equals getSnapshot", async () => {
  const { service, created, sessionId, base } = await primedCreate();
  const authoritative = service.getSnapshot(sessionId);
  assert.deepEqual(authoritative.capabilities, { capabilities: ["runtime.prompt", "runtime.abort", "runtime.extension_ui"], version: 2 });
  assert.deepEqual(authoritative.state.tools?.map((tool) => tool.name), ["compile", "ask_user"]);
  assert.equal(authoritative.state.systemPrompt, "You are the cap-v1 runtime.");
  assert.equal(authoritative.state.messageCount, 1, "the journaled assistant turn is projected exactly once");
  assert.deepEqual(authoritative.state.pendingExtensionUi, [questionnaire]);

  assert.ok(base >= 3, "the three pre-ready events are journaled before the prime");
  assert.equal(service.attach({ sessionId }).result.lastEventId, base);

  const attached = service.prepareAttach({ sessionId, epoch: created.epoch, lastEventId: base });
  assert.equal(attached.result.resumeStatus, "snapshot");
  assert.equal(attached.result.lastEventId, base, "same-epoch resume reports the cursor its snapshot was built at");
  assert.deepEqual(attached.replay, []);
  assert.deepEqual(attached.result.snapshot, authoritative, "same-epoch reattach must not fall back to the pre-prime capability set");
  assert.notEqual(attached.result.snapshot.capabilities.version, 0);
  attached.close();
  await service.shutdown();
});

test("cursor below the primed base is a gap: full snapshot at the boundary, journal untouched", async () => {
  const { service, created, sessionId, base } = await primedCreate();
  const authoritative = service.getSnapshot(sessionId);
  const stale = [...new Set([0, 1, base - 1])].filter((cursor) => cursor < base);
  assert.ok(stale.length > 0);
  for (const staleCursor of stale) {
    const attached = service.prepareAttach({ sessionId, epoch: created.epoch, lastEventId: staleCursor });
    assert.equal(attached.result.resumeStatus, "gap", `cursor ${staleCursor} predates the primed base ${base}`);
    assert.equal(attached.result.lastEventId, base);
    assert.deepEqual(attached.replay, []);
    assert.deepEqual(attached.result.snapshot, authoritative);
    attached.close();
  }
  await service.shutdown();
});

test("base <= cursor < head reconstructs at that cursor and replays only through the captured boundary", async () => {
  const { service, worker, created, sessionId, base } = await primedCreate();
  // Post-prime journal: a queue write and a second live questionnaire upsert
  // (the Ask gate reopening right after resume). Sessiond journals its own
  // side-channel running-set frames in between, so cursors are anchored on the
  // observed head instead of arithmetic.
  worker.emitEventApplied({ type: "queue_update", sessionId, steering: [{ message: "queued after resume" }], followUp: [] });
  worker.emitEventApplied({ type: "extension_ui_request", sessionId, request: { id: "ask-2", method: "confirm", title: "Approve?", message: "Run the migration?" } });
  const authoritative = service.getSnapshot(sessionId);
  assert.equal(authoritative.state.queuedMessages?.steering.length, 1);
  assert.deepEqual(authoritative.state.pendingExtensionUi?.map((item) => item.id), [questionnaire.id, "ask-2"]);

  const head = service.attach({ sessionId }).result.lastEventId;
  assert.ok(head > base + 1, `post-prime events must exist (base ${base}, head ${head})`);

  for (const cursor of [base, head - 1]) {
    const attached = service.prepareAttach({ sessionId, epoch: created.epoch, lastEventId: cursor });
    assert.equal(attached.result.resumeStatus, "snapshot");
    assert.equal(attached.result.lastEventId, cursor, "the response cursor must be the cursor the snapshot matches, not the head");
    const ids = replayedIds(attached);
    assert.equal(ids[0], cursor + 1, "replay starts immediately after the resumed cursor");
    assert.equal(ids.at(-1), head, "replay stops at the captured boundary");
    assert.equal(ids.length, head - cursor);
    assert.equal(attached.result.snapshot.state.messageCount, 1, "events folded into the base are never re-applied");
    const pending = attached.result.snapshot.state.pendingExtensionUi ?? [];
    assert.deepEqual(pending[0], questionnaire, "the live Ask questionnaire survives resume");
    assert.equal(new Set(pending.map((item) => item.id)).size, pending.length, "no questionnaire is duplicated by the base rebuild");
    if (cursor === base) assert.deepEqual(pending, [questionnaire], "the primed base is exactly the prime projection");
    assert.deepEqual(attached.result.snapshot.capabilities, authoritative.capabilities);

    let converged = attached.result.snapshot;
    for (const push of attached.replay) if (push.type === "event") converged = reduceRuntimeEventData(converged, push.event);
    assert.deepEqual(converged, authoritative, "resume snapshot + replay reproduces the authoritative state");
    attached.close();
  }

  const atHead = service.prepareAttach({ sessionId, epoch: created.epoch, lastEventId: head });
  assert.equal(atHead.result.lastEventId, head);
  assert.deepEqual(atHead.replay, []);
  assert.deepEqual(atHead.result.snapshot, authoritative);
  atHead.close();
  await service.shutdown();
});

test("epoch change keeps the boundary cursor and full snapshot", async () => {
  const { service, created, sessionId, base } = await primedCreate();
  const attached = service.prepareAttach({ sessionId, epoch: "stale-epoch", lastEventId: 1 });
  assert.equal(attached.result.resumeStatus, "epoch_changed");
  assert.equal(attached.result.lastEventId, base);
  assert.deepEqual(attached.result.snapshot, service.getSnapshot(sessionId));
  assert.deepEqual(attached.replay, []);
  attached.close();
  assert.notEqual(created.epoch, "stale-epoch");
  await service.shutdown();
});
