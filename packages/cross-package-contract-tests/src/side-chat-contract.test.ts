import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applySideChatDelta as coreApplySideChatDelta,
  MAX_SIDE_CHAT_ID_CHARS as CORE_ID,
  MAX_SIDE_CHAT_MESSAGE_CHARS as CORE_MESSAGE,
  MAX_SIDE_CHAT_MESSAGES as CORE_MESSAGES,
  MAX_SIDE_CHAT_STREAM_CHARS as CORE_STREAM,
  MAX_SIDE_CHAT_TOTAL_DISPLAY_CHARS as CORE_TOTAL,
  RUNTIME_COMMAND_CAPABILITIES,
  RUNTIME_INTERRUPT_CAPABILITIES,
  type SideChatState as CoreSideChatState,
} from "@fffattiger/pix-runtime-core";
import {
  applySideChatDelta as wireApplySideChatDelta,
  MAX_SIDE_CHAT_ID_CHARS as WIRE_ID,
  MAX_SIDE_CHAT_MESSAGE_CHARS as WIRE_MESSAGE,
  MAX_SIDE_CHAT_MESSAGES as WIRE_MESSAGES,
  MAX_SIDE_CHAT_STREAM_CHARS as WIRE_STREAM,
  MAX_SIDE_CHAT_TOTAL_DISPLAY_CHARS as WIRE_TOTAL,
  RUNTIME_COMMAND_CAPABILITY_MATRIX,
  RUNTIME_INTERRUPT_CAPABILITY_MATRIX,
  SideChatStateSchema,
  type SideChatState as WireSideChatState,
} from "@fffattiger/pix-protocol";

test("side chat limits and capability mappings match canonical Runtime Core", () => {
  assert.deepEqual(
    [WIRE_MESSAGES, WIRE_MESSAGE, WIRE_STREAM, WIRE_TOTAL, WIRE_ID],
    [CORE_MESSAGES, CORE_MESSAGE, CORE_STREAM, CORE_TOTAL, CORE_ID],
  );
  assert.deepEqual(RUNTIME_COMMAND_CAPABILITY_MATRIX, RUNTIME_COMMAND_CAPABILITIES);
  assert.deepEqual(RUNTIME_INTERRUPT_CAPABILITY_MATRIX, RUNTIME_INTERRUPT_CAPABILITIES);
});

test("protocol accepts the exact canonical renderer state shape", () => {
  const core: CoreSideChatState = {
    conversationId: "conversation-1",
    revision: 2,
    runId: "run-1",
    model: { provider: "test", id: "model" },
    thinkingLevel: "medium",
    status: "running",
    messages: [
      { role: "user", content: "question" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reason" },
          { type: "toolCall", toolCallId: "tc1", toolName: "read", input: { path: "a.ts" } },
          { type: "text", text: "answer" },
        ],
        model: "model",
        provider: "test",
      },
      { role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "file body" }] },
    ],
    messagesTruncated: false,
    totalCharsTruncated: false,
    partialMessage: {
      role: "assistant",
      content: [{ type: "text", text: "partial" }],
      model: "model",
      provider: "test",
    },
  };
  const wire: WireSideChatState = SideChatStateSchema.parse(core);
  assert.deepEqual(wire, core);
});

test("delta accumulators apply identical budget clamps (protocol reducer ≡ runtime-core authority)", () => {
  const fullMessage = (text: string): CoreSideChatState["messages"][number] => ({
    role: "assistant",
    content: [{ type: "text", text }],
    model: "model",
    provider: "test",
  });
  const base = {
    conversationId: "conversation-1",
    revision: 1,
    runId: "run-1",
    model: { provider: "test", id: "model" },
    thinkingLevel: "medium" as const,
    status: "running" as const,
    messagesTruncated: false,
    totalCharsTruncated: false,
  };
  const messages = Array.from({ length: 16 }, () => fullMessage("h".repeat(CORE_MESSAGE)));
  const deltaPartial = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "live" }],
    model: "model",
    provider: "test",
  };
  const coreNext = coreApplySideChatDelta(
    { ...base, messages, partialMessage: null } as CoreSideChatState,
    { conversationId: "conversation-1", runId: "run-1", previousRevision: 1, revision: 2, partial: deltaPartial },
  );
  const wireNext = wireApplySideChatDelta(
    { ...base, messages, partialMessage: null } as WireSideChatState,
    { conversationId: "conversation-1", runId: "run-1", previousRevision: 1, revision: 2, partial: deltaPartial },
  );
  const shape = (state: { messages: CoreSideChatState["messages"]; messagesTruncated: boolean; totalCharsTruncated: boolean; partialMessage: unknown }) => ({
    count: state.messages.length,
    oldestText: state.messages[0] && state.messages[0]!.role === "assistant" ? (state.messages[0]!.content[0] as { text: string }).text : "",
    messagesTruncated: state.messagesTruncated,
    totalCharsTruncated: state.totalCharsTruncated,
    partialText: state.partialMessage !== null && (state.partialMessage as { content?: Array<{ type: string; text?: string }> }).content !== undefined
      ? ((state.partialMessage as { content: Array<{ type: string; text?: string }> }).content[0]?.text ?? "")
      : null,
  });
  assert.deepEqual(shape(coreNext as unknown as Parameters<typeof shape>[0]), shape(wireNext as unknown as Parameters<typeof shape>[0]));
  assert.deepEqual(shape(wireNext as unknown as Parameters<typeof shape>[0]), {
    count: 16,
    oldestText: "h".repeat(CORE_MESSAGE - 4),
    messagesTruncated: false,
    totalCharsTruncated: true,
    partialText: "live",
  }, "history is kept, only the oldest message is trimmed by the partial's cost");
  assert.equal(SideChatStateSchema.safeParse(wireNext).success, true, "the accumulated wire state stays schema-valid");
});
