import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLifetimeLock,
  createPosixSecureStateBackend,
  isLifetimeLockTempName,
  lifetimeLockTempName,
  LocalAuthorityError,
  readLifetimeLock,
  releaseLifetimeLock,
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

function lockPayload(pid, instanceId, createdAt) {
  return `${JSON.stringify({ pid, instanceId, createdAt })}\n`;
}

const deadPid = 999_999_999;
function neverAlive() { return false; }
function alwaysAlive() { return true; }

async function expectReject(fn, code) {
  await assert.rejects(
    fn,
    (e) => e instanceof LocalAuthorityError && e.code === code,
    `expected reject with ${code}`,
  );
}

test("lock: acquire pins dev/ino identity; release removes only the exact owner", async () => {
  const dir = temp("lock-owner-");
  const lockPath = join(dir, "host.lock");
  const owned = await acquireLifetimeLock(lockPath, {
    payload: lockPayload(process.pid, "instance-a-aaaa", 1),
    isPidAlive: alwaysAlive,
  });
  assert.equal(owned.dev, lstatSync(lockPath).dev);
  assert.equal(owned.ino, lstatSync(lockPath).ino);
  // NTFS reports no POSIX mode bits, so 0600 is not observable there.
  if (process.platform !== "win32") {
    assert.equal((lstatSync(lockPath).mode & 0o077), 0, "lock is 0600");
  }

  // A live lock → LOCK_BUSY.
  await expectReject(
    () => acquireLifetimeLock(lockPath, { payload: lockPayload(process.pid, "instance-b-bbbb", 2), isPidAlive: alwaysAlive }),
    "LOCK_BUSY",
  );

  // Wrong instance id cannot release another handle's lock.
  await releaseLifetimeLock(lockPath, { ownership: owned, instanceId: "instance-other-9" });
  assert.equal(existsSync(lockPath), true, "wrong instance must not unlock");

  // Wrong identity (replaced lock) cannot release.
  const swapped = await acquireLifetimeLock(join(dir, "other.lock"), { payload: lockPayload(process.pid, "instance-c-cccc", 3), isPidAlive: alwaysAlive });
  await releaseLifetimeLock(lockPath, { ownership: swapped, instanceId: "instance-a-aaaa" });
  assert.equal(existsSync(lockPath), true, "wrong identity must not unlock");

  // Exact owner releases.
  await releaseLifetimeLock(lockPath, { ownership: owned, instanceId: "instance-a-aaaa" });
  assert.equal(existsSync(lockPath), false);
  await releaseLifetimeLock(lockPath, { ownership: owned, instanceId: "instance-a-aaaa" });
  // Release of a missing lock is a no-op.
});

test("lock: stale (dead pid) is reclaimed and the acquire retries; onStaleReclaim reports the owner", async () => {
  const dir = temp("lock-stale-");
  const lockPath = join(dir, "host.lock");
  writeFileSync(lockPath, lockPayload(deadPid, "dead-instance-xx", 1), { mode: 0o600 });
  const reclaimed = [];
  const owned = await acquireLifetimeLock(lockPath, {
    payload: lockPayload(process.pid, "instance-c-cccc", 2),
    isPidAlive: neverAlive,
    onStaleReclaim: (record) => reclaimed.push(record),
  });
  assert.deepEqual(reclaimed, [{ pid: deadPid, instanceId: "dead-instance-xx", createdAt: 1 }]);
  const current = await readLifetimeLock(lockPath);
  assert.equal(current.kind, "valid");
  if (current.kind === "valid") {
    assert.equal(current.record.instanceId, "instance-c-cccc", "the reclaimed path now holds OUR record");
    assert.equal(current.identity.ino, owned.ino);
  }
  assert.deepEqual(readdirSync(dir), ["host.lock"], "no reclaim debris left behind");
  await releaseLifetimeLock(lockPath, { ownership: owned, instanceId: "instance-c-cccc" });
  assert.equal(existsSync(lockPath), false);
});

test("lock: a live owner is LOCK_BUSY and its lock is never touched", async () => {
  const dir = temp("lock-live-");
  const lockPath = join(dir, "host.lock");
  writeFileSync(lockPath, lockPayload(process.pid, "live-instance-aa", 7), { mode: 0o600 });
  const before = readFileSync(lockPath);
  const beforeIno = lstatSync(lockPath).ino;
  await expectReject(
    () => acquireLifetimeLock(lockPath, {
      payload: lockPayload(process.pid, "instance-z-zzzz", 8),
      isPidAlive: alwaysAlive,
      onStaleReclaim: () => assert.fail("a live lock must never be reported as reclaimed"),
    }),
    "LOCK_BUSY",
  );
  assert.deepEqual(readFileSync(lockPath), before, "live lock bytes unchanged");
  assert.equal(lstatSync(lockPath).ino, beforeIno, "live lock inode unchanged");
  assert.equal(existsSync(lockPath), true);
});

test("lock: reclaim quarantine is recognized debris and never blocks a later acquire", async () => {
  const dir = temp("lock-quarantine-");
  const lockPath = join(dir, "host.lock");
  // Simulate a SIGKILL between the quarantine rename and its unlink.
  const debris = lifetimeLockTempName("host.lock", 4321, "0f8fad5b-d9cb-469f-a165-70867728950e");
  writeFileSync(join(dir, debris), lockPayload(deadPid, "dead-instance-yy", 1), { mode: 0o600 });
  assert.equal(isLifetimeLockTempName("host.lock", debris), true);
  assert.equal(isLifetimeLockTempName("host.lock", "host.lock"), false);
  writeFileSync(lockPath, lockPayload(deadPid, "dead-instance-xx", 1), { mode: 0o600 });
  const owned = await acquireLifetimeLock(lockPath, {
    payload: lockPayload(process.pid, "instance-h-hhhh", 2),
    isPidAlive: neverAlive,
  });
  await releaseLifetimeLock(lockPath, { ownership: owned, instanceId: "instance-h-hhhh" });
});

test("lock: malformed existing lock is unsafe; vanished-at-O_EXCL is ambiguous", async () => {
  const dir = temp("lock-unsafe-");
  const lockPath = join(dir, "host.lock");
  // Malformed JSON.
  writeFileSync(lockPath, "{not-json", { mode: 0o600 });
  await expectReject(
    () => acquireLifetimeLock(lockPath, { payload: lockPayload(process.pid, "instance-d-dddd", 1), isPidAlive: alwaysAlive }),
    "LOCK_UNSAFE",
  );
  // Wrong shape (missing instanceId).
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: 1 }) + "\n", { mode: 0o600 });
  await expectReject(
    () => acquireLifetimeLock(lockPath, { payload: lockPayload(process.pid, "instance-d-dddd", 1), isPidAlive: alwaysAlive }),
    "LOCK_UNSAFE",
  );
  // Invalid instance id (too short / control char).
  writeFileSync(lockPath, lockPayload(process.pid, "short", 1), { mode: 0o600 });
  await expectReject(
    () => acquireLifetimeLock(lockPath, { payload: lockPayload(process.pid, "instance-d-dddd", 1), isPidAlive: alwaysAlive }),
    "LOCK_UNSAFE",
  );
});

test("lock: readLifetimeLock classifies missing / unsafe / valid", async () => {
  const dir = temp("lock-read-");
  const lockPath = join(dir, "host.lock");
  assert.deepEqual(await readLifetimeLock(lockPath), { kind: "missing" });
  writeFileSync(lockPath, "garbage", { mode: 0o600 });
  assert.equal((await readLifetimeLock(lockPath)).kind, "unsafe");
  writeFileSync(lockPath, lockPayload(process.pid, "instance-e-eeee", 42), { mode: 0o600 });
  const result = await readLifetimeLock(lockPath);
  assert.equal(result.kind, "valid");
  if (result.kind === "valid") {
    assert.equal(result.record.pid, process.pid);
    assert.equal(result.record.instanceId, "instance-e-eeee");
    assert.equal(result.record.createdAt, 42);
    assert.equal(result.identity.ino, lstatSync(lockPath).ino);
  }
});

test("lock: backend delegates acquire/read/release", async () => {
  const dir = temp("lock-backend-");
  const lockPath = join(dir, "host.lock");
  const backend = createPosixSecureStateBackend();
  const owned = await backend.acquireLifetimeLock(lockPath, {
    payload: lockPayload(process.pid, "instance-f-ffff", 1),
    isPidAlive: alwaysAlive,
  });
  assert.equal((await backend.readLifetimeLock(lockPath)).kind, "valid");
  await expectReject(
    () => backend.acquireLifetimeLock(lockPath, { payload: lockPayload(process.pid, "instance-g-gggg", 2), isPidAlive: alwaysAlive }),
    "LOCK_BUSY",
  );
  await backend.releaseLifetimeLock(lockPath, { ownership: owned, instanceId: "instance-f-ffff" });
  assert.equal(existsSync(lockPath), false);
});
