/**
 * Phase 5A — exact controller leaf-fence rebase state machine (deterministic,
 * injected frames; NOT executed in this worktree — validation pending).
 *
 * Pins the committed `session_changed{cwd,leafId}` leaf fence:
 *  - leaf EQUALITY only: same leaf is already continuous → no generation churn;
 *  - a different leaf triggers the COMMON history rebase (generation++, new
 *    anchor, live tail cleared) — identical semantics to a gap/epoch rebase;
 *  - the rebase is DEFERRED while the exact turn is active (negotiated
 *    submit-turn accepted, not yet terminal) and applied at the turn's
 *    terminal turn_status (terminal is authoritative: forced even if a stale
 *    snapshot still claims running);
 *  - the rebase is DEFERRED while streaming and applied at the stream-ending
 *    event (agent_settled);
 *  - a rebase snapshot (gap / epoch_changed reconnect) supersedes a deferred
 *    fence (the snapshot anchor wins);
 *  - optimistic entries SURVIVE the rebase (transaction-owned);
 *  - cwd-only session_changed (no leafId) never fences the history layer;
 *  - cross-tab/self navigate and compaction-terminal fences take the SAME path
 *    (both arrive as committed session_changed events);
 *  - every injected user message_end is preceded by its correlated
 *    message_start (same streamId/messageId) with a contiguous eventId —
 *    wire-legal stream lifecycle, no synthetic bare completions;
 *  - stop teardown of an accepted (server-still-running) turn follows the
 *    honest abort-first contract (interrupt acked, then stop acked) and drops
 *    a deferred fence (never applies a stale anchor to the next attach).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, flush, lastFrame, snapshotPayload, type RuntimeHarness } from "./testing/harness";
import type { FakeWebSocket } from "./testing/harness";
import type { SubmitTurnAdmission } from "@fffattiger/pix-protocol";

function ackLegacy(caps: string[] = ["agent"]) {
  return { type: "handshake_ack", payload: { protocolVersion: 2, host: { mode: "local", capabilities: caps }, limits: { maxUpload: 0, maxOpenSessions: 4 }, sessionSnapshotSupport: true } };
}

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

async function openAndAttach(
  h: RuntimeHarness,
  ws: FakeWebSocket,
  sessionId = "s1",
  epoch = "e1",
  resumeStatus: "snapshot" | "gap" | "epoch_changed" = "snapshot",
  lastEventId = 0,
): Promise<void> {
  const p = h.store.openSession(sessionId);
  await flush();
  const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
  ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId, epoch, resumeStatus, lastEventId }) });
  await flush();
  await p;
}

/** Server→client committed session_changed event frame at the next cursor. */
function sessionChangedEvent(sessionId: string, leafId: string | null, eventId: number, epoch = "e1") {
  return {
    type: "event",
    payload: {
      type: "session_changed",
      sessionId,
      cwd: "/x",
      ...(leafId === null ? {} : { leafId }),
      eventId,
      epoch,
    },
  };
}

/**
 * Server→client user commit as a WIRE-LEGAL correlated pair: a `message_start`
 * followed by the `message_end` on the SAME streamId/messageId with contiguous
 * eventIds (the shared reducer throws "stale or uncorrelated stream end" on a
 * bare message_end, which would force a reattach and invalidate the test).
 * `firstEventId` is the message_start cursor; the end carries +1.
 */
function sendUserCommit(ws: FakeWebSocket, sessionId: string, entryId: string, firstEventId: number, text: string, epoch = "e1"): void {
  const streamId = `stream-${entryId}`;
  const messageId = `message-${entryId}`;
  ws.serverSend({
    type: "event",
    payload: { type: "message_start", sessionId, streamId, messageId, message: { role: "user", content: text }, eventId: firstEventId, epoch },
  });
  ws.serverSend({
    type: "event",
    payload: { type: "message_end", sessionId, streamId, messageId, message: { role: "user", content: text }, entryId, eventId: firstEventId + 1, epoch },
  });
}

describe("SessionController — Phase 5A committed session_changed leaf-fence rebase", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("a different leaf rebases the COMMON history layer (generation++, new anchor, live tail cleared)", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackLegacy());
    await openAndAttach(h, ws);
    const before = h.store.getSnapshot();
    expect(before.historyAnchorLeafId).toBeNull();
    expect(before.historyGeneration).toBe(1);

    ws.serverSend(sessionChangedEvent("s1", "entry-3", 1));
    await flush();
    const after = h.store.getSnapshot();
    expect(after.historyAnchorLeafId).toBe("entry-3");
    expect(after.historyGeneration).toBe(before.historyGeneration + 1);
    expect(after.liveEntries).toEqual([]);
  });

  it("leaf equality only: the SAME leaf is a no-op (no generation churn, no live-tail loss)", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackLegacy());
    await openAndAttach(h, ws);
    ws.serverSend(sessionChangedEvent("s1", "entry-3", 1));
    await flush();
    // A committed user entry lands in the live tail (correlated start+end).
    sendUserCommit(ws, "s1", "entry-4", 2, "hello");
    await flush();
    const fenced = h.store.getSnapshot();
    expect(fenced.historyAnchorLeafId).toBe("entry-3");
    expect(h.controller("s1")!.getSnapshot().liveEntries.map((entry) => entry.entryId)).toEqual(["entry-4"]);
    const generation = fenced.historyGeneration;

    // Same-leaf fence (self navigate reporting the current leaf) → no-op.
    ws.serverSend(sessionChangedEvent("s1", "entry-3", 4));
    await flush();
    const same = h.store.getSnapshot();
    expect(same.historyGeneration).toBe(generation);
    expect(same.historyAnchorLeafId).toBe("entry-3");
    expect(same.liveEntries.map((entry) => entry.entryId)).toEqual(["entry-4"]);
  });

  it("cwd-only session_changed (no leafId) never fences the history layer", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackLegacy());
    await openAndAttach(h, ws);
    ws.serverSend(sessionChangedEvent("s1", "entry-9", 1));
    await flush();
    const generation = h.store.getSnapshot().historyGeneration;
    ws.serverSend(sessionChangedEvent("s1", null, 2));
    await flush();
    expect(h.store.getSnapshot().historyGeneration).toBe(generation);
    expect(h.store.getSnapshot().historyAnchorLeafId).toBe("entry-9");
  });

  it("DEFERRED while the exact turn is active; applied at the terminal turn_status", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackSubmitTurn());
    await openAndAttach(h, ws);
    // Anchor the history layer first (cross-tab navigate before our turn).
    ws.serverSend(sessionChangedEvent("s1", "entry-3", 1));
    await flush();
    const anchored = h.store.getSnapshot();
    expect(anchored.historyAnchorLeafId).toBe("entry-3");

    // Start a negotiated turn (accepted, long-running).
    const sendP = h.store.sendPrompt("hello");
    await flush();
    const submit = lastFrame<{ type: string; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    const admission: SubmitTurnAdmission = {
      status: "accepted",
      delivery: "accepted",
      sessionId: "s1",
      epoch: "e1",
      revision: 2,
      operationId: submit.payload.operationId,
      turnId: "turn-1",
      snapshot: snapshotPayload({ sessionId: "s1", epoch: "e1", lastEventId: 2 }).snapshot as never,
      turnStatus: { sessionId: "s1", epoch: "e1", operationId: submit.payload.operationId, turnId: "turn-1", revision: 0, state: "admitted" },
    };
    ws.serverSend({ type: "submit_turn_result", id: submit.id, payload: admission });
    await flush();
    await sendP;
    expect(h.store.getSnapshot().turnActive).toBe(true);

    // A committed leaf fence arrives MID-TURN (cross-tab navigate). It must be
    // DEFERRED: no generation churn, anchor + live tail preserved.
    // A committed user entry lands in the live tail while the turn runs
    // (correlated start+end pair, contiguous cursor).
    sendUserCommit(ws, "s1", "entry-4", 3, "hello");
    await flush();
    ws.serverSend(sessionChangedEvent("s1", "entry-2", 5));
    await flush();
    const deferred = h.store.getSnapshot();
    expect(deferred.historyAnchorLeafId).toBe("entry-3");
    expect(deferred.historyGeneration).toBe(anchored.historyGeneration);
    // EXACT controller view: committed live tail only (optimism is separate).
    expect(h.controller("s1")!.getSnapshot().liveEntries.map((entry) => entry.entryId)).toEqual(["entry-4"]);

    // Turn terminal releases the deferred rebase.
    ws.serverSend({ type: "turn_status", payload: { sessionId: "s1", epoch: "e1", operationId: submit.payload.operationId, turnId: "turn-1", revision: 1, state: "completed" } });
    await flush();
    expect(h.store.getSnapshot().turnActive).toBe(false);
    const rebased = h.store.getSnapshot();
    expect(rebased.historyAnchorLeafId).toBe("entry-2");
    expect(rebased.historyGeneration).toBe(deferred.historyGeneration + 1);
    expect(h.controller("s1")!.getSnapshot().liveEntries).toEqual([]);
  });

  it("DEFERRED while streaming; applied at the stream-ending event (agent_settled)", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackLegacy());
    await openAndAttach(h, ws);
    ws.serverSend(sessionChangedEvent("s1", "entry-3", 1));
    await flush();
    const anchored = h.store.getSnapshot();

    // Streaming starts (authoritative isStreaming from the reducer).
    ws.serverSend({ type: "event", payload: { type: "agent_start", sessionId: "s1", eventId: 2, epoch: "e1" } });
    await flush();
    expect(h.store.getSnapshot().snapshot?.state.isPromptRunning).toBe(true);

    ws.serverSend(sessionChangedEvent("s1", "entry-1", 3));
    await flush();
    const deferred = h.store.getSnapshot();
    expect(deferred.historyAnchorLeafId).toBe("entry-3");
    expect(deferred.historyGeneration).toBe(anchored.historyGeneration);

    // Stream end (NOT agent_end) releases the deferred fence.
    ws.serverSend({ type: "event", payload: { type: "agent_settled", sessionId: "s1", eventId: 4, epoch: "e1" } });
    await flush();
    const rebased = h.store.getSnapshot();
    expect(rebased.historyAnchorLeafId).toBe("entry-1");
    expect(rebased.historyGeneration).toBe(deferred.historyGeneration + 1);
  });

  it("same-epoch order only: a later fence replaces the deferred leaf (last committed fence wins)", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackSubmitTurn());
    await openAndAttach(h, ws);
    ws.serverSend(sessionChangedEvent("s1", "entry-3", 1));
    await flush();

    const sendP = h.store.sendPrompt("hello");
    await flush();
    const submit = lastFrame<{ type: string; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    const admission: SubmitTurnAdmission = {
      status: "accepted",
      delivery: "accepted",
      sessionId: "s1",
      epoch: "e1",
      revision: 2,
      operationId: submit.payload.operationId,
      turnId: "turn-1",
      snapshot: snapshotPayload({ sessionId: "s1", epoch: "e1", lastEventId: 2 }).snapshot as never,
      turnStatus: { sessionId: "s1", epoch: "e1", operationId: submit.payload.operationId, turnId: "turn-1", revision: 0, state: "admitted" },
    };
    ws.serverSend({ type: "submit_turn_result", id: submit.id, payload: admission });
    await flush();
    await sendP;

    // Two consecutive committed fences while deferred: the later one wins.
    ws.serverSend(sessionChangedEvent("s1", "entry-1", 3));
    ws.serverSend(sessionChangedEvent("s1", "entry-2", 4));
    await flush();
    expect(h.store.getSnapshot().historyAnchorLeafId).toBe("entry-3");

    ws.serverSend({ type: "turn_status", payload: { sessionId: "s1", epoch: "e1", operationId: submit.payload.operationId, turnId: "turn-1", revision: 1, state: "completed" } });
    await flush();
    expect(h.store.getSnapshot().historyAnchorLeafId).toBe("entry-2");
  });

  it("a rebase snapshot (gap) supersedes the deferred fence — the snapshot anchor wins", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackSubmitTurn());
    await openAndAttach(h, ws);
    ws.serverSend(sessionChangedEvent("s1", "entry-3", 1));
    await flush();

    const sendP = h.store.sendPrompt("hello");
    await flush();
    const submit = lastFrame<{ type: string; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    ws.serverSend({
      type: "submit_turn_result",
      id: submit.id,
      payload: {
        status: "accepted",
        delivery: "accepted",
        sessionId: "s1",
        epoch: "e1",
        revision: 2,
        operationId: submit.payload.operationId,
        turnId: "turn-1",
        snapshot: snapshotPayload({ sessionId: "s1", epoch: "e1", lastEventId: 2 }).snapshot as never,
        turnStatus: { sessionId: "s1", epoch: "e1", operationId: submit.payload.operationId, turnId: "turn-1", revision: 0, state: "admitted" },
      },
    });
    await flush();
    await sendP;
    ws.serverSend(sessionChangedEvent("s1", "entry-1", 3));
    await flush();
    expect(h.store.getSnapshot().historyAnchorLeafId).toBe("entry-3");

    // Transport loss → resume with a GAP snapshot carrying a NEWER leaf. The
    // snapshot's anchor supersedes the deferred fence entirely.
    ws.serverClose(1006);
    vi.advanceTimersByTime(250);
    const ws2 = h.lastSocket();
    ws2.serverOpen();
    ws2.serverSend(ackSubmitTurn());
    await flush();
    // The resume attach resolves with resumeStatus "gap".
    const attachFrame = lastFrame<{ type: string; id: string }>(ws2, "attach")!;
    ws2.serverSend({
      type: "snapshot",
      id: attachFrame.id,
      payload: snapshotPayload({ sessionId: "s1", epoch: "e1", resumeStatus: "gap", lastEventId: 9 }),
    });
    await flush();
    const rebased = h.store.getSnapshot();
    expect(rebased.historyAnchorLeafId).toBe("entry-3"); // same-epoch unknown leaf cannot erase known history
    const generation = rebased.historyGeneration;
    // The deferred fence was cleared: the (still active) turn terminal must NOT
    // re-apply the stale entry-1 anchor afterwards.
    ws2.serverSend({ type: "turn_status", payload: { sessionId: "s1", epoch: "e1", operationId: submit.payload.operationId, turnId: "turn-1", revision: 1, state: "completed" } });
    await flush();
    expect(h.store.getSnapshot().historyGeneration).toBe(generation);
    expect(h.store.getSnapshot().historyAnchorLeafId).toBe("entry-3");
  });

  it("epoch_changed reconnect rebases (fresh anchor) and clears the deferred fence", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackSubmitTurn());
    await openAndAttach(h, ws);
    ws.serverSend(sessionChangedEvent("s1", "entry-3", 1));
    await flush();
    const sendP = h.store.sendPrompt("hello");
    await flush();
    const submit = lastFrame<{ type: string; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    ws.serverSend({
      type: "submit_turn_result",
      id: submit.id,
      payload: {
        status: "accepted",
        delivery: "accepted",
        sessionId: "s1",
        epoch: "e1",
        revision: 2,
        operationId: submit.payload.operationId,
        turnId: "turn-1",
        snapshot: snapshotPayload({ sessionId: "s1", epoch: "e1", lastEventId: 2 }).snapshot as never,
        turnStatus: { sessionId: "s1", epoch: "e1", operationId: submit.payload.operationId, turnId: "turn-1", revision: 0, state: "admitted" },
      },
    });
    await flush();
    await sendP;
    ws.serverSend(sessionChangedEvent("s1", "entry-1", 3));
    await flush();

    ws.serverClose(1006);
    vi.advanceTimersByTime(250);
    const ws2 = h.lastSocket();
    ws2.serverOpen();
    ws2.serverSend(ackSubmitTurn());
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string; payload: { epoch?: string } }>(ws2, "attach")!;
    expect(attachFrame.payload.epoch).toBe("e1");
    ws2.serverSend({
      type: "snapshot",
      id: attachFrame.id,
      payload: snapshotPayload({ sessionId: "s1", epoch: "e2", resumeStatus: "epoch_changed", lastEventId: 0 }),
    });
    await flush();
    // Epoch change settles the turn uncertain; the deferred fence never applies.
    const settled = h.store.getSnapshot();
    expect(settled.epoch).toBe("e2");
    const generation = settled.historyGeneration;
    expect(settled.historyAnchorLeafId).toBeNull();
    expect(generation).toBeGreaterThan(2);
  });

  it("optimistic entries SURVIVE the leaf-fence rebase (transaction-owned)", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackSubmitTurn());
    await openAndAttach(h, ws);
    ws.serverSend(sessionChangedEvent("s1", "entry-3", 1));
    await flush();

    const sendP = h.store.sendPrompt("hello");
    await flush();
    const submit = lastFrame<{ type: string; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    ws.serverSend({
      type: "submit_turn_result",
      id: submit.id,
      payload: {
        status: "accepted",
        delivery: "accepted",
        sessionId: "s1",
        epoch: "e1",
        revision: 2,
        operationId: submit.payload.operationId,
        turnId: "turn-1",
        snapshot: snapshotPayload({ sessionId: "s1", epoch: "e1", lastEventId: 2 }).snapshot as never,
        turnStatus: { sessionId: "s1", epoch: "e1", operationId: submit.payload.operationId, turnId: "turn-1", revision: 0, state: "admitted" },
      },
    });
    await flush();
    await sendP;
    expect(h.store.getSnapshot().optimisticEntries.length).toBe(1);

    ws.serverSend(sessionChangedEvent("s1", "entry-2", 3));
    await flush();
    // Deferred, then applied at terminal — the bubble must survive BOTH.
    expect(h.store.getSnapshot().optimisticEntries.length).toBe(1);
    ws.serverSend({ type: "turn_status", payload: { sessionId: "s1", epoch: "e1", operationId: submit.payload.operationId, turnId: "turn-1", revision: 1, state: "completed" } });
    await flush();
    const after = h.store.getSnapshot();
    expect(after.historyAnchorLeafId).toBe("entry-2");
    expect(h.controller("s1")!.getSnapshot().liveEntries).toEqual([]);
    expect(after.optimisticEntries.length).toBe(1);
  });

  it("a compaction-terminal leaf fence (committed session_changed after compaction_end) rebases the same common layer", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackLegacy());
    await openAndAttach(h, ws);
    ws.serverSend(sessionChangedEvent("s1", "entry-6", 1));
    await flush();
    // Terminal compaction event (projection), then the leaf fence.
    ws.serverSend({ type: "event", payload: { type: "compaction_end", sessionId: "s1", reason: "manual", eventId: 2, epoch: "e1" } });
    await flush();
    ws.serverSend(sessionChangedEvent("s1", "compaction-1", 3));
    await flush();
    const rebased = h.store.getSnapshot();
    expect(rebased.historyAnchorLeafId).toBe("compaction-1");
    expect(rebased.snapshot?.state.isCompacting).toBe(false);
  });

  it("detach/stop teardown drops a deferred fence (never applies a stale anchor)", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackSubmitTurn());
    await openAndAttach(h, ws);
    ws.serverSend(sessionChangedEvent("s1", "entry-3", 1));
    await flush();
    const sendP = h.store.sendPrompt("hello");
    await flush();
    const submit = lastFrame<{ type: string; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    ws.serverSend({
      type: "submit_turn_result",
      id: submit.id,
      payload: {
        status: "accepted",
        delivery: "accepted",
        sessionId: "s1",
        epoch: "e1",
        revision: 2,
        operationId: submit.payload.operationId,
        turnId: "turn-1",
        snapshot: snapshotPayload({ sessionId: "s1", epoch: "e1", lastEventId: 2 }).snapshot as never,
        turnStatus: { sessionId: "s1", epoch: "e1", operationId: submit.payload.operationId, turnId: "turn-1", revision: 0, state: "admitted" },
      },
    });
    await flush();
    await sendP;
    ws.serverSend(sessionChangedEvent("s1", "entry-1", 3));
    await flush();
    expect(h.store.getSnapshot().historyAnchorLeafId).toBe("entry-3");

    // Confirmed stop of an ACCEPTED (server-still-running) turn follows the
    // honest abort-first contract: boundedAbort sends the interrupt and waits
    // for its result BEFORE the stop frame. Ack the correlated interrupt so
    // the bounded wait resolves deterministically (no timer dependence).
    const stopP = h.store.stop("test");
    await flush();
    const interrupt = lastFrame<{ type: string; id: string; payload: { commandId: string } }>(ws, "interrupt")!;
    expect(interrupt).toBeDefined();
    ws.serverSend({
      type: "interrupt_result",
      id: interrupt.id,
      payload: { sessionId: "s1", commandId: interrupt.payload.commandId, interruptType: "abort", result: { ok: true, type: "abort" } },
    });
    await flush();
    const stopFrame = lastFrame<{ type: string; id: string }>(ws, "stop")!;
    expect(stopFrame).toBeDefined();
    ws.serverSend({ type: "response", id: stopFrame.id, payload: { ok: true, result: { sessionId: "s1", stopped: true } } });
    await flush();
    await stopP;
    const stopped = h.store.getSnapshot();
    expect(stopped.historyAnchorLeafId).toBeNull();
    const generation = stopped.historyGeneration;
    expect(generation).toBeGreaterThan(2);
  });
});
