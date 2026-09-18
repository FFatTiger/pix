import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLifetimeLock,
  createPosixSecureStateBackend,
  LocalAuthorityError,
  readStateDocument,
  writeStateDocument,
} from "../dist/state/index.js";

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
