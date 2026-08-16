import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeSnapshot } from "@fffattiger/pix-protocol";
import type { SessionCatalogPort, SessionLocatorPort, SessionMutationPort } from "@fffattiger/pix-runtime-core";
import { SessiondError } from "../src/errors.js";
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
/** Wait until the old worker has been fully stopped AND its record removed. */
const waitStopped = async (h: ReturnType<typeof forkHarness>): Promise<void> => {
  await waitUntil(() => h.workerShutdownCount() >= 1 && h.service.diagnostics().sessions === 0);
};

const snapshot = (sessionId: string, cwd = "/workspace", projectRoot = cwd): RuntimeSnapshot => ({
  sessionId, cwd, projectRoot,
  state: { sessionId, isStreaming: false, isPromptRunning: false, isBashRunning: false, isCompacting: false, model: null, messageCount: 0, queuedMessages: { steering: [], followUp: [] }, pendingMessageCount: 0, writtenFiles: [] },
  capabilities: { capabilities: ["runtime.prompt", "runtime.abort", "runtime.fork"], version: 1 },
  streaming: { active: false, phase: "idle" },
});

interface ForkHarnessOptions {
  worker?: ConstructorParameters<typeof FakeWorkerFactory>[0];
  service?: ConstructorParameters<typeof SessiondService>[1];
  mutation?: SessionMutationPort;
}

function forkHarness(options: ForkHarnessOptions = {}) {
  const files = new Map<string, boolean>();
  const mutationTitles = new Map<string, string>();
  const deleted: string[] = [];
  const mutationCalls: string[] = [];
  const baseMutation: SessionMutationPort = {
    async renameSession(sessionId, name) {
      mutationCalls.push(`${sessionId}:${name}`);
      if (!files.get(sessionId)) throw { code: "not_found", message: "session not found", retryable: false };
      mutationTitles.set(sessionId, name);
    },
  };
  const locator: SessionLocatorPort = {
    async locate(sessionId) { return { sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, exists: files.get(sessionId) ?? true }; },
    async resolveLeafId() { return "leaf"; },
  };
  const catalog: SessionCatalogPort = {
    async listSessions() { return []; },
    async readSession(sessionId) {
      if (!files.get(sessionId)) throw { code: "not_found", message: "session not found", retryable: false };
      return { sessionId, cwd: "/workspace", projectRoot: "/workspace", entries: [] };
    },
    async readSessionContext(sessionId) {
      if (!files.get(sessionId)) throw { code: "not_found", message: "session not found", retryable: false };
      return { sessionId, entries: [], pageInfo: { hasMore: false } };
    },
    async readSessionTree(sessionId) {
      if (!files.get(sessionId)) throw { code: "not_found", message: "session not found", retryable: false };
      return { sessionId, roots: [], entryCount: 0 };
    },
    async deleteSession(sessionId) {
      if (!files.get(sessionId)) throw { code: "not_found", message: "session not found", retryable: false };
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
    sessionMutation: options.mutation === undefined ? baseMutation : options.mutation,
  }, { workerStartTimeoutMs: 500, commandTimeoutMs: 500, idleTimeoutMs: 0, ...options.service });
  return {
    service,
    workers,
    files,
    deleted,
    mutationCalls,
    mutationTitles,
    seed: (id: string) => { files.set(id, true); },
    eventsFor: async (sessionId: string): Promise<string[]> => {
      const events: string[] = [];
      service.subscribe(sessionId, (push) => { if (push.type === "event") events.push(push.event.type); });
      return events;
    },
    workerShutdownCount: () => workers.workers[0]?.sent.filter((m) => m.type === "worker.shutdown").length ?? 0,
  };
}

test("fork success returns a new session id and ends the OLD worker after the result (runtime_closed forked, record removed)", async () => {
  const h = forkHarness();
  await h.service.activate("s");
  const events = await h.eventsFor("s");
  const result = await h.service.command("s", { type: "fork", commandId: "f1", entryId: "entry-1" });
  assert.equal(result.result.ok, true);
  if (result.result.ok && result.result.type === "fork") {
    assert.ok(result.result.forkedSessionId.length > 0);
    assert.equal(result.result.forkPointEntryId, "entry-1");
  }
  // The old worker is ended via the identity-lane stop path.
  await waitStopped(h);
  assert.equal(events.includes("runtime_closed"), true, "runtime_closed('forked') must be emitted");
  // The record is removed: getSnapshot fails and no running session remains.
  assert.throws(() => h.service.getSnapshot("s"), SessiondError);
  assert.equal(h.service.diagnostics().sessions, 0);
  assert.equal(h.service.listRunning().sessions.length, 0);
  await h.service.shutdown();
});

test("fork result-before-stop ordering with a gated worker: no shutdown until the fork result is delivered", async () => {
  const h = forkHarness({ worker: { commandDelayMs: 30 } });
  await h.service.activate("s");
  const resultP = h.service.command("s", { type: "fork", commandId: "f-order", entryId: "entry-1" });
  await wait(10);
  // While the worker holds the fork result, the OLD worker must NOT be stopped.
  assert.equal(h.workerShutdownCount(), 0, "no stop may happen before the fork result is delivered");
  const result = await resultP;
  assert.equal(result.result.ok, true);
  // After the result settles, the stop happens.
  await waitStopped(h);
  assert.equal(h.service.listRunning().sessions.length, 0);
  await h.service.shutdown();
});

test("fork failure does NOT stop the old worker and surfaces the canonical structured error", async () => {
  // The worker/adapter sends a CANONICAL sanitized error (raw SDK text and fork
  // params are already re-projected to fixed messages at the adapter boundary —
  // see fork.test.ts). sessiond returns it as-is and never stops the worker.
  const h = forkHarness({ worker: { forkError: { code: "external", message: "fork failed", retryable: true } } });
  await h.service.activate("s");
  const result = await h.service.command("s", { type: "fork", commandId: "f-fail", entryId: "entry-7" });
  assert.equal(result.result.ok, false);
  if (!result.result.ok) {
    assert.equal(result.result.type, "fork");
    assert.equal(result.result.error.code, "external");
    assert.equal(result.result.error.message, "fork failed");
  }
  assert.equal(h.workerShutdownCount(), 0, "a failed fork must never stop the old worker");
  assert.equal(h.service.listRunning().sessions.length, 1, "the old worker stays live");
  await h.service.shutdown();
});

test("delete-first: fork on a session with no live record fails closed not_found (no partial fork)", async () => {
  const h = forkHarness();
  // No live record exists (never activated / already deleted).
  const result = await h.service.command("s", { type: "fork", commandId: "f-del", entryId: "entry-1" });
  assert.equal(result.result.ok, false);
  if (!result.result.ok) {
    assert.equal(result.result.error.code, "not_found");
  }
  assert.equal(h.service.diagnostics().sessions, 0, "no new session record is created by a failed fork");
  await h.service.shutdown();
});

test("fork-first: a delete admitted after the fork's stop sees the stopped record and deletes the catalog entry", async () => {
  const h = forkHarness();
  h.seed("s");
  await h.service.activate("s");
  const result = await h.service.command("s", { type: "fork", commandId: "f1", entryId: "entry-1" });
  assert.equal(result.result.ok, true);
  await waitStopped(h);
  // The old record is gone → the delete prompt check passes and the catalog
  // delete proceeds (never session_busy, never double-stop).
  await h.service.deleteSession("s");
  assert.deepEqual(h.deleted, ["s"]);
  await h.service.shutdown();
});

test("a delete issued while the fork is in flight fails closed session_busy (never races the fork)", async () => {
  const h = forkHarness({ worker: { commandDelayMs: 30 } });
  h.seed("s");
  await h.service.activate("s");
  const resultP = h.service.command("s", { type: "fork", commandId: "f-race", entryId: "entry-1" });
  await wait(5);
  await assert.rejects(
    h.service.deleteSession("s"),
    (error: unknown) => error instanceof SessiondError && error.code === "session_busy",
    "delete mid-fork must fail closed with session_busy (record still live)",
  );
  await resultP;
  await waitStopped(h);
  await h.service.shutdown();
});

test("rename admitted after the fork's stop uses the offline mutation (no live record, no stale-lane live write)", async () => {
  const h = forkHarness();
  h.seed("s");
  await h.service.activate("s");
  const result = await h.service.command("s", { type: "fork", commandId: "f1", entryId: "entry-1" });
  assert.equal(result.result.ok, true);
  await waitStopped(h);
  await h.service.renameSession("s", "After Fork");
  assert.deepEqual(h.mutationCalls, ["s:After Fork"], "rename after the fork's stop must take the offline path");
  assert.equal(h.mutationTitles.get("s"), "After Fork");
  await h.service.shutdown();
});

test("explicit stop queued after a fork is a no-op (no double-stop)", async () => {
  const h = forkHarness();
  await h.service.activate("s");
  const result = await h.service.command("s", { type: "fork", commandId: "f1", entryId: "entry-1" });
  assert.equal(result.result.ok, true);
  await waitStopped(h);
  // The fork already stopped the old worker; an explicit stop must be a no-op.
  const stopped = await h.service.stop("s");
  assert.equal(stopped, false);
  assert.equal(h.workerShutdownCount(), 1, "exactly one worker.shutdown — no double-stop");
  await h.service.shutdown();
});

test("fork on a rekeyed record ends the rekeyed (authoritative) worker; stale id has no lane write", async () => {
  const h = forkHarness({ worker: { discoveredSessionId: "real-s" } });
  await h.service.activate("s");
  // Rekey binds the lane to "real-s"; a fork on the authoritative id works.
  const result = await h.service.command("real-s", { type: "fork", commandId: "f-rekey", entryId: "entry-1" });
  assert.equal(result.result.ok, true);
  await waitStopped(h);
  assert.equal(h.service.listRunning().sessions.length, 0, "the rekeyed worker is stopped");
  await h.service.shutdown();
});

test("worker crash mid-fork fails closed sanitized, cleans the old worker, and creates no partial new session", async () => {
  const h = forkHarness({ worker: { commandDelayMs: 30 } });
  await h.service.activate("s");
  const resultP = h.service.command("s", { type: "fork", commandId: "f-crash", entryId: "entry-1" });
  await wait(5);
  h.workers.workers[0]!.crash();
  const result = await resultP;
  assert.equal(result.result.ok, false);
  if (!result.result.ok) {
    assert.equal(result.result.type, "fork");
    assert.equal(result.result.error.code, "unavailable", "worker crash must fail closed with a fixed sanitized code");
  }
  // No partial new session: no new worker started, no forked record admitted.
  assert.equal(h.workers.starts, 1);
  // The old worker is cleaned up (crashed record remains until stopped, but is
  // no longer running and exposes no live session).
  assert.equal(h.service.diagnostics().sessions, 1);
  assert.equal(h.service.listRunning().sessions.length, 0, "crashed worker is not a running session");
  await h.service.shutdown();
});

test("concurrent fork/fork: exactly one succeeds, one worker.shutdown, the loser sees the stopped record", async () => {
  const h = forkHarness({ worker: { commandDelayMs: 5 } });
  await h.service.activate("s");
  const [a, b] = await Promise.all([
    h.service.command("s", { type: "fork", commandId: "f-a", entryId: "entry-1" }),
    h.service.command("s", { type: "fork", commandId: "f-b", entryId: "entry-1" }),
  ]);
  const ok = [a, b].filter((r) => r.result.ok).length;
  assert.equal(ok, 1, "exactly one concurrent fork may succeed");
  const loser = [a, b].find((r) => !r.result.ok);
  assert.ok(loser, "the concurrent loser must exist");
  if (loser && !loser.result.ok) {
    assert.equal(loser.result.type, "fork");
    assert.equal(loser.result.error.code, "not_found", "the loser must see the stopped record (not_found)");
  }
  assert.equal(h.workerShutdownCount(), 1, "exactly one old-worker stop");
  await h.service.shutdown();
});
