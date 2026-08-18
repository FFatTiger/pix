import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LocalAuthorityError,
  createSecureStateBackend,
} from "../dist/state/index.js";
import {
  WINDOWS_ADMINISTRATORS_SID,
  WINDOWS_LOCAL_SYSTEM_SID,
  rejectUnsafeWindowsNamedPipeEvidence,
  rejectUnsafeWindowsSecurityEvidence,
} from "../dist/state/windows-security.js";
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

test("Windows backend creates a protected named-pipe first instance", { skip: !isWindowsX64 }, async () => {
  const backend = createSecureStateBackend({ platform: "win32" });
  assert.equal(backend.kind, "windows");
  const pipe = "\\\\.\\pipe\\pix-test-" + process.pid + "-" + Date.now();
  const holder = await backend.createProtectedNamedPipe(pipe);
  try {
    assert.equal(typeof holder.close, "function");
    await assert.rejects(
      backend.createProtectedNamedPipe(pipe),
      (error) => error?.code === "LOCK_BUSY",
    );
  } finally {
    holder.close();
  }
});

test("Windows backend listens on a protected named pipe before Node binds", { skip: !isWindowsX64 }, async () => {
  const backend = createSecureStateBackend({ platform: "win32" });
  assert.equal(backend.kind, "windows");
  const pipe = "\\\\.\\pipe\\pix-listen-" + process.pid + "-" + Date.now();
  let resolveAccepted;
  const accepted = new Promise((resolve) => { resolveAccepted = resolve; });
  const holder = await backend.listenProtectedNamedPipe(pipe, (connection) => {
    resolveAccepted(connection);
  });
  try {
    await assert.rejects(
      backend.listenProtectedNamedPipe(pipe, () => {}),
      (error) => error?.code === "LOCK_BUSY",
    );
    await assert.rejects(
      backend.createProtectedNamedPipe(pipe),
      (error) => error?.code === "LOCK_BUSY",
    );
    const client = createConnection(pipe);
    const [connection] = await Promise.all([
      accepted,
      new Promise((resolve, reject) => {
        client.once("connect", resolve);
        client.once("error", reject);
      }),
    ]);
    assert.equal(typeof connection.write, "function");
    const reply = new Promise((resolve) => {
      connection.on("data", (chunk) => resolve(chunk.toString()));
    });
    client.write("ping\n");
    const seen = await Promise.race([
      reply,
      new Promise((_, reject) => setTimeout(() => reject(new Error("no server read")), 1000)),
    ]).catch((error) => error);
    if (seen instanceof Error) throw seen;
    assert.equal(seen, "ping\n");
    connection.write("pong\n");
    const clientSeen = await new Promise((resolve, reject) => {
      client.once("data", (chunk) => resolve(chunk.toString()));
      client.once("error", reject);
      setTimeout(() => reject(new Error("no client read")), 1000);
    });
    assert.equal(clientSeen, "pong\n");
    client.end();
    connection.destroy();
    await new Promise((resolve) => client.once("close", resolve));
  } finally {
    holder.close();
  }
});

test("Windows backend accepts an already-created private directory without a raw already-exists error", { skip: !isWindowsX64 }, async () => {
  const parent = mkdtempSync(join(tmpdir(), "pix-win-existing-private-"));
  const hostDir = join(parent, "host");
  const backend = createSecureStateBackend({ platform: "win32" });
  const binding = loadNativeWindowsBinding();
  try {
    binding.createPrivateObject(hostDir, "directory");
    const ensured = await backend.ensurePrivateDirectory(hostDir);
    assert.equal(ensured.created, false);
    assert.equal(ensured.identity.kind, "windows");
    const inspection = binding.inspectPath(ensured.path);
    assert.ok(inspection);
    rejectUnsafeWindowsSecurityEvidence(inspection, backend.principal());
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("Windows backend concurrent ensurePrivateDirectory never leaks a raw already-exists error", { skip: !isWindowsX64 }, async () => {
  const parent = mkdtempSync(join(tmpdir(), "pix-win-race-"));
  const hostDir = join(parent, "host");
  const backend = createSecureStateBackend({ platform: "win32" });
  try {
    const results = await Promise.allSettled([
      backend.ensurePrivateDirectory(hostDir),
      backend.ensurePrivateDirectory(hostDir),
    ]);
    for (const result of results) {
      if (result.status === "fulfilled") {
        assert.equal(result.value.identity.kind, "windows");
        continue;
      }
      assert.equal(result.reason instanceof LocalAuthorityError, true);
      assert.notEqual(result.reason.message, "path already exists");
    }
    assert.equal(results.some((result) => result.status === "fulfilled"), true);
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
