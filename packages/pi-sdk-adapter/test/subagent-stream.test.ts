import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_SUBAGENT_TASK_ID_LENGTH } from "@fffattiger/pix-runtime-core";
import {
  isTrackedChildSessionId,
  projectSubagentStreamEvent,
} from "../src/internal/subagent-projection.js";

const child = "child-session-1";
const tasks = [{
  taskId: "task-1",
  description: "inspect",
  agentType: "explore",
  status: "running" as const,
  childSessionId: child,
}];

describe("subagent in-process stream bridge", () => {
  it("rejects unknown or malformed child ids", () => {
    assert.equal(isTrackedChildSessionId("unknown", tasks), false);
    assert.equal(isTrackedChildSessionId(" ", tasks), false);
    assert.equal(isTrackedChildSessionId("x".repeat(MAX_SUBAGENT_TASK_ID_LENGTH + 1), tasks), false);
    assert.equal(projectSubagentStreamEvent({
      childSessionId: "unknown",
      event: { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "x" }] } },
      tasks,
      sessionId: "parent",
    }), undefined);
  });

  it("projects accumulated partials and assistant terminals, ignoring other roles", () => {
    const update = projectSubagentStreamEvent({
      childSessionId: child,
      event: { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Hel" }] } },
      tasks,
      sessionId: "parent",
    });
    assert.equal(update?.type, "subagent_delta");
    assert.equal(update?.done, false);
    assert.equal(update?.childSessionId, child);
    assert.equal((update?.partial as { content?: { text?: string }[] }).content?.[0]?.text, "Hel");

    const replaced = projectSubagentStreamEvent({
      childSessionId: child,
      event: { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Hello" }] } },
      tasks,
      sessionId: "parent",
    });
    assert.equal((replaced?.partial as { content?: { text?: string }[] }).content?.[0]?.text, "Hello");

    const done = projectSubagentStreamEvent({
      childSessionId: child,
      event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hello" }], model: "m", provider: "p" } },
      tasks,
      sessionId: "parent",
    });
    assert.equal(done?.done, true);

    assert.equal(projectSubagentStreamEvent({
      childSessionId: child,
      event: { type: "message_end", message: { role: "user", content: "hi" } },
      tasks,
      sessionId: "parent",
    }), undefined);
  });

  it("unregisters the global bridge and drops late callbacks after dispose", () => {
    type Bridge = (childSessionId: string, event: unknown) => void;
    const holder = globalThis as { __pixSubagentStream?: Bridge };
    let generation = 0;
    const closed = { value: false };
    const emitted: unknown[] = [];
    const install = () => {
      const current = ++generation;
      holder.__pixSubagentStream = (childSessionId, event) => {
        if (closed.value || current !== generation) return;
        const projected = projectSubagentStreamEvent({ childSessionId, event, tasks, sessionId: "parent" });
        if (projected) emitted.push(projected);
      };
    };
    const uninstall = () => {
      generation += 1;
      delete holder.__pixSubagentStream;
    };
    install();
    holder.__pixSubagentStream?.(child, { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "live" }] } });
    assert.equal(emitted.length, 1);
    const stale = holder.__pixSubagentStream!;
    uninstall();
    closed.value = true;
    stale(child, { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "late" }] } });
    assert.equal(emitted.length, 1);
    assert.equal(holder.__pixSubagentStream, undefined);
  });
});
