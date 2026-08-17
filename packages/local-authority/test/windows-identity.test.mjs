import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalAuthorityError } from "../dist/state/index.js";
import {
  currentWindowsPrincipal,
  inspectWindowsOwnerSid,
  isWindowsOwnedByCurrentUser,
  windowsFileIdentity,
} from "../dist/state/windows-identity.js";

const isWindowsX64 = process.platform === "win32" && process.arch === "x64";

test("Windows identity helpers stay off the public state surface", async () => {
  const state = await import("../dist/state/index.js");
  assert.equal("currentWindowsPrincipal" in state, false);
  assert.equal("windowsFileIdentity" in state, false);
  assert.equal("canonicalizeWindowsAbsolutePath" in state, false);
});

test("Windows principal and file identity come from native handle evidence", { skip: !isWindowsX64 }, async () => {
  const principal = currentWindowsPrincipal();
  assert.equal(principal.kind, "windows");
  assert.match(principal.sid, /^S-1-[0-9-]+$/u);

  const dir = mkdtempSync(join(tmpdir(), "pix-win-id-"));
  const file = join(dir, "evidence.txt");
  try {
    writeFileSync(file, "hello");
    const identity = await windowsFileIdentity(file);
    const again = await windowsFileIdentity(file.toUpperCase());
    assert.ok(identity);
    assert.ok(again);
    assert.equal(identity.kind, "windows");
    assert.equal(identity.fileId, again.fileId);
    assert.equal(identity.volumeSerial, again.volumeSerial);
    assert.equal(identity.size, "5");
    assert.match(identity.ownerSid, /^S-1-[0-9-]+$/u);
    assert.equal(identity.isFile, true);
    assert.equal(identity.isDirectory, false);
    assert.equal(identity.isReparsePoint, false);
    assert.equal(await windowsFileIdentity(join(dir, "missing")), null);
    await assert.rejects(
      () => windowsFileIdentity(`${file}${"\0"}X`),
      (error) => error instanceof LocalAuthorityError && error.code === "INVALID_PATH",
    );
    const ownerSid = inspectWindowsOwnerSid(file);
    assert.ok(ownerSid);
    assert.equal(isWindowsOwnedByCurrentUser(ownerSid, principal), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows identity helpers fail closed when the binding is unavailable", { skip: isWindowsX64 }, () => {
  assert.throws(
    () => currentWindowsPrincipal(),
    (error) => error instanceof LocalAuthorityError && error.code === "UNSUPPORTED_PLATFORM",
  );
});
