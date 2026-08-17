/**
 * Structured error projection for the agent worker.
 *
 * Maps Core {@link RuntimeError} values and raw backend errors into the frozen
 * Protocol {@link ProtocolError} wire shape. Sanitization is recursive: no
 * stack, secret, credential or filesystem path is ever leaked across the
 * process boundary. Runtime error codes map one-to-one onto Protocol codes;
 * raw/unknown failures become a sanitized `internal` error.
 */
import type { ProtocolError, ProtocolErrorCode } from "@fffattiger/pix-protocol";
import { isRuntimeError, type ExternalErrorCause, type RuntimeError, type RuntimeErrorCode } from "@fffattiger/pix-runtime-core";

const MAX_DEPTH = 6;
const MAX_ARRAY = 32;
const MAX_KEYS = 64;
const MAX_STRING = 2_048;
const SECRET_KEY =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|credential|code)/i;
/** POSIX absolute paths with at least two segments. */
const POSIX_PATH_PATTERN = /(?:^|[\s(=\[{,])((?:\/[\w.@-]+){2,})/g;
/** Windows drive, UNC, extended, and file:// URL forms. */
const WINDOWS_PATH_PATTERN =
  /(?:^|[\s(=\[{,])((?:[A-Za-z]:[\\/][^\s,;}\])'"]+|\\\\[^\s,;}\])'"]+|\/\/\?\/[A-Za-z]:[^\s,;}\])'"]+|file:\/\/[A-Za-z]:[^\s,;}\])'"]+|file:\/\/\/[^\s,;}\])'"]+))/g;

export function redactText(value: string): string {
  return value
    .slice(0, MAX_STRING)
    .replace(/secret-token-[A-Za-z0-9_-]+/gi, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|credential|code)\s*[:=]\s*)[^\s,;}\])]+/gi,
      "$1[REDACTED]",
    )
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(WINDOWS_PATH_PATTERN, (match, path) => match.replace(path, "[path]"))
    .replace(POSIX_PATH_PATTERN, (match, path) => match.replace(path, "[path]"));
}

export function sanitizeUnknown(value: unknown, depth = 0, key?: string): unknown {
  if (SECRET_KEY.test(key ?? "")) return "[REDACTED]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactText(value);
  if (depth >= MAX_DEPTH) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((item) => sanitizeUnknown(item, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redactText(value.message) };
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value).slice(0, MAX_KEYS)) {
      if (childKey === "stack") continue;
      result[childKey] = sanitizeUnknown(child, depth + 1, childKey);
    }
    return result;
  }
  return String(value).slice(0, MAX_STRING);
}

/** One-line a message and redact secrets/paths. */
export function sanitizeMessage(message: string): string {
  const firstLine = redactText(message).split("\n")[0];
  return (firstLine ?? "").trim() || "operation failed";
}

const RUNTIME_TO_PROTOCOL_CODE: Readonly<Record<RuntimeErrorCode, ProtocolErrorCode>> = {
  unsupported_capability: "unsupported_capability",
  invalid_command: "invalid_command",
  invalid_input: "invalid_input",
  not_found: "not_found",
  conflict: "conflict",
  session_busy: "session_busy",
  interrupted: "interrupted",
  timeout: "timeout",
  unavailable: "unavailable",
  external: "external",
  internal: "internal",
};

function mapCause(cause: ExternalErrorCause | undefined) {
  if (cause === undefined) return undefined;
  const detail =
    cause.detail === undefined ? undefined : sanitizeMessage(cause.detail);
  if (detail === undefined) return { kind: cause.kind };
  return { kind: cause.kind, detail };
}

/** Map a Core {@link RuntimeError} to the Protocol wire error (codes map 1:1). */
export function runtimeErrorToProtocolError(error: RuntimeError): ProtocolError {
  const cause = mapCause(error.cause);
  const protocol: ProtocolError = {
    code: RUNTIME_TO_PROTOCOL_CODE[error.code],
    message: sanitizeMessage(error.message),
    retryable: error.retryable,
    ...(cause === undefined ? {} : { cause }),
    ...(error.details === undefined ? {} : { details: sanitizeUnknown(error.details) }),
  };
  return protocol;
}

/**
 * Map any thrown value (factory/raw/unknown) to a sanitized Protocol error.
 * RuntimeError values keep their explicit code; everything else becomes a
 * sanitized `internal` error so no stack/secret/path can escape.
 */
export function toProtocolError(error: unknown, fallbackCode: ProtocolErrorCode = "internal"): ProtocolError {
  if (isRuntimeError(error)) return runtimeErrorToProtocolError(error);
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "unexpected worker failure";
  return {
    code: fallbackCode,
    message: sanitizeMessage(message),
    retryable: false,
  };
}

/** Build a canonical Protocol error inline (sanitized message). */
export function protocolError(
  code: ProtocolErrorCode,
  message: string,
  retryable = false,
): ProtocolError {
  return { code, message: sanitizeMessage(message), retryable };
}
