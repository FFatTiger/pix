import type { RuntimeError, RuntimeErrorCode } from "@fffattiger/pix-runtime-core";
import { isRuntimeError, makeRuntimeError } from "@fffattiger/pix-runtime-core";

const MAX_DEPTH = 6;
const MAX_ARRAY = 32;
const MAX_KEYS = 64;
const MAX_STRING = 2_048;
const SECRET_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|credential|code)/i;

export function redactText(value: string): string {
  return value
    .slice(0, MAX_STRING)
    .replace(/secret-token-[A-Za-z0-9_-]+/gi, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|credential|code)\s*[:=]\s*)[^\s,;\]}]+/gi, "$1[REDACTED]")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]");
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

export function sanitizeRuntimeError(error: unknown, fallbackKind: "auth" | "backend" = "backend"): RuntimeError {
  if (isRuntimeError(error)) {
    const cause = error.cause === undefined
      ? undefined
      : {
          kind: error.cause.kind,
          ...(error.cause.detail === undefined ? {} : { detail: redactText(error.cause.detail) }),
        };
    const message = redactText(error.message).split("\n")[0] ?? "operation failed";
    const normalizedCode = error.code === "not_found" && /unknown model|unknown .*level|invalid/i.test(message)
      ? "invalid_input"
      : error.code;
    return makeRuntimeError(normalizedCode as RuntimeErrorCode, message, {
      retryable: error.retryable,
      ...(cause === undefined ? {} : { cause }),
      ...(error.details === undefined ? {} : { details: sanitizeUnknown(error.details) }),
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return makeRuntimeError("external", redactText(message).split("\n")[0] ?? "operation failed", {
    cause: { kind: fallbackKind, detail: fallbackKind === "auth" ? "authentication operation failed" : "backend operation failed" },
    ...(error && typeof error === "object" ? { details: sanitizeUnknown(error) } : {}),
  });
}
