import { describe, expect, it } from "vitest";
import { isConsumedQueuedReceipt, isDefiniteSendFailure } from "./send-failure";

const conflict = { code: "conflict", message: "session revision changed", retryable: false };
const timeoutRetryable = { code: "timeout", message: "runtime not sendable in time", retryable: true };
const unavailableFinal = { code: "unavailable", message: "sessiond request failed", retryable: false };

describe("send-failure judgment", () => {
  it("only pre-dispatch activation or a correlated authority rejection proves non-delivery", () => {
    expect(isDefiniteSendFailure({ ...conflict, phase: "activation" })).toBe(true);
    expect(isDefiniteSendFailure({ ...timeoutRetryable, phase: "activation" })).toBe(true);
    expect(isDefiniteSendFailure({ status: "rejected", delivery: "not_delivered", error: conflict })).toBe(true);
    expect(isDefiniteSendFailure({ status: "rejected", delivery: "uncertain", error: conflict })).toBe(false);
    expect(isDefiniteSendFailure({ status: "duplicate", delivery: "not_delivered", error: conflict })).toBe(false);
  });

  it("defaults every unproven failure to uncertain, regardless of retryable or code", () => {
    for (const cause of [
      { ...unavailableFinal, phase: "uncertain" },
      { ...conflict, phase: "uncertain" },
      conflict,
      unavailableFinal,
      timeoutRetryable,
      new Error("raw"),
      new TypeError("socket closed"),
      new DOMException("aborted", "AbortError"),
      "string",
      null,
    ]) {
      expect(isDefiniteSendFailure(cause)).toBe(false);
    }
  });

  it("a consumed queued-turn receipt is not a queue entry", () => {
    // Pi 1.0: an extension input handler consumed the message, nothing queued.
    expect(isConsumedQueuedReceipt({ result: { ok: true, type: "follow_up", disposition: "handled" } })).toBe(true);
    expect(isConsumedQueuedReceipt({ result: { ok: true, type: "follow_up", disposition: "queued" } })).toBe(false);
    expect(isConsumedQueuedReceipt({ result: { ok: true } })).toBe(false);
    expect(isConsumedQueuedReceipt({ result: { ok: false } })).toBe(false);
    expect(isConsumedQueuedReceipt(null)).toBe(false);
    expect(isConsumedQueuedReceipt("handled")).toBe(false);
  });
});
