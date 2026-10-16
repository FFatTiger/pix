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

describe("Pi 1.1 turn outcome and tool duration forwarding", () => {
  it("forwards agent_settled.aborted so stopped runs differ from finished ones", async () => {
    const { driver, adapter, events } = await setup();
    try {
      driver.emit({ type: "agent_settled", aborted: true });
      driver.emit({ type: "agent_settled", aborted: false });
      driver.emit({ type: "agent_settled" });
      const settled = events.filter((event): event is Extract<RuntimeEvent, { type: "agent_settled" }> => event.type === "agent_settled");
      assert.equal(settled.length, 3);
      assert.equal(settled[0]?.aborted, true);
      assert.equal("aborted" in (settled[1] ?? {}), false, "an explicit non-abort normalizes to the legacy wire shape");
      assert.equal("aborted" in (settled[2] ?? {}), false, "legacy settles carry no opinion");
    } finally {
      await adapter.close("shutdown");
    }
  });

  it("forwards tool_execution_end.durationMs only for finite non-negative values", async () => {
    const { driver, adapter, events } = await setup();
    try {
      driver.emit({ type: "tool_execution_start", toolCallId: "a", toolName: "bash" });
      driver.emit({ type: "tool_execution_end", toolCallId: "a", toolName: "bash", isError: false, durationMs: 430 });
      driver.emit({ type: "tool_execution_start", toolCallId: "b", toolName: "read" });
      driver.emit({ type: "tool_execution_end", toolCallId: "b", toolName: "read", isError: false, durationMs: -1 });
      driver.emit({ type: "tool_execution_start", toolCallId: "c", toolName: "read" });
      driver.emit({ type: "tool_execution_end", toolCallId: "c", toolName: "read", isError: false, durationMs: Number.NaN });
      driver.emit({ type: "tool_execution_start", toolCallId: "d", toolName: "read" });
      driver.emit({ type: "tool_execution_end", toolCallId: "d", toolName: "read", isError: false });
      const ends = events.filter((event): event is Extract<RuntimeEvent, { type: "tool_execution_end" }> => event.type === "tool_execution_end");
      assert.equal(ends.length, 4);
      assert.equal(ends[0]?.durationMs, 430);
      for (const event of ends.slice(1)) {
        assert.equal("durationMs" in event, false, "invalid or absent durations must not surface");
      }
    } finally {
      await adapter.close("shutdown");
    }
  });
});
