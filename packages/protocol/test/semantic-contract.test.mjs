import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AuthProviderInfoSchema,
  EventIdSchema,
  LastEventIdSchema,
  RUNTIME_COMMAND_CAPABILITY_MATRIX,
  RUNTIME_INTERRUPT_CAPABILITY_MATRIX,
  RuntimeEventDataSchema,
  RuntimeEventSchema,
  RuntimeInterruptResultSchema,
  RuntimeSnapshotSchema,
  SessionHeaderSchema,
  SessiondRpcRequestSchema,
  SessiondRpcResponseSchema,
  SessiondToWorkerMessageSchema,
  WorkerToSessiondPushSchema,
  WsHostMessageSchema,
  safeParseSessiondRpcResponse,
} from "../dist/index.js";

const error = (code = "unavailable") => ({ code, message: code, retryable: false });
const state = {
  sessionId: "s-1",
  isStreaming: false,
  isPromptRunning: false,
  isBashRunning: false,
  isCompacting: false,
  model: null,
  messageCount: 0,
};
const snapshot = {
  sessionId: "s-1",
  cwd: "/p",
  projectRoot: "/p",
  state,
  capabilities: { capabilities: ["runtime.prompt", "runtime.abort"], version: 3 },
};

describe("method-bound RPC response envelopes", () => {
  it("accepts the result only for its matching method", () => {
    const createResult = { sessionId: "s-1", epoch: "e-1", created: true, cwd: "/p", projectRoot: "/p" };
    assert.equal(SessiondRpcResponseSchema.safeParse({ id: "1", ok: true, method: "runtime.create", result: createResult }).success, true);
    assert.equal(SessiondRpcResponseSchema.safeParse({ id: "1", ok: true, method: "runtime.stop", result: createResult }).success, false);
    assert.equal(SessiondRpcResponseSchema.safeParse({ id: "1", ok: true, method: "runtime.attach", result: { sessionId: "s-1", stopped: true } }).success, false);
  });

  it("binds failures to a known method and rejects mixed result/error shapes", () => {
    assert.equal(safeParseSessiondRpcResponse({ id: "1", ok: false, method: "runtime.attach", error: error("not_found") }).success, true);
    assert.equal(safeParseSessiondRpcResponse({ id: "1", ok: false, method: "unknown", error: error() }).success, false);
    assert.equal(safeParseSessiondRpcResponse({ id: "1", ok: true, method: "system.ping", result: { pong: true }, error: error() }).success, false);
    assert.equal(safeParseSessiondRpcResponse({ id: "1", ok: false, method: "system.ping", error: error(), result: { pong: true } }).success, false);
  });

  it("rejects command result type/payload mismatch", () => {
    const envelope = (result) => ({ id: "1", ok: true, method: "runtime.command", result: { commandId: "c-1", result } });
    assert.equal(SessiondRpcResponseSchema.safeParse(envelope({ ok: true, type: "fork", forkedSessionId: "s-2", forkPointEntryId: "entry-1" })).success, true);
    assert.equal(SessiondRpcResponseSchema.safeParse(envelope({ ok: true, type: "fork" })).success, false);
    assert.equal(SessiondRpcResponseSchema.safeParse(envelope({ ok: false, type: "abort", error: error("unsupported_capability") })).success, true);
  });
});

describe("independent interrupt wire path", () => {
  for (const type of ["abort", "abort_compaction", "abort_bash", "clear_queue"]) {
    it(`round-trips ${type} through sessiond and worker envelopes`, () => {
      const request = {
        protocolVersion: 1,
        id: `rpc-${type}`,
        method: "runtime.interrupt",
        params: { sessionId: "s-1", interrupt: { type } },
      };
      assert.equal(SessiondRpcRequestSchema.safeParse(request).success, true);
      assert.equal(SessiondToWorkerMessageSchema.safeParse({
        type: "worker.interrupt",
        id: `worker-${type}`,
        protocolVersion: 1,
        payload: request.params,
      }).success, true);
      const result = { ok: false, type, error: error("unsupported_capability") };
      assert.equal(RuntimeInterruptResultSchema.safeParse(result).success, true);
      assert.equal(WorkerToSessiondPushSchema.safeParse({
        type: "worker.interruptResult",
        id: `worker-${type}`,
        payload: { sessionId: "s-1", result },
      }).success, true);
      assert.equal(SessiondRpcResponseSchema.safeParse({ id: `rpc-${type}`, ok: true, method: "runtime.interrupt", result }).success, true);
    });
  }

  it("rejects interrupt result type and error-shape mismatches", () => {
    assert.equal(RuntimeInterruptResultSchema.safeParse({ ok: true, type: "abort", error: error() }).success, false);
    assert.equal(RuntimeInterruptResultSchema.safeParse({ ok: false, type: "abort", error: { code: "unavailable", message: "closed" } }).success, false);
    assert.equal(RuntimeInterruptResultSchema.safeParse({ ok: true, type: "prompt" }).success, false);
  });
});

describe("ACL0 semantic fixtures remain protocol-local", () => {
  it("keeps exhaustive command and interrupt capability matrices", () => {
    assert.equal(Object.keys(RUNTIME_COMMAND_CAPABILITY_MATRIX).length, 26);
    assert.deepEqual(RUNTIME_INTERRUPT_CAPABILITY_MATRIX, {
      abort: "runtime.abort",
      abort_compaction: "runtime.compact.abort",
      abort_bash: "runtime.bash.abort",
      clear_queue: "runtime.queue",
    });
  });

  it("preserves queued images, active bash/compaction and partial streaming", () => {
    const queuedMessages = {
      steering: [{ message: "redirect", images: [{ type: "image", data: "AA==", mimeType: "image/png" }] }],
      followUp: [{ message: "then continue" }],
    };
    const commonState = {
      ...state,
      queuedMessages,
      thinkingLevel: "high",
      thinkingLevelPinned: true,
      writtenFiles: ["/p/a.ts"],
    };
    const streaming = RuntimeSnapshotSchema.parse({
      ...snapshot,
      state: { ...commonState, isStreaming: true, isPromptRunning: true },
      streaming: {
        active: true,
        streamId: "stream-1",
        messageId: "message-1",
        phase: "streaming",
        partialMessage: { role: "assistant", content: [{ type: "text", text: "par" }], writtenFiles: [] },
      },
    });
    const bash = RuntimeSnapshotSchema.parse({
      ...snapshot,
      state: {
        ...commonState,
        isBashRunning: true,
        bash: { command: "npm test", output: "running", excludeFromContext: false, truncated: false, cancelled: false, completed: false, updateCount: 2 },
      },
      streaming: { active: true, phase: "bash" },
    });
    const compacting = RuntimeSnapshotSchema.parse({
      ...snapshot,
      state: {
        ...commonState,
        isCompacting: true,
        compaction: { reason: "manual", status: "aborting", customInstructions: "keep decisions", startedAt: 42 },
      },
      streaming: { active: true, phase: "compacting" },
    });
    assert.equal(streaming.state.queuedMessages?.steering[0]?.images?.[0]?.mimeType, "image/png");
    assert.equal(bash.state.bash?.updateCount, 2);
    assert.equal(compacting.state.compaction?.status, "aborting");
  });

  it("uses auth methods[] and stable session entry metadata", () => {
    const provider = AuthProviderInfoSchema.parse({ id: "openai", methods: ["apiKey", "oauth"] });
    assert.deepEqual(provider.methods, ["apiKey", "oauth"]);
    const header = SessionHeaderSchema.parse({
      sessionId: "s-2", cwd: "/p", projectRoot: "/p", parentSessionId: "s-1", forkPointEntryId: "entry-4",
    });
    assert.equal(header.forkPointEntryId, "entry-4");
  });
});

describe("event vocabulary and cursor ownership", () => {
  const samples = {
    agent_start: {}, agent_end: {}, agent_settled: {}, prompt_done: {},
    prompt_error: { errorMessage: "x" },
    message_start: { streamId: "stream-1", messageId: "message-1", message: { role: "assistant", content: [{ type: "text", text: "x" }] } },
    message_update: { streamId: "stream-1", messageId: "message-1", delta: { role: "assistant", delta: { type: "text", text: "x" } } },
    message_end: { streamId: "stream-1", messageId: "message-1", message: { role: "assistant", content: [], model: "m", provider: "p" } },
    tool_execution_start: { toolCallId: "t", toolName: "bash" },
    tool_execution_update: { toolCallId: "t" },
    tool_execution_end: { toolCallId: "t", writtenFiles: ["/p/a"] },
    queue_update: { followUp: [{ message: "later" }] },
    retry_start: { attempt: 1, maxAttempts: 3 }, retry_end: { success: true },
    auto_retry_start: { attempt: 1, maxAttempts: 3 }, auto_retry_end: { success: true },
    compaction_start: { reason: "manual" }, compaction_end: { aborted: false },
    auto_compaction_start: {}, auto_compaction_end: {}, bash_update: { command: "pwd", output: "/p" },
    extension_error: { error: "bad" },
    extension_ui_request: { request: { id: "ui", method: "confirm", title: "Sure?", message: "Continue?" } },
    extension_statuses: { statuses: [] }, extension_widgets: { widgets: [] }, session_title: { name: "Title" },
    runtime_state_changed: {}, runtime_capabilities_changed: { capabilities: { capabilities: [], version: 2 } },
    runtime_closed: { reason: "shutdown" }, session_changed: { cwd: "/p", leafId: "entry" },
    worker_crashed: { error: error("internal") }, running_sessions_changed: { sessionIds: ["s-1"] },
    runtime_unavailable: { error: error() }, runtime_error: { error: error("internal") },
  };

  for (const [type, payload] of Object.entries(samples)) {
    it(`round-trips ${type} as worker data and cursor-bearing event`, () => {
      const data = { type, sessionId: "s-1", ...payload };
      assert.equal(RuntimeEventDataSchema.safeParse(data).success, true);
      assert.equal(RuntimeEventSchema.safeParse({ ...data, epoch: "e-1", eventId: 1 }).success, true);
    });
  }

  it("rejects unsafe, fractional and zero event cursors everywhere", () => {
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      assert.equal(EventIdSchema.safeParse(value).success, false, String(value));
    }
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      assert.equal(LastEventIdSchema.safeParse(value).success, false, String(value));
    }
    assert.equal(LastEventIdSchema.safeParse(0).success, true);
  });
});

describe("strict response and UI correlation", () => {
  it("rejects success/failure mixing in WS response", () => {
    const result = { commandId: "c", result: { ok: true, type: "abort" } };
    assert.equal(WsHostMessageSchema.safeParse({ type: "response", id: "1", payload: { ok: true, result } }).success, true);
    assert.equal(WsHostMessageSchema.safeParse({ type: "response", id: "1", payload: { ok: true, result, error: error() } }).success, false);
    assert.equal(WsHostMessageSchema.safeParse({ type: "response", id: "1", payload: { ok: false, error: error(), result } }).success, false);
  });

  it("requires extension response correlation ids and exclusive variants", async () => {
    const { RuntimeCommandSchema } = await import("../dist/index.js");
    assert.equal(RuntimeCommandSchema.safeParse({ type: "extension_ui_response", commandId: "c", id: "ui", method: "confirm", responseKind: "confirmed", confirmed: false }).success, true);
    assert.equal(RuntimeCommandSchema.safeParse({ type: "extension_ui_input", commandId: "c", id: "ui", method: "input", data: "x" }).success, true);
    assert.equal(RuntimeCommandSchema.safeParse({ type: "extension_ui_response", commandId: "c", method: "confirm", responseKind: "confirmed", confirmed: true }).success, false);
    assert.equal(RuntimeCommandSchema.safeParse({ type: "extension_ui_response", commandId: "c", id: "ui", method: "confirm", responseKind: "value", value: "x" }).success, false);
  });
});
