import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { windowsReleaseVerifyUnsupportedMessage } from "./release-verify.mjs";

const here = dirname(fileURLToPath(import.meta.url));

test("Windows release-verify fail-closed copy is fixed and path-free", () => {
  const message = windowsReleaseVerifyUnsupportedMessage();
  assert.match(message, /Windows install\/upgrade\/uninstall is not claimed/);
  assert.equal(message.includes("sessiond.sock"), false);
  assert.equal(message.includes("C:\\"), false);
});

test("Windows entry fails closed before Unix layout assumptions", { skip: process.platform !== "win32" }, () => {
  const result = spawnSync(process.execPath, [join(here, "release-verify.mjs"), "--skip-build"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(String(result.stderr ?? ""), /Windows install\/upgrade\/uninstall is not claimed/);
  assert.equal(String(result.stderr ?? "").includes("sessiond.sock"), false);
});
