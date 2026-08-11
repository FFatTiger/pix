/**
 * Typed result of {@link AgentRuntimePort.execute}.
 *
 * Command-specific payloads are discriminated by `type`; commands without a
 * payload resolve to a bare ack. Failures are always a `RuntimeCommandError`
 * carrying a structured {@link RuntimeError} — never a thrown backend error.
 */
import type { RuntimeCommandType } from "./commands.js";
import type { RuntimeError } from "./errors.js";
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
      >;
    };

export interface RuntimeCommandError {
  ok: false;
  type: RuntimeCommandType;
  error: RuntimeError;
}

export type RuntimeCommandResult = RuntimeCommandOk | RuntimeCommandError;
