/**
 * Phase 5A — provisional create / staging / Phase 4A.0.1 bounded-repair PARITY
 * (deterministic, injected frames; NOT executed in this worktree — validation
 * pending).
 *
 * The bounded created-seed repair itself is UNALTERED. These tests prove the
 * Phase 5A additions (identity-bound optimism + committed session_changed leaf
 * fence) are behavior-neutral for the provisional create/staging/repair path:
 *  - the first negotiated submit of a freshly created (unattached) session
 *    binds optimism to the operation identity exactly like the attached path;
 *  - a committed session_changed leaf fence for the PENDING session defers
 *    (turn active) without touching the created seed fence, repair counters or
 *    staged activation settings, and applies at the turn's terminal;
 *  - a stale created-seed conflict still repairs EXACTLY ONCE with the SAME
 *    logical operation (same operationId/payload, only expectedRevision
 *    advances) when a leaf fence interleaves — never a third frame;
 *  - staged activation overrides survive the deferred fence unchanged on the
 *    repaired envelope.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, flush, lastFrame, snapshotPayload, type RuntimeHarness } from "./testing/harness";
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

function rejectedConflict(operationId: string, epoch: string, revision: number) {
  return {
    status: "rejected",
    delivery: "not_delivered",
    sessionId: "new-1",
    operationId,
    epoch,
    revision,
    error: { code: "conflict", message: "opaque authority text", retryable: false },
  };
}

describe("SessionController — Phase 5A provisional create/staging/repair parity", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("the first negotiated submit of a created (unattached) session binds optimism to the operation identity", async () => {
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
      expectedEpoch: "eN",
      expectedRevision: 1,
      activationOverrides: { model: { provider: "anthropic", modelId: "claude-opus-4" }, thinkingLevel: "high" },
    });

    // Provisional parity: the bubble is identity-bound BEFORE any attach —
    // same binding shape as the attached path.
    const bubble = h.controller("new-1")!.getSnapshot().optimisticEntries;
    expect(bubble).toHaveLength(1);
    expect(bubble[0]!.identity).toMatchObject({ operationId: submit.payload.operationId, userEntryId: null, finalLeafId: null });

    ws.serverSend({
      type: "submit_turn_result",
      id: submit.id,
      payload: {
        status: "accepted",
        delivery: "accepted",
        sessionId: "new-1",
        epoch: "eN",
        revision: 2,
        operationId: submit.payload.operationId,
        turnId: "turn-1",
        snapshot: snapshotPayload({ sessionId: "new-1", epoch: "eN", lastEventId: 2 }).snapshot as never,
        turnStatus: { sessionId: "new-1", epoch: "eN", operationId: submit.payload.operationId, turnId: "turn-1", revision: 0, state: "admitted" },
      },
    });
    await expect(sendP).resolves.toBeTruthy();
    expect(h.controller("new-1")!.getSnapshot().optimisticEntries[0]!.identity).toMatchObject({ turnId: "turn-1" });
  });

  it("a committed leaf fence for the pending provisional session defers and applies at terminal WITHOUT touching the created seed", async () => {
    const h = createHarness();
    const ws = await connectReady(h);
    await createSeededSession(h, ws);

    const sendP = h.store.sendPromptToSession("new-1", "hello");
    await flush();
    const submit = submitFrames(ws)[0]!;
    ws.serverSend({
      type: "submit_turn_result",
      id: submit.id,
      payload: {
        status: "accepted",
        delivery: "accepted",
        sessionId: "new-1",
        epoch: "eN",
        revision: 2,
        operationId: submit.payload.operationId,
        turnId: "turn-1",
        snapshot: snapshotPayload({ sessionId: "new-1", epoch: "eN", lastEventId: 2 }).snapshot as never,
        turnStatus: { sessionId: "new-1", epoch: "eN", operationId: submit.payload.operationId, turnId: "turn-1", revision: 0, state: "admitted" },
      },
    });
    await expect(sendP).resolves.toBeTruthy();
    // Post-acceptance attach of the provisional session.
    const attach = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    expect(attach.payload.sessionId).toBe("new-1");
    ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "new-1", epoch: "eN", lastEventId: 2 }) });
    await flush();

    // Cross-tab navigate fence arrives while OUR accepted turn is running →
    // deferred (anchor/generation frozen); the created-seed fence consumed by
    // admission stays irrelevant (cursor-based, leaf-independent).
    // Frozen Phase 4 attach semantics: the created session's authority (epoch +
    // exact create cursor) makes the first observation attach a RESUME, and the
    // resumeStatus "snapshot" snapshot is SAME-EPOCH — the history layer is
    // preserved, so the generation stays at its initial 0 (no fresh-attach
    // increment) until a leaf fence actually rebases.
    ws.serverSend({ type: "event", payload: { type: "session_changed", sessionId: "new-1", cwd: "/x", leafId: "entry-2", eventId: 3, epoch: "eN" } });
    await flush();
    const controller = h.controller("new-1")!;
    const deferred = controller.getSnapshot();
    expect(deferred.historyAnchorLeafId).toBeNull();
    expect(deferred.historyGeneration).toBe(0);
    expect(deferred.optimisticEntries).toHaveLength(1);

    // Terminal releases the deferred fence (leaf differs from the null anchor).
    ws.serverSend({ type: "turn_status", payload: { sessionId: "new-1", epoch: "eN", operationId: submit.payload.operationId, turnId: "turn-1", revision: 1, state: "completed" } });
    await flush();
    const rebased = controller.getSnapshot();
    expect(rebased.historyAnchorLeafId).toBe("entry-2");
    expect(rebased.historyGeneration).toBe(1);
    expect(rebased.optimisticEntries).toHaveLength(1);
  });

  it("stale created-seed conflict still repairs EXACTLY ONCE with the same logical operation when a leaf fence interleaves", async () => {
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
    expect(first.payload).toMatchObject({ expectedEpoch: "eN", expectedRevision: 1 });

    // Stale seed conflict (a later global compatibility journal event advanced
    // the authority revision) → the bounded Phase 4A.0.1 repair fires ONCE.
    ws.serverSend({ type: "submit_turn_result", id: first.id, payload: rejectedConflict(first.payload.operationId as string, "eN", 2) });
    await flush();

    const frames = submitFrames(ws);
    expect(frames).toHaveLength(2);
    const retry = frames[1]!;
    // Same logical operation; ONLY expectedRevision advanced; staged overrides
    // preserved verbatim (parity — the leaf fence never touches the repair).
    expect(retry.payload).toEqual({ ...first.payload, expectedRevision: 2 });
    expect(retry.payload.operationId).toBe(first.payload.operationId);
    expect(h.controller("new-1")?.getSnapshot().optimisticEntries).toHaveLength(1);
    expect(settled).toBe(false);

    // A committed session_changed leaf fence interleaves between the repaired
    // envelope and its admission — it must not add repairs or settle anything.
    ws.serverSend({ type: "submit_turn_result", id: retry.id, payload: {
      status: "accepted",
      delivery: "accepted",
      sessionId: "new-1",
      epoch: "eN",
      revision: 3,
      operationId: retry.payload.operationId,
      turnId: "turn-repair",
      snapshot: snapshotPayload({ sessionId: "new-1", epoch: "eN", lastEventId: 3 }).snapshot as never,
      turnStatus: { sessionId: "new-1", epoch: "eN", operationId: retry.payload.operationId, turnId: "turn-repair", revision: 0, state: "admitted" },
    } });
    await expect(sendP).resolves.toBeTruthy();
    const attach = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "new-1", epoch: "eN", lastEventId: 3 }) });
    await flush();
    ws.serverSend({ type: "event", payload: { type: "session_changed", sessionId: "new-1", cwd: "/x", leafId: "entry-5", eventId: 4, epoch: "eN" } });
    await flush();

    // The bounded repair contract: exactly ONE automatic conflict repair fired
    // before admission (the two pre-admission frames asserted above). Per the
    // frozen Phase 4 semantics the post-accept exact attach MAY resend the SAME
    // operation as its status-subscription reopen — so the total frame count is
    // NOT the contract. What must hold: a single logical operation (one distinct
    // operationId), every frame carries it, and no THIRD automatic repair —
    // anything after the repaired envelope is a verbatim resend of it.
    const framesAfterAdmission = submitFrames(ws);
    expect(new Set(framesAfterAdmission.map((frame) => frame.payload.operationId)).size).toBe(1);
    expect(framesAfterAdmission.every((frame) => frame.payload.operationId === first.payload.operationId)).toBe(true);
    for (const frame of framesAfterAdmission.slice(2)) {
      expect(frame.payload).toEqual(retry.payload);
    }
    // The bubble survives until its own identity commit.
    expect(h.controller("new-1")!.getSnapshot().optimisticEntries).toHaveLength(1);

    // A SECOND conflict after the repair is a normal definite failure (never a
    // third repair frame) — bounded semantics untouched by Phase 5A.
    ws.serverSend({ type: "turn_status", payload: { sessionId: "new-1", epoch: "eN", operationId: retry.payload.operationId, turnId: "turn-repair", revision: 1, state: "completed" } });
    await flush();
    expect(h.controller("new-1")!.getSnapshot().turnActive).toBe(false);
    // Terminal never mints a new operation either.
    expect(new Set(submitFrames(ws).map((frame) => frame.payload.operationId)).size).toBe(1);
  });

  it("deferred leaf-fence parity: the provisional seed submit is never fenced into a history rebase before admission", async () => {
    const h = createHarness();
    const ws = await connectReady(h);
    await createSeededSession(h, ws);

    // A leaf fence for the provisional session arrives while its FIRST submit
    // is still in flight (not yet admitted, not attached → no history layer).
    const sendP = h.store.sendPromptToSession("new-1", "hello");
    await flush();
    const submit = submitFrames(ws)[0]!;
    ws.serverSend({ type: "submit_turn_result", id: submit.id, payload: {
      status: "accepted",
      delivery: "accepted",
      sessionId: "new-1",
      epoch: "eN",
      revision: 2,
      operationId: submit.payload.operationId,
      turnId: "turn-1",
      snapshot: snapshotPayload({ sessionId: "new-1", epoch: "eN", lastEventId: 2 }).snapshot as never,
      turnStatus: { sessionId: "new-1", epoch: "eN", operationId: submit.payload.operationId, turnId: "turn-1", revision: 0, state: "admitted" },
    } });
    await expect(sendP).resolves.toBeTruthy();
    // The pre-admission in-flight window: no attach, no history anchor, and the
    // fence arriving now is simply deferred behind the active turn. The created
    // authority later makes the first observation a resume/same-epoch attach, so
    // the history generation stays at its initial 0 (no fresh-attach increment).
    expect(h.controller("new-1")!.getSnapshot().attached).toBe(false);
    const attach = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "new-1", epoch: "eN", lastEventId: 2 }) });
    await flush();
    ws.serverSend({ type: "event", payload: { type: "session_changed", sessionId: "new-1", cwd: "/x", leafId: "entry-2", eventId: 3, epoch: "eN" } });
    await flush();
    const view = h.controller("new-1")!.getSnapshot();
    expect(view.attached).toBe(true);
    expect(view.historyAnchorLeafId).toBeNull();
    expect(view.historyGeneration).toBe(0);
  });
});
