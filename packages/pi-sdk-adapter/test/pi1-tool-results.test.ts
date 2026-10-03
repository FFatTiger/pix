import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_NESTED_TOOL_CALLS } from "@fffattiger/pix-runtime-core";
import { mapMessage } from "../src/mappers/message.js";

const call = { id: "parent/0", name: "read", status: "ok", arguments: { path: "README.md", api_key: "private-value" }, durationMs: 0 };
const usage = { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

test("Pi 1.0 nested result metadata survives live and history mapping with secrets redacted", () => {
  const raw = {
    role: "toolResult", toolCallId: "parent", toolName: "codemode", content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
    nestedCalls: { calls: [call, { ...call, id: "parent/1", status: "error", error: "request token=private-value" }], complete: true },
    structuredContent: { items: [1], api_key: "private-value" }, usage,
  };
  const full = mapMessage(raw);
  assert.equal(full.role, "toolResult");
  if (full.role !== "toolResult") throw new Error("wrong role");
  assert.equal(full.nestedCalls?.calls.length, 2);
  assert.equal(full.nestedCalls?.calls[0]?.durationMs, 0);
  assert.deepEqual(full.usage, usage);
  assert.equal(full.content?.[0]?.type, "image");
  assert.equal(JSON.stringify(full).includes("private-value"), false);
  assert.deepEqual(mapMessage(raw, true), full);
});

test("nested errors redact credentials consistently in full and partial messages", () => {
  for (const error of [
    "password=SYNTHETIC_CANARY",
    "Authorization: Bearer SYNTHETIC_CANARY",
    "Authorization: Basic SYNTHETIC_CANARY",
    'Authorization: "Bearer SYNTHETIC_CANARY"',
    '{"password":"SYNTHETIC_CANARY with spaces"}',
    "credential='SYNTHETIC_CANARY with spaces'",
    "access_token=SYNTHETIC_CANARY",
    'password="ordinary-prefix SYNTHETIC_CANARY',
    "credential='ordinary-prefix SYNTHETIC_CANARY",
    'password="ordinary-prefix SYNTHETIC_CANARY\\',
    `password="ordinary-prefix SYNTHETIC_CANARY ${"padding ".repeat(400)}"`,
  ]) {
    const raw = { role: "toolResult", toolCallId: "parent", content: [], nestedCalls: { calls: [{ id: "parent/0", name: "mcp", status: "error", error }], complete: true } };
    for (const partial of [false, true]) {
      const mapped = mapMessage(raw, partial);
      assert.equal(JSON.stringify(mapped).includes("SYNTHETIC_CANARY"), false, error);
      assert.equal(mapped.role, "toolResult");
      if (mapped.role === "toolResult") assert.match(mapped.nestedCalls!.calls[0]!.error!, /\[REDACTED\]/);
    }
  }
});

test("malformed nested summaries fail closed instead of creating plausible child entries", () => {
  for (const nestedCalls of [
    { calls: [call, call], complete: true },
    { calls: [{ ...call, status: "invented" }], complete: true },
    { calls: [{ ...call, status: "unfinished" }], complete: true },
    { calls: [{ ...call, durationMs: Infinity }], complete: true },
    { calls: Array.from({ length: MAX_NESTED_TOOL_CALLS + 1 }, (_, i) => ({ ...call, id: String(i) })), complete: false },
  ]) assert.throws(() => mapMessage({ role: "toolResult", toolCallId: "parent", content: [], nestedCalls }), { code: "external", message: "invalid nested tool call summary" });
});
