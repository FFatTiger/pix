/**
 * PR#3 contract: `packages/sessiond/src/rpc.ts` must derive its accepted method
 * set from the current Protocol `SESSIOND_RPC_METHODS` constant (never a
 * hand-maintained duplicate that can drift), and the constant must stay in
 * sync with the discriminated request schema. Also asserts the public
 * protocol/sessiond surfaces gain no diagnostics/PID method.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSIOND_RPC_METHODS,
  SessiondRpcRequestSchema,
  SystemHelloResultSchema,
  type SessiondMethodParams,
  type SessiondMethodResult,
  type SessiondRpcMethod,
} from "@fffattiger/pix-protocol";
import { isSessiondRpcMethod } from "../src/rpc.js";

/** Compile-time: params/results are keyed 1:1 with the RPC method constant. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type RpcMethodContractAssertions =
  | Assert<Equal<keyof SessiondMethodParams, SessiondRpcMethod>>
  | Assert<Equal<keyof SessiondMethodResult, SessiondRpcMethod>>;
export const rpcMethodContractAssertions: RpcMethodContractAssertions = true;

test("sessiond RPC method set is derived from the Protocol SESSIOND_RPC_METHODS constant", () => {
  // Every protocol method is accepted by the server predicate.
  for (const method of SESSIOND_RPC_METHODS) {
    assert.equal(isSessiondRpcMethod(method), true, `method ${method} must be accepted`);
  }
  // The predicate rejects anything outside the constant.
  assert.equal(isSessiondRpcMethod("worker.status"), false);
  assert.equal(isSessiondRpcMethod("system.diagnostics"), false);
  assert.equal(isSessiondRpcMethod("runtime.workerPids"), false);
  assert.equal(isSessiondRpcMethod("sessions.rename"), true);
  assert.equal(isSessiondRpcMethod("sessions.delete"), true);
  // Current coverage includes the sessions rename/delete methods.
  assert.ok(SESSIOND_RPC_METHODS.includes("sessions.rename"));
  assert.ok(SESSIOND_RPC_METHODS.includes("sessions.delete"));
});

test("SESSIOND_RPC_METHODS exactly matches the discriminated request schema (no drift)", () => {
  const schemaMethods = SessiondRpcRequestSchema.options.map(
    (option) => (option.shape as { method: { value: string } }).method.value,
  );
  assert.deepEqual([...SESSIOND_RPC_METHODS].sort(), [...schemaMethods].sort());
});

test("no public RPC/hello surface gains a diagnostics or PID method/field", () => {
  for (const method of SESSIOND_RPC_METHODS) {
    assert.ok(!/diagnostic|pid|workersbystatus/i.test(method), `unexpected method ${method}`);
  }
  const helloKeys = Object.keys(SystemHelloResultSchema.shape);
  assert.ok(!helloKeys.some((key) => /diagnostic|pid/i.test(key)), `unexpected hello field: ${helloKeys.join(",")}`);
});
