/**
 * Provisional create / staging / send parity (Phase 5A semantics, outbox era).
 *
 * These prove the send path's identity behaviour for a freshly created,
 * UNATTACHED session, which is the shape that used to accumulate client-side
 * guesses (created-seed epoch fences, bounded conflict repair). A send is now
 * unconditional, so the parity assertions are about what actually matters:
 *  - the first send of a created session carries NO fence and binds optimism to
 *    the operation identity before any attach;
 *  - staged model/thinking ride the same send unchanged;
 *  - a transient rejection keeps the SAME operationId and the SAME payload
 *    (only the transport envelope is new) and never surfaces to the user;
 *  - a committed leaf fence for the provisional session defers behind the
 *    active turn and applies at terminal without touching the bubble;
 *  - the accepted send is the ONLY logical operation (one operationId, ever).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authoritySnapshot, createHarness, flush, lastFrame, snapshotPayload, type RuntimeHarness } from "./testing/harness";
import type { FakeWebSocket } from "./testing/harness";

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

async function connectReady(h: RuntimeHarness): Promise<FakeWebSocket> {
  h.store.connect();
  const ws = h.lastSocket();
  ws.serverOpen();
  ws.serverSend(ackSubmitTurn());
  await flush();
  return ws;
}

async function createSeededSession(
  h: RuntimeHarness,
  ws: FakeWebSocket,
  { sessionId = "new-1", epoch = "eN", revision = 1 }: { sessionId?: string; epoch?: string; revision?: number } = {},
): Promise<void> {
  const createP = h.store.createSession({ cwd: "/x", projectRoot: "/x" });
  await flush();
  const createFrame = lastFrame<{ type: string; id: string }>(ws, "create")!;
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
        snapshot: snapshotPayload({ sessionId, epoch, lastEventId: revision }).snapshot,
      },
    },
  });
  await expect(createP).resolves.toEqual({ sessionId });
}

function submitFrames(ws: FakeWebSocket): Array<{ type: "submit_turn"; id: string; payload: Record<string, unknown> }> {
  return ws.sent.filter((frame): frame is { type: "submit_turn"; id: string; payload: Record<string, unknown> } =>
    (frame as { type?: string }).type === "submit_turn",
  );
}

function transientRejection(operationId: string) {
  return {
    status: "rejected",
    delivery: "not_delivered",
    sessionId: "new-1",
    operationId,
    error: { code: "unavailable", message: "authority is restarting", retryable: true },
  };
}

function accepted(operationId: string, revision: number, turnId = "turn-1") {
  return {
    status: "accepted",
    delivery: "accepted",
    sessionId: "new-1",
    epoch: "eN",
    revision,
    operationId,
    turnId,
    snapshot: snapshotPayload({ sessionId: "new-1", epoch: "eN", lastEventId: revision }).snapshot as never,
    turnStatus: { sessionId: "new-1", epoch: "eN", operationId, turnId, revision: 0, state: "admitted" },
  };
}

describe("provisional create + send parity (outbox contract)", () => {
  // Real timers: the outbox has no client-side budget/deadline any more, and
  // transport readiness waits on real socket timers.
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("the first send of a created (unattached) session carries no fence and binds optimism by operation identity", async () => {
    const h = createHarness();
    const ws = await connectReady(h);
    await createSeededSession(h, ws);

    const sendP = h.store.sendPromptToSession("new-1", "hello", undefined, {
      model: { provider: "anthropic", modelId: "claude-opus-4" },
      thinkingLevel: "high",
    });
    await flush();
    const submit = submitFrames(ws)[0]!;
    expect(submit.payload).toMatchObject({
      sessionId: "new-1",
      prompt: "hello",
      activationOverrides: { model: { provider: "anthropic", modelId: "claude-opus-4" }, thinkingLevel: "high" },
    });
    // No client-side guess travels with the send: the authority decides.
    expect(submit.payload.expectedEpoch).toBeUndefined();
    expect(submit.payload.expectedRevision).toBeUndefined();

    const bubble = h.controller("new-1")!.getSnapshot().optimisticEntries;
    expect(bubble).toHaveLength(1);
    expect(bubble[0]!.identity).toMatchObject({ operationId: submit.payload.operationId, userEntryId: null, finalLeafId: null });

    ws.serverSend({ type: "submit_turn_result", id: submit.id, payload: accepted(submit.payload.operationId as string, 2) });
    await expect(sendP).resolves.toBeUndefined();
    expect(h.controller("new-1")!.getSnapshot().optimisticEntries[0]!.identity).toMatchObject({ turnId: "turn-1" });
  });

  it("a committed leaf fence for the pending provisional session defers and applies at terminal", async () => {
    const h = createHarness();
    const ws = await connectReady(h);
    await createSeededSession(h, ws);

    const sendP = h.store.sendPromptToSession("new-1", "hello");
    await flush();
    const submit = submitFrames(ws)[0]!;
    ws.serverSend({ type: "submit_turn_result", id: submit.id, payload: accepted(submit.payload.operationId as string, 1) });
    await expect(sendP).resolves.toBeUndefined();

    const attach = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    expect(attach.payload.sessionId).toBe("new-1");
    ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "new-1", epoch: "eN", lastEventId: 2 }) });
    ws.serverSend({ type: "event", payload: { type: "agent_start", sessionId: "new-1", eventId: 2, epoch: "eN" } });
    await flush();

    // A cross-tab navigate fence arrives while the accepted turn runs → it is
    // deferred (anchor/generation frozen) and the bubble is untouched.
    ws.serverSend({ type: "event", payload: { type: "session_changed", sessionId: "new-1", cwd: "/x", leafId: "entry-2", eventId: 3, epoch: "eN" } });
    await flush();
    const controller = h.controller("new-1")!;
    const deferred = controller.getSnapshot();
    expect(deferred.historyAnchorLeafId).toBeNull();
    expect(deferred.historyGeneration).toBe(0);
    expect(deferred.optimisticEntries).toHaveLength(1);

    // Terminal releases the deferred fence.
    ws.serverSend({ type: "turn_status", authority: authoritySnapshot("new-1", "eN"), payload: { sessionId: "new-1", epoch: "eN", operationId: submit.payload.operationId, turnId: "turn-1", revision: 1, state: "completed" } });
    await flush();
    const rebased = controller.getSnapshot();
    expect(rebased.historyAnchorLeafId).toBe("entry-2");
    expect(rebased.historyGeneration).toBe(1);
    expect(rebased.optimisticEntries).toHaveLength(1);
  });

  it("a transient rejection resends the SAME operation with the SAME payload, silently", async () => {
    const h = createHarness();
    const ws = await connectReady(h);
    await createSeededSession(h, ws);

    let settled = false;
    const sendP = h.store.sendPromptToSession("new-1", "same logical prompt", undefined, {
      model: { provider: "anthropic", modelId: "claude-opus-4" },
      thinkingLevel: "high",
    });
    void sendP.then(() => { settled = true; }, () => { settled = true; });
    await flush();
    const first = submitFrames(ws)[0]!;

    // Transient: the authority is restarting. Nothing surfaces.
    ws.serverSend({ type: "submit_turn_result", id: first.id, payload: transientRejection(first.payload.operationId as string) });
    await flush();
    expect(settled).toBe(false);
    expect(h.controller("new-1")?.getSnapshot().optimisticEntries).toHaveLength(1);

    const retrySocket = await h.reconnectAfterFailure({ sessionId: "new-1", epoch: "eN" });
    await flush();
    const frames = submitFrames(retrySocket);
    expect(frames).toHaveLength(1);
    const retry = frames[0]!;
    // Same logical operation, byte-identical payload (staged overrides intact).
    expect(retry.payload).toEqual(first.payload);

    // The acceptance answers the retry, i.e. arrives on the NEW socket.
    retrySocket.serverSend({ type: "submit_turn_result", id: retry.id, payload: accepted(first.payload.operationId as string, 3) });
    await expect(sendP).resolves.toBeUndefined();

    // A committed session_changed leaf fence interleaving with the accepted
    // turn adds no new logical operation and never removes the bubble.
    const attach = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(retrySocket, "attach")!;
    retrySocket.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "new-1", epoch: "eN", lastEventId: 3 }) });
    await flush();
    retrySocket.serverSend({ type: "event", payload: { type: "session_changed", sessionId: "new-1", cwd: "/x", leafId: "entry-5", eventId: 4, epoch: "eN" } });
    await flush();

    const allFrames = [...submitFrames(ws), ...submitFrames(retrySocket)];
    expect(new Set(allFrames.map((frame) => frame.payload.operationId)).size).toBe(1);
    expect(h.controller("new-1")!.getSnapshot().optimisticEntries).toHaveLength(1);
  });

  it("a proven-final rejection ends the send: bubble removed, no further frames", async () => {
    const h = createHarness();
    const ws = await connectReady(h);
    await createSeededSession(h, ws);

    const settled = h.store.sendPromptToSession("new-1", "hello").then(
      () => ({ ok: true as const }),
      (cause: unknown) => ({ ok: false as const, cause }),
    );
    await flush();
    const submit = submitFrames(ws)[0]!;
    ws.serverSend({
      type: "submit_turn_result",
      id: submit.id,
      payload: { status: "rejected", delivery: "not_delivered", sessionId: "new-1", operationId: submit.payload.operationId, error: { code: "not_found", message: "session is gone", retryable: false } },
    });
    const outcome = await settled;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect((outcome.cause as { code?: string }).code).toBe("not_found");
    expect(h.controller("new-1")!.getSnapshot().optimisticEntries).toHaveLength(0);

    // No retry after a proven-final answer, even across a reconnect.
    const afterReconnect = await h.reconnectAfterFailure({ sessionId: "new-1", epoch: "eN" });
    await flush();
    expect(submitFrames(afterReconnect)).toHaveLength(0);
  });
});
