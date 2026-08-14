import assert from "node:assert/strict";
import test from "node:test";
import { makeRuntimeError, type SessionCatalogPort, type SessionDetail, type SessionHeader, type SessionLocatorPort, type SessionMutationPort } from "@fffattiger/pix-runtime-core";
import { SessiondApplication } from "../src/application.js";
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

interface RenameHarnessOptions {
  worker?: ConstructorParameters<typeof FakeWorkerFactory>[0];
  service?: ConstructorParameters<typeof SessiondService>[1];
  mutation?: SessionMutationPort;
  /** Wrap the offline mutation in a deferred gate (hold/release/calls). */
  gateMutation?: boolean;
  /** Awaited before listSessions resolves (deterministic stale-read races). */
  catalogListHook?: () => Promise<void>;
}

interface RenameHarness {
  service: SessiondService;
  application: SessiondApplication;
  workers: FakeWorkerFactory;
  files: Map<string, boolean>;
  mutationTitles: Map<string, string>;
  catalogTitles: Map<string, string>;
  deleted: string[];
  mutationCalls: string[];
  mutationGate: { calls: string[]; hold: () => void; release: () => void };
  seed: (id: string, title?: string) => void;
  diagnostics: () => { lanes: number; aliases: number; activations: number; overlay: number; sessions: number };
}

/**
 * D4 rename harness: catalog + locator share a file-existence map; the offline
 * mutation appends to a SEPARATE title map while the catalog reads from its OWN
 * title map, so the service-owned overlay's stale-catalog bridge can be tested
 * deterministically (catalog convergence is simulated by the test).
 */
export function renameHarness(options: RenameHarnessOptions = {}): RenameHarness {
  const files = new Map<string, boolean>();
  const mutationTitles = new Map<string, string>();
  const catalogTitles = new Map<string, string>();
  const deleted: string[] = [];
  const mutationCalls: string[] = [];
  const baseMutation: SessionMutationPort = {
    async renameSession(sessionId, name) {
      mutationCalls.push(`${sessionId}:${name}`);
      if (!files.get(sessionId)) throw makeRuntimeError("not_found", `session not found: ${sessionId}`);
      mutationTitles.set(sessionId, name);
    },
  };
  const locator: SessionLocatorPort = {
    async locate(sessionId) { return { sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, exists: files.get(sessionId) ?? false }; },
    async resolveLeafId() { return "leaf"; },
  };
  const catalog: SessionCatalogPort = {
    async listSessions(filter) {
      if (options.catalogListHook) await options.catalogListHook();
      const title = (id: string): string | undefined => catalogTitles.get(id);
      let sessions = [...files].filter(([, exists]) => exists).map(([sessionId]) => {
        const header: SessionHeader = { sessionId, cwd: `/cwd/${sessionId}`, projectRoot: `/cwd/${sessionId}` };
        const t = title(sessionId);
        if (t !== undefined) header.title = t;
        return header;
      });
      if (filter?.cwd) sessions = sessions.filter((s) => s.cwd === filter.cwd);
      if (filter?.offset !== undefined) sessions = sessions.slice(filter.offset);
      if (filter?.limit !== undefined) sessions = sessions.slice(0, filter.limit);
      return sessions;
    },
    async readSession(sessionId) {
      if (!files.get(sessionId)) throw makeRuntimeError("not_found", `session not found: ${sessionId}`);
      const detail: SessionDetail = { sessionId, cwd: `/cwd/${sessionId}`, projectRoot: `/cwd/${sessionId}`, entries: [] };
      const t = catalogTitles.get(sessionId);
      if (t !== undefined) detail.title = t;
      return detail;
    },
    async readSessionContext(sessionId) {
      if (!files.get(sessionId)) throw makeRuntimeError("not_found", `session not found: ${sessionId}`);
      return { sessionId, entries: [] };
    },
    async deleteSession(sessionId) {
      if (!files.get(sessionId)) throw makeRuntimeError("not_found", `session not found: ${sessionId}`);
      files.set(sessionId, false);
      deleted.push(sessionId);
    },
  };
  const workers = new FakeWorkerFactory(options.worker);
  // Optional deferred gate around the offline mutation (shares the harness's
  // internal files/mutationTitles so seed() stays consistent).
  let gate: Promise<void> = Promise.resolve();
  let releaseGate: () => void = () => {};
  const gatedCalls: string[] = [];
  const gatedMutation: SessionMutationPort = {
    async renameSession(sessionId, name) {
      gatedCalls.push(`${sessionId}:${name}`);
      await gate;
      return baseMutation.renameSession(sessionId, name);
    },
  };
  const service = new SessiondService({
    sessionLocator: locator,
    activationContext: { async resolve(sessionId, _location, requestedCwd) { return { cwd: requestedCwd ?? `/cwd/${sessionId}`, projectRoot: requestedCwd ?? `/cwd/${sessionId}` }; } },
    workerFactory: workers,
    sessionCatalog: catalog,
    sessionMutation: options.mutation === undefined ? (options.gateMutation ? gatedMutation : baseMutation) : options.mutation,
  }, { workerStartTimeoutMs: 500, commandTimeoutMs: 500, idleTimeoutMs: 0, ...options.service });
  const application = new SessiondApplication(service);
  return {
    service,
    application,
    workers,
    files,
    mutationTitles,
    catalogTitles,
    deleted,
    mutationCalls,
    mutationGate: {
      calls: gatedCalls,
      hold: () => { gate = new Promise<void>((resolve) => { releaseGate = resolve; }); },
      release: () => { releaseGate(); gate = Promise.resolve(); },
    },
    seed: (id, title) => {
      files.set(id, true);
      if (title !== undefined) catalogTitles.set(id, title);
    },
    diagnostics: () => {
      const d = service.diagnostics();
      return { lanes: d.lanes, aliases: d.aliases, activations: d.activations, overlay: d.overlay, sessions: d.sessions };
    },
  };
}

// ---------------------------------------------------------------------------
// Offline rename first vs activation (requirement 1/2): FIFO + live path.
// ---------------------------------------------------------------------------

test("offline rename admitted first blocks activation (zero worker) until the append settles, then activation opens the renamed session", async () => {
  const h = renameHarness({ gateMutation: true });
  h.seed("s1");
  h.mutationGate.hold();
  const renameP = h.service.renameSession("s1", "New Title");
  await waitUntil(() => h.mutationGate.calls.length === 1);
  // activation admitted while the append is still settling: it must queue, not
  // start a worker, and not fail with busy.
  const activationP = h.service.activate("s1");
  await wait(20);
  assert.equal(h.workers.starts, 0, "activation must not start a worker while the rename append is pending");
  h.mutationGate.release();
  const renamed = await renameP;
  assert.equal(renamed.name, "New Title");
  const activated = await activationP;
  assert.equal(activated.sessionId, "s1");
  assert.equal(h.workers.starts, 1, "activation runs only after the append settles");
  await h.service.shutdown();
});

test("activation admitted first: rename waits, becomes a live set_session_name, and no offline mutation runs", async () => {
  const h = renameHarness({ worker: { readyDelayMs: 40 } });
  h.seed("s1");
  const activationP = h.service.activate("s1");
  const renameP = h.service.renameSession("s1", "Live");
  const activated = await activationP;
  assert.equal(activated.sessionId, "s1");
  const renamed = await renameP;
  assert.equal(renamed.name, "Live");
  assert.deepEqual(h.mutationCalls, [], "a rename behind a startup must never touch the offline mutation");
  assert.ok(h.workers.workers[0]!.sent.some((m) => m.type === "worker.command" && m.payload.command.type === "set_session_name"), "the live worker must receive set_session_name");
  assert.equal(h.service.diagnostics().overlay, 1, "confirmed live rename publishes the title overlay");
  await h.service.shutdown();
});

// ---------------------------------------------------------------------------
// Same-id FIFO across sessions.rename and runtime.command(set_session_name);
// different ids concurrent (requirement 5/7).
// ---------------------------------------------------------------------------

test("same-id renames FIFO across sessions.rename and runtime.command(set_session_name)", async () => {
  const h = renameHarness({ worker: { commandDelayMs: 60 } });
  h.seed("s1");
  await h.service.activate("s1");
  const worker = h.workers.workers[0]!;
  const p1 = h.service.renameSession("s1", "One");
  const p2 = h.service.command("s1", { type: "set_session_name", commandId: "cmd-2", name: "Two" });
  const p3 = h.service.renameSession("s1", "Three");
  await wait(10);
  const sentAt10 = worker.sent.filter((m) => m.type === "worker.command").map((m) => m.payload.command.commandId);
  assert.equal(sentAt10.length, 1, "the second/third rename must not reach the worker before the first settles");
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.equal(r1.name, "One");
  assert.equal(r2.commandId, "cmd-2");
  assert.equal(r2.result.ok, true);
  assert.equal(r3.name, "Three");
  const sent = worker.sent.filter((m) => m.type === "worker.command").map((m) => m.payload.command.commandId);
  assert.equal(sent.length, 3);
  assert.ok(sent[0]!.startsWith("rename:"), `first must be the sessions.rename command, got ${sent[0]}`);
  assert.equal(sent[1], "cmd-2", "runtime.command(set_session_name) must share the same lane in order");
  assert.ok(sent[2]!.startsWith("rename:"));
  assert.equal(h.service.diagnostics().overlay, 1, "last rename wins the overlay");
  const list = await h.service.listSessions();
  assert.equal(list.find((s) => s.sessionId === "s1")?.title, "Three");
  await h.service.shutdown();
});

test("different-id renames progress concurrently (no global identity lock)", async () => {
  const h = renameHarness({ gateMutation: true });
  h.seed("a");
  h.seed("b");
  h.mutationGate.hold();
  const pa = h.service.renameSession("a", "A");
  await waitUntil(() => h.mutationGate.calls.includes("a:A"));
  const pb = h.service.renameSession("b", "B");
  await waitUntil(() => h.mutationGate.calls.includes("b:B"), 1_000);
  h.mutationGate.release();
  await Promise.all([pa, pb]);
  assert.ok(h.mutationGate.calls.includes("a:A") && h.mutationGate.calls.includes("b:B"), "a different-id rename must not wait behind another id's in-flight rename");
  await h.service.shutdown();
});

// ---------------------------------------------------------------------------
// Delete ordering (requirement 3/4/5).
// ---------------------------------------------------------------------------

test("delete admitted first: activation queues, fails not_found, zero Workers", async () => {
  const h = renameHarness();
  h.seed("s1");
  const delP = h.service.deleteSession("s1");
  const actP = h.service.activate("s1");
  await delP;
  await assert.rejects(actP, (error: unknown) => {
    assert.ok(error instanceof SessiondError);
    assert.equal(error.code, "not_found");
    return true;
  });
  assert.equal(h.workers.starts, 0, "no worker may ever start for a deleted session");
  assert.equal(h.files.get("s1"), false);
  await h.service.shutdown();
});

test("delete admitted first: rename behind delete fails not_found and never recreates the file", async () => {
  const h = renameHarness();
  h.seed("s1");
  const delP = h.service.deleteSession("s1");
  const renameP = h.service.renameSession("s1", "Never");
  await delP;
  await assert.rejects(renameP, (error: unknown) => {
    assert.ok(error instanceof SessiondError);
    assert.equal(error.code, "not_found");
    return true;
  });
  assert.deepEqual(h.mutationCalls, ["s1:Never"], "the offline mutation was attempted and must fail not_found");
  assert.equal(h.files.get("s1"), false, "the rename must never recreate the file");
  await h.service.shutdown();
});

test("rename then delete both succeed; delete removes the renamed file and the overlay", async () => {
  const h = renameHarness();
  h.seed("s1");
  const renamed = await h.service.renameSession("s1", "Renamed");
  assert.equal(renamed.name, "Renamed");
  assert.equal(h.service.diagnostics().overlay, 1);
  await h.service.deleteSession("s1");
  assert.equal(h.files.get("s1"), false);
  assert.deepEqual(h.deleted, ["s1"]);
  assert.equal(h.service.diagnostics().overlay, 0, "delete must remove the overlay");
  await h.service.shutdown();
});

test("delete while an activation reservation exists fails closed promptly with session_busy", async () => {
  const h = renameHarness({ worker: { readyDelayMs: 300 } });
  h.seed("s1");
  const actP = h.service.activate("s1");
  await waitUntil(() => h.service.diagnostics().activations === 1);
  const started = Date.now();
  await assert.rejects(h.service.deleteSession("s1"), (error: unknown) => {
    assert.ok(error instanceof SessiondError);
    assert.equal(error.code, "session_busy");
    return true;
  });
  assert.ok(Date.now() - started < 250, "same-id delete must fail closed promptly, not wait for the worker");
  await actP;
  assert.equal(h.workers.starts, 1);
  await h.service.shutdown();
});

// ---------------------------------------------------------------------------
// Same-kind reservation proof at the service level (verifier kind-race2/3):
// one settled same-kind rename sibling must NOT release the lane while another
// is still pending, so a delete or third rename admitted in that window queues
// FIFO behind it instead of bypassing to a fresh lane. These fail the old
// Set<IdentityOperationKind> implementation deterministically.
// ---------------------------------------------------------------------------

const microtaskFlush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

test("delete admitted while a same-kind rename sibling is pending queues FIFO (never bypasses to a fresh lane)", async () => {
  // A and B are admitted CONCURRENTLY (sharing one lane); only B is gated, so
  // A settles while B is still pending. A delete admitted in that window must
  // queue behind B — the old Set implementation dropped the shared rename entry
  // on A's settle, removed the lane, and let the delete bypass B.
  const mutationCalls: string[] = [];
  const mutationTitles = new Map<string, string>();
  let blockForB = false;
  let bGatedResolve!: () => void;
  const bGatedPromise = new Promise<void>((resolve) => { bGatedResolve = resolve; });
  let releaseB!: () => void;
  const bGate = new Promise<void>((resolve) => { releaseB = resolve; });
  const h = renameHarness({
    mutation: {
      async renameSession(sessionId, name) {
        mutationCalls.push(`${sessionId}:${name}`);
        if (blockForB && name === "B") { bGatedResolve(); await bGate; }
        mutationTitles.set(sessionId, name);
      },
    },
  });
  h.seed("s1");
  const a = h.service.renameSession("s1", "A");
  blockForB = true;
  const b = h.service.renameSession("s1", "B"); // same lane as A (both pending)
  await a;
  await bGatedPromise; // deterministic: B is now gated after A settled

  // A delete admitted now must queue behind B, never bypass to a fresh lane.
  let deleteSettled = false;
  const del = h.service.deleteSession("s1").then(() => { deleteSettled = true; });
  await microtaskFlush();
  assert.equal(deleteSettled, false, "delete must remain unresolved while the same-kind rename B is pending");
  assert.deepEqual(h.deleted, [], "catalog delete must not run while B is pending");
  assert.equal(h.service.diagnostics().lanes, 1, "the lane must be retained while the same-kind sibling B is pending");

  // Release B → B settles, then the delete runs and succeeds in FIFO.
  releaseB();
  await b;
  await del;
  assert.equal(deleteSettled, true, "delete must run after B settles");
  assert.deepEqual(h.deleted, ["s1"], "the catalog delete commits after the rename sibling");
  const d = h.service.diagnostics();
  assert.equal(d.lanes, 0);
  assert.equal(d.aliases, 0);
  assert.equal(d.activations, 0);
  await h.service.shutdown();
});

test("a third same-kind rename C admitted while B is gated cannot run before B; final title is C", async () => {
  // A + B admitted concurrently (one lane), B gated; C admitted after A settles
  // must queue behind B (old Set implementation gave C a fresh lane and ran it
  // before B).
  const mutationCalls: string[] = [];
  const mutationTitles = new Map<string, string>();
  let blockForB = false;
  let bGatedResolve!: () => void;
  const bGatedPromise = new Promise<void>((resolve) => { bGatedResolve = resolve; });
  let releaseB!: () => void;
  const bGate = new Promise<void>((resolve) => { releaseB = resolve; });
  const h = renameHarness({
    mutation: {
      async renameSession(sessionId, name) {
        mutationCalls.push(`${sessionId}:${name}`);
        if (blockForB && name === "B") { bGatedResolve(); await bGate; }
        mutationTitles.set(sessionId, name);
      },
    },
  });
  h.seed("s1");
  const a = h.service.renameSession("s1", "A");
  blockForB = true;
  const b = h.service.renameSession("s1", "B");
  await a;
  await bGatedPromise; // B is gated; A settled

  const c = h.service.renameSession("s1", "C");
  await microtaskFlush();
  assert.deepEqual(mutationCalls, ["s1:A", "s1:B"], "C must not enter the mutation while B is gated");
  assert.equal(h.service.diagnostics().lanes, 1, "the lane must be retained with C queued behind B");

  releaseB();
  await Promise.all([b, c]);
  assert.deepEqual(mutationCalls, ["s1:A", "s1:B", "s1:C"], "same-kind renames must run in exact FIFO order");
  const list = await h.service.listSessions();
  assert.equal(list.find((s) => s.sessionId === "s1")?.title, "C", "the final title must be C");
  assert.equal(h.service.diagnostics().overlay, 1);
  const d = h.service.diagnostics();
  assert.equal(d.lanes, 0);
  assert.equal(d.aliases, 0);
  await h.service.shutdown();
});

// ---------------------------------------------------------------------------
// Explicit stop shares the lane (requirement 6).
// ---------------------------------------------------------------------------

test("rename-first live command settles before explicit stop", async () => {
  const h = renameHarness({ worker: { commandDelayMs: 60 } });
  h.seed("s1");
  await h.service.activate("s1");
  const worker = h.workers.workers[0]!;
  const renameP = h.service.renameSession("s1", "BeforeStop");
  const stopP = h.service.stop("s1", "user");
  await wait(10);
  assert.equal(worker.sent.filter((m) => m.type === "worker.command").length, 1, "the stop must not preempt the in-flight live rename");
  const [renamed, stopped] = await Promise.all([renameP, stopP]);
  assert.equal(renamed.name, "BeforeStop");
  assert.equal(stopped, true);
  assert.equal(h.service.listRunning().sessions.length, 0);
  assert.equal(h.service.diagnostics().overlay, 1, "the confirmed rename title survives the stop");
  await h.service.shutdown();
});

test("stop-first removes the record, then a rename uses the offline mutation", async () => {
  const h = renameHarness();
  h.seed("s1");
  await h.service.activate("s1");
  const stopP = h.service.stop("s1", "user");
  const renameP = h.service.renameSession("s1", "AfterStop");
  const [stopped, renamed] = await Promise.all([stopP, renameP]);
  assert.equal(stopped, true);
  assert.equal(renamed.name, "AfterStop");
  assert.deepEqual(h.mutationCalls, ["s1:AfterStop"], "after the record is removed the rename must use the offline mutation");
  await h.service.shutdown();
});

test("crashed record remains a reservation: rename is fixed unavailable, never falls back offline until explicitly stopped", async () => {
  const h = renameHarness();
  h.seed("s1");
  await h.service.activate("s1");
  h.workers.workers[0]!.crash();
  await assert.rejects(h.service.renameSession("s1", "No"), (error: unknown) => {
    assert.ok(error instanceof SessiondError);
    assert.equal(error.code, "unavailable");
    assert.ok(!String(error.message).includes("s1"), "no raw id in the fixed message");
    return true;
  });
  assert.deepEqual(h.mutationCalls, [], "a crashed record must NEVER fall back to offline rename");
  assert.equal(h.service.diagnostics().overlay, 0);
  await h.service.stop("s1");
  const renamed = await h.service.renameSession("s1", "Offline");
  assert.equal(renamed.name, "Offline");
  assert.deepEqual(h.mutationCalls, ["s1:Offline"], "after explicit stop the crashed reservation is removed and offline rename works");
  await h.service.shutdown();
});

// ---------------------------------------------------------------------------
// Live-command failure semantics (requirement 9): never false success.
// ---------------------------------------------------------------------------

test("sessions.rename surfaces a live {ok:false} as a fixed sanitized error and publishes no title", async () => {
  const h = renameHarness({ worker: { commandDelayMs: 5_000 } });
  h.seed("s1");
  await h.service.activate("s1");
  const worker = h.workers.workers[0]!;
  const p = h.service.renameSession("s1", "Fail");
  await waitUntil(() => worker.sent.some((m) => m.type === "worker.command"));
  const wire = worker.sent.find((m) => m.type === "worker.command")!;
  const commandId = (wire.payload as { command: { commandId: string } }).command.commandId;
  worker.emit({
    type: "worker.commandResult",
    id: wire.id,
    payload: {
      sessionId: "s1",
      result: {
        commandId,
        result: { ok: false, type: "set_session_name", error: { code: "command_rejected", message: "RAW_LEAK_SHOULD_NOT_SURFACE", retryable: false } },
      },
    },
  });
  await assert.rejects(p, (error: unknown) => {
    assert.ok(error instanceof SessiondError);
    assert.equal(error.code, "command_rejected");
    assert.equal(error.message, "session rename was rejected", "the raw worker message must be replaced by a fixed sanitized message");
    assert.ok(!String(error.message).includes("RAW_LEAK"));
    return true;
  });
  assert.equal(h.service.diagnostics().overlay, 0, "a failed live rename must never publish a title");
  await h.service.shutdown();
});

test("runtime.command(set_session_name) returns the structured {ok:false}, never a false success", async () => {
  const h = renameHarness({ worker: { commandDelayMs: 5_000 } });
  h.seed("s1");
  await h.service.activate("s1");
  const worker = h.workers.workers[0]!;
  const p = h.service.command("s1", { type: "set_session_name", commandId: "cmd-fail", name: "Fail" });
  await waitUntil(() => worker.sent.some((m) => m.type === "worker.command" && m.payload.command.commandId === "cmd-fail"));
  const wire = worker.sent.find((m) => m.type === "worker.command" && m.payload.command.commandId === "cmd-fail")!;
  worker.emit({
    type: "worker.commandResult",
    id: wire.id,
    payload: {
      sessionId: "s1",
      result: { commandId: "cmd-fail", result: { ok: false, type: "set_session_name", error: { code: "unavailable", message: "RAW", retryable: true } } },
    },
  });
  const result = await p;
  assert.equal(result.commandId, "cmd-fail");
  assert.equal(result.result.ok, false, "runtime.command must return the structured failure, not a success");
  assert.equal(result.result.type, "set_session_name");
  assert.equal(h.service.diagnostics().overlay, 0);
  await h.service.shutdown();
});

test("live rename timeout is propagated sanitized (never false success, no raw text)", async () => {
  const h = renameHarness({ worker: { commandDelayMs: 5_000 }, service: { commandTimeoutMs: 80 } });
  h.seed("s1");
  await h.service.activate("s1");
  await assert.rejects(h.service.renameSession("s1", "Timeout"), (error: unknown) => {
    assert.ok(error instanceof SessiondError);
    assert.equal(error.code, "unavailable");
    assert.equal(error.message, "session rename unavailable");
    assert.ok(!String(error.message).includes("timed out"), "no raw timeout text");
    return true;
  });
  assert.equal(h.service.diagnostics().overlay, 0);
  await h.service.shutdown();
});

test("crash during an in-flight live rename: fixed unavailable, no title, old worker result can never affect the new Worker", async () => {
  // Only the first worker delays its command result; the reactivated worker
  // answers immediately so the "Fresh" rename succeeds deterministically.
  const h = renameHarness({ worker: (input, index) => ({ commandDelayMs: index === 0 ? 5_000 : 0 }) });
  h.seed("s1");
  await h.service.activate("s1");
  const worker = h.workers.workers[0]!;
  const p = h.service.renameSession("s1", "Crash");
  await waitUntil(() => worker.sent.some((m) => m.type === "worker.command"));
  worker.crash();
  await assert.rejects(p, (error: unknown) => {
    assert.ok(error instanceof SessiondError);
    assert.equal(error.code, "unavailable");
    return true;
  });
  assert.equal(h.service.diagnostics().overlay, 0, "a crash mid-rename must not publish a title");
  // Explicit stop clears the crashed reservation, then reactivate on a fresh worker.
  await h.service.stop("s1");
  await h.service.activate("s1");
  assert.equal(h.workers.starts, 2);
  assert.equal(h.service.diagnostics().overlay, 0, "the old record's rename must never affect the new Worker");
  const ok = await h.service.renameSession("s1", "Fresh");
  assert.equal(ok.name, "Fresh");
  assert.equal(h.service.diagnostics().overlay, 1, "the new Worker's rename publishes on the new record only");
  await h.service.shutdown();
});

// ---------------------------------------------------------------------------
// Rekey (requirement 8): stale old-id requests, authoritative-id queue,
// occupied-target collision, exact alias cleanup.
// ---------------------------------------------------------------------------

test("rekey: request queued against the old id before rekey is stale conflict and never calls offline mutation", async () => {
  const h = renameHarness({ worker: { discoveredSessionId: "real-s", primeSnapshotDelayMs: 120 } });
  h.seed("s");
  const activationP = h.service.activate("s");
  // Admitted synchronously before the worker's rekey (generation 0 captured).
  const staleRename = h.service.renameSession("s", "Stale");
  await waitUntil(() => h.service.listRunning().sessions.some((item) => item.sessionId === "real-s"), 1_000);
  await activationP;
  await assert.rejects(staleRename, (error: unknown) => {
    assert.ok(error instanceof SessiondError);
    assert.equal(error.code, "conflict", "a request queued against the old id before rekey must fail stale conflict");
    return true;
  });
  assert.deepEqual(h.mutationCalls, [], "the stale request must NEVER call offline mutation against the old id");
  await h.service.shutdown();
});

test("rekey: request admitted under the authoritative id after binding queues behind startup and runs live", async () => {
  const h = renameHarness({ worker: { discoveredSessionId: "real-s", primeSnapshotDelayMs: 120 } });
  h.seed("s");
  const activationP = h.service.activate("s");
  // Wait until the rekey has bound real-s to the same startup lane.
  await waitUntil(() => h.service.listRunning().sessions.some((item) => item.sessionId === "real-s"), 1_000);
  const authRename = h.service.renameSession("real-s", "Auth");
  await activationP;
  const renamed = await authRename;
  assert.equal(renamed.name, "Auth");
  assert.deepEqual(h.mutationCalls, [], "the authoritative-id rename must run live, never offline");
  assert.ok(h.workers.workers[0]!.sent.some((m) => m.type === "worker.command" && m.payload.command.type === "set_session_name"));
  const d = h.service.diagnostics();
  assert.equal(d.activations, 0);
  assert.equal(d.lanes, 0, "no lane may leak after the rekeyed activation + rename settle");
  assert.equal(d.aliases, 0, "no alias may leak after the rekeyed activation + rename settle");
  await h.service.shutdown();
});

test("rekey: a stop queued against the old id still stops the authoritative record (no stale no-op)", async () => {
  const h = renameHarness({ worker: { discoveredSessionId: "real-s", primeSnapshotDelayMs: 120 } });
  h.seed("s");
  const activationP = h.service.activate("s");
  // Admitted synchronously before the rekey (captures the old generation).
  const stopP = h.service.stop("s", "user");
  await activationP;
  const stopped = await stopP;
  assert.equal(stopped, true, "a stop queued before rekey must stop the authoritative record");
  assert.equal(h.service.listRunning().sessions.length, 0, "the authoritative record must be stopped");
  const d = h.service.diagnostics();
  assert.equal(d.lanes, 0);
  assert.equal(d.aliases, 0);
  assert.equal(d.activations, 0);
  await h.service.shutdown();
});

test("rekey to an occupied target lane fails startup closed with fixed conflict (no wait/merge/steal)", async () => {
  const h = renameHarness({ gateMutation: true, worker: { discoveredSessionId: "real-s", readyDelayMs: 80 } });
  h.seed("s");
  const activationP = h.service.activate("s");
  // Occupy the target with an independent pending rename BEFORE the rekey binds.
  h.mutationGate.hold();
  const targetRename = h.service.renameSession("real-s", "Occupied");
  await waitUntil(() => h.mutationGate.calls.includes("real-s:Occupied"));
  await assert.rejects(activationP, (error: unknown) => {
    assert.ok(error instanceof SessiondError);
    assert.equal(error.code, "conflict", "rekey into an occupied target must fail closed with conflict");
    return true;
  });
  h.mutationGate.release();
  await assert.rejects(targetRename, (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, "not_found");
    return true;
  });
  const d = h.service.diagnostics();
  assert.equal(d.lanes, 0);
  assert.equal(d.aliases, 0);
  assert.equal(d.activations, 0);
  await h.service.shutdown();
});

// ---------------------------------------------------------------------------
// Leaks / poisoning (requirement 10).
// ---------------------------------------------------------------------------

test("failed operations leave no coordinator/alias/activation leaks and a failed tail does not poison later tasks", async () => {
  const h = renameHarness();
  await assert.rejects(h.service.renameSession("ghost", "X"), (e: unknown) => (e as { code?: string }).code === "not_found");
  await assert.rejects(h.service.deleteSession("ghost"), (e: unknown) => (e as { code?: string }).code === "not_found");
  // The same id must be usable again: a failed task must not poison the lane tail.
  h.seed("ghost");
  const renamed = await h.service.renameSession("ghost", "Ok");
  assert.equal(renamed.name, "Ok");
  assert.deepEqual(h.mutationCalls, ["ghost:X", "ghost:Ok"], "the failed rename reached the mutation (not_found), then the retry succeeded");
  const d = h.service.diagnostics();
  assert.equal(d.lanes, 0, "no lane may leak after failures");
  assert.equal(d.aliases, 0, "no alias may leak after failures");
  assert.equal(d.activations, 0);
  assert.equal(d.overlay, 1);
  await h.service.shutdown();
});

test("no lane/alias/activation leak after live rename + stop + delete", async () => {
  const h = renameHarness();
  h.seed("s1");
  await h.service.activate("s1");
  await h.service.renameSession("s1", "LeakCheck");
  await h.service.stop("s1");
  await h.service.deleteSession("s1");
  const d = h.service.diagnostics();
  assert.equal(d.lanes, 0);
  assert.equal(d.aliases, 0);
  assert.equal(d.activations, 0);
  assert.equal(d.overlay, 0);
  await h.service.shutdown();
});

// ---------------------------------------------------------------------------
// Title overlay (requirement F).
// ---------------------------------------------------------------------------

test("immediate list/read overlay after offline rename; a convergent same-title read removes the overlay", async () => {
  const h = renameHarness();
  h.seed("s1");
  const renamed = await h.service.renameSession("s1", "  New Name  ");
  assert.equal(renamed.name, "New Name", "the RPC returns the canonical trimmed name");
  // The catalog is stale (no title yet) → the overlay bridges it.
  const list = await h.service.listSessions();
  assert.equal(list.find((s) => s.sessionId === "s1")?.title, "New Name");
  const read = await h.service.readSession("s1");
  assert.equal(read.title, "New Name");
  assert.equal(h.service.diagnostics().overlay, 1);
  // Catalog converges to the same title → a read removes the overlay entry.
  h.catalogTitles.set("s1", "New Name");
  const list2 = await h.service.listSessions();
  assert.equal(list2.find((s) => s.sessionId === "s1")?.title, "New Name");
  assert.equal(h.service.diagnostics().overlay, 0, "a same-title convergent read must remove the overlay");
  const read2 = await h.service.readSession("s1");
  assert.equal(read2.title, "New Name");
  await h.service.shutdown();
});

test("an older catalog response cannot clear a newer overlay revision", async () => {
  let releaseList!: () => void;
  const listGate = new Promise<void>((resolve) => { releaseList = resolve; });
  const h = renameHarness({ catalogListHook: () => listGate });
  h.seed("s1");
  const listP = h.service.listSessions(); // begins before any overlay publish
  await h.service.renameSession("s1", "New"); // publishes revision N while the read is in flight
  releaseList();
  const sessions = await listP;
  assert.equal(sessions.find((s) => s.sessionId === "s1")?.title, "New", "a stale read must surface the current title");
  assert.equal(h.service.diagnostics().overlay, 1, "the stale read must NOT clear the newer overlay revision");
  await h.service.shutdown();
});

test("delete removes the overlay; explicit stop retains it", async () => {
  const h = renameHarness();
  h.seed("s1");
  await h.service.renameSession("s1", "Persist");
  assert.equal(h.service.diagnostics().overlay, 1);
  await h.service.activate("s1");
  await h.service.stop("s1");
  assert.equal(h.service.diagnostics().overlay, 1, "explicit stop must retain the overlay");
  await h.service.deleteSession("s1");
  assert.equal(h.service.diagnostics().overlay, 0, "delete must remove the overlay");
  await h.service.shutdown();
});

// ---------------------------------------------------------------------------
// Shutdown drain (requirement E): no lane recursion deadlock.
// ---------------------------------------------------------------------------

test("shutdown drains with an in-flight lane operation without deadlocking on the lane", async () => {
  const h = renameHarness({ worker: { commandDelayMs: 5_000 }, service: { commandTimeoutMs: 80 } });
  h.seed("s1");
  await h.service.activate("s1");
  const renameP = h.service.renameSession("s1", "Hang"); // in flight in the lane
  const started = Date.now();
  await h.service.shutdown();
  assert.ok(Date.now() - started < 1_000, "bulk shutdown must use the lane-free bypass, not wait for a queued lane operation");
  await assert.rejects(renameP, (e: unknown) => (e as { code?: string }).code === "unavailable");
});

// ---------------------------------------------------------------------------
// Boundary RPC errors (requirement G).
// ---------------------------------------------------------------------------

test("boundary: missing offline rename surfaces fixed not_found; invalid names invalid_input; null mutation unavailable", async () => {
  const h = renameHarness();
  // Missing offline session → not_found, sanitized (no id echo).
  await assert.rejects(h.application.handle("sessions.rename", { sessionId: "missing-secret-id", name: "X" }), (error: unknown) => {
    assert.ok(error instanceof SessiondError);
    assert.equal(error.code, "not_found");
    assert.ok(!String(error.message).includes("missing-secret-id"));
    return true;
  });
  // Invalid names → invalid_input, sanitized (no raw name echo).
  for (const bad of ["   ", "a".repeat(201), "bad\u0000name"]) {
    await assert.rejects(h.application.handle("sessions.rename", { sessionId: "s1", name: bad }), (error: unknown) => {
      assert.ok(error instanceof SessiondError);
      assert.equal(error.code, "invalid_input");
      assert.ok(!String(error.message).includes(bad), "no raw name may echo");
      return true;
    });
  }
  // Null mutation → offline rename unavailable (fail-closed), fixed.
  const noMutation = renameHarness({ mutation: null as unknown as SessionMutationPort });
  noMutation.seed("s1");
  await assert.rejects(noMutation.application.handle("sessions.rename", { sessionId: "s1", name: "Nope" }), (error: unknown) => {
    assert.ok(error instanceof SessiondError);
    assert.equal(error.code, "unavailable");
    assert.equal(error.message, "session mutation is unavailable");
    return true;
  });
  await h.service.shutdown();
  await noMutation.service.shutdown();
});
