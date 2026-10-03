/**
 * Cross-package authority-snapshot contract — Protocol wire projection vs
 * runtime-core canonical models for loaded built-ins, subagents, and todos.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILT_IN_CAPABILITY_IDS as CANONICAL_IDS,
  BUILT_IN_LOAD_FAILURE_CODES as CANONICAL_FAILURES,
  MAX_SUBAGENT_TASKS as CANONICAL_MAX_SUBAGENT_TASKS,
  MAX_SUBAGENT_STREAM_CHARS as CANONICAL_MAX_SUBAGENT_STREAM_CHARS,
  MAX_TODO_ITEMS as CANONICAL_MAX_TODO_ITEMS,
  RUNTIME_CAPABILITIES as CANONICAL_CAPABILITIES,
  RUNTIME_COMMAND_CAPABILITIES,
  SUBAGENT_TASK_STATUSES as CANONICAL_SUBAGENT_STATUSES,
  TODO_ITEM_STATUSES as CANONICAL_TODO_STATUSES,
  normalizeBuiltInRuntimeState,
  normalizeSubagentProjection,
  normalizeTodoProjection,
  type BuiltInRuntimeState as CanonicalBuiltIns,
  type SubagentProjection as CanonicalSubagents,
  type TodoProjection as CanonicalTodo,
} from "@fffattiger/pix-runtime-core";
import {
  BUILT_IN_CAPABILITY_IDS as WIRE_IDS,
  BUILT_IN_LOAD_FAILURE_CODES as WIRE_FAILURES,
  BuiltInRuntimeStateSchema,
  BuiltInsChangedEventDataSchema,
  MAX_SUBAGENT_TASKS as WIRE_MAX_SUBAGENT_TASKS,
  MAX_SUBAGENT_STREAM_CHARS as WIRE_MAX_SUBAGENT_STREAM_CHARS,
  MAX_TODO_ITEMS as WIRE_MAX_TODO_ITEMS,
  RUNTIME_COMMAND_CAPABILITY_MATRIX,
  RuntimeCapabilitySchema,
  SUBAGENT_TASK_STATUSES as WIRE_SUBAGENT_STATUSES,
  SubagentProjectionSchema,
  SubagentsChangedEventDataSchema,
  TODO_ITEM_STATUSES as WIRE_TODO_STATUSES,
  TodoChangedEventDataSchema,
  TodoProjectionSchema,
  type BuiltInRuntimeState as WireBuiltIns,
  type SubagentProjection as WireSubagents,
  type TodoProjection as WireTodo,
} from "@fffattiger/pix-protocol";

const revision = "a".repeat(64);

test("runtime capability vocabulary and command mapping stay in parity", () => {
  assert.deepEqual([...RuntimeCapabilitySchema.options], [...CANONICAL_CAPABILITIES]);
  assert.deepEqual(RUNTIME_COMMAND_CAPABILITY_MATRIX, RUNTIME_COMMAND_CAPABILITIES);
  for (const token of ["runtime.subagents", "runtime.todo", "runtime.user_question"]) {
    assert.ok(CANONICAL_CAPABILITIES.includes(token as typeof CANONICAL_CAPABILITIES[number]));
    assert.equal(Object.values(RUNTIME_COMMAND_CAPABILITIES).includes(token as never), false);
  }
  assert.equal(RUNTIME_COMMAND_CAPABILITIES.side_chat_start, "runtime.side_chat");
});

test("loaded built-in / subagent / todo vocabularies match runtime-core", () => {
  assert.deepEqual([...WIRE_IDS], [...CANONICAL_IDS]);
  assert.deepEqual([...WIRE_FAILURES], [...CANONICAL_FAILURES]);
  assert.deepEqual([...WIRE_SUBAGENT_STATUSES], [...CANONICAL_SUBAGENT_STATUSES]);
  assert.deepEqual([...WIRE_TODO_STATUSES], [...CANONICAL_TODO_STATUSES]);
  assert.equal(WIRE_MAX_SUBAGENT_TASKS, CANONICAL_MAX_SUBAGENT_TASKS);
  assert.equal(WIRE_MAX_SUBAGENT_STREAM_CHARS, CANONICAL_MAX_SUBAGENT_STREAM_CHARS);
  assert.equal(WIRE_MAX_TODO_ITEMS, CANONICAL_MAX_TODO_ITEMS);
});

test("protocol schemas accept canonical projection shapes and reject extras/duplicates", () => {
  const builtIns: CanonicalBuiltIns = normalizeBuiltInRuntimeState({
    configRevision: revision,
    loaded: ["side_chat", "todo"],
    failures: [{ id: "subagents", code: "load_failed" }],
  })!;
  const subagents: CanonicalSubagents = normalizeSubagentProjection({
    revision: 1,
    tasks: [{ taskId: "t1", description: "scan", agentType: "explore", status: "running" }],
  })!;
  const todo: CanonicalTodo = normalizeTodoProjection({
    revision: 2,
    items: [{ id: 1, subject: "write", blockedBy: [], status: "pending" }],
  })!;

  const wireBuiltIns: WireBuiltIns = BuiltInRuntimeStateSchema.parse(builtIns);
  const wireSubagents: WireSubagents = SubagentProjectionSchema.parse(subagents);
  const wireTodo: WireTodo = TodoProjectionSchema.parse(todo);
  assert.deepEqual(wireBuiltIns, builtIns);
  assert.deepEqual(wireSubagents, subagents);
  assert.deepEqual(wireTodo, todo);

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

  assert.equal(BuiltInRuntimeStateSchema.safeParse({
    ...builtIns,
    loaded: ["todo", "todo"],
  }).success, false);
  assert.equal(SubagentProjectionSchema.safeParse({
    revision: 1,
    tasks: [{ ...subagents.tasks[0], path: "/tmp" }],
  }).success, false);
  assert.equal(TodoProjectionSchema.safeParse({
    revision: 1,
    items: [{ ...todo.items[0], status: "blocked" }],
  }).success, false);
});
