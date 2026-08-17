import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createSecureStateBackend } from "../dist/state/platform.js";
import { loadNativeWindowsBinding } from "../dist/state/native-windows.js";

const isWindowsX64 = process.platform === "win32" && process.arch === "x64";

test("public state surface does not export the private native loader", async () => {
  const state = await import("../dist/state/index.js");
  assert.equal("loadNativeWindowsBinding" in state, false);
  assert.equal("NativeWindowsBinding" in state, false);
});

test("native Windows binding exposes SID and handle-based path evidence", { skip: !isWindowsX64 }, () => {
  const binding = loadNativeWindowsBinding();
  assert.equal(binding.apiVersion, 1);
  const userSid = binding.currentUserSid();
  assert.match(userSid, /^S-1-[0-9-]+$/u);

  const dir = mkdtempSync(join(tmpdir(), "pix-native-"));
  const file = join(dir, "with space-测试.txt");
  try {
    writeFileSync(file, "hello");
    mkdirSync(join(dir, "child"));
    const first = binding.inspectPath(file);
    const second = binding.inspectPath(file.toUpperCase());
    const directory = binding.inspectPath(dir);
    assert.ok(first);
    assert.ok(second);
    assert.ok(directory);
    assert.match(first.fileId, /^[0-9a-f]{32}$/u);
    assert.match(first.volumeSerial, /^[0-9]+$/u);
    assert.equal(first.size, "5");
    assert.equal(first.fileId, second.fileId);
    assert.equal(first.volumeSerial, second.volumeSerial);
    assert.equal(first.isFile, true);
    assert.equal(first.isDirectory, false);
    assert.equal(first.isReparsePoint, false);
    assert.equal(directory.isDirectory, true);
    assert.equal(directory.isFile, false);
    assert.match(first.ownerSid, /^S-1-[0-9-]+$/u);
    assert.equal(typeof first.daclPresent, "boolean");
    assert.equal(typeof first.daclProtected, "boolean");
    assert.equal(binding.inspectPath(join(dir, "missing")), null);
    assert.throws(() => binding.inspectPath(""), /path is invalid|path is required/);
    const keep = join(dir, "keep");
    const keepX = join(dir, "keepX");
    writeFileSync(keep, "prefix-only");
    writeFileSync(keepX, "suffix-file");
    const prefix = binding.inspectPath(keep);
    const suffix = binding.inspectPath(keepX);
    assert.ok(prefix);
    assert.ok(suffix);
    assert.notEqual(prefix.fileId, suffix.fileId);
    assert.throws(
      () => binding.inspectPath(`${keep}${"\0"}X`),
      (error) => error?.code === "NATIVE_INVALID_ARGUMENT" || /path is invalid/.test(error?.message ?? ""),
    );
    const raw = createRequire(import.meta.url)(
      join(dirname(fileURLToPath(import.meta.url)), "../dist/native/win32-x64-msvc/pix_local_authority_windows.node"),
    );
    assert.throws(
      () => raw.inspectPath(`${keep}${"\0"}X`),
      (error) => error?.code === "NATIVE_INVALID_ARGUMENT",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows product backend remains fail-closed after the native spike", () => {
  assert.throws(
    () => createSecureStateBackend({ platform: "win32" }),
    (error) => error?.code === "UNSUPPORTED_PLATFORM"
      && error.message === "Native Windows secure state is unavailable",
  );
});
