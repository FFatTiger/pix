import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RuntimeEvent } from "@fffattiger/pix-runtime-core";
import { CanonicalAgentRuntimeAdapter } from "../src/internal/adapter.js";
import { ScriptedSdkDriverFactory, ScriptedSdkStore } from "./scripted-sdk.js";

async function setup() {
  const driver = await new ScriptedSdkDriverFactory(new ScriptedSdkStore()).create({ cwd: "/workspace" }, {});
  const adapter = new CanonicalAgentRuntimeAdapter(driver);
  await adapter.ready();
  const events: RuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  return { driver, adapter, events };
}

describe("production adapter written-file correlation", () => {
  it("derives a canonical path from real-shaped start args, not end result fields", async () => {
    const { adapter, events } = await setup();
    const result = await adapter.execute({ type: "prompt", message: "write file" });
    assert.equal(result.ok, true);
    const end = events.find((event) => event.type === "tool_execution_end");
    assert.ok(end && end.type === "tool_execution_end");
    assert.deepEqual(end.writtenFiles, ["/workspace/notes-1.md"]);
    assert.deepEqual((await adapter.getSnapshot()).state.writtenFiles, ["/workspace/notes-1.md"]);
    await adapter.close("user");
  });

  it("does not cross-correlate mismatched, failed, or duplicate end events", async () => {
    const { driver, adapter, events } = await setup();
    const emit = driver.emit.bind(driver);
    emit({ type: "tool_execution_start", toolCallId: "a", toolName: "write", args: { path: "a.txt", content: "a" } });
    emit({ type: "tool_execution_start", toolCallId: "b", toolName: "edit", args: { path: "b.txt", edits: [] } });
    emit({ type: "tool_execution_end", toolCallId: "missing", toolName: "write", result: { content: [] }, isError: false });
    emit({ type: "tool_execution_end", toolCallId: "a", toolName: "write", result: { content: [] }, isError: true });
    emit({ type: "tool_execution_end", toolCallId: "b", toolName: "edit", result: { content: [] }, isError: false });
    emit({ type: "tool_execution_end", toolCallId: "b", toolName: "edit", result: { content: [] }, isError: false });
    assert.deepEqual((await adapter.getSnapshot()).state.writtenFiles, ["/workspace/b.txt"]);
    assert.equal(events.filter((event) => event.type === "tool_execution_end" && event.toolCallId === "b").length, 1);
    await adapter.close("user");
  });
});
