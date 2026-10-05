import { MAX_RPC_INBOUND_FRAME_BYTES } from "@fffattiger/pix-protocol";

export interface NdjsonLineDecoderOptions {
  /** Max UTF-8 bytes of one completed line or unfinished remainder. */
  maxFrameBytes?: number;
}

/**
 * Incremental NDJSON splitter for RPC sockets. Decodes UTF-8 across chunks,
 * yields each completed line, then checks the unfinished remainder. A chunk
 * containing several legal frames is accepted even when the chunk total
 * exceeds the per-frame budget.
 */
export class NdjsonLineDecoder {
  private decoder = new TextDecoder("utf8", { fatal: false });
  private buffer = "";
  private readonly maxFrameBytes: number;

  constructor(options: NdjsonLineDecoderOptions = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_RPC_INBOUND_FRAME_BYTES;
  }

  push(chunk: Buffer | Uint8Array): { lines: string[]; overflow: boolean } {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const lines: string[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const raw = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (Buffer.byteLength(line, "utf8") > this.maxFrameBytes) {
        return { lines, overflow: true };
      }
      lines.push(line);
      newline = this.buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxFrameBytes) {
      return { lines, overflow: true };
    }
    return { lines, overflow: false };
  }
}
