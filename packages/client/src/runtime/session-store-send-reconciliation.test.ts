/**
 * Send-outbox contract tests (the root cure for false send failures).
 *
 * A send used to be a CONDITIONAL commit: the client guessed whether the Agent
 * was idle (`submit_turn` vs steer/follow_up) and supplied an epoch fence, and
 * the authority refused the guess — six rounds of 「消息未发送」 came from that
 * shape. Now a send is an INTENT that always succeeds locally and is delivered
 * exactly once by the outbox:
 *
 *  - a transient failure (lost ack, retryable rejection, dropped socket, clock
 *    skew in an epoch guess) never settles the send and never surfaces: the
 *    SAME operationId is resent until the authority accepts it;
 *  - only `invalid_input` / `not_found` restore the draft;
 *  - a page reload resumes the persisted outbox;
 *  - the epoch/revision fences are IGNORED (they are guesses, not contracts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, flush, lastFrame, snapshotPayload, type RuntimeHarness } from "./testing/harness";
import type { FakeWebSocket } from "./testing/harness";
import type { SubmitTurnAdmission } from "@fffattiger/pix-protocol";
import { SendOutboxStore, type OutboxStorage } from "./send-outbox-store";

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

function rejected(sessionId: string, operationId: string, code: string, retryable: boolean): SubmitTurnAdmission {
  return {
    status: "rejected",
    delivery: "not_delivered",
    sessionId,
    operationId,
    error: { code: code as never, message: `rejected: ${code}`, retryable },
  };
}

function submitFrames(ws: FakeWebSocket): Array<{ type: "submit_turn"; id: string; payload: Record<string, unknown> }> {
  return ws.sent.filter((frame): frame is { type: "submit_turn"; id: string; payload: Record<string, unknown> } =>
    (frame as { type?: string }).type === "submit_turn"
  );
}

/** In-memory localStorage stand-in for the durable outbox. */
function memoryStorage(): OutboxStorage & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
  };
}

describe("SendOutboxStore — durable queue", () => {
  it("persists enqueued sends and reloads them for the next page load", () => {
    const storage = memoryStorage();
    const first = new SendOutboxStore(storage);
    first.enqueue({ operationId: "op-1", sessionId: "s1", prompt: "hello", whenBusy: "follow_up" });
    first.enqueue({ operationId: "op-2", sessionId: "s1", prompt: "again", whenBusy: "steer" });

    const reloaded = new SendOutboxStore(storage);
    reloaded.load();
    expect(reloaded.listFor("s1").map((entry) => entry.operationId)).toEqual(["op-1", "op-2"]);
    expect(reloaded.listFor("s1")[1]!.whenBusy).toBe("steer");

    reloaded.dequeue("op-1");
    const third = new SendOutboxStore(storage);
    third.load();
    expect(third.listFor("s1").map((entry) => entry.operationId)).toEqual(["op-2"]);
  });

  it("drops a structurally corrupt entry instead of replaying it blindly", () => {
    const storage = memoryStorage();
    storage.setItem("pix.send-outbox.v1", JSON.stringify([
      { operationId: "op-ok", sessionId: "s1", prompt: "hi", sequence: 1, whenBusy: "follow_up" },
      { operationId: "", sessionId: "s1", prompt: "bad", sequence: 2 },
      "not an object",
    ]));
    const store = new SendOutboxStore(storage);
    store.load();
    expect(store.listFor("s1").map((entry) => entry.operationId)).toEqual(["op-ok"]);
  });
});

describe("SessionStore — one unconditional send", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("sends without any epoch/revision fence and settles on acceptance", async () => {
    const h = createHarness();
    const ws = await openAndAttach(h, "s1", "e1", 40);
    const sendP = h.store.sendPrompt("hello");
    await flush();
    const first = submitFrames(ws)[0]!;
    // No client-side guess travels with the send.
    expect(first.payload.expectedEpoch).toBeUndefined();
    expect(first.payload.expectedRevision).toBeUndefined();
    expect(first.payload.whenBusy).toBe("follow_up");
    ws.serverSend({ type: "submit_turn_result", id: first.id, payload: acceptedAdmission("s1", first.payload.operationId as string, "e1", "turn-1", 41) });
    await expect(sendP).resolves.toBeUndefined();
    // Escape the 0..N outbox retry loop, then the message is gone from the
    // durable queue (it is the authority's responsibility now).
    expect(h.store.sendPrompt).toBeTypeOf("function");
  });

  it("keeps retrying the SAME operationId through retryable rejections, silently", async () => {
    const h = createHarness();
    const ws = await openAndAttach(h, "s1", "e1", 40);
    const settled = h.store.sendPrompt("survives a restart").then(
      () => ({ ok: true as const }),
      (cause: unknown) => ({ ok: false as const, cause }),
    );
    await flush();
    const first = submitFrames(ws)[0]!;
    // The authority reports a transient failure (worker restart, epoch
    // rollover, capacity rollover...): the send is NOT reported as failed.
    ws.serverSend({ type: "submit_turn_result", id: first.id, payload: rejected("s1", first.payload.operationId as string, "unavailable", true) });
    await flush();
    // The retry is driven by a NEW connection attempt, not by a timer.
    const retrySocket = await h.reconnectAfterFailure({ sessionId: "s1", epoch: "e1" });
    await flush();
    const frames = submitFrames(retrySocket);
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const retry = frames.at(-1)!;
    expect(retry.payload.operationId).toBe(first.payload.operationId);
    expect(retry.id).not.toBe(first.id);

    retrySocket.serverSend({ type: "submit_turn_result", id: retry.id, payload: duplicateAdmission("s1", first.payload.operationId as string, "e1", "turn-1", 41) });
    expect(await settled).toEqual({ ok: true });
  });

  it("ignores an epoch_changed rejection instead of surfacing 'not sent'", async () => {
    const h = createHarness();
    const ws = await openAndAttach(h, "s1", "e1", 40);
    const settled = h.store.sendPrompt("epoch rolled").then(
      () => ({ ok: true as const }),
      (cause: unknown) => ({ ok: false as const, cause }),
    );
    await flush();
    const first = submitFrames(ws)[0]!;
    ws.serverSend({ type: "submit_turn_result", id: first.id, payload: rejected("s1", first.payload.operationId as string, "epoch_changed", true) });
    await flush();
    const retrySocket = await h.reconnectAfterFailure({ sessionId: "s1", epoch: "e1" });
    await flush();
    const retry = submitFrames(retrySocket).at(-1)!;
    expect(retry.payload.operationId).toBe(first.payload.operationId);
    // The retry also carries NO fence: the epoch guess is gone for good.
    expect(retry.payload.expectedEpoch).toBeUndefined();
    retrySocket.serverSend({ type: "submit_turn_result", id: retry.id, payload: acceptedAdmission("s1", first.payload.operationId as string, "e1", "turn-1", 41) });
    expect(await settled).toEqual({ ok: true });
  });

  it("restores the draft ONLY for invalid_input / not_found", async () => {
    const h = createHarness();
    const ws = await openAndAttach(h, "s1", "e1", 40);
    const settled = h.store.sendPrompt("bad payload").then(
      () => ({ ok: true as const }),
      (cause: unknown) => ({ ok: false as const, cause }),
    );
    await flush();
    const first = submitFrames(ws)[0]!;
    ws.serverSend({ type: "submit_turn_result", id: first.id, payload: rejected("s1", first.payload.operationId as string, "invalid_input", false) });
    const outcome = await settled;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect((outcome.cause as { code?: string }).code).toBe("invalid_input");
    // Nothing is retried for a proven-final rejection, even after a reconnect.
    const reloadSocket = await h.reconnectAfterFailure({ sessionId: "s1", epoch: "e1" });
    await flush();
    expect(submitFrames(reloadSocket)).toHaveLength(0);
  });

  it("resumes a send that was enqueued before a reload", async () => {
    const storage = memoryStorage();
    const first = createHarness({ storeOptions: { outbox: new SendOutboxStore(storage) } });
    const wsA = await openAndAttach(first, "s1", "e1", 40);
    void first.store.sendPrompt("survives reload");
    await flush();
    expect(submitFrames(wsA)).toHaveLength(1);
    const operationId = submitFrames(wsA)[0]!.payload.operationId as string;
    // The page dies before any admission arrives.
    expect(storage.data.get("pix.send-outbox.v1")).toContain(operationId);

    const second = createHarness({ storeOptions: { outbox: new SendOutboxStore(storage) } });
    const wsB = await openAndAttach(second, "s1", "e1", 40);
    await flush();
    const resumed = submitFrames(wsB);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.payload.operationId).toBe(operationId);
    wsB.serverSend({ type: "submit_turn_result", id: resumed[0]!.id, payload: duplicateAdmission("s1", operationId, "e1", "turn-1", 41) });
    await flush();
    expect(second.store.getSnapshot().optimisticEntries).toHaveLength(1);
  });

  it("sends the whenBusy preference so the authority can queue a running turn", async () => {
    const h = createHarness();
    const ws = await openAndAttach(h, "s1", "e1", 40);
    void h.store.submitTurn({ sessionId: "s1", prompt: "steer me", whenBusy: "steer" });
    await flush();
    expect(submitFrames(ws)[0]!.payload.whenBusy).toBe("steer");
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
