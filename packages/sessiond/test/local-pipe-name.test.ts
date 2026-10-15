/**
 * Windows named-pipe naming for the sessiond public endpoint.
 *
 * The pipe name is derived from the NORMALIZED full directory path plus the
 * local username: `pix-sessiond-<sha256(dir + "\0" + user) first 32 hex>`.
 * This replaces the old hex-of-raw-directory prefix (24 hex chars, no user
 * component), which could collide between similarly-named directories and
 * always collided between two local accounts deriving the same runtime dir.
 * Unix endpoints are unaffected (filesystem socket path).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve, win32 } from "node:path";
import test from "node:test";
import { sessiondPaths, windowsSessiondPipeName } from "../src/local.js";

const expectedName = (directory: string, username: string): string => {
  const digest = createHash("sha256").update(`${win32.resolve(directory)}\0${username}`).digest("hex");
  return `\\\\.\\pipe\\pix-sessiond-${digest.slice(0, 32)}`;
};

test("windowsSessiondPipeName: deterministic, normalized, user-scoped", () => {
  const dir = "C:\\Users\\proxy\\AppData\\Local\\Temp\\pix-sessiond";
  const name = windowsSessiondPipeName(dir, "proxy");
  assert.equal(name, expectedName(dir, "proxy"));
  assert.match(name, /^\\\\\.\\pipe\\pix-sessiond-[0-9a-f]{32}$/);
  // The SAME pipe name for the same (dir, user) on every call.
  assert.equal(windowsSessiondPipeName(dir, "proxy"), name);
  // A different directory or a different user never collides.
  assert.notEqual(windowsSessiondPipeName("C:\\Users\\proxy\\other", "proxy"), name);
  assert.notEqual(windowsSessiondPipeName(dir, "root"), name);
});

test("windowsSessiondPipeName: normalization folds equivalent path spellings", () => {
  // A trailing separator (or repeated separators) does not fork the namespace.
  const dir = "C:\\Users\\proxy\\.pi\\pix\\sessiond";
  assert.equal(windowsSessiondPipeName(`${dir}\\`, "proxy"), windowsSessiondPipeName(dir, "proxy"));
});

test("sessiondPaths: unix keeps the socket path; win32 branch shape is delegated to the pipe-name helper", () => {
  // On non-win32 platforms (where these tests run) the endpoint stays a
  // filesystem socket inside the directory — the pipe helper is exercised
  // directly above so the win32 branch stays covered everywhere.
  if (process.platform === "win32") {
    const paths = sessiondPaths("C:\\Users\\proxy\\.pi\\pix\\sessiond");
    assert.match(paths.endpoint, /^\\\\\.\\pipe\\pix-sessiond-[0-9a-f]{32}$/);
  } else {
    const paths = sessiondPaths("/tmp/pix-sessiond-test");
    assert.equal(paths.endpoint, resolve("/tmp/pix-sessiond-test", "sessiond.sock"));
    assert.equal(paths.lockFile, resolve("/tmp/pix-sessiond-test", "sessiond.lock"));
    assert.equal(paths.secretFile, resolve("/tmp/pix-sessiond-test", "sessiond.secret"));
  }
});
