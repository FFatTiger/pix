/**
 * Structured runtime errors.
 *
 * Adapters must never leak raw SDK error classes, stacks or secrets across
 * this boundary. Every failure is projected into a `RuntimeError` with a
 * canonical code, a sanitized message and an explicit retryable flag.
 */

export type RuntimeErrorCode =
  | "unsupported_capability"
  | "invalid_command"
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "session_busy"
  | "interrupted"
  | "timeout"
  | "unavailable"
  | "external"
  | "internal";

/** Neutral category of a mapped external failure (never a backend identifier). */
export type ExternalErrorKind =
  | "auth"
  | "network"
  | "file"
  | "model"
  | "tool"
  | "backend"
  | "unknown";

export interface ExternalErrorCause {
  kind: ExternalErrorKind;
  /** Short sanitized detail. Never raw stacks or secrets. */
  detail?: string;
}

export interface RuntimeError {
  code: RuntimeErrorCode;
  /** Sanitized, human-readable message (no secrets, no SDK internals). */
  message: string;
  /** Whether retrying the same operation may succeed later. */
  retryable: boolean;
  /** Optional mapped external cause. */
  cause?: ExternalErrorCause;
  /** Optional structured, serializable, sanitized details. */
  details?: unknown;
}

export function isRuntimeError(value: unknown): value is RuntimeError {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.code === "string" &&
    typeof record.message === "string" &&
    typeof record.retryable === "boolean"
  );
}

export function makeRuntimeError(
  code: RuntimeErrorCode,
  message: string,
  options?: { retryable?: boolean; cause?: ExternalErrorCause; details?: unknown },
): RuntimeError {
  return {
    code,
    message,
    retryable: options?.retryable ?? false,
    ...(options?.cause === undefined ? {} : { cause: options.cause }),
    ...(options?.details === undefined ? {} : { details: options.details }),
  };
}

export function unsupportedCapabilityError(capability: string): RuntimeError {
  return makeRuntimeError(
    "unsupported_capability",
    `capability not supported: ${capability}`,
  );
}

export function invalidInputError(message: string, details?: unknown): RuntimeError {
  return makeRuntimeError("invalid_input", message, { details });
}
