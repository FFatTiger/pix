import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_SIDE_CHAT_ID_CHARS,
  MAX_SIDE_CHAT_MESSAGE_CHARS,
  MAX_SIDE_CHAT_MESSAGES,
  MAX_SIDE_CHAT_STREAM_CHARS,
  applySideChatDelta,
  boundSideChatState,
  type SideChatState,
} from "./side-chat.js";

function state(patch: Partial<SideChatState> = {}): SideChatState {
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

describe("canonical side chat projection", () => {
  it("bounds display messages and streams without mutating input", () => {
    const messages = Array.from({ length: MAX_SIDE_CHAT_MESSAGES + 2 }, (_, index) => ({
      id: `m-${index}`,
      role: "assistant" as const,
      text: "x".repeat(MAX_SIDE_CHAT_MESSAGE_CHARS + 10),
      textTruncated: false,
      thinkingTruncated: false,
    }));
    const bounded = boundSideChatState(state({
      messages,
      stream: { text: "y".repeat(MAX_SIDE_CHAT_STREAM_CHARS + 1), thinking: "", textTruncated: false, thinkingTruncated: false },
    }));
    assert.equal(bounded.messages.length, 15);
    assert.equal(bounded.messages[0]?.id, "m-51");
    assert.equal(bounded.messages.at(-1)?.id, `m-${MAX_SIDE_CHAT_MESSAGES + 1}`);
    assert.equal(bounded.stream.text.length, MAX_SIDE_CHAT_STREAM_CHARS);
    assert.equal(bounded.messagesTruncated, true);
    assert.equal(bounded.totalCharsTruncated, true);
    assert.equal(messages[0]?.text.length, MAX_SIDE_CHAT_MESSAGE_CHARS + 10);
  });

  it("preserves valid identity bounds and rejects instead of truncating oversized identities", () => {
    const validId = "x".repeat(MAX_SIDE_CHAT_ID_CHARS);
    const bounded = boundSideChatState(state({ conversationId: validId, runId: validId }));
    assert.equal(bounded.conversationId, validId);
    assert.equal(bounded.runId, validId);
    assert.throws(() => boundSideChatState(state({ conversationId: `${validId}x` })), /conversation id is invalid/);
    assert.throws(() => boundSideChatState(state({ runId: " " })), /run id is invalid/);
    assert.throws(() => boundSideChatState(state({
      pendingOverlap: { id: `${validId}x`, runId: "run-1", path: "/a", pathTruncated: false },
    })), /overlap request id is invalid/);
  });

  it("prioritizes a growing current stream over older display history", () => {
    const fullMessages = Array.from({ length: 16 }, (_, index) => ({
      id: `history-${index}`,
      role: "assistant" as const,
      text: "h".repeat(MAX_SIDE_CHAT_MESSAGE_CHARS),
      textTruncated: false,
      thinkingTruncated: false,
    }));
    const initial = boundSideChatState(state({ messages: fullMessages, stream: { text: "", thinking: "", textTruncated: false, thinkingTruncated: false } }));
    const next = applySideChatDelta(initial, {
      conversationId: "conversation-1",
      runId: "run-1",
      previousRevision: 1,
      revision: 2,
      kind: "text",
      delta: "live",
    });
    assert.equal(next.stream.text, "live");
    assert.equal(next.messages.at(-1)?.text.length, MAX_SIDE_CHAT_MESSAGE_CHARS);
    assert.equal(next.messages[0]?.text.length, MAX_SIDE_CHAT_MESSAGE_CHARS - 4);
    assert.equal(next.messages[0]?.textTruncated, true);
    assert.equal(next.totalCharsTruncated, true);
  });

  it("applies exact append-only deltas and rejects stale identity/revision", () => {
    const next = applySideChatDelta(state({ stream: { text: "a", thinking: "", textTruncated: false, thinkingTruncated: false } }), {
      conversationId: "conversation-1",
      runId: "run-1",
      previousRevision: 1,
      revision: 2,
      kind: "text",
      delta: "b",
    });
    assert.equal(next.stream.text, "ab");
    assert.equal(next.revision, 2);
    assert.throws(() => applySideChatDelta(next, {
      conversationId: "other",
      runId: "run-1",
      previousRevision: 2,
      revision: 3,
      kind: "text",
      delta: "late",
    }), /stale side chat identity/);
    assert.throws(() => applySideChatDelta(next, {
      conversationId: "conversation-1",
      runId: "run-1",
      previousRevision: 1,
      revision: 3,
      kind: "thinking",
      delta: "late",
    }), /stale side chat revision/);
  });
});
