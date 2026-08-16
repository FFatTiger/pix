import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StreamingMessageLifecycleSchema, RuntimeEventDataSchema } from "@fffattiger/pix-protocol";
import type { RuntimeEventData } from "@fffattiger/pix-protocol";
import type { AgentMessage, AssistantContentBlock, RuntimeEvent, StreamingAgentMessage } from "@fffattiger/pix-runtime-core";
import { StatefulRuntimeMapper } from "../../src/mapper/runtime-mapper.js";
import { createOracle, textOf, toolCallsOf, type StreamLike } from "../helpers/projection-oracle.js";

const SESSION = "sess-1";

function assistant(blocks: readonly AssistantContentBlock[]): StreamingAgentMessage {
  return { role: "assistant", content: blocks };
}

describe("StatefulRuntimeMapper + sessiond projection oracle", () => {
  it("projects a growing assistant partial into deltas the oracle reconstructs textually", () => {
    const mapper = new StatefulRuntimeMapper();
    const oracle = createOracle(SESSION);
    const events: RuntimeEventData[] = [];

    const p0 = assistant([{ type: "thinking", thinking: "Let me " }]);
    const p1 = assistant([{ type: "thinking", thinking: "Let me plan" }, { type: "text", text: "The answer is " }]);
    const p2 = assistant([{ type: "thinking", thinking: "Let me plan" }, { type: "text", text: "The answer is 42" }]);

    const e0 = mapper.mapEvent({ type: "message_update", sessionId: SESSION, message: p0 });
    assert.equal(e0.length, 1);
    assert.equal(e0[0]?.type, "message_start");
    const streamId = e0[0]!.streamId;
    const messageId = e0[0]!.messageId;
    events.push(...e0);
    for (const event of e0) oracle.apply(event);
    assert.equal(textOf(oracle.snapshot().streaming!.partialMessage!), "Let me ");

    const e1 = mapper.mapEvent({ type: "message_update", sessionId: SESSION, message: p1 });
    assert.ok(e1.every((event) => event.type === "message_update"));
    assert.ok(e1.every((event) => event.type === "message_update" && event.streamId === streamId && event.messageId === messageId));
    events.push(...e1);
    for (const event of e1) oracle.apply(event);
    assert.equal(textOf(oracle.snapshot().streaming!.partialMessage!), "Let me planThe answer is ");

    const e2 = mapper.mapEvent({ type: "message_update", sessionId: SESSION, message: p2 });
    assert.equal(e2.length, 1);
    events.push(...e2);
    for (const event of e2) oracle.apply(event);
    assert.equal(textOf(oracle.snapshot().streaming!.partialMessage!), "Let me planThe answer is 42");

    const complete: AgentMessage = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Let me plan" }, { type: "text", text: "The answer is 42" }],
      model: "m1",
      provider: "p1",
    };
    const end = mapper.mapEvent({ type: "message_end", sessionId: SESSION, message: complete, entryId: "entry-1" });
    assert.equal(end.length, 1);
    assert.equal(end[0]?.type, "message_end");
    events.push(...end);
    for (const event of end) oracle.apply(event);

    const snapshot = oracle.snapshot();
    assert.equal(snapshot.streaming!.active, false);
    // Protocol v2: message_end advances the authoritative leaf/count; it never
    // appends transcript history onto the snapshot.
    assert.equal(snapshot.state.messageCount, 1);
    assert.equal(snapshot.state.leafId, "entry-1");
    assert.equal("messages" in snapshot, false);

    // The full lifecycle must satisfy the frozen StreamingMessageLifecycleSchema.
    const lifecycle = StreamingMessageLifecycleSchema.safeParse(events);
    assert.equal(lifecycle.success, true, lifecycle.success ? "" : lifecycle.error.message);
  });

  it("role switch opens a fresh stream without fabricating a message_end", () => {
    const mapper = new StatefulRuntimeMapper();
    const oracle = createOracle(SESSION);
    const assistantStream = mapper.mapEvent({
      type: "message_update",
      sessionId: SESSION,
      message: assistant([{ type: "text", text: "hi" }]),
    });
    assert.equal(assistantStream[0]?.type, "message_start");
    for (const event of assistantStream) oracle.apply(event);

    const userUpdate = mapper.mapEvent({
      type: "message_update",
      sessionId: SESSION,
      message: { role: "user", content: "next" },
    });
    // Role switch → exactly one new message_start (no fabricated message_end).
    assert.equal(userUpdate.length, 1);
    assert.equal(userUpdate[0]?.type, "message_start");
    assert.notEqual(userUpdate[0]!.streamId, assistantStream[0]!.streamId);
    for (const event of userUpdate) oracle.apply(event);
    const partial = oracle.snapshot().streaming!.partialMessage!;
    assert.equal(partial.role, "user");
    assert.equal(textOf(partial), "next");
  });

  it("non-prefix mutation restarts: fresh message_start replaces the stale partial in the oracle", () => {
    const mapper = new StatefulRuntimeMapper();
    const oracle = createOracle(SESSION);
    for (const event of mapper.mapEvent({ type: "message_update", sessionId: SESSION, message: assistant([{ type: "text", text: "abc" }]) })) {
      oracle.apply(event);
    }
    const restart = mapper.mapEvent({ type: "message_update", sessionId: SESSION, message: assistant([{ type: "text", text: "ax" }]) });
    assert.equal(restart.length, 1);
    assert.equal(restart[0]?.type, "message_start");
    for (const event of restart) oracle.apply(event);
    assert.equal(textOf(oracle.snapshot().streaming!.partialMessage!), "ax");
  });

  it("message_end without an active stream emits a defensive start+end pair", () => {
    const mapper = new StatefulRuntimeMapper();
    const events = mapper.mapEvent({
      type: "message_end",
      sessionId: SESSION,
      message: { role: "assistant", content: [{ type: "text", text: "done" }], model: "m", provider: "p" },
      entryId: "entry-1",
    });
    assert.equal(events.length, 2);
    assert.equal(events[0]?.type, "message_start");
    assert.equal(events[1]?.type, "message_end");
    const lifecycle = StreamingMessageLifecycleSchema.safeParse(events);
    assert.equal(lifecycle.success, true);
  });

  it("bash_update output is passed through unchanged as a delta (no accumulation)", () => {
    const mapper = new StatefulRuntimeMapper();
    const events = mapper.mapEvent({ type: "bash_update", sessionId: SESSION, command: "ls", output: "chunk1" });
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.type, "bash_update");
    assert.equal((event as { output?: string }).output, "chunk1");
    const second = mapper.mapEvent({ type: "bash_update", sessionId: SESSION, command: "ls", output: "chunk2", exitCode: 0 });
    assert.equal((second[0] as { output?: string }).output, "chunk2");
    // The oracle accumulates each delta onto the prior output.
    const oracle = createOracle(SESSION);
    for (const event of mapper.mapEvent({ type: "bash_update", sessionId: SESSION, command: "ls", output: "chunk1" })) oracle.apply(event);
    for (const event of mapper.mapEvent({ type: "bash_update", sessionId: SESSION, command: "ls", output: "chunk2" })) oracle.apply(event);
    assert.equal(oracle.snapshot().state.bash?.output, "chunk1chunk2");
    assert.equal(oracle.snapshot().state.bash?.updateCount, 2);
  });

  it("mapped events never carry epoch/eventId (sessiond-owned) and always satisfy the schema", () => {
    const mapper = new StatefulRuntimeMapper();
    const events: RuntimeEvent[] = [
      { type: "agent_start", sessionId: SESSION },
      { type: "message_update", sessionId: SESSION, message: assistant([{ type: "text", text: "a" }]) },
      { type: "tool_execution_start", sessionId: SESSION, toolCallId: "t1", toolName: "ls" },
      { type: "tool_execution_end", sessionId: SESSION, toolCallId: "t1", result: "ok" },
      { type: "runtime_state_changed", sessionId: SESSION },
      { type: "bash_update", sessionId: SESSION, output: "x" },
    ];
    for (const event of events) {
      for (const mapped of mapper.mapEvent(event)) {
        assert.equal("eventId" in mapped, false);
        assert.equal("epoch" in mapped, false);
        const parsed = RuntimeEventDataSchema.safeParse(mapped);
        assert.equal(parsed.success, true, parsed.success ? "" : parsed.error.message);
      }
    }
  });

  it("runtime_closed clears the active stream", () => {
    const mapper = new StatefulRuntimeMapper();
    for (const event of mapper.mapEvent({ type: "message_update", sessionId: SESSION, message: assistant([{ type: "text", text: "a" }]) })) {
      void event;
    }
    assert.notEqual(mapper.getActiveStream(), null);
    const closed = mapper.mapEvent({ type: "runtime_closed", sessionId: SESSION, reason: "shutdown" });
    assert.equal(closed[0]?.type, "runtime_closed");
    assert.equal(mapper.getActiveStream(), null);
  });

  it("toolCall correlations survive the oracle round trip", () => {
    const mapper = new StatefulRuntimeMapper();
    const oracle = createOracle(SESSION);
    const p0 = assistant([{ type: "toolCall", toolCallId: "t1", toolName: "bash", input: { cmd: "ls" } }]);
    for (const event of mapper.mapEvent({ type: "message_update", sessionId: SESSION, message: p0 })) oracle.apply(event);
    const p1 = assistant([
      { type: "toolCall", toolCallId: "t1", toolName: "bash", input: { cmd: "ls" } },
      { type: "text", text: "listed" },
    ]);
    for (const event of mapper.mapEvent({ type: "message_update", sessionId: SESSION, message: p1 })) oracle.apply(event);
    const partial = oracle.snapshot().streaming!.partialMessage!;
    assert.deepEqual(toolCallsOf(partial), [{ toolCallId: "t1", toolName: "bash" }]);
    assert.equal(textOf(partial), "listed");
  });
});
