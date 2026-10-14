/**
 * Always-on assistant residency (Pixie).
 *
 * sessiond owns the assistant worker lifecycle: `ensureAssistantResident`
 * (what the production daemon boots) resolves the latest assistant
 * conversation through the SAME read-only catalog lookup `GET /v1/assistant`
 * rides and keeps exactly ONE worker resident on it. These tests prove:
 *
 *  - boot activation of the latest conversation (open mode, online presence);
 *  - armed-with-no-conversation (no worker, no fabricated session file) and
 *    adoption of the conversation the first message creates;
 *  - the tracked record is exempt from idle reclamation while a normal
 *    session in the SAME service still reclaims;
 *  - crash and explicit-stop restarts with bounded exponential backoff;
 *  - not_found collapses to armed (deleted conversation, no retry loop);
 *  - shutdown stops restarting;
 *  - the presence projection rides the revisioned running watch pushes.
 */
import assert from "node:assert/strict";
import { homedir } from "node:os";
import test from "node:test";
import type { SessiondRunningWatchPush } from "@fffattiger/pix-protocol";
import { SessiondService } from "../src/service.js";
import { AssistantResidencySupervisor } from "../src/assistant-residency.js";
import { FakeWorkerFactory } from "../src/testing/fake-worker.js";
import type { SessionCatalogPort, SessionLocatorPort } from "@fffattiger/pix-runtime-core";
import { resolveAssistantWorkspaceDir } from "@fffattiger/pix-runtime-core";

const assistantDir = resolveAssistantWorkspaceDir(homedir());

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(predicate: () => boolean, label: string, deadlineMs = 2_000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(2);
  }
  throw new Error(`waitUntil timed out: ${label}`);
}

interface HarnessOptions {
  latest?: { sessionId: string } | null;
  locateExists?: (sessionId: string) => boolean;
  cwdFor?: (sessionId: string, requestedCwd?: string) => string;
  service?: ConstructorParameters<typeof SessiondService>[1];
  worker?: ConstructorParameters<typeof FakeWorkerFactory>[0];
}

function harness(options: HarnessOptions = {}) {
  const latest = options.latest === undefined ? null : options.latest;
  const locator: SessionLocatorPort = {
    async locate(sessionId) {
      return { sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, exists: options.locateExists?.(sessionId) ?? true };
    },
    async resolveLeafId() { return "leaf"; },
  };
  const catalog = {
    async listSessions() { return []; },
    async readSession(sessionId: string) {
      return { sessionId, cwd: options.cwdFor?.(sessionId) ?? assistantDir, projectRoot: options.cwdFor?.(sessionId) ?? assistantDir, entries: [] };
    },
    async readSessionContext(sessionId: string) { return { sessionId, entries: [], pageInfo: { hasMore: false } }; },
    async readSessionThinking() { throw new Error("not used"); },
    async readSessionTree(sessionId: string) { return { sessionId, roots: [], entryCount: 0 }; },
    async deleteSession() {},
    async findLatestSessionByCwd(cwd: string) {
      return cwd === assistantDir && latest !== null
        ? { sessionId: latest.sessionId, cwd, projectRoot: cwd }
        : null;
    },
  } as unknown as SessionCatalogPort;
  const workers = new FakeWorkerFactory(options.worker);
  const service = new SessiondService({
    sessionLocator: locator,
    activationContext: {
      async resolve(sessionId, _location, requestedCwd) {
        const cwd = options.cwdFor?.(sessionId, requestedCwd) ?? assistantDir;
        return { cwd, projectRoot: cwd };
      },
    },
    workerFactory: workers,
    sessionCatalog: catalog,
  }, { workerStartTimeoutMs: 500, commandTimeoutMs: 500, idleTimeoutMs: 0, assistantResidencyRetryBaseMs: 5, assistantResidencyRetryCapMs: 20, ...options.service });
  return { service, workers };
}

const presence = (service: SessiondService) => service.runningStateSnapshot().assistant;

test("residency: ensureAssistantResident opens the latest assistant conversation and projects online", async () => {
  const { service, workers } = harness({ latest: { sessionId: "assistant-1" } });
  try {
    service.ensureAssistantResident();
    await waitUntil(() => presence(service)?.status === "online", "assistant online");
    assert.equal(workers.starts, 1);
    assert.equal(workers.workers[0]!.input.mode, "open");
    assert.equal(workers.workers[0]!.input.sessionId, "assistant-1");
    assert.deepEqual(presence(service), { sessionId: "assistant-1", status: "online" });
    // The tracked session rides the revisioned running watch.
    assert.ok(service.runningStateSnapshot().sessionIds.includes("assistant-1"));
    assert.ok(service.runningStateSnapshot().revision > 0);
  } finally {
    await service.shutdown();
  }
});

test("residency: armed without a conversation — nothing spawns; the first message creates + is adopted + is idle-exempt", async () => {
  const { service, workers } = harness({ latest: null, service: { idleTimeoutMs: 60 } });
  try {
    service.ensureAssistantResident();
    await waitUntil(() => presence(service)?.status === "armed", "assistant armed");
    assert.equal(workers.starts, 0);
    assert.equal(presence(service)?.sessionId, null);

    // First message: the normal create path in the assistant workspace.
    const created = await service.create({ createRequestId: "assistant-first", cwd: assistantDir, projectRoot: assistantDir });
    await waitUntil(() => presence(service)?.status === "online", "adopted online");
    assert.equal(presence(service)?.sessionId, created.sessionId);

    // Idle exemption: far past the 60ms timeout the resident record survives…
    await wait(200);
    assert.equal(presence(service)?.status, "online");
    assert.ok(service.runningStateSnapshot().sessionIds.includes(created.sessionId));
  } finally {
    await service.shutdown();
  }
});

test("residency: a normal session in the same service still idle-reclaims", async () => {
  const { service, workers } = harness({ latest: null, service: { idleTimeoutMs: 60 }, cwdFor: (sessionId) => sessionId === "normal-1" ? "/repos/normal" : assistantDir });
  try {
    service.ensureAssistantResident();
    await waitUntil(() => presence(service)?.status === "armed", "assistant armed");
    await service.activate("normal-1");
    assert.ok(service.runningStateSnapshot().sessionIds.includes("normal-1"));
    // Residency never adopted it (cwd is not the assistant workspace) and the
    // idle reclamation still owns non-tracked records.
    assert.notEqual(presence(service)?.sessionId, "normal-1");
    await waitUntil(() => !service.runningStateSnapshot().sessionIds.includes("normal-1"), "normal session reclaimed");
    assert.equal(workers.starts, 1);
  } finally {
    await service.shutdown();
  }
});

test("residency: unexpected worker exit restarts with backoff and republishes presence", async () => {
  const { service, workers } = harness({ latest: { sessionId: "assistant-1" } });
  try {
    service.ensureAssistantResident();
    await waitUntil(() => presence(service)?.status === "online", "assistant online");

    // Watch the running pushes while the worker dies.
    const pushes: SessiondRunningWatchPush[] = [];
    const watch = service.prepareRunningWatch();
    await watch.flushTo((push) => { pushes.push(push); });

    workers.workers[0]!.crash();
    await waitUntil(() => presence(service)?.status === "restarting", "presence restarting after crash");
    await waitUntil(() => presence(service)?.status === "online", "assistant back online");
    assert.equal(workers.starts, 2);
    assert.equal(workers.workers[1]!.input.sessionId, "assistant-1");
    // The restart transitions rode the revisioned running watch pushes.
    const statuses = pushes
      .filter((push): push is Extract<SessiondRunningWatchPush, { type: "running_state" }> => push.type === "running_state")
      .map((push) => push.state.assistant?.status);
    assert.ok(statuses.includes("restarting"), `expected restarting in pushes: ${JSON.stringify(statuses)}`);
    watch.close();
  } finally {
    await service.shutdown();
  }
});

test("residency: an explicit stop outside shutdown comes back (always-on)", async () => {
  const { service, workers } = harness({ latest: { sessionId: "assistant-1" } });
  try {
    service.ensureAssistantResident();
    await waitUntil(() => presence(service)?.status === "online", "assistant online");
    const stopped = await service.stop("assistant-1", "user");
    assert.equal(stopped, true);
    await waitUntil(() => presence(service)?.status === "online" && workers.starts === 2, "restarted after stop");
    assert.equal(workers.workers[1]!.input.sessionId, "assistant-1");
  } finally {
    await service.shutdown();
  }
});

test("residency: a vanished conversation collapses to armed with no retry loop", async () => {
  const { service, workers } = harness({ latest: { sessionId: "gone" }, locateExists: (sessionId) => sessionId !== "gone" });
  try {
    service.ensureAssistantResident();
    await waitUntil(() => presence(service)?.status === "armed", "armed after not_found");
    assert.deepEqual(presence(service), { sessionId: null, status: "armed" });
    // The locate failed closed BEFORE any worker process existed.
    assert.equal(workers.starts, 0);
    // No retry loop: still armed (and no worker) past several caps.
    await wait(80);
    assert.equal(presence(service)?.status, "armed");
    assert.equal(workers.starts, 0);
  } finally {
    await service.shutdown();
  }
});

test("residency: shutdown does not restart the assistant", async () => {
  const { service, workers } = harness({ latest: { sessionId: "assistant-1" } });
  service.ensureAssistantResident();
  await waitUntil(() => presence(service)?.status === "online", "assistant online");
  await service.shutdown();
  const startsAtShutdown = workers.starts;
  await wait(80);
  assert.equal(workers.starts, startsAtShutdown);
  assert.equal(service.runningStateSnapshot().sessionIds.length, 0);
});

test("residency: ensureAssistantResident is idempotent (one supervisor start, one activation)", async () => {
  const { service, workers } = harness({ latest: { sessionId: "assistant-1" } });
  try {
    service.ensureAssistantResident();
    service.ensureAssistantResident();
    await waitUntil(() => presence(service)?.status === "online", "assistant online");
    assert.equal(workers.starts, 1);
  } finally {
    await service.shutdown();
  }
});

test("supervisor: a rekey of the tracked conversation moves the tracked id; foreign rekeys never do", async () => {
  const supervisor = new AssistantResidencySupervisor({
    findLatestAssistantSession: async () => ({ sessionId: "a1" }),
    activate: async () => {},
    isLiveSession: () => true,
    isShuttingDown: () => false,
    publishPresenceChanged: () => {},
    log: () => {},
  }, { homedir: homedir(), retryBaseMs: 5, retryCapMs: 20 });
  supervisor.start();
  await wait(10);
  assert.deepEqual(supervisor.presence(), { sessionId: "a1", status: "online" });
  supervisor.onRekeyed("a1", "a1-real");
  assert.deepEqual(supervisor.presence(), { sessionId: "a1-real", status: "online" });
  // A rekey of some OTHER session never moves the tracked id.
  supervisor.onRekeyed("other", "other-real");
  assert.equal(supervisor.presence()?.sessionId, "a1-real");
  supervisor.dispose();
});
