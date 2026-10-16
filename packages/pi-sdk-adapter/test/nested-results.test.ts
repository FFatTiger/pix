import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { RuntimeEvent, NestedToolCalls } from "@fffattiger/pix-runtime-core";
import { MAX_NESTED_RESULT_TEXT_CHARS } from "@fffattiger/pix-runtime-core";
import { CanonicalAgentRuntimeAdapter } from "../src/internal/adapter.js";
import { createPiSdkSessionStore } from "../src/internal/session-store.js";
import { budgetPayload, mergeNestedResults, NestedResultsArchive, captureNestedToolResult } from "../src/internal/nested-results.js";
import { ScriptedSdkDriverFactory, ScriptedSdkStore } from "./scripted-sdk.js";

const NOW = 1_700_000_000_000;

async function setup() {
  const driver = await new ScriptedSdkDriverFactory(new ScriptedSdkStore()).create({ cwd: "/workspace" }, {});
  const adapter = new CanonicalAgentRuntimeAdapter(driver);
  await adapter.ready();
  const events: RuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  return { driver, adapter, events };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A committed parent codemode tool result with two recorded nested calls. */
const nestedCalls: NestedToolCalls = {
  calls: [
    { id: "code/0", name: "read", arguments: { path: "a" }, status: "ok", durationMs: 1 },
    { id: "code/1", name: "grep", arguments: { pattern: "b" }, status: "error", error: "no match" },
  ],
  complete: true,
};
const parentRawTool = {
  role: "toolResult",
  toolCallId: "code",
  toolName: "codemode",
  content: [{ type: "text", text: "shared script output" }],
  isError: false,
  timestamp: NOW,
  nestedCalls,
};

describe("nested call result capture (live)", () => {
  it("collects child results from tool_execution_end, merges them into the parent message_end, and persists a pix-nested-results custom entry", async () => {
    const { driver, adapter, events } = await setup();
    try {
      driver.emit({ type: "tool_execution_end", toolCallId: "code/0", parentToolCallId: "code", toolName: "read", isError: false, result: { content: [{ type: "text", text: "own output 0" }, { type: "image", data: "AA==", mimeType: "image/png" }] } });
      driver.emit({ type: "tool_execution_end", toolCallId: "code/1", parentToolCallId: "code", toolName: "grep", isError: true, result: { content: [{ type: "text", text: "password=SYNTHETIC_CANARY" }] } });
      driver.appendCommitted({ role: "toolResult", toolCallId: "code", toolName: "codemode", content: [{ type: "text", text: "shared script output" }], isError: false, timestamp: NOW, nestedCalls: parentRawTool.nestedCalls });
      driver.emit({ type: "message_end", message: parentRawTool });
      await settle();

      const end = events.find((event) => event.type === "message_end");
      assert.ok(end && end.type === "message_end", "message_end was published");
      const message = end.message as { nestedCalls?: { calls: { id: string; result?: { text: string; imageCount: number; isError: boolean } }[] } };
      const calls = message.nestedCalls!.calls;
      assert.equal(calls[0]!.result?.text, "own output 0");
      assert.equal(calls[0]!.result?.imageCount, 1);
      assert.equal(calls[0]!.result?.isError, false);
      assert.equal(calls[1]!.result?.isError, true);
      assert.match(calls[1]!.result?.text ?? "", /\[REDACTED\]/);
      assert.equal(JSON.stringify(events).includes("SYNTHETIC_CANARY"), false, "child result text is redacted");

      // Persistence: the bounded batch is written through the custom-entry
      // lane (display-only to the SDK), keyed by the parent tool call id.
      assert.equal(driver.appendedNestedResults.length, 1);
      assert.equal(driver.appendedNestedResults[0]!.toolCallId, "code");
      assert.deepEqual(
        driver.appendedNestedResults[0]!.calls.map((call) => call.id),
        ["code/0", "code/1"],
      );
      assert.equal(driver.appendedNestedResults[0]!.version, 1);
    } finally {
      await adapter.close("user");
    }
  });

  it("truncates child text at the per-call cap and marks the cut", async () => {
    const { driver, adapter, events } = await setup();
    try {
      const long = "x".repeat(MAX_NESTED_RESULT_TEXT_CHARS + 100);
      driver.emit({ type: "tool_execution_end", toolCallId: "code/0", parentToolCallId: "code", toolName: "bash", isError: false, result: { content: [{ type: "text", text: long }] } });
      driver.appendCommitted({ role: "toolResult", toolCallId: "code", toolName: "codemode", content: [], isError: false, timestamp: NOW, nestedCalls: parentRawTool.nestedCalls });
      driver.emit({ type: "message_end", message: parentRawTool });
      await settle();
      const end = events.find((event) => event.type === "message_end");
      assert.ok(end && end.type === "message_end");
      const calls = (end.message as typeof parentRawTool & { nestedCalls?: { calls: { id: string; result?: { text: string; truncated: boolean } }[] } }).nestedCalls!.calls;
      assert.equal(calls[0]!.result?.text.length, MAX_NESTED_RESULT_TEXT_CHARS);
      assert.equal(calls[0]!.result?.truncated, true);
      assert.equal(calls[1]!.result, undefined, "unarchived child keeps status only");
    } finally {
      await adapter.close("user");
    }
  });

  it("falls back to event order only when archived ids match no recorded call and counts are equal", async () => {
    const archive = new NestedResultsArchive();
    archive.record("code", "evt-a", captureNestedToolResult({ content: [{ type: "text", text: "A" }] }, false));
    archive.record("code", "evt-b", captureNestedToolResult({ content: [{ type: "text", text: "B" }] }, false));
    const payload = archive.takePayload("code");
    assert.ok(payload);
    // Recorded ids differ (e.g. SDK-recorded `${parent}/${i}` vs event ids) —
    // same count applies records by event order.
    const merged = mergeNestedResults(
      { calls: [{ id: "code/0", name: "read", status: "ok" }, { id: "code/1", name: "grep", status: "ok" }], complete: true },
      payload,
    );
    assert.equal(merged.calls[0]!.result?.text, "A");
    assert.equal(merged.calls[1]!.result?.text, "B");
    // Count mismatch never guesses: nothing is applied.
    const partial = mergeNestedResults({ calls: [{ id: "code/0", name: "read", status: "ok" }], complete: true }, payload);
    assert.equal(partial.calls[0]!.result, undefined);
  });

  it("keeps every simultaneously running parent's child results (bounded FIFO is per turn)", async () => {
    const { driver, adapter, events } = await setup();
    try {
      const parents = Array.from({ length: 9 }, (_, index) => `p${index}`);
      for (const parent of parents) {
        driver.emit({ type: "tool_execution_end", toolCallId: `${parent}/0`, parentToolCallId: parent, toolName: "read", isError: false, result: { content: [{ type: "text", text: `own ${parent}` }] } });
      }
      for (const parent of parents) {
        driver.appendCommitted({ role: "toolResult", toolCallId: parent, toolName: "codemode", content: [], isError: false, timestamp: NOW, nestedCalls: { calls: [{ id: `${parent}/0`, name: "read", status: "ok" }], complete: true } });
        driver.emit({ type: "message_end", message: { role: "toolResult", toolCallId: parent, toolName: "codemode", content: [], isError: false, timestamp: NOW, nestedCalls: { calls: [{ id: `${parent}/0`, name: "read", status: "ok" }], complete: true } } });
      }
      await settle();
      const ends = events.filter((event) => event.type === "message_end");
      // Nine overlapping batches exceed the old 8-parent window; none may be
      // evicted while still uncommitted.
      assert.equal(ends.length, parents.length);
      for (const [index, parent] of parents.entries()) {
        const calls = (ends[index]!.message as { nestedCalls?: { calls: { result?: { text: string } }[] } }).nestedCalls!.calls;
        assert.equal(calls[0]!.result?.text, `own ${parent}`);
      }
      assert.equal(driver.appendedNestedResults.length, parents.length);
    } finally {
      await adapter.close("user");
    }
  });

  it("drops over-budget calls from the persisted record (status-only on the wire)", () => {
    const archive = new NestedResultsArchive();
    archive.record("code", "code/0", captureNestedToolResult({ content: [{ type: "text", text: "y".repeat(MAX_NESTED_RESULT_TEXT_CHARS) }] }, false));
    archive.record("code", "code/1", captureNestedToolResult({ content: [{ type: "text", text: "tail" }] }, false));
    const payload = archive.takePayload("code");
    assert.ok(payload);
    // ~4KB of text fits the 64KB record: both calls persist.
    assert.deepEqual(payload.calls.map((call) => call.id), ["code/0", "code/1"]);
    // A record already at the budget keeps only the ordered prefix that fits.
    const huge = budgetPayload("code", [
      { id: "code/0", record: { id: "code/0", text: "z".repeat(40_000), truncated: true, imageCount: 0, isError: false } },
      { id: "code/1", record: { id: "code/1", text: "z".repeat(40_000), truncated: true, imageCount: 0, isError: false } },
      { id: "code/2", record: { id: "code/2", text: "fits", truncated: false, imageCount: 0, isError: false } },
    ]);
    assert.equal(huge.calls.length, 1, "filling is a prefix: once a call does not fit, later calls are dropped");
    assert.deepEqual(huge.calls.map((call) => call.id), ["code/0"]);
  });
});

describe("nested call results in persisted history", () => {
  async function seed() {
    const root = await mkdtemp(join(tmpdir(), "pix-nested-results-"));
    const sessionDir = join(root, "sessions");
    const cwd = join(root, "project");
    await mkdir(sessionDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const manager = SessionManager.create(cwd, sessionDir);
    manager.appendMessage({ role: "user", content: "run the script", timestamp: NOW });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "code", name: "codemode", arguments: { code: "return shared();" } }],
      api: "anthropic",
      provider: "anthropic",
      model: "claude-test",
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: NOW + 1,
    });
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "code",
      toolName: "codemode",
      content: [{ type: "text", text: "shared script output" }],
      isError: false,
      timestamp: NOW + 2,
      nestedCalls: {
        calls: [
          { id: "code/0", name: "read", arguments: { path: "a" }, status: "ok", durationMs: 1 },
          { id: "code/1", name: "grep", status: "error", error: "no match" },
        ],
        complete: true,
      },
    } as never);
    return { root, sessionDir, manager };
  }

  it("reloads merged child results from the pix-nested-results custom entry, which never enters model context", async () => {
    const { root, sessionDir, manager } = await seed();
    try {
      manager.appendCustomEntry("pix-nested-results", {
        version: 1,
        toolCallId: "code",
        calls: [
          { id: "code/0", text: "own output 0", truncated: false, imageCount: 0, isError: false },
          { id: "code/1", text: "grep failed hard", truncated: true, imageCount: 2, isError: true },
        ],
      });
      const store = createPiSdkSessionStore({ sessionDir });
      const context = await store.readSessionContext(manager.getSessionId());
      const toolEntry = context.entries.find((entry) => entry.message.role === "toolResult");
      assert.ok(toolEntry && toolEntry.message.role === "toolResult");
      const calls = toolEntry.message.nestedCalls!.calls;
      assert.equal(calls[0]!.result?.text, "own output 0");
      assert.equal(calls[1]!.result?.truncated, true);
      assert.equal(calls[1]!.result?.imageCount, 2);

      // The custom entry is display/state only: the SDK's model-context
      // projection must not contain it (nor the child outputs).
      const projection = manager.buildSessionContext();
      assert.equal(JSON.stringify(projection).includes("pix-nested-results"), false);
      assert.equal(JSON.stringify(projection).includes("own output 0"), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips malformed records fail-closed and leaves old sessions status-only", async () => {
    const { root, sessionDir, manager } = await seed();
    try {
      manager.appendCustomEntry("pix-nested-results", { version: 1, toolCallId: "code", calls: [{ id: "code/0", text: 7 }] });
      const store = createPiSdkSessionStore({ sessionDir });
      const context = await store.readSessionContext(manager.getSessionId());
      const toolEntry = context.entries.find((entry) => entry.message.role === "toolResult");
      assert.ok(toolEntry && toolEntry.message.role === "toolResult");
      assert.ok(toolEntry.message.nestedCalls!.calls.every((call) => call.result === undefined), "malformed record is never partially applied");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
