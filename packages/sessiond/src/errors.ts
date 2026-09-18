import type { CorrelatedRuntimeCommandResult, CorrelatedRuntimeInterruptResult, ProtocolError, RuntimeCommandResult, RuntimeInterruptResult } from "@fffattiger/pix-protocol";
import { isRuntimeError, type RuntimeErrorCode } from "@fffattiger/pix-runtime-core";

export class SessiondError extends Error {
  constructor(
    readonly code: ProtocolError["code"],
    message: string,
    readonly retryable = false,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "SessiondError";
  }

  toProtocolError(): ProtocolError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function duplicateResultUnavailable(commandId: string, type: RuntimeCommandResult["result"]["type"]): RuntimeCommandResult {
  return { commandId, result: { ok: false, type, error: { code: "command_duplicate", message: "command was already accepted in this epoch but its result is no longer cached", retryable: false } } };
}

export function rejectedCommand(commandId: string, type: RuntimeCommandResult["result"]["type"], message: string): RuntimeCommandResult {
  return { commandId, result: { ok: false, type, error: { code: "command_rejected", message, retryable: false } } };
}

export function unavailableCommand(commandId: string, type: RuntimeCommandResult["result"]["type"], message: string): RuntimeCommandResult {
  return { commandId, result: { ok: false, type, error: { code: "unavailable", message, retryable: true } } };
}

export function unavailableInterrupt(commandId: string, type: RuntimeInterruptResult["type"], message: string): CorrelatedRuntimeInterruptResult {
  return { commandId, result: { ok: false, type, error: { code: "unavailable", message, retryable: true } } };
}

export function rejectedInterrupt(commandId: string, type: RuntimeInterruptResult["type"], message: string): CorrelatedRuntimeInterruptResult {
  return { commandId, result: { ok: false, type, error: { code: "command_rejected", message, retryable: false } } };
}

export function duplicateInterruptUnavailable(commandId: string, type: RuntimeInterruptResult["type"]): CorrelatedRuntimeInterruptResult {
  return { commandId, result: { ok: false, type, error: { code: "command_duplicate", message: "interrupt was already accepted in this epoch but its result is no longer cached", retryable: false } } };
}

/**
 * Phase 5B correlated command failure: the triggering (or blocked) request was
 * PROVEN NOT ADMITTED during a whole-epoch rollover. Retryable: the user can
 * retry after the authoritative `epoch_changed` snapshot. Fixed copy; never
 * auto-executes or silently retries.
 */
export function epochChangedCommand(commandId: string, type: RuntimeCommandResult["result"]["type"]): RuntimeCommandResult {
  return { commandId, result: { ok: false, type, error: { code: "epoch_changed", message: "session epoch changed", retryable: true } } };
}

/** Phase 5B correlated interrupt failure mirroring {@link epochChangedCommand}. */
export function epochChangedInterrupt(commandId: string, type: RuntimeInterruptResult["type"]): CorrelatedRuntimeInterruptResult {
  return { commandId, result: { ok: false, type, error: { code: "epoch_changed", message: "session epoch changed", retryable: true } } };
}

// ---------------------------------------------------------------------------
// RPC boundary error mapping
// ---------------------------------------------------------------------------
//
// Ports below the RPC boundary (e.g. the read-only session catalog) throw
// canonical {@link RuntimeError}-shaped *plain objects* (`{ code, message,
// retryable }`), not `SessiondError` instances. Without an explicit mapping the
// server catch-all collapses every such thrown object to `internal`, hiding a
// legitimate `not_found` and turning a 404 into a 503.
//
// This single helper is the ONLY place that lifts a thrown port value back onto
// a protocol error. It is fail-closed for safety: only a structurally-valid
// canonical RuntimeError carrying a *known preserved* code survives, and it is
// always re-projected onto a FIXED sanitized canonical message + retryable
// (never the raw thrown message, which may reflect external/attacker input such
// as a session id). Anything else — a raw `Error`, a malformed object, or an
// unknown/unrecognized code — collapses to a fixed sanitized `internal` error,
// and no arbitrary code/message/details/stack is ever echoed.

/**
 * Fixed sanitized protocol projection for each preserved canonical runtime
 * error code. The message is a constant canonical string (never the thrown
 * message); `retryable` is the canonical policy for that code.
 */
const CANONICAL_PROTOCOL_ERROR_MAP: Readonly<Record<RuntimeErrorCode, { message: string; retryable: boolean }>> = {
  unsupported_capability: { message: "capability not supported", retryable: false },
  invalid_command: { message: "invalid command", retryable: false },
  invalid_input: { message: "invalid input", retryable: false },
  not_found: { message: "session not found", retryable: false },
  conflict: { message: "session state conflict", retryable: false },
  session_busy: { message: "session is busy", retryable: true },
  interrupted: { message: "operation interrupted", retryable: true },
  timeout: { message: "operation timed out", retryable: true },
  unavailable: { message: "session unavailable", retryable: true },
  external: { message: "external operation failed", retryable: true },
  internal: { message: "internal sessiond error", retryable: false },
};

/** Fixed sanitized internal error: no code/message/details from the thrown value survive. */
const SANITIZED_INTERNAL_PROTOCOL_ERROR: Readonly<ProtocolError> = Object.freeze({
  code: "internal",
  message: "sessiond request failed",
  retryable: false,
});

/**
 * Map a thrown value onto a protocol error at the sessiond RPC boundary.
 *
 * - A {@link SessiondError} is preserved verbatim (its code/message are already
 *   author-controlled and canonical).
 * - A structurally-valid canonical {@link RuntimeError} whose code is a known
 *   preserved runtime error code survives, re-projected onto its fixed
 *   sanitized canonical message + retryable. Its raw message, `cause` and
 *   `details` are dropped (they may reflect external/attacker input).
 * - Everything else (raw `Error`, malformed object, unknown/unrecognized code)
 *   collapses to the fixed sanitized `internal` error; no arbitrary
 *   code/message/details is echoed.
 */
export function toBoundaryProtocolError(error: unknown): ProtocolError {
  if (error instanceof SessiondError) return error.toProtocolError();
  if (isRuntimeError(error)) {
    const canonical = CANONICAL_PROTOCOL_ERROR_MAP[error.code];
    if (canonical) return { code: error.code, message: canonical.message, retryable: canonical.retryable };
  }
  return SANITIZED_INTERNAL_PROTOCOL_ERROR;
}
