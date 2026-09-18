import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProtocolErrorSchema } from "@fffattiger/pix-protocol";
import {
  protocolError,
  redactText,
  runtimeErrorToProtocolError,
  sanitizeUnknown,
  toProtocolError,
} from "../../src/mapper/protocol-error.js";

describe("protocol-error sanitization", () => {
  it("redacts secrets, bearer tokens, api keys and absolute paths", () => {
    const text = redactText(
      "token=sk-abc123XYZ /Users/alice/Documents/secret/file.txt api_key=123456 Bearer eyJhbGciOi.eyJzdWI.Ci",
    );
    assert.equal(text.includes("sk-abc123XYZ"), false);
    assert.equal(text.includes("/Users/alice/Documents"), false);
    assert.equal(text.includes("123456"), false);
    assert.equal(text.includes("Bearer [REDACTED]"), true);
    assert.ok(text.includes("[REDACTED]"));
  });

  it("sanitizeUnknown recurses and truncates depth/arrays/keys", () => {
    // MAX_DEPTH = 6: root is depth 0; the value under key `f` is reached at
    // depth 6 and must collapse to the truncation marker (not the whole tree).
    const value = sanitizeUnknown({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } });
    assert.deepEqual(value, { a: { b: { c: { d: { e: { f: "[TRUNCATED]" } } } } } });
    const secrets = sanitizeUnknown({ password: "hunter2", keep: "ok" });
    assert.equal((secrets as Record<string, unknown>).password, "[REDACTED]");
    assert.equal((secrets as Record<string, unknown>).keep, "ok");
  });

  it("maps a runtime error code 1:1 and passes the protocol schema", () => {
    const error = runtimeErrorToProtocolError({
      code: "unsupported_capability",
      message: "runtime.prompt not supported",
      retryable: false,
      details: { key: "x" },
    });
    assert.equal(error.code, "unsupported_capability");
    assert.equal(error.retryable, false);
    assert.deepEqual(error.details, { key: "x" });
    const parsed = ProtocolErrorSchema.safeParse(error);
    assert.equal(parsed.success, true);
  });

  it("maps thrown backend errors to a sanitized internal error", () => {
    const error = toProtocolError(new Error("boom at /Users/alice/x"));
    assert.equal(error.code, "internal");
    assert.equal(error.retryable, false);
    assert.equal(error.message.includes("/Users/alice"), false);
  });

  it("protocolError builds a schema-valid error", () => {
    const error = protocolError("invalid_request", "bad input");
    assert.deepEqual(error, { code: "invalid_request", message: "bad input", retryable: false });
    assert.equal(ProtocolErrorSchema.safeParse(error).success, true);
  });
});
