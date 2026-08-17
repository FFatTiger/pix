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

test("platform factory selects the Windows backend on win32-x64", () => {
  if (process.platform !== "win32" || process.arch !== "x64") {
    assert.throws(
      () => createSecureStateBackend({ platform: "win32" }),
      (error) => error instanceof LocalAuthorityError && error.code === "UNSUPPORTED_PLATFORM",
    );
    return;
  }
  const backend = createSecureStateBackend({ platform: "win32" });
  assert.equal(backend.kind, "windows");
  assert.equal(backend.principal().kind, "windows");
});
