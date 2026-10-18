/**
 * Send-outcome reconciliation tests (root cure for false send failures).
 *
 * The production symptom: the server received (and even replied to) a turn,
 * yet the composer showed 「消息未发送，草稿已保留」 and re-sending duplicated
 * the message. Two client-side judgment defects, both regression-tested here:
 *
 *  1. Attached-fence CONFLICT: a concurrent ordinary command (set_model from
 *     the model picker, auto title generation, queue writes) appends journal
 *     events between the submit's fence capture and sessiond's admission, so
 *     the submit is rejected `conflict/not_delivered`. The turn must repair
 *     ONCE with the returned authority cursor and the SAME operationId — never
 *     surface "not sent" for a repairable fence race.
 *  2. UNCERTAIN delivery: the admission receipt was lost (Host/sessiond RPC
 *     failed after possible dispatch, worker admission timed out). The turn
 *     must RECONCILE by re-sending the SAME operationId (idempotent admission:
 *     duplicate/accepted proves delivery; a fresh admission or a
 *     not_delivered rejection proves the opposite) and must NEVER settle as a
 *     definite send failure — a bounded give-up settles uncertain-tagged
 *     (bubble kept, draft never restored, no "not sent" copy).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, flush, lastFrame, snapshotPayload, type RuntimeHarness } from "./testing/harness";
import type { FakeWebSocket } from "./testing/harness";
import type { SubmitTurnAdmission } from "@fffattiger/pix-protocol";

function ackSubmitTurn() {
  return {
    type: "handshake_ack",
    payload: {
      protocolVersion: 2,
      host: { mode: "local", capabilities: ["agent"] },
      limits: { maxUpload: 0, maxOpenSessions: 4 },
      sessionSnapshotSupport: true,
      acceptedFeatures: ["runtime.read-rpc.v1", "runtime.submit-turn.v1", "runtime.observe-existing.v1"],
    },
  };
}

async function openAndAttach(h: RuntimeHarness, sessionId = "s1", epoch = "e1", lastEventId = 0): Promise<FakeWebSocket> {
  h.store.connect();
  const ws = h.lastSocket();
  ws.serverOpen();
  ws.serverSend(ackSubmitTurn());
  await flush();
  const p = h.store.openSession(sessionId);
  await flush();
  const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
  ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId, epoch, lastEventId }) });
  await flush();
  await p;
  return ws;
}

function acceptedAdmission(sessionId: string, operationId: string, epoch: string, turnId = "turn-1", revision = 1): SubmitTurnAdmission {
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

function duplicateAdmission(sessionId: string, operationId: string, epoch: string, turnId = "turn-1", revision = 1): SubmitTurnAdmission {
  return {
    status: "duplicate",
    delivery: "accepted",
    sessionId,
    epoch,
    revision,
    operationId,
    turnId,
    turnStatus: { sessionId, epoch, operationId, turnId, revision: 1, state: "running" },
    snapshot: snapshotPayload({ sessionId, epoch, lastEventId: revision }).snapshot as never,
  };
}

function conflictRejection(sessionId: string, operationId: string, epoch: string, revision: number) {
  return {
    status: "rejected" as const,
    delivery: "not_delivered" as const,
    sessionId,
    operationId,
    epoch,
    revision,
    error: { code: "conflict", message: "session revision changed", retryable: false },
  };
}

function uncertainRejection(sessionId: string, operationId: string) {
  return {
    status: "rejected" as const,
    delivery: "uncertain" as const,
    sessionId,
    operationId,
    error: { code: "timeout", message: "worker turn admission timed out", retryable: true },
  };
}

function submitFrames(ws: FakeWebSocket): Array<{ type: "submit_turn"; id: string; payload: Record<string, unknown> }> {
  return ws.sent.filter((frame): frame is { type: "submit_turn"; id: string; payload: Record<string, unknown> } =>
    (frame as { type?: string }).type === "submit_turn"
  );
}

describe("SessionStore — attached-fence conflict repair (model-switch / auto-title race)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("repairs an attached-fence conflict once with the SAME operationId and the authority cursor", async () => {
    const h = createHarness();
    const ws = await openAndAttach(h, "s1", "e1", 40);
    const sendP = h.store.sendPrompt("pick model then send");
    await flush();
    const first = submitFrames(ws)[0]!;
    expect(first.payload).toMatchObject({ expectedEpoch: "e1", expectedRevision: 40 });

    // Concurrent command events (e.g. the auto-title completion burst:
    // session_title + runtime_state_changed + session_title) arrive and
    // advance the local cursor before the conflict answer. Event ids stay
    // contiguous — a gap would trigger a re-attach resync instead.
    ws.serverSend({ type: "event", payload: { type: "session_title", sessionId: "s1", epoch: "e1", eventId: 41, name: "t" } });
    ws.serverSend({ type: "event", payload: { type: "runtime_state_changed", sessionId: "s1", epoch: "e1", eventId: 42 } });
    ws.serverSend({ type: "event", payload: { type: "session_title", sessionId: "s1", epoch: "e1", eventId: 43, name: "t2" } });
    await flush();
    ws.serverSend({
      type: "submit_turn_result",
      id: first.id,
      payload: conflictRejection("s1", first.payload.operationId as string, "e1", 43),
    });
    await flush();

    const frames = submitFrames(ws);
    expect(frames).toHaveLength(2);
    const retry = frames[1]!;
    expect(retry.id).not.toBe(first.id);
    expect(retry.payload.operationId).toBe(first.payload.operationId);
    expect(retry.payload.expectedEpoch).toBe("e1");
    // Freshest same-epoch cursor: max(authority revision 43, local 43).
    expect(retry.payload.expectedRevision).toBe(43);
    expect(h.store.getSnapshot().optimisticEntries).toHaveLength(1);

    ws.serverSend({
      type: "submit_turn_result",
      id: retry.id,
      payload: acceptedAdmission("s1", retry.payload.operationId as string, "e1", "turn-repair", 44),
    });
    await expect(sendP).resolves.toBeTruthy();
  });

  it("repair uses the authority revision when the local cursor is still behind", async () => {
    const h = createHarness();
    const ws = await openAndAttach(h, "s1", "e1", 40);
    const sendP = h.store.sendPrompt("race without applied events");
    await flush();
    const first = submitFrames(ws)[0]!;
    // No event frames delivered: the local cursor stays at 40 while the
    // authority rejection reports the true head 47.
    ws.serverSend({
      type: "submit_turn_result",
      id: first.id,
      payload: conflictRejection("s1", first.payload.operationId as string, "e1", 47),
    });
    await flush();
    const retry = submitFrames(ws)[1]!;
    expect(retry.payload.operationId).toBe(first.payload.operationId);
    expect(retry.payload.expectedRevision).toBe(47);
    ws.serverSend({
      type: "submit_turn_result",
      id: retry.id,
      payload: acceptedAdmission("s1", retry.payload.operationId as string, "e1", "turn-repair", 47),
    });
    await expect(sendP).resolves.toBeTruthy();
  });

  it("a second conflict is bounded: no third frame, honest definite rejection", async () => {
    const h = createHarness();
    const ws = await openAndAttach(h, "s1", "e1", 40);
    const sendP = h.store.sendPrompt("two conflicts");
    await flush();
    const first = submitFrames(ws)[0]!;
    ws.serverSend({
      type: "submit_turn_result",
      id: first.id,
      payload: conflictRejection("s1", first.payload.operationId as string, "e1", 41),
    });
    await flush();
    const retry = submitFrames(ws)[1]!;
    ws.serverSend({
      type: "submit_turn_result",
      id: retry.id,
      payload: conflictRejection("s1", retry.payload.operationId as string, "e1", 42),
    });
    await flush();
    expect(submitFrames(ws)).toHaveLength(2);
    // Proven non-delivery: activation-tagged, bubble removed (draft restore is
    // the Composer's honest reaction to a definite failure).
    await expect(sendP).rejects.toMatchObject({ code: "conflict", retryable: false, phase: "activation" });
    expect(h.store.getSnapshot().optimisticEntries).toEqual([]);
    expect(h.store.getSnapshot().turnActive).toBe(false);
  });
});

describe("SessionStore — uncertain-delivery reconciliation (lost admission receipt)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("re-sends the SAME operationId after an uncertain admission and resolves on duplicate/accepted", async () => {
    const h = createHarness();
    const ws = await openAndAttach(h);
    let rejected = false;
    const sendP = h.store.sendPrompt("maybe delivered").then(
      (value) => value,
      (cause) => { rejected = true; throw cause; },
    );
    await flush();
    const first = submitFrames(ws)[0]!;
    // Host/sessiond RPC failed after possible dispatch.
    ws.serverSend({
      type: "submit_turn_result",
      id: first.id,
      payload: uncertainRejection("s1", first.payload.operationId as string),
    });
    await flush();
    // Reconciliation resend: same operation, fresh envelope, same payload.
    const frames = submitFrames(ws);
    expect(frames).toHaveLength(2);
    const retry = frames[1]!;
    expect(retry.id).not.toBe(first.id);
    expect(retry.payload.operationId).toBe(first.payload.operationId);
    expect(retry.payload.prompt).toBe("maybe delivered");
    expect(rejected).toBe(false);
    expect(h.store.getSnapshot().optimisticEntries).toHaveLength(1);

    // The authority proves it landed: duplicate/accepted → the send is a success.
    ws.serverSend({
      type: "submit_turn_result",
      id: retry.id,
      payload: duplicateAdmission("s1", retry.payload.operationId as string, "e1", "turn-1", 1),
    });
    await expect(sendP).resolves.toBeTruthy();
    expect(h.store.getSnapshot().optimisticEntries).toHaveLength(1);
  });

  it("a second uncertainty settles honestly: uncertain-tagged, bubble kept, never activation", async () => {
    const h = createHarness();
    const ws = await openAndAttach(h);
    const sendP = h.store.sendPrompt("still unknown");
    await flush();
    const first = submitFrames(ws)[0]!;
    ws.serverSend({
      type: "submit_turn_result",
      id: first.id,
      payload: uncertainRejection("s1", first.payload.operationId as string),
    });
    await flush();
    const retry = submitFrames(ws)[1]!;
    expect(retry.payload.operationId).toBe(first.payload.operationId);
    ws.serverSend({
      type: "submit_turn_result",
      id: retry.id,
      payload: uncertainRejection("s1", retry.payload.operationId as string),
    });
    await flush();
    expect(submitFrames(ws)).toHaveLength(2);
    // NOT a definite failure: uncertain-tagged (the Composer must show the
    // "unconfirmed" state, never "not sent", and never restore the draft).
    await expect(sendP).rejects.toMatchObject({ code: "timeout", retryable: true, phase: "uncertain" });
    expect(h.store.getSnapshot().optimisticEntries.map((entry) => entry.entry.message)).toContainEqual({ role: "user", content: "still unknown" });
    expect(h.store.getSnapshot().turnActive).toBe(false);
  });

  it("a reconcile resend that hits a dead transport settles uncertain (never activation-tagged)", async () => {
    const h = createHarness();
    const ws = await openAndAttach(h);
    const sendP = h.store.sendPrompt("dies while reconciling");
    // Attach the rejection handler up front: the watchdog fires inside
    // advanceTimersByTimeAsync's await window, before a later expect().rejects
    // would install one (avoids a spurious unhandled rejection).
    const settled = sendP.then(
      () => { throw new Error("expected the uncertain settle to reject"); },
      (cause: unknown) => cause,
    );
    await flush();
    const first = submitFrames(ws)[0]!;
    ws.serverSend({
      type: "submit_turn_result",
      id: first.id,
      payload: uncertainRejection("s1", first.payload.operationId as string),
    });
    await flush();
    expect(submitFrames(ws)).toHaveLength(2);
    // The transport dies while the reconciliation resend is in flight. The
    // logical-retry attempt waits in the bounded 30s recovery queue for a
    // reconnect that never comes, then settles uncertain — never activation.
    ws.serverClose(1006);
    await flush();
    await vi.advanceTimersByTimeAsync(35_000);
    await flush();
    // Bytes of the first attempt were on the wire: the outcome is UNCERTAIN —
    // pre-wire activation semantics must not apply.
    await expect(settled).resolves.toMatchObject({ code: "timeout", retryable: true, phase: "uncertain" });
    expect(h.store.getSnapshot().optimisticEntries.map((entry) => entry.entry.message)).toContainEqual({ role: "user", content: "dies while reconciling" });
  });

  it("an uncertain settle never allows a duplicate wire submit of a NEW operation for the same intent", async () => {
    const h = createHarness();
    const ws = await openAndAttach(h);
    const sendP = h.store.sendPrompt("one intent");
    await flush();
    const first = submitFrames(ws)[0]!;
    ws.serverSend({ type: "submit_turn_result", id: first.id, payload: uncertainRejection("s1", first.payload.operationId as string) });
    await flush();
    const retry = submitFrames(ws)[1]!;
    ws.serverSend({ type: "submit_turn_result", id: retry.id, payload: uncertainRejection("s1", retry.payload.operationId as string) });
    await flush();
    await expect(sendP).rejects.toMatchObject({ phase: "uncertain" });
    // While reconciling/settled-uncertain, every wire submit for this intent
    // used the SAME operationId — a server-side dedup by operationId sees one
    // logical turn, so no duplicate user message can be written.
    const operationIds = new Set(submitFrames(ws).map((frame) => frame.payload.operationId));
    expect(operationIds.size).toBe(1);
  });
});

describe("SessionStore — queued-turn uncertain reconciliation (steer / follow_up)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function openAttachedWithSteer(h: RuntimeHarness): Promise<FakeWebSocket> {
    h.store.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackSubmitTurn());
    return flush().then(() => {
      const p = h.store.openSession("s1");
      return flush().then(() => {
        const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
        ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1", epoch: "e1", capabilities: ["runtime.prompt", "runtime.steer"] }) });
        return flush().then(() => p.then(() => ws));
      });
    });
  }

  function commandFrames(ws: FakeWebSocket): Array<{ id: string; payload: { command: { commandId: string; type: string; message?: string } } }> {
    return ws.sent.filter((frame): frame is { id: string; payload: { command: { commandId: string; type: string; message?: string } } } =>
      (frame as { type?: string }).type === "command"
    );
  }

  it("re-sends the SAME commandId after an uncertain RPC failure and resolves on the replayed result", async () => {
    const h = createHarness();
    const ws = await openAttachedWithSteer(h);
    const settled = h.store.steer("maybe queued").then(
      (value) => ({ ok: true as const, value }),
      (cause: unknown) => ({ ok: false as const, cause }),
    );
    await flush();
    const first = commandFrames(ws).at(-1)!;
    expect(first.payload.command.type).toBe("steer");
    // Host/sessiond RPC failed after possible dispatch — outcome unresolved.
    ws.serverSend({ type: "response", id: first.id, payload: { ok: false, error: { code: "timeout", message: "sessiond request failed", retryable: true } } });
    await flush();
    // The queued slot stays occupied (no duplicate submit of the same intent).
    expect(h.store.getSnapshot().queuedTurnPending).toBe(true);
    // Reconciliation re-send: SAME commandId on a fresh envelope.
    await vi.advanceTimersByTimeAsync(1_100);
    await flush();
    const frames = commandFrames(ws);
    expect(frames).toHaveLength(2);
    const retry = frames[1]!;
    expect(retry.payload.command.commandId).toBe(first.payload.command.commandId);
    expect(retry.id).not.toBe(first.id);
    // The idempotent command admission replays the cached result.
    ws.serverSend({ type: "response", id: retry.id, payload: { ok: true, result: { commandId: retry.payload.command.commandId, result: { ok: true, type: "steer", disposition: "queued" } } } });
    const outcome = await settled;
    expect(outcome.ok).toBe(true);
    expect(h.store.getSnapshot().queuedTurnPending).toBe(false);
  });

  it("a definite rejection settles immediately (no reconciliation resend)", async () => {
    const h = createHarness();
    const ws = await openAttachedWithSteer(h);
    const settled = h.store.steer("definitely rejected").then(
      () => ({ ok: true as const }),
      (cause: unknown) => ({ ok: false as const, cause }),
    );
    await flush();
    const first = commandFrames(ws).at(-1)!;
    ws.serverSend({ type: "response", id: first.id, payload: { ok: false, error: { code: "session_busy", message: "queue full", retryable: false } } });
    const outcome = await settled;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.cause).toMatchObject({ code: "session_busy" });
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(commandFrames(ws)).toHaveLength(1);
    expect(h.store.getSnapshot().queuedTurnPending).toBe(false);
  });

  it("budget exhaustion settles retained-uncertain (resolve, bubble kept) — never a claimed non-delivery", async () => {
    const h = createHarness();
    const ws = await openAttachedWithSteer(h);
    const settled = h.store.steer("never resolves").then(
      (value) => ({ ok: true as const, value }),
      (cause: unknown) => ({ ok: false as const, cause }),
    );
    await flush();
    const first = commandFrames(ws).at(-1)!;
    ws.serverSend({ type: "response", id: first.id, payload: { ok: false, error: { code: "timeout", message: "sessiond request failed", retryable: true } } });
    await vi.advanceTimersByTimeAsync(1_100);
    await flush();
    const retry = commandFrames(ws)[1]!;
    ws.serverSend({ type: "response", id: retry.id, payload: { ok: false, error: { code: "unavailable", message: "sessiond request failed", retryable: false } } });
    await flush();
    const outcome = await settled;
    // Bounded give-up resolves (retained-uncertain): never rejected as proven
    // non-delivery, so the Composer never restores the draft for it.
    expect(outcome.ok).toBe(true);
    expect(h.store.getSnapshot().queuedTurnPending).toBe(false);
    // The optimistic bubble stays for the queue event stream to claim.
    expect(h.store.getSnapshot().optimisticEntries.map((entry) => entry.entry.message)).toContainEqual({ role: "user", content: "never resolves" });
  });
});
