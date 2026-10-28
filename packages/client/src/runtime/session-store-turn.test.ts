/**
 * Phase 3 atomic submit-turn client tests.
 *
 * These drive SessionStore over the negotiated `runtime.submit-turn.v1` seam:
 *  - delivery states: in_flight → accepted / not_delivered / uncertain;
 *  - the single PendingTurn never occupies the ordinary command slot and
 *    conflicting ordinary commands reject `session_busy` while it is active;
 *  - same-epoch reconnect resends the SAME operationId + payload on a fresh
 *    transport envelope; epoch change after possible delivery NEVER resends;
 *  - strict generation/session/epoch/operation/turn matching drops wrong and
 *    late frames;
 *  - without the negotiated feature, prompts fall back to the explicit finite
 *    legacy command-envelope path (legacySubmitTurnV2).
 *
 * The store is driven through the same deterministic FakeWebSocket harness as
 * the main session-store suite (injected clock/timers/random).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authoritySnapshot, createHarness, flush, lastFrame, snapshotPayload, type RuntimeHarness } from "./testing/harness";
import type { FakeWebSocket } from "./testing/harness";
import type { SubmitTurnAdmission, RuntimeSnapshot, WsTurnStatusMessage } from "@fffattiger/pix-protocol";
import { sessionPresentationKey } from "./session-controller-registry";

function ackSubmitTurn(caps: string[] = ["agent"]) {
  return {
    type: "handshake_ack",
    payload: {
      protocolVersion: 2,
      host: { mode: "local", capabilities: caps },
      limits: { maxUpload: 0, maxOpenSessions: 4 },
      sessionSnapshotSupport: true,
      acceptedFeatures: ["runtime.read-rpc.v1", "runtime.submit-turn.v1", "runtime.observe-existing.v1"],
    },
  };
}

function ackLegacy(caps: string[] = ["agent"]) {
  return { type: "handshake_ack", payload: { protocolVersion: 2, host: { mode: "local", capabilities: caps }, limits: { maxUpload: 0, maxOpenSessions: 4 }, sessionSnapshotSupport: true } };
}

/** Drive connect + handshake (submit-turn negotiated) + attach to `sessionId`. */
async function openAndAttachTurn(h: RuntimeHarness, sessionId = "s1", epoch = "e1", resumeStatus: "snapshot" | "gap" | "epoch_changed" = "snapshot"): Promise<FakeWebSocket> {
  h.store.connect();
  const ws = h.lastSocket();
  ws.serverOpen();
  ws.serverSend(ackSubmitTurn());
  await flush();
  const p = h.store.openSession(sessionId);
  await flush();
  const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
  ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId, epoch, resumeStatus }) });
  await flush();
  await p;
  return ws;
}

/** A schema-valid accepted admission for the pending turn's operationId. */
function acceptedAdmission(_h: RuntimeHarness, operationId: string, epoch = "e1", turnId = "turn-1"): SubmitTurnAdmission {
  return acceptedAdmissionFor("s1", operationId, epoch, turnId);
}

function acceptedAdmissionFor(sessionId: string, operationId: string, epoch: string, turnId = "turn-1", revision = 1): SubmitTurnAdmission {
  return {
    status: "accepted",
    delivery: "accepted",
    sessionId,
    epoch,
    revision,
    operationId,
    turnId,
    snapshot: snapshotPayload({ sessionId, epoch, lastEventId: revision }).snapshot as never,
    turnStatus: { sessionId, epoch, operationId, turnId, revision: 0, state: "admitted" },
  };
}

/** A duplicate admission for an idempotent same-operation status rejoin. */
function duplicateAdmissionFor(
  sessionId: string,
  operationId: string,
  state: "running" | "completed" | "failed",
  revision: number,
  extra: Record<string, unknown> = {},
  epoch = "e1",
  turnId = "turn-1",
): SubmitTurnAdmission {
  return {
    status: "duplicate",
    delivery: "accepted",
    sessionId,
    epoch,
    revision: revision + 10,
    operationId,
    turnId,
    snapshot: snapshotPayload({ sessionId, epoch, lastEventId: revision + 10 }).snapshot as never,
    turnStatus: { sessionId, epoch, operationId, turnId, revision, state, ...extra },
  };
}

async function createSeededSession(
  h: RuntimeHarness,
  ws: FakeWebSocket,
  { sessionId = "new-1", epoch = "eN", revision = 1, leafId }: { sessionId?: string; epoch?: string; revision?: number; leafId?: string } = {},
): Promise<void> {
  const createP = h.store.createSession({ cwd: "/x", projectRoot: "/x" });
  await flush();
  const createFrame = lastFrame<{ type: string; id: string }>(ws, "create")!;
  const createdSnapshot = snapshotPayload({ sessionId, epoch, lastEventId: revision }).snapshot as { state: Record<string, unknown> };
  if (leafId !== undefined) createdSnapshot.state.leafId = leafId;
  ws.serverSend({
    type: "response",
    id: createFrame.id,
    payload: {
      ok: true,
      result: {
        sessionId,
        epoch,
        lastEventId: revision,
        created: true,
        cwd: "/x",
        projectRoot: "/x",
        snapshot: createdSnapshot,
      },
    },
  });
  await expect(createP).resolves.toEqual({ sessionId });
}

function submitFrames(ws: FakeWebSocket): Array<{ type: "submit_turn"; id: string; payload: Record<string, unknown> }> {
  return ws.sent.filter((frame): frame is { type: "submit_turn"; id: string; payload: Record<string, unknown> } =>
    (frame as { type?: string }).type === "submit_turn"
  );
}

/**
 * Wait for the outbox to put its NEXT send on the wire. The outbox waits for a
 * provably fresh transport before writing, which takes a few microtask rounds;
 * polling on the actual frame keeps these tests deterministic without timers.
 */
async function awaitSubmit(ws: FakeWebSocket, count = 1): Promise<void> {
  for (let i = 0; i < 50 && submitFrames(ws).length < count; i += 1) await flush(4);
}

/** A correlated turn status frame for the accepted turn. */
function turnStatus(sessionId: string, operationId: string, revision: number, state: string, extra: Record<string, unknown> = {}, epoch = "e1", turnId = "turn-1") {
  return {
    type: "turn_status",
    ...(state === "completed" ? { authority: authoritySnapshot(sessionId, epoch) } : {}),
    payload: { sessionId, epoch, operationId, turnId, revision, state, ...extra },
  };
}

describe("SessionStore — unconditional send over the negotiated seam", () => {
  // Real timers: the outbox has no client-side budget or deadline, and the
  // transport's freshness/connect timers must actually elapse.
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("routes a send through submit_turn with NO fence and never the command slot", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    expect(h.store.getSnapshot().submitTurnEnabled).toBe(true);

    const sendP = h.store.sendPrompt("hello");
    await awaitSubmit(ws);
    const submit = lastFrame<{ type: "submit_turn"; id: string; payload: Record<string, unknown> }>(ws, "submit_turn")!;
    expect(submit).toBeTruthy();
    expect(submit.payload.prompt).toBe("hello");
    expect(submit.payload.operationId).toMatch(/^op:/);
    // The client states a delivery PREFERENCE, never a guess about authority
    // state: no epoch/revision fence travels.
    expect(submit.payload.expectedEpoch).toBeUndefined();
    expect(submit.payload.expectedRevision).toBeUndefined();
    expect(submit.payload.whenBusy).toBe("follow_up");
    expect(lastFrame(ws, "command")).toBeUndefined();
    // Before acceptance the send owns only its bubble.
    expect(h.store.getSnapshot().promptPending).toBe(true);
    expect(h.store.getSnapshot().turnActive).toBe(false);

    ws.serverSend({ type: "submit_turn_result", id: submit.id, payload: acceptedAdmission(h, submit.payload.operationId as string) });
    await flush();
    await expect(sendP).resolves.toBeUndefined();
    expect(h.store.getSnapshot().turnDelivery).toBe("accepted");
    expect(h.store.getSnapshot().turnActive).toBe(true);
  });

  it("switch_queued_delivery stays independent of the in-flight turn — never session_busy while streaming", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    const sendP = h.store.sendPrompt("streaming");
    await awaitSubmit(ws);
    const submit = lastFrame<{ type: "submit_turn"; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    ws.serverSend({ type: "submit_turn_result", id: submit.id, payload: acceptedAdmission(h, submit.payload.operationId) });
    await flush();
    await sendP;
    // Queue surgery must not be refused because a turn is active: the command
    // goes out on the ordinary lane while the turn keeps running.
    const switched = h.store.switchQueuedDelivery({ list: "steering", index: 0, message: "x" });
    let command: { type: "command"; id: string; payload: { command: { commandId: string } } } | undefined;
    for (let i = 0; i < 50 && command === undefined; i += 1) {
      await flush(4);
      command = lastFrame<{ type: "command"; id: string; payload: { command: { commandId: string } } }>(ws, "command");
    }
    expect(command).toBeTruthy();
    ws.serverSend({ type: "response", id: command!.id, payload: { ok: true, result: { commandId: command!.payload.command.commandId, result: { ok: true, type: "switch_queued_delivery" } } } });
    await expect(switched).resolves.toBeUndefined();
    h.dispose();
  });

  it("stamps the optimistic bubble with the send instant so the turn has a start before the authority dates it", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    void h.store.sendPrompt("instant");
    await awaitSubmit(ws);
    const bubble = h.store.getSnapshot().optimisticEntries[0]!;
    expect(typeof bubble.entry.message.timestamp).toBe("number");
    h.dispose();
  });

  it("an accepted turn keeps the bubble and never occupies the ordinary command slot; reads stay independent", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    const sendP = h.store.sendPrompt("long running");
    await awaitSubmit(ws);
    const submit = lastFrame<{ type: "submit_turn"; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    ws.serverSend({ type: "submit_turn_result", id: submit.id, payload: acceptedAdmission(h, submit.payload.operationId) });
    await flush();
    await sendP;
    expect(h.store.getSnapshot().optimisticEntries).toHaveLength(1);
    expect(h.store.getSnapshot().promptPending).toBe(false);
    // Reads stay available while the turn runs: the read lane never waits
    // behind the prompt and never reports session_busy.
    await expect(h.store.getState()).resolves.toMatchObject({ sessionId: "s1" });
    h.dispose();
  });

  it("a proven-final rejection (invalid_input) removes the bubble and is reported exactly once", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    let settlements = 0;
    const sendP = h.store.sendPrompt("bad").catch((error: unknown) => { settlements += 1; return error; });
    await flush();
    const submit = lastFrame<{ type: "submit_turn"; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    ws.serverSend({
      type: "submit_turn_result",
      id: submit.id,
      payload: { status: "rejected", delivery: "not_delivered", sessionId: "s1", operationId: submit.payload.operationId, error: { code: "invalid_input", message: "illegal payload", retryable: false } },
    });
    await expect(sendP).resolves.toMatchObject({ code: "invalid_input", phase: "activation" });
    expect(settlements).toBe(1);
    expect(h.store.getSnapshot().optimisticEntries).toHaveLength(0);
    expect(submitFrames(ws)).toHaveLength(1);
    h.dispose();
  });

  it("a retryable rejection never settles the send: the SAME operationId is resent after a reconnect", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    let outcome: "pending" | "settled" = "pending";
    const sendP = h.store.sendPrompt("retry me");
    void sendP.then(() => { outcome = "settled"; }, () => { outcome = "settled"; });
    await flush();
    const first = lastFrame<{ type: "submit_turn"; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    ws.serverSend({
      type: "submit_turn_result",
      id: first.id,
      payload: { status: "rejected", delivery: "not_delivered", sessionId: "s1", operationId: first.payload.operationId, error: { code: "unavailable", message: "worker restarting", retryable: true } },
    });
    await flush();
    expect(outcome).toBe("pending");

    const ws2 = await h.reconnectAfterFailure({ sessionId: "s1", epoch: "e1" });
    await flush();
    const retried = submitFrames(ws2);
    expect(retried).toHaveLength(1);
    expect(retried[0]!.payload.operationId).toBe(first.payload.operationId);
    expect(retried[0]!.id).not.toBe(first.id);

    ws2.serverSend({ type: "submit_turn_result", id: retried[0]!.id, payload: acceptedAdmission(h, first.payload.operationId) });
    await expect(sendP).resolves.toBeUndefined();
    h.dispose();
  });

  it("a stop while a send is pending keeps the message queued (it is never dropped or failed)", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    let outcome: "pending" | "settled" = "pending";
    const sendP = h.store.sendPrompt("survives stop");
    void sendP.then(() => { outcome = "settled"; }, () => { outcome = "settled"; });
    await flush();
    const submit = lastFrame<{ type: "submit_turn"; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    void h.store.stop("user").catch(() => undefined);
    await flush(10);
    // Not lost: the outbox still owns it and the UI never claims non-delivery.
    expect(h.store.getSnapshot().optimisticEntries).toHaveLength(1);
    // An acceptance that arrives late still releases it.
    ws.serverSend({ type: "submit_turn_result", id: submit.id, payload: acceptedAdmission(h, submit.payload.operationId) });
    await expect(sendP).resolves.toBeUndefined();
    expect(outcome).toBe("settled");
    h.dispose();
  });

  it("strict matching: a wrong/late admission never settles the pending send", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    let outcome = "pending";
    const sendP = h.store.sendPrompt("mine");
    void sendP.then(() => { outcome = "settled"; }, () => { outcome = "settled"; });
    await flush();
    const submit = lastFrame<{ type: "submit_turn"; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    // Another operation's acceptance must be ignored.
    ws.serverSend({ type: "submit_turn_result", id: submit.id, payload: acceptedAdmission(h, "op:someone-else") });
    await flush();
    expect(outcome).toBe("pending");
    ws.serverSend({ type: "submit_turn_result", id: submit.id, payload: acceptedAdmission(h, submit.payload.operationId) });
    await expect(sendP).resolves.toBeUndefined();
    expect(outcome).toBe("settled");
    h.dispose();
  });

  it("stale status revisions never regress a terminal turn", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    const sendP = h.store.sendPrompt("terminal");
    await flush();
    const submit = lastFrame<{ type: "submit_turn"; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    ws.serverSend({ type: "submit_turn_result", id: submit.id, payload: acceptedAdmission(h, submit.payload.operationId) });
    await flush();
    await sendP;
    ws.serverSend(turnStatus("s1", submit.payload.operationId, 2, "completed", { userEntryId: "e-2", finalLeafId: "e-3" }));
    await flush();
    // A lower revision must not reopen or duplicate the terminal transition.
    ws.serverSend(turnStatus("s1", submit.payload.operationId, 1, "running", {}));
    await flush();
    expect(h.store.getSnapshot().turnActive).toBe(false);
    expect(h.controller("s1")!.getSnapshot().liveEntries.length).toBe(0);
    h.dispose();
  });

  it("a second send while one is still pending is queued in order, never session_busy", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    const firstSend = h.store.sendPrompt("first");
    await flush();
    const first = lastFrame<{ type: "submit_turn"; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    // A second send while the first is un-accepted is NOT rejected.
    const secondSend = h.store.sendPrompt("second");
    await flush();
    // Only the first is on the wire (one delivery at a time, in order).
    expect(submitFrames(ws)).toHaveLength(1);
    expect(h.store.getSnapshot().optimisticEntries.length).toBeGreaterThanOrEqual(1);

    ws.serverSend({ type: "submit_turn_result", id: first.id, payload: acceptedAdmission(h, first.payload.operationId) });
    await expect(firstSend).resolves.toBeUndefined();
    await flush();
    const frames = submitFrames(ws);
    expect(frames).toHaveLength(2);
    expect(frames[1]!.payload.prompt).toBe("second");
    ws.serverSend({ type: "submit_turn_result", id: frames[1]!.id, payload: acceptedAdmission(h, frames[1]!.payload.operationId as string) });
    await expect(secondSend).resolves.toBeUndefined();
    h.dispose();
  });

  it("create is identity-only; the first send of the new session carries activationOverrides and no fence", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    await createSeededSession(h, ws);
    const sendP = h.store.sendPromptToSession("new-1", "first", undefined, {
      model: { provider: "anthropic", modelId: "claude-opus-4" },
      thinkingLevel: "high",
    });
    await flush();
    const submit = lastFrame<{ type: "submit_turn"; id: string; payload: Record<string, unknown> }>(ws, "submit_turn")!;
    expect(submit.payload.activationOverrides).toEqual({
      model: { provider: "anthropic", modelId: "claude-opus-4" },
      thinkingLevel: "high",
    });
    expect(submit.payload.expectedEpoch).toBeUndefined();
    expect(submit.payload.expectedRevision).toBeUndefined();
    ws.serverSend({ type: "submit_turn_result", id: submit.id, payload: acceptedAdmissionFor("new-1", submit.payload.operationId as string, "eN") });
    await expect(sendP).resolves.toBeUndefined();
    h.dispose();
  });

  it("a transient rejection on a created session resends the SAME operation with an identical payload", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    await createSeededSession(h, ws, { sessionId: "new-repair", epoch: "eN" });
    const sendP = h.store.sendPromptToSession("new-repair", "same logical turn", undefined, {
      model: { provider: "anthropic", modelId: "claude-opus-4" },
      thinkingLevel: "high",
    });
    await flush();
    const first = lastFrame<{ type: "submit_turn"; id: string; payload: Record<string, unknown> }>(ws, "submit_turn")!;
    ws.serverSend({
      type: "submit_turn_result",
      id: first.id,
      payload: { status: "rejected", delivery: "not_delivered", sessionId: "new-repair", operationId: first.payload.operationId, error: { code: "unavailable", message: "authority restarting", retryable: true } },
    });
    await flush();
    const ws2 = await h.reconnectAfterFailure({ sessionId: "new-repair", epoch: "eN" });
    await flush();
    const retried = submitFrames(ws2);
    expect(retried).toHaveLength(1);
    expect(retried[0]!.payload).toEqual(first.payload);
    ws2.serverSend({ type: "submit_turn_result", id: retried[0]!.id, payload: acceptedAdmissionFor("new-repair", first.payload.operationId as string, "eN") });
    await expect(sendP).resolves.toBeUndefined();
    h.dispose();
  });

  it("a send for another session never steals the attached session's lease", async () => {
    const h = createHarness({ storeOptions: { maxControllers: 3 } });
    const ws = await openAndAttachTurn(h, "A", "eA");
    h.registry.declarePresentation(sessionPresentationKey("A"), true);
    await createSeededSession(h, ws, { sessionId: "B", epoch: "eB" });
    h.registry.declarePresentation(sessionPresentationKey("A"), true);
    // The send targets B's own exact controller (a controller only ever sends
    // for its own session).
    const controllerB = h.registry.lookup("B");
    expect(controllerB).not.toBeNull();
    const sendP = controllerB!.submitTurn({ sessionId: "B", prompt: "background turn" });
    await flush(8);
    const submit = lastFrame<{ type: "submit_turn"; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    // The presented session is still A while B's send is in flight.
    expect(h.registry.leaseSnapshot).toMatchObject({ holderSessionId: "A" });
    ws.serverSend({ type: "submit_turn_result", id: submit.id, payload: acceptedAdmissionFor("B", submit.payload.operationId, "eB") });
    await flush(8);
    await sendP;
    // B's admission settles the send; B stays a background controller.
    expect(controllerB!.getSnapshot()).toMatchObject({ attached: false });
    h.dispose();
  });

  it("uses the created snapshot leaf as the first prompt's optimistic base", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    await createSeededSession(h, ws, { leafId: "created-leaf" });
    const sendP = h.store.sendPromptToSession("new-1", "hello");
    await flush();
    const submit = lastFrame<{ type: "submit_turn"; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    // The bubble is anchored on the created leaf, so a later commit reconciles
    // by identity instead of text.
    const bubble = h.controller("new-1")!.getSnapshot().optimisticEntries[0]!;
    expect(bubble.baseEntryId).toBe("created-leaf");
    ws.serverSend({ type: "submit_turn_result", id: submit.id, payload: acceptedAdmissionFor("new-1", submit.payload.operationId as string, "eN") });
    await sendP.catch(() => undefined);
    h.dispose();
  });

  it("keeps the first committed turn visible across the second send", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    const first = h.store.sendPrompt("first");
    await awaitSubmit(ws);
    const s1 = lastFrame<{ type: "submit_turn"; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    ws.serverSend({ type: "submit_turn_result", id: s1.id, payload: acceptedAdmission(h, s1.payload.operationId) });
    await flush();
    await first;
    // Complete the turn: the tracker is released. The bubble is retained until
    // the authority's own committed user entry consumes it by exact identity —
    // never removed on a guess.
    ws.serverSend(turnStatus("s1", s1.payload.operationId, 2, "completed", { userEntryId: "entry-1", finalLeafId: "entry-1" }));
    await flush(8);
    expect(h.controller("s1")!.getSnapshot().turnActive).toBe(false);
    const bubble = h.controller("s1")!.getSnapshot().optimisticEntries;
    expect(bubble).toHaveLength(1);
    expect(bubble[0]!.identity?.userEntryId).toBe("entry-1");
    // A second send must not disturb the already-rendered live tail.
    const liveBefore = h.controller("s1")!.getSnapshot().liveEntries.length;
    void h.store.sendPrompt("second");
    await awaitSubmit(ws, 2);
    expect(h.controller("s1")!.getSnapshot().liveEntries).toHaveLength(liveBefore);
    h.dispose();
  });
});

describe("SessionStore — accepted turn status rejoin after reconnect", () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  async function acceptedTurn(h: RuntimeHarness, ws: FakeWebSocket, prompt = "resume me") {
    const sendP = h.store.sendPrompt(prompt);
    await awaitSubmit(ws);
    const submit = lastFrame<{ type: "submit_turn"; id: string; payload: { operationId: string; [key: string]: unknown } }>(ws, "submit_turn")!;
    ws.serverSend({ type: "submit_turn_result", id: submit.id, payload: acceptedAdmission(h, submit.payload.operationId) });
    await flush();
    await sendP;
    return submit;
  }

  it("same-epoch reattach re-subscribes the SAME operation; a duplicate terminal status clears the gate", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    const submit = await acceptedTurn(h, ws);
    const operationId = submit.payload.operationId;
    const controller = h.controller("s1")!;
    expect(controller.getSnapshot().turnActive).toBe(true);
    // Real gate before recovery: ordinary mutations are honestly busy.
    await expect(h.store.setModel("openai", "blocked")).rejects.toMatchObject({ code: "session_busy" });

    const ws2 = await h.reconnectAfterFailure({ sessionId: "s1", epoch: "e1" });
    await awaitSubmit(ws2);
    const rejoin = submitFrames(ws2);
    expect(rejoin).toHaveLength(1);
    // SAME operationId + payload, fresh transport envelope: idempotent status
    // recovery, never a new user send or a second bubble.
    expect(rejoin[0]!.payload).toEqual(submit.payload);
    expect(rejoin[0]!.payload.operationId).toBe(operationId);
    expect(rejoin[0]!.id).not.toBe(submit.id);
    expect(controller.getSnapshot().optimisticEntries).toHaveLength(1);

    ws2.serverSend({
      type: "submit_turn_result",
      id: rejoin[0]!.id,
      payload: duplicateAdmissionFor("s1", operationId, "completed", 2, { userEntryId: "entry-u", finalLeafId: "entry-u" }),
    });
    await flush();
    // The terminal status already happened while the Host subscription was
    // closed; the duplicate result is the authority's current truth and clears
    // the gate exactly through the normal terminal path. No new bubble.
    expect(controller.getSnapshot().turnActive).toBe(false);
    expect(controller.getSnapshot().optimisticEntries).toHaveLength(1);

    const modelP = h.store.setModel("openai", "gpt-5");
    await flush();
    const model = lastFrame<{ type: "command"; id: string; payload: { command: { commandId: string; type: string } } }>(ws2, "command")!;
    expect(model.payload.command.type).toBe("set_model");
    ws2.serverSend({ type: "response", id: model.id, payload: { ok: true, result: { commandId: model.payload.command.commandId, result: { ok: true, type: "set_model" } } } });
    await expect(modelP).resolves.toBeUndefined();

    const thinkingP = h.store.setThinkingLevel("high");
    await flush();
    const thinking = lastFrame<{ type: "command"; id: string; payload: { command: { commandId: string; type: string } } }>(ws2, "command")!;
    expect(thinking.payload.command.type).toBe("set_thinking_level");
    ws2.serverSend({ type: "response", id: thinking.id, payload: { ok: true, result: { commandId: thinking.payload.command.commandId, result: { ok: true, type: "set_thinking_level" } } } });
    await expect(thinkingP).resolves.toBeUndefined();
    h.dispose();
  });

  it("a durable duplicate's synthetic turn id clears the exact same-operation rejoin gate, never a foreign one", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    const submit = await acceptedTurn(h, ws, "receipt rejoin");
    const operationId = submit.payload.operationId;
    const controller = h.controller("s1")!;
    expect(controller.getSnapshot().turnActive).toBe(true);

    const ws2 = await h.reconnectAfterFailure({ sessionId: "s1", epoch: "e1" });
    await awaitSubmit(ws2);
    const rejoin = submitFrames(ws2)[0]!;
    // A DIFFERENT operation with a synthetic turn id must never touch this
    // tracker, even though its epoch is correct.
    ws2.serverSend({
      type: "submit_turn_result",
      id: rejoin.id,
      payload: duplicateAdmissionFor("s1", `${operationId}-foreign`, "completed", 2, {}, "e1", "turn-receipt"),
    });
    await flush();
    expect(controller.getSnapshot().turnActive).toBe(true);

    // The durable receipt hydration does not know the original in-memory turn
    // id. Under the EXACT session/operation/epoch fence, and with the admission
    // and status agreeing on the synthetic identity, the terminal truth must
    // still clear the gate.
    ws2.serverSend({
      type: "submit_turn_result",
      id: rejoin.id,
      payload: duplicateAdmissionFor("s1", operationId, "completed", 2, { userEntryId: "entry-u", finalLeafId: "entry-u" }, "e1", "turn-receipt"),
    });
    await flush();
    expect(controller.getSnapshot().turnActive).toBe(false);
    expect(controller.getSnapshot().optimisticEntries).toHaveLength(1);
    h.dispose();
  });

  it("a still-running rejoin keeps the real gate and releases it only on an exact terminal status", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    const submit = await acceptedTurn(h, ws);
    const operationId = submit.payload.operationId;
    const controller = h.controller("s1")!;

    const ws2 = await h.reconnectAfterFailure({ sessionId: "s1", epoch: "e1" });
    await awaitSubmit(ws2);
    const rejoin = submitFrames(ws2)[0]!;
    ws2.serverSend({
      type: "submit_turn_result",
      id: rejoin.id,
      payload: duplicateAdmissionFor("s1", operationId, "running", 1),
    });
    await flush();
    expect(controller.getSnapshot().turnActive).toBe(true);
    await expect(h.store.setModel("openai", "blocked")).rejects.toMatchObject({ code: "session_busy" });
    expect(controller.getSnapshot().optimisticEntries).toHaveLength(1);

    // The re-subscription owns the turn again: its live terminal push is what
    // releases the gate (never an idle snapshot guess).
    ws2.serverSend(turnStatus("s1", operationId, 2, "completed", { userEntryId: "entry-u", finalLeafId: "entry-u" }));
    await flush();
    expect(controller.getSnapshot().turnActive).toBe(false);
    const modelP = h.store.setModel("openai", "gpt-5");
    await flush();
    const model = lastFrame<{ type: "command"; id: string; payload: { command: { commandId: string; type: string } } }>(ws2, "command")!;
    ws2.serverSend({ type: "response", id: model.id, payload: { ok: true, result: { commandId: model.payload.command.commandId, result: { ok: true, type: "set_model" } } } });
    await expect(modelP).resolves.toBeUndefined();
    h.dispose();
  });

  it("epoch_changed NEVER replays an accepted submit and settles the tracker through the epoch-loss path", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    await acceptedTurn(h, ws);
    const controller = h.controller("s1")!;
    expect(controller.getSnapshot().turnActive).toBe(true);

    const ws2 = await h.reconnectAfterFailure({ sessionId: "s1", epoch: "e2" });
    await flush(20);
    expect(submitFrames(ws2)).toHaveLength(0);
    expect(controller.getSnapshot().turnActive).toBe(false);
    expect(controller.getSnapshot().optimisticEntries).toHaveLength(1);
    h.dispose();
  });

  it("a late rejoin result after detach/switch is ignored (old attempt cancelled, tracker retained)", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    const submit = await acceptedTurn(h, ws);
    const controller = h.controller("s1")!;
    const ws2 = await h.reconnectAfterFailure({ sessionId: "s1", epoch: "e1" });
    await awaitSubmit(ws2);
    const rejoin = submitFrames(ws2)[0]!;

    // Switching away detaches the old observation; its rejoin attempt must be
    // cancelled so no late duplicate can settle the new context.
    const switchP = h.store.openSession("s2");
    await flush();
    const detach = lastFrame<{ type: "detach"; id: string }>(ws2, "detach")!;
    ws2.serverSend({ type: "response", id: detach.id, payload: { ok: true, result: { sessionId: "s1", detached: true } } });
    let attach2: { type: "attach"; id: string; payload: { sessionId: string } } | undefined;
    for (let i = 0; i < 20 && attach2 === undefined; i += 1) {
      await flush(4);
      const candidate = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string } }>(ws2, "attach");
      if (candidate?.payload.sessionId === "s2") attach2 = candidate;
    }
    expect(attach2).toBeTruthy();

    ws2.serverSend({
      type: "submit_turn_result",
      id: rejoin.id,
      payload: duplicateAdmissionFor("s1", submit.payload.operationId, "completed", 2),
    });
    await flush();
    expect(controller.getSnapshot().turnActive).toBe(true);
    expect(controller.getSnapshot().optimisticEntries).toHaveLength(1);

    ws2.serverSend({ type: "snapshot", id: attach2!.id, payload: snapshotPayload({ sessionId: "s2", epoch: "e2" }) });
    await expect(switchP).resolves.toBeUndefined();
    h.dispose();
  });

  it("a terminal failed resume attach settles the pending ordinary command and stops claiming resuming", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    const modelP = h.store.setModel("openai", "gpt-5");
    await flush();
    expect(lastFrame(ws, "command")).toBeTruthy();

    const ws2 = await h.reconnectAfterFailure();
    const controller = h.controller("s1")!;
    expect(controller.getSnapshot().resuming).toBe(true);
    const attach = lastFrame<{ type: "attach"; id: string }>(ws2, "attach")!;
    ws2.serverSend({ type: "response", id: attach.id, payload: { ok: false, error: { code: "not_found", message: "session gone", retryable: false } } });

    await expect(modelP).rejects.toMatchObject({ code: "not_found" });
    await flush();
    expect(controller.getSnapshot()).toMatchObject({
      attached: false,
      resuming: false,
      connection: "ready",
      error: { code: "not_found", message: "session gone" },
    });
    // Failed recovery is terminal for this attach: no automatic create,
    // re-activate or duplicate wire attempt.
    expect(lastFrame(ws2, "create")).toBeUndefined();
    expect(lastFrame(ws2, "activate")).toBeUndefined();
    expect(ws2.sent.filter((frame) => (frame as { type?: string }).type === "attach")).toHaveLength(1);
    h.dispose();
  });
});

describe("SessionStore — a connection without the submit seam", () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("without the feature nothing goes out: the send stays queued with its bubble for the next connection", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackLegacy());
    await flush();
    expect(h.store.getSnapshot().submitTurnEnabled).toBe(false);
    const p = h.store.openSession("s1");
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1" }) });
    await flush();
    await p;

    let settled = false;
    void h.store.sendPrompt("hi").then(() => { settled = true; }, () => { settled = true; });
    await flush(40);
    expect(settled).toBe(false);
    expect(lastFrame(ws, "submit_turn")).toBeUndefined();
    expect((ws.sent as { type?: string; payload?: { command?: { type?: string } } }[]).some((f) => f.type === "command" && f.payload?.command?.type === "prompt")).toBe(false);
    expect(h.store.getSnapshot().optimisticEntries.some((c) => (c.entry.message as { content: string }).content === "hi")).toBe(true);
    h.dispose();
  });

});


describe("SessionController — terminal authority convergence", () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const terminal = (operationId: string, authority: ReturnType<typeof authoritySnapshot>, sessionId = "s1", epoch = "e1"): WsTurnStatusMessage => ({
    type: "turn_status", authority,
    payload: { sessionId, epoch, operationId, turnId: "turn-1", revision: 1, state: "completed", disposition: "handled", finalLeafId: "branch-parent" },
  });
  const settings = { model: { provider: "openai", id: "gpt-6.1-sol" }, thinkingLevel: "high" };
  function idleAuthority(sessionId: string, epoch: string, lastEventId: number) {
    const authority = authoritySnapshot(sessionId, epoch, lastEventId);
    authority.snapshot = snapshotPayload({ sessionId, epoch, lastEventId, ...settings }).snapshot as RuntimeSnapshot;
    authority.snapshot.state.leafId = "branch-parent";
    return authority;
  }
  async function admitted(h: RuntimeHarness, ws: FakeWebSocket, revision = 1) {
    const send = h.controller("s1")!.submitTurn({ sessionId: "s1", prompt: "fast", activationOverrides: { model: { provider: "openai", modelId: "gpt-6.1-sol" }, thinkingLevel: "high" } });
    // The outbox waits for a sendable transport before writing.
    for (let i = 0; i < 20 && submitFrames(ws).length === 0; i += 1) await flush(4);
    const submit = lastFrame<{ type: string; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    const admission = acceptedAdmissionFor("s1", submit.payload.operationId, "e1", "turn-1", revision);
    if (admission.status !== "accepted") throw new Error("expected accepted");
    admission.snapshot = idleAuthority("s1", "e1", revision).snapshot;
    admission.snapshot.state.isPromptRunning = true;
    ws.serverSend({ type: "submit_turn_result", id: submit.id, payload: admission });
    await send;
    return submit;
  }

  it.each([2, 3])("prompt_done cursor 2 precedes busy admission; terminal authority cursor %i converges without losing settings", async (cursor) => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    ws.serverSend({ type: "snapshot", payload: { ...snapshotPayload(), snapshot: idleAuthority("s1", "e1", 0).snapshot } });
    const send = h.controller("s1")!.submitTurn({ sessionId: "s1", prompt: "fast", activationOverrides: { model: { provider: "openai", modelId: "gpt-6.1-sol" }, thinkingLevel: "high" } });
    void send.catch(() => undefined);
    // The outbox waits for a sendable transport before writing.
    for (let i = 0; i < 20 && submitFrames(ws).length === 0; i += 1) await flush(4);
    const submit = lastFrame<{ type: string; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    ws.serverSend({ type: "event", payload: { type: "running_sessions_changed", sessionId: "s1", epoch: "e1", eventId: 1, sessionIds: ["s1"], busySessionIds: [] } });
    ws.serverSend({ type: "event", payload: { type: "prompt_done", sessionId: "s1", epoch: "e1", eventId: 2 } });
    const admission = acceptedAdmissionFor("s1", submit.payload.operationId, "e1", "turn-1", 2);
    if (admission.status !== "accepted") throw new Error("expected accepted");
    admission.snapshot = idleAuthority("s1", "e1", 2).snapshot;
    admission.snapshot.state.isPromptRunning = true;
    ws.serverSend({ type: "submit_turn_result", id: submit.id, payload: admission });
    await send;
    const controller = h.controller("s1")!;
    expect(controller.getSnapshot().snapshot?.state).toMatchObject({ ...settings, isPromptRunning: true });
    const history = controller.getSnapshot();
    const authority = idleAuthority("s1", "e1", cursor);
    ws.serverSend(terminal(submit.payload.operationId, authority));
    expect(controller.getSnapshot().turnActive).toBe(false);
    expect((controller as unknown as { lastEventId: number }).lastEventId).toBe(2);
    expect(controller.getSnapshot().snapshot?.state.isPromptRunning).toBe(cursor === 3);
    if (cursor === 3) {
      ws.serverSend({ type: "event", payload: { type: "running_sessions_changed", sessionId: "s1", epoch: "e1", eventId: 3, sessionIds: ["s1"], busySessionIds: ["s1"] } });
      ws.serverSend({ type: "snapshot", payload: { ...snapshotPayload({ sessionId: "s1", epoch: "e1", lastEventId: 3 }), snapshot: authority.snapshot } });
    }
    ws.serverSend({ type: "event", payload: { type: "running_sessions_changed", sessionId: "s1", epoch: "e1", eventId: cursor + 1, sessionIds: ["s1"], busySessionIds: [] } });
    expect(controller.getSnapshot().snapshot?.state).toMatchObject({ ...settings, isPromptRunning: false, isStreaming: false });
    expect(controller.getSnapshot().optimisticEntries).toHaveLength(0);
    expect(controller.getSnapshot().historyGeneration).toBe(history.historyGeneration);
    expect(controller.getSnapshot().historyAnchorLeafId).toBe(history.historyAnchorLeafId);
    const again = h.store.sendPrompt("again").catch(() => undefined);
    await flush();
    expect(submitFrames(ws)).toHaveLength(2);
    expect(lastFrame(ws, "command")).toBeUndefined();
    h.dispose();
    void again;
  });

  it("sidecar ahead of observer message_end preserves its entry exactly once and its branch/history", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    const initial = snapshotPayload({ sessionId: "s1", epoch: "e1", lastEventId: 1 });
    const snapshot = initial.snapshot as RuntimeSnapshot;
    snapshot.state.leafId = "branch-parent";
    ws.serverSend({ type: "snapshot", payload: initial });
    const submit = await admitted(h, ws);
    const controller = h.controller("s1")!;
    const history = controller.getSnapshot();
    ws.serverSend({ type: "event", payload: { type: "message_start", sessionId: "s1", epoch: "e1", eventId: 2, streamId: "u1", messageId: "u1", message: { role: "user", content: "fast" } } });
    const authority = idleAuthority("s1", "e1", 3);
    authority.snapshot.state.leafId = "u1";
    ws.serverSend({ ...terminal(submit.payload.operationId, authority), payload: { ...terminal(submit.payload.operationId, authority).payload, disposition: "started", userEntryId: "u1", finalLeafId: "u1" } });
    expect((controller as unknown as { lastEventId: number }).lastEventId).toBe(2);
    const end = { type: "event", payload: { type: "message_end", sessionId: "s1", epoch: "e1", eventId: 3, streamId: "u1", messageId: "u1", entryId: "u1", parentEntryId: "branch-parent", message: { role: "user", content: "fast" } } };
    ws.serverSend(end);
    ws.serverSend({ type: "snapshot", payload: { ...initial, lastEventId: 3, snapshot: authority.snapshot } });
    ws.serverSend(end);
    expect(controller.getSnapshot().liveEntries.map((entry) => entry.entryId)).toEqual(["u1"]);
    expect(controller.getSnapshot().historyGeneration).toBe(history.historyGeneration);
    expect(controller.getSnapshot().historyAnchorLeafId).toBe(history.historyAnchorLeafId);
    expect(controller.getSnapshot().snapshot?.state.leafId).toBe("u1");
    h.dispose();
  });

  it("observing A while background exact B completes updates only B without attachment or history churn", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h, "B", "eB");
    ws.serverSend({ type: "snapshot", payload: { ...snapshotPayload({ sessionId: "B", epoch: "eB" }), snapshot: idleAuthority("B", "eB", 0).snapshot } });
    const observeA = h.store.openSession("A");
    await flush();
    const detach = lastFrame<{ type: string; id: string }>(ws, "detach")!;
    ws.serverSend({ type: "response", id: detach.id, payload: { ok: true, result: { sessionId: "B", detached: true } } });
    await flush();
    const attach = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A", epoch: "eA" }) });
    await observeA;
    const a = h.controller("A")!;
    const b = h.registry.getOrCreate("B");
    h.registry.declarePresentation(sessionPresentationKey("B"), true);
    const send = b.submitTurn({ sessionId: "B", prompt: "background" });
    await flush();
    const submit = lastFrame<{ type: string; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    const admission = acceptedAdmissionFor("B", submit.payload.operationId, "eB", "turn-1", 2);
    if (admission.status !== "accepted") throw new Error("expected accepted");
    admission.snapshot.state.isPromptRunning = true;
    h.registry.declarePresentation(sessionPresentationKey("A"), true);
    ws.serverSend({ type: "submit_turn_result", id: submit.id, payload: admission });
    await send;
    const beforeA = a.getSnapshot();
    const beforeB = b.getSnapshot();
    const lease = h.registry.leaseSnapshot;
    const frames = ws.sent.length;
    ws.serverSend(terminal(submit.payload.operationId, idleAuthority("B", "eB", 4), "B", "eB"));
    expect(a.getSnapshot()).toBe(beforeA);
    expect(h.registry.leaseSnapshot).toEqual(lease);
    expect(lease).toMatchObject({ phase: "held", holderSessionId: "A" });
    expect(ws.sent).toHaveLength(frames);
    expect(b.getSnapshot()).toMatchObject({ attached: false, turnActive: false, historyGeneration: beforeB.historyGeneration, historyAnchorLeafId: beforeB.historyAnchorLeafId });
    expect((b as unknown as { lastEventId: number }).lastEventId).toBe(4);
    expect(b.getSnapshot().snapshot?.state).toMatchObject({ ...settings, isPromptRunning: false });
    expect(b.getSnapshot().liveEntries).toEqual(beforeB.liveEntries);
    h.dispose();
  });

  it("equal-cursor authority retains a real external stream, capabilities, branch and committed live entries", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    ws.serverSend({ type: "snapshot", payload: { ...snapshotPayload(), snapshot: idleAuthority("s1", "e1", 0).snapshot } });
    ws.serverSend({ type: "event", payload: { type: "message_start", sessionId: "s1", epoch: "e1", eventId: 1, streamId: "u", messageId: "u", message: { role: "user", content: "prior" } } });
    ws.serverSend({ type: "event", payload: { type: "message_end", sessionId: "s1", epoch: "e1", eventId: 2, streamId: "u", messageId: "u", entryId: "prior", message: { role: "user", content: "prior" } } });
    const submit = await admitted(h, ws, 2);
    const controller = h.controller("s1")!;
    const history = controller.getSnapshot();
    const authority = idleAuthority("s1", "e1", 2);
    authority.snapshot.state.isStreaming = true;
    authority.snapshot.state.leafId = "external-branch";
    authority.snapshot.streaming = { active: true, phase: "streaming", streamId: "external", messageId: "external", partialMessage: { role: "assistant", content: [], provider: "openai", model: "gpt-6.1-sol" } };
    authority.snapshot.capabilities.capabilities.push("runtime.follow_up");
    ws.serverSend(terminal(submit.payload.operationId, authority));
    expect(controller.getSnapshot().snapshot).toEqual(authority.snapshot);
    expect(controller.getSnapshot().historyGeneration).toBe(history.historyGeneration);
    expect(controller.getSnapshot().historyAnchorLeafId).toBe(history.historyAnchorLeafId);
    expect(controller.getSnapshot().liveEntries).toEqual(history.liveEntries);
    expect(controller.getSnapshot().turnActive).toBe(false);
    expect(controller.getSnapshot().snapshot?.state.isStreaming).toBe(true);
    h.dispose();
  });

  it("terminal authority runs existing capability-loss cleanup and a late extension reply cannot settle twice", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    const submit = await admitted(h, ws, 2);
    const controller = h.controller("s1")!;
    const extended = idleAuthority("s1", "e1", 2);
    extended.snapshot.capabilities.capabilities.push("runtime.extension_ui");
    const request = { id: "confirm", method: "confirm" as const, title: "Confirm", message: "Continue?" };
    extended.snapshot.state.pendingExtensionUi = [request];
    ws.serverSend({ type: "snapshot", payload: { ...snapshotPayload({ lastEventId: 2 }), snapshot: extended.snapshot } });
    let settlements = 0;
    const reply = controller.respondExtensionUi(request, { responseKind: "confirmed", confirmed: true }).catch((error: unknown) => { settlements += 1; return error; });
    await flush();
    const command = lastFrame<{ type: string; id: string; payload: { command: { commandId: string } } }>(ws, "command")!;
    expect(controller.getSnapshot().extensionUiReplyPending).toBe(true);
    ws.serverSend(terminal(submit.payload.operationId, idleAuthority("s1", "e1", 2)));
    await expect(reply).resolves.toMatchObject({ code: "unsupported_capability" });
    expect(controller.getSnapshot().extensionUiReplyPending).toBe(false);
    ws.serverSend({ type: "response", id: command.id, payload: { ok: true, result: { commandId: command.payload.command.commandId, result: { ok: true, type: "extension_ui_response" } } } });
    await flush();
    expect(settlements).toBe(1);
    h.dispose();
  });

  it("wrong session/epoch/turn/operation and old transport generation cannot replace or settle exact pending", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    ws.serverSend({ type: "snapshot", payload: snapshotPayload({ lastEventId: 2 }) });
    const submit = await admitted(h, ws, 2);
    const controller = h.controller("s1")!;
    const frame = terminal(submit.payload.operationId, idleAuthority("s1", "e1", 2));
    const before = controller.getSnapshot();
    const generation = h.connection.currentGeneration;
    controller.onTurnStatus(frame, generation - 1);
    for (const status of [{ ...frame.payload, sessionId: "other" }, { ...frame.payload, epoch: "other" }, { ...frame.payload, operationId: "other" }, { ...frame.payload, turnId: "other" }]) controller.onTurnStatus({ ...frame, payload: status }, generation);
    expect(controller.getSnapshot()).toBe(before);
    // A stale authority cursor cannot overwrite the running truth, but the
    // exact current terminal still settles its operation normally.
    controller.onTurnStatus(terminal(submit.payload.operationId, idleAuthority("s1", "e1", 1)), generation);
    expect(controller.getSnapshot().turnActive).toBe(false);
    expect((controller as unknown as { lastEventId: number }).lastEventId).toBe(2);
    expect(controller.getSnapshot().snapshot?.state.isPromptRunning).toBe(true);
    h.dispose();
  });
});
