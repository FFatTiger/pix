import { test } from "node:test";
import assert from "node:assert/strict";
import { RuntimeTurnStatusPushSchema, WsTurnStatusMessageSchema, TurnAuthoritySnapshotSchema, RuntimeCommandOutcomeSchema as RuntimeCommandResultSchema } from "../dist/index.js";

test("Pi 1.0 queued input receipts distinguish handled from queued and reject invented values", () => {
  for (const type of ["steer", "follow_up"]) {
    for (const disposition of ["handled", "queued"]) {
      const result = { ok: true, type, disposition };
      assert.deepEqual(RuntimeCommandResultSchema.parse(result), result);
    }
    // Protocol v2 ACK bridge. Remove this case when Protocol v3 is the minimum.
    const legacy = { ok: true, type };
    assert.deepEqual(RuntimeCommandResultSchema.parse(legacy), legacy);
    assert.equal(RuntimeCommandResultSchema.safeParse({ ok: true, type, disposition: "started" }).success, false);
    assert.equal(RuntimeCommandResultSchema.safeParse({ ok: true, type, disposition: "invented" }).success, false);
  }
});


test("terminal turn authority uses the same strict contract on RPC and WS without mixing revisions", () => {
  const snapshot = { sessionId: "s", cwd: "/s", projectRoot: "/s", capabilities: { capabilities: [], version: 1 }, state: { sessionId: "s", model: null, messageCount: 0, isPromptRunning: false, isStreaming: false, isBashRunning: false, isCompacting: false } };
  const authority = { sessionId: "s", epoch: "e", lastEventId: 2, snapshot };
  const status = { sessionId: "s", epoch: "e", operationId: "op", turnId: "turn", revision: 7, state: "completed", disposition: "handled" };
  assert.deepEqual(TurnAuthoritySnapshotSchema.parse(authority), authority);
  const check = (push, expected) => {
    assert.equal(RuntimeTurnStatusPushSchema.safeParse({ type: "turn_status", ...push }).success, expected);
    assert.equal(WsTurnStatusMessageSchema.safeParse({ type: "turn_status", payload: push.status, ...(push.authority === undefined ? {} : { authority: push.authority }) }).success, expected);
  };
  check({ status, authority }, true);
  check({ status }, false);
  check({ status: { ...status, state: "failed" } }, true);
  check({ status: { ...status, state: "failed" }, authority }, true);
  for (const state of ["admitted", "running", "user_committed"]) {
    check({ status: { ...status, state }, authority }, false);
    check({ status: { ...status, state } }, true);
  }
  for (const invalid of [
    { ...authority, sessionId: "wrong" }, { ...authority, epoch: "wrong" },
    { ...authority, snapshot: { ...snapshot, sessionId: "wrong" } },
    { ...authority, lastEventId: -1 }, { ...authority, lastEventId: 1.5 },
    { ...authority, unexpected: true },
  ]) check({ status, authority: invalid }, false);
  check({ status: { ...status, authority }, authority }, false);
});
