import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reduceRuntimeEventData } from "../dist/index.js";

function snapshot() {
  return {
    sessionId: "s-1",
    cwd: "/p",
    projectRoot: "/p",
    state: {
      sessionId: "s-1",
      isStreaming: false,
      isPromptRunning: false,
      isBashRunning: false,
      isCompacting: false,
      model: null,
      messageCount: 0,
    },
    capabilities: { capabilities: [], version: 1 },
    streaming: { active: false, phase: "idle" },
  };
}

describe("compaction projection reason", () => {
  it("preserves automatic and manual starts as distinct authoritative state", () => {
    const automatic = reduceRuntimeEventData(snapshot(), {
      type: "auto_compaction_start",
      sessionId: "s-1",
      ts: 10,
    });
    assert.equal(automatic.state.compaction?.reason, "auto");
    assert.equal(automatic.state.compaction?.startedAt, 10);

    const manual = reduceRuntimeEventData(snapshot(), {
      type: "compaction_start",
      sessionId: "s-1",
      reason: "manual",
      ts: 20,
    });
    assert.equal(manual.state.compaction?.reason, "manual");
    assert.equal(manual.state.compaction?.startedAt, 20);
  });
});
