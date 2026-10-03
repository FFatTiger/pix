import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_SUBAGENT_TASKS,
  MAX_SUBAGENT_TASK_ID_LENGTH,
  RuntimeEventDataSchema,
  RuntimeSnapshotSchema,
  reduceRuntimeEventData,
} from "../dist/index.js";

const idleState = {
  sessionId: "s-1",
  isStreaming: false,
  isPromptRunning: false,
  isBashRunning: false,
  isCompacting: false,
  model: null,
  messageCount: 0,
};

function snapshot(overrides = {}) {
  return {
    sessionId: "s-1",
    cwd: "/project",
    projectRoot: "/project",
    state: { ...idleState, ...overrides },
    capabilities: { capabilities: [], version: 0 },
    streaming: { active: false, phase: "idle" },
  };
}

function partial(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function delta(childSessionId, text, extra = {}) {
  return {
    type: "subagent_delta",
    sessionId: "s-1",
    childSessionId,
    partial: extra.partial ?? partial(text),
    done: extra.done ?? false,
    ...(extra.ts === undefined ? {} : { ts: extra.ts }),
  };
}

describe("subagent_delta wire and reducer", () => {
  it("accepts bounded child ids and cumulative partials, rejects extras and oversized ids", () => {
    const valid = delta("child-1", "hello");
    assert.equal(RuntimeEventDataSchema.safeParse(valid).success, true);
    assert.equal(RuntimeEventDataSchema.safeParse({ ...valid, extra: true }).success, false);
    assert.equal(RuntimeEventDataSchema.safeParse({ ...valid, childSessionId: "x".repeat(MAX_SUBAGENT_TASK_ID_LENGTH + 1) }).success, false);
    assert.equal(RuntimeEventDataSchema.safeParse({ ...valid, childSessionId: " " }).success, false);
    assert.equal(RuntimeEventDataSchema.safeParse({ ...valid, done: "no" }).success, false);
  });

  it("replaces the live stream, then deletes it on done", () => {
    const first = reduceRuntimeEventData(snapshot(), delta("child-1", "Hel", { ts: 1 }));
    assert.equal(first.state.subagents?.streams?.["child-1"]?.partial.content[0].text, "Hel");
    const second = reduceRuntimeEventData(first, delta("child-1", "Hello", { ts: 2 }));
    assert.equal(second.state.subagents?.streams?.["child-1"]?.partial.content[0].text, "Hello");
    assert.equal(Object.keys(second.state.subagents.streams).length, 1);
    const done = reduceRuntimeEventData(second, delta("child-1", "Hello", { done: true, ts: 3 }));
    assert.equal(done.state.subagents?.streams?.["child-1"], undefined);
    assert.deepEqual(done.state.subagents?.streams, {});
  });

  it("preserves live streams across a full subagents_changed replacement", () => {
    const live = reduceRuntimeEventData(snapshot(), delta("child-1", "partial", { ts: 5 }));
    const replaced = reduceRuntimeEventData(live, {
      type: "subagents_changed",
      sessionId: "s-1",
      subagents: { revision: 2, tasks: [{ taskId: "t1", description: "scan", agentType: "explore", status: "running", childSessionId: "child-1" }] },
    });
    assert.equal(replaced.state.subagents.revision, 2);
    assert.equal(replaced.state.subagents.tasks[0].taskId, "t1");
    assert.equal(replaced.state.subagents.streams["child-1"].partial.content[0].text, "partial");
  });

  it("evicts the oldest updatedAt when the stream map exceeds MAX_SUBAGENT_TASKS", () => {
    let current = snapshot();
    for (let index = 0; index < MAX_SUBAGENT_TASKS; index += 1) {
      current = reduceRuntimeEventData(current, delta(`child-${index}`, "x", { ts: index + 1 }));
    }
    current = reduceRuntimeEventData(current, delta("child-new", "y", { ts: MAX_SUBAGENT_TASKS + 10 }));
    const ids = Object.keys(current.state.subagents.streams);
    assert.equal(ids.length, MAX_SUBAGENT_TASKS);
    assert.equal(current.state.subagents.streams["child-0"], undefined);
    assert.equal(current.state.subagents.streams["child-new"]?.partial.content[0].text, "y");
  });

  it("allows attach snapshots to carry empty streams", () => {
    const emptyStreams = snapshot({
      subagents: { revision: 0, tasks: [], streams: {} },
    });
    assert.equal(RuntimeSnapshotSchema.safeParse(emptyStreams).success, true);
    const withStream = snapshot({
      subagents: {
        revision: 1,
        tasks: [{ taskId: "t1", description: "scan", agentType: "explore", status: "running", childSessionId: "child-1" }],
        streams: { "child-1": { partial: partial("live"), updatedAt: 1 } },
      },
    });
    assert.equal(RuntimeSnapshotSchema.safeParse(withStream).success, true);
  });
});
