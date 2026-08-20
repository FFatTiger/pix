import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  writeFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  lstatSync,
  linkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openManagedWorktreesLedger,
  createManagedWorktreesLedgerFromLease,
  parseManagedWorktreesDocument,
  serializeManagedWorktreesDocument,
  MANAGED_WORKTREES_KIND,
  MANAGED_WORKTREES_VERSION,
  MANAGED_WORKTREES_SOURCE,
  MANAGED_WORKTREES_FILE_NAME,
  ManagedWorktreesLedgerError,
} from "../dist/resources/managed-worktrees-ledger.js";
import { openHostStateDirectoryLease } from "../dist/resources/host-state-directory.js";
import { openTrustedRootsLedger, LEDGER_FILE_NAME } from "../dist/resources/trusted-roots-ledger.js";

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

function mrecord(overrides = {}) {
  const repoRoot = overrides.repoRoot ?? "/tmp/repo";
  const path = overrides.path ?? "/tmp/repo-worktrees/x";
  const commonDir = overrides.commonDir ?? "/tmp/repo/.git";
  const adminDir = overrides.adminDir ?? "/tmp/repo/.git/worktrees/x";
  const base = overrides.base ?? "/tmp/repo-worktrees";
  return {
    worktreeId: overrides.worktreeId ?? "mwt-aaaaaaaa",
    path,
    dev: overrides.dev ?? 11,
    ino: overrides.ino ?? 22,
    repoRoot,
    repoDev: overrides.repoDev ?? 33,
    repoIno: overrides.repoIno ?? 44,
    commonDir,
    commonDev: overrides.commonDev ?? 55,
    commonIno: overrides.commonIno ?? 66,
    adminDir,
    adminDev: overrides.adminDev ?? 77,
    adminIno: overrides.adminIno ?? 88,
    base,
    baseDev: overrides.baseDev ?? 99,
    baseIno: overrides.baseIno ?? 100,
    createdAt: overrides.createdAt ?? "2020-01-01T00:00:00.000Z",
    source: MANAGED_WORKTREES_SOURCE,
    branchAtCreate: overrides.branchAtCreate ?? "feature/x",
    branchCreatedByPix: overrides.branchCreatedByPix ?? true,
  };
}

// ---------------------------------------------------------------------------
// parse / serialize
// ---------------------------------------------------------------------------

test("managed ledger: parse/serialize round-trip; deterministic sort; wrong kind/version/corrupt fail closed", () => {
  const a = mrecord({ worktreeId: "mwt-aaaaaaa2", path: "/tmp/repo-worktrees/z" });
  const b = mrecord({ worktreeId: "mwt-aaaaaaa1", path: "/tmp/repo-worktrees/a" });
  const text = serializeManagedWorktreesDocument([a, b]);
  const parsed = parseManagedWorktreesDocument(text, 8);
  assert.equal(parsed.warning, undefined);
  assert.deepEqual(parsed.records.map((r) => r.worktreeId), ["mwt-aaaaaaa1", "mwt-aaaaaaa2"]);
  assert.equal(serializeManagedWorktreesDocument([a, b]), serializeManagedWorktreesDocument([b, a]));

  assert.equal(parseManagedWorktreesDocument("not-json", 8).warning, "MANAGED_CORRUPT");
  assert.equal(parseManagedWorktreesDocument(JSON.stringify({ kind: "other", version: 1, records: [] }), 8).warning, "MANAGED_WRONG_KIND");
  assert.equal(parseManagedWorktreesDocument(JSON.stringify({ kind: MANAGED_WORKTREES_KIND, version: 99, records: [] }), 8).warning, "MANAGED_UNKNOWN_VERSION");
  assert.equal(parseManagedWorktreesDocument(JSON.stringify({ kind: MANAGED_WORKTREES_KIND, version: 1, records: [], extra: true }), 8).warning, "MANAGED_CORRUPT");
  assert.equal(parseManagedWorktreesDocument(JSON.stringify({ kind: MANAGED_WORKTREES_KIND, version: 1, claims: [] }), 8).warning, "MANAGED_CORRUPT");
});

test("managed ledger: dev/ino/... are optional audit fields (L-04, no identity schema)", () => {
  const repoRoot = join(CANON_TMP, "managed-schema-repo");
  const commonDir = join(repoRoot, ".git");
  const base = `${repoRoot}-worktrees`;
  const noId = {
    worktreeId: "mwt-no-id-00001",
    path: join(base, "x"),
    repoRoot,
    commonDir,
    adminDir: join(commonDir, "worktrees", "x"),
    base,
    createdAt: "2020-01-01T00:00:00.000Z",
    source: MANAGED_WORKTREES_SOURCE,
    branchAtCreate: "feature",
    branchCreatedByPix: true,
  };
  const parsed = parseManagedWorktreesDocument(JSON.stringify({ kind: MANAGED_WORKTREES_KIND, version: 1, records: [noId] }), 8);
  assert.equal(parsed.warning, undefined, "a record without dev/ino must still parse");
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].baseDev, undefined);
  assert.equal(parsed.records[0].commonIno, undefined);
  const text = serializeManagedWorktreesDocument(parsed.records);
  assert.ok(!text.includes('"baseDev"'), "absent baseDev must not be serialized");
  assert.ok(!text.includes('"commonIno"'), "absent commonIno must not be serialized");
  const reparsed = parseManagedWorktreesDocument(text, 8);
  assert.equal(reparsed.warning, undefined);
  assert.equal(reparsed.records[0].worktreeId, "mwt-no-id-00001");

  // Optional means absent as a PAIR, never orphan audit evidence.
  for (const orphan of [
    { ...noId, dev: 1 },
    { ...noId, ino: 2 },
    { ...noId, commonDev: 3 },
    { ...noId, commonIno: 4 },
    { ...noId, baseDev: 5 },
    { ...noId, baseIno: 6 },
  ]) {
    const rejected = parseManagedWorktreesDocument(JSON.stringify({ kind: MANAGED_WORKTREES_KIND, version: 1, records: [orphan] }), 8);
    assert.equal(rejected.warning, "MANAGED_SPARSE");
  }
  assert.throws(
    () => serializeManagedWorktreesDocument([{ ...noId, adminDev: 7 }]),
    (error) => error instanceof ManagedWorktreesLedgerError && error.code === "MANAGED_WRITE_REJECTED",
  );
});

test("managed ledger: sparse / duplicate / oversize fail closed", () => {
  assert.equal(parseManagedWorktreesDocument(JSON.stringify({ kind: MANAGED_WORKTREES_KIND, version: 1, records: [{ worktreeId: "x" }] }), 8).warning, "MANAGED_SPARSE");
  const dup = parseManagedWorktreesDocument(JSON.stringify({
    kind: MANAGED_WORKTREES_KIND, version: 1,
    records: [mrecord(), mrecord({ path: "/tmp/repo-worktrees/other" })],
  }), 8);
  assert.equal(dup.warning, "MANAGED_DUPLICATE");
  const many = Array.from({ length: 5 }, (_, i) => mrecord({ worktreeId: `mwt-${i}-aaaaaa`, path: `/tmp/repo-worktrees/p${i}` }));
  assert.equal(parseManagedWorktreesDocument(JSON.stringify({ kind: MANAGED_WORKTREES_KIND, version: 1, records: many }), 2).warning, "MANAGED_OVERSIZE");
});

test("managed ledger: control chars (C0/DEL) in metadata rejected; unknown fields rejected", () => {
  for (const bad of ["feature\x00x", "feature\x1fx", "feature\x7fx"]) {
    const sparse = parseManagedWorktreesDocument(JSON.stringify({
      kind: MANAGED_WORKTREES_KIND, version: 1,
      records: [mrecord({ branchAtCreate: bad })],
    }), 8);
    assert.equal(sparse.warning, "MANAGED_SPARSE", `branch control char ${JSON.stringify(bad)}`);
  }
  for (const bad of ["id\x00x", "id\x1fx"]) {
    const sparse = parseManagedWorktreesDocument(JSON.stringify({
      kind: MANAGED_WORKTREES_KIND, version: 1,
      records: [mrecord({ worktreeId: bad })],
    }), 8);
    assert.equal(sparse.warning, "MANAGED_SPARSE", `worktreeId control char ${JSON.stringify(bad)}`);
  }
  const extra = parseManagedWorktreesDocument(JSON.stringify({
    kind: MANAGED_WORKTREES_KIND, version: 1,
    records: [{ ...mrecord(), sneaky: true }],
  }), 8);
  assert.equal(extra.warning, "MANAGED_SPARSE");
});

test("managed ledger: containment violations (path/base/common/admin) fail closed", () => {
  const cases = [
    { path: "/tmp/repo-worktrees" }, // path === base
    { path: "/tmp/elsewhere/x" }, // outside base
    { base: "/tmp/other-worktrees" }, // base != `${repoRoot}-worktrees`
    { commonDir: "/tmp/other/.git" }, // dirname(commonDir) !== repoRoot
    { adminDir: "/tmp/elsewhere/admin" }, // admin outside commonDir
    { repoRoot: "/tmp/repo/sub" }, // repoRoot not dirname(commonDir)
  ];
  for (const overrides of cases) {
    const parsed = parseManagedWorktreesDocument(JSON.stringify({
      kind: MANAGED_WORKTREES_KIND, version: 1,
      records: [mrecord(overrides)],
    }), 8);
    assert.equal(parsed.warning, "MANAGED_SPARSE", JSON.stringify(overrides));
  }
});

// ---------------------------------------------------------------------------
// open / missing / fail-closed immutability
// ---------------------------------------------------------------------------

test("managed ledger: missing sidecar is empty and stays absent until first record", async () => {
  const hostDir = temp("mwt-missing-");
  const ledger = await openManagedWorktreesLedger({ hostDir });
  assert.equal(existsSync(ledger.ledgerPath), false, "sidecar must not be created at open");
  assert.deepEqual((await ledger.read()).records, []);
  await ledger.writeAll([mrecord()]);
  assert.equal(existsSync(ledger.ledgerPath), true, "sidecar created on first record");
  const body = JSON.parse(await (await import("node:fs/promises")).readFile(ledger.ledgerPath, "utf8"));
  assert.equal(body.kind, MANAGED_WORKTREES_KIND);
  assert.equal(body.version, MANAGED_WORKTREES_VERSION);
  await ledger.close();
});

test("managed ledger: corrupt/unknown/duplicate/sparse sidecar fails startup; bytes+inode unchanged; no lock", async () => {
  const corruptors = [
    { content: "{not-json", code: "MANAGED_CORRUPT" },
    { content: JSON.stringify({ kind: "other", version: 1, records: [] }), code: "MANAGED_WRONG_KIND" },
    { content: JSON.stringify({ kind: MANAGED_WORKTREES_KIND, version: 99, records: [] }), code: "MANAGED_UNKNOWN_VERSION" },
    { content: JSON.stringify({ kind: MANAGED_WORKTREES_KIND, version: 1, records: [{ worktreeId: "x" }] }), code: "MANAGED_SPARSE" },
    {
      content: JSON.stringify({ kind: MANAGED_WORKTREES_KIND, version: 1, records: [mrecord(), mrecord({ path: "/tmp/repo-worktrees/other" })] }),
      code: "MANAGED_DUPLICATE",
    },
  ];
  for (const { content, code } of corruptors) {
    const hostDir = temp("mwt-corrupt-");
    writeFileSync(join(hostDir, MANAGED_WORKTREES_FILE_NAME), content, { mode: 0o600 });
    const beforeBytes = await (await import("node:fs/promises")).readFile(join(hostDir, MANAGED_WORKTREES_FILE_NAME));
    const beforeStat = lstatSync(join(hostDir, MANAGED_WORKTREES_FILE_NAME));
    await assert.rejects(() => openManagedWorktreesLedger({ hostDir }), (e) => e instanceof ManagedWorktreesLedgerError && e.code === code);
    assert.deepEqual(await (await import("node:fs/promises")).readFile(join(hostDir, MANAGED_WORKTREES_FILE_NAME)), beforeBytes, `${code}: bytes unchanged`);
    assert.equal(lstatSync(join(hostDir, MANAGED_WORKTREES_FILE_NAME)).ino, beforeStat.ino, `${code}: inode unchanged`);
    assert.equal(existsSync(join(hostDir, "trusted-roots.lock")), false, `${code}: no lock created`);
  }
});

test("managed ledger: wrong-permission / hard-linked / symlink sidecar fail closed", async () => {
  // wrong-permission (0644) → open rejects (validateBeforeLock reads it).
  const hostDir = temp("mwt-perm-");
  let ledger = await openManagedWorktreesLedger({ hostDir });
  await ledger.writeAll([mrecord()]);
  await ledger.close();
  chmodSync(join(hostDir, MANAGED_WORKTREES_FILE_NAME), 0o644);
  const beforeBytes = await (await import("node:fs/promises")).readFile(join(hostDir, MANAGED_WORKTREES_FILE_NAME));
  await assert.rejects(() => openManagedWorktreesLedger({ hostDir }), (e) => e.code === "MANAGED_PERMISSIONS");
  assert.deepEqual(await (await import("node:fs/promises")).readFile(join(hostDir, MANAGED_WORKTREES_FILE_NAME)), beforeBytes);

  // hard-linked → MANAGED_HARD_LINK.
  const hostDir2 = temp("mwt-hlink-");
  ledger = await openManagedWorktreesLedger({ hostDir: hostDir2 });
  await ledger.writeAll([mrecord()]);
  await ledger.close();
  const aliasDir = temp("mwt-alias-");
  linkSync(join(hostDir2, MANAGED_WORKTREES_FILE_NAME), join(aliasDir, "alias"));
  await assert.rejects(() => openManagedWorktreesLedger({ hostDir: hostDir2 }), (e) => e.code === "MANAGED_HARD_LINK");

  // symlink while running → read/update fail closed, no rewrite.
  const hostDir3 = temp("mwt-symlink-");
  ledger = await openManagedWorktreesLedger({ hostDir: hostDir3 });
  await ledger.writeAll([mrecord()]);
  const ledgerPath = ledger.ledgerPath;
  rmSync(ledgerPath);
  const outside = temp("mwt-sym-out-");
  writeFileSync(join(outside, "planted.json"), "{}");
  symlinkSync(join(outside, "planted.json"), ledgerPath);
  await assert.rejects(() => ledger.read(), (e) => e.code === "MANAGED_SYMLINK");
  await assert.rejects(() => ledger.update((d) => [...d]), (e) => e.code === "MANAGED_SYMLINK");
  await ledger.close();
});

test("managed ledger: maxRecords bound and injected atomic failures never report success", async () => {
  const hostDir = temp("mwt-inject-");
  const ledger = await openManagedWorktreesLedger({ hostDir, maxRecords: 2 });
  await ledger.writeAll([mrecord({ worktreeId: "mwt-aaaaaaa1" })]);
  await ledger.close();
  const oldBytes = await (await import("node:fs/promises")).readFile(join(hostDir, MANAGED_WORKTREES_FILE_NAME));

  // maxRecords exceeded → MANAGED_OVERSIZE.
  const cap = await openManagedWorktreesLedger({ hostDir, maxRecords: 2 });
  await assert.rejects(
    () => cap.writeAll([mrecord({ worktreeId: "mwt-aaaaaaa1" }), mrecord({ worktreeId: "mwt-aaaaaaa2" }), mrecord({ worktreeId: "mwt-aaaaaaa3", path: "/tmp/repo-worktrees/y" })]),
    (e) => e.code === "MANAGED_OVERSIZE",
  );
  await cap.close();

  // temp fsync failure → MANAGED_WRITE_FAILED, old bytes preserved.
  const fail = await openManagedWorktreesLedger({ hostDir, failTempFsync: () => { throw new Error("injected"); } });
  await assert.rejects(() => fail.writeAll([mrecord({ worktreeId: "mwt-aaaaaaa9" })]), (e) => e.code === "MANAGED_WRITE_FAILED");
  assert.deepEqual(await (await import("node:fs/promises")).readFile(join(hostDir, MANAGED_WORKTREES_FILE_NAME)), oldBytes);
  await fail.close();

  // arbitrary dir-fsync failure → FATAL.
  const fatal = await openManagedWorktreesLedger({ hostDir, failDirFsync: () => { const e = new Error("eio"); e.code = "EIO"; throw e; } });
  await assert.rejects(() => fatal.writeAll([mrecord({ worktreeId: "mwt-aaaaaaa9" })]), (e) => e.code === "MANAGED_WRITE_FAILED");
  JSON.parse((await (await import("node:fs/promises")).readFile(join(hostDir, MANAGED_WORKTREES_FILE_NAME), "utf8")));
  await fatal.close();
});

// ---------------------------------------------------------------------------
// Shared lease: one lease serializes both documents (no second lock)
// ---------------------------------------------------------------------------

test("managed ledger: shares ONE lease/lock with the trusted ledger; both documents coexist", async () => {
  const hostDir = temp("mwt-shared-");
  const lease = await openHostStateDirectoryLease({ hostDir, instanceId: "instance-shared-1" });
  const trusted = await openTrustedRootsLedger({ hostDir, instanceId: "instance-shared-2" }).catch((e) => {
    // A second lease on the same dir must fail — the shared lease holds the lock.
    assert.equal(e.code, "LEDGER_LOCK_BUSY");
    return null;
  });
  assert.equal(trusted, null, "no second lock: a second trusted open must fail while the shared lease is held");
  const managed = createManagedWorktreesLedgerFromLease(lease);
  await managed.writeAll([mrecord()]);
  await lease.withLock(async (io) => {
    await io.writeDocument(LEDGER_FILE_NAME, JSON.stringify({ kind: "pix.host.trusted-roots", version: 1, claims: [] }) + "\n");
  });
  assert.equal((await managed.read()).records.length, 1);
  await managed.close(); // shared handle close() is a no-op (must not release the lease lock)
  assert.equal(existsSync(lease.lockPath), true, "shared managed close must not release the lease lock");
  await lease.close();
  assert.equal(existsSync(lease.lockPath), false, "lease owner close releases the lock");
  // After lease close, a fresh managed open works (sidecar persisted).
  const reopened = await openManagedWorktreesLedger({ hostDir });
  assert.equal((await reopened.read()).records.length, 1);
  await reopened.close();
});

test("managed ledger: instance id validation fails before any filesystem mutation", async () => {
  const parent = temp("mwt-instance-");
  const hostDir = join(parent, "host");
  await assert.rejects(
    () => openManagedWorktreesLedger({ hostDir, instanceId: "short" }),
    (e) => e instanceof ManagedWorktreesLedgerError && e.code === "MANAGED_LOCK_UNSAFE",
  );
  assert.equal(existsSync(hostDir), false);
});

test("managed ledger: static schema constants", () => {
  assert.equal(MANAGED_WORKTREES_KIND, "pix.host.managed-worktrees");
  assert.equal(MANAGED_WORKTREES_VERSION, 1);
  assert.equal(MANAGED_WORKTREES_SOURCE, "worktree.create");
  assert.equal(MANAGED_WORKTREES_FILE_NAME, "managed-worktrees.json");
});
