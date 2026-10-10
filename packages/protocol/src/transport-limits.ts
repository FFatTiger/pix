import { MAX_IMAGE_BASE64_LENGTH } from "./common.js";

/**
 * Protocol-owned runtime transport capacity, introduced in sessiond contract
 * v9 / worker contract v8. Live image-bearing frames keep inline image content; this is
 * an aggregate whole-frame bound, not a per-image multiplier.
 *
 * Frame body: one currently supported image (`MAX_IMAGE_BASE64_LENGTH`) plus
 * the historical 2 MiB envelope/other-content allowance. Queue bytes: two
 * maximum frames including their NDJSON newlines. Frame-count bounds stay at
 * 256. Independent control/history budgets are owned separately and MUST NOT
 * be raised to this runtime capacity:
 *
 * - RPC inbound AUTH and non-image control requests remain 2 MiB.
 * - Image-bearing `runtime.submitTurn` / `runtime.command` (prompt/steer/
 *   follow_up with nonempty images) may use this runtime frame bound.
 * - Lightweight `sessions.context` history remains the previous 4 MiB
 *   newline-inclusive outbound writer budget, even when media is not deferred.
 * - Host inbound WebSocket `maxPayload` follows this runtime frame bound so
 *   image-bearing ingress can arrive; AUTH/control/history stay independent.
 *
 * Delimiters count on queued bytes. Encoded UTF-8 bytes of the final
 * serialized envelope are checked at each owner. Downstream wrapping may
 * still reject honestly if an inner-full frame crosses the bound after
 * envelope metadata is added.
 */
export const MAX_RUNTIME_FRAME_BYTES = MAX_IMAGE_BASE64_LENGTH + 2 * 1024 * 1024;
export const MAX_RUNTIME_FRAME_COUNT = 256;
export const MAX_RUNTIME_QUEUED_BYTES = 2 * (MAX_RUNTIME_FRAME_BYTES + 1);

/** Explicit 2 MiB inbound RPC control/request budget. Does not carry read-output. */
export const MAX_RPC_INBOUND_FRAME_BYTES = 2 * 1024 * 1024;

/**
 * Lightweight history method budget: the previous RPC serial-writer effective
 * cap (4 MiB including the trailing newline). Raising the live-media writer
 * must not silently enlarge `sessions.context` responses.
 */
export const MAX_HISTORY_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Host inbound WebSocket payload for image-bearing runtime ingress. Independent AUTH/control/history budgets stay smaller. */
export const MAX_HOST_INBOUND_WS_BYTES = MAX_RUNTIME_FRAME_BYTES;

export const utf8ByteLength = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

export const isWithinRuntimeFrameBudget = (encodedFrame: string): boolean =>
  utf8ByteLength(encodedFrame) <= MAX_RUNTIME_FRAME_BYTES;

function isNonemptyImageArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/** True only for validated image-bearing submitTurn / prompt / steer / follow_up. */
export const isImageBearingRuntimeRpcRequest = (request: {
  method: string;
  params: unknown;
}): boolean => {
  if (request.method === "runtime.submitTurn") {
    const params = request.params as { images?: unknown } | null;
    return isNonemptyImageArray(params?.images);
  }
  if (request.method !== "runtime.command") return false;
  const command = (request.params as { command?: { type?: unknown; images?: unknown } } | null)?.command;
  return (
    (command?.type === "prompt" || command?.type === "steer" || command?.type === "follow_up")
    && isNonemptyImageArray(command.images)
  );
};

export const inboundRpcFrameBudgetFor = (request: {
  method: string;
  params: unknown;
}): number =>
  isImageBearingRuntimeRpcRequest(request) ? MAX_RUNTIME_FRAME_BYTES : MAX_RPC_INBOUND_FRAME_BYTES;
