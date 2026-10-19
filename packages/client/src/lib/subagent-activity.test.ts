import { describe, expect, it } from "vitest";
import type { SubagentTask, TodoItem } from "@fffattiger/pix-protocol";
import { ASSISTANT_NOTIFY_MESSAGE_PREFIX, ASSISTANT_SENT_MESSAGE_PREFIX } from "@/lib/assistant-message";
import {
  selectChildStream,
  selectStatusTodos,
  selectSubagentActivity,
  selectTurnActivities,
  selectTurnStartedAt,
  shouldShowTodos,
  type SubagentActivity,
} from "./subagent-activity";

const TASKS: readonly SubagentTask[] = [
  {
    taskId: "task-1",
    name: "runtime-audit",
    description: "Inspect runtime",
    agentType: "Explore",
    model: "anthropic/claude-sonnet-4",
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
        model: "anthropic/claude-sonnet-4",
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
      "model",
      "status",
      "startedAt",
      "childSessionId",
    ]);
    expect(JSON.stringify(activity)).not.toContain("reading");
  });

  it("omits model when the authority task has none", () => {
    const [withoutModel] = selectSubagentActivity([TASKS[1]!]);
    expect(withoutModel).toBeDefined();
    expect(withoutModel).not.toHaveProperty("model");
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

const AGENT: SubagentActivity = {
  key: "task:agent",
  taskId: "agent",
  title: "Inspect runtime",
  agentType: "Explore",
  status: "completed",
};

describe("selectTurnStartedAt", () => {
  it("takes the timestamp of the newest user-authored message", () => {
    const messages = [
      { role: "user", content: "first", timestamp: 100 },
      { role: "assistant", content: [], timestamp: 200 },
      { role: "user", content: "second", timestamp: 300 },
      { role: "assistant", content: [], timestamp: 400 },
    ];
    expect(selectTurnStartedAt(messages)).toBe(300);
  });

  it("reads text blocks of a structured user message", () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "typed" }], timestamp: 42 }];
    expect(selectTurnStartedAt(messages)).toBe(42);
  });

  it("ignores Pixie's work notice and the messages Pixie sent for the user", () => {
    const messages = [
      { role: "user", content: "typed", timestamp: 100 },
      { role: "user", content: `${ASSISTANT_NOTIFY_MESSAGE_PREFIX}\n\n会话完成`, timestamp: 200 },
      { role: "user", content: `${ASSISTANT_SENT_MESSAGE_PREFIX}\n\n转发`, timestamp: 300 },
    ];
    expect(selectTurnStartedAt(messages)).toBe(100);
  });

  it("returns null when no dated user message exists", () => {
    expect(selectTurnStartedAt([])).toEqual(null);
    expect(selectTurnStartedAt([{ role: "assistant", content: [], timestamp: 10 }])).toEqual(null);
    expect(selectTurnStartedAt([{ role: "user", content: "typed" }])).toEqual(null);
    expect(selectTurnStartedAt([{ role: "user", content: "typed", timestamp: Number.NaN }])).toEqual(null);
  });
});

describe("selectTurnActivities", () => {
  const running: SubagentActivity = { ...AGENT, key: "task:running", taskId: "running", status: "running" };
  const endedThisTurn: SubagentActivity = { ...AGENT, key: "task:now", taskId: "now", completedAt: 500 };
  const endedBefore: SubagentActivity = { ...AGENT, key: "task:old", taskId: "old", completedAt: 100 };
  const endedNoTimestamp: SubagentActivity = { ...AGENT, key: "task:none", taskId: "none" };

  it("keeps running agents and the ones that ended in this turn", () => {
    expect(selectTurnActivities([running, endedThisTurn, endedBefore, endedNoTimestamp], 200))
      .toEqual([running, endedThisTurn]);
  });

  it("keeps an agent that ended exactly when the turn started", () => {
    expect(selectTurnActivities([{ ...AGENT, completedAt: 200 }], 200)).toHaveLength(1);
  });

  it("keeps everything when the turn start is unknown", () => {
    const all = [running, endedThisTurn, endedBefore, endedNoTimestamp];
    expect(selectTurnActivities(all, null)).toEqual(all);
  });

  it("does not mutate its input", () => {
    const input = [running, endedBefore];
    selectTurnActivities(input, 200);
    expect(input).toEqual([running, endedBefore]);
  });
});

describe("shouldShowTodos", () => {
  const done = [{ id: 1, subject: "Draft", status: "completed" as const }];
  const unfinished = [...done, { id: 2, subject: "Ship", status: "in_progress" as const }];

  it("hides a fully completed list once the turn is over", () => {
    expect(shouldShowTodos(done, false)).toBe(false);
  });

  it("keeps a fully completed list while the turn still runs", () => {
    expect(shouldShowTodos(done, true)).toBe(true);
  });

  it("keeps an unfinished list either way", () => {
    expect(shouldShowTodos(unfinished, false)).toBe(true);
    expect(shouldShowTodos(unfinished, true)).toBe(true);
  });

  it("shows nothing for an empty list", () => {
    expect(shouldShowTodos([], true)).toBe(false);
    expect(shouldShowTodos([], false)).toBe(false);
  });
});
