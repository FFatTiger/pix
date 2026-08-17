import assert from "node:assert/strict";
import test from "node:test";
import { buildWindowsNative } from "../scripts/build-native.mjs";

test("native build skips non-Windows hosts", () => {
  assert.deepEqual(
    buildWindowsNative({ platform: "linux", arch: "x64" }),
    { built: false, reason: "not-windows" },
  );
});

test("native build rejects unsupported Windows architectures", () => {
  assert.throws(
    () => buildWindowsNative({ platform: "win32", arch: "arm64" }),
    /unsupported Windows native target: win32-arm64/,
  );
});
