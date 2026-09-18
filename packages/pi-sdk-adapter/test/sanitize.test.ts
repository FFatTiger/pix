import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeRuntimeError } from "@fffattiger/pix-runtime-core";
import { sanitizeRuntimeError } from "../src/internal/sanitize.js";

describe("recursive RuntimeError sanitization", () => {
  it("redacts nested credential values while preserving canonical semantics", () => {
    const raw = makeRuntimeError("timeout", "token=outer-secret code=one-time", {
      retryable: true,
      cause: { kind: "auth", detail: "apiKey: sk-cause-secret" },
      details: {
        apiKey: "sk-top-secret",
        nested: [{ credential: { accessToken: "access-deep" }, safe: "visible" }],
        syncError: Object.assign(new Error("refresh_token=refresh-secret"), {
          credential: { type: "oauth", access: "access-secret", refresh: "refresh-secret" },
        }),
      },
    });
    const safe = sanitizeRuntimeError(raw, "auth");
    const serialized = JSON.stringify(safe);
    assert.equal(safe.code, "timeout");
    assert.equal(safe.retryable, true);
    assert.equal(safe.cause?.kind, "auth");
    for (const secret of ["outer-secret", "one-time", "sk-cause-secret", "sk-top-secret", "access-deep", "refresh-secret", "access-secret"]) {
      assert.equal(serialized.includes(secret), false, secret);
    }
    assert.equal(serialized.includes("visible"), true);
    assert.equal(serialized.includes("stack"), false);
  });

  it("bounds cyclic/deep external objects without throwing", () => {
    const cyclic: Record<string, unknown> = { message: "secret=hidden" };
    cyclic.self = cyclic;
    const safe = sanitizeRuntimeError(cyclic, "auth");
    assert.equal(safe.code, "external");
    assert.equal(JSON.stringify(safe).includes("hidden"), false);
  });
});
