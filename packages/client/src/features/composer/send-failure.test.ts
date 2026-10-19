import { describe, expect, it } from "vitest";
import { isActivationSendFailure, isConsumedQueuedReceipt, isDefiniteSendFailure, isUncertainSendSettle } from "./send-failure";

const conflict = { code: "conflict", message: "session revision changed", retryable: false };
const timeoutRetryable = { code: "timeout", message: "runtime not sendable in time", retryable: true };
const unavailableFinal = { code: "unavailable", message: "sessiond request failed", retryable: false };

describe("send-failure judgment", () => {
  it("activation-tagged causes are proven non-delivery", () => {
    expect(isActivationSendFailure({ ...conflict, phase: "activation" })).toBe(true);
    expect(isActivationSendFailure({ ...timeoutRetryable, phase: "activation" })).toBe(true);
    expect(isActivationSendFailure(conflict)).toBe(false);
    expect(isActivationSendFailure(null)).toBe(false);
  });

  it("uncertain-tagged causes are never definite, regardless of retryable", () => {
    expect(isUncertainSendSettle({ ...unavailableFinal, phase: "uncertain" })).toBe(true);
    expect(isUncertainSendSettle({ ...timeoutRetryable, phase: "uncertain" })).toBe(true);
    expect(isDefiniteSendFailure({ ...unavailableFinal, phase: "uncertain" })).toBe(false);
    expect(isDefiniteSendFailure({ ...conflict, phase: "uncertain" })).toBe(false);
  });

  it("retryable transport failures are not definite (owner keeps retrying)", () => {
    expect(isDefiniteSendFailure(timeoutRetryable)).toBe(false);
  });

  it("only an explicit non-retryable, non-uncertain rejection is definite", () => {
    expect(isDefiniteSendFailure(conflict)).toBe(true);
    expect(isDefiniteSendFailure(unavailableFinal)).toBe(true);
    expect(isDefiniteSendFailure({ code: "invalid_input", message: "x", retryable: false, phase: "activation" })).toBe(true);
  });

  it("malformed causes stay definite-false-positive-safe only via shape, never truthiness of junk", () => {
    expect(isDefiniteSendFailure(new Error("raw"))).toBe(true);
    expect(isDefiniteSendFailure("string")).toBe(true);
    expect(isUncertainSendSettle("string")).toBe(false);
    expect(isActivationSendFailure(42)).toBe(false);
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
