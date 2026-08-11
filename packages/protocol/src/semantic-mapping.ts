import type { RuntimeCommandType } from "./commands.js";
import type { RuntimeCapability } from "./domain.js";
import type { RuntimeInterruptType } from "./results.js";

/**
 * Protocol-local semantic mapping matrix. It intentionally duplicates stable
 * product semantics instead of importing Runtime Core; mapper contract tests
 * compare both sides in the process packages that depend on them.
 */
export const RUNTIME_COMMAND_CAPABILITY_MATRIX = {
  prompt: "runtime.prompt",
  abort: "runtime.abort",
  get_state: null,
  set_model: "runtime.model.set",
  fork: "runtime.fork",
  navigate_tree: "runtime.navigate",
  set_thinking_level: "runtime.thinking.set",
  compact: "runtime.compact",
  set_session_name: "runtime.session.rename",
  get_session_stats: "runtime.stats",
  get_last_assistant_text: null,
  set_auto_compaction: "runtime.compact",
  clear_queue: "runtime.queue",
  steer: "runtime.steer",
  follow_up: "runtime.follow_up",
  get_tools: "runtime.tools.read",
  get_commands: null,
  set_tools: "runtime.tools.write",
  reload: "runtime.reload",
  abort_compaction: "runtime.compact.abort",
  extension_ui_response: "runtime.extension_ui",
  extension_ui_input: "runtime.extension_ui",
  set_auto_retry: "runtime.queue",
  bash: "runtime.bash",
  abort_bash: "runtime.bash.abort",
  generate_session_title: "runtime.auto_name",
} as const satisfies Readonly<Record<RuntimeCommandType, RuntimeCapability | null>>;

export const RUNTIME_INTERRUPT_CAPABILITY_MATRIX = {
  abort: "runtime.abort",
  abort_compaction: "runtime.compact.abort",
  abort_bash: "runtime.bash.abort",
  clear_queue: "runtime.queue",
} as const satisfies Readonly<Record<RuntimeInterruptType, RuntimeCapability>>;

/** Stable mapper responsibilities exercised by protocol-local fixtures. */
export const ACL0_PROTOCOL_SEMANTIC_MATRIX = {
  commandCorrelation: "Protocol commandId -> Runtime command without commandId",
  eventCursor: "Runtime event data -> sessiond epoch/eventId envelope",
  partialStreaming: "Runtime StreamingAgentMessage <-> Protocol streaming DTO",
  queuedImages: "Runtime QueuedTurn images <-> Protocol QueuedTurn images",
  recoverableBash: "Runtime BashProjection <-> Protocol BashProjection",
  recoverableCompaction: "Runtime CompactionProjection <-> Protocol CompactionProjection",
  extensionCorrelation: "Runtime extension request id <-> response/input id",
  commandResult: "RuntimeCommandResult <-> method-bound correlated result",
  interruptResult: "RuntimeInterruptResult <-> independent interrupt wire result",
  dualAuth: "Runtime AuthProviderInfo.methods <-> Protocol methods[]",
  sessionEntries: "Runtime entryId/parentEntryId <-> Protocol session entries",
} as const;
