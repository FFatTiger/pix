import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentMessage, StreamingAgentMessage } from "./messages.js";
import {
  MAX_SIDE_CHAT_ID_CHARS,
  MAX_SIDE_CHAT_MESSAGE_CHARS,
  MAX_SIDE_CHAT_MESSAGES,
  MAX_SIDE_CHAT_STREAM_CHARS,
  MAX_SIDE_CHAT_TOTAL_DISPLAY_CHARS,
  applySideChatDelta,
  boundSideChatState,
  type SideChatState,
} from "./side-chat.js";

function assistantMessage(text: string, model = "model"): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model,
    provider: "test",
  };
}

function partial(text: string): StreamingAgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: "model",
    provider: "test",
  };
}

function messageText(message: AgentMessage): string {
  if (message.role === "assistant" || message.role === "toolResult") {
    return message.content
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
  }
  if (message.role === "user" && typeof message.content === "string") return message.content;
  return "";
}

function state(patch: Partial<SideChatState> = {}): SideChatState {
  return {
    conversationId: "conversation-1",
    revision: 1,
    runId: "run-1",
    model: { provider: "test", id: "model" },
    thinkingLevel: "medium",
    status: "running",
    messages: [],
    messagesTruncated: false,
    totalCharsTruncated: false,
    partialMessage: null,
    ...patch,
  };
}

describe("canonical side chat projection", () => {
  it("bounds display messages and the partial without mutating input", () => {
    const messages = Array.from({ length: MAX_SIDE_CHAT_MESSAGES + 2 }, (_, index) => ({
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "x".repeat(MAX_SIDE_CHAT_MESSAGE_CHARS + 10) }],
      model: "model",
      provider: "test",
    }));
    const oversizedPartial: StreamingAgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: "y".repeat(MAX_SIDE_CHAT_STREAM_CHARS + 1) }],
      model: "model",
      provider: "test",
    };
    const bounded = boundSideChatState(state({ messages, partialMessage: oversizedPartial }));
    assert.equal(bounded.messages.length, 15, "the clamped partial + 15 full messages fill the budget exactly");
    assert.equal(messageText(bounded.messages[0]!).length, MAX_SIDE_CHAT_MESSAGE_CHARS);
    assert.equal(messageText(bounded.messages[1]!).length, MAX_SIDE_CHAT_MESSAGE_CHARS);
    assert.ok(bounded.partialMessage !== null && bounded.partialMessage.role === "assistant");
    const boundedPartialText = bounded.partialMessage.content
      ?.filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("") ?? "";
    assert.equal(boundedPartialText.length, MAX_SIDE_CHAT_STREAM_CHARS);
    assert.equal(bounded.messagesTruncated, true);
    assert.equal(bounded.totalCharsTruncated, true);
    // Input is never mutated.
    assert.equal(messageText(messages[0]!).length, MAX_SIDE_CHAT_MESSAGE_CHARS + 10);
    const rawPartialText = oversizedPartial.content
      ?.filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("") ?? "";
    assert.equal(rawPartialText.length, MAX_SIDE_CHAT_STREAM_CHARS + 1);
  });

  it("keeps tool content intact while budgeting only prose", () => {
    const message: AgentMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reason" },
        { type: "toolCall", toolCallId: "tc1", toolName: "read", input: { path: "a.ts" } },
        { type: "text", text: "answer" },
      ],
      model: "model",
      provider: "test",
    };
    const bounded = boundSideChatState(state({ messages: [message] }));
    assert.equal(bounded.messages.length, 1);
    const kept = bounded.messages[0]!;
    assert.ok(kept.role === "assistant");
    assert.equal(kept.content.length, 3, "tool calls and results survive the display budget untouched");
  });

  it("preserves valid identity bounds and rejects instead of truncating oversized identities", () => {
    const validId = "x".repeat(MAX_SIDE_CHAT_ID_CHARS);
    const bounded = boundSideChatState(state({ conversationId: validId, runId: validId }));
    assert.equal(bounded.conversationId, validId);
    assert.equal(bounded.runId, validId);
    assert.throws(() => boundSideChatState(state({ conversationId: `${validId}x` })), /conversation id is invalid/);
    assert.throws(() => boundSideChatState(state({ runId: " " })), /run id is invalid/);
  });

  it("prioritizes a growing partial over older display history", () => {
    const fullMessages = Array.from({ length: 16 }, (_, index) => assistantMessage("h".repeat(MAX_SIDE_CHAT_MESSAGE_CHARS)));
    const initial = boundSideChatState(state({ messages: fullMessages }));
    const next = applySideChatDelta(initial, {
      conversationId: "conversation-1",
      runId: "run-1",
      previousRevision: initial.revision,
      revision: initial.revision + 1,
      partial: partial("live"),
    });
    assert.ok(next.partialMessage !== null && next.partialMessage.role === "assistant");
    const liveText = next.partialMessage.content
      ?.filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("") ?? "";
    assert.equal(liveText, "live");
    assert.equal(next.messages.length, fullMessages.length, "history is kept and only the oldest message is trimmed");
    assert.equal(messageText(next.messages[0]!).length, MAX_SIDE_CHAT_MESSAGE_CHARS - liveText.length, "the live partial's cost is taken from the oldest message");
    assert.equal(next.totalCharsTruncated, true);
    assert.ok(next.messages.reduce((sum, message) => sum + messageText(message).length, 0) + liveText.length <= MAX_SIDE_CHAT_TOTAL_DISPLAY_CHARS);
  });

  it("applies exact partial replacements and rejects stale identity/revision", () => {
    const next = applySideChatDelta(state({ partialMessage: partial("a") }), {
      conversationId: "conversation-1",
      runId: "run-1",
      previousRevision: 1,
      revision: 2,
      partial: partial("b"),
    });
    assert.ok(next.partialMessage !== null && next.partialMessage.role === "assistant");
    assert.equal(messageText(next.partialMessage as unknown as AgentMessage), "b");
    assert.equal(next.revision, 2);
    assert.throws(() => applySideChatDelta(next, {
      conversationId: "other",
      runId: "run-1",
      previousRevision: 2,
      revision: 3,
      partial: partial("late"),
    }), /stale side chat identity/);
    assert.throws(() => applySideChatDelta(next, {
      conversationId: "conversation-1",
      runId: "run-1",
      previousRevision: 1,
      revision: 3,
      partial: partial("late"),
    }), /stale side chat revision/);
  });
});
