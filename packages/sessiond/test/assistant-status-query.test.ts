/**
 * Round 4: worker.statusQuery — the read-only authoritative status channel.
 * Only the ASSISTANT worker (record cwd in the assistant workspace) gets a
 * reply; everyone else is silently refused. The reply derives from the same
 * inputs as the running watch (isTurnRunning) plus pending extension UI.
 */
import assert from "node:assert/strict";
import { homedir } from "node:os";
import test from "node:test";
import { SessiondService } from "../src/service.js";
import { FakeWorkerFactory } from "../src/testing/fake-worker.js";
import { InMemoryWorkspaceStateStore } from "../src/workspace-state.js";
import { resolveAssistantWorkspaceDir } from "@fffattiger/pix-runtime-core";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(predicate: () => boolean, label: string, deadlineMs = 2_000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(2);
  }
  throw new Error(`waitUntil timed out: ${label}`);
}

const locator = {
  async locate(sessionId: string) { return { sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, exists: true }; },
  async resolveLeafId() { return "leaf"; },
};

function makeService(cwdFor: (sessionId: string) => string) {
  const workers = new FakeWorkerFactory({});
  const service = new SessiondService({
    sessionLocator: locator,
    activationContext: { async resolve(sessionId) { return { cwd: cwdFor(sessionId), projectRoot: cwdFor(sessionId) }; } },
    workerFactory: workers,
  }, { workerStartTimeoutMs: 500, commandTimeoutMs: 500, idleTimeoutMs: 0 });
  return { service, workers };
}

test("worker.statusQuery: assistant worker gets an authoritative snapshot; busy/waitingUser derive correctly", async () => {
  const assistantDir = resolveAssistantWorkspaceDir(homedir());
  const { service, workers } = makeService((sessionId) =>
    sessionId === "assistant" ? assistantDir
      : sessionId === "runner" ? "/repos/runner"
      : "/repos/waiter");
  try {
    await service.activate("assistant");
    await service.activate("runner");
    await service.activate("waiter");
    const assistantWorker = workers.workers.find((w) => w.input.sessionId === "assistant")!;

    // Baseline: all live, none busy, no pending UI.
    assistantWorker.emit({ type: "worker.statusQuery", id: "q1", payload: { sessionId: "assistant" } });
    await waitUntil(() => assistantWorker.sent.some((m) => m.type === "worker.statusQueryResult"), "baseline reply");
    const baseline = assistantWorker.sent.find((m) => m.type === "worker.statusQueryResult") as { payload: { sessions: Array<{ sessionId: string; state: string }> } };
    const states = new Map(baseline.payload.sessions.map((row) => [row.sessionId, row.state]));
    assert.equal(states.get("assistant"), "live");
    assert.equal(states.get("runner"), "live");
    assert.equal(states.get("waiter"), "live");

    // Runner turns busy: a snapshot with isPromptRunning=true drives isTurnRunning.
    const runnerWorker = workers.workers.find((w) => w.input.sessionId === "runner")!;
    runnerWorker.emit({
      type: "worker.snapshot",
      payload: {
        sessionId: "runner",
        snapshot: {
          sessionId: "runner",
          cwd: "/repos/runner",
          projectRoot: "/repos/runner",
          state: {
            sessionId: "runner",
            model: null,
            isStreaming: false, isPromptRunning: true, isBashRunning: false, isCompacting: false,
            autoCompactionEnabled: true, autoRetryEnabled: true, messageCount: 0, pendingMessageCount: 0,
            queuedMessages: { steering: [], followUp: [] }, contextUsage: { percent: 0, contextWindow: 1000, tokens: 0 },
            tools: [], extensionNotifications: [],
            pendingExtensionUi: [], writtenFiles: [], builtIns: { configRevision: "0".repeat(64), loaded: [], failures: [] },
            todo: { revision: 0, items: [] }, subagents: { revision: 0, tasks: [] },
          },
          capabilities: { capabilities: ["runtime.prompt"], version: 1 },
          streaming: { active: false, phase: "idle" },
        },
      },
    });
    // Waiter waits on an extension UI request: the shared projection applies it.
    const waiterWorker = workers.workers.find((w) => w.input.sessionId === "waiter")!;
    waiterWorker.emit({
      type: "worker.event",
      payload: {
        sessionId: "waiter",
        event: {
          type: "extension_ui_request",
          sessionId: "waiter",
          request: {
            id: "ui-1",
            method: "select",
            title: "继续吗？",
            options: ["继续", "停止"],
          },
        },
      },
    });

    assistantWorker.emit({ type: "worker.statusQuery", id: "q2", payload: { sessionId: "assistant" } });
    await waitUntil(() => assistantWorker.sent.filter((m) => m.type === "worker.statusQueryResult").length >= 2, "second reply");
    const second = [...assistantWorker.sent].reverse().find((m) => m.type === "worker.statusQueryResult") as { payload: { sessions: Array<{ sessionId: string; state: string }> } };
    const states2 = new Map(second.payload.sessions.map((row) => [row.sessionId, row.state]));
    assert.equal(states2.get("runner"), "busy");
    assert.equal(states2.get("waiter"), "waitingUser");
    assert.equal(states2.get("assistant"), "live");
  } finally {
    await service.shutdown();
  }
});

test("worker.statusQuery: non-assistant workers are refused with no reply", async () => {
  const { service, workers } = makeService(() => "/repos/normal");
  try {
    await service.activate("normal");
    const worker = workers.workers[0]!;
    worker.emit({ type: "worker.statusQuery", id: "q1", payload: { sessionId: "normal" } });
    await wait(60);
    assert.equal(worker.sent.some((m) => m.type === "worker.statusQueryResult"), false);
  } finally {
    await service.shutdown();
  }
});

test("worker.statusQuery: a crashed worker's session disappears from the snapshot", async () => {
  const assistantDir = resolveAssistantWorkspaceDir(homedir());
  const { service, workers } = makeService((sessionId) =>
    sessionId === "assistant" ? assistantDir : "/repos/gone");
  try {
    await service.activate("assistant");
    await service.activate("gone");
    const assistantWorker = workers.workers.find((w) => w.input.sessionId === "assistant")!;
    const goneWorker = workers.workers.find((w) => w.input.sessionId === "gone")!;
    goneWorker.emit({ type: "worker.fatal", payload: { sessionId: "gone", error: { code: "worker_unavailable", message: "killed", retryable: true } } });
    await waitUntil(() => assistantWorker.sent.length >= 0 && service.listRunning().sessions.every((row) => row.sessionId !== "gone"), "gone removed");
    assistantWorker.emit({ type: "worker.statusQuery", id: "q3", payload: { sessionId: "assistant" } });
    await waitUntil(() => assistantWorker.sent.some((m) => m.type === "worker.statusQueryResult"), "reply");
    const reply = assistantWorker.sent.find((m) => m.type === "worker.statusQueryResult") as { payload: { sessions: Array<{ sessionId: string }> } };
    assert.equal(reply.payload.sessions.some((row) => row.sessionId === "gone"), false, "crashed session must not be reported");
  } finally {
    await service.shutdown();
  }
});

test("workspace flags: durable store write, authoritative read-back, global sessions_changed push, fail-closed input", async () => {
  const store = new InMemoryWorkspaceStateStore();
  const workers = new FakeWorkerFactory({});
  const service = new SessiondService({
    sessionLocator: locator,
    activationContext: { async resolve(sessionId) { return { cwd: sessionId === "t" ? "/repos/t" : "/repos/x", projectRoot: "/repos" }; } },
    workerFactory: workers,
    workspaceState: store,
  }, { workerStartTimeoutMs: 500, commandTimeoutMs: 500, idleTimeoutMs: 0 });
  try {
    // Session flags: merged effective state, revision bumps.
    const result = await service.setSessionFlags("t", { pinned: true, archived: true });
    assert.deepEqual(result, { sessionId: "t", pinned: true, archived: true, revision: 1 });
    const partial = await service.setSessionFlags("t", { archived: false });
    assert.deepEqual(partial, { sessionId: "t", pinned: true, archived: false, revision: 2 });

    // Project flags: same store, same push.
    const project = await service.setProjectFlags("/repos/t", { pinned: true });
    assert.deepEqual(project, { projectRoot: "/repos/t", pinned: true, archived: false, revision: 3 });

    // Unified read.
    const flags = service.getWorkspaceFlags();
    assert.equal(flags.revision, 3);
    assert.deepEqual(flags.sessions, { t: { pinned: true, archived: false } });
    assert.deepEqual(flags.projects, { "/repos/t": { pinned: true } });

    // No flags at all → structured invalid_input, no write, no revision bump.
    await assert.rejects(service.setSessionFlags("t", {}), (error: { code?: string }) => error.code === "invalid_input");
    await assert.rejects(service.setProjectFlags("not/absolute", { pinned: true }), (error: { code?: string }) => error.code === "invalid_input");
    assert.equal(store.snapshot().revision, 3);

    // Global sessions_changed push reaches running-watch subscribers on both kinds.
    const pushes: string[] = [];
    const watch = service.prepareRunningWatch();
    await watch.flushTo((push) => { pushes.push(push.type); });
    await service.setSessionFlags("t", { pinned: false });
    await service.setProjectFlags("/repos/t", { archived: true });
    await wait(150);
    assert.ok(pushes.includes("sessions_changed"), `pushes=${JSON.stringify(pushes)}`);
    watch.close();
  } finally {
    await service.shutdown();
  }
});

test("workspace flags merge onto list rows; a missing store fails closed", async () => {
  const workers = new FakeWorkerFactory({});
  const store = new InMemoryWorkspaceStateStore();
  await store.setSessionFlags("listed", { pinned: true });
  // The fake catalog page serves one row; flags from the store land on it.
  const catalog = {
    async listSessionPage() {
      return {
        sessions: [{ sessionId: "listed", cwd: "/repos/listed", projectRoot: "/repos/listed" }],
        page: 1, pageSize: 10, total: 1, totalPages: 1, catalogRevision: 1,
      };
    },
  };
  const withStore = new SessiondService({
    sessionLocator: locator,
    activationContext: { async resolve(sessionId) { return { cwd: `/repos/${sessionId}`, projectRoot: `/repos/${sessionId}` }; } },
    workerFactory: workers,
    sessionCatalog: catalog as never,
    workspaceState: store,
  }, { workerStartTimeoutMs: 500, commandTimeoutMs: 500, idleTimeoutMs: 0 });
  try {
    const page = await withStore.listSessionPage({ page: 1, pageSize: 10 });
    assert.equal(page.sessions[0]?.pinned, true);
  } finally {
    await withStore.shutdown();
  }

  // No store wired → flag writes fail closed (never a fake success).
  const noStore = new SessiondService({
    sessionLocator: locator,
    activationContext: { async resolve(sessionId) { return { cwd: `/repos/${sessionId}`, projectRoot: `/repos/${sessionId}` }; } },
    workerFactory: new FakeWorkerFactory({}),
    workspaceState: null,
  }, { workerStartTimeoutMs: 500, commandTimeoutMs: 500, idleTimeoutMs: 0 });
  try {
    await assert.rejects(noStore.setSessionFlags("x", { pinned: true }), (error: { code?: string }) => error.code === "unavailable");
  } finally {
    await noStore.shutdown();
  }
});
