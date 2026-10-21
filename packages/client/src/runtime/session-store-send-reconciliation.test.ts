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
    // The authority's journal head is the fence — never a locally maxed cursor
    // (the attached event lane already replays the very events that advanced it).
    expect(retry.payload.expectedRevision).toBe(43);
    expect(h.store.getSnapshot().optimisticEntries).toHaveLength(1);

    ws.serverSend({
      type: "submit_turn_result",
      id: retry.id,
      payload: acceptedAdmission("s1", retry.payload.operationId as string, "e1", "turn-repair", 44),
    });
    await expect(sendP).resolves.toBeTruthy();
  });

  it("repair uses the authority revision when the local cursor is still behind", async () => {    const h = createHarness();
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
    expect(h.store.getSnapshot().optimisticEntries.map((entry) => entry.entry.message)).toContainEqual(expect.objectContaining({ role: "user", content: "still unknown" }));
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
    expect(h.store.getSnapshot().optimisticEntries.map((entry) => entry.entry.message)).toContainEqual(expect.objectContaining({ role: "user", content: "dies while reconciling" }));
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

describe("SessionStore — one re-send budget, one deadline (SUBMIT_MAX_RESENDS)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("stops after three re-sends and settles by wire evidence", async () => {
    const h = createHarness();
    const ws = await openAndAttach(h, "s1", "e1", 40);
    const sendP = h.store.sendPrompt("budget");
    const settled = sendP.then(
      () => { throw new Error("expected a rejection"); },
      (cause: unknown) => cause,
    );
    await flush();
    // The longest reachable chain: drop the stale attached fence → repair the
    // authority fence → reconcile an uncertain admission. ONE counter covers
    // all three; a fourth re-send is refused and the authority-proved
    // non-delivery settles as activation (bubble removed, draft restored).
    const first = submitFrames(ws)[0]!;
    expect(first.payload).toMatchObject({ expectedEpoch: "e1", expectedRevision: 40 });
    ws.serverSend({
      type: "submit_turn_result",
      id: first.id,
      payload: { status: "rejected", delivery: "not_delivered", sessionId: "s1", operationId: first.payload.operationId, error: { code: "epoch_changed", message: "not active at expected epoch", retryable: false } },
    });
    await flush();
    const unfenced = submitFrames(ws)[1]!;
    expect("expectedEpoch" in unfenced.payload).toBe(false);
    ws.serverSend({
      type: "submit_turn_result",
      id: unfenced.id,
      payload: { status: "rejected", delivery: "not_delivered", sessionId: "s1", operationId: unfenced.payload.operationId, epoch: "eLive", revision: 4, error: { code: "conflict", message: "live worker fence", retryable: false } },
    });
    await flush();
    const fenced = submitFrames(ws)[2]!;
    expect(fenced.payload).toMatchObject({ expectedEpoch: "eLive", expectedRevision: 4 });
    ws.serverSend({
      type: "submit_turn_result",
      id: fenced.id,
      payload: { status: "rejected", delivery: "uncertain", sessionId: "s1", operationId: fenced.payload.operationId, error: { code: "timeout", message: "admission timed out", retryable: true } },
    });
    await flush();
    expect(submitFrames(ws)).toHaveLength(4);
    const reconciled = submitFrames(ws)[3]!;
    expect(reconciled.payload.operationId).toBe(first.payload.operationId);
    // Fourth failure: the shared quota is spent, so this settles instead of
    // re-sending again. The authority proved non-delivery → activation.
    ws.serverSend({
      type: "submit_turn_result",
      id: reconciled.id,
      payload: { status: "rejected", delivery: "not_delivered", sessionId: "s1", operationId: reconciled.payload.operationId, epoch: "eLive", revision: 5, error: { code: "conflict", message: "still racing", retryable: false } },
    });
    await expect(settled).resolves.toMatchObject({ code: "conflict", phase: "activation" });
    expect(submitFrames(ws)).toHaveLength(4);
    expect(new Set(submitFrames(ws).map((frame) => frame.payload.operationId)).size).toBe(1);
    expect(h.store.getSnapshot().optimisticEntries).toEqual([]);
    expect(h.store.getSnapshot().turnActive).toBe(false);
  });

  it("the one deadline settles a re-send that never comes back, by wire evidence", async () => {
    const h = createHarness();
    const ws = await openAndAttach(h);
    const sendP = h.store.sendPrompt("no receipt ever");
    const settled = sendP.then(
      () => { throw new Error("expected a rejection"); },
      (cause: unknown) => cause,
    );
    await flush();
    const first = submitFrames(ws)[0]!;
    // An uncertain admission starts the reconciliation re-send, whose deadline
    // is the SAME 30s budget armed for the first failure — not a second timer.
    ws.serverSend({ type: "submit_turn_result", id: first.id, payload: uncertainRejection("s1", first.payload.operationId as string) });
    await flush();
    expect(submitFrames(ws)).toHaveLength(2);
    // The reconcile frame reaches the wire and nothing ever answers it. Without
    // the shared deadline the pending slot would stay locked forever.
    await vi.advanceTimersByTimeAsync(35_000);
    await flush();
    // Bytes were on the wire: uncertain delivery, bubble kept, never activation.
    await expect(settled).resolves.toMatchObject({ code: "timeout", phase: "uncertain" });
    expect(h.store.getSnapshot().optimisticEntries.map((entry) => entry.entry.message)).toContainEqual(expect.objectContaining({ role: "user", content: "no receipt ever" }));
    expect(h.store.getSnapshot().turnActive).toBe(false);
  });

  it("a first send that never fails gets no client-side settle timeout", async () => {
    // A cold-started worker may legitimately take a long time to admit the very
    // first turn; the deadline bounds re-sends, never the first attempt.
    const h = createHarness();
    const ws = await openAndAttach(h);
    const sendP = h.store.sendPrompt("slow cold worker");
    let settled = false;
    const outcome = sendP.then(() => { settled = true; }, () => { settled = true; });
    await flush();
    expect(submitFrames(ws)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(360_000);
    await flush();
    expect(settled).toBe(false);
    expect(h.store.getSnapshot().turnActive).toBe(true);
    const submitted = submitFrames(ws)[0]!;
    ws.serverSend({ type: "submit_turn_result", id: submitted.id, payload: acceptedAdmission("s1", submitted.payload.operationId as string, "e1") });
    await expect(sendP).resolves.toBeTruthy();
    await outcome;
  });

  it("a same-epoch reconnect re-send does not consume the re-send budget", async () => {
    const h = createHarness();
    let ws = await openAndAttach(h, "s1", "e1", 40);
    const sendP = h.store.sendPrompt("survives a reconnect");
    await flush();
    const operationId = submitFrames(ws)[0]!.payload.operationId;
    // A plain transport drop moves the SAME attempt to a new socket; it is not
    // a repair, so the three-repair budget must still be intact afterwards.
    ws.serverClose(1006);
    vi.advanceTimersByTime(250);
    ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend({
      type: "handshake_ack",
      payload: {
        protocolVersion: 2,
        host: { mode: "local", capabilities: ["agent"] },
        limits: { maxUpload: 0, maxOpenSessions: 4 },
        sessionSnapshotSupport: true,
        acceptedFeatures: ["runtime.read-rpc.v1", "runtime.submit-turn.v1", "runtime.observe-existing.v1"],
      },
    });
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1", epoch: "e1", lastEventId: 40, resumeStatus: "snapshot" }) });
    await flush();
    const resent = submitFrames(ws);
    expect(resent).toHaveLength(1);
    expect(resent[0]!.payload.operationId).toBe(operationId);
    // A genuine fence race after the reconnect still gets its repair.
    ws.serverSend({ type: "submit_turn_result", id: resent[0]!.id, payload: conflictRejection("s1", operationId as string, "e1", 43) });
    await flush();
    const repaired = submitFrames(ws);
    expect(repaired).toHaveLength(2);
    expect(repaired[1]!.payload.expectedRevision).toBe(43);
    ws.serverSend({ type: "submit_turn_result", id: repaired[1]!.id, payload: acceptedAdmission("s1", operationId as string, "e1", "turn-reconnect", 44) });
    await expect(sendP).resolves.toBeTruthy();
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
    if (!outcome.ok) expect(outcome.cause).toMatchObject({ code: "session_busy", status: "rejected", delivery: "not_delivered" });
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(commandFrames(ws)).toHaveLength(1);
    expect(h.store.getSnapshot().queuedTurnPending).toBe(false);
  });

  it("a nested worker rejection stays uncertain because the SDK may already have queued it", async () => {
    const h = createHarness();
    const ws = await openAttachedWithSteer(h);
    const send = h.store.steer("not queued");
    await flush();
    const frame = commandFrames(ws).at(-1)!;
    ws.serverSend({ type: "response", id: frame.id, payload: { ok: true, result: {
      commandId: frame.payload.command.commandId,
      result: { ok: false, type: "steer", error: { code: "session_busy", message: "queue full", retryable: false } },
    } } });
    await expect(send).rejects.toMatchObject({ phase: "uncertain" });
    expect(h.store.getSnapshot().queuedTurnPending).toBe(false);
  });

  it("a post-enqueue nested invalid_input never restores a duplicate draft", async () => {
    const h = createHarness();
    const ws = await openAttachedWithSteer(h);
    const send = h.store.steer("already queued");
    await flush();
    const frame = commandFrames(ws).at(-1)!;
    // The SDK may have queued the entry before the adapter's state read throws.
    ws.serverSend({ type: "response", id: frame.id, payload: { ok: true, result: {
      commandId: frame.payload.command.commandId,
      result: { ok: false, type: "steer", error: { code: "invalid_input", message: "state not found", retryable: false } },
    } } });
    await expect(send).rejects.toMatchObject({ phase: "uncertain" });
  });

  it("a non-retryable transport error remains uncertain, even after a retry", async () => {
    const h = createHarness();
    const ws = await openAttachedWithSteer(h);
    const send = h.store.steer("maybe queued");
    await flush();
    const first = commandFrames(ws).at(-1)!;
    ws.serverSend({ type: "response", id: first.id, payload: { ok: false,
      error: { code: "unavailable", message: "sessiond request failed", retryable: false } } });
    await flush();
    await vi.advanceTimersByTimeAsync(1_100);
    await flush();
    const retry = commandFrames(ws).at(-1)!;
    expect(retry.id).not.toBe(first.id);
    ws.serverSend({ type: "response", id: retry.id, payload: { ok: false,
      error: { code: "session_busy", message: "busy on retry", retryable: false } } });
    await expect(send).rejects.toMatchObject({ phase: "uncertain" });
  });

  it("a same-epoch reconnect resync never double-sends the queued turn", async () => {
    // The reconcile timer and a transport resync both want to re-send the SAME
    // commandId. The re-send clears the pending timer first, so the idempotent
    // command admission never sees two frames for one steer.
    const h = createHarness();
    let ws = await openAttachedWithSteer(h);
    const settled = h.store.steer("only once").then(
      (value) => ({ ok: true as const, value }),
      (cause: unknown) => ({ ok: false as const, cause }),
    );
    await flush();
    const first = commandFrames(ws).at(-1)!;
    // An unresolved outcome arms the 1s reconcile backoff…
    ws.serverSend({ type: "response", id: first.id, payload: { ok: false, error: { code: "timeout", message: "sessiond request failed", retryable: true } } });
    await flush();
    // …and the transport drops before that backoff fires. The resync re-send
    // must consume the timer, not race it.
    ws.serverClose(1006);
    vi.advanceTimersByTime(250);
    ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackSubmitTurn());
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1", epoch: "e1", capabilities: ["runtime.prompt", "runtime.steer"] }) });
    await flush(8);
    expect(commandFrames(ws)).toHaveLength(1);
    // The stale reconcile timer is gone: no second frame appears later.
    await vi.advanceTimersByTimeAsync(3_000);
    await flush();
    expect(commandFrames(ws)).toHaveLength(1);
    expect(commandFrames(ws)[0]!.payload.command.commandId).toBe(first.payload.command.commandId);
    ws.serverSend({ type: "response", id: commandFrames(ws)[0]!.id, payload: { ok: true, result: { commandId: first.payload.command.commandId, result: { ok: true, type: "steer", disposition: "queued" } } } });
    const outcome = await settled;
    expect(outcome.ok).toBe(true);
  });

  it("budget exhaustion rejects retained-uncertain (bubble kept) — never a claimed non-delivery", async () => {
    const h = createHarness();
    const ws = await openAttachedWithSteer(h);
    const settled = h.store.steer("never resolves").then(
      (value) => ({ ok: true as const, value }),
      (cause: unknown) => ({ ok: false as const, cause }),
    );
    await flush();
    // Every round answers with an unresolved outcome. The shared quota is three
    // re-sends, so the fourth unresolved answer is the honest give-up.
    for (let round = 0; round < 4; round += 1) {
      const frames = commandFrames(ws);
      const frame = frames.at(-1)!;
      ws.serverSend({
        type: "response",
        id: frame.id,
        payload: { ok: false, error: { code: round === 0 ? "timeout" : "unavailable", message: "sessiond request failed", retryable: true } },
      });
      await flush();
      await vi.advanceTimersByTimeAsync(1_100);
      await flush();
      expect(commandFrames(ws).length).toBe(round + 1 < 4 ? round + 2 : 4);
    }
    const outcome = await settled;
    // Bounded give-up REJECTS uncertain-tagged (never "not sent"), so the
    // Composer shows "unconfirmed" and never restores the draft.
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.cause).toMatchObject({ phase: "uncertain" });
    expect(h.store.getSnapshot().queuedTurnPending).toBe(false);
    // A queued turn never creates an optimistic transcript entry: the message
    // belongs to the status capsule (queue events) until real delivery.
    expect(h.store.getSnapshot().optimisticEntries).toHaveLength(0);
  });
});
