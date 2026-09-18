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
import { createHarness, flush, lastFrame, snapshotPayload, type RuntimeHarness } from "./testing/harness";
import type { FakeWebSocket } from "./testing/harness";
import type { SubmitTurnAdmission } from "@fffattiger/pix-protocol";

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

describe("SessionStore — Phase 3 negotiated submit-turn", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("negotiates the feature and routes sendPrompt through submit_turn, never the command slot", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    expect(h.store.getSnapshot().submitTurnEnabled).toBe(true);

    const sendP = h.store.sendPrompt("hello");
    await flush();
    const submit = lastFrame<{ type: string; id: string; payload: { sessionId: string; operationId: string; prompt: string; expectedEpoch: string; expectedRevision: number } }>(ws, "submit_turn")!;
    expect(submit).toBeTruthy();
    expect(submit.payload.sessionId).toBe("s1");
    expect(submit.payload.prompt).toBe("hello");
    expect(submit.payload.operationId).toMatch(/^op:/);
    // Same-session submit carries the epoch fence.
    expect(submit.payload.expectedEpoch).toBe("e1");
    expect(submit.payload.expectedRevision).toBe(0);
    // NO ordinary command frame rides the mutation slot.
    expect(lastFrame(ws, "command")).toBeUndefined();
    expect(h.store.getSnapshot().turnActive).toBe(true);
    expect(h.store.getSnapshot().turnDelivery).toBe("in_flight");

    ws.serverSend({ type: "submit_turn_result", id: submit.id, payload: acceptedAdmission(h, submit.payload.operationId) });
    await flush();
    await expect(sendP).resolves.toBeTruthy();
    expect(h.store.getSnapshot().turnDelivery).toBe("accepted");
    expect(h.store.getSnapshot().turnActive).toBe(true);
  });

  it("accepted turn keeps the optimistic bubble until authority correlation and does NOT occupy pendingCommand; reads stay independent", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    const sendP = h.store.sendPrompt("hello");
    await flush();
    const submit = lastFrame<{ type: string; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    ws.serverSend({ type: "submit_turn_result", id: submit.id, payload: acceptedAdmission(h, submit.payload.operationId) });
    await flush();
    await expect(sendP).resolves.toBeTruthy();

    // Bubble retained (accepted), never fabricated terminal data.
    expect(h.store.getSnapshot().optimisticEntries.map((e) => e.entry.message)).toContainEqual({ role: "user", content: "hello" });
    // The turn does NOT occupy pendingCommand: a get_commands read (dedicated
    // read lane) still works while the turn is active.
    const toolsP = h.store.getCommands();
    await flush();
    const readFrame = lastFrame<{ type: string; id: string; payload: { sessionId: string; epoch: string; read: { type: string } } }>(ws, "read")!;
    expect(readFrame).toBeTruthy();
    expect(readFrame.payload.read.type).toBe("get_commands");
    ws.serverSend({ type: "read_result", id: readFrame.id, payload: { sessionId: "s1", epoch: "e1", requestId: readFrame.id, result: { ok: true, type: "get_commands", commands: [] } } });
    await expect(toolsP).resolves.toEqual([]);

    // A conflicting ordinary MUTATION command rejects session_busy while the turn is active.
    await expect(h.store.sendCommand({ commandId: "bash-1", type: "bash", command: "ls", excludeFromContext: false })).rejects.toMatchObject({ code: "session_busy" });

    // Terminal status clears the slot and publishes the terminal signal.
    let terminal: unknown;
    h.store.subscribeTurnTerminal((info) => { terminal = info; });
    ws.serverSend({ type: "turn_status", payload: { sessionId: "s1", epoch: "e1", operationId: submit.payload.operationId, turnId: "turn-1", revision: 1, state: "completed" } });
    await flush();
    expect(h.store.getSnapshot().turnActive).toBe(false);
    expect(h.store.getSnapshot().turnDelivery).toBe(null);
    expect(terminal).toMatchObject({ sessionId: "s1", state: "completed" });
  });

  it("not_delivered removes the optimistic bubble and rejects tagged phase=activation (draft restored, staging preserved)", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    const sendP = h.store.sendPrompt("hello");
    await flush();
    const submit = lastFrame<{ type: string; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    ws.serverSend({
      type: "submit_turn_result",
      id: submit.id,
      payload: { status: "rejected", delivery: "not_delivered", sessionId: "s1", operationId: submit.payload.operationId, error: { code: "epoch_changed", message: "session epoch changed", retryable: false } },
    });
    await flush();
    await expect(sendP).rejects.toMatchObject({ code: "epoch_changed", phase: "activation" });
    expect(h.store.getSnapshot().turnActive).toBe(false);
    expect(h.store.getSnapshot().optimisticEntries).toEqual([]);
  });

  it("uncertain retains the bubble and rejects retryable (never overwrites a newer draft)", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    const sendP = h.store.sendPrompt("hello");
    await flush();
    const submit = lastFrame<{ type: string; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    ws.serverSend({
      type: "submit_turn_result",
      id: submit.id,
      payload: { status: "rejected", delivery: "uncertain", sessionId: "s1", operationId: submit.payload.operationId, error: { code: "timeout", message: "admission timed out", retryable: true } },
    });
    await flush();
    await expect(sendP).rejects.toMatchObject({ code: "timeout", retryable: true });
    expect(h.store.getSnapshot().turnActive).toBe(false);
    expect(h.store.getSnapshot().optimisticEntries.map((e) => e.entry.message)).toContainEqual({ role: "user", content: "hello" });
  });

  it("same-epoch reconnect resends the SAME operationId + payload on a fresh envelope", async () => {
    const h = createHarness();
    let ws = await openAndAttachTurn(h);
    const sendP = h.store.sendPrompt("hello");
    await flush();
    const submit1 = lastFrame<{ type: string; id: string; payload: { operationId: string; prompt: string } }>(ws, "submit_turn")!;
    const operationId = submit1.payload.operationId;
    // Transport loss → reconnect.
    ws.serverClose(1006);
    vi.advanceTimersByTime(250);
    ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackSubmitTurn());
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1", epoch: "e1", resumeStatus: "snapshot" }) });
    await flush();
    const submit2 = lastFrame<{ type: string; id: string; payload: { operationId: string; prompt: string } }>(ws, "submit_turn")!;
    expect(submit2.payload.operationId).toBe(operationId);
    expect(submit2.payload.prompt).toBe("hello");
    expect(submit2.id).not.toBe(submit1.id);
    // duplicate+accepted re-opens the subscription and resolves the promise.
    ws.serverSend({ type: "submit_turn_result", id: submit2.id, payload: { ...acceptedAdmission(h, operationId), status: "duplicate", delivery: "accepted" } });
    await expect(sendP).resolves.toBeTruthy();
  });

  it.each([
    ["the initial created-authority frame", false],
    ["one repaired retry frame", true],
  ] as const)("detached pending B from %s does not resend on A reconnect and waits for the exact B lease", async (_label, repairBeforeLoss) => {
    const h = createHarness();
    let ws = await openAndAttachTurn(h, "resume-a", "eA");
    await createSeededSession(h, ws, { sessionId: "pending-b-reconnect", epoch: "eB", revision: 1 });
    const sendP = h.store.sendPromptToSession("pending-b-reconnect", "possibly delivered B");
    await flush();
    const first = submitFrames(ws)[0]!;
    let expectedRevision = 1;
    if (repairBeforeLoss) {
      ws.serverSend({
        type: "submit_turn_result",
        id: first.id,
        payload: { status: "rejected", delivery: "not_delivered", sessionId: "pending-b-reconnect", operationId: first.payload.operationId, epoch: "eB", revision: 2, error: { code: "conflict", message: "repair before loss", retryable: false } },
      });
      await flush();
      expectedRevision = 2;
    }

    ws.serverClose(1006);
    vi.advanceTimersByTime(250);
    ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackSubmitTurn());
    await flush();
    const resumeA = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    expect(resumeA.payload.sessionId).toBe("resume-a");
    ws.serverSend({ type: "snapshot", id: resumeA.id, payload: snapshotPayload({ sessionId: "resume-a", epoch: "eA", resumeStatus: "snapshot" }) });
    await flush();
    expect(submitFrames(ws)).toHaveLength(0);
    expect(h.controller("pending-b-reconnect")?.evictionProtection.turnInFlight).toBe(true);

    const openB = h.store.openSession("pending-b-reconnect");
    await flush();
    const detachA = lastFrame<{ type: string; id: string }>(ws, "detach")!;
    ws.serverSend({ type: "response", id: detachA.id, payload: { ok: true, result: { sessionId: "resume-a", detached: true } } });
    await flush();
    const attachB = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachB.id, payload: snapshotPayload({ sessionId: "pending-b-reconnect", epoch: "eB", lastEventId: expectedRevision, resumeStatus: "snapshot" }) });
    await openB;
    await flush();
    const resent = submitFrames(ws)[0]!;
    expect(resent.payload.operationId).toBe(first.payload.operationId);
    expect(resent.payload.expectedRevision).toBe(expectedRevision);
    ws.serverSend({ type: "submit_turn_result", id: resent.id, payload: acceptedAdmissionFor("pending-b-reconnect", resent.payload.operationId as string, "eB", "turn-b", expectedRevision) });
    await expect(sendP).resolves.toBeTruthy();
  });

  it("epoch change after possible delivery NEVER resends; in-flight admission becomes uncertain", async () => {
    const h = createHarness();
    let ws = await openAndAttachTurn(h);
    const sendP = h.store.sendPrompt("hello");
    await flush();
    const submit1 = lastFrame<{ type: string; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    const operationId = submit1.payload.operationId;
    ws.serverClose(1006);
    vi.advanceTimersByTime(250);
    ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackSubmitTurn());
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1", epoch: "e2", resumeStatus: "epoch_changed" }) });
    await flush();
    // No resend of the same operation on the new epoch.
    expect(lastFrame(ws, "submit_turn")).toBeUndefined();
    await expect(sendP).rejects.toMatchObject({ code: "epoch_changed", retryable: true });
    // Bubble retained (uncertain, may have been delivered).
    expect(h.store.getSnapshot().optimisticEntries.map((e) => e.entry.message)).toContainEqual({ role: "user", content: "hello" });
    void operationId;
  });

  it("strict matching: wrong/late admission and status frames are dropped and never settle the turn", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    let settled = false;
    const sendP = h.store.sendPrompt("hello").then(() => { settled = true; }, () => { settled = true; });
    await flush();
    const submit = lastFrame<{ type: string; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    // Wrong envelope id → dropped.
    ws.serverSend({ type: "submit_turn_result", id: "wrong-envelope", payload: acceptedAdmission(h, submit.payload.operationId) });
    await flush();
    expect(settled).toBe(false);
    // Right envelope, wrong operationId → dropped.
    ws.serverSend({ type: "submit_turn_result", id: submit.id, payload: acceptedAdmission(h, "op:other") });
    await flush();
    expect(settled).toBe(false);
    // Right envelope + operation → resolves.
    ws.serverSend({ type: "submit_turn_result", id: submit.id, payload: acceptedAdmission(h, submit.payload.operationId) });
    await flush();
    expect(settled).toBe(true);
    await sendP;

    // A status push for a WRONG session/operation is dropped.
    ws.serverSend({ type: "turn_status", payload: { sessionId: "other-session", epoch: "e1", operationId: submit.payload.operationId, turnId: "turn-1", revision: 1, state: "completed" } });
    ws.serverSend({ type: "turn_status", payload: { sessionId: "s1", epoch: "e1", operationId: "op:other", turnId: "turn-1", revision: 1, state: "completed" } });
    await flush();
    expect(h.store.getSnapshot().turnActive).toBe(true);
    // Correct status (revision > admission's 0) terminates the turn.
    ws.serverSend({ type: "turn_status", payload: { sessionId: "s1", epoch: "e1", operationId: submit.payload.operationId, turnId: "turn-1", revision: 1, state: "completed" } });
    await flush();
    expect(h.store.getSnapshot().turnActive).toBe(false);
  });

  it("stale status revision is dropped (never regresses a terminal turn)", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    const sendP = h.store.sendPrompt("hello");
    await flush();
    const submit = lastFrame<{ type: string; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    ws.serverSend({ type: "submit_turn_result", id: submit.id, payload: acceptedAdmission(h, submit.payload.operationId) });
    await flush();
    await sendP;
    // Terminal at revision 1.
    ws.serverSend({ type: "turn_status", payload: { sessionId: "s1", epoch: "e1", operationId: submit.payload.operationId, turnId: "turn-1", revision: 1, state: "completed" } });
    await flush();
    expect(h.store.getSnapshot().turnActive).toBe(false);
    // A late stale revision 0 must not resurrect the turn.
    ws.serverSend({ type: "turn_status", payload: { sessionId: "s1", epoch: "e1", operationId: submit.payload.operationId, turnId: "turn-1", revision: 0, state: "running" } });
    await flush();
    expect(h.store.getSnapshot().turnActive).toBe(false);
  });

  it("second submit while a turn is active rejects session_busy (single PendingTurn)", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    const sendP = h.store.sendPrompt("first");
    await flush();
    const submit = lastFrame<{ type: string; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    await expect(h.store.sendPrompt("second")).rejects.toMatchObject({ code: "session_busy" });
    ws.serverSend({ type: "submit_turn_result", id: submit.id, payload: acceptedAdmission(h, submit.payload.operationId) });
    await expect(sendP).resolves.toBeTruthy();
  });

  it("create is identity-only; first negotiated sendPromptToSession carries the exact create-result epoch/revision + activationOverrides, then attaches after admission", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackSubmitTurn());
    await flush();
    expect(h.store.getSnapshot().submitTurnEnabled).toBe(true);

    // Identity-only create: resolves immediately, zero attach, current state untouched.
    const createP = h.store.createSession({ cwd: "/x", projectRoot: "/x" });
    await flush();
    const createFrame = lastFrame<{ type: string; id: string; payload: Record<string, unknown> }>(ws, "create")!;
    expect(Object.keys(createFrame.payload).sort()).toEqual(["createRequestId", "cwd", "projectRoot"]);
    ws.serverSend({
      type: "response",
      id: createFrame.id,
      payload: { ok: true, result: { sessionId: "new-1", epoch: "eN", lastEventId: 1, created: true, cwd: "/x", projectRoot: "/x", snapshot: snapshotPayload({ sessionId: "new-1" }).snapshot } },
    });
    await expect(createP).resolves.toEqual({ sessionId: "new-1" });
    expect(ws.sent.filter((f) => (f as { type: string }).type === "attach")).toHaveLength(0);
    expect(h.store.getSnapshot().attached).toBe(false);

    // First negotiated submit to the new live-but-unattached session uses the
    // EXACT create-result epoch + authority-issued cursor and activationOverrides.
    const sendP = h.store.sendPromptToSession("new-1", "first message", undefined, {
      model: { provider: "anthropic", modelId: "claude-opus-4" },
      thinkingLevel: "high",
    });
    await flush();
    const submit = lastFrame<{ type: string; id: string; payload: { sessionId: string; expectedEpoch: string; expectedRevision: number; activationOverrides?: { model?: { provider: string; modelId: string }; thinkingLevel?: string }; operationId: string } }>(ws, "submit_turn")!;
    expect(submit).toBeTruthy();
    expect(submit.payload.sessionId).toBe("new-1");
    expect(submit.payload.expectedEpoch).toBe("eN");
    expect(submit.payload.expectedRevision).toBe(1);
    expect(submit.payload.activationOverrides).toEqual({ model: { provider: "anthropic", modelId: "claude-opus-4" }, thinkingLevel: "high" });
    // NO set_model / set_thinking_level command frames on the negotiated path.
    expect(ws.sent.filter((f) => (f as { payload?: { command?: { type?: string } } }).payload?.command?.type === "set_model")).toHaveLength(0);
    expect(ws.sent.filter((f) => (f as { payload?: { command?: { type?: string } } }).payload?.command?.type === "set_thinking_level")).toHaveLength(0);

    // Accepted admission resolves; ONLY then may the store attach the new session.
    const admission = {
      status: "accepted",
      delivery: "accepted",
      sessionId: "new-1",
      epoch: "eN",
      revision: 1,
      operationId: submit.payload.operationId,
      turnId: "turn-1",
      snapshot: snapshotPayload({ sessionId: "new-1", epoch: "eN" }).snapshot,
      turnStatus: { sessionId: "new-1", epoch: "eN", operationId: submit.payload.operationId, turnId: "turn-1", revision: 0, state: "admitted" },
    };
    ws.serverSend({ type: "submit_turn_result", id: submit.id, payload: admission });
    await expect(sendP).resolves.toBeTruthy();
    await flush();
    // After admission the store may begin attach observation of the new session.
    const attach = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    expect(attach.payload.sessionId).toBe("new-1");
    ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "new-1", epoch: "eN" }) });
    await flush();
    expect(h.store.getSnapshot().attached).toBe(true);
    expect(h.store.getSnapshot().sessionId).toBe("new-1");
  });

  it("keeps A attached while B owns exact admission/optimism, allows independent A turn, then retains A after lease transfer", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h, "A", "eA");
    await createSeededSession(h, ws, { sessionId: "B", epoch: "eB", revision: 1 });
    const sendB = h.store.sendPromptToSession("B", "prompt B");
    await flush();
    const submitB = submitFrames(ws).at(-1)!;
    const controllerB = h.controller("B")!;
    expect(h.store.getSnapshot()).toMatchObject({ attached: true, sessionId: "A" });
    expect(controllerB.getSnapshot()).toMatchObject({ optimisticRunningSessionId: "B", turnActive: true });
    expect(controllerB.getSnapshot().optimisticEntries.map((entry) => entry.sessionId)).toEqual(["B"]);

    // Per-controller lane independence: A and B may own the same logical lane concurrently.
    const sendA = h.store.sendPrompt("concurrent A");
    await flush();
    const submitA = submitFrames(ws).find((frame) => frame.payload.sessionId === "A")!;
    expect(submitA).toBeTruthy();
    expect(h.controller("A")?.evictionProtection.turnInFlight).toBe(true);
    expect(controllerB.evictionProtection.turnInFlight).toBe(true);
    ws.serverSend({ type: "submit_turn_result", id: submitA.id, payload: acceptedAdmissionFor("A", submitA.payload.operationId as string, "eA", "turn-A", 0) });
    await expect(sendA).resolves.toBeTruthy();

    ws.serverSend({ type: "submit_turn_result", id: submitB.id, payload: acceptedAdmissionFor("B", submitB.payload.operationId as string, "eB", "turn-B", 1) });
    await expect(sendB).resolves.toBeTruthy();
    await flush();
    const detachA = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "detach")!;
    ws.serverSend({ type: "response", id: detachA.id, payload: { ok: true, result: { sessionId: "A", detached: true } } });
    await flush();
    const attachB = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachB.id, payload: snapshotPayload({ sessionId: "B", epoch: "eB", lastEventId: 1 }) });
    await flush();
    expect(h.store.getSnapshot()).toMatchObject({ attached: true, sessionId: "B" });
    expect(h.controller("A")?.getSnapshot()).toMatchObject({ attached: false, sessionId: "A", epoch: "eA" });
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "stop")).toHaveLength(0);
  });

  it("repairs a stale created seed once with the same logical turn, then accepts and attaches normally", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackSubmitTurn());
    await flush();
    await createSeededSession(h, ws, { sessionId: "new-repair", epoch: "eN", revision: 1 });

    let settled = false;
    const images = [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" as const }];
    const sendP = h.store.sendPromptToSession("new-repair", "same logical prompt", images, {
      model: { provider: "anthropic", modelId: "claude-opus-4" },
      thinkingLevel: "high",
    });
    void sendP.then(() => { settled = true; }, () => { settled = true; });
    await flush();
    const first = submitFrames(ws)[0]!;
    expect(first.payload).toMatchObject({
      sessionId: "new-repair",
      prompt: "same logical prompt",
      images,
      activationOverrides: { model: { provider: "anthropic", modelId: "claude-opus-4" }, thinkingLevel: "high" },
      expectedEpoch: "eN",
      expectedRevision: 1,
    });

    ws.serverSend({
      type: "submit_turn_result",
      id: first.id,
      payload: {
        status: "rejected",
        delivery: "not_delivered",
        sessionId: "new-repair",
        operationId: first.payload.operationId,
        epoch: "eN",
        revision: 2,
        error: { code: "conflict", message: "opaque authority text", retryable: false },
      },
    });
    await flush();

    const frames = submitFrames(ws);
    expect(frames).toHaveLength(2);
    const retry = frames[1]!;
    expect(retry.id).not.toBe(first.id);
    expect(retry.payload).toEqual({ ...first.payload, expectedRevision: 2 });
    expect(retry.payload.operationId).toBe(first.payload.operationId);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "attach")).toHaveLength(0);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "detach")).toHaveLength(0);
    expect(h.controller("new-repair")?.getSnapshot().optimisticEntries).toHaveLength(1);
    expect(settled).toBe(false);

    ws.serverSend({
      type: "submit_turn_result",
      id: retry.id,
      payload: acceptedAdmissionFor("new-repair", retry.payload.operationId as string, "eN", "turn-repair", 2),
    });
    await expect(sendP).resolves.toBeTruthy();
    await flush();
    const attach = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    expect(attach.payload.sessionId).toBe("new-repair");
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "attach")).toHaveLength(1);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "detach")).toHaveLength(0);
    ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "new-repair", epoch: "eN", lastEventId: 2 }) });
    await flush();
    expect(h.store.getSnapshot()).toMatchObject({ attached: true, sessionId: "new-repair" });
  });

  it("drops a replayed old-attempt conflict after repair minted a fresh envelope", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackSubmitTurn());
    await flush();
    await createSeededSession(h, ws, { sessionId: "old-replay", epoch: "eN", revision: 1 });

    let settled = false;
    const sendP = h.store.sendPromptToSession("old-replay", "one logical turn");
    void sendP.then(() => { settled = true; }, () => { settled = true; });
    await flush();
    const first = submitFrames(ws)[0]!;
    const firstConflict = {
      status: "rejected",
      delivery: "not_delivered",
      sessionId: "old-replay",
      operationId: first.payload.operationId,
      epoch: "eN",
      revision: 2,
      error: { code: "conflict", message: "first", retryable: false },
    };
    ws.serverSend({ type: "submit_turn_result", id: first.id, payload: firstConflict });
    await flush();
    const retry = submitFrames(ws)[1]!;

    // The old envelope/generation is no longer the pending transport identity.
    // Even a replay claiming a newer authority cursor is completely inert.
    ws.serverSend({ type: "submit_turn_result", id: first.id, payload: { ...firstConflict, revision: 99 } });
    await flush();
    expect(submitFrames(ws)).toHaveLength(2);
    expect(lastFrame<{ type: string; id: string; payload: Record<string, unknown> }>(ws, "submit_turn")).toEqual(retry);
    expect(retry.payload.expectedRevision).toBe(2);
    expect(h.controller("old-replay")?.getSnapshot().optimisticEntries).toHaveLength(1);
    expect(settled).toBe(false);

    ws.serverSend({
      type: "submit_turn_result",
      id: retry.id,
      payload: acceptedAdmissionFor("old-replay", retry.payload.operationId as string, "eN", "turn-old-replay", 2),
    });
    await expect(sendP).resolves.toBeTruthy();
    await flush();
    const attach = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "old-replay", epoch: "eN", lastEventId: 2 }) });
    await flush();
  });

  it("settles definite non-delivery exactly once when the automatic repair resend throws, retaining the advanced seed", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackSubmitTurn());
    await flush();
    await createSeededSession(h, ws, { sessionId: "repair-send-throw", epoch: "eN", revision: 1 });

    let settlements = 0;
    const sendP = h.store.sendPromptToSession("repair-send-throw", "same intent");
    void sendP.then(() => { settlements += 1; }, () => { settlements += 1; });
    await flush();
    const first = submitFrames(ws)[0]!;
    expect(h.controller("repair-send-throw")?.getSnapshot().optimisticEntries).toHaveLength(1);

    const originalSend = ws.send.bind(ws);
    ws.send = () => { throw { code: "unavailable", message: "synthetic repair send failure", retryable: false }; };
    ws.serverSend({
      type: "submit_turn_result",
      id: first.id,
      payload: { status: "rejected", delivery: "not_delivered", sessionId: "repair-send-throw", operationId: first.payload.operationId, epoch: "eN", revision: 2, error: { code: "conflict", message: "advance before send", retryable: false } },
    });
    await flush();

    expect(submitFrames(ws)).toHaveLength(1);
    await expect(sendP).rejects.toMatchObject({ code: "unavailable" });
    expect(settlements).toBe(1);
    expect(h.store.getSnapshot().turnActive).toBe(false);
    expect(h.store.getSnapshot().optimisticEntries).toEqual([]);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "attach")).toHaveLength(0);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "detach")).toHaveLength(0);

    ws.send = originalSend;
    const manualP = h.store.sendPromptToSession("repair-send-throw", "same intent");
    await flush();
    const manual = submitFrames(ws)[1]!;
    expect(manual.payload.expectedRevision).toBe(2);
    expect(manual.payload.operationId).not.toBe(first.payload.operationId);
    ws.serverSend({
      type: "submit_turn_result",
      id: manual.id,
      payload: { status: "rejected", delivery: "not_delivered", sessionId: "repair-send-throw", operationId: manual.payload.operationId, error: { code: "not_found", message: "cleanup", retryable: false } },
    });
    await expect(manualP).rejects.toMatchObject({ code: "not_found" });
    expect(settlements).toBe(1);
  });

  it("preserves a pending B turn when attached A transfers the exact lease to B before admission", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h, "attached-a", "eA");
    await createSeededSession(h, ws, { sessionId: "target-b", epoch: "eB", revision: 1 });
    const sendP = h.store.sendPromptToSession("target-b", "turn for B");
    await flush();
    const first = submitFrames(ws)[0]!;
    const openB = h.store.openSession("target-b");
    await flush();
    const detachA = lastFrame<{ type: string; id: string }>(ws, "detach")!;
    ws.serverSend({ type: "response", id: detachA.id, payload: { ok: true, result: { sessionId: "attached-a", detached: true } } });
    await flush();
    const attachB = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    expect(attachB.payload.sessionId).toBe("target-b");
    ws.serverSend({ type: "snapshot", id: attachB.id, payload: snapshotPayload({ sessionId: "target-b", epoch: "eB", lastEventId: 2 }) });
    await openB;
    expect(h.controller("target-b")?.evictionProtection.turnInFlight).toBe(true);

    ws.serverSend({ type: "submit_turn_result", id: first.id, payload: { status: "rejected", delivery: "not_delivered", sessionId: "target-b", operationId: first.payload.operationId, epoch: "eB", revision: 2, error: { code: "conflict", message: "stale create cursor", retryable: false } } });
    await flush();
    const retry = submitFrames(ws)[1]!;
    expect(retry.payload).toEqual({ ...first.payload, expectedRevision: 2 });
    ws.serverSend({ type: "submit_turn_result", id: retry.id, payload: acceptedAdmissionFor("target-b", retry.payload.operationId as string, "eB", "turn-b", 2) });
    await expect(sendP).resolves.toBeTruthy();
    expect(h.store.getSnapshot()).toMatchObject({ attached: true, sessionId: "target-b" });
    expect(h.controller("attached-a")?.getSnapshot().attached).toBe(false);
  });

  it("opening unrelated C does not settle pending B; exact B rejection settles only B while C remains held", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h, "attached-a", "eA");
    await createSeededSession(h, ws, { sessionId: "pending-b", epoch: "eB", revision: 1 });
    let settlements = 0;
    const sendP = h.store.sendPromptToSession("pending-b", "turn for B");
    void sendP.then(() => { settlements += 1; }, () => { settlements += 1; });
    await flush();
    const first = submitFrames(ws)[0]!;

    const openC = h.store.openSession("unrelated-c");
    await flush();
    const detachA = lastFrame<{ type: string; id: string }>(ws, "detach")!;
    ws.serverSend({ type: "response", id: detachA.id, payload: { ok: true, result: { sessionId: "attached-a", detached: true } } });
    await flush();
    const attachC = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachC.id, payload: snapshotPayload({ sessionId: "unrelated-c", epoch: "eC" }) });
    await openC;
    expect(settlements).toBe(0);
    expect(h.controller("pending-b")?.evictionProtection.turnInFlight).toBe(true);

    ws.serverSend({ type: "submit_turn_result", id: first.id, payload: { status: "rejected", delivery: "not_delivered", sessionId: "pending-b", operationId: first.payload.operationId, error: { code: "not_found", message: "B rejected", retryable: false } } });
    await expect(sendP).rejects.toMatchObject({ code: "not_found" });
    expect(settlements).toBe(1);
    expect(h.store.getSnapshot()).toMatchObject({ attached: true, sessionId: "unrelated-c" });
  });

  it.each([
    ["before the first conflict", "before_conflict"],
    ["after retry mint and before retry acceptance", "after_retry"],
  ] as const)("preserves created-seed repair when a same-session attach lands %s", async (_label, attachTiming) => {
    const h = createHarness();
    h.store.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackSubmitTurn());
    await flush();
    const sessionId = `attach-${attachTiming}`;
    await createSeededSession(h, ws, { sessionId, epoch: "eN", revision: 1 });

    let settlements = 0;
    const sendP = h.store.sendPromptToSession(sessionId, "one attach-interleaved turn");
    void sendP.then(() => { settlements += 1; }, () => { settlements += 1; });
    await flush();
    const first = submitFrames(ws)[0]!;

    const landSameSessionAttach = async (): Promise<void> => {
      const openP = h.store.openSession(sessionId);
      await flush();
      const attach = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "attach")!;
      expect(attach.payload.sessionId).toBe(sessionId);
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId, epoch: "eN", lastEventId: 2 }) });
      await flush();
      await openP;
    };

    if (attachTiming === "before_conflict") await landSameSessionAttach();
    ws.serverSend({
      type: "submit_turn_result",
      id: first.id,
      payload: { status: "rejected", delivery: "not_delivered", sessionId, operationId: first.payload.operationId, epoch: "eN", revision: 2, error: { code: "conflict", message: "same epoch", retryable: false } },
    });
    await flush();
    const retry = submitFrames(ws)[1]!;
    expect(retry.payload).toEqual({ ...first.payload, expectedRevision: 2 });
    if (attachTiming === "after_retry") await landSameSessionAttach();

    expect(submitFrames(ws)).toHaveLength(2);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "attach")).toHaveLength(1);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "detach")).toHaveLength(0);
    expect(h.store.getSnapshot()).toMatchObject({ attached: true, sessionId, turnActive: true, turnDelivery: "in_flight" });
    expect(h.store.getSnapshot().optimisticEntries).toHaveLength(1);
    expect(settlements).toBe(0);

    ws.serverSend({
      type: "submit_turn_result",
      id: retry.id,
      payload: acceptedAdmissionFor(sessionId, retry.payload.operationId as string, "eN", `turn-${attachTiming}`, 2),
    });
    await expect(sendP).resolves.toBeTruthy();
    await flush();
    expect(settlements).toBe(1);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "attach")).toHaveLength(1);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "detach")).toHaveLength(0);
  });

  it("bounds created-seed repair to one resend, advances the latest seed, and manual retry mints a new operation", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackSubmitTurn());
    await flush();
    await createSeededSession(h, ws, { sessionId: "new-bounded", epoch: "eN", revision: 1 });

    const sendP = h.store.sendPromptToSession("new-bounded", "first logical turn");
    await flush();
    const first = submitFrames(ws)[0]!;
    ws.serverSend({
      type: "submit_turn_result",
      id: first.id,
      payload: { status: "rejected", delivery: "not_delivered", sessionId: "new-bounded", operationId: first.payload.operationId, epoch: "eN", revision: 2, error: { code: "conflict", message: "first", retryable: false } },
    });
    await flush();
    const retry = submitFrames(ws)[1]!;
    ws.serverSend({
      type: "submit_turn_result",
      id: retry.id,
      payload: { status: "rejected", delivery: "not_delivered", sessionId: "new-bounded", operationId: retry.payload.operationId, epoch: "eN", revision: 3, error: { code: "conflict", message: "second", retryable: false } },
    });
    await flush();

    expect(submitFrames(ws)).toHaveLength(2);
    await expect(sendP).rejects.toMatchObject({ code: "conflict", phase: "activation" });
    expect(h.store.getSnapshot().optimisticEntries).toEqual([]);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "attach")).toHaveLength(0);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "detach")).toHaveLength(0);

    const manualP = h.store.sendPromptToSession("new-bounded", "first logical turn");
    await flush();
    const manual = submitFrames(ws)[2]!;
    expect(manual.payload.expectedEpoch).toBe("eN");
    expect(manual.payload.expectedRevision).toBe(3);
    expect(manual.payload.operationId).not.toBe(first.payload.operationId);
    ws.serverSend({
      type: "submit_turn_result",
      id: manual.id,
      payload: { status: "rejected", delivery: "not_delivered", sessionId: "new-bounded", operationId: manual.payload.operationId, error: { code: "not_found", message: "cleanup", retryable: false } },
    });
    await expect(manualP).rejects.toMatchObject({ code: "not_found" });
  });

  it("does not repair created seeds for malformed/stale authority, non-conflict, or uncertain rejection", async () => {
    const cases: Array<{ name: string; admission: Record<string, unknown> }> = [
      { name: "missing revision", admission: { delivery: "not_delivered", epoch: "eN", error: { code: "conflict", message: "x", retryable: false } } },
      { name: "wrong epoch", admission: { delivery: "not_delivered", epoch: "other", revision: 6, error: { code: "conflict", message: "x", retryable: false } } },
      { name: "equal revision", admission: { delivery: "not_delivered", epoch: "eN", revision: 5, error: { code: "conflict", message: "x", retryable: false } } },
      { name: "older revision", admission: { delivery: "not_delivered", epoch: "eN", revision: 4, error: { code: "conflict", message: "x", retryable: false } } },
      { name: "non-conflict", admission: { delivery: "not_delivered", epoch: "eN", revision: 6, error: { code: "session_busy", message: "x", retryable: true } } },
      { name: "uncertain", admission: { delivery: "uncertain", epoch: "eN", revision: 6, error: { code: "conflict", message: "x", retryable: true } } },
    ];

    for (const testCase of cases) {
      const h = createHarness();
      h.store.connect();
      const ws = h.lastSocket();
      ws.serverOpen();
      ws.serverSend(ackSubmitTurn());
      await flush();
      await createSeededSession(h, ws, { sessionId: `seed-${testCase.name}`, epoch: "eN", revision: 5 });
      const sendP = h.store.sendPromptToSession(`seed-${testCase.name}`, "negative");
      await flush();
      const first = submitFrames(ws)[0]!;
      ws.serverSend({
        type: "submit_turn_result",
        id: first.id,
        payload: { status: "rejected", sessionId: `seed-${testCase.name}`, operationId: first.payload.operationId, ...testCase.admission },
      });
      await flush();
      expect(submitFrames(ws), testCase.name).toHaveLength(1);
      await expect(sendP, testCase.name).rejects.toBeTruthy();

      const manualP = h.store.sendPromptToSession(`seed-${testCase.name}`, "manual");
      await flush();
      const manual = submitFrames(ws)[1]!;
      expect(manual.payload.expectedRevision, testCase.name).toBe(5);
      ws.serverSend({
        type: "submit_turn_result",
        id: manual.id,
        payload: { status: "rejected", delivery: "not_delivered", sessionId: `seed-${testCase.name}`, operationId: manual.payload.operationId, error: { code: "not_found", message: "cleanup", retryable: false } },
      });
      await expect(manualP).rejects.toBeTruthy();
    }
  });

  it("never repairs explicit/attached submissions, but repairs an unfenced live target exactly once", async () => {
    // Explicit source wins over an available seed and must not advance it.
    {
      const h = createHarness();
      h.store.connect();
      const ws = h.lastSocket();
      ws.serverOpen();
      ws.serverSend(ackSubmitTurn());
      await flush();
      await createSeededSession(h, ws, { sessionId: "explicit-seed", epoch: "eN", revision: 5 });
      const explicitP = h.store.submitTurn({ sessionId: "explicit-seed", prompt: "explicit", expectedEpoch: "eN", expectedRevision: 2 });
      await flush();
      const explicit = submitFrames(ws)[0]!;
      ws.serverSend({ type: "submit_turn_result", id: explicit.id, payload: { status: "rejected", delivery: "not_delivered", sessionId: "explicit-seed", operationId: explicit.payload.operationId, epoch: "eN", revision: 6, error: { code: "conflict", message: "x", retryable: false } } });
      await expect(explicitP).rejects.toBeTruthy();
      expect(submitFrames(ws)).toHaveLength(1);
      const manualP = h.store.sendPromptToSession("explicit-seed", "manual");
      await flush();
      const manual = submitFrames(ws)[1]!;
      expect(manual.payload.expectedRevision).toBe(5);
      ws.serverSend({ type: "submit_turn_result", id: manual.id, payload: { status: "rejected", delivery: "not_delivered", sessionId: "explicit-seed", operationId: manual.payload.operationId, error: { code: "not_found", message: "cleanup", retryable: false } } });
      await expect(manualP).rejects.toBeTruthy();
    }

    // Attached authority outranks the exact seed; detach proves the seed stayed at 5.
    {
      const h = createHarness();
      h.store.connect();
      const ws = h.lastSocket();
      ws.serverOpen();
      ws.serverSend(ackSubmitTurn());
      await flush();
      await createSeededSession(h, ws, { sessionId: "attached-seed", epoch: "eN", revision: 5 });
      const openP = h.store.openSession("attached-seed");
      await flush();
      const attach = lastFrame<{ type: string; id: string }>(ws, "attach")!;
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "attached-seed", epoch: "eN", lastEventId: 7 }) });
      await openP;
      const attachedP = h.store.sendPrompt("attached");
      await flush();
      const attached = submitFrames(ws)[0]!;
      expect(attached.payload.expectedRevision).toBe(7);
      ws.serverSend({ type: "submit_turn_result", id: attached.id, payload: { status: "rejected", delivery: "not_delivered", sessionId: "attached-seed", operationId: attached.payload.operationId, epoch: "eN", revision: 8, error: { code: "conflict", message: "x", retryable: false } } });
      await expect(attachedP).rejects.toBeTruthy();
      expect(submitFrames(ws)).toHaveLength(1);
      const detachP = h.store.detach();
      await flush();
      const detach = lastFrame<{ type: string; id: string }>(ws, "detach")!;
      ws.serverSend({ type: "response", id: detach.id, payload: { ok: true, result: { sessionId: "attached-seed", detached: true } } });
      await detachP;
      const manualP = h.store.sendPromptToSession("attached-seed", "manual");
      await flush();
      const manual = submitFrames(ws)[1]!;
      expect(manual.payload.expectedRevision).toBe(5);
      ws.serverSend({ type: "submit_turn_result", id: manual.id, payload: { status: "rejected", delivery: "not_delivered", sessionId: "attached-seed", operationId: manual.payload.operationId, error: { code: "not_found", message: "cleanup", retryable: false } } });
      await expect(manualP).rejects.toBeTruthy();
    }

    // A detached exact controller can discover that the target is already
    // live only when sessiond rejects the unfenced attempt as definitely not
    // delivered and returns the exact authority fence. The SAME operation is
    // retried once; another revision race fails closed without a third send.
    {
      const h = createHarness();
      h.store.connect();
      const ws = h.lastSocket();
      ws.serverOpen();
      ws.serverSend(ackSubmitTurn());
      await flush();
      const noneP = h.store.sendPromptToSession("unseeded", "none");
      await flush();
      const none = submitFrames(ws)[0]!;
      expect(none.payload.expectedEpoch).toBeUndefined();
      expect(none.payload.expectedRevision).toBeUndefined();
      ws.serverSend({ type: "submit_turn_result", id: none.id, payload: { status: "rejected", delivery: "not_delivered", sessionId: "unseeded", operationId: none.payload.operationId, epoch: "eN", revision: 9, error: { code: "conflict", message: "live session submit requires an epoch fence", retryable: false } } });
      await flush();
      const repaired = submitFrames(ws)[1]!;
      expect(repaired.payload.operationId).toBe(none.payload.operationId);
      expect(repaired.payload.expectedEpoch).toBe("eN");
      expect(repaired.payload.expectedRevision).toBe(9);
      ws.serverSend({ type: "submit_turn_result", id: repaired.id, payload: { status: "rejected", delivery: "not_delivered", sessionId: "unseeded", operationId: repaired.payload.operationId, epoch: "eN", revision: 10, error: { code: "conflict", message: "session revision changed", retryable: false } } });
      await expect(noneP).rejects.toMatchObject({ code: "conflict" });
      expect(submitFrames(ws)).toHaveLength(2);
    }
  });

  it("uses the created snapshot leaf as the first prompt's optimistic base and never treats admission as final", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackSubmitTurn());
    await flush();
    await createSeededSession(h, ws, { sessionId: "new-first", epoch: "eN", revision: 2, leafId: "config-leaf" });

    const sendP = h.store.sendPromptToSession("new-first", "first prompt");
    await flush();
    const optimistic = h.controller("new-first")!.getSnapshot().optimisticEntries[0]!;
    expect(optimistic.baseEntryId).toBe("config-leaf");
    const submit = lastFrame<{ type: string; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    const admission = acceptedAdmissionFor("new-first", submit.payload.operationId, "eN", "turn-first", 2);
    expect(admission.status).toBe("accepted");
    if (admission.status !== "accepted") throw new Error("test admission must be accepted");
    // Mixed-build defense: an older Worker may have mislabeled this exact
    // pre-turn config leaf as final on an admitted status. The Client ignores
    // it and keeps final identity unknown until user_committed/terminal.
    ws.serverSend({
      type: "submit_turn_result",
      id: submit.id,
      payload: { ...admission, turnStatus: { ...admission.turnStatus, finalLeafId: "config-leaf" } },
    });
    await expect(sendP).resolves.toBeTruthy();
    expect(h.controller("new-first")!.getSnapshot().optimisticEntries[0]!.identity).toMatchObject({
      operationId: submit.payload.operationId,
      userEntryId: null,
      finalLeafId: null,
    });
  });

  it("repairs an unknown optimistic base from the pre-prompt admission snapshot", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackSubmitTurn());
    await flush();

    const sendP = h.store.sendPromptToSession("cold-existing", "persist me once");
    await flush();
    const controller = h.controller("cold-existing")!;
    expect(controller.getSnapshot().optimisticEntries[0]!.baseEntryId).toBeNull();
    const submit = lastFrame<{ type: string; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    const admissionSnapshot = snapshotPayload({ sessionId: "cold-existing", epoch: "eC", lastEventId: 4 }).snapshot as { state: Record<string, unknown> };
    admissionSnapshot.state.leafId = "pre-prompt-leaf";
    const admission = acceptedAdmissionFor("cold-existing", submit.payload.operationId, "eC", "turn-cold", 4);
    ws.serverSend({ type: "submit_turn_result", id: submit.id, payload: { ...admission, snapshot: admissionSnapshot } });
    await expect(sendP).resolves.toBeTruthy();
    expect(controller.getSnapshot().optimisticEntries[0]!.baseEntryId).toBe("pre-prompt-leaf");
  });

  it("repairs an unknown optimistic base from a delayed same-epoch admission without replacing a newer snapshot", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackSubmitTurn());
    await flush();
    const open = h.store.openSession("s1");
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({
      type: "snapshot",
      id: attachFrame.id,
      payload: snapshotPayload({ sessionId: "s1", epoch: "e1", lastEventId: 14, model: { provider: "openai", id: "live-14" } }),
    });
    await open;
    const sendP = h.store.sendPrompt("second");
    await flush();
    const submit = lastFrame<{ type: "submit_turn"; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    expect(h.controller("s1")!.getSnapshot().optimisticEntries[0]!.baseEntryId).toBeNull();
    const delayedAdmission = {
      ...acceptedAdmissionFor("s1", submit.payload.operationId, "e1", "turn-2", 13),
      snapshot: snapshotPayload({ sessionId: "s1", epoch: "e1", lastEventId: 13, model: { provider: "openai", id: "stale-pre-prompt" } }).snapshot,
    };
    (delayedAdmission.snapshot as { state: Record<string, unknown> }).state.leafId = "pre-prompt-leaf";
    ws.serverSend({ type: "submit_turn_result", id: submit.id, payload: delayedAdmission });
    await expect(sendP).resolves.toBeTruthy();
    expect(h.controller("s1")!.getSnapshot().optimisticEntries[0]!.baseEntryId).toBe("pre-prompt-leaf");
    expect(h.controller("s1")!.getSnapshot().snapshot?.state.model).toEqual({ provider: "openai", id: "live-14" });
    h.dispose();
  });

  it("establishes the first history anchor from a same-epoch post-admission observation snapshot", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackSubmitTurn());
    await flush();
    await createSeededSession(h, ws, { sessionId: "new-anchor", epoch: "eN", revision: 2, leafId: "config-leaf" });

    const sendP = h.store.sendPromptToSession("new-anchor", "first prompt");
    await flush();
    const submit = lastFrame<{ type: string; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    const admission = acceptedAdmissionFor("new-anchor", submit.payload.operationId, "eN", "turn-anchor", 2);
    const admissionSnapshot = admission.snapshot as { state: Record<string, unknown> };
    admissionSnapshot.state.leafId = "config-leaf";
    ws.serverSend({ type: "submit_turn_result", id: submit.id, payload: admission });
    await expect(sendP).resolves.toBeTruthy();

    const controller = h.controller("new-anchor")!;
    expect(controller.getSnapshot().createdWithAutoThinking).toBe(true);
    expect(controller.getSnapshot().historyAnchorLeafId).toBeNull();
    const attach = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    const observation = snapshotPayload({ sessionId: "new-anchor", epoch: "eN", lastEventId: 3 }) as {
      snapshot: { state: Record<string, unknown> };
      [key: string]: unknown;
    };
    observation.snapshot.state.leafId = "committed-user-leaf";
    ws.serverSend({ type: "snapshot", id: attach.id, payload: observation });
    await flush();

    // Even though created authority makes this a same-epoch resume, the first
    // non-null observation leaf anchors HTTP history so commits that raced
    // ahead of attachment are not lost until a full page refresh.
    expect(controller.getSnapshot().historyAnchorLeafId).toBe("committed-user-leaf");
    expect(controller.getSnapshot().historyGeneration).toBe(1);
  });

  it("keeps the first committed turn visible across the second send and a same-epoch null-leaf snapshot", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackSubmitTurn());
    await flush();
    await createSeededSession(h, ws, { sessionId: "two-turn", epoch: "eN", revision: 1 });

    const firstP = h.store.sendPromptToSession("two-turn", "first");
    await flush();
    const first = lastFrame<{ type: string; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    ws.serverSend({ type: "submit_turn_result", id: first.id, payload: acceptedAdmissionFor("two-turn", first.payload.operationId, "eN", "turn-1", 1) });
    await expect(firstP).resolves.toBeTruthy();
    const attach = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "two-turn", epoch: "eN", lastEventId: 1 }) });
    await flush();
    ws.serverSend({ type: "event", payload: { type: "message_start", sessionId: "two-turn", epoch: "eN", eventId: 2, streamId: "u1", messageId: "u1", message: { role: "user", content: "first" } } });
    ws.serverSend({ type: "event", payload: { type: "message_end", sessionId: "two-turn", epoch: "eN", eventId: 3, streamId: "u1", messageId: "u1", entryId: "u1", message: { role: "user", content: "first" } } });
    ws.serverSend({ type: "event", payload: { type: "message_start", sessionId: "two-turn", epoch: "eN", eventId: 4, streamId: "a1", messageId: "a1", message: { role: "assistant", content: [], model: "m", provider: "p" } } });
    ws.serverSend({ type: "event", payload: { type: "message_end", sessionId: "two-turn", epoch: "eN", eventId: 5, streamId: "a1", messageId: "a1", entryId: "a1", parentEntryId: "u1", message: { role: "assistant", content: [{ type: "text", text: "answer one" }], model: "m", provider: "p" } } });
    await flush();
    expect(h.controller("two-turn")!.getSnapshot().liveEntries.map((entry) => entry.entryId)).toEqual(["u1", "a1"]);
    ws.serverSend({ type: "turn_status", payload: { sessionId: "two-turn", epoch: "eN", operationId: first.payload.operationId, turnId: "turn-1", revision: 1, state: "completed", userEntryId: "u1", finalLeafId: "a1" } });
    await flush();
    const controller = h.controller("two-turn")!;
    expect(controller.getSnapshot().historyAnchorLeafId).toBe("a1");
    expect(controller.getSnapshot().liveEntries.map((entry) => entry.entryId)).toEqual(["u1", "a1"]);

    // A late same-epoch snapshot may omit leafId. It cannot erase the exact
    // terminal anchor/live tail already observed for this session.
    ws.serverSend({ type: "snapshot", payload: snapshotPayload({ sessionId: "two-turn", epoch: "eN", lastEventId: 5, resumeStatus: "gap" }) });
    await flush();
    expect(controller.getSnapshot().historyAnchorLeafId).toBe("a1");
    expect(controller.getSnapshot().liveEntries.map((entry) => entry.entryId)).toEqual(["u1", "a1"]);

    const secondP = h.store.sendPromptToSession("two-turn", "second");
    await flush();
    expect(controller.getSnapshot().liveEntries.map((entry) => entry.entryId)).toEqual(["u1", "a1"]);
    const second = lastFrame<{ type: string; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    ws.serverSend({ type: "submit_turn_result", id: second.id, payload: { status: "rejected", delivery: "not_delivered", sessionId: "two-turn", operationId: second.payload.operationId, epoch: "eN", revision: 3, error: { code: "conflict", message: "cleanup", retryable: false } } });
    await expect(secondP).rejects.toMatchObject({ code: "conflict" });
  });

  it("an older create result without lastEventId never guesses zero; it attaches once for an exact submit fence", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackSubmitTurn());
    await flush();

    const createP = h.store.createSession({ cwd: "/x", projectRoot: "/x" });
    await flush();
    const createFrame = lastFrame<{ type: string; id: string }>(ws, "create")!;
    // Additive Protocol-v2 compatibility: an older daemon omits lastEventId.
    ws.serverSend({ type: "response", id: createFrame.id, payload: { ok: true, result: { sessionId: "new-old", epoch: "eN", created: true, cwd: "/x", projectRoot: "/x" } } });
    await expect(createP).resolves.toEqual({ sessionId: "new-old" });
    expect(lastFrame(ws, "attach")).toBeUndefined();

    const sendP = h.store.sendPromptToSession("new-old", "first");
    await flush();
    // The Client must not submit (epoch, guessed revision 0). It first attaches
    // to acquire the exact current cursor from authority.
    expect(lastFrame(ws, "submit_turn")).toBeUndefined();
    const attach = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    expect(attach.payload.sessionId).toBe("new-old");
    ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "new-old", epoch: "eN", lastEventId: 2 }) });
    await flush();

    const submit = lastFrame<{ type: string; id: string; payload: { operationId: string; expectedEpoch: string; expectedRevision: number } }>(ws, "submit_turn")!;
    expect(submit.payload.expectedEpoch).toBe("eN");
    expect(submit.payload.expectedRevision).toBe(2);
    ws.serverSend({
      type: "submit_turn_result",
      id: submit.id,
      payload: {
        status: "accepted",
        delivery: "accepted",
        sessionId: "new-old",
        epoch: "eN",
        revision: 2,
        operationId: submit.payload.operationId,
        turnId: "turn-old",
        snapshot: snapshotPayload({ sessionId: "new-old", epoch: "eN", lastEventId: 2 }).snapshot,
        turnStatus: { sessionId: "new-old", epoch: "eN", operationId: submit.payload.operationId, turnId: "turn-old", revision: 0, state: "admitted" },
      },
    });
    await expect(sendP).resolves.toBeTruthy();
  });

  it("a created-session seed is never used for another session; a seedless cross-session submit carries no epoch fence", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackSubmitTurn());
    await flush();

    const createP = h.store.createSession({ cwd: "/x", projectRoot: "/x" });
    await flush();
    const createFrame = lastFrame<{ type: string; id: string }>(ws, "create")!;
    ws.serverSend({ type: "response", id: createFrame.id, payload: { ok: true, result: { sessionId: "new-1", epoch: "eN", created: true, cwd: "/x", projectRoot: "/x" } } });
    await expect(createP).resolves.toEqual({ sessionId: "new-1" });

    // Submit to a DIFFERENT session with NO seed: no expectedEpoch/expectedRevision
    // may be fabricated from new-1's seed.
    const sendP = h.store.sendPromptToSession("other", "cross session");
    await flush();
    const submit = lastFrame<{ type: string; id: string; payload: { sessionId: string; operationId: string; expectedEpoch?: string; expectedRevision?: number } }>(ws, "submit_turn")!;
    expect(submit.payload.sessionId).toBe("other");
    expect("expectedEpoch" in submit.payload).toBe(false);
    expect("expectedRevision" in submit.payload).toBe(false);
    ws.serverSend({
      type: "submit_turn_result",
      id: submit.id,
      payload: { status: "rejected", delivery: "not_delivered", sessionId: "other", operationId: submit.payload.operationId, error: { code: "not_found", message: "no such session", retryable: false } },
    });
    await expect(sendP).rejects.toMatchObject({ code: "not_found" });
  });

  it("explicit caller fence wins over the attached session; revision-without-epoch is rejected before any send", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h, "s1", "e1");
    // Explicit fence on the ATTACHED session overrides the attached epoch.
    const sendP = h.store.submitTurn({ sessionId: "s1", prompt: "fenced", expectedEpoch: "eF", expectedRevision: 7 });
    await flush();
    const submit = lastFrame<{ type: string; id: string; payload: { sessionId: string; operationId: string; expectedEpoch: string; expectedRevision: number } }>(ws, "submit_turn")!;
    expect(submit.payload.expectedEpoch).toBe("eF");
    expect(submit.payload.expectedRevision).toBe(7);
    ws.serverSend({
      type: "submit_turn_result",
      id: submit.id,
      payload: { status: "rejected", delivery: "not_delivered", sessionId: "s1", operationId: submit.payload.operationId, error: { code: "epoch_changed", message: "fence mismatch", retryable: false } },
    });
    await expect(sendP).rejects.toMatchObject({ code: "epoch_changed" });

    // revision without epoch → invalid_input BEFORE any submit frame is sent.
    await expect(h.store.submitTurn({ sessionId: "s1", prompt: "bad", expectedRevision: 3 })).rejects.toMatchObject({ code: "invalid_input" });
    await flush();
    expect(ws.sent.filter((f) => (f as { type: string }).type === "submit_turn")).toHaveLength(1);
  });

  it("keeps a same-epoch observation cursor when a delayed accepted ACK carries an older pre-prompt revision", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackSubmitTurn());
    await flush();
    const open = h.store.openSession("s1");
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({
      type: "snapshot",
      id: attachFrame.id,
      payload: snapshotPayload({ sessionId: "s1", epoch: "e1", lastEventId: 13, model: { provider: "openai", id: "live-13" } }),
    });
    await open;
    const attachCountAfterOpen = ws.sent.filter((frame) => (frame as { type?: string }).type === "attach").length;
    const activateCountAfterOpen = ws.sent.filter((frame) => (frame as { type?: string }).type === "activate").length;
    const stopCountAfterOpen = ws.sent.filter((frame) => (frame as { type?: string }).type === "stop").length;
    expect(h.controller("s1")!.getSnapshot().snapshot?.state.model).toEqual({ provider: "openai", id: "live-13" });

    const secondP = h.store.sendPrompt("second");
    await flush();
    const second = lastFrame<{ type: "submit_turn"; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    expect(h.controller("s1")!.getSnapshot()).toMatchObject({ promptPending: true, turnActive: true, turnDelivery: "in_flight" });
    expect(h.controller("s1")!.getSnapshot().optimisticEntries[0]!.baseEntryId).toBeNull();

    ws.serverSend({ type: "event", payload: { type: "agent_start", sessionId: "s1", epoch: "e1", eventId: 14 } });
    ws.serverSend({ type: "event", payload: { type: "message_start", sessionId: "s1", epoch: "e1", eventId: 15, streamId: "u2", messageId: "u2", message: { role: "user", content: "second" } } });
    ws.serverSend({ type: "event", payload: { type: "message_end", sessionId: "s1", epoch: "e1", eventId: 16, streamId: "u2", messageId: "u2", entryId: "u2", message: { role: "user", content: "second" } } });
    ws.serverSend({ type: "event", payload: { type: "agent_start", sessionId: "s1", epoch: "e1", eventId: 17 } });
    await flush();
    expect(h.controller("s1")!.getSnapshot().liveEntries.map((entry) => entry.entryId)).toEqual(["u2"]);
    expect(h.controller("s1")!.getSnapshot().snapshot?.state.model).toEqual({ provider: "openai", id: "live-13" });
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "attach")).toHaveLength(attachCountAfterOpen);

    const delayedAdmission = {
      ...acceptedAdmissionFor("s1", second.payload.operationId, "e1", "turn-2", 13),
      snapshot: snapshotPayload({ sessionId: "s1", epoch: "e1", lastEventId: 13, model: { provider: "openai", id: "stale-pre-prompt" } }).snapshot,
    };
    (delayedAdmission.snapshot as { state: Record<string, unknown> }).state.leafId = "pre-prompt-leaf";
    ws.serverSend({ type: "submit_turn_result", id: second.id, payload: delayedAdmission });
    await flush();
    await expect(secondP).resolves.toMatchObject({ status: "accepted", operationId: second.payload.operationId, turnId: "turn-2" });
    expect(h.controller("s1")!.getSnapshot()).toMatchObject({ promptPending: false, turnActive: true, turnDelivery: "accepted" });
    expect(h.controller("s1")!.getSnapshot().optimisticEntries).toEqual([]);
    expect(h.controller("s1")!.getSnapshot().snapshot?.state.model).toEqual({ provider: "openai", id: "live-13" });
    expect(h.controller("s1")!.getSnapshot().liveEntries.map((entry) => entry.entryId)).toEqual(["u2"]);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "attach")).toHaveLength(attachCountAfterOpen);

    ws.serverSend({ type: "event", payload: { type: "message_start", sessionId: "s1", epoch: "e1", eventId: 18, streamId: "a2", messageId: "a2", message: { role: "assistant", content: [], model: "m", provider: "p" } } });
    ws.serverSend({
      type: "event",
      payload: {
        type: "message_update",
        sessionId: "s1",
        epoch: "e1",
        eventId: 19,
        streamId: "a2",
        messageId: "a2",
        delta: { role: "assistant", delta: { type: "text", text: "answer two" } },
      },
    });
    ws.serverSend({
      type: "event",
      payload: {
        type: "message_end",
        sessionId: "s1",
        epoch: "e1",
        eventId: 20,
        streamId: "a2",
        messageId: "a2",
        entryId: "a2",
        parentEntryId: "u2",
        message: { role: "assistant", content: [{ type: "text", text: "answer two" }], model: "m", provider: "p" },
      },
    });
    await flush();
    expect(h.controller("s1")!.getSnapshot().liveEntries.map((entry) => entry.entryId)).toEqual(["u2", "a2"]);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "attach")).toHaveLength(attachCountAfterOpen);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "activate")).toHaveLength(activateCountAfterOpen);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "stop")).toHaveLength(stopCountAfterOpen);
    h.dispose();
  });
});

describe("SessionStore — Phase 3 legacy fallback (no negotiated submit seam)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("without the feature, sendPrompt uses the legacy command-envelope prompt path", async () => {
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

    const sendP = h.store.sendPrompt("hi");
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { type: string; message: string; commandId: string } } }>(ws, "command")!;
    expect(cmd.payload.command.type).toBe("prompt");
    expect(cmd.payload.command.message).toBe("hi");
    expect(lastFrame(ws, "submit_turn")).toBeUndefined();
    ws.serverSend({ type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "prompt" } } } });
    await expect(sendP).resolves.toBeTruthy();
  });

  it("feature-off: create is identity-only (no attach), then legacy send attaches the exact new session before settings/prompt", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackLegacy());
    await flush();
    expect(h.store.getSnapshot().submitTurnEnabled).toBe(false);

    // Identity-only create: resolves, zero attach.
    const createP = h.store.createSession({ cwd: "/x", projectRoot: "/x" });
    await flush();
    const createFrame = lastFrame<{ type: string; id: string }>(ws, "create")!;
    ws.serverSend({ type: "response", id: createFrame.id, payload: { ok: true, result: { sessionId: "new-1", epoch: "eN", created: true, cwd: "/x", projectRoot: "/x" } } });
    await expect(createP).resolves.toEqual({ sessionId: "new-1" });
    expect(ws.sent.filter((f) => (f as { type: string }).type === "attach")).toHaveLength(0);
    expect(h.store.getSnapshot().attached).toBe(false);

    // Legacy send acquires the ONE attachment of the exact new session, then
    // staged settings → prompt. Nothing is sent before the attach lands.
    const sendP = h.store.sendPromptToSession("new-1", "first", undefined, { model: { provider: "openai", modelId: "gpt-5" }, thinkingLevel: "low" });
    await flush();
    const attach = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    expect(attach.payload.sessionId).toBe("new-1");
    expect(ws.sent.filter((f) => (f as { type: string }).type === "command")).toHaveLength(0);
    ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "new-1" }) });
    await flush();
    const modelCmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; provider: string; modelId: string } } }>(ws, "command")!;
    expect(modelCmd.payload.command.type).toBe("set_model");
    expect(modelCmd.payload.command.provider).toBe("openai");
    ws.serverSend({ type: "response", id: modelCmd.id, payload: { ok: true, result: { commandId: modelCmd.payload.command.commandId, result: { ok: true, type: "set_model" } } } });
    await flush();
    const thinkingCmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; level: string } } }>(ws, "command")!;
    expect(thinkingCmd.payload.command.type).toBe("set_thinking_level");
    ws.serverSend({ type: "response", id: thinkingCmd.id, payload: { ok: true, result: { commandId: thinkingCmd.payload.command.commandId, result: { ok: true, type: "set_thinking_level" } } } });
    await flush();
    // The staged-settings shim refreshes the authoritative snapshot before dispatch.
    const gsFrame = lastFrame<{ type: string; id: string }>(ws, "getSnapshot")!;
    expect(gsFrame).toBeTruthy();
    ws.serverSend({ type: "response", id: gsFrame.id, payload: { ok: true, result: snapshotPayload({ sessionId: "new-1" }).snapshot } });
    await flush();
    const promptCmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; message: string } } }>(ws, "command")!;
    expect(promptCmd.payload.command.type).toBe("prompt");
    expect(promptCmd.payload.command.message).toBe("first");
    ws.serverSend({ type: "response", id: promptCmd.id, payload: { ok: true, result: { commandId: promptCmd.payload.command.commandId, result: { ok: true, type: "prompt" } } } });
    await expect(sendP).resolves.toBeTruthy();
  });
});
