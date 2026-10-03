import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  MAX_TODO_ACTIVE_FORM_LENGTH,
  MAX_TODO_DESCRIPTION_LENGTH,
  MAX_TODO_OWNER_LENGTH,
  MAX_TODO_SUBJECT_LENGTH,
} from "@fffattiger/pix-runtime-core";
import {
  isTodoReplayEvent,
  nextTodoProjection,
  parseTodoDetails,
  todoItemsFromBranch,
  todoItemsFromMessages,
  todoItemsFromToolEnd,
} from "../src/internal/todo-projection.js";

function item(
  id: number,
  status: "pending" | "in_progress" | "completed" | "deleted" = "pending",
) {
  return { id, subject: `task ${id}`, status };
}

describe("todo projection replay and live refresh", () => {
  it("restores Todo from real compacted JSONL on reopen without taking a sibling branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-todo-compaction-"));
    const cwd = join(root, "cwd");
    const sessionsDir = join(root, "sessions");
    await mkdir(cwd);
    await mkdir(sessionsDir);
    try {
      const manager = SessionManager.create(cwd, sessionsDir);
      manager.appendMessage({ role: "user", content: "track work", timestamp: 1 });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "todo-call", name: "todo", arguments: { action: "list" } }],
        api: "openai-completions", provider: "test", model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse", timestamp: 2,
      });
      const trunk = manager.appendMessage({
        role: "toolResult", toolCallId: "todo-call", toolName: "todo", isError: false,
        content: [{ type: "text", text: "tracked" }],
        details: { tasks: [item(1, "completed"), item(2, "in_progress")] }, timestamp: 3,
      });
      manager.appendMessage({
        role: "toolResult", toolCallId: "sibling-call", toolName: "todo", isError: false,
        content: [{ type: "text", text: "sibling" }], details: { tasks: [item(9)] }, timestamp: 4,
      });
      manager.branch(trunk);
      const kept = manager.appendMessage({ role: "user", content: "continue", timestamp: 5 });
      manager.appendCompaction("summary without Todo details", kept, 500);
      const expected = [{ id: 1, status: "completed" }, { id: 2, status: "in_progress" }];
      const sessionFile = manager.getSessionFile();
      assert.ok(sessionFile);
      const reopened = SessionManager.open(sessionFile, sessionsDir);
      for (const selected of [manager, reopened]) {
        assert.deepEqual(todoItemsFromMessages(selected.buildSessionContext().messages), []);
        assert.deepEqual(todoItemsFromBranch(selected.getBranch()).map(({ id, status }) => ({ id, status })), expected);
        assert.ok(selected.getEntries().length > selected.getBranch().length, "sibling history exists but is not selected");
      }
      assert.equal(reopened.getSessionId(), manager.getSessionId());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("replays the selected durable branch after compaction hides the Todo message", () => {
    const branch = [
      { type: "message", id: "m1", message: { role: "toolResult", toolName: "todo", isError: false, details: { tasks: [item(1, "in_progress")] } } },
      { type: "compaction", id: "c1", summary: "older work" },
      { type: "message", id: "m2", message: { role: "user", content: "continue" } },
      { type: "custom", id: "x1" },
    ];

    assert.deepEqual(todoItemsFromMessages([
      { role: "user", content: "continue" },
    ]), []);
    assert.deepEqual(todoItemsFromBranch(branch).map((row) => ({ id: row.id, status: row.status })), [
      { id: 1, status: "in_progress" },
    ]);
  });

  it("replays only message entries from the selected branch and keeps exact-result validation", () => {
    const branch = [
      { type: "message", message: { role: "toolResult", toolName: "todo", isError: false, details: { tasks: [item(1)] } } },
      { type: "message", message: { role: "toolResult", toolName: "todo", isError: true, details: { tasks: [item(2)] } } },
      { type: "message", message: { role: "toolResult", toolName: "other", isError: false, details: { tasks: [item(3)] } } },
      { type: "message", message: { role: "toolResult", toolName: "todo", isError: false, details: { tasks: [{ id: 0, subject: "bad", status: "pending" }] } } },
      { type: "branch_summary", summary: "sibling branch todo id 9" },
    ];

    assert.deepEqual(todoItemsFromBranch(branch).map((row) => row.id), [1]);
  });

  it("replays the latest successful Todo result on the selected branch", () => {
    const items = todoItemsFromMessages([
      { role: "toolResult", toolName: "todo", isError: false, details: { tasks: [item(1, "pending"), { id: 8, subject: "gone later", status: "deleted" }] } },
      { role: "toolResult", toolName: "other", isError: false, details: { tasks: [item(9)] } },
      { role: "toolResult", toolName: "todo", isError: false, details: { tasks: [
        item(2),
        { id: 1, subject: "first", status: "in_progress", description: "now", blockedBy: [] },
        { id: 3, subject: "gone", status: "deleted" },
      ] } },
      // A later FAILED todo result must not replace the last valid one.
      { role: "toolResult", toolName: "todo", isError: true, details: { tasks: [item(99)] } },
      // A later MALFORMED todo result is skipped; the earlier valid list wins.
      { role: "toolResult", toolName: "todo", isError: false, details: { tasks: [{ id: 0, subject: "bad", status: "pending" }] } },
      // Missing isError is not a successful exact toolResult.
      { role: "toolResult", toolName: "todo", details: { tasks: [item(98)] } },
    ]);
    assert.deepEqual(items.map((row) => row.id), [2, 1]);
    assert.equal(items[1]?.status, "in_progress");
    const seeded = nextTodoProjection(undefined, items);
    assert.equal(seeded.projection.revision, 1);
    const same = nextTodoProjection(seeded.projection, items);
    assert.equal(same.changed, false);
    assert.equal(same.projection.revision, 1);
    const empty = nextTodoProjection(undefined, []);
    assert.deepEqual(empty.projection, { revision: 0, items: [] });
    const changed = nextTodoProjection(seeded.projection, []);
    assert.equal(changed.changed, true);
    assert.equal(changed.projection.revision, 2);
  });

  it("bounds long plugin text without discarding task progress or accepting malformed fields", () => {
    const longTask = {
      id: 1,
      subject: "工作标题".repeat(MAX_TODO_SUBJECT_LENGTH),
      description: "Long task description ".repeat(MAX_TODO_DESCRIPTION_LENGTH),
      activeForm: "working ".repeat(MAX_TODO_ACTIVE_FORM_LENGTH),
      owner: "owner ".repeat(MAX_TODO_OWNER_LENGTH),
      status: "completed",
    };
    const tasks = [longTask, item(2, "in_progress")];
    const projected = parseTodoDetails({ tasks });
    assert.ok(projected);
    assert.deepEqual(projected.map(({ id, status }) => ({ id, status })), [
      { id: 1, status: "completed" }, { id: 2, status: "in_progress" },
    ]);
    assert.equal(projected[0]?.subject, longTask.subject.slice(0, MAX_TODO_SUBJECT_LENGTH));
    assert.equal(projected[0]?.description, longTask.description.slice(0, MAX_TODO_DESCRIPTION_LENGTH));
    assert.equal(projected[0]?.activeForm, longTask.activeForm.slice(0, MAX_TODO_ACTIVE_FORM_LENGTH));
    assert.equal(projected[0]?.owner, longTask.owner.slice(0, MAX_TODO_OWNER_LENGTH));
    assert.deepEqual(todoItemsFromBranch([
      { type: "message", message: { role: "toolResult", toolName: "todo", isError: false, details: { tasks } } },
    ]), projected);
    for (const field of ["subject", "description", "activeForm", "owner"]) {
      for (const invalid of [null, 123, {}, "   "]) {
        assert.equal(parseTodoDetails({ tasks: [{ ...longTask, [field]: invalid }] }), null);
      }
    }
  });

  it("rejects malformed/oversize lists and ignores non-exact live ends", () => {
    assert.equal(parseTodoDetails({ tasks: [{ id: 0, subject: "bad", status: "pending" }] }), null);
    assert.equal(parseTodoDetails({ tasks: [{ id: 1, subject: "x", status: "blocked" }] }), null);
    assert.equal(parseTodoDetails({ tasks: Array.from({ length: 129 }, (_, index) => item(index + 1)) }), null);
    assert.equal(parseTodoDetails({ tasks: Array.from({ length: 65 }, (_, index) => item(index + 1)) }), null);
    assert.equal(parseTodoDetails({ tasks: Array.from({ length: 200 }, (_, index) => item(index + 1, "deleted")) }), null);
    assert.equal(todoItemsFromToolEnd({ type: "tool_execution_end", toolName: "todo", isError: true, result: { details: { tasks: [] } } }), null);
    assert.equal(todoItemsFromToolEnd({ type: "tool_execution_end", toolName: "todos", isError: false, result: { details: { tasks: [] } } }), null);
    assert.equal(todoItemsFromToolEnd({ type: "tool_execution_end", toolName: "todo", result: { details: { tasks: [item(1)] } } }), null);
    const live = todoItemsFromToolEnd({
      type: "tool_execution_end",
      toolName: "todo",
      isError: false,
      result: { details: { tasks: [{ id: 1, subject: "keep", status: "completed", blockedBy: [] }] } },
    });
    assert.deepEqual(live?.map((row) => row.id), [1]);
  });

  it("replays after an exact successful compaction_end only", () => {
    assert.equal(isTodoReplayEvent({ type: "compaction_end", aborted: false, result: { entries: 2 } }), true);
    assert.equal(isTodoReplayEvent({ type: "compaction_end", aborted: true, result: { entries: 2 } }), false);
    assert.equal(isTodoReplayEvent({ type: "compaction_end", aborted: false, result: undefined }), false);
    assert.equal(isTodoReplayEvent({ type: "compaction_start", reason: "manual" }), false);
    assert.equal(isTodoReplayEvent({ type: "compaction", aborted: false, result: {} }), false);
  });
});
