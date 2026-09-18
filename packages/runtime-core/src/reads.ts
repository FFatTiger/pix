/**
 * Canonical runtime read domain (Phase 2B independent read RPC).
 *
 * Reads are pure queries over the runtime projection that must never consume
 * the epoch's finite mutation at-most-once admission ledger. They share the
 * command vocabulary with the legacy command path (`get_state`,
 * `get_session_stats`, `get_last_assistant_text`, `get_tools`, `get_commands`)
 * but travel on an independent, bounded read lane with its own identity
 * (`sessionId + epoch + requestId`), separate timeout and separate result
 * cache — a read flood can never block a prompt or exhaust command capacity.
 *
 * Like {@link RuntimeCommand}, these requests deliberately carry **no wire
 * `commandId`**: correlation is a transport concern of the Runtime Protocol
 * (see D-012) and belongs to the Protocol layer, not the application
 * boundary. Adapters receive these requests from the Worker application
 * controller via {@link AgentRuntimePort.read} and translate them to backend
 * reads.
 */
import type { RuntimeError } from "./errors.js";
import type { SlashCommandInfo, ToolInfo } from "./resources.js";
import type { SessionStats } from "./session.js";
import type { RuntimeState } from "./state.js";

/** The five read-only command types that travel on the independent read lane. */
export type RuntimeReadType =
  | "get_state"
  | "get_session_stats"
  | "get_last_assistant_text"
  | "get_tools"
  | "get_commands";

/** Canonical read request (no wire correlation id). */
export type RuntimeReadRequest =
  | { type: "get_state" }
  | { type: "get_session_stats" }
  | { type: "get_last_assistant_text" }
  | { type: "get_tools" }
  | { type: "get_commands" };

export type RuntimeReadOk =
  | { ok: true; type: "get_state"; state: RuntimeState }
  | { ok: true; type: "get_session_stats"; stats: SessionStats }
  | { ok: true; type: "get_last_assistant_text"; text: string }
  | { ok: true; type: "get_tools"; tools: readonly ToolInfo[] }
  | { ok: true; type: "get_commands"; commands: readonly SlashCommandInfo[] };

export interface RuntimeReadFailure {
  ok: false;
  type: RuntimeReadType;
  error: RuntimeError;
}

/**
 * Result of {@link AgentRuntimePort.read}. Mirrors
 * {@link RuntimeCommandResult}: successes carry typed payloads, failures are
 * always structured {@link RuntimeError} outcomes — never a thrown backend
 * error.
 */
export type RuntimeReadResult = RuntimeReadOk | RuntimeReadFailure;
