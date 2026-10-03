import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_NESTED_TOOL_CALLS, MAX_NESTED_TOOL_ERROR_CHARS, NESTED_TOOL_CALL_STATUSES, type NestedToolCalls } from "@fffattiger/pix-runtime-core";
import { MAX_NESTED_TOOL_CALLS as WIRE_MAX, MAX_NESTED_TOOL_ERROR_CHARS as WIRE_ERROR_MAX, NESTED_TOOL_CALL_STATUSES as WIRE_STATUSES, NestedToolCallsSchema, ToolResultMessageSchema } from "@fffattiger/pix-protocol";

test("nested tool result limits and vocabulary match their canonical owner", () => {
  assert.equal(WIRE_MAX, MAX_NESTED_TOOL_CALLS);
  assert.equal(WIRE_ERROR_MAX, MAX_NESTED_TOOL_ERROR_CHARS);
  assert.deepEqual(WIRE_STATUSES, NESTED_TOOL_CALL_STATUSES);
  const nested: NestedToolCalls = { calls: [{ id: "outer/0", name: "read", arguments: { path: "a" }, status: "ok", durationMs: 0 }], complete: true };
  assert.deepEqual(NestedToolCallsSchema.parse(nested), nested);
  const result = { role: "toolResult", toolCallId: "outer", content: [], nestedCalls: nested, structuredContent: { count: 0 } };
  assert.deepEqual(ToolResultMessageSchema.parse(result), result);
});

test("nested summaries reject duplicate identities, false completion, and malformed bounds", () => {
  const call = { id: "outer/0", name: "read", status: "ok" };
  for (const value of [
    { calls: [call, call], complete: true },
    { calls: [{ ...call, status: "unfinished" }], complete: true },
    { calls: [{ ...call, status: "unknown" }], complete: false },
    { calls: [{ ...call, durationMs: -1 }], complete: true },
    { calls: [{ ...call, argumentsBytes: -1 }], complete: true },
    { calls: [{ ...call, error: "x".repeat(MAX_NESTED_TOOL_ERROR_CHARS + 1) }], complete: true },
    { calls: Array.from({ length: MAX_NESTED_TOOL_CALLS + 1 }, (_, i) => ({ ...call, id: String(i) })), complete: false },
  ]) assert.equal(NestedToolCallsSchema.safeParse(value).success, false);
});
