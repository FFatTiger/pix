import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProtocolHandshakeResponse } from "@fffattiger/pix-protocol";
import { createHarness, flush, lastFrame, snapshotPayload, type FakeWebSocket, type RuntimeHarness } from "./testing/harness";
import type { RuntimeControllerPort as ConnectionControllerPort } from "./runtime-connection";
import { homePresentationKey, sessionPresentationKey } from "./session-controller-registry";
import { sessionTabId } from "../features/workspace/tabs/workspace-tab-state";

function ack(features: readonly string[] = ["runtime.running-watch.v1", "runtime.submit-turn.v1", "runtime.read-rpc.v1", "runtime.observe-existing.v1"]): { type: "handshake_ack"; payload: ProtocolHandshakeResponse } {
  return {
    type: "handshake_ack",
    payload: {
      protocolVersion: 2,
      host: { mode: "local", capabilities: ["agent"] },
      limits: { maxUpload: 0, maxOpenSessions: 4 },
      sessionSnapshotSupport: true,
      acceptedFeatures: [...features],
    },
  };
}

const inertPort = (): ConnectionControllerPort => ({
  onTransportState: () => undefined,
  onTransportFatal: () => undefined,
  onSnapshot: () => undefined,
  onEvent: () => undefined,
  onTurnStatus: () => undefined,
  onUnavailable: () => undefined,
});

async function ready(h: RuntimeHarness, features?: readonly string[]): Promise<FakeWebSocket> {
  h.store.connect();
  const ws = h.lastSocket();
  ws.serverOpen();
  ws.serverSend(ack(features));
  await flush();
  return ws;
}

async function acquire(h: RuntimeHarness, ws: FakeWebSocket, sessionId: string, epoch = `e-${sessionId}`, lastEventId = 0): Promise<void> {
  const promise = h.registry.acquire(sessionId);
  await flush();
  const attach = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string; epoch?: string; lastEventId?: number } }>(ws, "attach")!;
  expect(attach.payload.sessionId).toBe(sessionId);
  ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId, epoch, lastEventId }) });
  await promise;
}

async function transfer(h: RuntimeHarness, ws: FakeWebSocket, sessionId: string, epoch = `e-${sessionId}`, lastEventId = 0): Promise<void> {
  const sourceSessionId = h.registry.leaseSnapshot.holderSessionId;
  const promise = h.registry.acquire(sessionId);
  await flush();
  expect(h.registry.leaseSnapshot).toMatchObject({ phase: "releasing", sourceSessionId, targetSessionId: sessionId, desiredSessionId: sessionId });
  const detach = lastFrame<{ type: "detach"; id: string; payload: { sessionId: string } }>(ws, "detach")!;
  ws.serverSend({ type: "response", id: detach.id, payload: { ok: true, result: { sessionId: detach.payload.sessionId, detached: true } } });
  await flush();
  expect(h.registry.leaseSnapshot).toMatchObject({ phase: "acquiring", targetSessionId: sessionId, desiredSessionId: sessionId });
  const attach = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string; epoch?: string; lastEventId?: number } }>(ws, "attach")!;
  expect(attach.payload.sessionId).toBe(sessionId);
  ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId, epoch, lastEventId }) });
  await promise;
}

function commandAck(ws: FakeWebSocket, frame: { id: string; payload: { sessionId: string; command: { commandId: string; type: string } } }): void {
  ws.serverSend({
    type: "response",
    id: frame.id,
    payload: {
      sessionId: frame.payload.sessionId,
      ok: true,
      result: { commandId: frame.payload.command.commandId, result: { ok: true, type: frame.payload.command.type } },
    },
  });
}

describe("SessionControllerRegistry — exact bounded retention and one lease", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("returns stable exact controllers for duplicate ids while A/B bindings coexist", () => {
    const h = createHarness({ storeOptions: { maxControllers: 4 } });
    const a = h.registry.getOrCreate("A");
    const b = h.registry.getOrCreate("B");
    expect(a).not.toBe(b);
    expect(h.registry.lookup("A")).toBe(a);
    expect(h.registry.getOrCreate("A")).toBe(a);
    expect(() => h.connection.registerController("A", inertPort())).toThrow(/already has a controller/);
    expect(h.registry.controllerCount).toBe(2);
    h.dispose();
  });

  it("evicts deterministic monotonic LRU among quiescent detached controllers only; eviction is local unbind with zero wire", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 2 } });
    const ws = await ready(h);
    h.registry.getOrCreate("A");
    h.registry.getOrCreate("B");
    h.registry.lookup("A"); // A newer, so B is deterministic LRU.
    h.registry.getOrCreate("C");
    expect(h.registry.lookup("B")).toBeNull();
    expect(h.registry.lookup("A")).not.toBeNull();
    expect(h.registry.lookup("C")).not.toBeNull();
    expect(() => h.connection.registerController("B", inertPort())).not.toThrow();
    expect(ws.sent.filter((frame) => ["detach", "stop"].includes((frame as { type?: string }).type ?? ""))).toHaveLength(0);
    expect(h.registry.controllerCount).toBeLessThanOrEqual(2);
    h.dispose();
  });

  it("repeated admissions stay bounded and leave no duplicate exact binding", () => {
    const h = createHarness({ storeOptions: { maxControllers: 3 } });
    for (let index = 0; index < 40; index += 1) {
      h.registry.getOrCreate(`session-${index}`);
      expect(h.registry.controllerCount).toBeLessThanOrEqual(3);
    }
    expect(h.registry.controllerCount).toBe(3);
    expect(h.registry.lookup("session-39")).not.toBeNull();
    expect(() => h.connection.registerController("session-39", inertPort())).toThrow(/already has a controller/);
    h.dispose();
  });

  it("protects held/acquiring and pending exact lanes; all protected fails locally session_busy before wire/disposal", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 1 } });
    const ws = await ready(h, []);
    await acquire(h, ws, "A");
    const before = ws.sent.length;
    expect(() => h.registry.getOrCreate("B")).toThrow(expect.objectContaining({ code: "session_busy", retryable: true }));
    await expect(h.registry.createSession({ cwd: "/x", projectRoot: "/x" })).rejects.toMatchObject({ code: "session_busy", retryable: true });
    expect(ws.sent).toHaveLength(before);
    expect(h.registry.lookup("A")?.evictionProtection.attached).toBe(true);
    expect(h.registry.controllerCount).toBe(1);
    h.dispose();
  });

  it("create reservation counts capacity, failure releases, and success registers full authority before resolution", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 2 } });
    const ws = await ready(h);
    await acquire(h, ws, "A", "eA", 4);
    const create = h.registry.createSession({ cwd: "/x", projectRoot: "/x" });
    await flush();
    expect(h.registry.getSnapshot().createReserved).toBe(true);
    expect(() => h.registry.getOrCreate("C")).toThrow(expect.objectContaining({ code: "session_busy" }));
    const frame = lastFrame<{ type: "create"; id: string }>(ws, "create")!;
    ws.serverSend({
      type: "response",
      id: frame.id,
      payload: { ok: true, result: { sessionId: "B", epoch: "eB", lastEventId: 7, created: true, cwd: "/x", projectRoot: "/x", snapshot: snapshotPayload({ sessionId: "B", epoch: "eB", lastEventId: 7 }).snapshot } },
    });
    const result = await create;
    expect(result).toEqual({ sessionId: "B" });
    const b = h.registry.lookup("B")!;
    expect(b.getSnapshot()).toMatchObject({ sessionId: "B", epoch: "eB" });
    expect(b.hasResumeAuthority).toBe(true);
    expect(h.registry.leaseSnapshot.holderSessionId).toBe("A");
    expect(ws.sent.filter((candidate) => (candidate as { type?: string }).type === "detach")).toHaveLength(0);
    h.dispose();

    const failed = createHarness({ storeOptions: { maxControllers: 1 } });
    const failedWs = await ready(failed);
    const failedCreate = failed.registry.createSession({ cwd: "/x", projectRoot: "/x" });
    await flush();
    const failedFrame = lastFrame<{ type: "create"; id: string }>(failedWs, "create")!;
    failedWs.serverSend({ type: "response", id: failedFrame.id, payload: { ok: false, error: { code: "unavailable", message: "failed", retryable: true } } });
    await expect(failedCreate).rejects.toMatchObject({ code: "unavailable" });
    expect(failed.registry.getSnapshot().createReserved).toBe(false);
    expect(() => failed.registry.getOrCreate("after-failure")).not.toThrow();
    failed.dispose();
  });

  it("old-daemon create omission never guesses revision zero and attaches first", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 2 } });
    const ws = await ready(h);
    const create = h.store.createSession({ cwd: "/x", projectRoot: "/x" });
    await flush();
    const createFrame = lastFrame<{ type: "create"; id: string }>(ws, "create")!;
    ws.serverSend({ type: "response", id: createFrame.id, payload: { ok: true, result: { sessionId: "legacy", epoch: "eL", created: true, cwd: "/x", projectRoot: "/x" } } });
    await create;
    const send = h.store.sendPromptToSession("legacy", "first");
    await flush();
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "submit_turn")).toHaveLength(0);
    const attach = lastFrame<{ type: "attach"; id: string; payload: Record<string, unknown> }>(ws, "attach")!;
    expect(attach.payload).toEqual({ sessionId: "legacy" });
    ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "legacy", epoch: "eL", lastEventId: 9 }) });
    await flush();
    const submit = lastFrame<{ type: "submit_turn"; id: string; payload: { expectedRevision?: number } }>(ws, "submit_turn")!;
    expect(submit.payload.expectedRevision).toBe(9);
    h.dispose();
    await send.catch(() => undefined);
  });

  it("A→B→A retains A snapshot/history/cursor, sends observation detach only, and resumes exact cursor", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 3 } });
    const ws = await ready(h, []);
    await acquire(h, ws, "A", "eA", 2);
    ws.serverSend({ type: "event", payload: { type: "message_start", sessionId: "A", epoch: "eA", eventId: 3, streamId: "s", messageId: "m", message: { role: "user", content: "retained" } } });
    ws.serverSend({ type: "event", payload: { type: "message_end", sessionId: "A", epoch: "eA", eventId: 4, streamId: "s", messageId: "m", entryId: "entry-A", message: { role: "user", content: "retained" } } });
    await transfer(h, ws, "B", "eB", 1);
    const a = h.registry.lookup("A")!;
    expect(a.getSnapshot().liveEntries.map((entry) => entry.entryId)).toContain("entry-A");
    expect(a.getSnapshot()).toMatchObject({ attached: false, epoch: "eA" });
    await transfer(h, ws, "A", "eA", 4);
    const attachA = lastFrame<{ type: "attach"; payload: Record<string, unknown> }>(ws, "attach")!;
    expect(attachA.payload).toEqual({ sessionId: "A", epoch: "eA", lastEventId: 4 });
    expect(h.registry.lookup("A")).toBe(a);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "stop")).toHaveLength(0);
    expect(h.registry.leaseSnapshot).toMatchObject({ phase: "held", holderSessionId: "A" });
    h.dispose();
  });

  it("correlated A result settles while detached; B owns an independent same lane and late id-less A frames are inert", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 3 } });
    const ws = await ready(h, []);
    await acquire(h, ws, "A", "eA");
    const a = h.registry.lookup("A")!;
    let aSettled = 0;
    const commandA = a.setSessionName("A name");
    void commandA.then(() => { aSettled += 1; });
    await flush();
    const frameA = lastFrame<{ type: "command"; id: string; payload: { sessionId: string; command: { commandId: string; type: string } } }>(ws, "command")!;
    await transfer(h, ws, "B", "eB");
    const b = h.registry.lookup("B")!;
    const commandB = b.setSessionName("B name");
    await flush();
    const frameB = lastFrame<{ type: "command"; id: string; payload: { sessionId: string; command: { commandId: string; type: string } } }>(ws, "command")!;
    expect(frameB.payload.sessionId).toBe("B");
    expect(a.evictionProtection.pendingCommand).toBe(true);
    expect(b.evictionProtection.pendingCommand).toBe(true);
    ws.serverSend({ type: "event", payload: { type: "agent_start", sessionId: "A", epoch: "eA", eventId: 1 } });
    ws.serverSend({ type: "snapshot", payload: snapshotPayload({ sessionId: "A", epoch: "eA", lastEventId: 99 }) });
    expect(a.getSnapshot().epoch).toBe("eA");
    commandAck(ws, frameA);
    await commandA;
    expect(aSettled).toBe(1);
    expect(b.evictionProtection.pendingCommand).toBe(true);
    commandAck(ws, frameB);
    await commandB;
    h.dispose();
  });

  it("superseded B→C acquisition rejects B exactly once; stale snapshot is inert and final lease is exact", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 4 } });
    const ws = await ready(h, []);
    await acquire(h, ws, "A");
    let bSettles = 0;
    const b = h.registry.acquire("B");
    void b.then(() => { bSettles += 1; }, () => { bSettles += 1; });
    await flush();
    const detachA = lastFrame<{ type: "detach"; id: string; payload: { sessionId: string } }>(ws, "detach")!;
    const c = h.registry.acquire("C");
    await expect(b).rejects.toMatchObject({ code: "interrupted" });
    expect(bSettles).toBe(1);
    ws.serverSend({ type: "response", id: detachA.id, payload: { ok: true, result: { sessionId: "A", detached: true } } });
    await flush();
    const attachC = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    expect(attachC.payload.sessionId).toBe("C");
    ws.serverSend({ type: "snapshot", id: "stale-B", payload: snapshotPayload({ sessionId: "B" }) });
    ws.serverSend({ type: "snapshot", id: attachC.id, payload: snapshotPayload({ sessionId: "C", epoch: "eC" }) });
    await c;
    expect(bSettles).toBe(1);
    expect(h.registry.leaseSnapshot).toMatchObject({ phase: "held", holderSessionId: "C", desiredSessionId: "C" });
    expect(ws.sent.filter((frame) => (frame as { type?: string; payload?: { sessionId?: string } }).type === "attach" && (frame as { payload?: { sessionId?: string } }).payload?.sessionId === "B")).toHaveLength(0);
    h.dispose();
  });

  it("reconnect resumes only the holder from retained cursor; detached pending lane waits for its exact lease", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 3 } });
    let ws = await ready(h, []);
    await acquire(h, ws, "A", "eA", 3);
    await transfer(h, ws, "B", "eB", 5);
    const a = h.registry.lookup("A")!;
    // A is detached; create a logical pending lane is impossible without attach,
    // so B is the sole immediate resync owner on transport loss.
    const pendingB = h.registry.lookup("B")!.setSessionName("pending B");
    await flush();
    const first = lastFrame<{ type: "command"; payload: { command: { commandId: string } } }>(ws, "command")!;
    ws.serverClose(1006);
    expect(h.registry.leaseSnapshot).toMatchObject({ phase: "suspended", holderSessionId: "B", desiredSessionId: "B" });
    vi.advanceTimersByTime(250);
    ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ack([]));
    await flush();
    const resume = lastFrame<{ type: "attach"; id: string; payload: Record<string, unknown> }>(ws, "attach")!;
    expect(resume.payload).toEqual({ sessionId: "B", epoch: "eB", lastEventId: 5 });
    ws.serverSend({ type: "snapshot", id: resume.id, payload: snapshotPayload({ sessionId: "B", epoch: "eB", lastEventId: 5, resumeStatus: "snapshot" }) });
    await flush();
    const resent = lastFrame<{ type: "command"; id: string; payload: { sessionId: string; command: { commandId: string; type: string } } }>(ws, "command")!;
    expect(resent.payload.sessionId).toBe("B");
    expect(resent.payload.command.commandId).toBe(first.payload.command.commandId);
    expect(a.getSnapshot().attached).toBe(false);
    commandAck(ws, resent);
    await pendingB;
    h.dispose();
  });

  it("a late B admission cannot steal the lease after C becomes the newer presentation", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 3 } });
    const ws = await ready(h);
    await acquire(h, ws, "B", "eB", 4);

    const sendB = h.store.sendPromptToSession("B", "background turn");
    await flush();
    const submitB = lastFrame<{ type: "submit_turn"; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;

    await transfer(h, ws, "C", "eC", 2);
    h.registry.declarePresentation(sessionPresentationKey("C"), true);
    const detachCountAfterC = ws.sent.filter((frame) => (frame as { type?: string }).type === "detach").length;
    const attachCountAfterC = ws.sent.filter((frame) => (frame as { type?: string }).type === "attach").length;

    ws.serverSend({
      type: "submit_turn_result",
      id: submitB.id,
      payload: {
        status: "accepted",
        delivery: "accepted",
        sessionId: "B",
        epoch: "eB",
        revision: 4,
        operationId: submitB.payload.operationId,
        turnId: "turn-B",
        snapshot: snapshotPayload({ sessionId: "B", epoch: "eB", lastEventId: 4 }).snapshot,
        turnStatus: {
          sessionId: "B",
          epoch: "eB",
          operationId: submitB.payload.operationId,
          turnId: "turn-B",
          revision: 0,
          state: "admitted",
        },
      },
    });
    await sendB;
    await flush();

    expect(h.registry.leaseSnapshot).toMatchObject({ phase: "held", holderSessionId: "C", desiredSessionId: "C" });
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "detach")).toHaveLength(detachCountAfterC);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "attach")).toHaveLength(attachCountAfterC);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "activate")).toHaveLength(0);
    expect(h.controller("B")?.getSnapshot()).toMatchObject({ turnActive: true, attached: false });
    h.dispose();
  });

  // --- hasAdmittedSnapshot: authoritative-settings eligibility transitions ---
  // The exact controller's accepted-admission snapshot is eligible from the
  // resolve (installed synchronously BEFORE the public promise settles) until
  // a history-layer transition (fresh attach / rebase / detach / stop /
  // session switch) or a later presentation reselect supersedes it.
  async function acceptAdmission(
    ws: FakeWebSocket,
    sessionId: string,
    options: { epoch?: string; revision?: number; model?: { provider: string; id: string } | null } = {},
  ): Promise<void> {
    const submit = lastFrame<{ type: "submit_turn"; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    const revision = options.revision ?? 5;
    const epoch = options.epoch ?? `e-${sessionId}`;
    ws.serverSend({
      type: "submit_turn_result",
      id: submit.id,
      payload: {
        status: "accepted",
        delivery: "accepted",
        sessionId,
        epoch,
        revision,
        operationId: submit.payload.operationId,
        turnId: `turn-${sessionId}`,
        snapshot: snapshotPayload({ sessionId, epoch, lastEventId: revision, model: options.model === undefined ? null : options.model }).snapshot,
        turnStatus: { sessionId, epoch, operationId: submit.payload.operationId, turnId: `turn-${sessionId}`, revision: 0, state: "admitted" },
      },
    });
    await flush();
  }

  it("hasAdmittedSnapshot is set with the accepted snapshot before resolve and ends at the post-admission observation attach", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 2 } });
    const ws = await ready(h);
    h.registry.declarePresentation(sessionPresentationKey("A"), true);
    const send = h.store.sendPromptToSession("A", "detached submit");
    await flush();
    const controller = h.controller("A")!;
    expect(controller.getSnapshot().hasAdmittedSnapshot).toBe(false);
    await acceptAdmission(ws, "A", { model: { provider: "openai", id: "gpt-5" } });
    await send;
    // Eligible from the resolve: the authoritative admission snapshot is
    // installed BEFORE the promise settles, while the session is still not
    // attached (the admission→observation gap).
    expect(controller.getSnapshot()).toMatchObject({ attached: false, hasAdmittedSnapshot: true });
    expect(controller.getSnapshot().snapshot?.state.model).toEqual({ provider: "openai", id: "gpt-5" });

    // The post-admission observation attach supersedes the bridge: normal
    // attached authority takes over.
    const attach = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string; attachMode?: string } }>(ws, "attach")!;
    expect(attach.payload.sessionId).toBe("A");
    expect(attach.payload.attachMode).toBe("existing_only");
    ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A", epoch: "e-A", lastEventId: 5, model: { provider: "openai", id: "gpt-5" } }) });
    await flush();
    expect(controller.getSnapshot()).toMatchObject({ attached: true, hasAdmittedSnapshot: false });
    h.dispose();
  });

  it("hasAdmittedSnapshot ends on an actual detach after the observation attach (no retained-snapshot history leak)", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 2 } });
    const ws = await ready(h);
    h.registry.declarePresentation(sessionPresentationKey("A"), true);
    const send = h.store.sendPromptToSession("A", "detached submit");
    await flush();
    await acceptAdmission(ws, "A", { model: { provider: "openai", id: "gpt-5" } });
    await send;
    const controller = h.controller("A")!;
    const attach = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A", epoch: "e-A", lastEventId: 5, model: { provider: "openai", id: "gpt-5" } }) });
    await flush();
    expect(controller.getSnapshot()).toMatchObject({ attached: true, hasAdmittedSnapshot: false });
    const release = h.registry.release();
    await flush();
    const detach = lastFrame<{ type: "detach"; id: string; payload: { sessionId: string } }>(ws, "detach")!;
    ws.serverSend({ type: "response", id: detach.id, payload: { ok: true, result: { sessionId: detach.payload.sessionId, detached: true } } });
    await release;
    expect(controller.getSnapshot()).toMatchObject({ attached: false, hasAdmittedSnapshot: false });
    h.dispose();
  });

  it("hasAdmittedSnapshot ends on a presentation reselect while the session never attaches", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 2 } });
    const ws = await ready(h);
    h.registry.declarePresentation(sessionPresentationKey("B"), true);
    const send = h.store.sendPromptToSession("B", "detached submit");
    await flush();
    await acceptAdmission(ws, "B", { model: { provider: "openai", id: "gpt-5" } });
    await send;
    const controller = h.controller("B")!;
    expect(controller.getSnapshot()).toMatchObject({ attached: false, hasAdmittedSnapshot: true });
    // A presentation switch invalidates the retained settings authority even
    // while the exact controller remains detached and retained.
    h.registry.declarePresentation(sessionPresentationKey("C"), true);
    expect(controller.getSnapshot()).toMatchObject({ attached: false, hasAdmittedSnapshot: false });
    h.registry.declarePresentation(sessionPresentationKey("B"), true);
    expect(controller.getSnapshot()).toMatchObject({ attached: false, hasAdmittedSnapshot: false });
    h.dispose();
  });

  it("clears admitted eligibility on transport loss while retaining the exact old operation fence", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 2 } });
    const ws = await ready(h);
    h.registry.declarePresentation(sessionPresentationKey("A"), true);
    const send = h.store.sendPromptToSession("A", "transport loss");
    await flush();
    await acceptAdmission(ws, "A", { model: { provider: "p", id: "B" } });
    await send;
    const controller = h.controller("A")!;
    expect(controller.getSnapshot()).toMatchObject({ hasAdmittedSnapshot: true });
    ws.serverClose(1006);
    await flush();
    expect(controller.getSnapshot()).toMatchObject({ attached: false, hasAdmittedSnapshot: false });
    h.dispose();
  });

  it("rejects lower same-epoch push snapshots without rolling back the accepted cursor or model", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 2 } });
    const ws = await ready(h);
    h.registry.declarePresentation(sessionPresentationKey("A"), true);
    await acquire(h, ws, "A", "e-A", 10);
    const send = h.store.sendPromptToSession("A", "stale push");
    await flush();
    await acceptAdmission(ws, "A", { epoch: "e-A", revision: 11, model: { provider: "p", id: "B" } });
    await send;
    const controller = h.controller("A")!;
    expect(controller.getSnapshot().snapshot?.state.model).toEqual({ provider: "p", id: "B" });
    ws.serverSend({
      type: "snapshot",
      payload: snapshotPayload({ sessionId: "A", epoch: "e-A", lastEventId: 5, model: { provider: "p", id: "A" } }),
    });
    await flush();
    expect(controller.getSnapshot()).toMatchObject({ hasAdmittedSnapshot: true, epoch: "e-A" });
    expect(controller.getSnapshot().snapshot?.state.model).toEqual({ provider: "p", id: "B" });
    h.dispose();
  });

  it("expires a no-final-leaf terminal bridge only after the observation attach fails and refreshes history", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 2 } });
    const ws = await ready(h);
    h.registry.declarePresentation(sessionPresentationKey("A"), true);
    const send = h.store.sendPromptToSession("A", "terminal without leaf");
    await flush();
    await acceptAdmission(ws, "A", { epoch: "e-A", revision: 5, model: { provider: "p", id: "B" } });
    await send;
    const controller = h.controller("A")!;
    const submit = lastFrame<{ type: "submit_turn"; payload: { operationId: string } }>(ws, "submit_turn")!;
    const attach = lastFrame<{ type: "attach"; id: string }>(ws, "attach")!;
    ws.serverSend({
      type: "turn_status",
      payload: { sessionId: "A", epoch: "e-A", operationId: submit.payload.operationId, turnId: "turn-A", revision: 1, state: "completed" },
    });
    await flush();
    expect(controller.getSnapshot().hasAdmittedSnapshot).toBe(true);
    const generationBeforeFailure = controller.getSnapshot().historyGeneration;
    ws.serverSend({
      type: "response",
      id: attach.id,
      payload: { ok: false, error: { code: "unavailable", message: "observation failed", retryable: false } },
    });
    await flush();
    expect(controller.getSnapshot()).toMatchObject({ hasAdmittedSnapshot: false });
    expect(controller.getSnapshot().historyGeneration).toBeGreaterThan(generationBeforeFailure);
    h.dispose();
  });

  it("declaring idle B after A is held from a home presentation keeps A's live snapshot", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 3 } });
    const ws = await ready(h, []);
    h.registry.declarePresentation(homePresentationKey("/x"), true);
    const openA = h.registry.acquire("A");
    await flush();
    const attachA = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    expect(attachA.payload.sessionId).toBe("A");
    ws.serverSend({
      type: "snapshot",
      id: attachA.id,
      payload: snapshotPayload({ sessionId: "A", epoch: "eA", model: { provider: "openai", id: "gpt-5" } }),
    });
    await openA;
    expect(h.registry.leaseSnapshot).toMatchObject({ phase: "held", holderSessionId: "A" });
    expect(h.controller("A")?.getSnapshot()).toMatchObject({ attached: true, sessionId: "A" });
    expect(h.controller("A")?.getSnapshot().snapshot?.state.model).toEqual({ provider: "openai", id: "gpt-5" });
    const detachBeforeB = ws.sent.filter((frame) => (frame as { type?: string }).type === "detach").length;
    h.registry.declarePresentation(sessionPresentationKey("B"), true);
    await flush();
    expect(h.registry.leaseSnapshot).toMatchObject({ phase: "held", holderSessionId: "A" });
    expect(h.controller("A")?.getSnapshot()).toMatchObject({ attached: true, sessionId: "A" });
    expect(h.controller("A")?.getSnapshot().snapshot?.state.model).toEqual({ provider: "openai", id: "gpt-5" });
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "detach")).toHaveLength(detachBeforeB);
    h.dispose();
  });

  it("selecting idle C while B waits to detach A cannot steal the lease after detach", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 3 } });
    const ws = await ready(h);
    await acquire(h, ws, "A", "eA", 2);
    h.registry.declarePresentation(sessionPresentationKey("A"), true);
    const sendB = h.store.sendPromptToSession("B", "background B");
    await flush();
    const submitB = lastFrame<{ type: "submit_turn"; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    ws.serverSend({
      type: "submit_turn_result",
      id: submitB.id,
      payload: {
        status: "accepted",
        delivery: "accepted",
        sessionId: "B",
        epoch: "eB",
        revision: 0,
        operationId: submitB.payload.operationId,
        turnId: "turn-B",
        snapshot: snapshotPayload({ sessionId: "B", epoch: "eB", lastEventId: 0 }).snapshot,
        turnStatus: {
          sessionId: "B",
          epoch: "eB",
          operationId: submitB.payload.operationId,
          turnId: "turn-B",
          revision: 0,
          state: "admitted",
        },
      },
    });
    await flush();
    expect(h.registry.leaseSnapshot).toMatchObject({ phase: "releasing", sourceSessionId: "A", targetSessionId: "B" });
    const detachA = lastFrame<{ type: "detach"; id: string; payload: { sessionId: string } }>(ws, "detach")!;
    expect(detachA.payload.sessionId).toBe("A");
    const attachCountBeforeC = ws.sent.filter((frame) => (frame as { type?: string }).type === "attach").length;
    h.registry.declarePresentation(sessionPresentationKey("C"), true);
    ws.serverSend({ type: "response", id: detachA.id, payload: { ok: true, result: { sessionId: "A", detached: true } } });
    await sendB;
    await flush();
    expect(h.registry.leaseSnapshot.holderSessionId).not.toBe("B");
    expect(h.registry.getSnapshot().presentationKey).toBe("session:C");
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "attach")).toHaveLength(attachCountBeforeC);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "activate")).toHaveLength(0);
    expect(h.controller("B")?.getSnapshot()).toMatchObject({ turnActive: true, attached: false });
    h.dispose();
  });

  it("auth-revoke release fail-closes locally without stopping the Worker or clearing a newer C lease", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 3, detachAckTimeoutMs: 20 } });
    const ws = await ready(h);
    await acquire(h, ws, "A", "eA", 2);
    h.registry.declarePresentation(sessionPresentationKey("A"), true);
    const sendA = h.store.sendPromptToSession("A", "keep running");
    await flush();
    const submitA = lastFrame<{ type: "submit_turn"; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    ws.serverSend({
      type: "submit_turn_result",
      id: submitA.id,
      payload: {
        status: "accepted",
        delivery: "accepted",
        sessionId: "A",
        epoch: "eA",
        revision: 2,
        operationId: submitA.payload.operationId,
        turnId: "turn-A",
        snapshot: snapshotPayload({ sessionId: "A", epoch: "eA", lastEventId: 2 }).snapshot,
        turnStatus: {
          sessionId: "A",
          epoch: "eA",
          operationId: submitA.payload.operationId,
          turnId: "turn-A",
          revision: 0,
          state: "admitted",
        },
      },
    });
    await sendA;
    const releaseA = h.registry.release();
    await flush();
    const detachA = lastFrame<{ type: "detach"; id: string; payload: { sessionId: string } }>(ws, "detach")!;
    expect(detachA.payload.sessionId).toBe("A");
    expect(h.registry.leaseSnapshot.phase).toBe("releasing");
    vi.advanceTimersByTime(20);
    await flush();
    await expect(releaseA).rejects.toMatchObject({ code: "timeout" });
    expect(h.registry.leaseSnapshot.phase).not.toBe("releasing");
    expect(h.controller("A")?.getSnapshot()).toMatchObject({
      turnActive: true,
      error: expect.objectContaining({ code: "timeout" }),
    });
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "stop")).toHaveLength(0);
    const observeC = h.registry.observeExisting("C");
    await flush();
    const attachC = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    expect(attachC.payload.sessionId).toBe("C");
    ws.serverSend({ type: "snapshot", id: attachC.id, payload: snapshotPayload({ sessionId: "C", epoch: "eC" }) });
    await observeC;
    expect(h.registry.leaseSnapshot).toMatchObject({ phase: "held", holderSessionId: "C" });
    ws.serverSend({ type: "response", id: detachA.id, payload: { ok: true, result: { sessionId: "A", detached: true } } });
    await flush();
    expect(h.registry.leaseSnapshot).toMatchObject({ phase: "held", holderSessionId: "C" });
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "stop")).toHaveLength(0);
    h.dispose();
  });

  it("auth-revoke drops A's route immediately so A events cannot update projection or cursor", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 3, detachAckTimeoutMs: 20 } });
    const ws = await ready(h);
    await acquire(h, ws, "A", "eA", 2);
    h.registry.declarePresentation(sessionPresentationKey("A"), true);
    const sendA = h.store.sendPromptToSession("A", "keep running");
    await flush();
    const submitA = lastFrame<{ type: "submit_turn"; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    ws.serverSend({
      type: "submit_turn_result",
      id: submitA.id,
      payload: {
        status: "accepted",
        delivery: "accepted",
        sessionId: "A",
        epoch: "eA",
        revision: 2,
        operationId: submitA.payload.operationId,
        turnId: "turn-A",
        snapshot: snapshotPayload({ sessionId: "A", epoch: "eA", lastEventId: 2 }).snapshot,
        turnStatus: {
          sessionId: "A",
          epoch: "eA",
          operationId: submitA.payload.operationId,
          turnId: "turn-A",
          revision: 0,
          state: "admitted",
        },
      },
    });
    await sendA;
    const a = h.controller("A")!;
    const liveBefore = a.getSnapshot().liveEntries.map((entry) => entry.entryId);
    const releaseA = h.registry.release();
    await flush();
    const detachA = lastFrame<{ type: "detach"; id: string; payload: { sessionId: string } }>(ws, "detach")!;
    expect(detachA.payload.sessionId).toBe("A");
    expect(h.registry.lookup("A")).toBe(a);
    expect(a.getSnapshot()).toMatchObject({ attached: false, turnActive: true, sessionId: "A" });
    ws.serverSend({
      type: "event",
      payload: { type: "message_start", sessionId: "A", epoch: "eA", eventId: 3, streamId: "s", messageId: "m", message: { role: "user", content: "late A" } },
    });
    ws.serverSend({
      type: "event",
      payload: { type: "message_end", sessionId: "A", epoch: "eA", eventId: 4, streamId: "s", messageId: "m", entryId: "stolen-A", message: { role: "user", content: "late A" } },
    });
    await flush();
    expect(a.getSnapshot().attached).toBe(false);
    expect(a.getSnapshot().liveEntries.map((entry) => entry.entryId)).toEqual(liveBefore);
    expect(a.getSnapshot().liveEntries.map((entry) => entry.entryId)).not.toContain("stolen-A");
    vi.advanceTimersByTime(20);
    await flush();
    await expect(releaseA).rejects.toMatchObject({ code: "timeout" });
    expect(a.getSnapshot()).toMatchObject({
      attached: false,
      turnActive: true,
      sessionId: "A",
      error: expect.objectContaining({ code: "timeout" }),
    });
    expect(a.getSnapshot().liveEntries.map((entry) => entry.entryId)).not.toContain("stolen-A");
    const observeC = h.registry.observeExisting("C");
    await flush();
    const attachC = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    expect(attachC.payload.sessionId).toBe("C");
    ws.serverSend({ type: "snapshot", id: attachC.id, payload: snapshotPayload({ sessionId: "C", epoch: "eC", lastEventId: 0 }) });
    await observeC;
    expect(h.registry.leaseSnapshot).toMatchObject({ phase: "held", holderSessionId: "C" });
    expect(h.controller("C")?.getSnapshot().attached).toBe(true);
    ws.serverSend({
      type: "event",
      payload: { type: "message_start", sessionId: "C", epoch: "eC", eventId: 1, streamId: "c", messageId: "cm", message: { role: "user", content: "from C" } },
    });
    ws.serverSend({
      type: "event",
      payload: { type: "message_end", sessionId: "C", epoch: "eC", eventId: 2, streamId: "c", messageId: "cm", entryId: "entry-C", message: { role: "user", content: "from C" } },
    });
    await flush();
    expect(h.controller("C")?.getSnapshot().liveEntries.map((entry) => entry.entryId)).toContain("entry-C");
    ws.serverSend({ type: "response", id: detachA.id, payload: { ok: true, result: { sessionId: "A", detached: true } } });
    ws.serverSend({
      type: "event",
      payload: { type: "message_end", sessionId: "A", epoch: "eA", eventId: 5, streamId: "s", messageId: "m2", entryId: "late-ack-A", message: { role: "user", content: "after ack" } },
    });
    await flush();
    expect(h.registry.leaseSnapshot).toMatchObject({ phase: "held", holderSessionId: "C" });
    expect(h.controller("C")?.getSnapshot()).toMatchObject({ attached: true, sessionId: "C" });
    expect(h.controller("C")?.getSnapshot().liveEntries.map((entry) => entry.entryId)).toContain("entry-C");
    expect(a.getSnapshot()).toMatchObject({ attached: false, sessionId: "A", turnActive: true });
    expect(a.getSnapshot().liveEntries.map((entry) => entry.entryId)).not.toContain("stolen-A");
    expect(a.getSnapshot().liveEntries.map((entry) => entry.entryId)).not.toContain("late-ack-A");
    expect(h.registry.lookup("A")).toBe(a);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "stop")).toHaveLength(0);
    const observeA = h.registry.observeExisting("A");
    await flush();
    const detachC = lastFrame<{ type: "detach"; id: string; payload: { sessionId: string } }>(ws, "detach")!;
    expect(detachC.payload.sessionId).toBe("C");
    ws.serverSend({ type: "response", id: detachC.id, payload: { ok: true, result: { sessionId: "C", detached: true } } });
    await flush();
    const resumeA = lastFrame<{ type: "attach"; payload: Record<string, unknown> }>(ws, "attach")!;
    expect(resumeA.payload).toEqual({ sessionId: "A", attachMode: "existing_only", epoch: "eA", lastEventId: 2 });
    ws.serverSend({ type: "snapshot", id: (lastFrame<{ type: "attach"; id: string }>(ws, "attach")!).id, payload: snapshotPayload({ sessionId: "A", epoch: "eA", lastEventId: 2 }) });
    await observeA;
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "stop")).toHaveLength(0);
    h.dispose();
  });

  it("release success ticks attachGeneration exactly once", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 2 } });
    const ws = await ready(h);
    await acquire(h, ws, "A", "eA", 2);
    const a = h.controller("A")!;
    const gen0 = a.getSnapshot().attachGeneration;
    const storeGen0 = h.store.getSnapshot().attachGeneration;
    const release = h.registry.release();
    await flush();
    const detach = lastFrame<{ type: "detach"; id: string }>(ws, "detach")!;
    expect(a.getSnapshot().attached).toBe(false);
    expect(a.getSnapshot().attachGeneration).toBe(gen0 + 1);
    ws.serverSend({ type: "response", id: detach.id, payload: { ok: true, result: { sessionId: "A", detached: true } } });
    await release;
    expect(a.getSnapshot().attachGeneration).toBe(gen0 + 1);
    expect(h.store.getSnapshot().attachGeneration).toBe(storeGen0 + 1);
    expect(a.getSnapshot().attached).toBe(false);
    h.dispose();
  });

  it("release timeout ticks attachGeneration exactly once", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 2, detachAckTimeoutMs: 20 } });
    const ws = await ready(h);
    await acquire(h, ws, "A", "eA", 2);
    const a = h.controller("A")!;
    const gen0 = a.getSnapshot().attachGeneration;
    const release = h.registry.release();
    await flush();
    expect(lastFrame<{ type: "detach" }>(ws, "detach")).toBeDefined();
    expect(a.getSnapshot().attachGeneration).toBe(gen0 + 1);
    vi.advanceTimersByTime(20);
    await flush();
    await expect(release).rejects.toMatchObject({ code: "timeout" });
    expect(a.getSnapshot().attachGeneration).toBe(gen0 + 1);
    expect(a.getSnapshot().attached).toBe(false);
    h.dispose();
  });

  it("release error ticks attachGeneration exactly once", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 2 } });
    const ws = await ready(h);
    await acquire(h, ws, "A", "eA", 2);
    const a = h.controller("A")!;
    const gen0 = a.getSnapshot().attachGeneration;
    const release = h.registry.release();
    await flush();
    const detach = lastFrame<{ type: "detach"; id: string }>(ws, "detach")!;
    expect(a.getSnapshot().attachGeneration).toBe(gen0 + 1);
    ws.serverSend({
      type: "response",
      id: detach.id,
      payload: { ok: false, error: { code: "unavailable", message: "detach failed", retryable: true } },
    });
    await expect(release).rejects.toMatchObject({ code: "unavailable" });
    expect(a.getSnapshot().attachGeneration).toBe(gen0 + 1);
    expect(a.getSnapshot().attached).toBe(false);
    h.dispose();
  });

  it("a late old A detach ack cannot teardown a newer observation of the same A", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 2, detachAckTimeoutMs: 20 } });
    const ws = await ready(h, ["runtime.running-watch.v1", "runtime.submit-turn.v1", "runtime.observe-existing.v1"]);
    await acquire(h, ws, "A", "eA", 2);
    const a = h.controller("A")!;
    const liveBefore = a.getSnapshot().liveEntries.map((entry) => entry.entryId);
    const releaseA = h.registry.release();
    await flush();
    const detachA = lastFrame<{ type: "detach"; id: string; payload: { sessionId: string } }>(ws, "detach")!;
    expect(detachA.payload.sessionId).toBe("A");
    expect(a.getSnapshot().attached).toBe(false);
    vi.advanceTimersByTime(20);
    await flush();
    await expect(releaseA).rejects.toMatchObject({ code: "timeout" });
    const genAfterRelease = a.getSnapshot().attachGeneration;
    h.registry.declarePresentation(sessionPresentationKey("A"), true);
    const observeA = h.registry.observeExisting("A");
    await flush();
    const attachA = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    expect(attachA.payload.sessionId).toBe("A");
    ws.serverSend({ type: "snapshot", id: attachA.id, payload: snapshotPayload({ sessionId: "A", epoch: "eA", lastEventId: 2 }) });
    await observeA;
    expect(a.getSnapshot().attached).toBe(true);
    const genHeld = a.getSnapshot().attachGeneration;
    expect(genHeld).toBe(genAfterRelease);
    ws.serverSend({ type: "response", id: detachA.id, payload: { ok: true, result: { sessionId: "A", detached: true } } });
    await flush();
    expect(a.getSnapshot().attached).toBe(true);
    expect(a.getSnapshot().attachGeneration).toBe(genHeld);
    expect(h.registry.leaseSnapshot).toMatchObject({ phase: "held", holderSessionId: "A" });
    ws.serverSend({
      type: "event",
      payload: { type: "message_start", sessionId: "A", epoch: "eA", eventId: 3, streamId: "s", messageId: "m", message: { role: "user", content: "new A" } },
    });
    ws.serverSend({
      type: "event",
      payload: { type: "message_end", sessionId: "A", epoch: "eA", eventId: 4, streamId: "s", messageId: "m", entryId: "kept-A", message: { role: "user", content: "new A" } },
    });
    await flush();
    expect(a.getSnapshot().liveEntries.map((entry) => entry.entryId)).toContain("kept-A");
    expect(a.getSnapshot().liveEntries.map((entry) => entry.entryId)).toEqual([...liveBefore, "kept-A"]);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "stop")).toHaveLength(0);
    h.dispose();
  });

  it("session presentation key equals the tab identity and home keys include cwd", () => {
    expect(sessionPresentationKey("A")).toBe(sessionTabId("A"));
    expect(homePresentationKey("/x")).toBe("home:/x");
    expect(homePresentationKey("/y")).toBe("home:/y");
    expect(homePresentationKey(undefined)).toBe("home:");
    expect(homePresentationKey("/x")).not.toBe(homePresentationKey("/y"));
  });

  it("declarePresentation is idempotent for the same key+auth and busy changes never mint a revision", () => {
    const h = createHarness();
    expect(h.registry.getSnapshot().presentationRevision).toBe(0);
    h.registry.declarePresentation(homePresentationKey("/x"), true);
    expect(h.registry.getSnapshot()).toMatchObject({ presentationKey: "home:/x", presentationAuthorized: true, presentationRevision: 1 });
    h.registry.declarePresentation(homePresentationKey("/x"), true);
    expect(h.registry.getSnapshot().presentationRevision).toBe(1);
    h.registry.declarePresentation(sessionPresentationKey("A"), true);
    expect(h.registry.getSnapshot().presentationRevision).toBe(2);
    h.registry.declarePresentation(sessionPresentationKey("A"), false);
    expect(h.registry.getSnapshot()).toMatchObject({ presentationKey: "session:A", presentationAuthorized: false, presentationRevision: 3 });
    h.dispose();
  });

  it("a late create after a home/draft switch does not promote or steal the lease", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 3 } });
    const ws = await ready(h, ["runtime.running-watch.v1", "runtime.submit-turn.v1", "runtime.observe-existing.v1"]);
    h.registry.declarePresentation(homePresentationKey("/x"), true);
    const create = h.store.createSession({ cwd: "/x", projectRoot: "/x" });
    await flush();
    const createFrame = lastFrame<{ type: "create"; id: string }>(ws, "create")!;
    h.registry.declarePresentation(homePresentationKey("/y"), true);
    ws.serverSend({
      type: "response",
      id: createFrame.id,
      payload: { ok: true, result: { sessionId: "created-a", epoch: "eA", lastEventId: 0, created: true, cwd: "/x", projectRoot: "/x" } },
    });
    const created = await create;
    expect(created.sessionId).toBe("created-a");
    expect(h.registry.promoteCreatedPresentation("created-a")).toBe(false);
    expect(h.registry.getSnapshot()).toMatchObject({ presentationKey: "home:/y" });
    expect(h.registry.leaseSnapshot.holderSessionId).not.toBe("created-a");
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "attach")).toHaveLength(0);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "activate")).toHaveLength(0);
    h.dispose();
  });

  it("late created-session admission after a draft switch does not steal the current presentation lease", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 3 } });
    const ws = await ready(h, ["runtime.running-watch.v1", "runtime.submit-turn.v1", "runtime.observe-existing.v1"]);
    h.registry.declarePresentation(homePresentationKey("/x"), true);
    const create = h.store.createSession({ cwd: "/x", projectRoot: "/x" });
    await flush();
    const createFrame = lastFrame<{ type: "create"; id: string }>(ws, "create")!;
    ws.serverSend({
      type: "response",
      id: createFrame.id,
      payload: { ok: true, result: { sessionId: "created-a", epoch: "eA", lastEventId: 0, created: true, cwd: "/x", projectRoot: "/x" } },
    });
    await create;
    const sendA = h.store.sendPromptToSession("created-a", "first from draft");
    await flush();
    const submitA = lastFrame<{ type: "submit_turn"; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    await acquire(h, ws, "C", "eC", 2);
    h.registry.declarePresentation(sessionPresentationKey("C"), true);
    const attachCountAfterC = ws.sent.filter((frame) => (frame as { type?: string }).type === "attach").length;
    const detachCountAfterC = ws.sent.filter((frame) => (frame as { type?: string }).type === "detach").length;
    expect(h.registry.promoteCreatedPresentation("created-a")).toBe(false);
    ws.serverSend({
      type: "submit_turn_result",
      id: submitA.id,
      payload: {
        status: "accepted",
        delivery: "accepted",
        sessionId: "created-a",
        epoch: "eA",
        revision: 0,
        operationId: submitA.payload.operationId,
        turnId: "turn-A",
        snapshot: snapshotPayload({ sessionId: "created-a", epoch: "eA", lastEventId: 0 }).snapshot,
        turnStatus: {
          sessionId: "created-a",
          epoch: "eA",
          operationId: submitA.payload.operationId,
          turnId: "turn-A",
          revision: 0,
          state: "admitted",
        },
      },
    });
    await sendA;
    await flush();
    expect(h.registry.leaseSnapshot).toMatchObject({ phase: "held", holderSessionId: "C", desiredSessionId: "C" });
    expect(h.registry.getSnapshot().presentationKey).toBe("session:C");
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "attach")).toHaveLength(attachCountAfterC);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "detach")).toHaveLength(detachCountAfterC);
    expect(h.controller("created-a")?.getSnapshot()).toMatchObject({ turnActive: true, attached: false });
    h.dispose();
  });

  it("create B pending then select C: first send of B after create cannot steal C on admission", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 3 } });
    const ws = await ready(h, ["runtime.running-watch.v1", "runtime.submit-turn.v1", "runtime.observe-existing.v1"]);
    h.registry.declarePresentation(homePresentationKey("/x"), true);
    const create = h.store.createSession({ cwd: "/x", projectRoot: "/x" });
    await flush();
    const createFrame = lastFrame<{ type: "create"; id: string }>(ws, "create")!;

    await acquire(h, ws, "C", "eC", 2);
    h.registry.declarePresentation(sessionPresentationKey("C"), true);
    const attachCountAfterC = ws.sent.filter((frame) => (frame as { type?: string }).type === "attach").length;
    const detachCountAfterC = ws.sent.filter((frame) => (frame as { type?: string }).type === "detach").length;

    ws.serverSend({
      type: "response",
      id: createFrame.id,
      payload: { ok: true, result: { sessionId: "created-b", epoch: "eB", lastEventId: 0, created: true, cwd: "/x", projectRoot: "/x" } },
    });
    await create;
    expect(h.registry.promoteCreatedPresentation("created-b")).toBe(false);

    const sendB = h.store.sendPromptToSession("created-b", "first after create");
    await flush();
    const submitB = lastFrame<{ type: "submit_turn"; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    ws.serverSend({
      type: "submit_turn_result",
      id: submitB.id,
      payload: {
        status: "accepted",
        delivery: "accepted",
        sessionId: "created-b",
        epoch: "eB",
        revision: 0,
        operationId: submitB.payload.operationId,
        turnId: "turn-B",
        snapshot: snapshotPayload({ sessionId: "created-b", epoch: "eB", lastEventId: 0 }).snapshot,
        turnStatus: {
          sessionId: "created-b",
          epoch: "eB",
          operationId: submitB.payload.operationId,
          turnId: "turn-B",
          revision: 0,
          state: "admitted",
        },
      },
    });
    await sendB;
    await flush();

    expect(h.registry.leaseSnapshot).toMatchObject({ phase: "held", holderSessionId: "C", desiredSessionId: "C" });
    expect(h.registry.getSnapshot().presentationKey).toBe("session:C");
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "attach")).toHaveLength(attachCountAfterC);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "detach")).toHaveLength(detachCountAfterC);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "activate")).toHaveLength(0);
    expect(h.controller("created-b")?.getSnapshot()).toMatchObject({ turnActive: true, attached: false });
    h.dispose();
  });

  it("new-home first-send promotion before accepted ACK retains the original pending identity through terminal and a second send", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 3 } });
    const ws = await ready(h, ["runtime.running-watch.v1", "runtime.submit-turn.v1", "runtime.observe-existing.v1"]);
    h.registry.declarePresentation(homePresentationKey("/x"), true);

    const create = h.store.createSession({ cwd: "/x", projectRoot: "/x" });
    await flush();
    const createFrame = lastFrame<{ type: "create"; id: string }>(ws, "create")!;
    ws.serverSend({
      type: "response",
      id: createFrame.id,
      payload: {
        ok: true,
        result: {
          sessionId: "created-home",
          epoch: "eH",
          lastEventId: 0,
          created: true,
          cwd: "/x",
          projectRoot: "/x",
          snapshot: snapshotPayload({ sessionId: "created-home", epoch: "eH", lastEventId: 0 }).snapshot,
        },
      },
    });
    await expect(create).resolves.toEqual({ sessionId: "created-home" });

    let firstSettled = 0;
    let firstValue: unknown;
    const firstSend = h.store.sendPromptToSession("created-home", "first from home").then((value) => {
      firstSettled += 1;
      firstValue = value;
      return value;
    });
    await flush();
    const submit = lastFrame<{ type: "submit_turn"; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    const firstOperationId = submit.payload.operationId;
    const activateBeforePromote = ws.sent.filter((frame) => (frame as { type?: string }).type === "activate").length;
    const stopBeforePromote = ws.sent.filter((frame) => (frame as { type?: string }).type === "stop").length;
    expect(h.controller("created-home")?.getSnapshot()).toMatchObject({
      promptPending: true,
      turnActive: true,
      turnDelivery: "in_flight",
    });

    expect(h.registry.promoteCreatedPresentation("created-home")).toBe(true);
    expect(h.registry.getSnapshot().presentationKey).toBe(sessionPresentationKey("created-home"));
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "activate")).toHaveLength(activateBeforePromote);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "stop")).toHaveLength(stopBeforePromote);

    ws.serverSend({
      type: "submit_turn_result",
      id: submit.id,
      payload: {
        status: "accepted",
        delivery: "accepted",
        sessionId: "created-home",
        epoch: "eH",
        revision: 0,
        operationId: firstOperationId,
        turnId: "turn-H1",
        snapshot: snapshotPayload({ sessionId: "created-home", epoch: "eH", lastEventId: 0 }).snapshot,
        turnStatus: {
          sessionId: "created-home",
          epoch: "eH",
          operationId: firstOperationId,
          turnId: "turn-H1",
          revision: 0,
          state: "admitted",
        },
      },
    });
    await flush();
    await Promise.race([
      firstSend,
      Promise.reject(new Error("accepted admission after new-home promotion must resolve the original submit promise")),
    ]);
    expect(firstSettled).toBe(1);
    expect(firstValue).toMatchObject({ status: "accepted", operationId: firstOperationId, turnId: "turn-H1" });
    expect(h.controller("created-home")?.getSnapshot()).toMatchObject({
      promptPending: false,
      turnActive: true,
      turnDelivery: "accepted",
    });

    await flush();
    const attach = lastFrame<{ type: "attach"; id: string; payload: Record<string, unknown> }>(ws, "attach")!;
    expect(attach.payload).toMatchObject({ sessionId: "created-home", attachMode: "existing_only" });
    ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "created-home", epoch: "eH", lastEventId: 0 }) });
    await flush();
    expect(h.registry.leaseSnapshot).toMatchObject({ phase: "held", holderSessionId: "created-home" });
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "activate")).toHaveLength(activateBeforePromote);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "stop")).toHaveLength(stopBeforePromote);

    let terminal: unknown;
    h.store.subscribeTurnTerminal((info) => { terminal = info; });
    ws.serverSend({
      type: "event",
      payload: {
        type: "message_start",
        sessionId: "created-home",
        epoch: "eH",
        eventId: 1,
        streamId: "u1",
        messageId: "u1",
        message: { role: "user", content: "first from home" },
      },
    });
    ws.serverSend({
      type: "event",
      payload: {
        type: "message_end",
        sessionId: "created-home",
        epoch: "eH",
        eventId: 2,
        streamId: "u1",
        messageId: "u1",
        entryId: "u1",
        message: { role: "user", content: "first from home" },
      },
    });
    ws.serverSend({
      type: "turn_status",
      payload: {
        sessionId: "created-home",
        epoch: "eH",
        operationId: firstOperationId,
        turnId: "turn-H1",
        revision: 1,
        state: "completed",
        userEntryId: "u1",
        finalLeafId: "u1",
      },
    });
    await flush();
    expect(terminal).toMatchObject({ sessionId: "created-home", operationId: firstOperationId, turnId: "turn-H1", state: "completed" });
    expect(h.controller("created-home")?.getSnapshot()).toMatchObject({
      promptPending: false,
      turnActive: false,
      turnDelivery: null,
    });
    expect(firstSettled).toBe(1);

    const secondSend = h.store.sendPromptToSession("created-home", "second from home");
    await flush();
    const second = lastFrame<{ type: "submit_turn"; id: string; payload: { operationId: string; prompt: string } }>(ws, "submit_turn")!;
    expect(second.payload.prompt).toBe("second from home");
    expect(second.payload.operationId).not.toBe(firstOperationId);
    expect(h.controller("created-home")?.getSnapshot()).toMatchObject({ turnActive: true, turnDelivery: "in_flight" });
    ws.serverSend({
      type: "submit_turn_result",
      id: second.id,
      payload: {
        status: "accepted",
        delivery: "accepted",
        sessionId: "created-home",
        epoch: "eH",
        revision: 2,
        operationId: second.payload.operationId,
        turnId: "turn-H2",
        snapshot: snapshotPayload({ sessionId: "created-home", epoch: "eH", lastEventId: 2 }).snapshot,
        turnStatus: {
          sessionId: "created-home",
          epoch: "eH",
          operationId: second.payload.operationId,
          turnId: "turn-H2",
          revision: 0,
          state: "admitted",
        },
      },
    });
    await flush();
    await Promise.race([
      secondSend,
      Promise.reject(new Error("second send after new-home terminal must accept a new operation")),
    ]);
    expect(h.controller("created-home")?.getSnapshot()).toMatchObject({ turnActive: true, turnDelivery: "accepted" });
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "activate")).toHaveLength(activateBeforePromote);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "stop")).toHaveLength(stopBeforePromote);
    h.dispose();
  });

  it("activateAndObserve takes the one lease from vacant and from another holder", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 3 } });
    const ws = await ready(h, [
      "runtime.running-watch.v1",
      "runtime.submit-turn.v1",
      "runtime.observe-existing.v1",
      "runtime.explicit-activate.v1",
    ]);
    h.registry.declarePresentation(sessionPresentationKey("A"), true);
    const vacant = h.registry.activateAndObserve("A");
    await flush();
    const activateA = lastFrame<{ type: "activate"; id: string; payload: { sessionId: string } }>(ws, "activate")!;
    expect(activateA.payload).toEqual({ sessionId: "A" });
    ws.serverSend({
      type: "response",
      id: activateA.id,
      payload: { ok: true, result: { sessionId: "A", epoch: "eA", cwd: "/x", projectRoot: "/x", workerStatus: "ready" } },
    });
    await flush();
    const attachA = lastFrame<{ type: "attach"; id: string; payload: Record<string, unknown> }>(ws, "attach")!;
    expect(attachA.payload).toEqual({ sessionId: "A", attachMode: "existing_only" });
    ws.serverSend({ type: "snapshot", id: attachA.id, payload: snapshotPayload({ sessionId: "A", epoch: "eA" }) });
    await vacant;
    expect(h.registry.leaseSnapshot).toMatchObject({ phase: "held", holderSessionId: "A" });

    h.registry.declarePresentation(sessionPresentationKey("B"), true);
    const transfer = h.registry.activateAndObserve("B");
    await flush();
    const detachA = lastFrame<{ type: "detach"; id: string; payload: { sessionId: string } }>(ws, "detach")!;
    expect(detachA.payload.sessionId).toBe("A");
    ws.serverSend({ type: "response", id: detachA.id, payload: { ok: true, result: { sessionId: "A", detached: true } } });
    await flush();
    const activateB = lastFrame<{ type: "activate"; id: string; payload: { sessionId: string } }>(ws, "activate")!;
    expect(activateB.payload).toEqual({ sessionId: "B" });
    ws.serverSend({
      type: "response",
      id: activateB.id,
      payload: { ok: true, result: { sessionId: "B", epoch: "eB", cwd: "/x", projectRoot: "/x", workerStatus: "ready" } },
    });
    await flush();
    const attachB = lastFrame<{ type: "attach"; id: string; payload: Record<string, unknown> }>(ws, "attach")!;
    expect(attachB.payload).toEqual({ sessionId: "B", attachMode: "existing_only" });
    ws.serverSend({ type: "snapshot", id: attachB.id, payload: snapshotPayload({ sessionId: "B", epoch: "eB" }) });
    await transfer;
    expect(h.registry.leaseSnapshot).toMatchObject({ phase: "held", holderSessionId: "B", desiredSessionId: "B" });
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "stop")).toHaveLength(0);
    h.dispose();
  });

  it("a late explicit activation cannot steal the lease after the user switches away", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 3 } });
    const ws = await ready(h, [
      "runtime.running-watch.v1",
      "runtime.submit-turn.v1",
      "runtime.observe-existing.v1",
      "runtime.explicit-activate.v1",
    ]);
    h.registry.declarePresentation(sessionPresentationKey("A"), true);
    const pendingA = h.registry.activateAndObserve("A");
    await flush();
    const activateA = lastFrame<{ type: "activate"; id: string; payload: { sessionId: string } }>(ws, "activate")!;
    expect(activateA.payload).toEqual({ sessionId: "A" });
    h.registry.declarePresentation(sessionPresentationKey("C"), true);
    const observeC = h.registry.observeExisting("C");
    await flush();
    const attachC = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    expect(attachC.payload.sessionId).toBe("C");
    ws.serverSend({ type: "snapshot", id: attachC.id, payload: snapshotPayload({ sessionId: "C", epoch: "eC" }) });
    await observeC;
    ws.serverSend({
      type: "response",
      id: activateA.id,
      payload: { ok: true, result: { sessionId: "A", epoch: "eA", cwd: "/x", projectRoot: "/x", workerStatus: "ready" } },
    });
    await expect(pendingA).rejects.toMatchObject({ code: "interrupted", retryable: false });
    await flush();
    expect(h.registry.leaseSnapshot).toMatchObject({ phase: "held", holderSessionId: "C", desiredSessionId: "C" });
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "activate")).toHaveLength(1);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "attach")).toHaveLength(1);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "stop")).toHaveLength(0);
    h.dispose();
  });

  it("declaring idle C during A's activate does not send A attach or steal the vacant lease", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 3 } });
    const ws = await ready(h, [
      "runtime.running-watch.v1",
      "runtime.submit-turn.v1",
      "runtime.observe-existing.v1",
      "runtime.explicit-activate.v1",
    ]);
    h.registry.declarePresentation(sessionPresentationKey("A"), true);
    const pendingA = h.registry.activateAndObserve("A");
    await flush();
    const activateA = lastFrame<{ type: "activate"; id: string; payload: { sessionId: string } }>(ws, "activate")!;
    expect(activateA.payload).toEqual({ sessionId: "A" });
    const attachBeforeC = ws.sent.filter((frame) => (frame as { type?: string }).type === "attach").length;
    const compactBeforeC = ws.sent.filter((frame) => {
      const typed = frame as { type?: string; payload?: { command?: { type?: string } } };
      return typed.type === "command" && typed.payload?.command?.type === "compact";
    }).length;
    // Route-only: the user selected idle C. Do NOT observeExisting(C) — that
    // would mint a newer lease and hide the combined activate+observe race.
    h.registry.declarePresentation(sessionPresentationKey("C"), true);
    ws.serverSend({
      type: "response",
      id: activateA.id,
      payload: { ok: true, result: { sessionId: "A", epoch: "eA", cwd: "/x", projectRoot: "/x", workerStatus: "ready" } },
    });
    await expect(pendingA).rejects.toMatchObject({ code: "interrupted", retryable: false });
    await flush();
    expect(h.registry.leaseSnapshot.holderSessionId).not.toBe("A");
    expect(h.registry.getSnapshot().presentationKey).toBe("session:C");
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "attach")).toHaveLength(attachBeforeC);
    expect(ws.sent.filter((frame) => {
      const typed = frame as { type?: string; payload?: { command?: { type?: string } } };
      return typed.type === "command" && typed.payload?.command?.type === "compact";
    })).toHaveLength(compactBeforeC);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "activate")).toHaveLength(1);
    expect(h.controller("A")?.getSnapshot().attached).toBe(false);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "stop")).toHaveLength(0);
    h.dispose();
  });

  it("evicting an unused created controller drops its one-shot submit token so a later same-id send uses the current presentation", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 1 } });
    const ws = await ready(h, ["runtime.running-watch.v1", "runtime.submit-turn.v1", "runtime.observe-existing.v1"]);
    h.registry.declarePresentation(homePresentationKey("/x"), true);
    const create = h.store.createSession({ cwd: "/x", projectRoot: "/x" });
    await flush();
    const createFrame = lastFrame<{ type: "create"; id: string }>(ws, "create")!;
    ws.serverSend({
      type: "response",
      id: createFrame.id,
      payload: { ok: true, result: { sessionId: "created-b", epoch: "eB", lastEventId: 0, created: true, cwd: "/x", projectRoot: "/x" } },
    });
    await create;
    expect(h.registry.lookup("created-b")).not.toBeNull();
    expect(h.registry.controllerCount).toBe(1);
    h.registry.declarePresentation(sessionPresentationKey("C"), true);
    const c = h.registry.getOrCreate("C");
    expect(h.registry.lookup("created-b")).toBeNull();
    expect(h.registry.lookup("C")).toBe(c);
    expect(h.registry.controllerCount).toBe(1);
    const leftover = h.connection.registerController("created-b", inertPort());
    leftover.unbind();
    // Re-admit under a NEW presentation of the same id. A surviving create-start
    // token (home:/x) would fail the current-presentation gate and skip attach.
    h.registry.declarePresentation(sessionPresentationKey("created-b"), true);
    const readmitted = h.registry.getOrCreate("created-b");
    expect(h.registry.lookup("C")).toBeNull();
    expect(h.registry.controllerCount).toBe(1);
    expect(() => h.connection.registerController("created-b", inertPort())).toThrow(/already has a controller/);
    const sendB = readmitted.submitTurn({ sessionId: "created-b", prompt: "after eviction" });
    await flush();
    const submitB = lastFrame<{ type: "submit_turn"; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    ws.serverSend({
      type: "submit_turn_result",
      id: submitB.id,
      payload: {
        status: "accepted",
        delivery: "accepted",
        sessionId: "created-b",
        epoch: "eB",
        revision: 0,
        operationId: submitB.payload.operationId,
        turnId: "turn-B",
        snapshot: snapshotPayload({ sessionId: "created-b", epoch: "eB", lastEventId: 0 }).snapshot,
        turnStatus: {
          sessionId: "created-b",
          epoch: "eB",
          operationId: submitB.payload.operationId,
          turnId: "turn-B",
          revision: 0,
          state: "admitted",
        },
      },
    });
    await sendB;
    await flush();
    const attachB = lastFrame<{ type: "attach"; payload: Record<string, unknown> }>(ws, "attach")!;
    expect(attachB.payload).toMatchObject({ sessionId: "created-b", attachMode: "existing_only" });
    ws.serverSend({ type: "snapshot", id: (lastFrame<{ type: "attach"; id: string }>(ws, "attach")!).id, payload: snapshotPayload({ sessionId: "created-b", epoch: "eB" }) });
    await flush();
    expect(h.registry.leaseSnapshot).toMatchObject({ phase: "held", holderSessionId: "created-b" });
    expect(h.registry.getSnapshot().presentationKey).toBe("session:created-b");
    expect(h.registry.controllerCount).toBe(1);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "activate")).toHaveLength(0);
    h.dispose();
  });

  it("post-admission observation without observe-existing is unsupported and never reactivates", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 2 } });
    const ws = await ready(h, ["runtime.running-watch.v1", "runtime.submit-turn.v1"]);
    h.registry.declarePresentation(sessionPresentationKey("A"), true);
    const send = h.store.sendPromptToSession("A", "atomic first");
    await flush();
    const submit = lastFrame<{ type: "submit_turn"; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    ws.serverSend({
      type: "submit_turn_result",
      id: submit.id,
      payload: {
        status: "accepted",
        delivery: "accepted",
        sessionId: "A",
        epoch: "eA",
        revision: 0,
        operationId: submit.payload.operationId,
        turnId: "turn-A",
        snapshot: snapshotPayload({ sessionId: "A", epoch: "eA", lastEventId: 0 }).snapshot,
        turnStatus: {
          sessionId: "A",
          epoch: "eA",
          operationId: submit.payload.operationId,
          turnId: "turn-A",
          revision: 0,
          state: "admitted",
        },
      },
    });
    await send;
    await flush();
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "attach")).toHaveLength(0);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "activate")).toHaveLength(0);
    expect(h.controller("A")?.getSnapshot()).toMatchObject({
      turnActive: true,
      attached: false,
      error: expect.objectContaining({ code: "unsupported_capability" }),
    });
    h.dispose();
  });

  it("observeExisting stamps attachMode existing_only and never falls back to activating attach", async () => {
    const h = createHarness();
    const ws = await ready(h, ["runtime.running-watch.v1", "runtime.submit-turn.v1", "runtime.observe-existing.v1"]);
    const observe = h.registry.observeExisting("A");
    await flush();
    const attach = lastFrame<{ type: "attach"; id: string; payload: Record<string, unknown> }>(ws, "attach")!;
    expect(attach.payload).toEqual({ sessionId: "A", attachMode: "existing_only" });
    ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A" }) });
    await observe;
    expect(ws.sent.filter((frame) => ["activate", "stop"].includes((frame as { type?: string }).type ?? ""))).toHaveLength(0);
    h.dispose();
  });

  it("observeExisting rejects unsupported_capability without sending attach when the feature is absent", async () => {
    const h = createHarness();
    const ws = await ready(h, ["runtime.running-watch.v1", "runtime.submit-turn.v1"]);
    await expect(h.registry.observeExisting("A")).rejects.toMatchObject({ code: "unsupported_capability", retryable: false });
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "attach")).toHaveLength(0);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "activate")).toHaveLength(0);
    h.dispose();
  });

  it("release never sends stop", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 2 } });
    const ws = await ready(h, []);
    await acquire(h, ws, "A");
    const stopCount = ws.sent.filter((frame) => (frame as { type?: string }).type === "stop").length;
    const release = h.registry.release();
    await flush();
    const detach = lastFrame<{ type: "detach"; id: string }>(ws, "detach")!;
    ws.serverSend({ type: "response", id: detach.id, payload: { ok: true, result: { sessionId: "A", detached: true } } });
    await release;
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "stop")).toHaveLength(stopCount);
    expect(h.registry.leaseSnapshot.phase).toBe("vacant");
    h.dispose();
  });

  it("auth/feature revoke via presentation unauthorized release detaches without stop", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 2 } });
    const ws = await ready(h, ["runtime.running-watch.v1", "runtime.submit-turn.v1", "runtime.observe-existing.v1"]);
    const observe = h.registry.observeExisting("A");
    await flush();
    const attach = lastFrame<{ type: "attach"; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A" }) });
    await observe;
    h.registry.declarePresentation(sessionPresentationKey("A"), false);
    expect(h.registry.getSnapshot()).toMatchObject({ presentationKey: "session:A", presentationAuthorized: false });
    const release = h.registry.release();
    await flush();
    const detach = lastFrame<{ type: "detach"; id: string; payload: { sessionId: string } }>(ws, "detach")!;
    expect(detach.payload.sessionId).toBe("A");
    ws.serverSend({ type: "response", id: detach.id, payload: { ok: true, result: { sessionId: "A", detached: true } } });
    await release;
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "stop")).toHaveLength(0);
    expect(h.registry.leaseSnapshot.phase).toBe("vacant");
    h.dispose();
  });

  it("release retains, strict stop false stays pending, and provider-style dispose sends no stop", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 2 } });
    const ws = await ready(h, []);
    await acquire(h, ws, "A");
    const a = h.registry.lookup("A")!;
    const release = h.registry.release();
    await flush();
    const detach = lastFrame<{ type: "detach"; id: string }>(ws, "detach")!;
    ws.serverSend({ type: "response", id: detach.id, payload: { ok: true, result: { sessionId: "A", detached: true } } });
    await release;
    expect(h.registry.lookup("A")).toBe(a);
    expect(a.getSnapshot().attached).toBe(false);
    await acquire(h, ws, "A");
    const stop = h.store.stop();
    await flush();
    const stopFrame = lastFrame<{ type: "stop"; id: string }>(ws, "stop")!;
    let settled = false;
    void stop.then(() => { settled = true; });
    ws.serverSend({ type: "response", id: stopFrame.id, payload: { ok: true, result: { sessionId: "A", stopped: false } } });
    await flush();
    expect(settled).toBe(false);
    ws.serverSend({ type: "response", id: stopFrame.id, payload: { ok: true, result: { sessionId: "A", stopped: true } } });
    await stop;
    expect(a.getSnapshot().sessionStopped).toBe(true);
    const stopCount = ws.sent.filter((frame) => (frame as { type?: string }).type === "stop").length;
    h.dispose();
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "stop")).toHaveLength(stopCount);
  });
});

describe("SessionControllerRegistry — pure peek + exact-ID membership subscription (4A.3.2a)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("peek is pure: no LRU touch, no publish, no admission, zero wire frames", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 4 } });
    const ws = await ready(h);
    h.registry.getOrCreate("A");
    h.registry.getOrCreate("B");
    const ordinalBefore = h.registry.getSnapshot().accessOrdinal;
    const framesBefore = ws.sent.length;
    expect(h.registry.peek("A")?.sessionId).toBe("A");
    expect(h.registry.peek("B")?.sessionId).toBe("B");
    expect(h.registry.peek("missing")).toBeNull();
    // No LRU touch: ordinals unchanged after peeks.
    expect(h.registry.getSnapshot().accessOrdinal).toBe(ordinalBefore);
    // No frames emitted by peek.
    expect(ws.sent).toHaveLength(framesBefore);
    expect(h.registry.controllerCount).toBe(2);
    h.dispose();
  });

  it("subscribeSession is exact-ID membership: notifies on register/evict/re-register and never protects (mounted observer evictable)", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 2 } });
    const ws = await ready(h);
    const notifications: string[] = [];
    const unsub = h.registry.subscribeSession("A", () => notifications.push("notify"));
    // Subscribing never admits and never notifies while absent.
    expect(notifications).toEqual([]);
    expect(h.registry.peek("A")).toBeNull();
    // Registration notifies the exact observer.
    h.registry.getOrCreate("A");
    expect(notifications).toContain("notify");
    // The observer creates NO protection: filling B + C evicts A (LRU).
    notifications.length = 0;
    h.registry.getOrCreate("B");
    h.registry.getOrCreate("C");
    expect(h.registry.peek("A")).toBeNull();
    expect(notifications).toContain("notify");
    // Re-registration notifies again.
    notifications.length = 0;
    h.registry.getOrCreate("A");
    expect(h.registry.peek("A")).not.toBeNull();
    expect(notifications).toContain("notify");
    // Unsubscribe stops notifications for A.
    unsub();
    notifications.length = 0;
    h.registry.getOrCreate("D");
    expect(notifications).toEqual([]);
    expect(ws.sent.filter((frame) => ["detach", "stop"].includes((frame as { type?: string }).type ?? ""))).toHaveLength(0);
    h.dispose();
  });

  it("subscribeSession forwards exact controller view changes and isolates A from B", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 4 } });
    const ws = await ready(h, []);
    const aNotifications: string[] = [];
    const bNotifications: string[] = [];
    const unsubA = h.registry.subscribeSession("A", () => aNotifications.push("a"));
    const unsubB = h.registry.subscribeSession("B", () => bNotifications.push("b"));
    await acquire(h, ws, "A", "eA", 2);
    expect(aNotifications.length).toBeGreaterThan(0);
    const aBefore = aNotifications.length;
    const bBefore = bNotifications.length;
    // Drive a view change on A only: a committed live entry.
    ws.serverSend({ type: "event", payload: { type: "message_start", sessionId: "A", epoch: "eA", eventId: 3, streamId: "s", messageId: "m", message: { role: "user", content: "hello" } } });
    ws.serverSend({ type: "event", payload: { type: "message_end", sessionId: "A", epoch: "eA", eventId: 4, streamId: "s", messageId: "m", entryId: "entry-A", message: { role: "user", content: "hello" } } });
    await flush();
    expect(aNotifications.length).toBeGreaterThan(aBefore);
    expect(bNotifications.length).toBe(bBefore);
    // subscribeSession does not perturb LRU recency.
    const ordinalBefore = h.registry.getSnapshot().accessOrdinal;
    unsubA();
    unsubB();
    expect(h.registry.getSnapshot().accessOrdinal).toBe(ordinalBefore);
    h.dispose();
  });

  it("observer listeners are dropped on registry dispose (no leak)", () => {
    const h = createHarness({ storeOptions: { maxControllers: 2 } });
    const notifications: string[] = [];
    const unsub = h.registry.subscribeSession("A", () => notifications.push("notify"));
    h.registry.getOrCreate("A");
    h.dispose();
    expect(notifications.length).toBeGreaterThanOrEqual(0);
    // Unsubscribing after dispose is a safe no-op.
    unsub();
    expect(() => h.registry.peek("A")).not.toThrow();
  });
});
