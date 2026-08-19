import { SessiondError } from "../errors.js";

/**
 * Incremental, byte-bounded, newline-delimited line decoder used by both the
 * sessiond RPC server and client transports. Exists so that:
 *  - inbound frames on both sides are counted in UTF-8 **bytes** (a single
 *    line/frame is capped at `maxLineBytes`);
 *  - a peer that streams an endless line without a newline cannot exhaust
 *    memory (the retained incomplete line is capped by `maxLineBytes`);
 *  - a UTF-8 sequence split across socket `data` chunks is reassembled
 *    correctly (the decoder appends raw bytes and splits only on `\n`);
 *  - multiple frames coalesced in one `data` chunk are emitted in order.
 *
 * Lines are returned as UTF-8 strings; an incomplete frame (no trailing
 * newline) is retained as the pending buffer. `pending` always holds at most
 * one incomplete line, so the pending total is automatically bounded by
 * `maxLineBytes`. This is the single, shared implementation for frame splitting
 * so the server and client cannot drift apart in their bounds or behavior.
 *
 * Fail-closed: exceeding the per-line byte bound returns an error and yields
 * no lines — callers must destroy the connection; the decoder never silently
 * truncates or fabricates a frame.
 */
export interface DecodeResult {
  lines: string[];
  /** Set exactly once when a byte bound is violated; the caller must fail closed. */
  error: Error | undefined;
  /** Bytes currently retained awaiting a trailing newline. */
  pendingBytes: number;
}

export class ByteLineDecoder {
  private pending: Buffer = Buffer.alloc(0);
  private readonly maxLineBytes: number;

  constructor(options: { maxLineBytes: number; maxPendingBytes?: number }) {
    if (!Number.isSafeInteger(options.maxLineBytes) || options.maxLineBytes < 1) {
      throw new RangeError("maxLineBytes must be a positive safe integer");
    }
    this.maxLineBytes = options.maxLineBytes;
    // Historical API compatibility: the caller may pass a separate pending cap,
    // but since we retain at most one incomplete (sub-line-bound) frame the line
    // bound is the effective cap. Accept and ignore a larger value.
    void options.maxPendingBytes;
  }

  get pendingBytes(): number {
    return this.pending.length;
  }

  /** Append a raw chunk and return the complete newline-terminated lines in order. */
  push(chunk: Uint8Array): DecodeResult {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const lines: string[] = [];
    // Work on the combined buffer once; scan forwards splitting on newlines,
    // but enforce the per-line bound on every candidate line (including one
    // that started in a previous push, so a packet can never smuggle an
    // oversized frame past the limit by splitting it across `data` events).
    let source = buf;
    let carry = this.pending;
    this.pending = Buffer.alloc(0);
    while (true) {
      if (carry.length > this.maxLineBytes) {
        return { lines: [], error: new SessiondError("unavailable", "sessiond frame exceeds the maximum allowed size", true), pendingBytes: 0 };
      }
      const nl = source.indexOf(0x0a);
      if (nl === -1) {
        // No newline in the remaining source → this completes one more
        // (incomplete) line = concatenation of carry and source.
        const partial = carry.length === 0 ? source : Buffer.concat([carry, source]);
        if (partial.length > this.maxLineBytes) {
          return { lines: [], error: new SessiondError("unavailable", "sessiond frame exceeds the maximum allowed size", true), pendingBytes: 0 };
        }
        this.pending = partial;
        return { lines, error: undefined, pendingBytes: partial.length };
      }
      // A newline at `nl`: the line is carry + source[0..nl].
      const tail = source.subarray(nl + 1);
      const lineBody = carry.length === 0 ? source.subarray(0, nl) : Buffer.concat([carry, source.subarray(0, nl)]);
      if (lineBody.length > this.maxLineBytes) {
        return { lines: [], error: new SessiondError("unavailable", "sessiond frame exceeds the maximum allowed size", true), pendingBytes: 0 };
      }
      lines.push(lineBody.toString("utf8"));
      carry = Buffer.alloc(0);
      source = tail;
      if (source.length === 0) {
        this.pending = Buffer.alloc(0);
        return { lines, error: undefined, pendingBytes: 0 };
      }
    }
  }
}
