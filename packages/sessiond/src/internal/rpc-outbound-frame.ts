import { MAX_RUNTIME_FRAME_BYTES } from "@fffattiger/pix-protocol";
import { SessiondError } from "../errors.js";
import type { SerialSocketWriter } from "./serial-writer.js";

/** Body budget excludes the mandatory NDJSON newline; queued bytes still include it. */
export const rpcOutboundBodyBytes = (frame: string): number => {
  if (frame.length === 0 || frame[frame.length - 1] !== "\n") return Number.POSITIVE_INFINITY;
  return Buffer.byteLength(frame, "utf8") - 1;
};

export const enqueueRpcOutboundFrame = (
  writer: SerialSocketWriter,
  frame: string,
  maxOutboundBodyBytes = MAX_RUNTIME_FRAME_BYTES,
  flushedTimeoutMs?: number,
): Promise<void> => {
  if (rpcOutboundBodyBytes(frame) > maxOutboundBodyBytes) {
    const error = new SessiondError("unavailable", "RPC outbound frame exceeds the size limit", true);
    writer.close(error);
    return Promise.reject(error);
  }
  return flushedTimeoutMs === undefined ? writer.enqueue(frame) : writer.enqueueFlushed(frame, flushedTimeoutMs);
};
