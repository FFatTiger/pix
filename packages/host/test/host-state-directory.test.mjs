import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  lstatSync,
  linkSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openHostStateDirectoryLease,
  HostStateDirectoryError,
  TRUSTED_ROOTS_STATE_DOCUMENT,
  MANAGED_WORKTREES_STATE_DOCUMENT,
  HOST_STATE_LOCK_NAME,
  DEFAULT_RECOGNIZED_DOCUMENTS,
} from "../dist/resources/host-state-directory.js";

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
    rmSync(`${value}-worktrees`, { recursive: true, force: true });
    rmSync(value, { recursive: true, force: true });
  }
});

function doc(name) {
  return JSON.stringify({ kind: name, version: 1 }) + "\n";
}

// ---------------------------------------------------------------------------
// Lease basics / layout policy
// ---------------------------------------------------------------------------

test("lease: default layout recognizes both trusted-roots and future managed-worktrees sidecar", async () => {
  // Pre-seed a host dir with ONLY the future managed sidecar (rollback
  // compatibility: today's trusted adapter must not treat it as unsafe).
  const hostDir = temp("lease-sidecar-");
  chmodSync(hostDir, 0o700);
  writeFileSync(join(hostDir, MANAGED_WORKTREES_STATE_DOCUMENT), doc("managed"), { mode: 0o600 });
  const lease = await openHostStateDirectoryLease({ hostDir });
  assert.equal(lease.lockPath, join(hostDir, HOST_STATE_LOCK_NAME));
  const result = await lease.readDocument(MANAGED_WORKTREES_STATE_DOCUMENT);
  assert.equal("content" in result && result.content, doc("managed"));
  const trusted = await lease.readDocument(TRUSTED_ROOTS_STATE_DOCUMENT);
  assert.deepEqual(trusted, { missing: true }, "absent trusted doc reads as missing, not unsafe");
  await lease.close();
});

test("lease: unrecognized host-dir entries still fail closed; recognized override is honored", async () => {
  // Unknown entry in an existing 0700 dir → HOST_DIR_UNSAFE before mutation.
  const hostDir = temp("lease-unknown-");
  chmodSync(hostDir, 0o700);
  writeFileSync(join(hostDir, "foreign.bin"), "x", { mode: 0o600 });
  await assert.rejects(
    () => openHostStateDirectoryLease({ hostDir }),
    (e) => e instanceof HostStateDirectoryError && e.code === "HOST_DIR_UNSAFE",
  );
  assert.equal(existsSync(join(hostDir, HOST_STATE_LOCK_NAME)), false);

  // Custom recognized set: a dir carrying the OTHER sidecar becomes unsafe.
  const onlyManaged = temp("lease-only-managed-");
  chmodSync(onlyManaged, 0o700);
  writeFileSync(join(onlyManaged, TRUSTED_ROOTS_STATE_DOCUMENT), doc("trusted"), { mode: 0o600 });
  await assert.rejects(
    () => openHostStateDirectoryLease({ hostDir: onlyManaged, recognizedDocuments: [MANAGED_WORKTREES_STATE_DOCUMENT] }),
    (e) => e instanceof HostStateDirectoryError && e.code === "HOST_DIR_UNSAFE",
  );
  // Same dir with the full default layout opens fine.
  const lease = await openHostStateDirectoryLease({ hostDir: onlyManaged });
  assert.equal("content" in await lease.readDocument(TRUSTED_ROOTS_STATE_DOCUMENT), true);
  await lease.close();
});

test("lease: macOS /var system alias hostDir canonicalizes under /private/var (no false reject)", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS system alias only");
    return;
  }
  // Use the /var-form tmpdir (non-canonicalized) so the root-level `/var` →
  // `/private/var` system alias is exercised through the lease. The leaf is
  // created under the writable canonical temp path.
  const hostDir = join(tmpdir(), `pi-var-alias-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  temporary.push(hostDir);
  const lease = await openHostStateDirectoryLease({ hostDir });
  temporary.push(lease.hostDir);
  assert.equal(lease.hostDir, realpathSync(hostDir), "lease hostDir is canonicalized through the alias");
  assert.equal(lease.hostDir.startsWith("/private/var/"), true);
  assert.equal(lease.lockPath, join(lease.hostDir, HOST_STATE_LOCK_NAME));
  await lease.writeDocument(TRUSTED_ROOTS_STATE_DOCUMENT, doc("t"));
  assert.equal("content" in await lease.readDocument(TRUSTED_ROOTS_STATE_DOCUMENT), true);
  await lease.close();
});

test("lease: unknown document name read/write fail closed (DOC_UNKNOWN)", async () => {
  const hostDir = temp("lease-doc-unknown-");
  const lease = await openHostStateDirectoryLease({ hostDir });
  await assert.rejects(() => lease.readDocument("totally-unknown.json"), (e) => e instanceof HostStateDirectoryError && e.code === "DOC_UNKNOWN");
  await assert.rejects(() => lease.writeDocument("totally-unknown.json", "{}"), (e) => e.code === "DOC_UNKNOWN");
  await lease.close();
});

// ---------------------------------------------------------------------------
// Lifetime lock (shared lease)
// ---------------------------------------------------------------------------

test("lease: second lease same dir fails LOCK_BUSY; stale lock LOCK_STALE; exact-owner unlock", async () => {
  const hostDir = temp("lease-lock-");
  const a = await openHostStateDirectoryLease({ hostDir, instanceId: "instance-a-aaaa" });
  assert.equal(existsSync(a.lockPath), true);
  await assert.rejects(
    () => openHostStateDirectoryLease({ hostDir, instanceId: "instance-b-bbbb" }),
    (e) => e instanceof HostStateDirectoryError && e.code === "LOCK_BUSY",
  );
  // Wrong instance cannot unlock A's lock.
  writeFileSync(a.lockPath, JSON.stringify({ pid: process.pid, instanceId: "instance-other-9", createdAt: 1 }) + "\n", { mode: 0o600 });
  await a.close();
  assert.equal(existsSync(a.lockPath), true, "wrong instance must not unlock another lease's lock");
  rmSync(a.lockPath, { force: true });

  // Stale lock (dead pid) → LOCK_STALE, no auto-reclaim.
  const staleDir = temp("lease-lock-stale-");
  const s = await openHostStateDirectoryLease({ hostDir: staleDir, instanceId: "instance-s-aaaa" });
  writeFileSync(s.lockPath, JSON.stringify({ pid: 999_999_999, instanceId: "dead-instance-xx", createdAt: 1 }) + "\n", { mode: 0o600 });
  await assert.rejects(
    () => openHostStateDirectoryLease({ hostDir: staleDir, instanceId: "instance-c-cccc" }),
    (e) => e.code === "LOCK_STALE",
  );
  // Operator explicitly removes the fixture stale lock, then a new lease works.
  rmSync(s.lockPath, { force: true });
  const s2 = await openHostStateDirectoryLease({ hostDir: staleDir, instanceId: "instance-c-cccc" });
  await s2.close();
});

test("lease: different host dirs are independent (each own lock)", async () => {
  const dirA = temp("lease-ip-a-");
  const dirB = temp("lease-ip-b-");
  const a = await openHostStateDirectoryLease({ hostDir: dirA, instanceId: "instance-ip-a1" });
  const b = await openHostStateDirectoryLease({ hostDir: dirB, instanceId: "instance-ip-b1" });
  await a.writeDocument(TRUSTED_ROOTS_STATE_DOCUMENT, doc("trusted-a"));
  await b.writeDocument(MANAGED_WORKTREES_STATE_DOCUMENT, doc("managed-b"));
  assert.equal(readFileSync(join(dirA, TRUSTED_ROOTS_STATE_DOCUMENT), "utf8"), doc("trusted-a"));
  assert.equal(readFileSync(join(dirB, MANAGED_WORKTREES_STATE_DOCUMENT), "utf8"), doc("managed-b"));
  // No cross-contamination: A does not see B's document as unsafe/absent.
  assert.deepEqual(await a.readDocument(MANAGED_WORKTREES_STATE_DOCUMENT), { missing: true });
  assert.deepEqual(await b.readDocument(TRUSTED_ROOTS_STATE_DOCUMENT), { missing: true });
  await a.close();
  await b.close();
});

// ---------------------------------------------------------------------------
// Atomic durability (shared lease)
// ---------------------------------------------------------------------------

test("lease: injected temp fsync / rename / dir-fsync failures never report success", async () => {
  const hostDir = temp("lease-inject-");
  let lease = await openHostStateDirectoryLease({ hostDir });
  await lease.writeDocument(TRUSTED_ROOTS_STATE_DOCUMENT, doc("base"));
  await lease.close();
  const oldBytes = readFileSync(join(hostDir, TRUSTED_ROOTS_STATE_DOCUMENT));
  const oldIno = lstatSync(join(hostDir, TRUSTED_ROOTS_STATE_DOCUMENT)).ino;

  // temp fsync failure → DOC_WRITE_FAILED, old content preserved, temp cleaned.
  lease = await openHostStateDirectoryLease({ hostDir, failTempFsync: () => { throw new Error("injected"); } });
  await assert.rejects(() => lease.writeDocument(TRUSTED_ROOTS_STATE_DOCUMENT, doc("next")), (e) => e instanceof HostStateDirectoryError && e.code === "DOC_WRITE_FAILED");
  assert.deepEqual(readFileSync(join(hostDir, TRUSTED_ROOTS_STATE_DOCUMENT)), oldBytes);
  assert.equal(lstatSync(join(hostDir, TRUSTED_ROOTS_STATE_DOCUMENT)).ino, oldIno);
  assert.equal(readdirSync(hostDir).filter((n) => n.endsWith(".tmp")).length, 0, "temp must be cleaned on failure");
  await lease.close();

  // rename failure → DOC_WRITE_FAILED, old content preserved.
  lease = await openHostStateDirectoryLease({ hostDir, failRename: () => { throw new Error("injected"); } });
  await assert.rejects(() => lease.writeDocument(TRUSTED_ROOTS_STATE_DOCUMENT, doc("next")), (e) => e.code === "DOC_WRITE_FAILED");
  assert.deepEqual(readFileSync(join(hostDir, TRUSTED_ROOTS_STATE_DOCUMENT)), oldBytes);
  await lease.close();

  // arbitrary dir-fsync failure (EIO) → FATAL: reject, no success reported.
  lease = await openHostStateDirectoryLease({ hostDir, failDirFsync: () => { const e = new Error("eio"); e.code = "EIO"; throw e; } });
  await assert.rejects(() => lease.writeDocument(TRUSTED_ROOTS_STATE_DOCUMENT, doc("next")), (e) => e.code === "DOC_WRITE_FAILED");
  JSON.parse(readFileSync(join(hostDir, TRUSTED_ROOTS_STATE_DOCUMENT), "utf8"));
  await lease.close();

  // truly-unsupported dir-fsync (EINVAL) → tolerated; write reports success.
  lease = await openHostStateDirectoryLease({ hostDir, failDirFsync: () => { const e = new Error("einval"); e.code = "EINVAL"; throw e; } });
  await lease.writeDocument(TRUSTED_ROOTS_STATE_DOCUMENT, doc("next"));
  assert.equal("content" in await lease.readDocument(TRUSTED_ROOTS_STATE_DOCUMENT), true);
  await lease.close();
});

test("lease: validateBeforeLock fails closed without creating any lock file", async () => {
  const hostDir = temp("lease-validate-");
  writeFileSync(join(hostDir, TRUSTED_ROOTS_STATE_DOCUMENT), "{not-json", { mode: 0o600 });
  const beforeBytes = readFileSync(join(hostDir, TRUSTED_ROOTS_STATE_DOCUMENT));
  const beforeIno = lstatSync(join(hostDir, TRUSTED_ROOTS_STATE_DOCUMENT)).ino;
  await assert.rejects(
    () => openHostStateDirectoryLease({
      hostDir,
      validateBeforeLock: async ({ readDocument }) => {
        const result = await readDocument(TRUSTED_ROOTS_STATE_DOCUMENT);
        if ("content" in result) {
          try {
            JSON.parse(result.content);
          } catch {
            throw new Error("corrupt evidence");
          }
        }
      },
    }),
    /corrupt evidence/,
  );
  assert.equal(existsSync(join(hostDir, HOST_STATE_LOCK_NAME)), false, "no lock created on validate failure");
  assert.deepEqual(readFileSync(join(hostDir, TRUSTED_ROOTS_STATE_DOCUMENT)), beforeBytes);
  assert.equal(lstatSync(join(hostDir, TRUSTED_ROOTS_STATE_DOCUMENT)).ino, beforeIno);
});

test("lease: one lease serializes both documents under a single mutex (no lost updates)", async () => {
  const hostDir = temp("lease-shared-");
  const lease = await openHostStateDirectoryLease({ hostDir });
  // Both documents written through the SAME lease's withLock(io) — one mutex.
  await lease.withLock(async (io) => {
    await io.writeDocument(TRUSTED_ROOTS_STATE_DOCUMENT, doc("trusted"));
    await io.writeDocument(MANAGED_WORKTREES_STATE_DOCUMENT, doc("managed"));
  });
  assert.equal(readFileSync(join(hostDir, TRUSTED_ROOTS_STATE_DOCUMENT), "utf8"), doc("trusted"));
  assert.equal(readFileSync(join(hostDir, MANAGED_WORKTREES_STATE_DOCUMENT), "utf8"), doc("managed"));
  // Both read back through the same lease (no cross-document interference).
  assert.equal("content" in await lease.readDocument(TRUSTED_ROOTS_STATE_DOCUMENT), true);
  assert.equal("content" in await lease.readDocument(MANAGED_WORKTREES_STATE_DOCUMENT), true);
  await lease.close();
  // A fresh lease on the same dir reads both persisted documents back.
  const reopened = await openHostStateDirectoryLease({ hostDir });
  assert.equal("content" in await reopened.readDocument(TRUSTED_ROOTS_STATE_DOCUMENT), true);
  assert.equal("content" in await reopened.readDocument(MANAGED_WORKTREES_STATE_DOCUMENT), true);
  await reopened.close();
});

// ---------------------------------------------------------------------------
// Document safety (bounded / perms / hardlink / symlink)
// ---------------------------------------------------------------------------

test("lease: symlink / wrong-permission / hard-linked document fail closed and stay untouched", async () => {
  // Symlink document → DOC_SYMLINK on read, no rewrite.
  const hostDir = temp("lease-doc-safety-");
  const lease = await openHostStateDirectoryLease({ hostDir });
  await lease.writeDocument(TRUSTED_ROOTS_STATE_DOCUMENT, doc("real"));
  const docPath = join(hostDir, TRUSTED_ROOTS_STATE_DOCUMENT);
  rmSync(docPath);
  const outside = temp("lease-doc-out-");
  writeFileSync(join(outside, "planted.json"), "{}");
  symlinkSync(join(outside, "planted.json"), docPath);
  await assert.rejects(() => lease.readDocument(TRUSTED_ROOTS_STATE_DOCUMENT), (e) => e instanceof HostStateDirectoryError && e.code === "DOC_SYMLINK");
  await lease.close();

  // wrong-permission (0644) → DOC_PERMISSIONS on read, bytes+inode unchanged.
  const hostDir2 = temp("lease-doc-perm-");
  let l2 = await openHostStateDirectoryLease({ hostDir: hostDir2 });
  await l2.writeDocument(TRUSTED_ROOTS_STATE_DOCUMENT, doc("perm"));
  await l2.close();
  chmodSync(join(hostDir2, TRUSTED_ROOTS_STATE_DOCUMENT), 0o644);
  const beforeBytes = readFileSync(join(hostDir2, TRUSTED_ROOTS_STATE_DOCUMENT));
  const beforeIno = lstatSync(join(hostDir2, TRUSTED_ROOTS_STATE_DOCUMENT)).ino;
  const permLease = await openHostStateDirectoryLease({ hostDir: hostDir2 });
  await assert.rejects(() => permLease.readDocument(TRUSTED_ROOTS_STATE_DOCUMENT), (e) => e.code === "DOC_PERMISSIONS");
  assert.deepEqual(readFileSync(join(hostDir2, TRUSTED_ROOTS_STATE_DOCUMENT)), beforeBytes);
  assert.equal(lstatSync(join(hostDir2, TRUSTED_ROOTS_STATE_DOCUMENT)).ino, beforeIno);
  await permLease.close();

  // hard-linked document → DOC_HARD_LINK on read.
  const hostDir3 = temp("lease-doc-hlink-");
  l2 = await openHostStateDirectoryLease({ hostDir: hostDir3 });
  await l2.writeDocument(TRUSTED_ROOTS_STATE_DOCUMENT, doc("hlink"));
  await l2.close();
  const aliasDir = temp("lease-doc-alias-");
  linkSync(join(hostDir3, TRUSTED_ROOTS_STATE_DOCUMENT), join(aliasDir, "alias"));
  const hlinkLease = await openHostStateDirectoryLease({ hostDir: hostDir3 });
  await assert.rejects(() => hlinkLease.readDocument(TRUSTED_ROOTS_STATE_DOCUMENT), (e) => e.code === "DOC_HARD_LINK");
  await hlinkLease.close();
});

test("lease: bounded document size — oversize write/read fail closed", async () => {
  const hostDir = temp("lease-oversize-");
  const lease = await openHostStateDirectoryLease({ hostDir, maxDocumentBytes: 128 });
  await assert.rejects(
    () => lease.writeDocument(TRUSTED_ROOTS_STATE_DOCUMENT, JSON.stringify({ big: "x".repeat(300) })),
    (e) => e instanceof HostStateDirectoryError && e.code === "DOC_OVERSIZE",
  );
  // A pre-existing oversize doc fails open (read) closed with DOC_OVERSIZE.
  writeFileSync(join(hostDir, MANAGED_WORKTREES_STATE_DOCUMENT), JSON.stringify({ big: "y".repeat(300) }), { mode: 0o600 });
  await assert.rejects(() => lease.readDocument(MANAGED_WORKTREES_STATE_DOCUMENT), (e) => e.code === "DOC_OVERSIZE");
  await lease.close();
});

test("lease: crash-window temp debris is recognized layout and never tears the document", async () => {
  const hostDir = temp("lease-temp-");
  const lease = await openHostStateDirectoryLease({ hostDir });
  await lease.writeDocument(TRUSTED_ROOTS_STATE_DOCUMENT, doc("stable"));
  writeFileSync(join(hostDir, `${TRUSTED_ROOTS_STATE_DOCUMENT}.12345.deadbeef.tmp`), "partial", { mode: 0o600 });
  assert.equal("content" in await lease.readDocument(TRUSTED_ROOTS_STATE_DOCUMENT), true);
  await lease.close();
  // Restart with leftover temp debris still opens (recognized temp pattern).
  const reopened = await openHostStateDirectoryLease({ hostDir });
  assert.equal("content" in await reopened.readDocument(TRUSTED_ROOTS_STATE_DOCUMENT), true);
  await reopened.close();
});

// ---------------------------------------------------------------------------
// Static guard: shared lease owns the fs primitives
// ---------------------------------------------------------------------------

test("lease: recognized temp pattern covers both state documents", async () => {
  const hostDir = temp("lease-temp-pattern-");
  const lease = await openHostStateDirectoryLease({ hostDir });
  await lease.writeDocument(TRUSTED_ROOTS_STATE_DOCUMENT, doc("t"));
  await lease.writeDocument(MANAGED_WORKTREES_STATE_DOCUMENT, doc("m"));
  // Both temp patterns are part of the recognized layout on reopen.
  await lease.close();
  const reopened = await openHostStateDirectoryLease({ hostDir });
  assert.equal("content" in await reopened.readDocument(MANAGED_WORKTREES_STATE_DOCUMENT), true);
  await reopened.close();
});

test("lease: DEFAULT_RECOGNIZED_DOCUMENTS covers the full Pix layout", () => {
  assert.deepEqual([...DEFAULT_RECOGNIZED_DOCUMENTS], [TRUSTED_ROOTS_STATE_DOCUMENT, MANAGED_WORKTREES_STATE_DOCUMENT]);
});
