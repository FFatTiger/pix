/**
 * Windows (win32) semantics for the sessiond private-directory walk and the
 * shutdown signal set, unit-tested on macOS via injected platform + fake fs
 * (mirrors the local-authority win32 suite; sessiond keeps its own frozen
 * walk policy, so it carries its own parity tests).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { LocalAuthorityError } from "@fffattiger/pix-local-authority/state";
import { join } from "node:path";
import { ensureSessiondPrivateDirectoryWithFs } from "../src/local-posix.js";
import { shutdownSignalsFor } from "../src/composition/daemon.js";
import { sessiondPaths } from "../src/local.js";

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

interface FakeEntry { type: "file" | "directory" | "symlink"; mode: number; ino: number }

/** In-memory win32 filesystem with win32-typical 0o666 mode bits. */
function fakeWin32Fs(entries: Array<[string, FakeEntry]>) {
  const tree = new Map(entries);
  let nextIno = 500;
  const stat = (path: string) => {
    const entry = tree.get(path);
    if (entry === undefined) throw errno("ENOENT");
    return {
      dev: 7,
      ino: entry.ino,
      mode: entry.mode,
      nlink: 1,
      size: 0,
      uid: -1,
      gid: -1,
      isFile: () => entry.type === "file",
      isDirectory: () => entry.type === "directory",
      isSymbolicLink: () => entry.type === "symlink",
    };
  };
  return {
    tree,
    async lstat(path: string) {
      return stat(path);
    },
    async mkdir(path: string) {
      if (tree.has(path)) throw errno("EEXIST");
      tree.set(path, { type: "directory", mode: 0o666, ino: nextIno++ });
      return undefined;
    },
    async realpath(path: string) {
      if (!tree.has(path)) throw errno("ENOENT");
      // win32 realpath may answer with the extended prefix and a different case.
      return path.startsWith("C:\\") ? `\\\\?\\${path}` : path;
    },
    async open() {
      throw errno("EPERM");
    },
    isOwnedByCurrentUser: () => false,
  };
}

async function expectCode(fn: () => Promise<unknown> | unknown, code: string): Promise<void> {
  await assert.rejects(
    async () => fn(),
    (e: unknown) => e instanceof LocalAuthorityError && e.code === code,
    `expected ${code}`,
  );
}

test("sessiond private-dir walk win32: creates missing components, no mode/uid enforcement", async () => {
  const fs = fakeWin32Fs([
    ["C:\\Users", { type: "directory", mode: 0o666, ino: 10 }],
    ["C:\\Users\\x", { type: "directory", mode: 0o666, ino: 11 }],
  ]);
  const result = await ensureSessiondPrivateDirectoryWithFs(
    "C:\\Users\\x\\.pi\\pix\\sessiond",
    fs as never,
    "win32",
  );
  assert.equal(result.path, "C:\\Users\\x\\.pi\\pix\\sessiond");
  assert.equal(result.created, true);
  assert.equal(fs.tree.get("C:\\Users\\x\\.pi\\pix\\sessiond")?.type, "directory");
});

test("sessiond private-dir walk win32: existing 0o666 leaf validates; symlink still fails closed", async () => {
  const fs = fakeWin32Fs([
    ["C:\\rt", { type: "directory", mode: 0o666, ino: 20 }],
    ["C:\\lnk", { type: "symlink", mode: 0o666, ino: 21 }],
  ]);
  const ok = await ensureSessiondPrivateDirectoryWithFs("C:\\rt", fs as never, "win32");
  assert.equal(ok.created, false);
  await expectCode(
    () => ensureSessiondPrivateDirectoryWithFs("C:\\lnk\\leaf", fs as never, "win32"),
    "SYMLINK",
  );
});

test("sessiond private-dir walk win32: UNC roots walk; drive root and device paths reject", async () => {
  const fs = fakeWin32Fs([
    ["\\\\srv\\share", { type: "directory", mode: 0o666, ino: 30 }],
  ]);
  const result = await ensureSessiondPrivateDirectoryWithFs("\\\\srv\\share\\pix\\sd", fs as never, "win32");
  assert.equal(result.created, true);
  await expectCode(() => ensureSessiondPrivateDirectoryWithFs("C:\\", fs as never, "win32"), "ROOT_PATH");
  await expectCode(() => ensureSessiondPrivateDirectoryWithFs("\\\\.\\pipe\\pix", fs as never, "win32"), "INVALID_PATH");
});

test("sessiond private-dir walk posix: mode enforcement still applies (parity)", async () => {
  const fake = fakeWin32Fs([
    ["/lax", { type: "directory", mode: 0o755, ino: 40 }],
  ]);
  // Injected owner check (the REAL isOwnedByCurrentUser is host-shaped:
  // always-true on win32, uid-compare on POSIX) so the parity expectation is
  // host-independent: uid semantics fail first on posix, then the mode gate.
  const fs = { ...fake, isOwnedByCurrentUser: () => false };
  await expectCode(() => ensureSessiondPrivateDirectoryWithFs("/lax", fs as never, "posix"), "NOT_OWNED");
});

test("shutdown signal set: win32 adds SIGBREAK + SIGHUP, POSIX stays frozen", () => {
  assert.deepEqual(shutdownSignalsFor("win32"), ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]);
  assert.deepEqual(shutdownSignalsFor("darwin"), ["SIGINT", "SIGTERM"]);
  assert.deepEqual(shutdownSignalsFor("linux"), ["SIGINT", "SIGTERM"]);
});

test("sessiondPaths endpoint shape is derived from process.platform only (documented)", () => {
  // On POSIX hosts this asserts the Unix socket shape; on win32 hosts the
  // endpoint is the deterministic named pipe (no filesystem socket file).
  const paths = sessiondPaths("/tmp/pix-test-dir");
  if (process.platform === "win32") {
    assert.match(paths.endpoint, /^\\\\\.\\pipe\\pix-sessiond-[0-9a-f]{32}$/);
    assert.equal(paths.endpoint, sessiondPaths("/tmp/pix-test-dir").endpoint, "pipe name is deterministic");
    assert.notEqual(paths.endpoint, sessiondPaths("/tmp/pix-test-dir-2").endpoint, "pipe name is per-directory");
  } else {
    assert.equal(paths.endpoint, "/tmp/pix-test-dir/sessiond.sock");
  }
  assert.equal(paths.lockFile, join("/tmp/pix-test-dir", "sessiond.lock"));
  assert.equal(paths.secretFile, join("/tmp/pix-test-dir", "sessiond.secret"));
});
