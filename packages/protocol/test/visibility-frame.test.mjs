import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PUSH_ENDPOINT_HASH_PATTERN,
  WsClientMessageSchema,
  WsVisibilityMessageSchema,
} from "../dist/index.js";

// The `visibility` frame carries per-device push suppression data: `attended`
// (page visible AND focused) and the SHA-256 hex of this browser's push
// endpoint. Both are optional so a legacy boolean-only report still parses.

const HASH = "4e9bdab8bbe7189c00aebb0922fc49fe40e00594c400f3e1b5dcf97a35c79f85";

describe("WsVisibilityMessageSchema (per-device suppression fields)", () => {
  it("accepts the legacy boolean-only report (back-compat)", () => {
    assert.equal(WsVisibilityMessageSchema.safeParse({ type: "visibility", payload: { visible: true } }).success, true);
    assert.equal(WsVisibilityMessageSchema.safeParse({ type: "visibility", payload: { visible: false } }).success, true);
  });

  it("accepts the full attended report with an endpoint hash", () => {
    const parsed = WsVisibilityMessageSchema.safeParse({
      type: "visibility",
      payload: { visible: true, attended: true, pushEndpointHash: HASH },
    });
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.success && parsed.data.payload, { visible: true, attended: true, pushEndpointHash: HASH });
  });

  it("accepts attended without a hash (no push mapping — suppresses nothing)", () => {
    assert.equal(
      WsVisibilityMessageSchema.safeParse({ type: "visibility", payload: { visible: true, attended: true } }).success,
      true,
    );
  });

  it("rejects malformed endpoint hashes fail-closed (wrong length, non-hex, uppercase)", () => {
    for (const bad of ["XYZ", HASH.slice(0, 63), HASH.toUpperCase(), `${HASH}0`, ""]) {
      assert.equal(
        WsVisibilityMessageSchema.safeParse({ type: "visibility", payload: { visible: true, attended: true, pushEndpointHash: bad } }).success,
        false,
        `hash "${bad}" must be rejected`,
      );
    }
  });

  it("rejects unknown fields and wrong types (strict)", () => {
    assert.equal(WsVisibilityMessageSchema.safeParse({ type: "visibility", payload: { visible: true, endpoint: "https://push" } }).success, false);
    assert.equal(WsVisibilityMessageSchema.safeParse({ type: "visibility", payload: { visible: "yes" } }).success, false);
    assert.equal(WsVisibilityMessageSchema.safeParse({ type: "visibility", payload: { visible: true, attended: "yes" } }).success, false);
  });

  it("participates in the client message union with the same semantics", () => {
    assert.equal(
      WsClientMessageSchema.safeParse({ type: "visibility", payload: { visible: true, attended: false, pushEndpointHash: HASH } }).success,
      true,
    );
    assert.equal(WsClientMessageSchema.safeParse({ type: "visibility", payload: { visible: true, pushEndpointHash: "nope" } }).success, false);
  });

  it("the hash pattern is exactly 64 lowercase hex chars", () => {
    assert.equal(PUSH_ENDPOINT_HASH_PATTERN.test(HASH), true);
    assert.equal(PUSH_ENDPOINT_HASH_PATTERN.test(HASH.toUpperCase()), false);
  });
});
