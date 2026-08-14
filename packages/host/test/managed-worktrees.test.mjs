import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
  lstatSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  openManagedWorktreesLedger,
  MANAGED_WORKTREES_FILE_NAME,
  MANAGED_WORKTREES_SOURCE,
} from "../dist/resources/managed-worktrees-ledger.js";
import {
  createManagedWorktreesService,
  recordCreated,
  commitRemoved,
  findLiveAuthority,
  classify,
  rehydrateManagedWorktrees,
  captureManagedWorktreeEvidence,
} from "../dist/resources/managed-worktrees.js";
import {
  createAllowedRootService,
  attachTrustedRootsLedger,
  listTrustedCreatedRoots,
  registerManagedAuthorizedRoot,
} from "../dist/resources/allowed-roots.js";
import { openTrustedRootsLedger } from "../dist/resources/trusted-roots-ledger.js";

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

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LC_ALL: "C" },
  }).trim();
}
function initRepo(root) {
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  writeFileSync(join(root, "tracked.txt"), "one\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-qm", "initial"]);
}
function makeWorktree(root, branch) {
  const canonicalRoot = realpathSync(root);
  const base = `${resolve(canonicalRoot)}-worktrees`;
  mkdirSync(base, { recursive: true });
  const target = join(base, branch);
  git(root, ["worktree", "add", "-b", branch, "--", target]);
  return target;
}

async function freshDeps({ root, hostDir, maxRecords, failTempFsync, allowedRoots, runner }) {
  const ledger = await openManagedWorktreesLedger({
    hostDir,
    ...(maxRecords !== undefined ? { maxRecords } : {}),
    ...(failTempFsync ? { failTempFsync } : {}),
  });
  const deps = { ledger, ...(allowedRoots ? { allowedRoots } : {}), ...(runner ? { runner } : {}) };
  return { deps, ledger };
}

// ---------------------------------------------------------------------------
// capture / recordCreated
// ---------------------------------------------------------------------------

test("recordCreated captures full evidence, persists disk before memory authorization", async () => {
  const root = temp("mwt-rec-repo-");
  initRepo(root);
  const hostDir = temp("mwt-rec-host-");
  const target = makeWorktree(root, "feature-a");
  const allowedRoots = await createAllowedRootService({ roots: [realpathSync(root)], maxRoots: 16 });
  const { deps, ledger } = await freshDeps({ root, hostDir, allowedRoots });

  assert.equal(await allowedRoots.isAuthorized(target, "directory"), false, "not authorized before record");
  const record = await recordCreated(deps, { path: target, branchAtCreate: "feature-a", branchCreatedByPix: true, worktreeId: "mwt-record-0001" });
  assert.equal(record.worktreeId, "mwt-record-0001");
  assert.equal(record.path, realpathSync(target));
  assert.equal(record.source, MANAGED_WORKTREES_SOURCE);
  assert.equal(record.branchAtCreate, "feature-a");
  assert.equal(record.branchCreatedByPix, true);
  // identity evidence populated.
  const info = lstatSync(realpathSync(target));
  assert.equal(record.dev, info.dev);
  assert.equal(record.ino, info.ino);
  assert.equal(record.repoRoot, realpathSync(root));
  assert.equal(record.base, `${resolve(realpathSync(root))}-worktrees`);
  // disk committed (record readable from a fresh ledger read).
  const onDisk = await ledger.read();
  assert.equal(onDisk.records.length, 1);
  // memory authorization published AFTER disk commit.
  assert.equal(await allowedRoots.isAuthorized(target, "directory"), true);
  await ledger.close();
});

test("recordCreated: disk failure means NO memory authorization and NO record (disk before memory)", async () => {
  const root = temp("mwt-fail-repo-");
  initRepo(root);
  const hostDir = temp("mwt-fail-host-");
  const target = makeWorktree(root, "feature-fail");
  const allowedRoots = await createAllowedRootService({ roots: [realpathSync(root)], maxRoots: 16 });
  const { deps, ledger } = await freshDeps({
    root,
    hostDir,
    allowedRoots,
    failTempFsync: () => { throw new Error("injected"); },
  });
  await assert.rejects(
    () => recordCreated(deps, { path: target, branchAtCreate: "feature-fail", branchCreatedByPix: true, worktreeId: "mwt-fail-00001" }),
    (e) => e.code === "MANAGED_WRITE_FAILED",
  );
  assert.equal(await allowedRoots.isAuthorized(target, "directory"), false, "no auth leak on disk failure");
  assert.equal((await ledger.read()).records.length, 0, "no partial record on disk failure");
  await ledger.close();
});

test("recordCreated: duplicate worktreeId/path fails closed with no memory auth", async () => {
  const root = temp("mwt-dup-repo-");
  initRepo(root);
  const hostDir = temp("mwt-dup-host-");
  const targetA = makeWorktree(root, "feature-dup");
  const allowedRoots = await createAllowedRootService({ roots: [realpathSync(root)], maxRoots: 16 });
  const { deps, ledger } = await freshDeps({ root, hostDir, allowedRoots });
  await recordCreated(deps, { path: targetA, branchAtCreate: "feature-dup", branchCreatedByPix: true, worktreeId: "mwt-dup-000001" });
  // Same worktreeId, different path → fail.
  await assert.rejects(
    () => recordCreated(deps, { path: targetA, branchAtCreate: "feature-dup", branchCreatedByPix: true, worktreeId: "mwt-dup-000001" }),
    (e) => e.code === "MANAGED_WORKTREE_EXISTS",
  );
  // Same path, different worktreeId → fail.
  await assert.rejects(
    () => recordCreated(deps, { path: targetA, branchAtCreate: "feature-dup", branchCreatedByPix: true, worktreeId: "mwt-dup-000002" }),
    (e) => e.code === "MANAGED_WORKTREE_EXISTS",
  );
  assert.equal((await ledger.read()).records.length, 1);
  assert.equal(await allowedRoots.isAuthorized(targetA, "directory"), true);
  await ledger.close();
});

test("recordCreated: created under an already-durable AllowedRoot still gets a managed record + memory auth, no trusted claim", async () => {
  const root = temp("mwt-durable-repo-");
  initRepo(root);
  const hostDir = temp("mwt-durable-host-");
  const target = makeWorktree(root, "feature-durable");
  const base = `${resolve(realpathSync(root))}-worktrees`;
  // Durable root ALREADY covers the worktree path.
  const allowedRoots = await createAllowedRootService({ roots: [base], maxRoots: 16 });
  const { deps, ledger } = await freshDeps({ root, hostDir, allowedRoots });
  const record = await recordCreated(deps, { path: target, branchAtCreate: "feature-durable", branchCreatedByPix: true, worktreeId: "mwt-durable-01" });
  assert.equal((await ledger.read()).records.length, 1, "managed record written even under a durable root");
  assert.equal(await allowedRoots.isAuthorized(target, "directory"), true, "memory auth published");
  assert.equal(listTrustedCreatedRoots(allowedRoots).length, 0, "no trusted claim created (no double-write)");
  assert.equal(record.worktreeId, "mwt-durable-01");
  await ledger.close();
});

test("capture: repo replacement / unsafe containment fails; injected runner is honored", async () => {
  const root = temp("mwt-capture-repo-");
  initRepo(root);
  const hostDir = temp("mwt-capture-host-");
  const target = makeWorktree(root, "feature-cap");
  const { deps, ledger } = await freshDeps({ root, hostDir });
  // A runner that throws → capture fails closed (injectable runner honored).
  const failing = { ...deps, runner: { run: async () => { throw new Error("runner down"); } } };
  await assert.rejects(
    () => captureManagedWorktreeEvidence(failing, { path: target, branchAtCreate: "feature-cap", branchCreatedByPix: true }),
    (e) => e.code === "WORKTREE_CAPTURE_FAILED",
  );
  await ledger.close();
});

// ---------------------------------------------------------------------------
// classify / findLiveAuthority
// ---------------------------------------------------------------------------

test("classify: managed vs unmanaged; planted/external worktrees are unmanaged", async () => {
  const root = temp("mwt-cls-repo-");
  initRepo(root);
  const hostDir = temp("mwt-cls-host-");
  const target = makeWorktree(root, "feature-cls");
  const { deps, ledger } = await freshDeps({ root, hostDir });
  await recordCreated(deps, { path: target, branchAtCreate: "feature-cls", branchCreatedByPix: true, worktreeId: "mwt-cls-000001" });

  const managed = await classify(deps, target);
  assert.equal(managed.kind, "managed");
  assert.equal(managed.live, true);
  const authority = await findLiveAuthority(deps, target);
  assert.equal(authority?.record.worktreeId, "mwt-cls-000001");
  assert.equal(authority?.live, true);

  // A planted/external worktree never managed.
  const external = temp("mwt-ext-");
  const externalPath = join(external, "ext");
  git(root, ["worktree", "add", "-b", "external-b", "--", externalPath]);
  assert.equal((await classify(deps, externalPath)).kind, "unmanaged");
  assert.equal(await findLiveAuthority(deps, externalPath), null);
  await ledger.close();
});

test("branch switch and detach keep the worktree managed (branchAtCreate audit-only)", async () => {
  const root = temp("mwt-branch-repo-");
  initRepo(root);
  const hostDir = temp("mwt-branch-host-");
  const target = makeWorktree(root, "feature-branch");
  const { deps, ledger } = await freshDeps({ root, hostDir });
  await recordCreated(deps, { path: target, branchAtCreate: "feature-branch", branchCreatedByPix: true, worktreeId: "mwt-branch-001" });

  // Branch switch inside the worktree.
  git(target, ["checkout", "-b", "switched"]);
  assert.equal((await classify(deps, target)).kind, "managed");
  assert.equal((await findLiveAuthority(deps, target)).live, true);
  // Detach HEAD.
  git(target, ["checkout", "--detach", "HEAD"]);
  assert.equal((await classify(deps, target)).kind, "managed");
  assert.equal((await findLiveAuthority(deps, target)).live, true);
  await ledger.close();
});

// ---------------------------------------------------------------------------
// durable-root promotion non-erasure
// ---------------------------------------------------------------------------

test("durable root promotion never erases managed ownership; no trusted double-write", async () => {
  const root = temp("mwt-promo-repo-");
  initRepo(root);
  const hostDir = temp("mwt-promo-host-");
  const target = makeWorktree(root, "feature-promo");
  const base = `${resolve(realpathSync(root))}-worktrees`;
  const allowedRoots = await createAllowedRootService({ roots: [realpathSync(root)], maxRoots: 16, allowLocalExpansion: true });
  // ONE shared lease serializes BOTH documents (no second lock).
  const { openHostStateDirectoryLease } = await import("../dist/resources/host-state-directory.js");
  const { createTrustedRootsLedgerFromLease } = await import("../dist/resources/trusted-roots-ledger.js");
  const { createManagedWorktreesLedgerFromLease } = await import("../dist/resources/managed-worktrees-ledger.js");
  const lease = await openHostStateDirectoryLease({ hostDir, instanceId: "instance-promo-01" });
  const trustedLedger = createTrustedRootsLedgerFromLease(lease, { maxClaims: 16 });
  attachTrustedRootsLedger(allowedRoots, trustedLedger);
  const managedLedger = createManagedWorktreesLedgerFromLease(lease);
  const deps = { ledger: managedLedger, allowedRoots };
  await recordCreated(deps, { path: target, branchAtCreate: "feature-promo", branchCreatedByPix: true, worktreeId: "mwt-promo-0001" });
  assert.equal((await managedLedger.read()).records.length, 1);

  // Promote the base to a durable root (would absorb TRUSTED claims).
  await allowedRoots.expandRoots([base], "local");
  assert.equal(await allowedRoots.isAuthorized(target, "directory"), true, "managed ownership survives promotion");
  assert.equal((await managedLedger.read()).records.length, 1, "managed record NOT erased by promotion");
  assert.equal((await trustedLedger.read()).claims.length, 0, "promotion wrote no trusted claim for the managed record");

  // A fresh service + managed rehydrate still restores the record (ownership intact).
  const freshRoots = await createAllowedRootService({ roots: [realpathSync(root)], maxRoots: 16 });
  const result = await rehydrateManagedWorktrees(
    { ledger: managedLedger, allowedRoots: freshRoots },
    { isRepoManaged: () => true },
  );
  assert.equal(result.restored, 1);
  assert.equal(await freshRoots.isAuthorized(target, "directory"), true);
  await lease.close();
});

// ---------------------------------------------------------------------------
// remove / re-add
// ---------------------------------------------------------------------------

test("remove then re-add the same path loses authority via inode/admin identity", async () => {
  const root = temp("mwt-readd-repo-");
  initRepo(root);
  const hostDir = temp("mwt-readd-host-");
  const allowedRoots = await createAllowedRootService({ roots: [realpathSync(root)], maxRoots: 16 });
  const { deps, ledger } = await freshDeps({ root, hostDir, allowedRoots });
  const target = makeWorktree(root, "feature-readd");
  await recordCreated(deps, { path: target, branchAtCreate: "feature-readd", branchCreatedByPix: true, worktreeId: "mwt-readd-0001" });

  // External deletion of the managed worktree.
  git(root, ["worktree", "remove", "--force", "--", target]);
  assert.equal((await ledger.read()).records.length, 1, "stale record remains on disk");
  assert.equal((await findLiveAuthority(deps, target)), null, "path is gone → no live authority");

  // Re-create a DIFFERENT worktree at the SAME path (branch still exists after remove).
  const base = `${resolve(realpathSync(root))}-worktrees`;
  mkdirSync(base, { recursive: true });
  git(root, ["worktree", "add", "--", target, "feature-readd"]);
  const newInfo = lstatSync(target);
  const oldRecord = (await ledger.read()).records[0];
  assert.notEqual(oldRecord.ino, newInfo.ino, "new dir has a fresh inode");
  // findLiveAuthority (no identity match) → live false; classify still managed-by-record but not live.
  const authority = await findLiveAuthority(deps, target);
  assert.equal(authority?.live, false, "same path after re-add is NOT the original managed worktree");

  // rehydrate drops the stale exact record (identity evidence safely allows).
  const result = await rehydrateManagedWorktrees(deps, { isRepoManaged: () => true });
  assert.equal(result.dropped, 1);
  assert.equal((await ledger.read()).records.length, 0);
  assert.equal((await classify(deps, target)).kind, "unmanaged", "re-add loses authority");
  await ledger.close();
});

test("commitRemoved removes ONLY the exact record/path; never branch/base deletion authority", async () => {
  const root = temp("mwt-remove-repo-");
  initRepo(root);
  const hostDir = temp("mwt-remove-host-");
  const target = makeWorktree(root, "feature-rm");
  const allowedRoots = await createAllowedRootService({ roots: [realpathSync(root)], maxRoots: 16 });
  const { deps, ledger } = await freshDeps({ root, hostDir, allowedRoots });
  await recordCreated(deps, { path: target, branchAtCreate: "feature-rm", branchCreatedByPix: true, worktreeId: "mwt-rm-0000001" });

  // Wrong worktreeId (same path) → nothing removed.
  assert.equal(await commitRemoved(deps, "mwt-wrong-id-00", target), false);
  assert.equal((await ledger.read()).records.length, 1);
  // Wrong path (same worktreeId) → nothing removed.
  assert.equal(await commitRemoved(deps, "mwt-rm-0000001", "/tmp/nonexistent-path"), false);
  assert.equal((await ledger.read()).records.length, 1);
  // Exact record/path → removed.
  assert.equal(await commitRemoved(deps, "mwt-rm-0000001", realpathSync(target)), true);
  assert.equal((await ledger.read()).records.length, 0);
  assert.equal(await allowedRoots.isAuthorized(target, "directory"), false, "memory auth removed after exact removal");
  // No branch/base deletion authority: branch and worktree dir still exist.
  assert.doesNotThrow(() => git(root, ["show-ref", "--verify", "refs/heads/feature-rm"]));
  assert.equal(existsSync(realpathSync(target)), true);
  await ledger.close();
});

// ---------------------------------------------------------------------------
// rehydrate / reconcile
// ---------------------------------------------------------------------------

test("external deletion yields stale record; reconciliation drops it; corrupt evidence untouched", async () => {
  const root = temp("mwt-rec2-repo-");
  initRepo(root);
  const hostDir = temp("mwt-rec2-host-");
  const target = makeWorktree(root, "feature-rec2");
  const { deps, ledger } = await freshDeps({ root, hostDir });
  await recordCreated(deps, { path: target, branchAtCreate: "feature-rec2", branchCreatedByPix: true, worktreeId: "mwt-rec2-0001" });
  git(root, ["worktree", "remove", "--force", "--", target]);
  assert.equal((await ledger.read()).records.length, 1, "stale record remains");
  const result = await rehydrateManagedWorktrees(deps, { isRepoManaged: () => true });
  assert.equal(result.dropped, 1);
  assert.equal(result.restored, 0);
  assert.equal((await ledger.read()).records.length, 0, "stale exact record dropped");

  // Corrupt sidecar → rehydrate fails closed and does not rewrite.
  const hostDir2 = temp("mwt-rec2-host2-");
  writeFileSync(join(hostDir2, MANAGED_WORKTREES_FILE_NAME), "{not-json", { mode: 0o600 });
  const beforeBytes = await readFile(join(hostDir2, MANAGED_WORKTREES_FILE_NAME));
  const corruptLedger = await openManagedWorktreesLedger({ hostDir: hostDir2 }).catch(() => null);
  // Opening a corrupt sidecar already fails closed (validateBeforeLock).
  assert.equal(corruptLedger, null);
  assert.deepEqual(await readFile(join(hostDir2, MANAGED_WORKTREES_FILE_NAME)), beforeBytes, "corrupt evidence untouched");
});

test("foreign installation/repository records are preserved on disk but never authorized", async () => {
  const root = temp("mwt-foreign-repo-");
  initRepo(root);
  const hostDir = temp("mwt-foreign-host-");
  const target = makeWorktree(root, "feature-fw");
  const { deps, ledger } = await freshDeps({ root, hostDir });
  const record = await recordCreated(deps, { path: target, branchAtCreate: "feature-fw", branchCreatedByPix: true, worktreeId: "mwt-fw-0000001" });
  assert.equal((await ledger.read()).records.length, 1);
  // THIS host does not manage the repo → preserve, do not authorize.
  const allowedRoots = await createAllowedRootService({ roots: [realpathSync(root)], maxRoots: 16 });
  const result = await rehydrateManagedWorktrees(
    { ledger, allowedRoots },
    { isRepoManaged: async () => false },
  );
  assert.equal(result.preservedForeign, 1);
  assert.equal(result.restored, 0);
  assert.equal((await ledger.read()).records.length, 1, "foreign record preserved on disk");
  assert.equal(await allowedRoots.isAuthorized(target, "directory"), false, "foreign record never authorized");
  assert.equal(record.worktreeId, "mwt-fw-0000001");
  await ledger.close();
});

// ---------------------------------------------------------------------------
// concurrency / failure ordering
// ---------------------------------------------------------------------------

test("rehydrate on a MISSING sidecar keeps it absent (no empty sidecar write)", async () => {
  const root = temp("mwt-missing-repo-");
  initRepo(root);
  const hostDir = temp("mwt-missing-host-");
  const ledger = await openManagedWorktreesLedger({ hostDir });
  assert.equal(existsSync(join(hostDir, MANAGED_WORKTREES_FILE_NAME)), false, "sidecar absent before rehydrate");
  const result = await rehydrateManagedWorktrees({ ledger }, { isRepoManaged: () => true });
  assert.equal(result.restored, 0);
  assert.equal(result.dropped, 0);
  assert.equal(existsSync(join(hostDir, MANAGED_WORKTREES_FILE_NAME)), false, "missing sidecar stays absent after rehydrate (no empty write)");
  await ledger.close();
});

test("concurrent recordCreated for distinct paths both commit durably (shared lease serializes)", async () => {
  const root = temp("mwt-conc-repo-");
  initRepo(root);
  const hostDir = temp("mwt-conc-host-");
  const targetA = makeWorktree(root, "feature-a");
  const targetB = makeWorktree(root, "feature-b");
  const allowedRoots = await createAllowedRootService({ roots: [realpathSync(root)], maxRoots: 16 });
  const { deps, ledger } = await freshDeps({ root, hostDir, allowedRoots });
  await Promise.all([
    recordCreated(deps, { path: targetA, branchAtCreate: "feature-a", branchCreatedByPix: true, worktreeId: "mwt-conc-aaaa1" }),
    recordCreated(deps, { path: targetB, branchAtCreate: "feature-b", branchCreatedByPix: true, worktreeId: "mwt-conc-bbbb1" }),
  ]);
  const onDisk = await ledger.read();
  assert.equal(onDisk.records.length, 2);
  assert.equal(await allowedRoots.isAuthorized(targetA, "directory"), true);
  assert.equal(await allowedRoots.isAuthorized(targetB, "directory"), true);
  await ledger.close();
});

test("managed service factory exposes a narrow composition surface", async () => {
  const root = temp("mwt-factory-repo-");
  initRepo(root);
  const hostDir = temp("mwt-factory-host-");
  const target = makeWorktree(root, "feature-factory");
  const ledger = await openManagedWorktreesLedger({ hostDir });
  const deps = createManagedWorktreesService({ ledger, allowedRoots: undefined });
  assert.equal(typeof deps.recordCreated, "function");
  assert.equal(typeof deps.findLiveAuthority, "function");
  assert.equal(typeof deps.classify, "function");
  assert.equal(typeof deps.commitRemoved, "function");
  assert.equal(typeof deps.rehydrate, "function");
  const record = await deps.recordCreated({ path: target, branchAtCreate: "feature-factory", branchCreatedByPix: true, worktreeId: "mwt-factory-01" });
  assert.equal((await deps.classify(target)).kind, "managed");
  assert.equal((await deps.findLiveAuthority(target))?.record.worktreeId, "mwt-factory-01");
  await ledger.close();
});

test("registerManagedAuthorizedRoot: exact worktreeId+path unregister; mismatch is never removed", async () => {
  const root = temp("mwt-seam-repo-");
  initRepo(root);
  const target = makeWorktree(root, "feature-seam");
  const allowedRoots = await createAllowedRootService({ roots: [realpathSync(root)], maxRoots: 16 });
  const seamInfo = lstatSync(realpathSync(target));
  await registerManagedAuthorizedRoot(allowedRoots, { worktreeId: "mwt-seam-0001", path: realpathSync(target), dev: seamInfo.dev, ino: seamInfo.ino });
  assert.equal(await allowedRoots.isAuthorized(target, "directory"), true);
  // Mismatched path → not removed.
  await (await import("../dist/resources/allowed-roots.js")).unregisterManagedAuthorizedRoot(allowedRoots, "mwt-seam-0001", "/tmp/wrong");
  assert.equal(await allowedRoots.isAuthorized(target, "directory"), true);
  // Exact → removed.
  await (await import("../dist/resources/allowed-roots.js")).unregisterManagedAuthorizedRoot(allowedRoots, "mwt-seam-0001", realpathSync(target));
  assert.equal(await allowedRoots.isAuthorized(target, "directory"), false);
});
