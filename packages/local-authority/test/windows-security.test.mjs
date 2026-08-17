import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalAuthorityError } from "../dist/state/index.js";
import { loadNativeWindowsBinding } from "../dist/state/native-windows.js";
import { currentWindowsPrincipal } from "../dist/state/windows-identity.js";
import {
  WINDOWS_ADMINISTRATORS_SID,
  WINDOWS_LOCAL_SYSTEM_SID,
  hasUsableWindowsSecurityEvidence,
  rejectUnsafeWindowsSecurityEvidence,
} from "../dist/state/windows-security.js";

const isWindowsX64 = process.platform === "win32" && process.arch === "x64";
const GENERIC_ALL = 0x10000000;

function ace(overrides = {}) {
  return {
    type: "allow",
    sid: "S-1-5-21-1-2-3-1001",
    mask: GENERIC_ALL,
    flags: 0,
    inherited: false,
    ...overrides,
  };
}

function inspection(overrides = {}) {
  const ownerSid = overrides.ownerSid ?? "S-1-5-21-1-2-3-1001";
  return {
    volumeSerial: "1",
    fileId: "0".repeat(32),
    size: "0",
    attributes: 0,
    reparseTag: 0,
    isReparsePoint: false,
    isDirectory: true,
    isFile: false,
    ownerSid,
    daclPresent: true,
    daclProtected: true,
    aces: [
      ace({ sid: ownerSid }),
      ace({ sid: WINDOWS_LOCAL_SYSTEM_SID }),
    ],
    ...overrides,
  };
}

test("Windows security helpers stay off the public state surface", async () => {
  const state = await import("../dist/state/index.js");
  assert.equal("rejectUnsafeWindowsSecurityEvidence" in state, false);
  assert.equal("hasUsableWindowsSecurityEvidence" in state, false);
});

test("rejectUnsafeWindowsSecurityEvidence fail-closes on reparse, foreign owner, and extra SIDs", () => {
  const principal = { kind: "windows", sid: "S-1-5-21-1-2-3-1001" };
  assert.throws(
    () => rejectUnsafeWindowsSecurityEvidence(inspection({ isReparsePoint: true }), principal),
    (error) => error instanceof LocalAuthorityError && error.code === "SYMLINK",
  );
  assert.throws(
    () => rejectUnsafeWindowsSecurityEvidence(inspection({ ownerSid: "S-1-5-21-9-9-9-9" }), principal),
    (error) => error instanceof LocalAuthorityError && error.code === "NOT_OWNED",
  );
  assert.throws(
    () => rejectUnsafeWindowsSecurityEvidence(inspection({ daclPresent: false }), principal),
    (error) => error instanceof LocalAuthorityError && error.code === "NOT_PRIVATE",
  );
  assert.throws(
    () => rejectUnsafeWindowsSecurityEvidence(inspection({ daclProtected: false }), principal),
    (error) => error instanceof LocalAuthorityError && error.code === "NOT_PRIVATE",
  );
  assert.throws(
    () => rejectUnsafeWindowsSecurityEvidence(inspection({
      aces: [ace(), ace({ sid: WINDOWS_LOCAL_SYSTEM_SID }), ace({ sid: WINDOWS_ADMINISTRATORS_SID })],
    }), principal),
    (error) => error instanceof LocalAuthorityError && error.code === "NOT_PRIVATE",
  );
  assert.throws(
    () => rejectUnsafeWindowsSecurityEvidence(inspection({
      aces: [ace({ type: "deny" }), ace({ sid: WINDOWS_LOCAL_SYSTEM_SID })],
    }), principal),
    (error) => error instanceof LocalAuthorityError && error.code === "NOT_PRIVATE",
  );
  assert.doesNotThrow(() => rejectUnsafeWindowsSecurityEvidence(inspection(), principal));
  assert.equal(hasUsableWindowsSecurityEvidence(inspection()), true);
  assert.equal(hasUsableWindowsSecurityEvidence(inspection({ ownerSid: "not-a-sid" })), false);
});

test("inherited temp directories are not treated as private", { skip: !isWindowsX64 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pix-win-sec-"));
  try {
    const native = loadNativeWindowsBinding().inspectPath(dir);
    assert.ok(native);
    assert.equal(hasUsableWindowsSecurityEvidence(native), true);
    const principal = currentWindowsPrincipal();
    assert.throws(
      () => rejectUnsafeWindowsSecurityEvidence(native, principal),
      (error) => error instanceof LocalAuthorityError
        && (error.code === "NOT_PRIVATE" || error.code === "NOT_OWNED"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
