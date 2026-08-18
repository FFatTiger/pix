import assert from "node:assert/strict";
import test from "node:test";
import {
  PRIVILEGED_PROCESS_CODE,
  PRIVILEGED_PROCESS_MESSAGE,
  PrivilegedProcessError,
  assertPrivilegedProcessAllowed,
  isExplicitAllowRoot,
} from "../dist/state/index.js";

test("root policy default-denies uid 0 unless explicitly allowed", () => {
  assert.equal(isExplicitAllowRoot("1"), true);
  assert.equal(isExplicitAllowRoot(true), true);
  assert.equal(isExplicitAllowRoot("true"), false);
  assert.equal(isExplicitAllowRoot("yes"), false);
  assert.doesNotThrow(() => assertPrivilegedProcessAllowed({ uid: 1000 }));
  assert.doesNotThrow(() => assertPrivilegedProcessAllowed({}));
  assert.doesNotThrow(() => assertPrivilegedProcessAllowed({ uid: 0, allowRoot: "1" }));
  assert.throws(
    () => assertPrivilegedProcessAllowed({ uid: 0 }),
    (error) => error instanceof PrivilegedProcessError
      && error.code === PRIVILEGED_PROCESS_CODE
      && error.message === PRIVILEGED_PROCESS_MESSAGE,
  );
});
