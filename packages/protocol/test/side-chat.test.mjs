import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_SIDE_CHAT_ID_CHARS,
  MAX_SIDE_CHAT_MESSAGE_CHARS,
  MAX_SIDE_CHAT_STREAM_CHARS,
  PROTOCOL_VERSION,
  RuntimeCommandOutcomeSchema,
  RuntimeCommandSchema,
  RuntimeInterruptSchema,
  RuntimeSnapshotSchema,
  SessiondRpcRequestSchema,
  SideChatStateSchema,
  WorkerCommandMessageSchema,
  WorkerInterruptMessageSchema,
  WsCommandMessageSchema,
  WsInterruptMessageSchema,
  reduceRuntimeEventData,
} from "../dist/index.js";

function sideChat(patch = {}) {
  return {
    conversationId: "conversation-1",
    revision: 1,
    runId: "run-1",
    capturedModel: { provider: "test", id: "model" },
    capturedThinkingLevel: "medium",
    mode: "read_only",
    status: "running",
    messages: [],
    messagesTruncated: false,
    totalCharsTruncated: false,
    stream: { text: "", thinking: "", textTruncated: false, thinkingTruncated: false },
    tools: [],
    ...patch,
  };
}

function snapshot(state) {
  return {
    sessionId: "parent",
    cwd: "/workspace",
    projectRoot: "/workspace",
    state: {
      sessionId: "parent",
      isStreaming: false,
      isPromptRunning: false,
      isBashRunning: false,
      isCompacting: false,
      model: null,
      messageCount: 0,
      sideChat: state,
    },
    capabilities: { capabilities: ["runtime.side_chat"], version: 1 },
    streaming: { active: false, phase: "idle" },
  };
}

describe("side chat wire contract", () => {
  it("accepts exact commands, interrupts and typed acknowledgements", () => {
    assert.equal(RuntimeCommandSchema.safeParse({ commandId: "c1", type: "side_chat_start" }).success, true);
    assert.equal(RuntimeCommandSchema.safeParse({ commandId: "c2", type: "side_chat_send", conversationId: "x", message: "hello" }).success, true);
    assert.equal(RuntimeCommandSchema.safeParse({ commandId: "c3", type: "side_chat_reset", conversationId: "x", mode: "refork" }).success, true);
    assert.equal(RuntimeCommandSchema.safeParse({ commandId: "c4", type: "side_chat_set_mode", conversationId: "x", mode: "edit" }).success, true);
    assert.equal(RuntimeCommandSchema.safeParse({ commandId: "c5", type: "side_chat_overlap_response", conversationId: "x", requestId: "o1", proceed: false }).success, true);
    assert.equal(RuntimeInterruptSchema.safeParse({ type: "abort_side_chat", conversationId: "x" }).success, true);
    assert.equal(RuntimeCommandOutcomeSchema.safeParse({ ok: true, type: "side_chat_start", conversationId: "x" }).success, true);
    assert.equal(RuntimeCommandOutcomeSchema.safeParse({ ok: true, type: "side_chat_send", runId: "r1" }).success, true);
    assert.equal(RuntimeCommandOutcomeSchema.safeParse({ ok: true, type: "side_chat_reset", conversationId: "y" }).success, true);
  });

  it("bounds every side identity through command, interrupt, RPC, WS, Worker, and result schemas", () => {
    const validId = "x".repeat(MAX_SIDE_CHAT_ID_CHARS);
    const oversizedId = `${validId}x`;
    const command = { commandId: "c", type: "side_chat_overlap_response", conversationId: validId, requestId: validId, proceed: true };
    const interrupt = { type: "abort_side_chat", conversationId: validId };

    assert.equal(RuntimeCommandSchema.safeParse(command).success, true);
    assert.equal(RuntimeInterruptSchema.safeParse(interrupt).success, true);
    assert.equal(RuntimeCommandSchema.safeParse({ ...command, conversationId: oversizedId }).success, false);
    assert.equal(RuntimeCommandSchema.safeParse({ ...command, requestId: oversizedId }).success, false);
    assert.equal(RuntimeInterruptSchema.safeParse({ ...interrupt, conversationId: oversizedId }).success, false);

    const commandEnvelopes = [
      [WsCommandMessageSchema, { type: "command", payload: { sessionId: "s", command } }],
      [SessiondRpcRequestSchema, { protocolVersion: PROTOCOL_VERSION, id: "rpc", method: "runtime.command", params: { sessionId: "s", command } }],
      [WorkerCommandMessageSchema, { type: "worker.command", id: "worker", protocolVersion: PROTOCOL_VERSION, payload: { sessionId: "s", epoch: "e", command } }],
    ];
    for (const [schema, envelope] of commandEnvelopes) {
      assert.equal(schema.safeParse(envelope).success, true);
      const invalid = structuredClone(envelope);
      invalid.payload ? invalid.payload.command.conversationId = oversizedId : invalid.params.command.conversationId = oversizedId;
      assert.equal(schema.safeParse(invalid).success, false);
    }

    const interruptEnvelopes = [
      [WsInterruptMessageSchema, { type: "interrupt", id: "ws", payload: { sessionId: "s", commandId: "c", interrupt } }],
      [SessiondRpcRequestSchema, { protocolVersion: PROTOCOL_VERSION, id: "rpc", method: "runtime.interrupt", params: { sessionId: "s", commandId: "c", interrupt } }],
      [WorkerInterruptMessageSchema, { type: "worker.interrupt", id: "worker", protocolVersion: PROTOCOL_VERSION, payload: { sessionId: "s", epoch: "e", commandId: "c", interrupt } }],
    ];
    for (const [schema, envelope] of interruptEnvelopes) {
      assert.equal(schema.safeParse(envelope).success, true);
      const invalid = structuredClone(envelope);
      const nested = invalid.payload ?? invalid.params;
      nested.interrupt.conversationId = oversizedId;
      assert.equal(schema.safeParse(invalid).success, false);
    }

    for (const result of [
      { ok: true, type: "side_chat_start", conversationId: validId },
      { ok: true, type: "side_chat_send", runId: validId },
      { ok: true, type: "side_chat_reset", conversationId: validId },
    ]) {
      assert.equal(RuntimeCommandOutcomeSchema.safeParse(result).success, true);
      const key = "runId" in result ? "runId" : "conversationId";
      assert.equal(RuntimeCommandOutcomeSchema.safeParse({ ...result, [key]: oversizedId }).success, false);
    }

    assert.equal(RuntimeCommandSchema.safeParse({ ...command, conversationId: " " }).success, false);
    assert.equal(RuntimeCommandSchema.safeParse({ ...command, unknown: true }).success, false);
    assert.equal(RuntimeInterruptSchema.safeParse({ ...interrupt, unknown: true }).success, false);
  });

  it("rejects live side state without its capability while preserving legacy omission and null", () => {
    const liveWithoutCapability = { ...snapshot(sideChat()), capabilities: { capabilities: [], version: 1 } };
    assert.equal(RuntimeSnapshotSchema.safeParse(liveWithoutCapability).success, false);
    assert.equal(RuntimeSnapshotSchema.safeParse(snapshot(null)).success, true);
    const legacy = snapshot(null);
    delete legacy.state.sideChat;
    legacy.capabilities = { capabilities: [], version: 1 };
    assert.equal(RuntimeSnapshotSchema.safeParse(legacy).success, true);
  });

  it("reduces replacement and append-only deltas with exact fences", () => {
    const initial = snapshot(null);
    const replaced = reduceRuntimeEventData(initial, { type: "side_chat_changed", sessionId: "parent", sideChat: sideChat() });
    const next = reduceRuntimeEventData(replaced, {
      type: "side_chat_delta",
      sessionId: "parent",
      delta: { conversationId: "conversation-1", runId: "run-1", previousRevision: 1, revision: 2, kind: "text", delta: "hello" },
    });
    assert.equal(next.state.sideChat?.stream.text, "hello");
    assert.throws(() => reduceRuntimeEventData(next, {
      type: "side_chat_delta",
      sessionId: "parent",
      delta: { conversationId: "old", runId: "run-1", previousRevision: 2, revision: 3, kind: "text", delta: "late" },
    }), /stale side chat identity/);
  });

  it("keeps current stream visible when aggregate history is at the display budget", () => {
    const messages = Array.from({ length: 16 }, (_, index) => ({
      id: `history-${index}`,
      role: "assistant",
      text: "h".repeat(MAX_SIDE_CHAT_MESSAGE_CHARS),
      textTruncated: false,
      thinkingTruncated: false,
    }));
    const initial = snapshot(sideChat({ messages }));
    const next = reduceRuntimeEventData(initial, {
      type: "side_chat_delta",
      sessionId: "parent",
      delta: { conversationId: "conversation-1", runId: "run-1", previousRevision: 1, revision: 2, kind: "text", delta: "live" },
    });
    assert.equal(next.state.sideChat?.stream.text, "live");
    assert.equal(next.state.sideChat?.messages[0]?.text.length, MAX_SIDE_CHAT_MESSAGE_CHARS - 4);
    assert.equal(next.state.sideChat?.messages[0]?.textTruncated, true);
    assert.equal(next.state.sideChat?.totalCharsTruncated, true);
    assert.equal(SideChatStateSchema.safeParse(next.state.sideChat).success, true);
  });

  it("rejects incoherent or oversized state", () => {
    assert.equal(SideChatStateSchema.safeParse(sideChat({ status: "awaiting_overlap" })).success, false);
    assert.equal(SideChatStateSchema.safeParse(sideChat({ stream: { text: "x".repeat(MAX_SIDE_CHAT_STREAM_CHARS + 1), thinking: "", textTruncated: false, thinkingTruncated: false } })).success, false);
  });
});
