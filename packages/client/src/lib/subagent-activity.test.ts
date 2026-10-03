import { describe, expect, it } from "vitest";
import type { SubagentTask, TodoItem } from "@fffattiger/pix-protocol";
import { selectChildStream, selectStatusTodos, selectSubagentActivity } from "./subagent-activity";

const TASKS: readonly SubagentTask[] = [
  {
    taskId: "task-1",
    name: "runtime-audit",
    description: "Inspect runtime",
    agentType: "Explore",
    status: "running",
    background: true,
    startedAt: 10,
    childSessionId: "child-1",
    preview: "reading",
    usage: { turns: 2, toolCalls: 4 },
  },
  {
    taskId: "task-2",
    description: "Check tests",
    agentType: "verification",
    status: "completed",
    startedAt: 20,
    completedAt: 30,
  },
];

const TODOS: readonly TodoItem[] = [
  {
    id: 1,
    subject: "Ship the status panel",
    description: "hidden backend description",
    activeForm: "Shipping",
    owner: "runtime",
    blockedBy: [2],
    status: "in_progress",
  },
  {
    id: 2,
    subject: "Write tests",
    blockedBy: [],
    status: "pending",
  },
];

describe("selectSubagentActivity", () => {
  it("projects the authority-owned task order and child identity", () => {
    expect(selectSubagentActivity(TASKS)).toEqual([
      {
        key: "task:task-1",
        taskId: "task-1",
        title: "runtime-audit",
        agentType: "Explore",
        status: "running",
        startedAt: 10,
        childSessionId: "child-1",
      },
      {
        key: "task:task-2",
        taskId: "task-2",
        title: "Check tests",
        agentType: "verification",
        status: "completed",
        startedAt: 20,
        completedAt: 30,
      },
    ]);
  });

  it("does not expose prompt, path, preview, usage, or backend-only fields", () => {
    const activity = selectSubagentActivity(TASKS)[0];
    expect(activity).toBeDefined();
    expect(Object.keys(activity!)).toEqual([
      "key",
      "taskId",
      "title",
      "agentType",
      "status",
      "startedAt",
      "childSessionId",
    ]);
    expect(JSON.stringify(activity)).not.toContain("reading");
  });

  it("returns no speculative row when authority has no task", () => {
    expect(selectSubagentActivity([])).toEqual([]);
  });
});

describe("selectStatusTodos", () => {
  it("projects authority order without hidden backend fields or mutation", () => {
    const source = TODOS.map((item) => ({ ...item, blockedBy: [...item.blockedBy] }));
    const projected = selectStatusTodos(source);
    expect(projected).toEqual([
      { id: 1, subject: "Ship the status panel", status: "in_progress" },
      { id: 2, subject: "Write tests", status: "pending" },
    ]);
    expect(Object.keys(projected[0]!)).toEqual(["id", "subject", "status"]);
    expect(JSON.stringify(projected)).not.toContain("hidden backend description");
    expect(JSON.stringify(projected)).not.toContain("Shipping");
    expect(JSON.stringify(projected)).not.toContain("runtime");
    source[0]!.subject = "mutated";
    source[0]!.status = "completed";
    expect(projected[0]?.subject).toBe("Ship the status panel");
    expect(projected[0]?.status).toBe("in_progress");
  });

  it("returns no speculative row when authority has no todo", () => {
    expect(selectStatusTodos([])).toEqual([]);
  });
});

describe("selectChildStream", () => {
  const PARTIAL = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "token" }],
  };

  it("returns the child's live partial from the optional streams map", () => {
    expect(selectChildStream({
      "child-1": { partial: PARTIAL, updatedAt: 10 },
    }, "child-1")).toEqual(PARTIAL);
  });

  it("returns null when the snapshot omitted streams or the child has no slot", () => {
    expect(selectChildStream(undefined, "child-1")).toBeNull();
    expect(selectChildStream({}, "child-1")).toBeNull();
    expect(selectChildStream({ "child-other": { partial: PARTIAL } }, "child-1")).toBeNull();
    expect(selectChildStream({ "child-1": { partial: PARTIAL } }, null)).toBeNull();
  });
});
