import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BuiltInRuntimeStateSchema,
  BuiltInsChangedEventDataSchema,
  MAX_SUBAGENT_TASKS,
  MAX_TODO_ITEMS,
  RuntimeSnapshotSchema,
  SubagentProjectionSchema,
  SubagentsChangedEventDataSchema,
  TodoChangedEventDataSchema,
  TodoProjectionSchema,
  reduceRuntimeEventData,
} from "../dist/index.js";

const revision = "a".repeat(64);
const idleState = {
  sessionId: "s-1",
  isStreaming: false,
  isPromptRunning: false,
  isBashRunning: false,
  isCompacting: false,
  model: null,
  messageCount: 0,
};

function baseSnapshot(overrides = {}) {
  return {
    sessionId: "s-1",
    cwd: "/project",
    projectRoot: "/project",
    state: { ...idleState, ...overrides },
    capabilities: { capabilities: [], version: 0 },
  };
}

const builtIns = {
  configRevision: revision,
  loaded: ["todo", "side_chat"],
  failures: [{ id: "subagents", code: "load_failed" }],
};

const subagents = {
  revision: 2,
  tasks: [{
    taskId: "task-1",
    description: "scan the repo",
    agentType: "explore",
    status: "running",
    usage: { turns: 1, toolCalls: 2, tokens: 9 },
  }],
};

const todo = {
  revision: 4,
  items: [{ id: 1, subject: "write tests", blockedBy: [], status: "pending" }],
};

describe("built-in / subagent / todo snapshot schemas", () => {
  it("accepts canonical loaded order and unique failures", () => {
    assert.equal(BuiltInRuntimeStateSchema.safeParse(builtIns).success, true);
    assert.equal(BuiltInRuntimeStateSchema.safeParse({
      ...builtIns,
      loaded: ["side_chat", "todo"],
    }).success, false);
    assert.equal(BuiltInRuntimeStateSchema.safeParse({
      ...builtIns,
      loaded: ["todo", "todo"],
    }).success, false);
    assert.equal(BuiltInRuntimeStateSchema.safeParse({
      ...builtIns,
      failures: [{ id: "todo", code: "load_failed" }],
    }).success, false);
    assert.equal(BuiltInRuntimeStateSchema.safeParse({
      ...builtIns,
      failures: [{ id: "todo", code: "timeout" }],
    }).success, false);
    assert.equal(BuiltInRuntimeStateSchema.safeParse({ ...builtIns, extra: true }).success, false);
  });

  it("rejects unknown keys, duplicate ids, and invalid statuses", () => {
    assert.equal(SubagentProjectionSchema.safeParse(subagents).success, true);
    assert.equal(SubagentProjectionSchema.safeParse({
      revision: 1,
      tasks: [subagents.tasks[0], subagents.tasks[0]],
    }).success, false);
    assert.equal(SubagentProjectionSchema.safeParse({
      revision: 1,
      tasks: [{ ...subagents.tasks[0], status: "queued" }],
    }).success, false);
    assert.equal(SubagentProjectionSchema.safeParse({
      revision: 1,
      tasks: [{ ...subagents.tasks[0], path: "/tmp" }],
    }).success, false);
    assert.equal(SubagentProjectionSchema.safeParse({
      revision: 1,
      tasks: [{ ...subagents.tasks[0], usage: { turns: -1 } }],
    }).success, false);
    assert.equal(SubagentProjectionSchema.safeParse({
      revision: 1,
      tasks: Array.from({ length: MAX_SUBAGENT_TASKS + 1 }, (_, i) => ({
        ...subagents.tasks[0],
        taskId: `t-${i}`,
      })),
    }).success, false);

    assert.equal(TodoProjectionSchema.safeParse(todo).success, true);
    assert.equal(TodoProjectionSchema.safeParse({
      revision: 1,
      items: [todo.items[0], todo.items[0]],
    }).success, false);
    assert.equal(TodoProjectionSchema.safeParse({
      revision: 1,
      items: [{ ...todo.items[0], status: "blocked" }],
    }).success, false);
    assert.equal(TodoProjectionSchema.safeParse({
      revision: 1,
      items: [{ ...todo.items[0], extra: true }],
    }).success, false);
    assert.equal(TodoProjectionSchema.safeParse({
      revision: 1,
      items: [{ ...todo.items[0], blockedBy: [1] }],
    }).success, false);
    assert.equal(TodoProjectionSchema.safeParse({
      revision: 1,
      items: Array.from({ length: MAX_TODO_ITEMS + 1 }, (_, i) => ({
        ...todo.items[0],
        id: i + 1,
      })),
    }).success, false);
  });

  it("round-trips optional snapshot fields and replacement events", () => {
    assert.equal(RuntimeSnapshotSchema.safeParse({
      ...baseSnapshot({ builtIns, subagents, todo }),
    }).success, true);
    assert.equal(BuiltInsChangedEventDataSchema.safeParse({
      type: "built_ins_changed",
      sessionId: "s-1",
      builtIns,
    }).success, true);
    assert.equal(SubagentsChangedEventDataSchema.safeParse({
      type: "subagents_changed",
      sessionId: "s-1",
      subagents,
    }).success, true);
    assert.equal(TodoChangedEventDataSchema.safeParse({
      type: "todo_changed",
      sessionId: "s-1",
      todo,
    }).success, true);
    assert.equal(BuiltInsChangedEventDataSchema.safeParse({
      type: "built_ins_changed",
      sessionId: "s-1",
      builtIns,
      extra: 1,
    }).success, false);
  });
});

describe("reduceRuntimeEventData — full replacement of builtIns/subagents/todo", () => {
  it("replaces each projection completely and leaves the input snapshot untouched", () => {
    const before = baseSnapshot({
      builtIns: { configRevision: "b".repeat(64), loaded: ["subagents"], failures: [] },
      subagents: { revision: 1, tasks: [{ taskId: "old", description: "old", agentType: "x", status: "failed" }] },
      todo: { revision: 1, items: [{ id: 9, subject: "old", blockedBy: [], status: "completed" }] },
    });
    const frozenBuiltIns = structuredClone(before.state.builtIns);
    let after = reduceRuntimeEventData(before, {
      type: "built_ins_changed",
      sessionId: "s-1",
      builtIns,
    });
    after = reduceRuntimeEventData(after, {
      type: "subagents_changed",
      sessionId: "s-1",
      subagents,
    });
    after = reduceRuntimeEventData(after, {
      type: "todo_changed",
      sessionId: "s-1",
      todo,
    });
    assert.deepEqual(after.state.builtIns, builtIns);
    assert.deepEqual(after.state.subagents, subagents);
    assert.deepEqual(after.state.todo, todo);
    assert.deepEqual(before.state.builtIns, frozenBuiltIns);
    assert.equal(before.state.subagents.tasks[0].taskId, "old");
    assert.equal(before.state.todo.items[0].id, 9);
  });

  it("clones event payloads so later mutation cannot leak into the snapshot", () => {
    const event = {
      type: "subagents_changed",
      sessionId: "s-1",
      subagents: structuredClone(subagents),
    };
    const after = reduceRuntimeEventData(baseSnapshot(), event);
    event.subagents.revision = 99;
    event.subagents.tasks[0].taskId = "mutated";
    event.subagents.tasks[0].usage.tokens = 0;
    assert.equal(after.state.subagents.revision, 2);
    assert.equal(after.state.subagents.tasks[0].taskId, "task-1");
    assert.equal(after.state.subagents.tasks[0].usage.tokens, 9);
  });
});
