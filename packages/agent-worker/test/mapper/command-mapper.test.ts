import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RuntimeCommandSchema } from "@fffattiger/pix-protocol";
import type { RuntimeCommand as ProtocolRuntimeCommand } from "@fffattiger/pix-protocol";
import type { RuntimeCommand as CoreRuntimeCommand } from "@fffattiger/pix-runtime-core";
import { mapCoreResultToProtocol, mapProtocolCommandToCore } from "../../src/mapper/command-mapper.js";

const CID = "cmd-1";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function wire(command: DistributiveOmit<ProtocolRuntimeCommand, "commandId">): ProtocolRuntimeCommand {
  const withId = { ...command, commandId: CID };
  return RuntimeCommandSchema.parse(withId);
}

function coreFor(command: DistributiveOmit<ProtocolRuntimeCommand, "commandId">): CoreRuntimeCommand {
  return mapProtocolCommandToCore(wire(command));
}

describe("command-mapper (protocol → core, commandId stripped)", () => {
  it("prompt maps message/images/streamingBehavior", () => {
    assert.deepEqual(
      coreFor({ type: "prompt", message: "hi", images: [{ type: "image", data: "AAAA", mimeType: "image/png" }], streamingBehavior: "steer" }),
      { type: "prompt", message: "hi", images: [{ type: "image", data: "AAAA", mimeType: "image/png" }], streamingBehavior: "steer" },
    );
    assert.deepEqual(coreFor({ type: "prompt", message: "hi" }), { type: "prompt", message: "hi" });
  });

  it("maps every ack-style command field-for-field without a commandId leak", () => {
    const cases: Array<[DistributiveOmit<ProtocolRuntimeCommand, "commandId">, CoreRuntimeCommand]> = [
      [{ type: "abort" }, { type: "abort" }],
      [{ type: "get_state" }, { type: "get_state" }],
      [{ type: "set_model", provider: "openai", modelId: "gpt-4o" }, { type: "set_model", provider: "openai", modelId: "gpt-4o" }],
      [{ type: "fork", entryId: "e1" }, { type: "fork", entryId: "e1" }],
      [{ type: "navigate_tree", targetId: "t1" }, { type: "navigate_tree", targetId: "t1" }],
      [{ type: "set_thinking_level", level: "high" }, { type: "set_thinking_level", level: "high" }],
      [{ type: "compact", customInstructions: "focus" }, { type: "compact", customInstructions: "focus" }],
      [{ type: "compact" }, { type: "compact" }],
      [{ type: "set_session_name", name: "work" }, { type: "set_session_name", name: "work" }],
      [{ type: "get_session_stats" }, { type: "get_session_stats" }],
      [{ type: "get_last_assistant_text" }, { type: "get_last_assistant_text" }],
      [{ type: "set_auto_compaction", enabled: true }, { type: "set_auto_compaction", enabled: true }],
      [{ type: "clear_queue" }, { type: "clear_queue" }],
      [{ type: "steer", message: "s" }, { type: "steer", message: "s" }],
      [{ type: "follow_up", message: "f" }, { type: "follow_up", message: "f" }],
      [{ type: "get_tools" }, { type: "get_tools" }],
      [{ type: "get_commands" }, { type: "get_commands" }],
      [{ type: "set_tools", toolNames: ["bash"], includeExtensionTools: true }, { type: "set_tools", toolNames: ["bash"], includeExtensionTools: true }],
      [{ type: "reload" }, { type: "reload" }],
      [{ type: "abort_compaction" }, { type: "abort_compaction" }],
      [{ type: "set_auto_retry", enabled: false }, { type: "set_auto_retry", enabled: false }],
      [{ type: "bash", command: "ls", excludeFromContext: true }, { type: "bash", command: "ls", excludeFromContext: true }],
      [{ type: "abort_bash" }, { type: "abort_bash" }],
      [{ type: "generate_session_title" }, { type: "generate_session_title" }],
    ];
    for (const [protocol, expected] of cases) {
      const mapped = coreFor(protocol);
      assert.deepEqual(mapped, expected, `mismatch for ${protocol.type}`);
      // Core commands must never carry the wire commandId.
      assert.equal("commandId" in mapped, false);
    }
  });

  it("extension_ui_response collapses responseKind into value|confirmed|cancelled and preserves method", () => {
    assert.deepEqual(
      coreFor({ type: "extension_ui_response", id: "r1", method: "select", responseKind: "selected", selected: "optA" }),
      { type: "extension_ui_response", id: "r1", method: "select", value: "optA" },
    );
    assert.deepEqual(
      coreFor({ type: "extension_ui_response", id: "r1", method: "confirm", responseKind: "confirmed", confirmed: true }),
      { type: "extension_ui_response", id: "r1", method: "confirm", confirmed: true },
    );
    assert.deepEqual(
      coreFor({ type: "extension_ui_response", id: "r1", method: "editor", responseKind: "value", value: "typed" }),
      { type: "extension_ui_response", id: "r1", method: "editor", value: "typed" },
    );
    assert.deepEqual(
      coreFor({ type: "extension_ui_response", id: "r1", method: "select", responseKind: "cancelled", cancelled: true }),
      { type: "extension_ui_response", id: "r1", method: "select", cancelled: true },
    );
  });

  it("extension_ui_input preserves method/commandId-strip and carries data", () => {
    assert.deepEqual(
      coreFor({ type: "extension_ui_input", id: "r1", method: "input", data: "incremental" }),
      { type: "extension_ui_input", id: "r1", method: "input", data: "incremental" },
    );
    assert.deepEqual(
      coreFor({ type: "extension_ui_input", id: "r1", method: "editor", data: "edit" }),
      { type: "extension_ui_input", id: "r1", method: "editor", data: "edit" },
    );
    // E15: custom incremental key data keeps its method (exact correlation is
    // enforced downstream against the pending request, never widened here).
    assert.deepEqual(
      coreFor({ type: "extension_ui_input", id: "r1", method: "custom", data: "\x1b[A" }),
      { type: "extension_ui_input", id: "r1", method: "custom", data: "\x1b[A" },
    );
  });
});

describe("command-mapper (core result → protocol outcome)", () => {
  it("maps get_state to the protocol state DTO", () => {
    const result = mapCoreResultToProtocol({
      ok: true,
      type: "get_state",
      state: { sessionId: "s1", isStreaming: false, isPromptRunning: false, isBashRunning: false, isCompacting: false, model: null, messageCount: 0 },
    });
    assert.equal(result.ok, true);
    assert.equal(result.type, "get_state");
    assert.equal(result.state.sessionId, "s1");
  });

  it("maps get_tools / get_commands / get_session_stats / get_last_assistant_text / fork", () => {
    const tools = mapCoreResultToProtocol({ ok: true, type: "get_tools", tools: [{ name: "bash", active: true }] });
    assert.deepEqual(tools, { ok: true, type: "get_tools", tools: [{ name: "bash", active: true }] });
    const commands = mapCoreResultToProtocol({ ok: true, type: "get_commands", commands: [{ name: "/help", source: "prompt" }] });
    assert.deepEqual(commands, { ok: true, type: "get_commands", commands: [{ name: "/help", source: "prompt" }] });
    const stats = mapCoreResultToProtocol({ ok: true, type: "get_session_stats", stats: { messageCount: 3 } });
    assert.deepEqual(stats, { ok: true, type: "get_session_stats", stats: { messageCount: 3 } });
    const text = mapCoreResultToProtocol({ ok: true, type: "get_last_assistant_text", text: "hello" });
    assert.deepEqual(text, { ok: true, type: "get_last_assistant_text", text: "hello" });
    const fork = mapCoreResultToProtocol({ ok: true, type: "fork", forkedSessionId: "f1", forkPointEntryId: "e1" });
    assert.deepEqual(fork, { ok: true, type: "fork", forkedSessionId: "f1", forkPointEntryId: "e1" });
  });

  it("maps bare acks", () => {
    assert.deepEqual(mapCoreResultToProtocol({ ok: true, type: "prompt" }), { ok: true, type: "prompt" });
    assert.deepEqual(mapCoreResultToProtocol({ ok: true, type: "abort" }), { ok: true, type: "abort" });
  });

  it("maps a structured core error to a sanitized protocol error", () => {
    const result = mapCoreResultToProtocol({
      ok: false,
      type: "prompt",
      error: { code: "interrupted", message: "cancelled", retryable: false },
    });
    assert.deepEqual(result, { ok: false, type: "prompt", error: { code: "interrupted", message: "cancelled", retryable: false } });
  });
});
