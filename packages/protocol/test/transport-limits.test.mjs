import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  ADAPTER_CONTRACT_VERSION,
  MAX_HISTORY_RESPONSE_BYTES,
  MAX_HOST_INBOUND_WS_BYTES,
  MAX_IMAGE_BASE64_LENGTH,
  MAX_RPC_INBOUND_FRAME_BYTES,
  MAX_RUNTIME_FRAME_BYTES,
  MAX_RUNTIME_FRAME_COUNT,
  MAX_RUNTIME_QUEUED_BYTES,
  PROTOCOL_VERSION,
  SESSIOND_CONTRACT_VERSION,
  WORKER_CONTRACT_VERSION,
  isWithinRuntimeFrameBudget,
  utf8ByteLength,
} from "../dist/index.js";

const MiB = 1024 * 1024;

describe("Protocol runtime transport limits", () => {
  it("owns the aggregate runtime frame and two-frame queue budget", () => {
    assert.equal(MAX_RUNTIME_FRAME_BYTES, MAX_IMAGE_BASE64_LENGTH + 2 * MiB);
    assert.equal(MAX_RUNTIME_FRAME_BYTES, 16_097_152);
    assert.equal(MAX_RUNTIME_FRAME_COUNT, 256);
    assert.equal(MAX_RUNTIME_QUEUED_BYTES, 2 * (MAX_RUNTIME_FRAME_BYTES + 1));
    assert.equal(isWithinRuntimeFrameBudget("x".repeat(MAX_RUNTIME_FRAME_BYTES)), true);
    assert.equal(isWithinRuntimeFrameBudget("x".repeat(MAX_RUNTIME_FRAME_BYTES + 1)), false);
  });

  it("keeps inbound control and lightweight history independent of runtime capacity", () => {
    assert.equal(MAX_RPC_INBOUND_FRAME_BYTES, 2 * MiB);
    assert.equal(MAX_HISTORY_RESPONSE_BYTES, 4 * MiB);
    assert.equal(MAX_HOST_INBOUND_WS_BYTES, MiB);
    assert.ok(MAX_RPC_INBOUND_FRAME_BYTES < MAX_RUNTIME_FRAME_BYTES);
    assert.ok(MAX_HISTORY_RESPONSE_BYTES < MAX_RUNTIME_FRAME_BYTES);
    assert.ok(MAX_HOST_INBOUND_WS_BYTES < MAX_RUNTIME_FRAME_BYTES);
  });

  it("counts UTF-8 bytes, including multibyte code points", () => {
    assert.equal(utf8ByteLength("é"), 2);
    assert.equal(utf8ByteLength("😀"), 4);
    assert.equal(utf8ByteLength("A".repeat(MAX_RUNTIME_FRAME_BYTES)), MAX_RUNTIME_FRAME_BYTES);
    assert.equal(isWithinRuntimeFrameBudget("é".repeat(MAX_RUNTIME_FRAME_BYTES / 2)), true);
    assert.equal(isWithinRuntimeFrameBudget("é".repeat(MAX_RUNTIME_FRAME_BYTES / 2 + 1)), false);
  });

  it("uses Protocol v2 and the integrated image/questionnaire build generations", () => {
    assert.equal(PROTOCOL_VERSION, 2);
    assert.equal(ADAPTER_CONTRACT_VERSION, 8);
    assert.equal(SESSIOND_CONTRACT_VERSION, 10);
    assert.equal(WORKER_CONTRACT_VERSION, 9);
  });
});

describe("PNG-equivalent image envelope capacity", () => {
  it("accepts a 2.1MB PNG-equivalent valid image and rejects one-over the aggregate frame", () => {
    // Synthetic PNG-equivalent: 2,108,283 decoded bytes (original parent PNG
    // size) as canonical base64. Never a user-image literal fixture.
    const decodedBytes = 2_108_283;
    const data = Buffer.alloc(decodedBytes, 0x41).toString("base64");
    const digest = createHash("sha256").update(data).digest("hex");
    const envelope = JSON.stringify({
      type: "worker.event",
      payload: {
        sessionId: "s1",
        event: {
          type: "message_start",
          sessionId: "s1",
          streamId: "st1",
          messageId: "m1",
          message: {
            role: "toolResult",
            toolCallId: "t1",
            content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }],
          },
        },
      },
    });
    const bytes = Buffer.byteLength(envelope, "utf8");
    assert.ok(bytes > 2 * MiB, `PNG-equivalent frame must exceed the old 2 MiB cap, got ${bytes}`);
    assert.ok(bytes <= MAX_RUNTIME_FRAME_BYTES, `PNG-equivalent frame must fit the new runtime cap, got ${bytes}`);
    assert.equal(isWithinRuntimeFrameBudget(envelope), true);
    assert.equal(digest.length, 64);
    assert.equal(isWithinRuntimeFrameBudget("x".repeat(MAX_RUNTIME_FRAME_BYTES + 1)), false);
  });
});
