import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LocalAuthorityError,
  createSecureStateBackend,
} from "../dist/state/index.js";
import { rejectUnsafeWindowsSecurityEvidence } from "../dist/state/windows-security.js";
import { loadNativeWindowsBinding } from "../dist/state/native-windows.js";

const isWindowsX64 = process.platform === "win32" && process.arch === "x64";

test("Windows backend creates a private directory, document, and exclusive lock", { skip: !isWindowsX64 }, async () => {
  const parent = mkdtempSync(join(tmpdir(), "pix-win-backend-"));
  const hostDir = join(parent, "host");
  const backend = createSecureStateBackend({ platform: "win32" });
  assert.equal(backend.kind, "windows");
  try {
    const ensured = await backend.ensurePrivateDirectory(hostDir);
    assert.equal(ensured.created, true);
    assert.equal(ensured.identity.kind, "windows");
    const inspection = loadNativeWindowsBinding().inspectPath(ensured.path);
    assert.ok(inspection);
    rejectUnsafeWindowsSecurityEvidence(inspection, backend.principal());

    const docPath = join(ensured.path, "trusted-roots.json");
    const lockPath = join(ensured.path, "trusted-roots.lock");
    const ownership = await backend.acquireLifetimeLock(lockPath, {
      payload: `${JSON.stringify({ pid: process.pid, instanceId: "abcd1234", createdAt: Date.now() })}\n`,
      isPidAlive: (pid) => backend.isPidAlive(pid),
    });
    assert.equal(ownership.kind, "windows");
    await backend.writeStateDocument(docPath, "{\"ok\":true}\n", {
      maxBytes: 1024,
      lockCheck: { path: lockPath, ownership },
    });
    const read = await backend.readStateDocument(docPath, { maxBytes: 1024 });
    assert.equal("content" in read && read.content, "{\"ok\":true}\n");
    await assert.rejects(
      () => backend.acquireLifetimeLock(lockPath, {
        payload: `${JSON.stringify({ pid: process.pid, instanceId: "efgh5678", createdAt: Date.now() })}\n`,
        isPidAlive: () => true,
      }),
      (error) => error instanceof LocalAuthorityError && error.code === "LOCK_BUSY",
    );
    await backend.releaseLifetimeLock(lockPath, { ownership, instanceId: "abcd1234" });
    assert.deepEqual(await backend.readLifetimeLock(lockPath), { kind: "missing" });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("Windows backend fail-closes inherited existing directories and does not chmod them", { skip: !isWindowsX64 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pix-win-existing-"));
  const backend = createSecureStateBackend({ platform: "win32" });
  try {
    writeFileSync(join(dir, "foreign.bin"), "x");
    await assert.rejects(
      () => backend.ensurePrivateDirectory(dir),
      (error) => error instanceof LocalAuthorityError && error.code === "NOT_PRIVATE",
    );
    assert.equal(await import("node:fs/promises").then((fs) => fs.readFile(join(dir, "foreign.bin"), "utf8")), "x");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
