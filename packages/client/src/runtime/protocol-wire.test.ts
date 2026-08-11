import { describe, expect, it } from "vitest";
import {
  buildRuntimeWsUrl,
  buildHandshakeRequest,
  computeBackoffDelay,
  parseHostFrame,
  isFatalHandshakeError,
  isRetryableError,
} from "./protocol-wire";
import { FATAL_HANDSHAKE_CODES } from "./lifecycle";

describe("buildRuntimeWsUrl", () => {
  it("derives wss from https at the root /v1/runtime route", () => {
    expect(buildRuntimeWsUrl({ href: "https://pix.local/" })).toBe("wss://pix.local/v1/runtime");
  });
  it("derives ws from http", () => {
    expect(buildRuntimeWsUrl({ href: "http://host:8080/" })).toBe("ws://host:8080/v1/runtime");
  });
  it("is independent of document base path (trailing-slash invariant)", () => {
    // Host serves /v1/runtime at root; slash vs no-slash must yield the same url.
    expect(buildRuntimeWsUrl({ href: "https://host/app/" })).toBe("wss://host/v1/runtime");
    expect(buildRuntimeWsUrl({ href: "https://host/app" })).toBe("wss://host/v1/runtime");
    expect(buildRuntimeWsUrl({ href: "https://host/app/index.html" })).toBe("wss://host/v1/runtime");
  });
});

describe("buildHandshakeRequest", () => {
  it("builds a strict protocolVersion=1 handshake with client identity + features", () => {
    const req = buildHandshakeRequest({ shell: "pwa", platform: "ios" }, ["x"]);
    expect(req).toEqual({ protocolVersion: 1, client: { shell: "pwa", platform: "ios" }, features: ["x"] });
  });
  it("defaults features to empty", () => {
    expect(buildHandshakeRequest({ shell: "web", platform: "mac" }).features).toEqual([]);
  });
});

describe("backoff (full-jitter exponential)", () => {
  it("base 500, factor 2, cap 30000 with full jitter in [0, upper)", () => {
    const rand = () => 0.0;
    // attempt 1: upper = 500 → 0*500 = 0 (full jitter floor)
    expect(computeBackoffDelay(1, rand)).toBe(0);
    const half = () => 0.5;
    expect(computeBackoffDelay(1, half)).toBe(250); // 0.5*500
    expect(computeBackoffDelay(2, half)).toBe(500); // 0.5*1000
    expect(computeBackoffDelay(3, half)).toBe(1000); // 0.5*2000
    expect(computeBackoffDelay(7, () => 1)).toBe(30_000); // capped at upper=30000
  });
});

describe("error classification", () => {
  it("flags fatal handshake codes", () => {
    for (const code of FATAL_HANDSHAKE_CODES) {
      expect(isFatalHandshakeError({ code, message: "x", retryable: false })).toBe(true);
    }
    expect(isFatalHandshakeError({ code: "timeout", message: "x", retryable: true })).toBe(false);
  });
  it("reports retryable errors", () => {
    expect(isRetryableError({ code: "runtime_unavailable", message: "x", retryable: true })).toBe(true);
    expect(isRetryableError({ code: "forbidden", message: "x", retryable: false })).toBe(false);
  });
});

describe("parseHostFrame (fail-closed)", () => {
  it("parses a valid handshake_ack", () => {
    const r = parseHostFrame(JSON.stringify({ type: "handshake_ack", payload: { protocolVersion: 1, host: { mode: "local", capabilities: ["agent"] }, limits: { maxUpload: 0, maxOpenSessions: 4 }, sessionSnapshotSupport: true } }));
    expect(r.ok).toBe(true);
  });
  it("rejects malformed JSON", () => {
    expect(parseHostFrame("{not json").ok).toBe(false);
  });
  it("rejects an unknown/invalid frame (fail closed, no `as any`)", () => {
    expect(parseHostFrame(JSON.stringify({ type: "bogus" })).ok).toBe(false);
    expect(parseHostFrame(JSON.stringify({ type: "snapshot", payload: {} })).ok).toBe(false);
  });
});
