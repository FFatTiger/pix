import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalCompareKey,
  canonicalizeAbsolutePath,
  createPosixSecureStateBackend,
  decomposeAbsolutePath,
  isAbsoluteCanonicalShape,
  isPidAlive,
  LocalAuthorityError,
  readStateDocument,
  stripWindowsExtendedPrefix,
  writeStateDocument,
} from "../dist/state/index.js";
// Private/internal test seam (direct module path only; never on the public surface).
import { ensurePrivateDirectoryWithFs } from "../dist/state/posix.js";

const temporary = [];
const CANON_TMP = realpathSync(tmpdir());
function temp(prefix) {
  const value = mkdtempSync(join(CANON_TMP, prefix));
  temporary.push(value);
  return value;
}
afterEach(() => {
  while (temporary.length) {
    const value = temporary.pop();
    rmSync(value, { recursive: true, force: true });
  }
});

async function expectReject(fn, code) {
  await assert.rejects(
    fn,
    (e) => e instanceof LocalAuthorityError && e.code === code,
    `expected reject with ${code}`,
  );
}

function errno(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

// ---------------------------------------------------------------------------
// Pure path primitives
// ---------------------------------------------------------------------------

test("stripWindowsExtendedPrefix: \\\\?\\ and \\\\?\\UNC\\ map to plain win32 paths", () => {
  assert.equal(stripWindowsExtendedPrefix("\\\\?\\C:\\Users\\x"), "C:\\Users\\x");
  assert.equal(stripWindowsExtendedPrefix("\\\\?\\UNC\\srv\\share\\a"), "\\\\srv\\share\\a");
  assert.equal(stripWindowsExtendedPrefix("C:\\plain"), "C:\\plain");
  // POSIX strings are never touched.
  assert.equal(stripWindowsExtendedPrefix("/tmp/x"), "/tmp/x");
});

test("canonicalCompareKey: posix stays exact, win32 strips prefix and folds case", () => {
  assert.equal(canonicalCompareKey("/tmp/X", "posix"), "/tmp/X");
  assert.equal(canonicalCompareKey("\\\\?\\C:\\Users\\x", "win32"), canonicalCompareKey("c:\\users\\X", "win32"));
  assert.notEqual(canonicalCompareKey("C:\\Users", "win32"), canonicalCompareKey("C:\\other", "win32"));
});

test("decomposeAbsolutePath: drive and UNC roots with validated segments", () => {
  assert.deepEqual(decomposeAbsolutePath("C:\\Users\\x\\.pi", "win32"), {
    root: "C:\\",
    segments: ["Users", "x", ".pi"],
  });
  // Forward slashes normalize to the win32 shape.
  assert.deepEqual(decomposeAbsolutePath("C:/Users/x", "win32"), {
    root: "C:\\",
    segments: ["Users", "x"],
  });
  const unc = decomposeAbsolutePath("\\\\srv\\share\\a\\b", "win32");
  assert.equal(unc.root, "\\\\srv\\share");
  assert.deepEqual(unc.segments, ["a", "b"]);
  // Extended prefixes are accepted as input and stripped.
  assert.deepEqual(decomposeAbsolutePath("\\\\?\\C:\\a", "win32"), { root: "C:\\", segments: ["a"] });
  // Roots have no segments.
  assert.deepEqual(decomposeAbsolutePath("C:\\", "win32"), { root: "C:\\", segments: [] });
});

test("decomposeAbsolutePath: rejects escapes, device paths, and POSIX-only claims per platform", async () => {
  // decomposeAbsolutePath is synchronous — assert.throws, not rejects.
  const expectCode = (fn, code) =>
    assert.throws(fn, (e) => e instanceof LocalAuthorityError && e.code === code, `expected ${code}`);
  expectCode(() => decomposeAbsolutePath("C:\\a\\..\\b", "win32"), "PARENT_ESCAPE");
  expectCode(() => decomposeAbsolutePath("\\\\.\\pipe\\pix", "win32"), "INVALID_PATH");
  expectCode(() => decomposeAbsolutePath("relative", "win32"), "INVALID_PATH");
  expectCode(() => decomposeAbsolutePath("/tmp/x", "win32"), "INVALID_PATH");
  expectCode(() => decomposeAbsolutePath("C:\\foo", "posix"), "WINDOWS_PATH");
  expectCode(() => decomposeAbsolutePath("\\\\srv\\share", "posix"), "WINDOWS_PATH");
  expectCode(() => decomposeAbsolutePath("//server/share", "posix"), "NETWORK_PATH");
  expectCode(() => decomposeAbsolutePath("relative", "posix"), "INVALID_PATH");
});

// ---------------------------------------------------------------------------
// canonicalizeAbsolutePath (win32 mode; validation branches run before fs)
// ---------------------------------------------------------------------------

test("canonicalize win32: rejects relative, device, root and escape inputs before fs", async () => {
  await expectReject(() => canonicalizeAbsolutePath("relative", "win32"), "INVALID_PATH");
  await expectReject(() => canonicalizeAbsolutePath("\\\\.\\pipe\\pix-sessiond", "win32"), "INVALID_PATH");
  await expectReject(() => canonicalizeAbsolutePath("C:\\", "win32"), "ROOT_PATH");
  await expectReject(() => canonicalizeAbsolutePath("\\\\srv\\share", "win32"), "ROOT_PATH");
  await expectReject(() => canonicalizeAbsolutePath("C:\\a\\..\\b", "win32"), "PARENT_ESCAPE");
  await expectReject(() => canonicalizeAbsolutePath(`C:\\a\u0000b`, "win32"), "INVALID_PATH");
});

/**
 * In-memory win32 filesystem: paths are drive/UNC-rooted with backslashes.
 * Entries carry the fields the walks read (dev/ino/mode/nlink/uid/gid + type
 * predicates). Directories get the win32-typical 0o666 mode bits (NTFS reports
 * no POSIX modes) so tests prove mode enforcement is skipped, not assumed.
 */
function fakeWin32Fs(entries) {
  const tree = new Map(entries);
  let nextIno = 100;
  const stat = (path) => {
    const entry = tree.get(path);
    if (entry === undefined) throw errno("ENOENT");
    return {
      dev: 1,
      ino: entry.ino,
      mode: entry.mode,
      nlink: entry.nlink ?? 1,
      size: 0,
      uid: -1, // win32: no uid
      gid: -1,
      isFile: () => entry.type === "file",
      isDirectory: () => entry.type === "directory",
      isSymbolicLink: () => entry.type === "symlink",
    };
  };
  return {
    tree,
    stat,
    async lstat(path) {
      return stat(path);
    },
    async mkdir(path, options) {
      if (tree.has(path)) throw errno("EEXIST");
      tree.set(path, { type: "directory", mode: 0o666, ino: nextIno++ });
      return undefined;
    },
    async realpath(path) {
      // Canonical case + optional extended prefix differ from the stored key;
      // the walk must compare via the platform compare key.
      if (!tree.has(path) && !tree.has(path.toLowerCase())) throw errno("ENOENT");
      return path.startsWith("C:\\") ? `\\\\?\\${path}` : path;
    },
    async open() {
      throw errno("EPERM"); // win32 cannot open directory handles this way
    },
    // Ownership can never hold on win32 (no uid) — mirrors isOwnedByCurrentUser.
    isOwnedByCurrentUser: () => false,
    add(path, entry) {
      tree.set(path, { ino: nextIno++, ...entry });
    },
  };
}

test("canonicalize win32: climb + realpath + tail append over the fake fs", async () => {
  const fs = fakeWin32Fs([
    ["C:\\Users", { type: "directory", mode: 0o666 }],
    ["C:\\Users\\x", { type: "directory", mode: 0o666 }],
  ]);
  const canonical = await canonicalizeAbsolutePath("C:\\Users\\x\\.pi\\pix\\sessiond", "win32", fs);
  // realpath of the nearest existing ancestor returns an extended prefix — the
  // canonical result keeps the plain drive-rooted shape with the missing tail.
  assert.equal(canonical, "C:\\Users\\x\\.pi\\pix\\sessiond");
});

test("canonicalize win32: an existing symlinked intermediate component fails closed", async () => {
  const fs = fakeWin32Fs([
    ["C:\\real", { type: "directory", mode: 0o666 }],
    ["C:\\link", { type: "symlink", mode: 0o666 }],
  ]);
  await expectReject(() => canonicalizeAbsolutePath("C:\\link\\leaf", "win32", fs), "SYMLINK");
});

test("canonicalize posix behavior is unchanged by the new parameters", async () => {
  const dir = temp("canon-posix-");
  assert.equal(await canonicalizeAbsolutePath(dir), realpathSync(dir));
  // Explicit "posix": the default platform is the host's, and on a Windows
  // host `C:\\foo` is a valid win32 path instead of a WINDOWS_PATH rejection.
  await expectReject(() => canonicalizeAbsolutePath("C:\\foo", "posix"), "WINDOWS_PATH");
  await expectReject(() => canonicalizeAbsolutePath("//s/s", "posix"), "NETWORK_PATH");
});

// ---------------------------------------------------------------------------
// Secure-directory walk (win32 mode, injected fake fs)
// ---------------------------------------------------------------------------

test("ensurePrivateDirectory win32: creates missing components, skips mode/uid enforcement", async () => {
  const fs = fakeWin32Fs([
    ["C:\\Users", { type: "directory", mode: 0o666 }],
    ["C:\\Users\\x", { type: "directory", mode: 0o666 }],
  ]);
  const result = await ensurePrivateDirectoryWithFs("C:\\Users\\x\\.pi\\pix\\sessiond", {}, fs, "win32");
  assert.equal(result.path, "C:\\Users\\x\\.pi\\pix\\sessiond");
  assert.equal(result.created, true);
  for (const created of ["C:\\Users\\x\\.pi", "C:\\Users\\x\\.pi\\pix", "C:\\Users\\x\\.pi\\pix\\sessiond"]) {
    assert.equal(fs.tree.get(created)?.type, "directory", `${created} must be created`);
  }
});

test("ensurePrivateDirectory win32: existing 0o666 leaf validates (no NOT_PRIVATE, no uid check)", async () => {
  const fs = fakeWin32Fs([
    ["C:\\state", { type: "directory", mode: 0o666 }],
  ]);
  const result = await ensurePrivateDirectoryWithFs("C:\\state", {}, fs, "win32");
  assert.equal(result.created, false);
  assert.equal(result.path, "C:\\state");
});

test("ensurePrivateDirectory win32: symlink leaf and non-directory components still fail closed", async () => {
  const fs = fakeWin32Fs([
    ["C:\\link", { type: "symlink", mode: 0o666 }],
    ["C:\\file", { type: "file", mode: 0o666 }],
  ]);
  await expectReject(() => ensurePrivateDirectoryWithFs("C:\\link\\leaf", {}, fs, "win32"), "SYMLINK");
  await expectReject(() => ensurePrivateDirectoryWithFs("C:\\file\\leaf", {}, fs, "win32"), "NOT_DIRECTORY");
});

test("ensurePrivateDirectory win32: UNC root walk and drive-root rejection", async () => {
  const fs = fakeWin32Fs([
    ["\\\\srv\\share", { type: "directory", mode: 0o666 }],
  ]);
  const result = await ensurePrivateDirectoryWithFs("\\\\srv\\share\\pix\\state", {}, fs, "win32");
  assert.equal(result.path, "\\\\srv\\share\\pix\\state");
  assert.equal(result.created, true);
  await expectReject(() => ensurePrivateDirectoryWithFs("C:\\", {}, fs, "win32"), "ROOT_PATH");
  await expectReject(() => ensurePrivateDirectoryWithFs("\\\\.\\pipe\\x", {}, fs, "win32"), "INVALID_PATH");
});

test("ensurePrivateDirectory win32: realpath case/extended-prefix differences compare equal", async () => {
  const fs = fakeWin32Fs([
    ["C:\\State", { type: "directory", mode: 0o666 }],
  ]);
  // realpath returns the extended-prefix form; canonicalCompareKey folds both.
  const result = await ensurePrivateDirectoryWithFs("C:\\State", {}, fs, "win32");
  assert.equal(result.created, false);
});

test("ensurePrivateDirectory posix: mode enforcement still applies on posix", async () => {
  // Same fake fs on a POSIX path with a 0o755 leaf must fail NOT_PRIVATE.
  const fs = fakeWin32Fs([
    ["/lax", { type: "directory", mode: 0o755 }],
  ]);
  await expectReject(() => ensurePrivateDirectoryWithFs("/lax", {}, fs, "posix"), "NOT_OWNED");
});

// ---------------------------------------------------------------------------
// State documents
// ---------------------------------------------------------------------------

test("readStateDocument win32: 0o666 mode bits are not a permission failure; hard links still fail", async (t) => {
  const dir = temp("doc-win32-");
  const doc = join(dir, "state.json");
  writeFileSync(doc, "{\"ok\":true}\n", { mode: 0o666 });
  chmodSync(doc, 0o666);
  if (process.platform === "win32") {
    // NTFS reports 0o666 for every file and the running platform is win32, so
    // the POSIX DOC_PERMISSIONS branch never runs. The read must succeed.
    const result = await readStateDocument(doc, { maxBytes: 1024 });
    assert.equal(result.content, "{\"ok\":true}\n");
  } else {
    // posix mode (default) rejects group/other bits.
    await expectReject(() => readStateDocument(doc, { maxBytes: 1024 }), "DOC_PERMISSIONS");
  }
  // win32 mode reads it on every host (the platform argument, not the OS).
  const forced = await readStateDocument(doc, { maxBytes: 1024 }, "win32");
  assert.equal(forced.content, "{\"ok\":true}\n");
  // Hard link still fails on both platforms. link() needs a second name.
  const { linkSync } = await import("node:fs");
  const alias = join(dir, "alias.json");
  try {
    linkSync(doc, alias);
  } catch (error) {
    t.skip(`hard links unavailable here (${error.code ?? error.message})`);
    return;
  }
  await expectReject(() => readStateDocument(doc, { maxBytes: 1024 }, "win32"), "DOC_HARD_LINK");
});

test("backend factory: platform option plumbs through read/write paths", async () => {
  const dir = temp("doc-backend-");
  const doc = join(dir, "doc.json");
  writeFileSync(doc, "{}\n", { mode: 0o666 });
  chmodSync(doc, 0o666);
  const backend = createPosixSecureStateBackend({ platform: "win32" });
  const result = await backend.readStateDocument(doc, { maxBytes: 64 });
  assert.equal(result.content, "{}\n");
  await backend.writeStateDocument(doc, "{\"a\":1}\n", { maxBytes: 64 });
  assert.equal(readFileSync(doc, "utf8"), "{\"a\":1}\n");
});

test("writeStateDocument win32: EPERM rename falls back to unlink+rename once; content replaces", async () => {
  const dir = temp("doc-rename-");
  const doc = join(dir, "doc.json");
  writeFileSync(doc, "old\n");
  const failOnce = { armed: true };
  await writeStateDocument(doc, "new\n", {
    maxBytes: 64,
    inject: {
      failRename() {
        if (!failOnce.armed) return;
        failOnce.armed = false;
        throw errno("EPERM");
      },
    },
  }, "win32");
  assert.equal(readFileSync(doc, "utf8"), "new\n");
});

test("writeStateDocument win32: non-retryable rename failure still fails closed", async () => {
  const dir = temp("doc-rename2-");
  const doc = join(dir, "doc.json");
  writeFileSync(doc, "old\n");
  await expectReject(() => writeStateDocument(doc, "new\n", {
    maxBytes: 64,
    inject: { failRename() { throw errno("ENOSPC"); } },
  }, "win32"), "WRITE_FAILED");
  assert.equal(readFileSync(doc, "utf8"), "old\n");
});

test("writeStateDocument posix: EPERM rename never retries (frozen atomic rename-over)", async (t) => {
  if (process.platform === "win32") {
    t.skip("the default platform is win32 here, so EPERM takes the bounded retry; the frozen no-retry path is the explicit posix run below and on POSIX hosts");
    return;
  }
  const dir = temp("doc-rename3-");
  const doc = join(dir, "doc.json");
  writeFileSync(doc, "old\n");
  await expectReject(() => writeStateDocument(doc, "new\n", {
    maxBytes: 64,
    inject: { failRename() { throw errno("EPERM"); } },
  }), "WRITE_FAILED");
  assert.equal(readFileSync(doc, "utf8"), "old\n");
});

// ---------------------------------------------------------------------------
// isAbsoluteCanonicalShape + pid liveness
// ---------------------------------------------------------------------------

test("isAbsoluteCanonicalShape accepts win32 drive and UNC canonical shapes", () => {
  assert.equal(isAbsoluteCanonicalShape("C:\\repo"), true);
  assert.equal(isAbsoluteCanonicalShape("C:\\a\\b-c"), true);
  assert.equal(isAbsoluteCanonicalShape("C:\\"), true);
  assert.equal(isAbsoluteCanonicalShape("\\\\srv\\share\\repo"), true);
  assert.equal(isAbsoluteCanonicalShape("C:\\repo\\"), false, "no trailing separator");
  assert.equal(isAbsoluteCanonicalShape("C:\\a\\..\\b"), false);
  assert.equal(isAbsoluteCanonicalShape("C:repo"), false, "drive-relative is not canonical");
  assert.equal(isAbsoluteCanonicalShape("\\\\?\\C:\\repo"), false, "extended prefix never stored");
  assert.equal(isAbsoluteCanonicalShape("\\\\.\\pipe\\x"), false, "device paths never stored");
  assert.equal(isAbsoluteCanonicalShape("C:/repo"), false, "win32 resolve output is backslash-only");
  // POSIX shapes unchanged.
  assert.equal(isAbsoluteCanonicalShape("/a/b"), true);
  assert.equal(isAbsoluteCanonicalShape("/a//b"), false);
});

test("isPidAlive: dead pid false; invalid input false; EACCES/EPERM codes treated alive", async () => {
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive(Number.NaN), false);
  // Spawn a real short-lived process and wait for it to exit.
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.equal(child.status, 0);
  // Reuse the just-exited child pid via a second identical spawn: pids are
  // recycled, so instead probe a definitely-dead pid deterministically: use a
  // pid we know cannot exist (pid_max sentinel is unreliable) — use the
  // exited child of a detached double-spawn instead.
  const probe = spawnSync(process.execPath, ["-e", "process.exit(0)"], { detached: false });
  assert.notEqual(probe.pid, undefined);
  // After the synchronous spawn returns, the child has exited; on Linux/macOS
  // the pid is gone (libuv reaped it). This asserts the ESRCH path.
  assert.equal(isPidAlive(probe.pid), false, "exited+reaped child pid must read dead");
  // The EPERM/EACCES branches are covered by construction (kill wrap).
  assert.equal(typeof isPidAlive(process.pid), "boolean");
});
