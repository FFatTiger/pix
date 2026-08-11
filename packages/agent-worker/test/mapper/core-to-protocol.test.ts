import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AgentMessageSchema,
  RuntimeEventDataSchema,
  RuntimeSnapshotSchema,
  RuntimeStateSchema,
  StreamingAgentMessageSchema,
} from "@fffattiger/pix-protocol";
import type { AgentMessage, RuntimeSnapshot, StreamingAgentMessage } from "@fffattiger/pix-runtime-core";
import { createCapabilitySet } from "@fffattiger/pix-runtime-core";
import { mapAgentMessage, mapRuntimeState, mapStreamingMessage } from "../../src/mapper/core-to-protocol.js";
import { SnapshotMapper } from "../../src/mapper/snapshot-mapper.js";
import { StatefulRuntimeMapper } from "../../src/mapper/runtime-mapper.js";

describe("core-to-protocol DTO mapping", () => {
  it("maps a complete assistant message and passes the protocol schema", () => {
    const message: AgentMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "hello" },
        { type: "toolCall", toolCallId: "t1", toolName: "bash", input: { cmd: "ls" } },
        { type: "image", source: { type: "url", url: "https://example.com/x.png" } },
      ],
      model: "m",
      provider: "p",
      stopReason: "done",
      timestamp: 123,
    };
    const mapped = mapAgentMessage(message);
    const parsed = AgentMessageSchema.safeParse(mapped);
    assert.equal(parsed.success, true, parsed.success ? "" : parsed.error.message);
    assert.equal(mapped.role, "assistant");
    assert.equal((mapped as { content: unknown[] }).content.length, 3);
  });

  it("maps a streaming assistant partial and passes the schema", () => {
    const partial: StreamingAgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: "partial" }],
      model: "m",
    };
    const mapped = mapStreamingMessage(partial);
    const parsed = StreamingAgentMessageSchema.safeParse(mapped);
    assert.equal(parsed.success, true, parsed.success ? "" : parsed.error.message);
  });

  it("maps runtime state and passes the schema", () => {
    const state = {
      sessionId: "s1",
      isStreaming: true,
      isPromptRunning: true,
      isBashRunning: false,
      isCompacting: false,
      model: { id: "gpt-4o", provider: "openai" },
      messageCount: 2,
      pendingMessageCount: 1,
      queuedMessages: { steering: [], followUp: [{ message: "next" }] },
      contextUsage: { percent: 10 },
    } as const;
    const mapped = mapRuntimeState(state);
    const parsed = RuntimeStateSchema.safeParse(mapped);
    assert.equal(parsed.success, true, parsed.success ? "" : parsed.error.message);
  });
});

describe("snapshot-mapper", () => {
  it("injects cwd/projectRoot, maps state/capabilities/messages, and passes the schema", () => {
    const coreSnapshot: RuntimeSnapshot = {
      sessionId: "s1",
      state: {
        sessionId: "s1",
        isStreaming: false,
        isPromptRunning: false,
        isBashRunning: false,
        isCompacting: false,
        model: null,
        messageCount: 1,
      },
      capabilities: createCapabilitySet(["runtime.prompt", "runtime.abort"]),
      messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }], model: "m", provider: "p" }],
    };
    const mapper = new SnapshotMapper(new StatefulRuntimeMapper());
    const mapped = mapper.map(coreSnapshot, { cwd: "/w", projectRoot: "/w" });
    const parsed = RuntimeSnapshotSchema.safeParse(mapped);
    assert.equal(parsed.success, true, parsed.success ? "" : parsed.error.message);
    assert.equal(mapped.cwd, "/w");
    assert.equal(mapped.projectRoot, "/w");
    assert.equal(mapped.sessionId, "s1");
  });

  it("coordinates streaming ids with the live stateful mapper", () => {
    const runtimeMapper = new StatefulRuntimeMapper();
    const snapshotMapper = new SnapshotMapper(runtimeMapper);
    // Activate a stream through the mapper first.
    const start = runtimeMapper.mapEvent({
      type: "message_update",
      sessionId: "s1",
      message: { role: "assistant", content: [{ type: "text", text: "abc" }] },
    });
    assert.equal(start[0]?.type, "message_start");
    const streamId = start[0]!.streamId;

    const coreSnapshot: RuntimeSnapshot = {
      sessionId: "s1",
      state: {
        sessionId: "s1",
        isStreaming: true,
        isPromptRunning: true,
        isBashRunning: false,
        isCompacting: false,
        model: null,
        messageCount: 0,
      },
      capabilities: createCapabilitySet([]),
      streaming: {
        active: true,
        partialMessage: { role: "assistant", content: [{ type: "text", text: "abc" }] },
        phase: "streaming",
      },
    };
    const mapped = snapshotMapper.map(coreSnapshot, { cwd: "/w", projectRoot: "/w" });
    const parsed = RuntimeSnapshotSchema.safeParse(mapped);
    assert.equal(parsed.success, true, parsed.success ? "" : parsed.error.message);
    assert.equal(mapped.streaming?.streamId, streamId);
    assert.equal(mapped.streaming?.active, true);
  });

  it("active bash emits a bash phase without a message stream", () => {
    const runtimeMapper = new StatefulRuntimeMapper();
    const snapshotMapper = new SnapshotMapper(runtimeMapper);
    const coreSnapshot: RuntimeSnapshot = {
      sessionId: "s1",
      state: {
        sessionId: "s1",
        isStreaming: false,
        isPromptRunning: false,
        isBashRunning: true,
        isCompacting: false,
        model: null,
        messageCount: 0,
        bash: {
          command: "ls",
          output: "a",
          excludeFromContext: false,
          truncated: false,
          cancelled: false,
          completed: false,
          updateCount: 1,
        },
      },
      capabilities: createCapabilitySet([]),
    };
    const mapped = snapshotMapper.map(coreSnapshot, { cwd: "/w", projectRoot: "/w" });
    const parsed = RuntimeSnapshotSchema.safeParse(mapped);
    assert.equal(parsed.success, true, parsed.success ? "" : parsed.error.message);
    assert.equal(mapped.streaming?.active, true);
    assert.equal(mapped.streaming?.phase, "bash");
  });

  it("mapped snapshot never carries epoch/eventId", () => {
    const runtimeMapper = new StatefulRuntimeMapper();
    const snapshotMapper = new SnapshotMapper(runtimeMapper);
    const coreSnapshot: RuntimeSnapshot = {
      sessionId: "s1",
      state: { sessionId: "s1", isStreaming: false, isPromptRunning: false, isBashRunning: false, isCompacting: false, model: null, messageCount: 0 },
      capabilities: createCapabilitySet([]),
    };
    const mapped = snapshotMapper.map(coreSnapshot, { cwd: "/w", projectRoot: "/w" });
    assert.equal("epoch" in mapped, false);
    assert.equal("lastEventId" in mapped, false);
    assert.equal("eventId" in mapped, false);
  });
});

describe("event mapping schema validity", () => {
  it("maps every Core event family to schema-valid protocol data", () => {
    const mapper = new StatefulRuntimeMapper();
    const sessionId = "s1";
    const events = [
      { type: "agent_start" },
      { type: "agent_end" },
      { type: "agent_settled" },
      { type: "prompt_done" },
      { type: "prompt_error", errorMessage: "boom", error: { code: "external", message: "boom", retryable: false } },
      { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "x" }] } },
      { type: "tool_execution_start", toolCallId: "t1", toolName: "ls" },
      { type: "tool_execution_update", toolCallId: "t1", partialResult: "r" },
      { type: "tool_execution_end", toolCallId: "t1", result: "ok", writtenFiles: ["/w/a.txt"] },
      { type: "queue_update", followUp: [{ message: "q" }] },
      { type: "auto_retry_start", attempt: 1, maxAttempts: 2 },
      { type: "auto_retry_end", success: true },
      { type: "compaction_start" },
      { type: "compaction_end", result: "r" },
      { type: "auto_compaction_start" },
      { type: "auto_compaction_end" },
      { type: "bash_update", command: "ls", output: "delta" },
      { type: "extension_error", error: "ext failed" },
      { type: "extension_statuses", statuses: [{ key: "k", text: "t" }] },
      { type: "extension_widgets", widgets: [{ key: "k", lines: ["l"], placement: "aboveEditor" }] },
      { type: "session_title", name: "n" },
      { type: "runtime_state_changed" },
      { type: "runtime_capabilities_changed", capabilities: { capabilities: ["runtime.prompt"], version: 1 } },
      { type: "runtime_error", error: { code: "internal", message: "x", retryable: false } },
      { type: "runtime_closed", reason: "shutdown" },
    ] as const;
    for (const event of events) {
      const mapped = mapper.mapEvent({ ...event, sessionId } as never);
      assert.ok(mapped.length >= 0);
      for (const data of mapped) {
        const parsed = RuntimeEventDataSchema.safeParse(data);
        assert.equal(parsed.success, true, `event ${event.type}: ${parsed.success ? "" : parsed.error.message}`);
      }
    }
  });
});
