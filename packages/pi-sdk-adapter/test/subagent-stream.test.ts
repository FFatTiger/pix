import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { MAX_SUBAGENT_TASK_ID_LENGTH } from "@fffattiger/pix-runtime-core";
import {
  isTrackedChildSessionId,
  projectSubagentStreamEvent,
} from "../src/internal/subagent-projection.js";
import { subscribeSubagentChildEvents, type SubagentChildEventPayload } from "../src/internal/sdk-runtime.js";

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

  it("subscribes to the plugin's child-event channel, drops malformed payloads, and detaches on uninstall", () => {
    const bus = createEventBus();
    const received: SubagentChildEventPayload[] = [];
    // Driver-style stale guard: the subscription generation captures install-time
    // state; uninstall bumps it so a late callback can never settle a new cycle.
    let generation = 0;
    const unsubscribe = subscribeSubagentChildEvents({
      events: bus,
      onEvent: payload => {
        if (generation !== 0) return;
        received.push(payload);
      },
    });
    bus.emit("pi-claude-subagents:child-event", {
      childSessionId: child,
      taskId: "task-1",
      event: { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "live" }] } },
    });
    assert.equal(received.length, 1);
    assert.equal(received[0]!.childSessionId, child);
    assert.equal(received[0]!.taskId, "task-1");

    // Malformed payloads and foreign channels are dropped fail-closed.
    bus.emit("pi-claude-subagents:child-event", { childSessionId: 42, taskId: "task-1", event: null });
    bus.emit("pi-claude-subagents:child-event", { childSessionId: child });
    bus.emit("pi-claude-subagents:child-event", "not-a-payload");
    bus.emit("other-channel", { childSessionId: child, taskId: "task-1" });
    assert.equal(received.length, 1);

    // Uninstall bumps the generation and detaches: no late delivery, and a
    // callback captured before the bump is refused by the stale guard.
    generation += 1;
    unsubscribe();
    bus.emit("pi-claude-subagents:child-event", { childSessionId: child, taskId: "task-1", event: { type: "message_update" } });
    assert.equal(received.length, 1);
  });

  it("a throwing listener never breaks the bus contract (forwarding is best-effort)", () => {
    const bus = createEventBus();
    const unsubscribe = subscribeSubagentChildEvents({
      events: bus,
      onEvent: () => {
        throw new Error("listener exploded");
      },
    });
    assert.doesNotThrow(() => {
      bus.emit("pi-claude-subagents:child-event", { childSessionId: child, taskId: "task-1", event: { type: "message_update" } });
    });
    unsubscribe();
  });

  it("the vendored plugin publishes the exact channel the adapter subscribes to", () => {
    // Wire-contract guard: pi-claude-subagents is a pi package without a Node
    // module entry, so the channel literal in the adapter is the contract with
    // the bundled copy. Fail closed if a plugin upgrade ever drifts the channel.
    const requireFromTest = createRequire(import.meta.url);
    const manifestPath = requireFromTest.resolve("pi-claude-subagents/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string };
    assert.match(manifest.version, /^0\./, "vendored pi-claude-subagents must stay on the 0.x line");
    const runtimeSource = readFileSync(join(dirname(manifestPath), "src", "runtime.ts"), "utf8");
    assert.match(
      runtimeSource,
      /SUBAGENT_CHILD_EVENT_CHANNEL\s*=\s*["']pi-claude-subagents:child-event["']/,
      "bundled plugin channel drifted from the adapter subscription",
    );
  });
});
