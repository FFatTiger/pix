/**
 * Canonical runtime commands — the 26 product commands.
 *
 * This model intentionally carries **no wire `commandId`**: at-most-once
 * delivery, deduplication and command correlation are transport concerns of
 * the Runtime Protocol (see D-012) and belong to the Protocol layer, not to
 * the application boundary. Adapters receive these commands from the Worker
 * application controller and translate them to backend calls.
 */
import type { ImageAttachment, StreamingBehavior, ThinkingLevel } from "./messages.js";

export interface PromptCommand {
  type: "prompt";
  message: string;
  images?: readonly ImageAttachment[];
  streamingBehavior?: StreamingBehavior;
}

export interface AbortCommand {
  type: "abort";
}

export interface GetStateCommand {
  type: "get_state";
}

export interface SetModelCommand {
  type: "set_model";
  provider: string;
  modelId: string;
}

export interface ForkCommand {
  type: "fork";
  /** Entry (message) id that becomes the fork point of the new session. */
  entryId: string;
}

export interface NavigateTreeCommand {
  type: "navigate_tree";
  targetId: string;
}

export interface SetThinkingLevelCommand {
  type: "set_thinking_level";
  level: ThinkingLevel;
}

export interface CompactCommand {
  type: "compact";
  customInstructions?: string;
}

export interface SetSessionNameCommand {
  type: "set_session_name";
  name: string;
}

export interface GetSessionStatsCommand {
  type: "get_session_stats";
}

export interface GetLastAssistantTextCommand {
  type: "get_last_assistant_text";
}

export interface SetAutoCompactionCommand {
  type: "set_auto_compaction";
  enabled: boolean;
}

export interface ClearQueueCommand {
  type: "clear_queue";
}

export interface SteerCommand {
  type: "steer";
  message: string;
  images?: readonly ImageAttachment[];
}

export interface FollowUpCommand {
  type: "follow_up";
  message: string;
  images?: readonly ImageAttachment[];
}

export interface GetToolsCommand {
  type: "get_tools";
}

export interface GetCommandsCommand {
  type: "get_commands";
}

export interface SetToolsCommand {
  type: "set_tools";
  toolNames: readonly string[];
  includeExtensionTools?: boolean;
}

export interface ReloadCommand {
  type: "reload";
}

export interface AbortCompactionCommand {
  type: "abort_compaction";
}

/**
 * Extension UI responses — exactly one of `value` / `confirmed` / `cancelled`.
 */
export type ExtensionUiResponseCommand =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

export interface ExtensionUiInputCommand {
  type: "extension_ui_input";
  id: string;
  data: string;
}

export interface SetAutoRetryCommand {
  type: "set_auto_retry";
  enabled: boolean;
}

export interface BashCommand {
  type: "bash";
  command: string;
  excludeFromContext?: boolean;
}

export interface AbortBashCommand {
  type: "abort_bash";
}

export interface GenerateSessionTitleCommand {
  type: "generate_session_title";
}

export type RuntimeCommand =
  | PromptCommand
  | AbortCommand
  | GetStateCommand
  | SetModelCommand
  | ForkCommand
  | NavigateTreeCommand
  | SetThinkingLevelCommand
  | CompactCommand
  | SetSessionNameCommand
  | GetSessionStatsCommand
  | GetLastAssistantTextCommand
  | SetAutoCompactionCommand
  | ClearQueueCommand
  | SteerCommand
  | FollowUpCommand
  | GetToolsCommand
  | GetCommandsCommand
  | SetToolsCommand
  | ReloadCommand
  | AbortCompactionCommand
  | ExtensionUiResponseCommand
  | ExtensionUiInputCommand
  | SetAutoRetryCommand
  | BashCommand
  | AbortBashCommand
  | GenerateSessionTitleCommand;

/** All 26 canonical command types, in stable order. */
export const RUNTIME_COMMAND_TYPES = [
  "prompt",
  "abort",
  "get_state",
  "set_model",
  "fork",
  "navigate_tree",
  "set_thinking_level",
  "compact",
  "set_session_name",
  "get_session_stats",
  "get_last_assistant_text",
  "set_auto_compaction",
  "clear_queue",
  "steer",
  "follow_up",
  "get_tools",
  "get_commands",
  "set_tools",
  "reload",
  "abort_compaction",
  "extension_ui_response",
  "extension_ui_input",
  "set_auto_retry",
  "bash",
  "abort_bash",
  "generate_session_title",
] as const;

export type RuntimeCommandType = (typeof RUNTIME_COMMAND_TYPES)[number];
