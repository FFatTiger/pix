import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProtocolError } from "@fffattiger/pix-protocol";
import { makeRuntimeError, type SessionCatalogPort, type SessionLocatorPort } from "@fffattiger/pix-runtime-core";
import { SessiondApplication } from "../src/application.js";
import { SessiondError, toBoundaryProtocolError } from "../src/errors.js";
import { SessiondRpcClient, SessiondRpcServer } from "../src/rpc.js";
import { SessiondService } from "../src/service.js";
import { FakeWorkerFactory } from "../src/testing/fake-worker.js";

// ---------------------------------------------------------------------------
// Pure boundary mapping: known canonical codes survive, everything else is
// sanitized to a fixed internal error.
// ---------------------------------------------------------------------------

test("toBoundaryProtocolError preserves a canonical not_found with a fixed sanitized message", () => {
  // The catalog throws a plain RuntimeError-shaped object reflecting the id.
  const error = makeRuntimeError("not_found", "session not found: attacker-id-xyz", {
    details: { leaked: "should-not-survive" },
  });
  const protocolError = toBoundaryProtocolError(error);
  assert.equal(protocolError.code, "not_found");
  // The raw message (with the id) is replaced by the fixed canonical message.
  assert.equal(protocolError.message, "session not found");
  assert.equal(protocolError.retryable, false);
  // cause/details are dropped (they may reflect external/attacker input).
  assert.equal("cause" in protocolError, false);
  assert.equal("details" in protocolError, false);
  assert.ok(!JSON.stringify(protocolError).includes("attacker-id-xyz"));
});

test("toBoundaryProtocolError preserves a known code but sanitizes an attacker-authored message", () => {
  // A structurally-valid object whose message/cause/details are attacker-crafted.
  const attacker = {
    code: "not_found",
    message: "session not found: /secret/endpoint/and/key",
    retryable: false,
    cause: { kind: "file", detail: "/etc/shadow" },
    details: { inject: "<script>" },
  } as unknown;
  const protocolError = toBoundaryProtocolError(attacker);
  assert.equal(protocolError.code, "not_found");
  assert.equal(protocolError.message, "session not found");
  assert.equal(protocolError.retryable, false);
  assert.ok(!JSON.stringify(protocolError).includes("secret"));
  assert.ok(!JSON.stringify(protocolError).includes("shadow"));
  assert.ok(!JSON.stringify(protocolError).includes("script"));
});

test("toBoundaryProtocolError maps an unknown/malicious code to internal", () => {
  const protocolError = toBoundaryProtocolError({ code: "PWNED", message: "arbitrary", retryable: true });
  assert.equal(protocolError.code, "internal");
  assert.equal(protocolError.message, "sessiond request failed");
  assert.equal(protocolError.retryable, false);
});

test("toBoundaryProtocolError maps a malformed RuntimeError (missing retryable) to internal", () => {
  const protocolError = toBoundaryProtocolError({ code: "not_found", message: "x" });
  assert.equal(protocolError.code, "internal");
  assert.equal(protocolError.message, "sessiond request failed");
});

test("toBoundaryProtocolError maps a raw Error to internal without echoing its message/stack", () => {
  const protocolError = toBoundaryProtocolError(new Error("boom with stack trace: /secret/path"));
  assert.equal(protocolError.code, "internal");
  assert.equal(protocolError.message, "sessiond request failed");
  assert.ok(!JSON.stringify(protocolError).includes("boom"));
  assert.ok(!JSON.stringify(protocolError).includes("secret"));
});

test("toBoundaryProtocolError maps null/undefined/string to internal", () => {
  for (const value of [null, undefined, "oops", 42, {}]) {
    const protocolError = toBoundaryProtocolError(value) as ProtocolError;
    assert.equal(protocolError.code, "internal");
    assert.equal(protocolError.message, "sessiond request failed");
  }
});

test("toBoundaryProtocolError preserves a SessiondError verbatim", () => {
  const sessiondError = new SessiondError("unavailable", "session catalog is unavailable", false);
  const protocolError = toBoundaryProtocolError(sessiondError);
  assert.equal(protocolError.code, "unavailable");
  assert.equal(protocolError.message, "session catalog is unavailable");
  assert.equal(protocolError.retryable, false);
});

// ---------------------------------------------------------------------------
// End-to-end through the RPC boundary: a catalog not_found survives to the
// client as a SessiondError with the canonical code + sanitized message.
// ---------------------------------------------------------------------------

function rpcHarness() {
  const catalog: SessionCatalogPort = {
    async listSessions() { return []; },
    async readSession(sessionId) { throw makeRuntimeError("not_found", `session not found: ${sessionId}`); },
    async readSessionContext(sessionId) { throw makeRuntimeError("not_found", `session not found: ${sessionId}`); },
    async deleteSession() { throw makeRuntimeError("not_found", "session not found"); },
  };
  const locator: SessionLocatorPort = {
    async locate(sessionId) { return { sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, exists: false }; },
    async resolveLeafId(sessionId) { return sessionId; },
  };
  const service = new SessiondService({
    sessionLocator: locator,
    activationContext: { async resolve(sessionId, _location, requestedCwd) { return { cwd: requestedCwd ?? `/cwd/${sessionId}`, projectRoot: requestedCwd ?? `/cwd/${sessionId}` }; } },
    workerFactory: new FakeWorkerFactory({ readyDelayMs: 0 }),
    sessionCatalog: catalog,
  }, { workerStartTimeoutMs: 500, commandTimeoutMs: 500, idleTimeoutMs: 0 });
  return { service };
}

test("RPC boundary preserves a catalog not_found as a sanitized protocol error (round-trip)", async (t) => {
  if (process.platform === "win32") return t.skip("unix socket test");
  const directory = await mkdtemp(join(tmpdir(), "sessiond-boundary-"));
  const endpoint = join(directory, "rpc.sock");
  const { service } = rpcHarness();
  const server = new SessiondRpcServer({ endpoint, secret: "a".repeat(40), handler: new SessiondApplication(service) });
  await server.listen();
  try {
    const client = new SessiondRpcClient({ endpoint, secret: "a".repeat(40), timeoutMs: 1_000 });

    // read of a missing session → not_found (NOT internal) reaching the client.
    await assert.rejects(
      client.call("sessions.read", { sessionId: "missing-secret-id" }),
      (error: unknown) => {
        assert.ok(error instanceof SessiondError, "client must reject with a SessiondError");
        assert.equal(error.code, "not_found", "canonical not_found must survive the boundary");
        assert.equal(error.message, "session not found", "message must be the fixed sanitized canonical message");
        assert.equal(error.retryable, false);
        assert.ok(!String(error.message).includes("missing-secret-id"), "the raw thrown message must not echo the id");
        return true;
      },
    );

    // context of a missing session → not_found as well.
    await assert.rejects(
      client.call("sessions.context", { sessionId: "also-missing" }),
      (error: unknown) => {
        assert.ok(error instanceof SessiondError);
        assert.equal(error.code, "not_found");
        assert.equal(error.message, "session not found");
        return true;
      },
    );
  } finally {
    await server.close();
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("RPC boundary sanitizes an arbitrary thrown value to internal (round-trip)", async (t) => {
  if (process.platform === "win32") return t.skip("unix socket test");
  const directory = await mkdtemp(join(tmpdir(), "sessiond-boundary-internal-"));
  const endpoint = join(directory, "rpc.sock");
  // A handler that throws a raw, attacker-shaped object with an unknown code.
  const handler: { handle: () => Promise<never> } = {
    async handle() {
      throw { code: "exfiltrated", message: "leak: /secret/path and key", retryable: true, details: { inject: "x" } };
    },
  };
  const server = new SessiondRpcServer({ endpoint, secret: "a".repeat(40), handler: handler as never });
  await server.listen();
  try {
    const client = new SessiondRpcClient({ endpoint, secret: "a".repeat(40), timeoutMs: 1_000 });
    await assert.rejects(
      client.call("sessions.read", { sessionId: "s" }),
      (error: unknown) => {
        assert.ok(error instanceof SessiondError);
        assert.equal(error.code, "internal", "unknown/external code must collapse to internal");
        assert.equal(error.message, "sessiond request failed");
        assert.ok(!String(error.message).includes("secret"));
        assert.ok(!String(error.message).includes("exfiltrated"));
        return true;
      },
    );
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
