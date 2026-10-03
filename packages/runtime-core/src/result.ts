/**
 * Typed result of {@link AgentRuntimePort.execute}.
 *
 * Command-specific payloads are discriminated by `type`; commands without a
 * payload resolve to a bare ack. Failures are always a `RuntimeCommandError`
 * carrying a structured {@link RuntimeError} — never a thrown backend error.
 */
import type { RuntimeCommandType } from "./commands.js";
import type { RuntimeError } from "./errors.js";
import type { PromptDisposition, QueuedInputDisposition } from "./turns.js";
import type { ToolInfo, SlashCommandInfo } from "./resources.js";
import type { SessionStats } from "./session.js";
import type { RuntimeState } from "./state.js";

export type RuntimeCommandOk =
  | { ok: true; type: "get_state"; state: RuntimeState }
  | { ok: true; type: "get_tools"; tools: readonly ToolInfo[] }
  | { ok: true; type: "get_commands"; commands: readonly SlashCommandInfo[] }
  | { ok: true; type: "get_session_stats"; stats: SessionStats }
  | { ok: true; type: "get_last_assistant_text"; text: string }
  | { ok: true; type: "fork"; forkedSessionId: string; forkPointEntryId: string }
  | { ok: true; type: "generate_session_title"; title: string }
  | { ok: true; type: "side_chat_start"; conversationId: string }
  | { ok: true; type: "side_chat_send"; runId: string }
  | { ok: true; type: "side_chat_reset"; conversationId: string }
  | { ok: true; type: "steer"; disposition: QueuedInputDisposition }
  | { ok: true; type: "follow_up"; disposition: QueuedInputDisposition }
  | { ok: true; type: "prompt"; disposition?: PromptDisposition }
  | {
      ok: true;
      type: Exclude<
        RuntimeCommandType,
        | "get_state"
        | "get_tools"
        | "get_commands"
        | "get_session_stats"
        | "get_last_assistant_text"
        | "fork"
        | "generate_session_title"
        | "side_chat_start"
        | "side_chat_send"
        | "side_chat_reset"
        | "steer"
        | "follow_up"
        | "prompt"
      >;
    };

export interface RuntimeCommandError {
  ok: false;
  type: RuntimeCommandType;
  error: RuntimeError;
}

export type RuntimeCommandResult = RuntimeCommandOk | RuntimeCommandError;
