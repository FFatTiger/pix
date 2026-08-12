import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALL_HOST_CAPABILITIES,
  EpochSchema,
  EventIdSchema,
  HostCapabilitySchema,
  ImageAttachmentSchema,
  LastEventIdSchema,
  ModelRefSchema,
  ModelInfoSchema,
  NonEmptyStringSchema,
  PROTOCOL_VERSION,
  ProtocolErrorSchema,
  ProtocolHandshakeRequestSchema,
  ProtocolHandshakeResponseSchema,
  RUNTIME_COMMAND_TYPES,
  RuntimeCommandSchema,
  RuntimeEventSchema,
  RuntimeSnapshotSchema,
  SESSIOND_RPC_METHODS,
  SessionCreateParamsSchema,
  SessiondMethodResultSchemas,
  SessiondRpcRequestSchema,
  SessiondRpcResponseSchema,
  SessiondToWorkerMessageSchema,
  StreamingAgentMessageSchema,
  ThinkingLevelSchema,
  WorkerToSessiondPushSchema,
  parseRuntimeCommand,
  parseSessiondMethodResult,
  safeParseRuntimeCommand,
  safeParseRuntimeEvent,
  safeParseRuntimeSnapshot,
  safeParseSessiondRpcRequest,
  safeParseSessiondRpcResponse,
  safeParseSessiondToWorkerMessage,
  safeParseWorkerToSessiondMessage,
  safeParseWsClientMessage,
  WsClientMessageSchema,
  WsHostMessageSchema,
} from "../dist/index.js";

function roundTrip(schema, value) {
  const parsed = schema.parse(value);
  const json = JSON.parse(JSON.stringify(parsed));
  return schema.parse(json);
}

const baseEvent = {
  eventId: 1,
  sessionId: "s-1",
  epoch: "epoch-1",
};

const baseSnapshotState = {
  sessionId: "s-1",
  isStreaming: false,
  isPromptRunning: false,
  isBashRunning: false,
  isCompacting: false,
  model: null,
  messageCount: 0,
};

describe("protocol version", () => {
  it("freezes protocolVersion at 1", () => {
    assert.equal(PROTOCOL_VERSION, 1);
  });

  it("rejects non-v1 handshake", () => {
    const result = ProtocolHandshakeRequestSchema.safeParse({
      protocolVersion: 2,
      client: { shell: "web", platform: "mac" },
      features: [],
    });
    assert.equal(result.success, false);
  });
});

describe("capabilities", () => {
  it("covers the full negotiated capability set", () => {
    const expected = [
      "agent",
      "sessions",
      "files",
      "files.write",
      "files.watch",
      "files.upload",
      "git",
      "worktree",
      "session.write",
      "session.delete",
      "models",
      "auth.providers",
      "skills",
      "plugins",
      "export",
    ];
    assert.deepEqual([...ALL_HOST_CAPABILITIES].sort(), [...expected].sort());
    for (const cap of expected) {
      assert.equal(HostCapabilitySchema.parse(cap), cap);
    }
  });

  it("rejects mutation/trust-management capability tokens (read-only foundation)", () => {
    // D3B-R1A freezes the resource/auth/model surface as read-only: there is
    // no configure/manage/trust-mutation capability.
    for (const rejected of [
      "models.configure",
      "skills.manage",
      "plugins.manage",
      "project.trust",
    ]) {
      assert.equal(HostCapabilitySchema.safeParse(rejected).success, false);
    }
  });

  it("rejects unknown capabilities", () => {
    assert.equal(HostCapabilitySchema.safeParse("desktop").success, false);
  });
});

describe("identifiers and cursors", () => {
  it("accepts non-blank strings without trimming", () => {
    assert.equal(NonEmptyStringSchema.parse(" a "), " a ");
    assert.equal(EpochSchema.parse("epoch-1"), "epoch-1");
    assert.equal(NonEmptyStringSchema.safeParse("").success, false);
    assert.equal(NonEmptyStringSchema.safeParse("   ").success, false);
    assert.equal(NonEmptyStringSchema.safeParse("\t\n").success, false);
  });

  it("uses integer event cursors", () => {
    assert.equal(EventIdSchema.parse(1), 1);
    assert.equal(LastEventIdSchema.parse(0), 0);
    assert.equal(EventIdSchema.safeParse(0).success, false);
    assert.equal(EventIdSchema.safeParse(-1).success, false);
    assert.equal(EventIdSchema.safeParse(1.5).success, false);
    assert.equal(EventIdSchema.safeParse("1").success, false);
    assert.equal(LastEventIdSchema.safeParse(-1).success, false);
    assert.equal(LastEventIdSchema.safeParse(1.2).success, false);
    assert.equal(LastEventIdSchema.safeParse("0").success, false);
    assert.equal(EpochSchema.safeParse(1).success, false);
  });
});

describe("handshake round-trip", () => {
  it("parses request and response", () => {
    const req = roundTrip(ProtocolHandshakeRequestSchema, {
      protocolVersion: 1,
      client: { shell: "pwa", platform: "ios" },
      features: ["virtual-scroll"],
      auth: "gate-token",
    });
    assert.equal(req.protocolVersion, 1);
    assert.equal(req.client.shell, "pwa");

    const res = roundTrip(ProtocolHandshakeResponseSchema, {
      protocolVersion: 1,
      host: {
        mode: "lan",
        capabilities: ["agent", "files", "files.write", "git", "worktree"],
      },
      limits: { maxUpload: 10_485_760, maxOpenSessions: 8 },
      sessionSnapshotSupport: true,
    });
    assert.equal(res.host.mode, "lan");
    assert.equal(res.sessionSnapshotSupport, true);
  });
});

describe("RuntimeCommand", () => {
  const samples = {
    prompt: {
      type: "prompt",
      commandId: "c-prompt",
      message: "hello",
      images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      streamingBehavior: "steer",
    },
    abort: { type: "abort", commandId: "c-abort" },
    get_state: { type: "get_state", commandId: "c-state" },
    set_model: {
      type: "set_model",
      commandId: "c-model",
      provider: "openai",
      modelId: "gpt-4.1",
    },
    fork: { type: "fork", commandId: "c-fork", entryId: "entry-1" },
    navigate_tree: {
      type: "navigate_tree",
      commandId: "c-nav",
      targetId: "leaf-1",
    },
    set_thinking_level: {
      type: "set_thinking_level",
      commandId: "c-think",
      level: "high",
    },
    compact: {
      type: "compact",
      commandId: "c-compact",
      customInstructions: "keep decisions",
    },
    set_session_name: {
      type: "set_session_name",
      commandId: "c-name",
      name: "My session",
    },
    get_session_stats: { type: "get_session_stats", commandId: "c-stats" },
    get_last_assistant_text: {
      type: "get_last_assistant_text",
      commandId: "c-last",
    },
    set_auto_compaction: {
      type: "set_auto_compaction",
      commandId: "c-ac",
      enabled: true,
    },
    clear_queue: { type: "clear_queue", commandId: "c-cq" },
    steer: { type: "steer", commandId: "c-steer", message: "stop" },
    follow_up: {
      type: "follow_up",
      commandId: "c-fu",
      message: "then do this",
    },
    get_tools: { type: "get_tools", commandId: "c-tools" },
    get_commands: { type: "get_commands", commandId: "c-cmds" },
    set_tools: {
      type: "set_tools",
      commandId: "c-set-tools",
      toolNames: ["read", "bash"],
      includeExtensionTools: false,
    },
    reload: { type: "reload", commandId: "c-reload" },
    abort_compaction: { type: "abort_compaction", commandId: "c-ab-c" },
    extension_ui_response: {
      type: "extension_ui_response",
      commandId: "c-ui-r",
      id: "ui-1",
      method: "input",
      responseKind: "value",
      value: "ok",
    },
    extension_ui_input: {
      type: "extension_ui_input",
      commandId: "c-ui-i",
      id: "ui-2",
      method: "input",
      data: "typed",
    },
    set_auto_retry: {
      type: "set_auto_retry",
      commandId: "c-retry",
      enabled: false,
    },
    bash: {
      type: "bash",
      commandId: "c-bash",
      command: "ls -la",
      excludeFromContext: true,
    },
    abort_bash: { type: "abort_bash", commandId: "c-ab-b" },
    generate_session_title: {
      type: "generate_session_title",
      commandId: "c-title",
    },
  };

  it("enumerates exactly 26 command types", () => {
    assert.equal(RUNTIME_COMMAND_TYPES.length, 26);
    assert.equal(Object.keys(samples).length, 26);
  });

  it("parses every command type with commandId", () => {
    for (const type of RUNTIME_COMMAND_TYPES) {
      const sample = samples[type];
      assert.ok(sample, `missing sample for ${type}`);
      const parsed = parseRuntimeCommand(sample);
      assert.equal(parsed.type, type);
      assert.ok(parsed.commandId.length > 0);
      const again = roundTrip(RuntimeCommandSchema, parsed);
      assert.equal(again.type, type);
    }
  });

  it("rejects unknown command type", () => {
    assert.equal(
      safeParseRuntimeCommand({ type: "teleport", commandId: "x" }).success,
      false,
    );
  });

  it("rejects commands missing commandId", () => {
    assert.equal(
      safeParseRuntimeCommand({ type: "prompt", message: "hi" }).success,
      false,
    );
  });

  it("rejects blank commandId", () => {
    assert.equal(
      safeParseRuntimeCommand({ type: "abort", commandId: "  " }).success,
      false,
    );
  });

  it("rejects invalid thinking level", () => {
    assert.equal(
      safeParseRuntimeCommand({
        type: "set_thinking_level",
        commandId: "c1",
        level: "ultra",
      }).success,
      false,
    );
  });

  it("rejects unknown SDK model fields on set_model", () => {
    assert.equal(
      safeParseRuntimeCommand({
        type: "set_model",
        commandId: "c1",
        provider: "openai",
        modelId: "gpt",
        contextWindow: 128000,
      }).success,
      false,
    );
    assert.equal(
      safeParseRuntimeCommand({
        type: "set_model",
        commandId: "c1",
        model: { id: "gpt", provider: "openai", contextWindow: 128000 },
      }).success,
      false,
    );
  });

  it("rejects image attachments without image/* mimeType", () => {
    assert.equal(
      ImageAttachmentSchema.safeParse({
        type: "image",
        data: "abc",
        mimeType: "application/pdf",
      }).success,
      false,
    );
    assert.equal(
      safeParseRuntimeCommand({
        type: "prompt",
        commandId: "c1",
        message: "x",
        images: [{ type: "image", data: "abc", mimeType: "text/plain" }],
      }).success,
      false,
    );
  });

  it("rejects empty or blank prompt and bash", () => {
    assert.equal(
      safeParseRuntimeCommand({
        type: "prompt",
        commandId: "c1",
        message: "",
      }).success,
      false,
    );
    assert.equal(
      safeParseRuntimeCommand({
        type: "prompt",
        commandId: "c1",
        message: "   ",
      }).success,
      false,
    );
    assert.equal(
      safeParseRuntimeCommand({
        type: "bash",
        commandId: "c1",
        command: "",
      }).success,
      false,
    );
    assert.equal(
      safeParseRuntimeCommand({
        type: "bash",
        commandId: "c1",
        command: "\n\t",
      }).success,
      false,
    );
  });

  it("rejects toolNames that are not an array", () => {
    assert.equal(
      safeParseRuntimeCommand({
        type: "set_tools",
        commandId: "c1",
        toolNames: "read",
      }).success,
      false,
    );
  });

  it("binds extension responses to request method and rejects conflicts", () => {
    assert.equal(safeParseRuntimeCommand({ type: "extension_ui_response", commandId: "c1", id: "ui", method: "confirm", responseKind: "confirmed", confirmed: true }).success, true);
    assert.equal(safeParseRuntimeCommand({ type: "extension_ui_response", commandId: "c1", id: "ui", method: "select", responseKind: "selected", selected: "a" }).success, true);
    assert.equal(safeParseRuntimeCommand({ type: "extension_ui_response", commandId: "c1", id: "ui", method: "confirm", responseKind: "value", value: "x" }).success, false);
    assert.equal(safeParseRuntimeCommand({ type: "extension_ui_response", commandId: "c1", id: "ui", method: "select", responseKind: "confirmed", confirmed: true }).success, false);
    assert.equal(safeParseRuntimeCommand({ type: "extension_ui_input", commandId: "c1", id: "ui", method: "confirm", data: "x" }).success, false);
  });
});

describe("messages and RuntimeEvent", () => {
  it("round-trips a message_update event with typed streaming content", () => {
    const event = roundTrip(RuntimeEventSchema, {
      type: "message_update",
      ...baseEvent,
      streamId: "stream-1",
      messageId: "message-1",
      delta: { role: "assistant", delta: { type: "text", text: "partial" } },
    });
    assert.equal(event.type, "message_update");
  });

  it("rejects streaming content that is null or number", () => {
    assert.equal(
      StreamingAgentMessageSchema.safeParse({
        role: "assistant",
        content: null,
      }).success,
      false,
    );
    assert.equal(
      StreamingAgentMessageSchema.safeParse({
        role: "assistant",
        content: 42,
      }).success,
      false,
    );
    assert.equal(
      safeParseRuntimeEvent({
        type: "message_start",
        ...baseEvent,
        streamId: "stream-1",
        messageId: "message-1",
        message: { role: "assistant", content: null },
      }).success,
      false,
    );
  });

  it("requires complete AgentMessage on message_end", () => {
    assert.equal(
      safeParseRuntimeEvent({
        type: "message_end",
        ...baseEvent,
        streamId: "stream-1",
        messageId: "message-1",
        message: { role: "assistant", content: [{ type: "text", text: "x" }] },
      }).success,
      false,
    );
    assert.equal(
      safeParseRuntimeEvent({
        type: "message_end",
        ...baseEvent,
        streamId: "stream-1",
        messageId: "message-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          model: "gpt-4.1",
          provider: "openai",
        },
      }).success,
      true,
    );
  });

  it("round-trips tool_execution_start with unknown args", () => {
    const event = roundTrip(RuntimeEventSchema, {
      type: "tool_execution_start",
      ...baseEvent,
      eventId: 2,
      toolCallId: "tc-1",
      toolName: "bash",
      args: { command: "echo hi" },
    });
    assert.equal(event.type, "tool_execution_start");
  });

  it("rejects events missing envelope fields or with bad cursors", () => {
    assert.equal(safeParseRuntimeEvent({ type: "agent_start" }).success, false);
    assert.equal(
      safeParseRuntimeEvent({
        type: "agent_start",
        eventId: "1",
        sessionId: "s",
        epoch: "e",
      }).success,
      false,
    );
    assert.equal(
      safeParseRuntimeEvent({
        type: "agent_start",
        eventId: 0,
        sessionId: "s",
        epoch: "e",
      }).success,
      false,
    );
    assert.equal(
      safeParseRuntimeEvent({
        type: "agent_start",
        eventId: 1,
        sessionId: "s",
        epoch: 1,
      }).success,
      false,
    );
  });

  it("rejects unknown SDK event fields", () => {
    assert.equal(
      safeParseRuntimeEvent({
        type: "agent_start",
        ...baseEvent,
        sdkEvent: { kind: "raw" },
      }).success,
      false,
    );
  });

  it("validates extension_ui_request method requirements", () => {
    assert.equal(
      safeParseRuntimeEvent({
        type: "extension_ui_request",
        ...baseEvent,
        request: {
          id: "ui-1",
          method: "select",
          title: "Pick",
          options: ["a", "b"],
        },
      }).success,
      true,
    );
    assert.equal(
      safeParseRuntimeEvent({
        type: "extension_ui_request",
        ...baseEvent,
        request: { id: "ui-1", method: "select", title: "Pick" },
      }).success,
      false,
    );
  });
});

describe("RuntimeSnapshot", () => {
  it("round-trips snapshot with streaming, queues, pending UI, tools", () => {
    const snapshot = roundTrip(RuntimeSnapshotSchema, {
      sessionId: "s-1",
      cwd: "/tmp/project",
      projectRoot: "/tmp/project",
      capabilities: { capabilities: ["runtime.prompt", "runtime.abort"], version: 1 },
      state: {
        ...baseSnapshotState,
        isStreaming: true,
        isPromptRunning: true,
        isBashRunning: false,
        isCompacting: false,
        model: { id: "gpt-4.1", provider: "openai" },
        thinkingLevel: "medium",
        contextUsage: { percent: 42, tokens: 12000, contextWindow: 128000 },
        queuedMessages: { steering: [], followUp: [{ message: "later", images: [{ type: "image", data: "AA==", mimeType: "image/png" }] }] },
        tools: [{ name: "bash", active: true, description: "shell" }],
        extensionStatuses: [{ key: "status", text: "ok" }],
        extensionWidgets: [
          { key: "w1", lines: ["line"], placement: "aboveEditor" },
        ],
        pendingExtensionUi: [
          {
            id: "ui-1",
            method: "confirm",
            title: "Sure?",
            message: "Proceed?",
          },
        ],
      },
      streaming: {
        active: true,
        streamId: "stream-1",
        messageId: "message-1",
        phase: "streaming",
        toolCallIds: [],
        partialMessage: {
          role: "assistant",
          content: [{ type: "text", text: "..." }],
        },
      },
    });
    assert.equal(snapshot.capabilities.version, 1);
    assert.equal(snapshot.state.model?.id, "gpt-4.1");
    assert.equal(snapshot.state.pendingExtensionUi?.[0]?.method, "confirm");
  });

  it("requires capability snapshot and rejects transport cursor leakage", () => {
    assert.equal(
      safeParseRuntimeSnapshot({
        sessionId: "s",
        cwd: "/tmp/project",
        projectRoot: "/tmp/project",
        state: { ...baseSnapshotState, sessionId: "s" },
        capabilities: { capabilities: [], version: 0 },
      }).success,
      true,
    );
    assert.equal(
      safeParseRuntimeSnapshot({
        sessionId: "s",
        epoch: "e0",
        state: baseSnapshotState,
        capabilities: { capabilities: [], version: 0 },
      }).success,
      false,
    );
  });
});

describe("WS envelopes", () => {
  it("parses client attach with atomic epoch/lastEventId", () => {
    const msg = roundTrip(WsClientMessageSchema, {
      type: "attach",
      id: "req-1",
      payload: {
        sessionId: "s-1",
        epoch: "epoch-2",
        lastEventId: 10,
      },
    });
    assert.equal(msg.type, "attach");
    if (msg.type === "attach") {
      assert.equal(msg.payload.epoch, "epoch-2");
      assert.equal(msg.payload.lastEventId, 10);
    }
  });

  it("parses host snapshot and event messages", () => {
    const snap = roundTrip(WsHostMessageSchema, {
      type: "snapshot",
      payload: {
        sessionId: "s-1",
        cwd: "/tmp/project",
        projectRoot: "/tmp/project",
        epoch: "e0",
        lastEventId: 0,
        workerStatus: "ready",
        resumeStatus: "snapshot",
        snapshot: {
          sessionId: "s-1",
          cwd: "/tmp/project",
          projectRoot: "/tmp/project",
          state: baseSnapshotState,
          capabilities: { capabilities: [], version: 0 },
        },
      },
    });
    assert.equal(snap.type, "snapshot");

    const evt = roundTrip(WsHostMessageSchema, {
      type: "event",
      payload: {
        type: "prompt_done",
        eventId: 1,
        sessionId: "s-1",
        epoch: "e0",
      },
    });
    assert.equal(evt.type, "event");
  });

  it("parses runtime_unavailable", () => {
    const msg = roundTrip(WsHostMessageSchema, {
      type: "runtime_unavailable",
      payload: {
        sessionId: "s-1",
        error: {
          code: "runtime_unavailable",
          message: "worker crashed",
          retryable: true,
        },
      },
    });
    assert.equal(msg.type, "runtime_unavailable");
  });

  it("rejects invalid client envelope type", () => {
    assert.equal(
      safeParseWsClientMessage({ type: "snapshot", payload: {} }).success,
      false,
    );
  });

  it("parses getSnapshot and stop client messages", () => {
    const get = roundTrip(WsClientMessageSchema, {
      type: "getSnapshot",
      id: "req-1",
      payload: { sessionId: "s-1" },
    });
    assert.equal(get.type, "getSnapshot");
    const stop = roundTrip(WsClientMessageSchema, {
      type: "stop",
      id: "req-2",
      payload: { sessionId: "s-1", reason: "user" },
    });
    assert.equal(stop.type, "stop");
    const stopNoReason = roundTrip(WsClientMessageSchema, {
      type: "stop",
      id: "req-3",
      payload: { sessionId: "s-1" },
    });
    assert.equal(stopNoReason.type, "stop");
  });

  it("rejects getSnapshot/stop missing id or sessionId", () => {
    assert.equal(safeParseWsClientMessage({ type: "getSnapshot", payload: { sessionId: "s-1" } }).success, false);
    assert.equal(safeParseWsClientMessage({ type: "getSnapshot", id: "r", payload: {} }).success, false);
    assert.equal(safeParseWsClientMessage({ type: "stop", payload: { sessionId: "s-1" } }).success, false);
    assert.equal(safeParseWsClientMessage({ type: "stop", id: "r", payload: { sessionId: "s-1", extra: 1 } }).success, false);
  });

  it("accepts each member of the strict response result union and rejects unknown", () => {
    const snapshot = {
      sessionId: "s-1",
      cwd: "/tmp/p",
      projectRoot: "/tmp/p",
      state: baseSnapshotState,
      capabilities: { capabilities: [], version: 0 },
    };
    const cases = [
      { ok: true, result: { commandId: "c-1", result: { ok: true, type: "abort" } } },
      { ok: true, result: { sessionId: "s-1", epoch: "e1", created: true, cwd: "/tmp/p", projectRoot: "/tmp/p", workerStatus: "ready" } },
      { ok: true, result: { sessionId: "s-1", detached: true } },
      { ok: true, result: snapshot },
      { ok: true, result: { sessionId: "s-1", stopped: true } },
    ];
    for (const result of cases) {
      const msg = roundTrip(WsHostMessageSchema, { type: "response", id: "r-1", payload: result });
      assert.equal(msg.type, "response");
    }
    // unknown result shape is rejected (no `unknown` accepted)
    assert.equal(
      WsHostMessageSchema.safeParse({ type: "response", id: "r-1", payload: { ok: true, result: { wat: true } } }).success,
      false,
    );
    // error branch still accepted
    assert.equal(
      WsHostMessageSchema.safeParse({ type: "response", id: "r-1", payload: { ok: false, error: { code: "internal", message: "x", retryable: false } } }).success,
      true,
    );
  });
});

describe("sessiond RPC", () => {
  const rpc = (method, params) => ({
    protocolVersion: 1,
    id: `rpc-${method}`,
    method,
    params,
  });

  it("lists frozen core and optional sessions methods", () => {
    assert.ok(SESSIOND_RPC_METHODS.includes("system.ping"));
    assert.ok(SESSIOND_RPC_METHODS.includes("runtime.create"));
    assert.ok(SESSIOND_RPC_METHODS.includes("runtime.hasBusyCwd"));
    assert.ok(SESSIOND_RPC_METHODS.includes("sessions.list"));
    assert.equal(SESSIOND_RPC_METHODS.includes("worker.status"), false);
    assert.equal(SESSIOND_RPC_METHODS.includes("session.create"), false);
  });

  it("parses all core method requests with strict params", () => {
    const cases = [
      rpc("system.ping", {}),
      rpc("system.hello", { clientName: "host" }),
      rpc("runtime.create", {
        createRequestId: "cr-1",
        cwd: "/tmp/project",
        projectRoot: "/tmp/project",
      }),
      rpc("runtime.activate", { sessionId: "s-1" }),
      rpc("runtime.attach", {
        sessionId: "s-1",
        epoch: "e1",
        lastEventId: 3,
      }),
      rpc("runtime.detach", { sessionId: "s-1" }),
      rpc("runtime.getSnapshot", { sessionId: "s-1" }),
      rpc("runtime.listRunning", {}),
      rpc("runtime.command", {
        sessionId: "s-1",
        command: { type: "abort", commandId: "c-1" },
      }),
      rpc("runtime.stop", { sessionId: "s-1" }),
      rpc("runtime.hasBusyCwd", { cwd: "/tmp/project" }),
      rpc("runtime.stopByCwd", { cwd: "/tmp/project" }),
      rpc("sessions.list", { cwd: "/tmp/project", limit: 10, offset: 20 }),
      rpc("sessions.read", { sessionId: "s-1" }),
      rpc("sessions.context", { sessionId: "s-1", leafId: "entry-7" }),
    ];
    for (const input of cases) {
      const parsed = SessiondRpcRequestSchema.parse(input);
      assert.equal(parsed.method, input.method);
    }
  });

  it("rejects method↔params mismatches and blank cwd", () => {
    assert.equal(
      safeParseSessiondRpcRequest(
        rpc("runtime.create", { cwd: "/tmp/project" }),
      ).success,
      false,
    );
    assert.equal(
      safeParseSessiondRpcRequest(
        rpc("runtime.command", { command: { type: "abort", commandId: "c" } }),
      ).success,
      false,
    );
    assert.equal(
      safeParseSessiondRpcRequest(
        rpc("runtime.hasBusyCwd", { cwd: "  " }),
      ).success,
      false,
    );
    assert.equal(
      safeParseSessiondRpcRequest(
        rpc("runtime.stopByCwd", { cwd: "" }),
      ).success,
      false,
    );
    assert.equal(
      safeParseSessiondRpcRequest(
        rpc("runtime.attach", { sessionId: "s", lastEventId: "1" }),
      ).success,
      false,
    );
    assert.equal(
      safeParseSessiondRpcRequest(
        rpc("runtime.getSnapshot", { sessionId: "s", activate: true }),
      ).success,
      false,
    );
    assert.equal(
      safeParseSessiondRpcRequest({
        protocolVersion: 1,
        id: "x",
        method: "worker.status",
        params: {},
      }).success,
      false,
    );
    // sessions.list bounds: limit must be positive int; offset non-negative int.
    assert.equal(
      safeParseSessiondRpcRequest(
        rpc("sessions.list", { limit: 0 }),
      ).success,
      false,
    );
    assert.equal(
      safeParseSessiondRpcRequest(
        rpc("sessions.list", { offset: -1 }),
      ).success,
      false,
    );
    assert.equal(
      safeParseSessiondRpcRequest(
        rpc("sessions.list", { limit: 1.5 }),
      ).success,
      false,
    );
    // sessions.context leafId must be non-blank.
    assert.equal(
      safeParseSessiondRpcRequest(
        rpc("sessions.context", { sessionId: "s", leafId: "  " }),
      ).success,
      false,
    );
    assert.equal(
      safeParseSessiondRpcRequest(
        rpc("sessions.context", { leafId: "e" }),
      ).success,
      false,
    );
  });

  it("requires createRequestId for runtime.create", () => {
    assert.equal(
      SessionCreateParamsSchema.safeParse({ cwd: "/tmp/project" }).success,
      false,
    );
    const ok = SessionCreateParamsSchema.parse({
      createRequestId: "cr-1",
      cwd: "/tmp/project",
      projectRoot: "/tmp/project",
    });
    assert.equal(ok.createRequestId, "cr-1");
  });

  it("round-trips RPC error response", () => {
    const err = roundTrip(SessiondRpcResponseSchema, {
      id: "rpc-1",
      ok: false,
      method: "runtime.attach",
      error: { code: "not_found", message: "session missing", retryable: false },
    });
    assert.equal(err.ok, false);
    if (!err.ok) assert.equal(err.error.code, "not_found");
  });

  it("rejects RPC error without code", () => {
    assert.equal(
      safeParseSessiondRpcResponse({
        id: "x",
        ok: false,
        method: "runtime.attach",
        error: { message: "boom", retryable: false },
      }).success,
      false,
    );
  });

  it("parses all core method result schemas", () => {
    const results = {
      "system.ping": { pong: true, serverTime: 1 },
      "system.hello": { protocolVersion: 1, sessiondVersion: "0.1.0" },
      "runtime.create": {
        sessionId: "s-1",
        epoch: "e1",
        created: true,
        cwd: "/tmp/p",
        projectRoot: "/tmp/p",
        workerStatus: "ready",
      },
      "runtime.activate": {
        sessionId: "s-1",
        epoch: "e1",
        cwd: "/tmp/p",
        projectRoot: "/tmp/p",
        workerStatus: "ready",
      },
      "runtime.attach": {
        sessionId: "s-1",
        epoch: "e1",
        lastEventId: 0,
        cwd: "/tmp/p",
        projectRoot: "/tmp/p",
        workerStatus: "ready",
        resumeStatus: "snapshot",
        snapshot: {
          sessionId: "s-1",
          cwd: "/tmp/p",
          projectRoot: "/tmp/p",
          state: baseSnapshotState,
          capabilities: { capabilities: [], version: 0 },
        },
      },
      "runtime.detach": { sessionId: "s-1", detached: true },
      "runtime.getSnapshot": {
        sessionId: "s-1",
        cwd: "/tmp/p",
        projectRoot: "/tmp/p",
        capabilities: { capabilities: ["runtime.prompt"], version: 1 },
        state: {
          ...baseSnapshotState,
          isStreaming: true,
          isPromptRunning: true,
        },
        streaming: { active: true, streamId: "stream-1", messageId: "message-1", phase: "streaming", partialMessage: { role: "assistant", content: [{ type: "text", text: "x" }] } },
      },
      "runtime.listRunning": {
        sessions: [
          { sessionId: "s-1", workerStatus: "busy", cwd: "/tmp/p", projectRoot: "/tmp/p" },
        ],
      },
      "runtime.command": { commandId: "c-1", result: { ok: true, type: "abort" } },
      "runtime.interrupt": { commandId: "cmd-1", result: { ok: true, type: "abort" } },
      "runtime.stop": { sessionId: "s-1", stopped: true },
      "runtime.hasBusyCwd": {
        cwd: "/tmp/p",
        busy: true,
        sessionIds: ["s-1"],
      },
      "runtime.stopByCwd": {
        cwd: "/tmp/p",
        stoppedSessionIds: ["s-1"],
      },
      "sessions.list": { sessions: [{ sessionId: "s-1", cwd: "/tmp/p", projectRoot: "/tmp/p" }] },
      "sessions.resolve": { sessionId: "s-1", cwd: "/tmp/p", projectRoot: "/tmp/p" },
      "sessions.read": { sessionId: "s-1", cwd: "/tmp/p", projectRoot: "/tmp/p", entries: [] },
      "sessions.context": { sessionId: "s-1", entries: [] },
      "sessions.rename": { sessionId: "s-1", name: "New" },
      "sessions.delete": { sessionId: "s-1", deleted: true },
    };

    for (const method of Object.keys(SessiondMethodResultSchemas)) {
      const parsed = parseSessiondMethodResult(method, results[method]);
      assert.ok(parsed);
    }
  });

  it("runtime.attach result requires workerStatus", () => {
    const schema = SessiondMethodResultSchemas["runtime.attach"];
    const ok = {
      sessionId: "s-1",
      epoch: "e1",
      lastEventId: 0,
      cwd: "/tmp/p",
      projectRoot: "/tmp/p",
      workerStatus: "ready",
      resumeStatus: "snapshot",
      snapshot: { sessionId: "s-1", cwd: "/tmp/p", projectRoot: "/tmp/p", state: baseSnapshotState, capabilities: { capabilities: [], version: 0 } },
    };
    assert.equal(schema.safeParse(ok).success, true);
    const { workerStatus, ...missing } = ok;
    void workerStatus;
    assert.equal(schema.safeParse(missing).success, false);
  });
});

describe("worker IPC", () => {
  it("parses sessiond→worker messages with bound payloads", () => {
    const init = roundTrip(SessiondToWorkerMessageSchema, {
      type: "worker.init",
      id: "w-1",
      protocolVersion: 1,
      payload: {
        mode: "create",
        sessionId: "s-1",
        cwd: "/tmp/project",
        projectRoot: "/tmp/project",
        model: { provider: "openai", modelId: "gpt-4.1" },
      },
    });
    assert.equal(init.type, "worker.init");
    assert.equal(init.payload.mode, "create");

    const openInit = roundTrip(SessiondToWorkerMessageSchema, {
      type: "worker.init",
      id: "w-open",
      protocolVersion: 1,
      payload: {
        mode: "open",
        sessionId: "s-1",
        cwd: "/tmp/project",
        projectRoot: "/tmp/project",
        sessionFile: "/sessions/s-1.jsonl",
      },
    });
    assert.equal(openInit.payload.mode, "open");
    assert.equal(
      safeParseSessiondToWorkerMessage({
        type: "worker.init",
        id: "w-bad",
        protocolVersion: 1,
        payload: { mode: "resume", sessionId: "s-1", cwd: "/p", projectRoot: "/p" },
      }).success,
      false,
      "worker.init rejects unknown mode",
    );

    const interrupt = roundTrip(SessiondToWorkerMessageSchema, {
      type: "worker.interrupt",
      id: "w-int",
      protocolVersion: 1,
      payload: { sessionId: "s-1", commandId: "cmd-1", interrupt: { type: "abort" } },
    });
    assert.equal(interrupt.payload.commandId, "cmd-1");

    const command = roundTrip(SessiondToWorkerMessageSchema, {
      type: "worker.command",
      id: "w-2",
      protocolVersion: 1,
      payload: {
        sessionId: "s-1",
        command: { type: "get_state", commandId: "c-1" },
      },
    });
    assert.equal(command.type, "worker.command");

    for (const type of [
      "worker.getSnapshot",
      "worker.shutdown",
      "worker.hostResponse",
      "worker.ping",
    ]) {
      const payload =
        type === "worker.getSnapshot"
          ? { sessionId: "s-1" }
          : type === "worker.hostResponse"
            ? { requestId: "r-1", ok: true, data: { ok: true } }
            : {};
      assert.equal(
        safeParseSessiondToWorkerMessage({
          type,
          id: "w-x",
          protocolVersion: 1,
          payload,
        }).success,
        true,
        type,
      );
    }
  });

  it("rejects worker payload mismatches", () => {
    assert.equal(
      safeParseSessiondToWorkerMessage({
        type: "worker.init",
        id: "w-1",
        protocolVersion: 1,
        payload: { sessionId: "s-1", cwd: "/p", projectRoot: "/p" },
      }).success,
      false,
      "worker.init rejects missing mode",
    );
    assert.equal(
      safeParseSessiondToWorkerMessage({
        type: "worker.command",
        id: "w-1",
        protocolVersion: 1,
        payload: {
          sessionId: "s-1",
          command: { type: "prompt", message: "hi" },
        },
      }).success,
      false,
    );
    assert.equal(
      safeParseSessiondToWorkerMessage({
        type: "worker.ready",
        payload: { sessionId: "s-1" },
      }).success,
      false,
    );
  });

  it("parses worker→sessiond push messages", () => {
    const ready = roundTrip(WorkerToSessiondPushSchema, {
      type: "worker.ready",
      payload: {
        sessionId: "s-1",
        workerStatus: "ready",
      },
    });
    assert.equal(ready.type, "worker.ready");
    assert.equal(
      safeParseWorkerToSessiondMessage({
        type: "worker.ready",
        payload: { sessionId: "s-1", epoch: "e1", workerStatus: "ready" },
      }).success,
      false,
      "worker.ready rejects worker-reported epoch",
    );

    const event = roundTrip(WorkerToSessiondPushSchema, {
      type: "worker.event",
      payload: {
        sessionId: "s-1",
        event: {
          type: "agent_start",
          sessionId: "s-1",
        },
      },
    });
    assert.equal(event.type, "worker.event");

    const interruptResult = roundTrip(WorkerToSessiondPushSchema, {
      type: "worker.interruptResult",
      id: "w-ir",
      payload: {
        sessionId: "s-1",
        result: { commandId: "cmd-1", result: { ok: true, type: "abort" } },
      },
    });
    assert.equal(interruptResult.payload.result.commandId, "cmd-1");

    assert.equal(
      safeParseWorkerToSessiondMessage({
        type: "worker.fatal",
        payload: {
          error: { code: "internal", message: "boom", retryable: false },
        },
      }).success,
      true,
    );
    assert.equal(
      safeParseWorkerToSessiondMessage({
        type: "worker.cacheInvalidated",
        payload: { caches: ["models"] },
      }).success,
      true,
    );
  });
});

describe("DTO guards", () => {
  it("accepts thinking levels and model refs without SDK types", () => {
    for (const level of [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]) {
      assert.equal(ThinkingLevelSchema.parse(level), level);
    }
    assert.deepEqual(ModelRefSchema.parse({ id: "m", provider: "p" }), {
      id: "m",
      provider: "p",
    });
    assert.equal(
      ModelRefSchema.safeParse({
        id: "m",
        provider: "p",
        contextWindow: 1,
      }).success,
      false,
    );
  });

  it("ModelInfoSchema accepts positive-integer contextWindow and rejects invalid", () => {
    // Valid minimal + full positive-integer contextWindow.
    assert.equal(
      ModelInfoSchema.safeParse({ id: "m", provider: "p" }).success,
      true,
    );
    const full = ModelInfoSchema.parse({
      id: "m",
      provider: "p",
      displayName: "M",
      thinking: true,
      contextWindow: 200000,
    });
    assert.equal(full.contextWindow, 200000);
    // contextWindow invariant: positive integer only.
    assert.equal(
      ModelInfoSchema.safeParse({ id: "m", provider: "p", contextWindow: 0 })
        .success,
      false,
      "rejects 0",
    );
    assert.equal(
      ModelInfoSchema.safeParse({ id: "m", provider: "p", contextWindow: -1 })
        .success,
      false,
      "rejects negative",
    );
    assert.equal(
      ModelInfoSchema.safeParse({ id: "m", provider: "p", contextWindow: 1.5 })
        .success,
      false,
      "rejects fractional",
    );
    // Backend-neutral: rejects SDK leakage (cost/sampling/api).
    assert.equal(
      ModelInfoSchema.safeParse({
        id: "m",
        provider: "p",
        api: "anthropic-messages",
      }).success,
      false,
    );
    assert.equal(
      ModelInfoSchema.safeParse({ id: "", provider: "p" }).success,
      false,
      "rejects blank id",
    );
  });

  it("structures protocol errors", () => {
    const err = ProtocolErrorSchema.parse({
      code: "epoch_changed",
      message: "session epoch advanced",
      details: { expected: "e1", actual: "e2" },
      retryable: false,
    });
    assert.equal(err.code, "epoch_changed");
  });
});
