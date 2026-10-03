import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILT_IN_CAPABILITY_IDS } from "./built-in-capabilities.js";
import {
  BUILT_IN_LOAD_FAILURE_CODES,
  MAX_SUBAGENT_TASKS,
  MAX_TODO_ITEMS,
  SUBAGENT_TASK_STATUSES,
  TODO_ITEM_STATUSES,
  normalizeBuiltInRuntimeState,
  normalizeSubagentProjection,
  normalizeTodoProjection,
} from "./runtime-projections.js";

const revision = "a".repeat(64);

test("built-in runtime state uses canonical IDs and unique canonical order", () => {
  const normalized = normalizeBuiltInRuntimeState({
    configRevision: revision,
    loaded: ["side_chat", "todo"],
    failures: [
      { id: "ask_user_question", code: "incompatible" },
      { id: "subagents", code: "load_failed" },
    ],
  });
  assert.deepEqual(normalized, {
    configRevision: revision,
    loaded: ["todo", "side_chat"],
    failures: [
      { id: "subagents", code: "load_failed" },
      { id: "ask_user_question", code: "incompatible" },
    ],
  });
  assert.deepEqual([...BUILT_IN_CAPABILITY_IDS], ["subagents", "todo", "ask_user_question", "side_chat"]);
  assert.deepEqual([...BUILT_IN_LOAD_FAILURE_CODES], ["load_failed", "incompatible"]);
});

test("built-in runtime state rejects unknown keys, duplicate ids, and bad revisions", () => {
  const valid = { configRevision: revision, loaded: ["todo"], failures: [] };
  assert.equal(normalizeBuiltInRuntimeState(null), null);
  assert.equal(normalizeBuiltInRuntimeState({ ...valid, extra: true }), null);
  assert.equal(normalizeBuiltInRuntimeState({ ...valid, configRevision: "xyz" }), null);
  assert.equal(normalizeBuiltInRuntimeState({ ...valid, loaded: ["todo", "todo"] }), null);
  assert.equal(normalizeBuiltInRuntimeState({ ...valid, loaded: ["plugins"] }), null);
  assert.equal(normalizeBuiltInRuntimeState({
    ...valid,
    failures: [{ id: "todo", code: "load_failed" }],
  }), null);
  assert.equal(normalizeBuiltInRuntimeState({
    ...valid,
    failures: [
      { id: "todo", code: "load_failed" },
      { id: "todo", code: "incompatible" },
    ],
  }), null);
  assert.equal(normalizeBuiltInRuntimeState({
    ...valid,
    failures: [{ id: "todo", code: "timeout" }],
  }), null);
});

test("subagent projection accepts safe fields and unique task ids", () => {
  const normalized = normalizeSubagentProjection({
    revision: 3,
    tasks: [
      {
        taskId: "task-1",
        name: "Explore",
        description: "scan the repo",
        agentType: "explore",
        status: "running",
        background: true,
        startedAt: 1,
        childSessionId: "child-1",
        preview: "reading files",
        usage: { turns: 2, toolCalls: 4, tokens: 80 },
      },
      {
        taskId: "task-2",
        description: "done work",
        agentType: "general",
        status: "completed",
        completedAt: 9,
      },
    ],
  });
  assert.equal(normalized?.revision, 3);
  assert.equal(normalized?.tasks.length, 2);
  assert.equal(normalized?.tasks[0]?.taskId, "task-1");
  assert.deepEqual([...SUBAGENT_TASK_STATUSES], ["running", "completed", "partial", "failed", "stopped"]);
});

test("subagent projection rejects path/raw-prompt extras, duplicates, and bad status", () => {
  const task = {
    taskId: "task-1",
    description: "scan",
    agentType: "explore",
    status: "running",
  };
  assert.equal(normalizeSubagentProjection({ revision: -1, tasks: [task] }), null);
  assert.equal(normalizeSubagentProjection({ revision: 1, tasks: [task, task] }), null);
  assert.equal(normalizeSubagentProjection({ revision: 1, tasks: [{ ...task, status: "queued" }] }), null);
  assert.equal(normalizeSubagentProjection({ revision: 1, tasks: [{ ...task, path: "/tmp/x" }] }), null);
  assert.equal(normalizeSubagentProjection({ revision: 1, tasks: [{ ...task, prompt: "raw" }] }), null);
  assert.equal(normalizeSubagentProjection({ revision: 1, tasks: [{ ...task, usage: { turns: -1 } }] }), null);
  assert.equal(normalizeSubagentProjection({
    revision: 1,
    tasks: Array.from({ length: MAX_SUBAGENT_TASKS + 1 }, (_, i) => ({ ...task, taskId: `t-${i}` })),
  }), null);
});

test("todo projection accepts unique positive ids and bounded blockedBy", () => {
  const normalized = normalizeTodoProjection({
    revision: 0,
    items: [
      { id: 1, subject: "write tests", blockedBy: [], status: "in_progress", owner: "pix" },
      { id: 2, subject: "ship", description: "after tests", blockedBy: [1], status: "pending", activeForm: "Shipping" },
    ],
  });
  assert.equal(normalized?.items.length, 2);
  assert.deepEqual(normalized?.items[1]?.blockedBy, [1]);
  assert.deepEqual([...TODO_ITEM_STATUSES], ["pending", "in_progress", "completed"]);
});

test("todo projection rejects unknown keys, duplicate ids, and invalid status", () => {
  const item = { id: 1, subject: "write", blockedBy: [], status: "pending" };
  assert.equal(normalizeTodoProjection({ revision: 1, items: [{ ...item, extra: true }] }), null);
  assert.equal(normalizeTodoProjection({ revision: 1, items: [item, item] }), null);
  assert.equal(normalizeTodoProjection({ revision: 1, items: [{ ...item, id: 0 }] }), null);
  assert.equal(normalizeTodoProjection({ revision: 1, items: [{ ...item, status: "blocked" }] }), null);
  assert.equal(normalizeTodoProjection({ revision: 1, items: [{ ...item, blockedBy: [1] }] }), null);
  assert.equal(normalizeTodoProjection({
    revision: 1,
    items: Array.from({ length: MAX_TODO_ITEMS + 1 }, (_, i) => ({ ...item, id: i + 1 })),
  }), null);
});
