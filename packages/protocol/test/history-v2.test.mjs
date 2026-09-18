import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PROTOCOL_VERSION,
  RuntimeSnapshotSchema,
  SessionsContextParamsSchema,
  SessionsContextResultSchema,
  SessionsThinkingParamsSchema,
  SessionsThinkingResultSchema,
  reduceRuntimeEventData,
} from "../dist/index.js";

const idleState = {
  sessionId: "s-1",
  isStreaming: false,
  isPromptRunning: false,
  isBashRunning: false,
  isCompacting: false,
  model: null,
  messageCount: 0,
  leafId: "entry-0",
};

function baseSnapshot(overrides = {}) {
  return {
    sessionId: "s-1",
    cwd: "/project",
    projectRoot: "/project",
    state: { ...idleState, ...overrides },
    capabilities: { capabilities: [], version: 0 },
  };
}

describe("Protocol v2 snapshot/history invariants", () => {
  it("freezes protocol version at 2", () => {
    assert.equal(PROTOCOL_VERSION, 2);
  });

  it("rejects snapshots that carry completed transcript history", () => {
    const withMessages = { ...baseSnapshot(), messages: [
      { role: "user", content: "hello" },
    ] };
    const parsed = RuntimeSnapshotSchema.safeParse(withMessages);
    assert.equal(parsed.success, false);
    // A clean control/reconnect snapshot (no messages) still parses.
    assert.equal(RuntimeSnapshotSchema.safeParse(baseSnapshot()).success, true);
  });

  it("advances leafId and messageCount on message_end without appending transcript", () => {
    let snapshot = baseSnapshot();
    snapshot = reduceRuntimeEventData(snapshot, {
      type: "message_start",
      sessionId: "s-1",
      streamId: "stream-1",
      messageId: "msg-1",
      message: { role: "assistant", content: [{ type: "text", text: "x" }] },
    });
    snapshot = reduceRuntimeEventData(snapshot, {
      type: "message_update",
      sessionId: "s-1",
      streamId: "stream-1",
      messageId: "msg-1",
      delta: { role: "assistant", delta: { type: "text", text: "y" } },
    });
    snapshot = reduceRuntimeEventData(snapshot, {
      type: "message_end",
      sessionId: "s-1",
      streamId: "stream-1",
      messageId: "msg-1",
      message: { role: "assistant", content: [{ type: "text", text: "xy" }], model: "m", provider: "p" },
      entryId: "entry-1",
    });
    assert.equal(snapshot.state.leafId, "entry-1");
    assert.equal(snapshot.state.messageCount, 1);
    assert.equal(snapshot.state.isStreaming, false);
    // No transcript history ever lives on the snapshot.
    assert.equal("messages" in snapshot, false);
  });

  it("rejects message_end without a committed entryId", () => {
    let snapshot = baseSnapshot();
    snapshot = reduceRuntimeEventData(snapshot, {
      type: "message_start",
      sessionId: "s-1",
      streamId: "stream-1",
      messageId: "msg-1",
      message: { role: "assistant", content: [{ type: "text", text: "x" }] },
    });
    assert.throws(() => reduceRuntimeEventData(snapshot, {
      type: "message_end",
      sessionId: "s-1",
      streamId: "stream-1",
      messageId: "msg-1",
      message: { role: "assistant", content: [], model: "m", provider: "p" },
    }), /entryId/);
  });

  it("advances leafId and messageCount on terminal bash_update only", () => {
    // Delta-only bash_update: no leaf/count change (entry not yet persisted).
    let snapshot = baseSnapshot();
    snapshot = reduceRuntimeEventData(snapshot, {
      type: "bash_update",
      sessionId: "s-1",
      command: "pwd",
      output: "/project",
    });
    assert.equal(snapshot.state.leafId, "entry-0");
    assert.equal(snapshot.state.messageCount, 0);
    assert.equal(snapshot.state.isBashRunning, true);

    // Terminal bash_update with committed entry identity advances leaf/count.
    snapshot = reduceRuntimeEventData(snapshot, {
      type: "bash_update",
      sessionId: "s-1",
      command: "pwd",
      exitCode: 0,
      entryId: "entry-bash-1",
    });
    assert.equal(snapshot.state.leafId, "entry-bash-1");
    assert.equal(snapshot.state.messageCount, 1);
    assert.equal(snapshot.state.isBashRunning, false);
  });

  it("paginates context params with exclusive cursor and bounded limit", () => {
    assert.equal(SessionsContextParamsSchema.safeParse({ sessionId: "s-1" }).success, true);
    assert.equal(SessionsContextParamsSchema.safeParse({ sessionId: "s-1", limit: 50 }).success, true);
    assert.equal(SessionsContextParamsSchema.safeParse({ sessionId: "s-1", before: "entry-5", limit: 1 }).success, true);
    assert.equal(SessionsContextParamsSchema.safeParse({ sessionId: "s-1", before: "entry-5", limit: 200 }).success, true);
    // Bounds are 1..200; a blank cursor or an out-of-range limit is rejected.
    assert.equal(SessionsContextParamsSchema.safeParse({ sessionId: "s-1", limit: 0 }).success, false);
    assert.equal(SessionsContextParamsSchema.safeParse({ sessionId: "s-1", limit: 201 }).success, false);
    assert.equal(SessionsContextParamsSchema.safeParse({ sessionId: "s-1", limit: 1.5 }).success, false);
    assert.equal(SessionsContextParamsSchema.safeParse({ sessionId: "s-1", before: "  " }).success, false);
  });

  it("accepts complete-history deferral flags and exact deferred-thinking identities", () => {
    assert.equal(SessionsContextParamsSchema.safeParse({
      sessionId: "s-1",
      deferThinking: true,
      deferMedia: true,
    }).success, true);
    assert.equal(SessionsContextParamsSchema.safeParse({ sessionId: "s-1", deferThinking: "1" }).success, false);
    assert.equal(SessionsContextParamsSchema.safeParse({ sessionId: "s-1", deferMedia: 1 }).success, false);
    assert.equal(SessionsThinkingParamsSchema.safeParse({ sessionId: "s-1", entryId: "e-1", blockIndex: 0 }).success, true);
    assert.equal(SessionsThinkingParamsSchema.safeParse({ sessionId: "s-1", entryId: "e-1", blockIndex: -1 }).success, false);
    assert.equal(SessionsThinkingResultSchema.safeParse({
      sessionId: "s-1",
      entryId: "e-1",
      blockIndex: 0,
      thinking: "persisted reasoning",
    }).success, true);
  });

  it("requires pageInfo on the context result", () => {
    assert.equal(SessionsContextResultSchema.safeParse({
      sessionId: "s-1",
      leafId: "entry-10",
      entries: [],
      settings: { model: { provider: "openai", modelId: "gpt-5" }, thinkingLevel: "high" },
      pageInfo: { hasMore: true, nextCursor: "entry-5" },
    }).success, true);
    assert.equal(SessionsContextResultSchema.safeParse({ sessionId: "s-1", entries: [] }).success, false);
    assert.equal(SessionsContextResultSchema.safeParse({
      sessionId: "s-1",
      entries: [],
      pageInfo: { hasMore: false },
    }).success, true);
    assert.equal(SessionsContextResultSchema.safeParse({
      sessionId: "s-1",
      entries: [],
      settings: { model: null, thinkingLevel: "off" },
      pageInfo: { hasMore: false },
    }).success, true);
  });
});
