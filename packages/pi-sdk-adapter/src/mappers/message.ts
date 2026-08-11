import type {
  AgentMessage,
  AssistantContentBlock,
  ImageContent,
  RuntimeError,
  StreamingAgentMessage,
  TokenUsage,
  UserContent,
} from "@fffattiger/pix-runtime-core";
import { sanitizeRuntimeError, sanitizeUnknown } from "../internal/sanitize.js";

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]+\b/g,
  /\b(?:api[_-]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi,
  /secret-token-[a-z0-9]+/gi,
];

function sanitizeString(value: string): string {
  let sanitized = value.split("\n")[0] ?? "";
  for (const pattern of SECRET_PATTERNS) sanitized = sanitized.replace(pattern, "[REDACTED]");
  return sanitized;
}

export function sanitizeValue(value: unknown): unknown {
  return sanitizeUnknown(value);
}

export function mapDriverError(error: unknown, fallbackCode: RuntimeError["code"] = "external"): RuntimeError {
  if (error && typeof error === "object" && typeof (error as Record<string, unknown>).code === "string" && typeof (error as Record<string, unknown>).retryable === "boolean") {
    return sanitizeRuntimeError(error);
  }
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const message = error instanceof Error
    ? error.message
    : typeof record.message === "string"
      ? record.message
      : String(error);
  const lower = message.toLowerCase();
  const code: RuntimeError["code"] =
    lower.includes("abort") || lower.includes("cancel") ? "interrupted" :
    lower.includes("not found") || lower.includes("unknown model") ? "invalid_input" :
    lower.includes("busy") || lower.includes("running") ? "session_busy" :
    lower.includes("timeout") ? "timeout" : fallbackCode;
  const kind = lower.includes("auth") || lower.includes("api key") ? "auth" :
    lower.includes("model") ? "model" :
    lower.includes("file") || lower.includes("path") ? "file" :
    lower.includes("network") || lower.includes("fetch") || lower.includes("rate") ? "network" :
    lower.includes("tool") ? "tool" : "backend";
  return sanitizeRuntimeError({
    code,
    message,
    retryable: code === "session_busy" || code === "timeout" || kind === "network",
    cause: { kind, detail: "mapped by Pi SDK adapter" },
    details: record.details ?? record.cause ?? { sanitized: true },
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function mapUsage(value: unknown): TokenUsage | undefined {
  const usage = asRecord(value);
  if (Object.keys(usage).length === 0) return undefined;
  const cost = asRecord(usage.cost);
  return {
    input: numberOrZero(usage.input),
    output: numberOrZero(usage.output),
    cacheRead: numberOrZero(usage.cacheRead),
    cacheWrite: numberOrZero(usage.cacheWrite),
    cost: {
      input: numberOrZero(cost.input),
      output: numberOrZero(cost.output),
      cacheRead: numberOrZero(cost.cacheRead),
      cacheWrite: numberOrZero(cost.cacheWrite),
      total: numberOrZero(cost.total),
    },
  };
}

function mapImage(value: unknown): ImageContent | null {
  const image = asRecord(value);
  if (image.type !== "image") return null;
  const source = asRecord(image.source);
  if (source.type === "base64" || (typeof image.data === "string" && typeof image.mimeType === "string")) {
    return {
      type: "image",
      source: {
        type: "base64",
        ...(typeof source.media_type === "string"
          ? { media_type: source.media_type }
          : typeof image.mimeType === "string"
            ? { media_type: image.mimeType }
            : {}),
        ...(typeof source.data === "string"
          ? { data: source.data }
          : typeof image.data === "string"
            ? { data: image.data }
            : {}),
      },
    };
  }
  if (source.type === "url" || typeof source.url === "string") {
    return { type: "image", source: { type: "url", ...(typeof source.url === "string" ? { url: source.url } : {}) } };
  }
  return null;
}

function mapUserContent(value: unknown): UserContent {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const result: Exclude<UserContent, string>[number][] = [];
  for (const raw of value) {
    const block = asRecord(raw);
    if (block.type === "text" && typeof block.text === "string") {
      result.push({ type: "text", text: block.text });
      continue;
    }
    const image = mapImage(raw);
    if (image) result.push(image);
  }
  return result;
}

function mapAssistantBlocks(value: unknown): AssistantContentBlock[] {
  if (!Array.isArray(value)) return [];
  const result: AssistantContentBlock[] = [];
  for (const raw of value) {
    const block = asRecord(raw);
    if (block.type === "text" && typeof block.text === "string") {
      result.push({ type: "text", text: block.text });
      continue;
    }
    if ((block.type === "thinking" || block.type === "reasoning") && typeof (block.thinking ?? block.text) === "string") {
      result.push({ type: "thinking", thinking: String(block.thinking ?? block.text), ...(typeof block.deferred === "boolean" ? { deferred: block.deferred } : {}) });
      continue;
    }
    if ((block.type === "toolCall" || block.type === "tool_call") && typeof (block.toolCallId ?? block.id) === "string" && typeof (block.toolName ?? block.name) === "string") {
      result.push({ type: "toolCall", toolCallId: String(block.toolCallId ?? block.id), toolName: String(block.toolName ?? block.name), input: block.input ?? block.arguments ?? {} });
      continue;
    }
    const image = mapImage(raw);
    if (image) result.push(image);
  }
  return result;
}

export function mapMessage(value: unknown, partial = false): AgentMessage | StreamingAgentMessage {
  const message = asRecord(value);
  switch (message.role) {
    case "user":
      return { role: "user", content: mapUserContent(message.content), ...(typeof message.timestamp === "number" ? { timestamp: message.timestamp } : {}) };
    case "assistant": {
      const base = {
        role: "assistant" as const,
        content: mapAssistantBlocks(message.content),
        ...(typeof message.model === "string" ? { model: message.model } : partial ? {} : { model: "unknown" }),
        ...(typeof message.provider === "string" ? { provider: message.provider } : partial ? {} : { provider: "unknown" }),
        ...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
        ...(typeof message.errorMessage === "string" ? { errorMessage: sanitizeString(message.errorMessage) } : {}),
        ...(typeof message.timestamp === "number" ? { timestamp: message.timestamp } : {}),
        ...(mapUsage(message.usage) ? { usage: mapUsage(message.usage)! } : {}),
        ...(Array.isArray(message.writtenFiles) ? { writtenFiles: message.writtenFiles.filter((item): item is string => typeof item === "string") } : {}),
      };
      return base;
    }
    case "toolResult":
    case "tool_result":
      return {
        role: "toolResult",
        ...(typeof (message.toolCallId ?? message.tool_call_id) === "string" ? { toolCallId: String(message.toolCallId ?? message.tool_call_id) } : partial ? {} : { toolCallId: "unknown" }),
        ...(typeof (message.toolName ?? message.tool_name) === "string" ? { toolName: String(message.toolName ?? message.tool_name) } : {}),
        content: Array.isArray(message.content) ? mapUserContent(message.content) as Exclude<UserContent, string> : [{ type: "text", text: String(message.content ?? "") }],
        ...(typeof message.isError === "boolean" ? { isError: message.isError } : {}),
        ...(message.details === undefined ? {} : { details: sanitizeValue(message.details) }),
        ...(typeof message.timestamp === "number" ? { timestamp: message.timestamp } : {}),
      };
    case "bashExecution":
    case "bash_execution":
      return {
        role: "bashExecution",
        ...(typeof message.command === "string" ? { command: message.command } : partial ? {} : { command: "" }),
        ...(typeof message.output === "string" ? { output: message.output } : partial ? {} : { output: "" }),
        ...(typeof message.exitCode === "number" ? { exitCode: message.exitCode } : {}),
        ...(typeof message.cancelled === "boolean" ? { cancelled: message.cancelled } : {}),
        ...(typeof message.truncated === "boolean" ? { truncated: message.truncated } : {}),
        ...(typeof message.fullOutputPath === "string" ? { fullOutputPath: message.fullOutputPath } : {}),
        ...(typeof message.excludeFromContext === "boolean" ? { excludeFromContext: message.excludeFromContext } : {}),
      } as AgentMessage | StreamingAgentMessage;
    default:
      return {
        role: "custom",
        ...(typeof message.customType === "string" ? { customType: message.customType } : partial ? {} : { customType: "unknown" }),
        content: mapUserContent(message.content),
        display: typeof message.display === "boolean" ? message.display : true,
        ...(message.details === undefined ? {} : { details: sanitizeValue(message.details) }),
      } as AgentMessage | StreamingAgentMessage;
  }
}
