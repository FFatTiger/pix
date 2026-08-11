import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ExtensionUiInputExchangeSchema,
  ExtensionUiRequestSchema,
  ExtensionUiResponseExchangeSchema,
  ImageAttachmentSchema,
  ImageContentSourceSchema,
  MAX_IMAGE_BASE64_LENGTH,
  RuntimeAttachParamsSchema,
  RuntimeCommandSchema,
  RuntimeEventSchema,
  RuntimeSnapshotSchema,
  SessiondRuntimeAttachResultSchema,
  SessiondPushSnapshotSchema,
  StreamingMessageLifecycleSchema,
  WsClientMessageSchema,
  WsHostMessageSchema,
  WsInterruptExchangeSchema,
  WsSnapshotMessageSchema,
} from "../dist/index.js";

const error = { code: "unavailable", message: "closed", retryable: false };
const idleState = {
  sessionId: "s-1", isStreaming: false, isPromptRunning: false,
  isBashRunning: false, isCompacting: false, model: null, messageCount: 0,
};
const fullSnapshot = {
  sessionId: "s-1", cwd: "/project", projectRoot: "/project",
  state: idleState,
  capabilities: { capabilities: [], version: 0 },
};

describe("A: cwd authority and create/attach separation", () => {
  it("accepts explicit create and existing-session attach, rejects mixed forms", () => {
    assert.equal(WsClientMessageSchema.safeParse({
      type: "create", id: "req-create", payload: { createRequestId: "create-1", cwd: "/project", projectRoot: "/project", thinkingLevel: "high", thinkingLevelPinned: true, toolNames: [] },
    }).success, true);
    assert.equal(WsClientMessageSchema.safeParse({ type: "attach", id: "req-attach", payload: { sessionId: "s-1" } }).success, true);
    assert.equal(WsClientMessageSchema.safeParse({ type: "attach", id: "req", payload: { sessionId: "s-1", createRequestId: "x", cwd: "/project" } }).success, false);
    assert.equal(WsClientMessageSchema.safeParse({ type: "create", id: "req", payload: { createRequestId: "x", cwd: "/project" } }).success, false);
  });

  it("requires epoch and lastEventId atomically", () => {
    assert.equal(RuntimeAttachParamsSchema.safeParse({ sessionId: "s" }).success, true);
    assert.equal(RuntimeAttachParamsSchema.safeParse({ sessionId: "s", epoch: "e", lastEventId: 0 }).success, true);
    assert.equal(RuntimeAttachParamsSchema.safeParse({ sessionId: "s", epoch: "e" }).success, false);
    assert.equal(RuntimeAttachParamsSchema.safeParse({ sessionId: "s", lastEventId: 0 }).success, false);
  });

  for (const resumeStatus of ["snapshot", "gap", "epoch_changed"]) {
    it(`full ${resumeStatus} snapshot restores cwd/projectRoot`, () => {
      const frame = {
        type: "snapshot",
        payload: { sessionId: "s-1", cwd: "/project", projectRoot: "/project", epoch: "e-2", lastEventId: 0, workerStatus: "ready", resumeStatus, snapshot: fullSnapshot },
      };
      assert.equal(WsHostMessageSchema.safeParse(frame).success, true);
      assert.equal(SessiondPushSnapshotSchema.safeParse({ ...frame.payload, type: "snapshot" }).success, true);
      assert.equal(WsHostMessageSchema.safeParse({ ...frame, payload: { ...frame.payload, cwd: "/other" } }).success, false);
      assert.equal(WsHostMessageSchema.safeParse({ ...frame, payload: { ...frame.payload, snapshot: { ...fullSnapshot, projectRoot: "/other" } } }).success, false);
    });
  }

  it("requires an explicit snapshot delivery reason and rejects resumed", () => {
    const payload = { sessionId: "s-1", cwd: "/project", projectRoot: "/project", epoch: "e-2", lastEventId: 0, workerStatus: "ready", snapshot: fullSnapshot };
    const attachResult = (value) => ({
      sessionId: value.sessionId,
      cwd: value.cwd,
      projectRoot: value.projectRoot,
      epoch: value.epoch,
      lastEventId: value.lastEventId,
      snapshot: value.snapshot,
      ...(value.resumeStatus === undefined ? {} : { resumeStatus: value.resumeStatus }),
    });
    assert.equal(WsSnapshotMessageSchema.safeParse({ type: "snapshot", payload }).success, false);
    assert.equal(SessiondPushSnapshotSchema.safeParse({ type: "snapshot", ...payload }).success, false);
    assert.equal(SessiondRuntimeAttachResultSchema.safeParse(attachResult(payload)).success, false);
    for (const resumeStatus of ["snapshot", "gap", "epoch_changed"]) {
      assert.equal(WsSnapshotMessageSchema.safeParse({ type: "snapshot", payload: { ...payload, resumeStatus } }).success, true, resumeStatus);
      assert.equal(SessiondPushSnapshotSchema.safeParse({ type: "snapshot", ...payload, resumeStatus }).success, true, resumeStatus);
      assert.equal(SessiondRuntimeAttachResultSchema.safeParse(attachResult({ ...payload, resumeStatus })).success, true, resumeStatus);
    }
    assert.equal(WsSnapshotMessageSchema.safeParse({ type: "snapshot", payload: { ...payload, resumeStatus: "resumed" } }).success, false);
    assert.equal(SessiondPushSnapshotSchema.safeParse({ type: "snapshot", ...payload, resumeStatus: "resumed" }).success, false);
    assert.equal(SessiondRuntimeAttachResultSchema.safeParse(attachResult({ ...payload, resumeStatus: "resumed" })).success, false);
  });
});

describe("B: streaming correlation and snapshot invariants", () => {
  it("distinguishes interleaved streams and rejects missing IDs or empty deltas", () => {
    const update = (streamId, messageId, text) => ({ type: "message_update", eventId: 1, epoch: "e", sessionId: "s-1", streamId, messageId, delta: { role: "assistant", delta: { type: "text", text } } });
    assert.equal(RuntimeEventSchema.safeParse(update("stream-a", "msg-a", "A")).success, true);
    assert.equal(RuntimeEventSchema.safeParse(update("stream-b", "msg-b", "B")).success, true);
    assert.equal(RuntimeEventSchema.safeParse({ ...update("stream-a", "msg-a", "A"), streamId: undefined }).success, false);
    assert.equal(RuntimeEventSchema.safeParse({ ...update("stream-a", "msg-a", "A"), delta: { role: "assistant" } }).success, false);
    assert.equal(RuntimeEventSchema.safeParse({ ...update("stream-a", "msg-a", "A"), delta: { role: "toolResult" } }).success, false);
    assert.equal(RuntimeEventSchema.safeParse({ ...update("stream-a", "msg-a", "A"), delta: { role: "custom" } }).success, false);
    assert.equal(RuntimeEventSchema.safeParse({ ...update("stream-a", "msg-a", "A"), delta: { role: "bashExecution" } }).success, false);
    assert.equal(StreamingMessageLifecycleSchema.safeParse([
      { type: "message_start", sessionId: "s-1", streamId: "stream-a", messageId: "msg-a", message: { role: "assistant", content: [{ type: "text", text: "A" }] } },
      { type: "message_update", sessionId: "s-1", streamId: "stream-b", messageId: "msg-a", delta: { role: "assistant", delta: { type: "text", text: "B" } } },
      { type: "message_end", sessionId: "s-1", streamId: "stream-a", messageId: "msg-a", message: { role: "assistant", content: [], model: "m", provider: "p" } },
    ]).success, false);
  });

  it("enforces exact lifecycle sequence, correlation and role", () => {
    const start = { type: "message_start", sessionId: "s-1", streamId: "stream-a", messageId: "msg-a", message: { role: "assistant", content: [{ type: "text", text: "A" }] } };
    const update = { type: "message_update", sessionId: "s-1", streamId: "stream-a", messageId: "msg-a", delta: { role: "assistant", delta: { type: "text", text: "B" } } };
    const end = { type: "message_end", sessionId: "s-1", streamId: "stream-a", messageId: "msg-a", message: { role: "assistant", content: [], model: "m", provider: "p" } };
    assert.equal(StreamingMessageLifecycleSchema.safeParse([start, update, end]).success, true);
    assert.equal(StreamingMessageLifecycleSchema.safeParse([{ ...start, streamId: "stream-b", messageId: "msg-b" }, { ...end, streamId: "stream-b", messageId: "msg-b" }]).success, true);
    assert.equal(StreamingMessageLifecycleSchema.safeParse([start, { ...update, sessionId: "s-2" }, end]).success, false);
    assert.equal(StreamingMessageLifecycleSchema.safeParse([start, { ...update, delta: { role: "bashExecution", delta: { type: "output", output: "bad" } } }, end]).success, false);
    assert.equal(StreamingMessageLifecycleSchema.safeParse([start, start, end]).success, false);
    assert.equal(StreamingMessageLifecycleSchema.safeParse([start, end, end]).success, false);
    assert.equal(StreamingMessageLifecycleSchema.safeParse([start, end, update]).success, false);
    assert.equal(StreamingMessageLifecycleSchema.safeParse([start, update]).success, false);
    assert.equal(StreamingMessageLifecycleSchema.safeParse([start, { ...end, message: { role: "bashExecution", command: "x", output: "", exitCode: 0 } }]).success, false);
  });

  it("rejects contradictory snapshot projections", () => {
    const active = {
      ...fullSnapshot,
      state: { ...idleState, isStreaming: true },
      streaming: { active: true, streamId: "stream", messageId: "msg", phase: "streaming", partialMessage: { role: "assistant", content: [{ type: "text", text: "part" }] } },
    };
    assert.equal(RuntimeSnapshotSchema.safeParse(active).success, true);
    assert.equal(RuntimeSnapshotSchema.safeParse({ ...active, state: { ...active.state, sessionId: "other" } }).success, false);
    assert.equal(RuntimeSnapshotSchema.safeParse({ ...active, streaming: { ...active.streaming, partialMessage: { role: "assistant" } } }).success, false);
    assert.equal(RuntimeSnapshotSchema.safeParse({ ...active, streaming: { active: true, phase: "streaming" } }).success, false);
    assert.equal(RuntimeSnapshotSchema.safeParse({ ...fullSnapshot, streaming: { active: false, streamId: "stale", messageId: "stale", partialMessage: { role: "assistant", content: [{ type: "text", text: "x" }] } } }).success, false);
    assert.equal(RuntimeSnapshotSchema.safeParse({ ...fullSnapshot, state: { ...idleState, isBashRunning: true } }).success, false);
    assert.equal(RuntimeSnapshotSchema.safeParse({ ...fullSnapshot, state: { ...idleState, bash: { command: "x", output: "", excludeFromContext: false, truncated: false, cancelled: false, completed: false, updateCount: 0 } } }).success, false);
    assert.equal(RuntimeSnapshotSchema.safeParse({ ...fullSnapshot, state: { ...idleState, bash: { command: "x", output: "done", excludeFromContext: false, truncated: false, cancelled: false, completed: true, exitCode: 0, updateCount: 1 } } }).success, true);
    assert.equal(RuntimeSnapshotSchema.safeParse({ ...fullSnapshot, state: { ...idleState, isCompacting: true } }).success, false);
  });
  it("enforces phase↔bash/compaction bidirectionally and accepts terminal bash", () => {
    const bash = { command: "x", output: "running", excludeFromContext: false, truncated: false, cancelled: false, completed: false, updateCount: 1 };
    const completedBash = { ...bash, output: "done", completed: true, exitCode: 0, updateCount: 2 };
    const compaction = { reason: "manual", status: "running", startedAt: 1 };
    const runningBash = { ...fullSnapshot, state: { ...idleState, isBashRunning: true, bash }, streaming: { active: true, phase: "bash" } };
    const runningCompaction = { ...fullSnapshot, state: { ...idleState, isCompacting: true, compaction }, streaming: { active: true, phase: "compacting" } };
    assert.equal(RuntimeSnapshotSchema.safeParse(runningBash).success, true);
    assert.equal(RuntimeSnapshotSchema.safeParse(runningCompaction).success, true);
    assert.equal(RuntimeSnapshotSchema.safeParse({ ...runningBash, streaming: { active: true, phase: "streaming" } }).success, false);
    assert.equal(RuntimeSnapshotSchema.safeParse({ ...fullSnapshot, streaming: { active: true, phase: "bash" } }).success, false);
    assert.equal(RuntimeSnapshotSchema.safeParse({ ...runningCompaction, streaming: { active: true, phase: "streaming" } }).success, false);
    assert.equal(RuntimeSnapshotSchema.safeParse({ ...fullSnapshot, streaming: { active: true, phase: "compacting" } }).success, false);
    assert.equal(RuntimeSnapshotSchema.safeParse({ ...runningBash, state: { ...runningBash.state, isCompacting: true, compaction } }).success, false);
    assert.equal(RuntimeSnapshotSchema.safeParse({ ...fullSnapshot, state: { ...idleState, bash: completedBash }, streaming: { active: false, phase: "idle" } }).success, true);
    assert.equal(RuntimeSnapshotSchema.safeParse({ ...fullSnapshot, state: { ...idleState, bash: { ...completedBash, cancelled: true } } }).success, true);
  });
});

describe("C: extension method/response binding", () => {
  const validRequests = [
    { id: "1", method: "select", title: "Pick", options: ["a"] },
    { id: "2", method: "confirm", title: "Sure", message: "Continue?" },
    { id: "3", method: "input", title: "Input" },
    { id: "4", method: "editor", title: "Edit" },
    { id: "5", method: "notify", message: "Done", notifyType: "info" },
    { id: "6", method: "setStatus", statusKey: "k" },
    { id: "7", method: "setWidget", widgetKey: "w" },
    { id: "8", method: "setTitle", title: "T" },
    { id: "9", method: "set_editor_text", text: "x" },
    { id: "10", method: "custom", lines: ["x"] },
  ];
  it("accepts every request method and rejects cross-method fields", () => {
    for (const request of validRequests) assert.equal(ExtensionUiRequestSchema.safeParse(request).success, true, request.method);
    assert.equal(ExtensionUiRequestSchema.safeParse({ id: "x", method: "confirm", title: "T", message: "M", options: ["bad"] }).success, false);
    assert.equal(ExtensionUiRequestSchema.safeParse({ id: "x", method: "select", title: "T", options: ["a"], confirmed: true }).success, false);
  });
  it("binds each response kind and rejects wrong method/input path", () => {
    const command = (value) => RuntimeCommandSchema.safeParse({ type: "extension_ui_response", commandId: "c", id: "ui", ...value }).success;
    assert.equal(command({ method: "select", responseKind: "selected", selected: "a" }), true);
    assert.equal(command({ method: "confirm", responseKind: "confirmed", confirmed: false }), true);
    assert.equal(command({ method: "input", responseKind: "value", value: "x" }), true);
    assert.equal(command({ method: "editor", responseKind: "cancelled", cancelled: true }), true);
    assert.equal(command({ method: "confirm", responseKind: "value", value: "x" }), false);
    assert.equal(command({ method: "select", responseKind: "confirmed", confirmed: true }), false);
    assert.equal(RuntimeCommandSchema.safeParse({ type: "extension_ui_input", commandId: "c", id: "ui", method: "confirm", data: "x" }).success, false);
    for (const method of ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]) {
      assert.equal(command({ method, responseKind: "cancelled", cancelled: true }), false, method);
      assert.equal(RuntimeCommandSchema.safeParse({ type: "extension_ui_input", commandId: "c", id: "ui", method, data: "x" }).success, false, method);
    }
  });
  it("correlates commands against the authoritative pending request", () => {
    const confirmRequest = { id: "ui-confirm", method: "confirm", title: "Sure", message: "Continue?" };
    const confirmCommand = { type: "extension_ui_response", commandId: "c-1", id: "ui-confirm", method: "confirm", responseKind: "confirmed", confirmed: true };
    assert.equal(ExtensionUiResponseExchangeSchema.safeParse({ request: confirmRequest, command: confirmCommand }).success, true);
    assert.equal(ExtensionUiResponseExchangeSchema.safeParse({ request: confirmRequest, command: { type: "extension_ui_response", commandId: "c-1", id: "ui-confirm", method: "select", responseKind: "selected", selected: "fake" } }).success, false);
    assert.equal(ExtensionUiResponseExchangeSchema.safeParse({ request: confirmRequest, command: { ...confirmCommand, id: "other" } }).success, false);

    const inputRequest = { id: "ui-input", method: "input", title: "Input" };
    const inputCommand = { type: "extension_ui_input", commandId: "c-2", id: "ui-input", method: "input", data: "x" };
    assert.equal(ExtensionUiInputExchangeSchema.safeParse({ request: inputRequest, command: inputCommand }).success, true);
    assert.equal(ExtensionUiInputExchangeSchema.safeParse({ request: { id: "ui-editor", method: "editor", title: "Edit" }, command: inputCommand }).success, false);
    for (const request of [
      { id: "ui-custom", method: "custom", lines: ["x"] },
      { id: "ui-notify", method: "notify", message: "x", notifyType: "info" },
      { id: "ui-status", method: "setStatus", statusKey: "k" },
      { id: "ui-widget", method: "setWidget", widgetKey: "w" },
      { id: "ui-title", method: "setTitle", title: "t" },
      { id: "ui-editor-text", method: "set_editor_text", text: "x" },
    ]) {
      assert.equal(ExtensionUiInputExchangeSchema.safeParse({ request, command: { ...inputCommand, id: request.id } }).success, false, request.method);
      if (request.method !== "custom") {
        assert.equal(ExtensionUiResponseExchangeSchema.safeParse({ request, command: { type: "extension_ui_response", commandId: "c", id: request.id, method: "input", responseKind: "cancelled", cancelled: true } }).success, false, request.method);
      }
    }
    assert.equal(ExtensionUiResponseExchangeSchema.safeParse({ request: { id: "ui-custom", method: "custom", lines: ["x"] }, command: { type: "extension_ui_response", commandId: "c", id: "ui-custom", method: "custom", responseKind: "value", value: "done" } }).success, true);
  });
});

describe("D: image validation", () => {
  it("accepts canonical supported images", () => {
    assert.equal(ImageAttachmentSchema.safeParse({ type: "image", data: "AA==", mimeType: "image/png" }).success, true);
    assert.equal(ImageContentSourceSchema.safeParse({ type: "url", url: "https://example.com/image.png", media_type: "image/png" }).success, true);
  });
  it("rejects malformed/oversized base64 and unsupported media types", () => {
    for (const data of ["", "A", "AAA", "A===", "AA=A", "!!!!", "AAAA=", "AB==", "AAB="]) assert.equal(ImageAttachmentSchema.safeParse({ type: "image", data, mimeType: "image/png" }).success, false, data);
    assert.equal(ImageAttachmentSchema.safeParse({ type: "image", data: "A".repeat(MAX_IMAGE_BASE64_LENGTH + 4), mimeType: "image/png" }).success, false);
    assert.equal(ImageAttachmentSchema.safeParse({ type: "image", data: "AA==", mimeType: "text/plain" }).success, false);
    assert.equal(ImageContentSourceSchema.safeParse({ type: "base64", data: "AA==", media_type: "text/plain" }).success, false);
    assert.equal(ImageContentSourceSchema.safeParse({ type: "url", url: `https://example.com/${"a".repeat(9_000)}` }).success, false);
  });
  it("rejects relative and dangerous image URLs", () => {
    for (const url of ["/relative.png", "javascript:alert(1)", "file:///tmp/a", "data:image/png;base64,AA==", "ftp://example.com/a", "https://user:pass@example.com/a.png"]) assert.equal(ImageContentSourceSchema.safeParse({ type: "url", url }).success, false, url);
  });
});

describe("E: browser WS independent interrupt", () => {
  it("parses explicit interrupt and correlated result", () => {
    const request = { type: "interrupt", id: "req-1", payload: { sessionId: "s-1", commandId: "cmd-1", interrupt: { type: "abort" } } };
    assert.equal(WsClientMessageSchema.safeParse(request).success, true);
    const response = { type: "interrupt_result", id: "req-1", payload: { sessionId: "s-1", commandId: "cmd-1", interruptType: "abort", result: { ok: false, type: "abort", error } } };
    assert.equal(WsHostMessageSchema.safeParse(response).success, true);
    assert.equal(WsInterruptExchangeSchema.safeParse({ request, response }).success, true);
    assert.equal(WsInterruptExchangeSchema.safeParse({ request, response: { ...response, id: "other" } }).success, false);
    assert.equal(WsInterruptExchangeSchema.safeParse({ request, response: { ...response, payload: { ...response.payload, commandId: "other" } } }).success, false);
    assert.equal(WsInterruptExchangeSchema.safeParse({ request, response: { ...response, payload: { ...response.payload, sessionId: "other" } } }).success, false);
    assert.equal(WsHostMessageSchema.safeParse({ ...response, payload: { ...response.payload, interruptType: "abort_bash" } }).success, false);
  });
  it("rejects unknown interrupts and abort-family ordinary commands", () => {
    assert.equal(WsClientMessageSchema.safeParse({ type: "interrupt", id: "r", payload: { sessionId: "s", commandId: "c", interrupt: { type: "prompt" } } }).success, false);
    for (const type of ["abort", "abort_compaction", "abort_bash", "clear_queue"]) assert.equal(WsClientMessageSchema.safeParse({ type: "command", payload: { sessionId: "s", command: { type, commandId: "c" } } }).success, false, type);
  });
});
