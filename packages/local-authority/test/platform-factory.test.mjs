import assert from "node:assert/strict";
import test from "node:test";
import {
  createSecureStateBackend,
  LocalAuthorityError,
} from "../dist/state/index.js";

test("platform factory selects the POSIX backend deterministically", () => {
  const backend = createSecureStateBackend({ platform: "linux" });
  assert.equal(backend.kind, "posix");
  const principal = backend.principal();
  assert.equal(principal.kind, "posix");
});

test("platform factory rejects Windows before any POSIX backend/path operation", () => {
  const marker = "C:\\Users\\secret-marker";
  assert.throws(
    () => createSecureStateBackend({ platform: "win32" }),
    (error) => {
      assert.equal(error instanceof LocalAuthorityError, true);
      assert.equal(error.code, "UNSUPPORTED_PLATFORM");
      assert.equal(error.message, "Native Windows secure state is unavailable");
      assert.equal(error.message.includes(marker), false);
      return true;
    },
  );
});
