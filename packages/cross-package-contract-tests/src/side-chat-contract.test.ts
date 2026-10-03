import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_SIDE_CHAT_ID_CHARS as CORE_ID,
  MAX_SIDE_CHAT_MESSAGE_CHARS as CORE_MESSAGE,
  MAX_SIDE_CHAT_MESSAGES as CORE_MESSAGES,
  MAX_SIDE_CHAT_PATH_CHARS as CORE_PATH,
  MAX_SIDE_CHAT_STREAM_CHARS as CORE_STREAM,
  MAX_SIDE_CHAT_TOOL_NAME_CHARS as CORE_TOOL_NAME,
  MAX_SIDE_CHAT_TOOLS as CORE_TOOLS,
  MAX_SIDE_CHAT_TOTAL_DISPLAY_CHARS as CORE_TOTAL,
  RUNTIME_COMMAND_CAPABILITIES,
  RUNTIME_INTERRUPT_CAPABILITIES,
  type SideChatState as CoreSideChatState,
} from "@fffattiger/pix-runtime-core";
import {
  MAX_SIDE_CHAT_ID_CHARS as WIRE_ID,
  MAX_SIDE_CHAT_MESSAGE_CHARS as WIRE_MESSAGE,
  MAX_SIDE_CHAT_MESSAGES as WIRE_MESSAGES,
  MAX_SIDE_CHAT_PATH_CHARS as WIRE_PATH,
  MAX_SIDE_CHAT_STREAM_CHARS as WIRE_STREAM,
  MAX_SIDE_CHAT_TOOL_NAME_CHARS as WIRE_TOOL_NAME,
  MAX_SIDE_CHAT_TOOLS as WIRE_TOOLS,
  MAX_SIDE_CHAT_TOTAL_DISPLAY_CHARS as WIRE_TOTAL,
  RUNTIME_COMMAND_CAPABILITY_MATRIX,
  RUNTIME_INTERRUPT_CAPABILITY_MATRIX,
  SideChatStateSchema,
  type SideChatState as WireSideChatState,
} from "@fffattiger/pix-protocol";

test("side chat limits and capability mappings match canonical Runtime Core", () => {
  assert.deepEqual(
    [WIRE_MESSAGES, WIRE_MESSAGE, WIRE_STREAM, WIRE_TOTAL, WIRE_TOOLS, WIRE_ID, WIRE_TOOL_NAME, WIRE_PATH],
    [CORE_MESSAGES, CORE_MESSAGE, CORE_STREAM, CORE_TOTAL, CORE_TOOLS, CORE_ID, CORE_TOOL_NAME, CORE_PATH],
  );
  assert.deepEqual(RUNTIME_COMMAND_CAPABILITY_MATRIX, RUNTIME_COMMAND_CAPABILITIES);
  assert.deepEqual(RUNTIME_INTERRUPT_CAPABILITY_MATRIX, RUNTIME_INTERRUPT_CAPABILITIES);
});

test("protocol accepts the exact canonical renderer state shape", () => {
  const core: CoreSideChatState = {
    conversationId: "conversation-1",
    revision: 2,
    runId: "run-1",
    capturedModel: { provider: "test", id: "model" },
    capturedThinkingLevel: "medium",
    mode: "edit",
    status: "awaiting_overlap",
    messages: [{ id: "m1", role: "assistant", text: "answer", thinking: "reason", textTruncated: false, thinkingTruncated: false }],
    messagesTruncated: false,
    totalCharsTruncated: false,
    stream: { text: "partial", thinking: "", textTruncated: false, thinkingTruncated: false },
    tools: [{ toolCallId: "tc1", name: "write", status: "running", nameTruncated: false }],
    pendingOverlap: { id: "o1", runId: "run-1", path: "src/a.ts", pathTruncated: false },
  };
  const wire: WireSideChatState = SideChatStateSchema.parse(core);
  assert.deepEqual(wire, core);
});
