/**
 * Explicit Protocol ↔ Core command mapping.
 *
 * Wire {@link RuntimeCommand} (Protocol) carries a transport `commandId` that
 * Core commands deliberately omit (D-012: at-most-once delivery is a transport
 * concern). This mapper strips the wire envelope and rebuilds each of the 26
 * Core command variants field-by-field — no `as any` identity cast anywhere.
 *
 * Extension UI commands are the special case: the wire form is method/responseKind
 * discriminated; the Core form collapses to `value | confirmed | cancelled`
 * (response) or `{ id, data }` (input). Method/responseKind are dropped here.
 */
import type { RuntimeCommand as ProtocolRuntimeCommand } from "@fffattiger/pix-protocol";
import type {
  RuntimeCommand as CoreRuntimeCommand,
  RuntimeCommandResult as CoreRuntimeCommandResult,
  ExtensionUiResponseCommand as CoreExtensionUiResponseCommand,
  ImageAttachment as CoreImageAttachment,
} from "@fffattiger/pix-runtime-core";
import {
  mapRuntimeState,
  mapSlashCommands,
  mapToolInfo,
} from "./core-to-protocol.js";
import { runtimeErrorToProtocolError } from "./protocol-error.js";

function mapImages(images: readonly { type: "image"; data: string; mimeType: string }[]): CoreImageAttachment[] {
  return images.map((image): CoreImageAttachment => ({ type: "image", data: image.data, mimeType: image.mimeType }));
}

/** Strip the wire envelope and rebuild the canonical Core command. */
export function mapProtocolCommandToCore(command: ProtocolRuntimeCommand): CoreRuntimeCommand {
  switch (command.type) {
    case "prompt":
      return {
        type: "prompt",
        message: command.message,
        ...(command.images === undefined ? {} : { images: mapImages(command.images) }),
        ...(command.streamingBehavior === undefined ? {} : { streamingBehavior: command.streamingBehavior }),
      };
    case "abort":
      return { type: "abort" };
    case "get_state":
      return { type: "get_state" };
    case "set_model":
      return { type: "set_model", provider: command.provider, modelId: command.modelId };
    case "fork":
      return { type: "fork", entryId: command.entryId };
    case "navigate_tree":
      return { type: "navigate_tree", targetId: command.targetId };
    case "set_thinking_level":
      return { type: "set_thinking_level", level: command.level };
    case "compact":
      return {
        type: "compact",
        ...(command.customInstructions === undefined ? {} : { customInstructions: command.customInstructions }),
      };
    case "set_session_name":
      return { type: "set_session_name", name: command.name };
    case "get_session_stats":
      return { type: "get_session_stats" };
    case "get_last_assistant_text":
      return { type: "get_last_assistant_text" };
    case "set_auto_compaction":
      return { type: "set_auto_compaction", enabled: command.enabled };
    case "clear_queue":
      return { type: "clear_queue" };
    case "steer":
      return {
        type: "steer",
        message: command.message,
        ...(command.images === undefined ? {} : { images: mapImages(command.images) }),
      };
    case "follow_up":
      return {
        type: "follow_up",
        message: command.message,
        ...(command.images === undefined ? {} : { images: mapImages(command.images) }),
      };
    case "get_tools":
      return { type: "get_tools" };
    case "get_commands":
      return { type: "get_commands" };
    case "set_tools":
      return {
        type: "set_tools",
        toolNames: [...command.toolNames],
        ...(command.includeExtensionTools === undefined ? {} : { includeExtensionTools: command.includeExtensionTools }),
      };
    case "reload":
      return { type: "reload" };
    case "abort_compaction":
      return { type: "abort_compaction" };
    case "set_auto_retry":
      return { type: "set_auto_retry", enabled: command.enabled };
    case "bash":
      return {
        type: "bash",
        command: command.command,
        ...(command.excludeFromContext === undefined ? {} : { excludeFromContext: command.excludeFromContext }),
      };
    case "abort_bash":
      return { type: "abort_bash" };
    case "generate_session_title":
      return { type: "generate_session_title" };
    case "extension_ui_response": {
      // Collapse method/responseKind into the Core value|confirmed|cancelled
      // form, PRESERVING the correlated method (the adapter validates the
      // pending request's exact method against it).
      if (command.responseKind === "cancelled") {
        const core: CoreExtensionUiResponseCommand = {
          type: "extension_ui_response",
          id: command.id,
          method: command.method,
          cancelled: true,
        };
        return core;
      }
      if (command.responseKind === "confirmed") {
        const core: CoreExtensionUiResponseCommand = {
          type: "extension_ui_response",
          id: command.id,
          method: command.method,
          confirmed: command.confirmed,
        };
        return core;
      }
      // responseKind "selected" → value = selected; "value" → value = value.
      const value =
        command.responseKind === "selected" ? command.selected : command.value;
      const core: CoreExtensionUiResponseCommand = {
        type: "extension_ui_response",
        id: command.id,
        method: command.method,
        value,
      };
      return core;
    }
    case "extension_ui_input":
      // Strip commandId; carry the correlated method + incremental data string.
      return { type: "extension_ui_input", id: command.id, method: command.method, data: command.data };
  }
}

function mapStats(stats: {
  messageCount: number;
  pendingMessageCount?: number;
  tokenCount?: number;
  contextUsage?: { percent: number; contextWindow?: number; tokens?: number };
}) {
  return {
    messageCount: stats.messageCount,
    ...(stats.pendingMessageCount === undefined ? {} : { pendingMessageCount: stats.pendingMessageCount }),
    ...(stats.tokenCount === undefined ? {} : { tokenCount: stats.tokenCount }),
    ...(stats.contextUsage === undefined
      ? {}
      : {
          contextUsage: {
            percent: stats.contextUsage.percent,
            ...(stats.contextUsage.contextWindow === undefined
              ? {}
              : { contextWindow: stats.contextUsage.contextWindow }),
            ...(stats.contextUsage.tokens === undefined ? {} : { tokens: stats.contextUsage.tokens }),
          },
        }),
  };
}

/**
 * Map a Core {@link RuntimeCommandResult} back to the Protocol outcome. The
 * `get_state`/`get_tools`/`get_commands` payloads carry Core data that is
 * rebuilt into Protocol DTOs; acks pass through; errors are sanitized.
 */
export function mapCoreResultToProtocol(result: CoreRuntimeCommandResult) {
  if (!result.ok) {
    return {
      ok: false as const,
      type: result.type,
      error: runtimeErrorToProtocolError(result.error),
    };
  }
  switch (result.type) {
    case "get_state":
      return { ok: true as const, type: "get_state" as const, state: mapRuntimeState(result.state) };
    case "get_tools":
      return {
        ok: true as const,
        type: "get_tools" as const,
        tools: mapToolInfo(result.tools) ?? [],
      };
    case "get_commands":
      return {
        ok: true as const,
        type: "get_commands" as const,
        commands: mapSlashCommands(result.commands) ?? [],
      };
    case "get_session_stats":
      return {
        ok: true as const,
        type: "get_session_stats" as const,
        stats: mapStats(result.stats),
      };
    case "get_last_assistant_text":
      return { ok: true as const, type: "get_last_assistant_text" as const, text: result.text };
    case "fork":
      return {
        ok: true as const,
        type: "fork" as const,
        forkedSessionId: result.forkedSessionId,
        forkPointEntryId: result.forkPointEntryId,
      };
    default:
      // Bare ack commands (prompt, abort, steer, …) carry no payload.
      return { ok: true as const, type: result.type };
  }
}
