import type { CorrelatedRuntimeCommandResult, CorrelatedRuntimeInterruptResult, ProtocolError, RuntimeCommandResult, RuntimeInterruptResult } from "@fffattiger/pix-protocol";

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
