import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  appendFileSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat, open as openHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLifetimeLock,
  createPosixSecureStateBackend,
  LocalAuthorityError,
  readLifetimeLock,
  readStateDocument,
  writeStateDocument,
} from "../dist/state/index.js";
// Private direct-module seam for deterministic precheck→open/read races. This
// stays intentionally absent from the package state surface.
import { readLifetimeLockWithFs, readStateDocumentWithFs } from "../dist/state/posix.js";

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

const MAX = 1024 * 1024;
const alive = () => true;

async function expectReject(fn, code) {
  await assert.rejects(
    fn,
    (e) => e instanceof LocalAuthorityError && e.code === code,
    `expected reject with ${code}`,
  );
}

function lockPayload(pid, instanceId) {
  return `${JSON.stringify({ pid, instanceId, createdAt: 1 })}\n`;
}

test("document: missing reads as missing; write publishes durable 0600 content with no temp debris", async () => {
  const dir = temp("doc-basic-");
  const path = join(dir, "state.json");
  assert.deepEqual(await readStateDocument(path, { maxBytes: MAX }), { missing: true });
  const lockPath = join(dir, "host.lock");
  const owned = await acquireLifetimeLock(lockPath, { payload: lockPayload(process.pid, "instance-doc-01"), isPidAlive: alive });
  await writeStateDocument(path, "{\"a\":1}\n", { maxBytes: MAX, lockCheck: { path: lockPath, ownership: owned } });
  assert.equal(readFileSync(path, "utf8"), "{\"a\":1}\n");
  assert.equal((lstatSync(path).mode & 0o077), 0, "document is 0600");
  assert.equal(readdirSync(dir).filter((n) => n.endsWith(".tmp")).length, 0, "no temp debris");
  assert.deepEqual(await readStateDocument(path, { maxBytes: MAX }), { content: "{\"a\":1}\n" });
  await release(path, lockPath, owned);
});

async function release(_path, lockPath, owned) {
  const { releaseLifetimeLock } = await import("../dist/state/index.js");
  await releaseLifetimeLock(lockPath, { ownership: owned, instanceId: "instance-doc-01" });
}

test("document: bounded read — symlink / non-regular / perms / hard-link / oversize fail closed and stay untouched", async () => {
  const dir = temp("doc-safety-");
  const path = join(dir, "state.json");
  writeFileSync(path, "x", { mode: 0o600 });

  // Symlink document.
  rmSync(path);
  const outside = temp("doc-out-");
  writeFileSync(join(outside, "planted.json"), "{}");
  symlinkSync(join(outside, "planted.json"), path);
  await expectReject(() => readStateDocument(path, { maxBytes: MAX }), "DOC_SYMLINK");

  // Non-regular (directory) document.
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path);
  await expectReject(() => readStateDocument(path, { maxBytes: MAX }), "NOT_REGULAR");

  // Wrong permissions (0644).
  rmSync(path, { recursive: true, force: true });
  writeFileSync(path, "y", { mode: 0o600 });
  chmodSync(path, 0o644);
  await expectReject(() => readStateDocument(path, { maxBytes: MAX }), "DOC_PERMISSIONS");

  // Hard-linked document.
  chmodSync(path, 0o600);
  const aliasDir = temp("doc-alias-");
  linkSync(path, join(aliasDir, "alias"));
  await expectReject(() => readStateDocument(path, { maxBytes: MAX }), "DOC_HARD_LINK");

  // Oversize (bounded read).
  rmSync(path);
  writeFileSync(path, "x".repeat(200), { mode: 0o600 });
  await expectReject(() => readStateDocument(path, { maxBytes: 128 }), "DOC_OVERSIZE");

  // The document was never rewritten/truncated.
  assert.equal(readFileSync(path, "utf8").length, 200);
});

test("document: descriptor-pinned read rejects pre-open replacement, nonregular replacement, and post-open growth", { skip: process.platform === "win32" }, async () => {
  const dir = temp("doc-pinned-race-");
  const path = join(dir, "state.json");
  const original = "original";
  const replacement = "replacement";
  writeFileSync(path, original, { mode: 0o600 });
  const originalPath = join(dir, "state.original");
  let regularFlags;

  // A real regular-file replacement cannot be stopped by O_NOFOLLOW alone;
  // fstat must prove the descriptor is the lstat-approved dev/ino.
  await expectReject(
    () => readStateDocumentWithFs(path, { maxBytes: MAX }, {
      lstat,
      open: async (target, flags) => {
        regularFlags = flags;
        renameSync(path, originalPath);
        writeFileSync(path, replacement, { mode: 0o600 });
        return openHandle(target, flags);
      },
    }),
    "DOC_UNREADABLE",
  );
  assert.equal(readFileSync(path, "utf8"), replacement, "replacement was never returned as approved content");
  assert.ok((regularFlags & constants.O_NOFOLLOW) !== 0, "POSIX open must carry O_NOFOLLOW");

  // A symlink introduced after lstat must not be followed. On POSIX the
  // O_NOFOLLOW open fails; regardless, a fixed DOC_UNREADABLE error is exposed
  // rather than the target's bytes or an errno/path leak.
  const symlinkTarget = join(temp("doc-pinned-target-"), "outside.json");
  writeFileSync(symlinkTarget, "outside", { mode: 0o600 });
  rmSync(path, { force: true });
  writeFileSync(path, original, { mode: 0o600 });
  let symlinkFlags;
  await expectReject(
    () => readStateDocumentWithFs(path, { maxBytes: MAX }, {
      lstat,
      open: async (target, flags) => {
        symlinkFlags = flags;
        rmSync(path, { force: true });
        symlinkSync(symlinkTarget, path);
        return openHandle(target, flags);
      },
    }),
    "DOC_UNREADABLE",
  );
  assert.ok((symlinkFlags & constants.O_NOFOLLOW) !== 0, "replacement symlink is opened no-follow");
  assert.ok((symlinkFlags & constants.O_NONBLOCK) !== 0, "replacement symlink open is nonblocking");
  assert.equal(readFileSync(symlinkTarget, "utf8"), "outside", "outside target stays untouched");

  // O_NOFOLLOW does not reject FIFOs. A directory replacement exercises the
  // same pre-fstat non-regular branch deterministically; the dedicated FIFO
  // test below proves O_NONBLOCK prevents the pre-fstat open from hanging.
  rmSync(path, { recursive: true, force: true });
  writeFileSync(path, original, { mode: 0o600 });
  let nonRegularFlags;
  await expectReject(
    () => readStateDocumentWithFs(path, { maxBytes: MAX }, {
      lstat,
      open: async (target, flags) => {
        nonRegularFlags = flags;
        rmSync(path, { force: true });
        mkdirSync(path);
        return openHandle(target, flags);
      },
    }),
    "DOC_UNREADABLE",
  );
  assert.ok((nonRegularFlags & constants.O_NOFOLLOW) !== 0, "nonregular replacement is opened no-follow");
  assert.ok((nonRegularFlags & constants.O_NONBLOCK) !== 0, "nonregular replacement open is nonblocking");

  // Grow the already-opened inode after its fstat-approved initial size. The
  // implementation reads only that bounded size, then rejects the changed fd
  // state instead of allocating/returning the enlarged document.
  rmSync(path, { recursive: true, force: true });
  writeFileSync(path, original, { mode: 0o600 });
  let grew = false;
  await expectReject(
    () => readStateDocumentWithFs(path, { maxBytes: MAX }, {
      lstat,
      open: async (target, flags) => {
        const handle = await openHandle(target, flags);
        return {
          stat: () => handle.stat(),
          read: async (...args) => {
            if (!grew) {
              grew = true;
              appendFileSync(path, "-grown");
            }
            return handle.read(...args);
          },
          close: () => handle.close(),
        };
      },
    }),
    "DOC_UNREADABLE",
  );
  assert.equal(grew, true, "growth occurred after the descriptor's initial fstat");
  assert.equal(readFileSync(path, "utf8"), `${original}-grown`);
});

test("document: descriptor-pinned FIFO replacement is nonblocking and rejected", { skip: process.platform === "win32" }, async (t) => {
  const dir = temp("doc-pinned-fifo-");
  const path = join(dir, "state.json");
  const fifo = join(dir, "replacement.fifo");
  writeFileSync(path, "safe", { mode: 0o600 });
  const made = spawnSync("/usr/bin/mkfifo", [fifo], { encoding: "utf8", shell: false, windowsHide: true });
  if (made.error?.code === "ENOENT") {
    t.skip("POSIX mkfifo utility unavailable");
    return;
  }
  assert.equal(made.status, 0, `mkfifo failed: ${made.stderr || made.error?.message || "unknown"}`);

  let flags;
  await expectReject(
    () => readStateDocumentWithFs(path, { maxBytes: MAX }, {
      lstat,
      open: async (target, openFlags) => {
        flags = openFlags;
        rmSync(path, { force: true });
        renameSync(fifo, path);
        // Do not open the FIFO under an old implementation: the assertion
        // below makes a missing O_NONBLOCK fail deterministically instead of
        // hanging the test waiting for a FIFO writer.
        if ((openFlags & constants.O_NONBLOCK) === 0) throw new Error("O_NONBLOCK missing");
        return openHandle(target, openFlags);
      },
    }),
    "DOC_UNREADABLE",
  );
  assert.ok((flags & constants.O_NOFOLLOW) !== 0, "FIFO replacement is opened no-follow");
  assert.ok((flags & constants.O_NONBLOCK) !== 0, "FIFO replacement open is nonblocking");
  assert.equal(lstatSync(path).isFIFO(), true, "the substituted path is a FIFO");
});

test("lock: descriptor-pinned read classifies a pre-open replacement as unsafe", { skip: process.platform === "win32" }, async () => {
  const dir = temp("lock-pinned-race-");
  const path = join(dir, "host.lock");
  const original = lockPayload(process.pid, "instance-lock-pinned-a");
  const replacement = lockPayload(process.pid, "instance-lock-pinned-b");
  writeFileSync(path, original, { mode: 0o600 });
  const originalPath = join(dir, "host.original");
  let flags;

  const raced = await readLifetimeLockWithFs(path, {
    lstat,
    open: async (target, openFlags) => {
      flags = openFlags;
      renameSync(path, originalPath);
      writeFileSync(path, replacement, { mode: 0o600 });
      return openHandle(target, openFlags);
    },
  });
  assert.deepEqual(raced, { kind: "unsafe", reason: "LOCK_UNSAFE" });
  assert.ok((flags & constants.O_NOFOLLOW) !== 0, "lock replacement is opened no-follow");
  assert.ok((flags & constants.O_NONBLOCK) !== 0, "lock replacement open is nonblocking");
  assert.equal(readFileSync(path, "utf8"), replacement, "replacement was not parsed as the old lock");

  // A nonregular replacement maps to the lock's non-throwing unsafe union,
  // and uses the same nonblocking descriptor-open primitive.
  const nonRegularPath = join(dir, "nonregular.lock");
  writeFileSync(nonRegularPath, original, { mode: 0o600 });
  let nonRegularFlags;
  const nonRegular = await readLifetimeLockWithFs(nonRegularPath, {
    lstat,
    open: async (target, openFlags) => {
      nonRegularFlags = openFlags;
      rmSync(nonRegularPath, { force: true });
      mkdirSync(nonRegularPath);
      return openHandle(target, openFlags);
    },
  });
  assert.deepEqual(nonRegular, { kind: "unsafe", reason: "LOCK_UNSAFE" });
  assert.ok((nonRegularFlags & constants.O_NONBLOCK) !== 0, "nonregular lock open is nonblocking");

  // A normal, already-established lock remains readable through the public
  // non-throwing union.
  const valid = await readLifetimeLock(path);
  assert.equal(valid.kind, "valid");
  assert.equal(valid.kind === "valid" ? valid.record.instanceId : "", "instance-lock-pinned-b");
});

test("document: oversize write rejected; target symlink/non-regular rejected before publish", async () => {
  const dir = temp("doc-write-safety-");
  const path = join(dir, "state.json");
  const lockPath = join(dir, "host.lock");
  const owned = await acquireLifetimeLock(lockPath, { payload: lockPayload(process.pid, "instance-doc-02"), isPidAlive: alive });
  await expectReject(
    () => writeStateDocument(path, "x".repeat(300), { maxBytes: 128, lockCheck: { path: lockPath, ownership: owned } }),
    "DOC_OVERSIZE",
  );
  const outside = temp("doc-out2-");
  writeFileSync(join(outside, "t.json"), "{}");
  symlinkSync(join(outside, "t.json"), path);
  await expectReject(
    () => writeStateDocument(path, "{}", { maxBytes: MAX, lockCheck: { path: lockPath, ownership: owned } }),
    "NOT_REGULAR",
  );
  await release(path, lockPath, owned);
});

test("document: lockCheck fails closed (LOCK_LOST) when the held lock vanishes before publish", async () => {
  const dir = temp("doc-locklost-");
  const path = join(dir, "state.json");
  const lockPath = join(dir, "host.lock");
  const owned = await acquireLifetimeLock(lockPath, { payload: lockPayload(process.pid, "instance-doc-03"), isPidAlive: alive });
  // Lock removed externally before publish → LOCK_LOST, nothing published.
  rmSync(lockPath, { force: true });
  await expectReject(
    () => writeStateDocument(path, "{}", { maxBytes: MAX, lockCheck: { path: lockPath, ownership: owned } }),
    "LOCK_LOST",
  );
  assert.equal(existsSync(path), false);
  // No lockCheck → write proceeds even though the lock is gone (caller's choice).
  await writeStateDocument(path, "{}", { maxBytes: MAX });
  assert.equal(readFileSync(path, "utf8"), "{}");
});

test("document: injected temp-fsync / rename / dir-fsync failures never report success", async () => {
  const dir = temp("doc-inject-");
  const path = join(dir, "state.json");
  const lockPath = join(dir, "host.lock");
  const owned = await acquireLifetimeLock(lockPath, { payload: lockPayload(process.pid, "instance-doc-04"), isPidAlive: alive });
  await writeStateDocument(path, "base", { maxBytes: MAX, lockCheck: { path: lockPath, ownership: owned } });
  const oldBytes = readFileSync(path);
  const oldIno = lstatSync(path).ino;

  // temp fsync failure → WRITE_FAILED, old content + inode preserved, temp cleaned.
  await expectReject(
    () => writeStateDocument(path, "next", { maxBytes: MAX, lockCheck: { path: lockPath, ownership: owned }, inject: { failTempFsync: () => { throw new Error("injected"); } } }),
    "WRITE_FAILED",
  );
  assert.deepEqual(readFileSync(path), oldBytes);
  assert.equal(lstatSync(path).ino, oldIno);
  assert.equal(readdirSync(dir).filter((n) => n.endsWith(".tmp")).length, 0);

  // rename failure → WRITE_FAILED, old content preserved.
  await expectReject(
    () => writeStateDocument(path, "next", { maxBytes: MAX, lockCheck: { path: lockPath, ownership: owned }, inject: { failRename: () => { throw new Error("injected"); } } }),
    "WRITE_FAILED",
  );
  assert.deepEqual(readFileSync(path), oldBytes);

  // arbitrary dir-fsync failure (EIO) → FATAL (DIR_FSYNC_FAILED).
  await expectReject(
    () => writeStateDocument(path, "next", { maxBytes: MAX, lockCheck: { path: lockPath, ownership: owned }, inject: { failDirFsync: () => { const e = new Error("eio"); e.code = "EIO"; throw e; } } }),
    "DIR_FSYNC_FAILED",
  );

  // truly-unsupported dir-fsync (EINVAL) → tolerated; write reports success.
  await writeStateDocument(path, "next", { maxBytes: MAX, lockCheck: { path: lockPath, ownership: owned }, inject: { failDirFsync: () => { const e = new Error("einval"); e.code = "EINVAL"; throw e; } } });
  assert.equal(readFileSync(path, "utf8"), "next");
  await release(path, lockPath, owned);
});

test("document: crash-window temp debris is never torn; backend merges inject hooks", async () => {
  const dir = temp("doc-temp-");
  const path = join(dir, "state.json");
  const lockPath = join(dir, "host.lock");
  const owned = await acquireLifetimeLock(lockPath, { payload: lockPayload(process.pid, "instance-doc-05"), isPidAlive: alive });
  const backend = createPosixSecureStateBackend({ inject: { failTempFsync: () => { throw new Error("factory inject"); } } });
  // Factory-level inject applies to backend writes.
  await expectReject(
    () => backend.writeStateDocument(path, "x", { maxBytes: MAX, lockCheck: { path: lockPath, ownership: owned } }),
    "WRITE_FAILED",
  );
  assert.equal(readdirSync(dir).filter((n) => n.endsWith(".tmp")).length, 0);
  // A normal backend (no inject) publishes; leftover temp debris from a crash
  // window is a separate file and never tears the published document.
  const clean = createPosixSecureStateBackend();
  await clean.writeStateDocument(path, "stable", { maxBytes: MAX, lockCheck: { path: lockPath, ownership: owned } });
  writeFileSync(join(dir, "state.json.12345.deadbeef.tmp"), "partial", { mode: 0o600 });
  assert.deepEqual(await clean.readStateDocument(path, { maxBytes: MAX }), { content: "stable" });
  await release(path, lockPath, owned);
});
