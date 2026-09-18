/**
 * Phase 5A — identity optimistic commit (deterministic, injected frames; NOT
 * executed in this worktree — validation pending).
 *
 * Pins:
 *  - the negotiated submit-turn bubble is BOUND to {operationId} at submit and
 *    refined by authoritative pushes (turnId from admission; userEntryId /
 *    finalLeafId from turn_status);
 *  - a committed user message_end removes the bubble BY EXACT IDENTITY even
 *    when the committed text DIFFERS from the optimistic text;
 *  - WRONG identity never removes: a message_end with another entryId never
 *    consumes an identity-bound bubble, even when the text matches exactly;
 *  - another operation's identity never removes this bubble;
 *  - the LEGACY path (no negotiated submit seam → no identity) still uses the
 *    quarantined text fallback — scoped to candidates whose identity is
 *    UNKNOWN (none, or operationId-only before the authority reports the
 *    user entry id), matching the live controller boundary;
 *  - the identity survives a rebase (ghost prevention) and the persisted-page
 *    ghost is removed by identity in the transcript merge (see the dedicated
 *    merge-table tests);
 *  - every injected user message_end is preceded by its correlated
 *    message_start (same streamId/messageId) with a contiguous eventId —
 *    wire-legal stream lifecycle, no synthetic bare completions.
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

async function openAndAttachTurn(h: RuntimeHarness, sessionId = "s1", epoch = "e1"): Promise<FakeWebSocket> {
  h.store.connect();
  const ws = h.lastSocket();
  ws.serverOpen();
  ws.serverSend(ackSubmitTurn());
  await flush();
  const p = h.store.openSession(sessionId);
  await flush();
  const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
  ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId, epoch }) });
  await flush();
  await p;
  return ws;
}

function admissionFor(operationId: string, epoch = "e1", turnId = "turn-1", revision = 1, sessionId = "s1"): SubmitTurnAdmission {
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

async function startAcceptedTurn(h: RuntimeHarness, ws: FakeWebSocket, prompt: string, epoch = "e1", turnId = "turn-1") {
  const sendP = h.store.sendPrompt(prompt);
  await flush();
  const submit = lastFrame<{ type: string; id: string; payload: { operationId: string; prompt: string } }>(ws, "submit_turn")!;
  ws.serverSend({ type: "submit_turn_result", id: submit.id, payload: admissionFor(submit.payload.operationId, epoch, turnId) });
  await flush();
  await sendP;
  return submit;
}

/**
 * WIRE-LEGAL user commit over the ws: a correlated `message_start` +
 * `message_end` pair on the SAME streamId/messageId with contiguous eventIds
 * (`firstEventId` is the start cursor; the end carries +1). The shared reducer
 * throws on a bare message_end, which would force a reattach and invalidate
 * the test — never inject synthetic unkeyed completions.
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

function turnStatus(sessionId: string, operationId: string, revision: number, state: string, extra: Record<string, unknown> = {}, epoch = "e1", turnId = "turn-1") {
  return { type: "turn_status", payload: { sessionId, epoch, operationId, turnId, revision, state, ...extra } };
}

describe("SessionController — Phase 5A identity optimistic commit", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("binds the bubble to the operation identity at submit and refines it from authority pushes", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    const submit = await startAcceptedTurn(h, ws, "hello");

    const bound = h.store.getSnapshot().optimisticEntries;
    expect(bound.length).toBe(1);
    expect(bound[0]!.identity).toMatchObject({ operationId: submit.payload.operationId, turnId: "turn-1", userEntryId: null, finalLeafId: null });

    // Authority reports the committed user entry identity (user_committed).
    ws.serverSend(turnStatus("s1", submit.payload.operationId, 1, "user_committed", { userEntryId: "entry-42" }));
    await flush();
    const refined = h.store.getSnapshot().optimisticEntries;
    expect(refined[0]!.identity).toMatchObject({ operationId: submit.payload.operationId, userEntryId: "entry-42" });

    // Terminal adds the final leaf identity (first answer wins per field).
    ws.serverSend(turnStatus("s1", submit.payload.operationId, 2, "completed", { userEntryId: "entry-42", finalLeafId: "entry-77" }));
    await flush();
    const terminal = h.store.getSnapshot().optimisticEntries;
    expect(terminal[0]!.identity).toMatchObject({ userEntryId: "entry-42", finalLeafId: "entry-77" });
  });

  it("POSITIVE: a committed user message_end removes the bubble BY IDENTITY even with DIFFERENT text", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    const submit = await startAcceptedTurn(h, ws, "optimistic text");
    ws.serverSend(turnStatus("s1", submit.payload.operationId, 1, "user_committed", { userEntryId: "entry-42" }));
    await flush();
    expect(h.store.getSnapshot().optimisticEntries.length).toBe(1);

    // The committed entry text differs (e.g. server-side normalization) — the
    // identity, not the text, owns the removal.
    sendUserCommit(ws, "s1", "entry-42", 2, "committed text differs");
    await flush();
    const view = h.store.getSnapshot();
    expect(view.optimisticEntries.length).toBe(0);
    // The committed entry itself IS recorded in the committed live tail.
    expect(h.controller("s1")!.getSnapshot().liveEntries.map((entry) => entry.entryId)).toContain("entry-42");
  });

  it("NEGATIVE: wrong identity never removes — same TEXT, different entryId cannot consume an identity-bound bubble", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    const submit = await startAcceptedTurn(h, ws, "hello exact text");
    ws.serverSend(turnStatus("s1", submit.payload.operationId, 1, "user_committed", { userEntryId: "entry-42" }));
    await flush();

    // A HISTORICAL entry with EXACTLY the same text commits first — the
    // identity-bound bubble must survive (text matching is forbidden).
    sendUserCommit(ws, "s1", "entry-999", 2, "hello exact text");
    await flush();
    const survived = h.store.getSnapshot().optimisticEntries;
    expect(survived.length).toBe(1);
    expect(survived[0]!.identity?.userEntryId).toBe("entry-42");

    // The bound identity's OWN commit then removes it.
    sendUserCommit(ws, "s1", "entry-42", 4, "hello exact text");
    await flush();
    expect(h.store.getSnapshot().optimisticEntries.length).toBe(0);
  });

  it("NEGATIVE: another operation's turn identity never binds; a KNOWN identity is never consumed by another entry", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    const submit = await startAcceptedTurn(h, ws, "mine");
    // A status for a DIFFERENT operation is dropped by exact correlation before
    // any identity refinement (the bubble's identity stays unknown).
    ws.serverSend(turnStatus("s1", "op:someone-else", 1, "user_committed", { userEntryId: "entry-8" }));
    await flush();
    expect(h.store.getSnapshot().optimisticEntries[0]!.identity?.userEntryId).toBeNull();

    // The authority then reports OUR operation's user entry identity.
    ws.serverSend(turnStatus("s1", submit.payload.operationId, 1, "user_committed", { userEntryId: "entry-9" }));
    await flush();
    expect(h.store.getSnapshot().optimisticEntries[0]!.identity?.userEntryId).toBe("entry-9");

    // A commit for ANOTHER entry id — even with the EXACT same text — can never
    // consume the now-known identity.
    sendUserCommit(ws, "s1", "entry-8", 2, "mine");
    await flush();
    expect(h.store.getSnapshot().optimisticEntries.length).toBe(1);

    // The bound identity's own commit removes it.
    sendUserCommit(ws, "s1", "entry-9", 4, "mine");
    await flush();
    expect(h.store.getSnapshot().optimisticEntries.length).toBe(0);
  });

  it("LEGACY fallback isolation: without the negotiated seam (no identity) the quarantined text path still removes the bubble", async () => {
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
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1", epoch: "e1" }) });
    await flush();
    await p;

    // Legacy command-envelope prompt: the bubble carries NO identity.
    const sendP = h.store.sendPrompt("legacy text");
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { type: string; commandId: string } } }>(ws, "command")!;
    expect(cmd.payload.command.type).toBe("prompt");
    ws.serverSend({ type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "prompt" } } } });
    await flush();
    await sendP;
    const bubble = h.store.getSnapshot().optimisticEntries;
    expect(bubble.length).toBe(1);
    expect(bubble[0]!.identity).toBeUndefined();

    // Same text commit removes it via the QUARANTINED legacy text fallback.
    sendUserCommit(ws, "s1", "entry-5", 1, "legacy text");
    await flush();
    expect(h.store.getSnapshot().optimisticEntries.length).toBe(0);
  });

  it("LEGACY fallback isolation: the identity-less single-candidate owner rule still applies (exact legacy semantics the Phase 7 removal deletes)", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend(ackLegacy());
    await flush();
    const p = h.store.openSession("s1");
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1", epoch: "e1" }) });
    await flush();
    await p;
    const sendP = h.store.sendPrompt("legacy one");
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string } } }>(ws, "command")!;
    ws.serverSend({ type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "prompt" } } } });
    await flush();
    await sendP;

    // Different text: the content match fails, but with exactly ONE legacy
    // candidate it is the only possible owner (documented heuristic) —
    // consumed. This pins the legacy semantics the Phase 7 removal deletes.
    sendUserCommit(ws, "s1", "entry-5", 1, "unrelated committed text");
    await flush();
    expect(h.store.getSnapshot().optimisticEntries.length).toBe(0);
  });

  it("identity survives a leaf-fence rebase (ghost prevention): the bubble persists until its own commit", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    const submit = await startAcceptedTurn(h, ws, "hello");
    ws.serverSend(turnStatus("s1", submit.payload.operationId, 1, "user_committed", { userEntryId: "entry-42" }));
    await flush();

    // Cross-tab navigate fence arrives mid-turn → deferred, then applied at
    // terminal. The identity-bound bubble must survive both stages untouched.
    ws.serverSend({ type: "event", payload: { type: "session_changed", sessionId: "s1", cwd: "/x", leafId: "entry-2", eventId: 2, epoch: "e1" } });
    await flush();
    expect(h.store.getSnapshot().optimisticEntries.length).toBe(1);
    ws.serverSend(turnStatus("s1", submit.payload.operationId, 2, "completed", { userEntryId: "entry-42", finalLeafId: "entry-43" }));
    await flush();
    const after = h.store.getSnapshot();
    expect(after.optimisticEntries.length).toBe(1);
    expect(after.optimisticEntries[0]!.identity).toMatchObject({ userEntryId: "entry-42", finalLeafId: "entry-43" });
  });

  it("finalLeafId identity also consumes the bubble when the user entry IS the final leaf", async () => {
    const h = createHarness();
    const ws = await openAndAttachTurn(h);
    const submit = await startAcceptedTurn(h, ws, "hello");
    // Terminal status carries ONLY the final leaf id (user entry id omitted).
    ws.serverSend(turnStatus("s1", submit.payload.operationId, 1, "completed", { finalLeafId: "entry-55" }));
    await flush();
    expect(h.store.getSnapshot().optimisticEntries.length).toBe(1);

    sendUserCommit(ws, "s1", "entry-55", 2, "hello");
    await flush();
    expect(h.store.getSnapshot().optimisticEntries.length).toBe(0);
  });
});
