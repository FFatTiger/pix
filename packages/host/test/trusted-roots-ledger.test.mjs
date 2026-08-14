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
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import {
  createHostApp,
  createProductionResources,
  InvalidHostDirError,
} from "../dist/index.js";
import {
  openTrustedRootsLedger,
  resolvePixHostDir,
  parseTrustedRootsDocument,
  serializeTrustedRootsDocument,
  TRUSTED_ROOTS_KIND,
  TRUSTED_ROOTS_VERSION,
  TRUSTED_ROOTS_SOURCE,
  LEDGER_FILE_NAME,
  LEDGER_LOCK_NAME,
  TrustedRootsLedgerError,
} from "../dist/resources/trusted-roots-ledger.js";
import {
  createAllowedRootService,
  attachTrustedRootsLedger,
  registerTrustedCreatedRoot,
  unregisterTrustedCreatedRoot,
  rehydrateTrustedCreatedRoots,
  listTrustedCreatedRoots,
} from "../dist/resources/allowed-roots.js";
import { openHostStateDirectoryLease } from "../dist/resources/host-state-directory.js";
import { createTrustedRootsLedgerFromLease } from "../dist/resources/trusted-roots-ledger.js";
import { createManagedWorktreesLedgerFromLease } from "../dist/resources/managed-worktrees-ledger.js";
import { createManagedWorktreesService } from "../dist/resources/managed-worktrees.js";

const temporary = [];
// Canonicalize temp roots so hostDir never walks macOS `/var` → `/private/var`.
// ensurePixHostDir refuses intermediate symlinks on the absolute path text.
const CANON_TMP = realpathSync(tmpdir());
function temp(prefix) {
  const value = mkdtempSync(join(CANON_TMP, prefix));
  temporary.push(value);
  return value;
}
afterEach(() => {
  while (temporary.length) {
    const value = temporary.pop();
    // git linked-worktree bases live OUTSIDE the repo as `${repo}-worktrees`
    // siblings; clean them too so no fixture debris survives a run.
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

function claim(overrides = {}) {
  const path = overrides.path ?? "/tmp/wt/feature";
  const repoRoot = overrides.repoRoot ?? "/tmp/repo";
  const base = overrides.base ?? `${repoRoot}-worktrees`;
  return {
    claimId: overrides.claimId ?? "claim-aaaaaaaa",
    path,
    dev: overrides.dev ?? 1,
    ino: overrides.ino ?? 2,
    repoRoot,
    repoDev: overrides.repoDev ?? 3,
    repoIno: overrides.repoIno ?? 4,
    base,
    createdAt: overrides.createdAt ?? "2020-01-01T00:00:00.000Z",
    source: TRUSTED_ROOTS_SOURCE,
    ...(overrides.branch !== undefined ? { branch: overrides.branch } : {}),
  };
}

async function liveClaimForWorktree(root, worktreePath, branch) {
  const repoRoot = await realpath(root);
  const path = await realpath(worktreePath);
  const base = await realpath(`${resolve(repoRoot)}-worktrees`);
  const pathInfo = lstatSync(path);
  const repoInfo = lstatSync(repoRoot);
  return {
    claimId: `claim-${branch}-${pathInfo.ino}`,
    path,
    dev: pathInfo.dev,
    ino: pathInfo.ino,
    repoRoot,
    repoDev: repoInfo.dev,
    repoIno: repoInfo.ino,
    base,
    createdAt: new Date().toISOString(),
    source: TRUSTED_ROOTS_SOURCE,
    branch,
  };
}

async function listWorktrees(repoRoot) {
  const out = execFileSync(
    "git",
    ["-C", repoRoot, "worktree", "list", "--porcelain", "-z"],
    { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } },
  );
  const result = [];
  let current = {};
  const flush = () => {
    if (current.path && !current.prunable) {
      result.push({ path: current.path, isMain: result.length === 0 });
    }
    current = {};
  };
  for (const record of out.split("\0").filter(Boolean)) {
    for (const line of record.split("\n")) {
      if (line.startsWith("worktree ")) {
        flush();
        current.path = line.slice(9);
      } else if (line.startsWith("prunable")) current.prunable = true;
    }
  }
  flush();
  const existing = [];
  for (const item of result) {
    try {
      const info = lstatSync(item.path);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        existing.push({ path: await realpath(item.path), isMain: item.isMain });
      }
    } catch {
      /* stale */
    }
  }
  return existing;
}

function makeWorktree(root, branch) {
  const base = `${resolve(realpathSync(root))}-worktrees`;
  mkdirSync(base, { recursive: true });
  const target = join(base, branch);
  git(root, ["worktree", "add", "-b", branch, "--", target]);
  return target;
}

// ---------------------------------------------------------------------------
// resolvePixHostDir / parse / serialize
// ---------------------------------------------------------------------------

test("resolvePixHostDir: default and absolute PIX_HOST_DIR; reject empty/relative/NUL", () => {
  const home = temp("pi-home-");
  assert.equal(resolvePixHostDir(undefined, home), resolve(join(home, ".pi", "pix", "host")));
  const abs = join(home, "custom-host");
  assert.equal(resolvePixHostDir(abs), resolve(abs));
  assert.throws(() => resolvePixHostDir(""), (e) => e instanceof TrustedRootsLedgerError && e.code === "HOST_DIR_INVALID");
  assert.throws(() => resolvePixHostDir("relative"), (e) => e.code === "HOST_DIR_INVALID");
  assert.throws(() => resolvePixHostDir("/a\0b"), (e) => e.code === "HOST_DIR_INVALID");
});

test("parseTrustedRootsDocument: wrong kind/version/corrupt/partial/sparse/duplicate/oversize fail closed", () => {
  assert.equal(parseTrustedRootsDocument("not-json", 8).warning, "LEDGER_CORRUPT");
  assert.equal(parseTrustedRootsDocument(JSON.stringify({ kind: "other", version: 1, claims: [] }), 8).warning, "LEDGER_WRONG_KIND");
  assert.equal(parseTrustedRootsDocument(JSON.stringify({ kind: TRUSTED_ROOTS_KIND, version: 99, claims: [] }), 8).warning, "LEDGER_UNKNOWN_VERSION");
  assert.equal(parseTrustedRootsDocument(JSON.stringify({ kind: TRUSTED_ROOTS_KIND, version: 1, claims: [], extra: true }), 8).warning, "LEDGER_CORRUPT");
  const sparse = parseTrustedRootsDocument(JSON.stringify({
    kind: TRUSTED_ROOTS_KIND, version: 1,
    claims: [{ claimId: "x", path: "/a" }],
  }), 8);
  assert.equal(sparse.warning, "LEDGER_SPARSE");
  assert.deepEqual(sparse.claims, []);
  const c = claim({ claimId: "claim-dup-aaaa" });
  const dup = parseTrustedRootsDocument(JSON.stringify({
    kind: TRUSTED_ROOTS_KIND, version: 1,
    claims: [c, { ...c, path: "/other" }],
  }), 8);
  assert.equal(dup.warning, "LEDGER_DUPLICATE");
  assert.deepEqual(dup.claims, []);
  const many = Array.from({ length: 5 }, (_, i) => claim({ claimId: `claim-${i}-aaaaaa`, path: `/p/${i}`, ino: i + 1 }));
  assert.equal(parseTrustedRootsDocument(JSON.stringify({ kind: TRUSTED_ROOTS_KIND, version: 1, claims: many }), 2).warning, "LEDGER_OVERSIZE");
  const valid = claim({ branch: "feature" });
  const text = serializeTrustedRootsDocument([valid]);
  const parsed = parseTrustedRootsDocument(text, 8);
  assert.equal(parsed.warning, undefined);
  assert.equal(parsed.claims.length, 1);
  assert.equal(parsed.claims[0].branch, "feature");
  assert.equal(serializeTrustedRootsDocument([valid, claim({ claimId: "claim-bbbbbbbb", path: "/z" })]),
    serializeTrustedRootsDocument([claim({ claimId: "claim-bbbbbbbb", path: "/z" }), valid]));
});

test("ledger open rejects invalid instanceId before any filesystem mutation", async () => {
  const cases = ["short", "x".repeat(129), "valid-id\0suffix", "valid-id\nsuffix", "valid-id\u007fsuffix"];
  for (const instanceId of cases) {
    const parent = temp("pi-invalid-instance-parent-");
    const hostDir = join(parent, `host-${cases.indexOf(instanceId)}`);
    await assert.rejects(
      () => openTrustedRootsLedger({ hostDir, instanceId }),
      (error) => error instanceof TrustedRootsLedgerError
        && error.code === "LEDGER_LOCK_UNSAFE"
        && error.message === "Ledger instance id is invalid"
        && !error.message.includes(instanceId),
    );
    assert.equal(existsSync(hostDir), false);
  }
});

// ---------------------------------------------------------------------------
// Host dir safety (D3A-P0 decision 2)
// ---------------------------------------------------------------------------

test("PIX_HOST_DIR: newly created dedicated leaf gets 0700; ledger 0600; atomic write", async () => {
  const hostDir = temp("pi-host-dir-");
  const ledger = await openTrustedRootsLedger({ hostDir });
  assert.equal(lstatSync(hostDir).mode & 0o777, 0o700, "newly created host dir must be 0700");
  await ledger.writeAll([claim({ path: "/tmp/a", repoRoot: "/tmp/r", base: "/tmp/r-worktrees", claimId: "claim-perm-aaa" })]);
  assert.equal(lstatSync(ledger.ledgerPath).mode & 0o777, 0o600, "ledger must be 0600");
  assert.equal(lstatSync(ledger.ledgerPath).isFile(), true);
  assert.equal(lstatSync(ledger.ledgerPath).isSymbolicLink(), false);
  const body = readFileSync(ledger.ledgerPath, "utf8");
  assert.match(body, /pix\.host\.trusted-roots/);
  assert.ok(!body.includes("\n  "));
  await ledger.close();
  assert.equal(existsSync(ledger.lockPath), false, "graceful close must remove the lock");
});

test("PIX_HOST_DIR: reserved destinations rejected before mutation (root/home/tmp/repo)", async () => {
  await assert.rejects(() => openTrustedRootsLedger({ hostDir: "/" }), (e) => e.code === "HOST_DIR_INVALID");
  await assert.rejects(() => openTrustedRootsLedger({ hostDir: homedir() }), (e) => e.code === "HOST_DIR_INVALID");
  await assert.rejects(() => openTrustedRootsLedger({ hostDir: realpathSync(tmpdir()) }), (e) => e.code === "HOST_DIR_INVALID");
  const repo = temp("pi-repo-detect-");
  initRepo(repo);
  await assert.rejects(() => openTrustedRootsLedger({ hostDir: repo }), (e) => e.code === "HOST_DIR_INVALID");
  const sub = join(repo, "subdir");
  mkdirSync(sub);
  await assert.rejects(() => openTrustedRootsLedger({ hostDir: sub }), (e) => e.code === "HOST_DIR_INVALID");
  // No ledger/lock was created anywhere.
  assert.equal(existsSync(join(repo, LEDGER_FILE_NAME)), false);
  assert.equal(existsSync(join(repo, LEDGER_LOCK_NAME)), false);
});

test("PIX_HOST_DIR: existing populated/wrong-mode dir rejected with no mode/content mutation", async () => {
  // Wrong mode (0755) + populated: rejected, never chmod'd, contents untouched.
  const hostDir = temp("pi-populated-");
  chmodSync(hostDir, 0o755);
  writeFileSync(join(hostDir, "unrelated.txt"), "keep", { mode: 0o644 });
  const beforeMode = lstatSync(hostDir).mode & 0o777;
  const beforeIno = lstatSync(hostDir).ino;
  await assert.rejects(() => openTrustedRootsLedger({ hostDir }), (e) => e.code === "HOST_DIR_UNSAFE");
  assert.equal(lstatSync(hostDir).mode & 0o777, beforeMode, "must never chmod an existing dir");
  assert.equal(lstatSync(hostDir).ino, beforeIno);
  assert.equal(readFileSync(join(hostDir, "unrelated.txt"), "utf8"), "keep");
  assert.equal(existsSync(join(hostDir, LEDGER_FILE_NAME)), false);
  assert.equal(existsSync(join(hostDir, LEDGER_LOCK_NAME)), false);

  // Correct 0700 but populated with an unrelated file: still rejected, untouched.
  const hostDir2 = temp("pi-populated-0700-");
  writeFileSync(join(hostDir2, "foreign.bin"), "x", { mode: 0o600 });
  await assert.rejects(() => openTrustedRootsLedger({ hostDir: hostDir2 }), (e) => e.code === "HOST_DIR_UNSAFE");
  assert.equal(existsSync(join(hostDir2, "foreign.bin")), true);
  assert.equal(existsSync(join(hostDir2, LEDGER_FILE_NAME)), false);
  assert.equal(existsSync(join(hostDir2, LEDGER_LOCK_NAME)), false);
});

test("PIX_HOST_DIR: existing dedicated empty/recognized dir accepted; existing non-0700 rejected", async () => {
  // Existing empty 0700 dir accepted.
  const hostDir = temp("pi-existing-empty-");
  chmodSync(hostDir, 0o700);
  const ledger = await openTrustedRootsLedger({ hostDir });
  await ledger.writeAll([claim({ claimId: "claim-exist-aaaa", path: "/tmp/e1", repoRoot: "/tmp/r", base: "/tmp/r-worktrees" })]);
  await ledger.close();
  // Re-open an existing dir containing the recognized ledger layout.
  const reopened = await openTrustedRootsLedger({ hostDir });
  assert.equal((await reopened.read()).claims.length, 1);
  await reopened.close();

  // Existing 0755 (even empty) is rejected and NOT chmod'd.
  const hostDir3 = temp("pi-existing-0755-");
  chmodSync(hostDir3, 0o755);
  const beforeMode = lstatSync(hostDir3).mode & 0o777;
  await assert.rejects(() => openTrustedRootsLedger({ hostDir: hostDir3 }), (e) => e.code === "HOST_DIR_UNSAFE");
  assert.equal(lstatSync(hostDir3).mode & 0o777, beforeMode);
});

test("PIX_HOST_DIR: intermediate symlink rejected; outside tree never mutated", async () => {
  const outside = temp("pi-mid-out-");
  const parent = temp("pi-mid-parent-");
  const link = join(parent, "link");
  symlinkSync(outside, link, "dir");
  const hostDir = join(link, "child");
  const marker = "SECRET_OUTSIDE_MARKER_9f3a";
  writeFileSync(join(outside, marker), "planted");
  await assert.rejects(
    () => openTrustedRootsLedger({ hostDir }),
    (e) => e instanceof TrustedRootsLedgerError && e.code === "HOST_DIR_UNSAFE",
  );
  assert.equal(existsSync(join(outside, "child")), false);
  assert.equal(existsSync(join(outside, LEDGER_FILE_NAME)), false);
  assert.equal(existsSync(join(outside, LEDGER_LOCK_NAME)), false);
  assert.equal(existsSync(join(outside, marker)), true);
});

test("PIX_HOST_DIR: wrong owner / wrong-permission ledger / hard-linked ledger / symlink ledger rejected", async () => {
  // wrong owner (where supported): only runnable as root; static guard otherwise.
  const src = readFileSync(new URL("../src/resources/host-state-directory.ts", import.meta.url), "utf8");
  assert.match(src, /Host directory is owned by another user/, "ownership check must exist in the shared lease");

  // wrong-permission ledger (0644) → open rejects LEDGER_PERMISSIONS, unchanged.
  const hostDir = temp("pi-wrongperm-");
  let ledger = await openTrustedRootsLedger({ hostDir });
  await ledger.writeAll([claim({ claimId: "claim-wperm-aaaa", path: "/tmp/wp", repoRoot: "/tmp/r", base: "/tmp/r-worktrees" })]);
  await ledger.close();
  chmodSync(join(hostDir, LEDGER_FILE_NAME), 0o644);
  const beforeBytes = readFileSync(join(hostDir, LEDGER_FILE_NAME));
  const beforeIno = lstatSync(join(hostDir, LEDGER_FILE_NAME)).ino;
  await assert.rejects(() => openTrustedRootsLedger({ hostDir }), (e) => e.code === "LEDGER_PERMISSIONS");
  assert.deepEqual(readFileSync(join(hostDir, LEDGER_FILE_NAME)), beforeBytes);
  assert.equal(lstatSync(join(hostDir, LEDGER_FILE_NAME)).ino, beforeIno);

  // hard-linked ledger → open rejects LEDGER_HARD_LINK.
  const hostDir2 = temp("pi-hardlink-");
  ledger = await openTrustedRootsLedger({ hostDir: hostDir2 });
  await ledger.writeAll([claim({ claimId: "claim-hlink-aaa", path: "/tmp/hl", repoRoot: "/tmp/r", base: "/tmp/r-worktrees" })]);
  await ledger.close();
  const alias = join(temp("pi-hardlink-alias-"), "alias");
  linkSync(join(hostDir2, LEDGER_FILE_NAME), alias);
  await assert.rejects(() => openTrustedRootsLedger({ hostDir: hostDir2 }), (e) => e.code === "LEDGER_HARD_LINK");

  // Symlink ledger while Host runs: read/update fail closed and do not rewrite.
  const hostDir3 = temp("pi-symlink-");
  ledger = await openTrustedRootsLedger({ hostDir: hostDir3 });
  await ledger.writeAll([claim({ claimId: "claim-symlink-a", path: "/tmp/sy", repoRoot: "/tmp/r", base: "/tmp/r-worktrees" })]);
  const ledgerPath = ledger.ledgerPath;
  rmSync(ledgerPath);
  const outside = temp("pi-ledger-out-");
  writeFileSync(join(outside, "planted.json"), "{}");
  symlinkSync(join(outside, "planted.json"), ledgerPath);
  await assert.rejects(() => ledger.read(), (e) => e.code === "LEDGER_SYMLINK");
  await assert.rejects(() => ledger.update((d) => [...d]), (e) => e.code === "LEDGER_SYMLINK");
});

// ---------------------------------------------------------------------------
// Lifetime lock (D3A-P0 decision 1)
// ---------------------------------------------------------------------------

test("lifetime lock: second Host same dir fails before listen; stale lock fails closed; exact-owner unlock", async () => {
  const hostDir = temp("pi-lock-busy-");
  const a = await openTrustedRootsLedger({ hostDir, instanceId: "instance-a-aaaa" });
  assert.equal(existsSync(a.lockPath), true);
  // Second Host same dir → LEDGER_LOCK_BUSY (fail before listen), no ledger touch.
  const ledgerBytes = await a.read();
  await assert.rejects(
    () => openTrustedRootsLedger({ hostDir, instanceId: "instance-b-bbbb" }),
    (e) => e.code === "LEDGER_LOCK_BUSY",
  );
  assert.deepEqual((await a.read()).claims, ledgerBytes.claims);
  // Graceful exact-owner unlock: A closes, then B can acquire.
  await a.close();
  assert.equal(existsSync(a.lockPath), false);
  const b = await openTrustedRootsLedger({ hostDir, instanceId: "instance-b-bbbb" });
  await b.close();

  // Stale lock (dead pid) → LEDGER_LOCK_STALE, ledger untouched. Explicit
  // fixture removal (operator action after proving old pid dead) then restores.
  const staleDir = temp("pi-lock-stale-");
  let s = await openTrustedRootsLedger({ hostDir: staleDir });
  await s.writeAll([claim({ claimId: "claim-stale-aaaa", path: "/tmp/st", repoRoot: "/tmp/r", base: "/tmp/r-worktrees" })]);
  const staleLedgerBytes = readFileSync(join(staleDir, LEDGER_FILE_NAME));
  const staleLedgerIno = lstatSync(join(staleDir, LEDGER_FILE_NAME)).ino;
  const staleLockPath = s.lockPath;
  // Do NOT close: simulate SIGKILL leaving the lock with a dead pid.
  writeFileSync(staleLockPath, JSON.stringify({ pid: 999_999_999, instanceId: "dead-instance-xx", createdAt: 1 }) + "\n", { mode: 0o600 });
  await assert.rejects(
    () => openTrustedRootsLedger({ hostDir: staleDir, instanceId: "instance-c-cccc" }),
    (e) => e.code === "LEDGER_LOCK_STALE",
  );
  assert.deepEqual(readFileSync(join(staleDir, LEDGER_FILE_NAME)), staleLedgerBytes);
  assert.equal(lstatSync(join(staleDir, LEDGER_FILE_NAME)).ino, staleLedgerIno);
  // Operator explicitly removes the fixture stale lock after proving pid dead.
  rmSync(staleLockPath, { force: true });
  s = await openTrustedRootsLedger({ hostDir: staleDir, instanceId: "instance-c-cccc" });
  assert.equal((await s.read()).claims.length, 1, "restart after explicit stale-lock removal restores claims");
  await s.close();

  // Wrong instance cannot unlock: A's close must not remove B's lock.
  const lockDir = temp("pi-lock-owner-");
  const owner = await openTrustedRootsLedger({ hostDir: lockDir, instanceId: "instance-owner-1" });
  writeFileSync(owner.lockPath, JSON.stringify({ pid: process.pid, instanceId: "instance-other-9", createdAt: 1 }) + "\n", { mode: 0o600 });
  await owner.close();
  assert.equal(existsSync(owner.lockPath), true, "wrong instance must not unlock another Host's lock");
  rmSync(owner.lockPath, { force: true });
});

// ---------------------------------------------------------------------------
// Corrupt ledger is immutable evidence (D3A-P0 decision 3)
// ---------------------------------------------------------------------------

test("corrupt/wrong-version/wrong-kind/duplicate/sparse ledger fails startup; bytes+inode unchanged", async () => {
  const corruptors = [
    { content: "{not-json", code: "LEDGER_CORRUPT" },
    { content: JSON.stringify({ kind: "other", version: 1, claims: [] }), code: "LEDGER_WRONG_KIND" },
    { content: JSON.stringify({ kind: TRUSTED_ROOTS_KIND, version: 99, claims: [] }), code: "LEDGER_UNKNOWN_VERSION" },
    { content: JSON.stringify({ kind: TRUSTED_ROOTS_KIND, version: 1, claims: [{ claimId: "x", path: "/a" }] }), code: "LEDGER_SPARSE" },
    {
      content: JSON.stringify({
        kind: TRUSTED_ROOTS_KIND, version: 1,
        claims: [claim({ claimId: "claim-dup-aaaa" }), claim({ claimId: "claim-dup-aaaa", path: "/other" })],
      }),
      code: "LEDGER_DUPLICATE",
    },
  ];
  for (const { content, code } of corruptors) {
    const hostDir = temp("pi-corrupt-case-");
    writeFileSync(join(hostDir, LEDGER_FILE_NAME), content, { mode: 0o600 });
    const beforeBytes = readFileSync(join(hostDir, LEDGER_FILE_NAME));
    const beforeStat = lstatSync(join(hostDir, LEDGER_FILE_NAME));
    await assert.rejects(() => openTrustedRootsLedger({ hostDir }), (e) => e.code === code);
    assert.deepEqual(readFileSync(join(hostDir, LEDGER_FILE_NAME)), beforeBytes, `${code}: bytes unchanged`);
    assert.equal(lstatSync(join(hostDir, LEDGER_FILE_NAME)).ino, beforeStat.ino, `${code}: inode unchanged`);
    assert.equal(existsSync(join(hostDir, LEDGER_LOCK_NAME)), false, `${code}: no lock created on corrupt ledger`);
  }
});

test("corrupt ledger also fails mutations; never rewritten/truncated", async () => {
  const root = temp("pi-corrupt-mut-repo-");
  initRepo(root);
  const hostDir = temp("pi-corrupt-mut-host-");
  const ledger = await openTrustedRootsLedger({ hostDir });
  const service = await createAllowedRootService({ roots: [root], maxRoots: 16 });
  attachTrustedRootsLedger(service, ledger);
  const target = makeWorktree(root, "feature-mut");
  const base = realpathSync(`${resolve(realpathSync(root))}-worktrees`);
  await registerTrustedCreatedRoot(service, { path: target, repoRoot: root, base, branch: "feature-mut", claimId: "claim-mut-aaaaa" });
  assert.equal((await ledger.read()).claims.length, 1);

  // Externally corrupt the ledger while the Host runs.
  const ledgerPath = ledger.ledgerPath;
  writeFileSync(ledgerPath, "{not-json", { mode: 0o600 });
  const corruptBytes = readFileSync(ledgerPath);
  const corruptStat = lstatSync(ledgerPath);
  // A mutation attempt (register another worktree) must fail closed and not rewrite.
  const target2 = makeWorktree(root, "feature-mut2");
  await assert.rejects(
    () => registerTrustedCreatedRoot(service, { path: target2, repoRoot: root, base, branch: "feature-mut2", claimId: "claim-mut2-aaaa" }),
    (e) => e.code === "TRUSTED_ROOT_PERSIST_FAILED",
  );
  assert.deepEqual(readFileSync(ledgerPath), corruptBytes, "mutation must not rewrite corrupt ledger");
  assert.equal(lstatSync(ledgerPath).ino, corruptStat.ino);
  assert.equal(listTrustedCreatedRoots(service).some((c) => c.claimId === "claim-mut2-aaaa"), false);
});

test("missing ledger is empty and not created until the first claim", async () => {
  const hostDir = temp("pi-missing-ledger-");
  const ledger = await openTrustedRootsLedger({ hostDir });
  assert.equal(existsSync(ledger.ledgerPath), false, "missing ledger must not be created at open");
  assert.equal(existsSync(ledger.lockPath), true, "lifetime lock is created at open");
  assert.deepEqual((await ledger.read()).claims, []);
  await ledger.writeAll([claim({ claimId: "claim-first-aaa", path: "/tmp/f1", repoRoot: "/tmp/r", base: "/tmp/r-worktrees" })]);
  assert.equal(existsSync(ledger.ledgerPath), true, "ledger is created on the first claim");
  await ledger.close();
});

// ---------------------------------------------------------------------------
// Durability contract (D3A-P0 decision 4)
// ---------------------------------------------------------------------------

test("injected temp fsync / rename / directory-fsync failures never report success", async () => {
  const hostDir = temp("pi-inject-fsync-");
  let ledger = await openTrustedRootsLedger({ hostDir });
  const baseClaim = claim({ claimId: "claim-inj-base-1", path: "/tmp/i1", repoRoot: "/tmp/r", base: "/tmp/r-worktrees" });
  await ledger.writeAll([baseClaim]);
  await ledger.close();
  const oldBytes = readFileSync(join(hostDir, LEDGER_FILE_NAME));
  const oldIno = lstatSync(join(hostDir, LEDGER_FILE_NAME)).ino;

  // temp fsync failure → reject, old ledger preserved, no stray temp.
  ledger = await openTrustedRootsLedger({ hostDir, failTempFsync: () => { throw new Error("injected temp fsync"); } });
  await assert.rejects(() => ledger.writeAll([claim({ claimId: "claim-inj-b-0001", path: "/tmp/i2", repoRoot: "/tmp/r", base: "/tmp/r-worktrees" })]), (e) => e.code === "LEDGER_WRITE_FAILED");
  assert.deepEqual(readFileSync(join(hostDir, LEDGER_FILE_NAME)), oldBytes);
  assert.equal(lstatSync(join(hostDir, LEDGER_FILE_NAME)).ino, oldIno);
  assert.equal(readdirSync(hostDir).filter((n) => n.endsWith(".tmp")).length, 0, "temp must be cleaned on failure");
  await ledger.close();

  // rename failure → reject, old ledger preserved.
  ledger = await openTrustedRootsLedger({ hostDir, failRename: () => { throw new Error("injected rename"); } });
  await assert.rejects(() => ledger.writeAll([claim({ claimId: "claim-inj-c-0001", path: "/tmp/i3", repoRoot: "/tmp/r", base: "/tmp/r-worktrees" })]), (e) => e.code === "LEDGER_WRITE_FAILED");
  assert.deepEqual(readFileSync(join(hostDir, LEDGER_FILE_NAME)), oldBytes);
  assert.equal(lstatSync(join(hostDir, LEDGER_FILE_NAME)).ino, oldIno);
  await ledger.close();

  // arbitrary dir-fsync failure (EIO) → FATAL: reject, no success reported.
  ledger = await openTrustedRootsLedger({ hostDir, failDirFsync: () => { const e = new Error("eio"); e.code = "EIO"; throw e; } });
  await assert.rejects(() => ledger.writeAll([claim({ claimId: "claim-inj-d-0001", path: "/tmp/i4", repoRoot: "/tmp/r", base: "/tmp/r-worktrees" })]), (e) => e.code === "LEDGER_WRITE_FAILED");
  // The rename already happened; the document must still be complete JSON (not torn).
  JSON.parse(readFileSync(join(hostDir, LEDGER_FILE_NAME), "utf8"));
  await ledger.close();

  // truly-unsupported dir-fsync (EINVAL) → tolerated; write reports success.
  ledger = await openTrustedRootsLedger({ hostDir, failDirFsync: () => { const e = new Error("einval"); e.code = "EINVAL"; throw e; } });
  await ledger.writeAll([claim({ claimId: "claim-inj-e-0001", path: "/tmp/i5", repoRoot: "/tmp/r", base: "/tmp/r-worktrees" })]);
  assert.equal((await ledger.read()).claims.some((c) => c.claimId === "claim-inj-e-0001"), true);
  await ledger.close();
});

test("crash window: temp debris left behind does not tear the published ledger", async () => {
  const hostDir = temp("pi-atomic-");
  const ledger = await openTrustedRootsLedger({ hostDir });
  await ledger.writeAll([claim({ claimId: "claim-atomic-01", path: "/tmp/a1", repoRoot: "/tmp/r", base: "/tmp/r-worktrees" })]);
  const before = readFileSync(ledger.ledgerPath, "utf8");
  writeFileSync(join(hostDir, `${LEDGER_FILE_NAME}.12345.deadbeef.tmp`), "partial", { mode: 0o600 });
  assert.equal((await ledger.read()).claims.length, 1);
  assert.equal(readFileSync(ledger.ledgerPath, "utf8"), before);
  await ledger.writeAll([]);
  assert.equal(readFileSync(ledger.ledgerPath, "utf8").includes("\"claims\":[]"), true);
  await ledger.close();
  // A restart with leftover temp debris still opens (temp is recognized layout).
  const reopened = await openTrustedRootsLedger({ hostDir });
  assert.equal((await reopened.read()).claims.length, 0);
  await reopened.close();
});

// ---------------------------------------------------------------------------
// register / unregister / rehydrate
// ---------------------------------------------------------------------------

test("register persists to disk BEFORE memory authorization (no 201 before commit)", async () => {
  const root = temp("pi-reg-repo-");
  initRepo(root);
  const hostDir = temp("pi-reg-host-");
  const ledger = await openTrustedRootsLedger({ hostDir });
  const service = await createAllowedRootService({ roots: [root], maxRoots: 16 });
  attachTrustedRootsLedger(service, ledger);
  const target = makeWorktree(root, "feature-reg");
  const base = realpathSync(`${resolve(realpathSync(root))}-worktrees`);
  assert.equal((await ledger.read()).claims.length, 0);
  const receipt = await registerTrustedCreatedRoot(service, { path: target, repoRoot: root, base, branch: "feature-reg" });
  assert.equal(receipt.added, true);
  assert.equal(typeof receipt.claimId, "string");
  assert.equal((await ledger.read()).claims.length, 1, "ledger persisted before isAuthorized returns true");
  assert.equal(await service.isAuthorized(target, "directory"), true);
  await receipt.rollback();
  assert.equal((await ledger.read()).claims.length, 0, "rollback removes only the owner claim");
  assert.equal(await service.isAuthorized(target, "directory"), false);
  await ledger.close();
});

test("rehydrate: create→fresh service restores; delete→restart does not; planted/external stay unauthorized", async () => {
  const root = temp("pi-rehydrate-repo-");
  initRepo(root);
  const hostDir = temp("pi-rehydrate-host-");
  const ledger = await openTrustedRootsLedger({ hostDir });
  const target = makeWorktree(root, "feature-a");
  const base = realpathSync(`${resolve(realpathSync(root))}-worktrees`);

  const service1 = await createAllowedRootService({ roots: [root], maxRoots: 16 });
  attachTrustedRootsLedger(service1, ledger);
  const receipt = await registerTrustedCreatedRoot(service1, { path: target, repoRoot: root, base, branch: "feature-a" });
  assert.equal(receipt.added, true);
  assert.equal(await service1.isAuthorized(target, "directory"), true);
  const onDisk = await ledger.read();
  assert.equal(onDisk.claims.length, 1);

  // Fresh service simulates Host restart.
  const service2 = await createAllowedRootService({ roots: [root], maxRoots: 16 });
  attachTrustedRootsLedger(service2, ledger);
  const snap = await ledger.read();
  const result = await rehydrateTrustedCreatedRoots(service2, snap.claims, { listWorktrees });
  assert.equal(result.restored, 1);
  assert.equal(await service2.isAuthorized(target, "directory"), true);

  // External worktree (outside base) without ledger never authorized.
  const externalBase = temp("pi-external-wt-");
  const external = join(externalBase, "ext");
  git(root, ["worktree", "add", "-b", "external-b", "--", external]);
  assert.equal(await service2.isAuthorized(external, "directory"), false);

  // Planted matching path inside base without ledger entry stays unauthorized.
  const planted = join(base, "planted");
  git(root, ["worktree", "add", "-b", "planted-b", "--", planted]);
  assert.equal(await service2.isAuthorized(planted, "directory"), false);

  // Delete worktree + unregister; restart must not restore.
  git(root, ["worktree", "remove", "--force", "--", target]);
  await unregisterTrustedCreatedRoot(service2, onDisk.claims[0].path);
  const service3 = await createAllowedRootService({ roots: [root], maxRoots: 16 });
  attachTrustedRootsLedger(service3, ledger);
  const afterDelete = await rehydrateTrustedCreatedRoots(service3, (await ledger.read()).claims, { listWorktrees });
  assert.equal(afterDelete.restored, 0);
  assert.equal(await service3.isAuthorized(target, "directory"), false);
  await ledger.close();
});

test("delete after ledger write failure: stale entry dropped by git missing on rehydrate", async () => {
  const root = temp("pi-stale-repo-");
  initRepo(root);
  const hostDir = temp("pi-stale-host-");
  const ledger = await openTrustedRootsLedger({ hostDir });
  const service = await createAllowedRootService({ roots: [root], maxRoots: 16 });
  attachTrustedRootsLedger(service, ledger);
  const target = makeWorktree(root, "stale-a");
  const base = realpathSync(`${resolve(realpathSync(root))}-worktrees`);
  await registerTrustedCreatedRoot(service, { path: target, repoRoot: root, base, branch: "stale-a" });
  const path = (await ledger.read()).claims[0].path;
  git(root, ["worktree", "remove", "--force", "--", target]);
  assert.equal((await ledger.read()).claims.length, 1, "stale ledger row remains");
  const fresh = await createAllowedRootService({ roots: [root], maxRoots: 16 });
  attachTrustedRootsLedger(fresh, ledger);
  const r = await rehydrateTrustedCreatedRoots(fresh, (await ledger.read()).claims, { listWorktrees });
  assert.equal(r.restored, 0);
  assert.equal(r.dropped, 1);
  assert.equal(await fresh.isAuthorized(path, "directory"), false);
  assert.equal((await ledger.read()).claims.length, 0, "rehydrate drops the stale row");
  await ledger.close();
});

test("rehydrate drops: path/repo identity replace, symlink path/base, path escape, repo replaced", async () => {
  const root = temp("pi-drop-repo-");
  initRepo(root);
  const hostDir = temp("pi-drop-host-");
  const ledger = await openTrustedRootsLedger({ hostDir });
  const target = makeWorktree(root, "drop-me");
  const good = await liveClaimForWorktree(root, target, "drop-me");
  await ledger.writeAll([good]);

  const wrongIno = { ...good, ino: good.ino + 99999, claimId: "claim-wrong-ino-x" };
  const wrongRepo = { ...good, repoIno: good.repoIno + 99999, claimId: "claim-wrong-repo-x" };
  const escape = { ...good, path: realpathSync(root), claimId: "claim-escape-xxx" };
  const badBase = { ...good, base: realpathSync(root), claimId: "claim-bad-base-xx" };

  for (const bad of [wrongIno, wrongRepo, escape, badBase]) {
    const service = await createAllowedRootService({ roots: [root], maxRoots: 16 });
    const r = await rehydrateTrustedCreatedRoots(service, [bad], { listWorktrees });
    assert.equal(r.restored, 0, bad.claimId);
    assert.equal(await service.isAuthorized(good.path, "directory"), false);
  }

  // symlink path claim: not a real directory identity.
  const outside = temp("pi-sym-out-");
  const symPath = join(realpathSync(`${resolve(realpathSync(root))}-worktrees`), "sym-claim");
  const symClaim = { ...good, path: symPath, claimId: "claim-sym-path-x", dev: 0, ino: 0 };
  try { symlinkSync(outside, symPath, "dir"); } catch { /* may exist */ }
  const serviceSym = await createAllowedRootService({ roots: [root], maxRoots: 16 });
  const rSym = await rehydrateTrustedCreatedRoots(serviceSym, [symClaim], { listWorktrees });
  assert.equal(rSym.restored, 0);

  // good claim still rehydrates.
  const serviceOk = await createAllowedRootService({ roots: [root], maxRoots: 16 });
  attachTrustedRootsLedger(serviceOk, ledger);
  const rOk = await rehydrateTrustedCreatedRoots(serviceOk, [good], { listWorktrees });
  assert.equal(rOk.restored, 1);
  assert.equal(await serviceOk.isAuthorized(good.path, "directory"), true);
  await ledger.close();
});

test("durable promotion absorbs trusted claims; ledger RMW removes only absorbed claims", async () => {
  const root = temp("pi-promo-repo-");
  initRepo(root);
  const hostDir = temp("pi-promo-host-");
  const ledger = await openTrustedRootsLedger({ hostDir });
  const service = await createAllowedRootService({ roots: [root], maxRoots: 16, allowLocalExpansion: true });
  attachTrustedRootsLedger(service, ledger);
  const target = makeWorktree(root, "promo-a");
  const base = realpathSync(`${resolve(realpathSync(root))}-worktrees`);
  const receipt = await registerTrustedCreatedRoot(service, { path: target, repoRoot: root, base, branch: "promo-a", claimId: "claim-promo-aaaa" });
  assert.equal(receipt.added, true);
  assert.equal((await ledger.read()).claims.length, 1);
  // A durable parent (the base) promotion absorbs the trusted claim.
  await service.expandRoots([base], "local");
  assert.equal(await service.isAuthorized(target, "directory"), true);
  assert.equal((await ledger.read()).claims.length, 0, "absorbed claim removed from ledger");
  await receipt.rollback(); // no-op (already absorbed)
  assert.equal((await ledger.read()).claims.length, 0);
  await ledger.close();
});

test("foreign claims preserved on local rehydrate; capacity lowering fails non-destructively", async () => {
  const repoA = temp("pi-fw-repo-a-");
  const repoB = temp("pi-fw-repo-b-");
  initRepo(repoA);
  initRepo(repoB);
  const hostDir = temp("pi-fw-host-");
  const ledger = await openTrustedRootsLedger({ hostDir, instanceId: "host-fw-shared" });
  const serviceA = await createAllowedRootService({ roots: [repoA], maxRoots: 16 });
  const serviceB = await createAllowedRootService({ roots: [repoB], maxRoots: 16 });
  attachTrustedRootsLedger(serviceA, ledger);
  attachTrustedRootsLedger(serviceB, ledger);
  const targetA = makeWorktree(repoA, "feature-fw");
  const targetB = makeWorktree(repoB, "feature-fw");
  const baseA = realpathSync(`${resolve(realpathSync(repoA))}-worktrees`);
  const baseB = realpathSync(`${resolve(realpathSync(repoB))}-worktrees`);
  await registerTrustedCreatedRoot(serviceA, { path: targetA, repoRoot: repoA, base: baseA, branch: "feature-fw", claimId: "claim-fw-a-aaaa" });
  await registerTrustedCreatedRoot(serviceB, { path: targetB, repoRoot: repoB, base: baseB, branch: "feature-fw", claimId: "claim-fw-b-bbbb" });
  assert.equal((await ledger.read()).claims.length, 2);

  // Fresh Host A boot: restores A's own claim; B's foreign claim preserved.
  const freshA = await createAllowedRootService({ roots: [repoA], maxRoots: 16 });
  attachTrustedRootsLedger(freshA, ledger);
  const resultA = await rehydrateTrustedCreatedRoots(freshA, (await ledger.read()).claims, { listWorktrees });
  assert.equal(resultA.restored, 1);
  assert.equal(await freshA.isAuthorized(targetA, "directory"), true);
  assert.equal(await freshA.isAuthorized(targetB, "directory"), false);
  const afterA = await ledger.read();
  assert.equal(afterA.claims.length, 2, "A rehydrate must not delete B's foreign claim");
  assert.ok(new Set(afterA.claims.map((c) => c.claimId)).has("claim-fw-b-bbbb"));

  // Capacity lowering (maxRoots=1) with two surviving claims → FAIL, evidence preserved.
  const low = await createAllowedRootService({ roots: [repoA], maxRoots: 1 });
  attachTrustedRootsLedger(low, ledger);
  const beforeBytes = readFileSync(join(hostDir, LEDGER_FILE_NAME));
  await assert.rejects(
    async () => rehydrateTrustedCreatedRoots(low, (await ledger.read()).claims, { listWorktrees }),
    (e) => e.code === "LEDGER_OVERSIZE",
  );
  assert.deepEqual(readFileSync(join(hostDir, LEDGER_FILE_NAME)), beforeBytes, "capacity lowering must not destructively empty");
  assert.equal((await ledger.read()).claims.length, 2);
  await ledger.close();
});

test("collision and identity replacement fail closed; loser never authorizes", async () => {
  const root = temp("pi-collision-repo-");
  initRepo(root);
  const hostDir = temp("pi-collision-host-");
  const ledger = await openTrustedRootsLedger({ hostDir });
  const service = await createAllowedRootService({ roots: [root], maxRoots: 16 });
  attachTrustedRootsLedger(service, ledger);
  const target = makeWorktree(root, "shared");
  const base = realpathSync(`${resolve(realpathSync(root))}-worktrees`);
  await registerTrustedCreatedRoot(service, { path: target, repoRoot: root, base, branch: "shared", claimId: "claim-owner-old-01" });
  // Same claimId with different content → fail closed, keep old.
  await assert.rejects(
    () => registerTrustedCreatedRoot(service, { path: target, repoRoot: root, base, branch: "shared-changed", claimId: "claim-owner-old-01" }),
    (e) => e.code === "TRUSTED_ROOT_PERSIST_FAILED",
  );
  const kept = await ledger.read();
  assert.equal(kept.claims.length, 1);
  assert.equal(kept.claims[0].branch, "shared");
  await ledger.close();
});

// ---------------------------------------------------------------------------
// Production composition / worktree route
// ---------------------------------------------------------------------------

test("worktree create managed persistence failure rolls back worktree/branch and never 201", async () => {
  const root = temp("pi-persist-fail-");
  initRepo(root);
  const hostDir = temp("pi-persist-fail-host-");
  const lease = await openHostStateDirectoryLease({ hostDir, instanceId: "pi-persist-fail-0001", failTempFsync: () => { throw new Error("injected"); } });
  const trusted = createTrustedRootsLedgerFromLease(lease, { maxClaims: 16 });
  const managedLedger = createManagedWorktreesLedgerFromLease(lease, { maxRecords: 16 });
  const roots = await createAllowedRootService({ roots: [root], maxRoots: 16 });
  attachTrustedRootsLedger(roots, trusted);
  const managedWorktrees = createManagedWorktreesService({ ledger: managedLedger, allowedRoots: roots });
  const gate = { config: { read: () => ({ status: "disabled", source: "test" }) } };
  const app = createHostApp({ logger: {}, gate, resources: { allowedRoots: roots, managedWorktrees } }).app;
  const response = await app.request("http://localhost/v1/worktrees", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ cwd: root, branch: "persist-fail" }),
  });
  assert.equal(response.status, 500);
  assert.equal((await response.json()).code, "MANAGED_WRITE_FAILED");
  assert.throws(() => git(root, ["show-ref", "--verify", "refs/heads/persist-fail"]), "persist failure must roll back the branch");
  const linked = join(`${realpathSync(root)}-worktrees`, "persist-fail");
  const porcelain = git(root, ["worktree", "list", "--porcelain"]);
  assert.ok(!porcelain.includes(linked), `stale worktree remained: ${porcelain}`);
  assert.equal((await managedLedger.read()).records.length, 0, "no managed record after persist failure");
  assert.equal((await trusted.read()).claims.length, 0, "no trusted claim written for a managed create");
  assert.equal(await roots.isAuthorized(linked, "directory"), false);
  await lease.close();
});

test("create→production resources restart→authorized; sessiond down GET still works; POST 503 before git", async () => {
  const root = temp("pi-prod-restart-");
  initRepo(root);
  const hostDir = temp("pi-prod-host-");
  const sessionDir = temp("pi-prod-sessiond-");
  const fakeEndpoint = join(sessionDir, "sessiond.sock");
  const fakeSecret = "x".repeat(48);
  const gate = { config: { read: () => ({ status: "disabled", source: "test" }) } };

  const first = await createProductionResources({
    allowedRootsEnv: root,
    cwd: root,
    endpoint: fakeEndpoint,
    secret: fakeSecret,
    hostDirEnv: hostDir,
  });
  const app1 = createHostApp({
    logger: {},
    gate,
    resources: { allowedRoots: first.deps.allowedRoots, processRunner: first.deps.processRunner, busyPreflight: { check: async () => ({ busy: false }) }, managedWorktrees: first.managedWorktrees },
  }).app;
  const created = await app1.request("http://localhost/v1/worktrees", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ cwd: root, branch: "restart-a" }),
  });
  assert.equal(created.status, 201);
  const { path } = await created.json();
  assert.equal(await first.deps.allowedRoots.isAuthorized(path, "directory"), true);
  assert.equal((await first.managedWorktreesLedger.read()).records.length, 1, "one durable managed record");
  assert.equal((await first.trustedRootsLedger.read()).claims.length, 0, "no trusted claim for a managed create");
  // Graceful close releases the lifetime lock before the simulated restart.
  await first.trustedRootsLedger.close();

  const second = await createProductionResources({
    allowedRootsEnv: root,
    cwd: root,
    endpoint: fakeEndpoint,
    secret: fakeSecret,
    hostDirEnv: hostDir,
  });
  assert.equal(await second.deps.allowedRoots.isAuthorized(path, "directory"), true, "managed record rehydrates + authorizes after restart");

  // sessiond-down style: no mutationGuard; GET list still authorizes; files authorize.
  const app2 = createHostApp({
    logger: {},
    gate,
    resources: {
      allowedRoots: second.deps.allowedRoots,
      processRunner: second.deps.processRunner,
      mutationGuard: { assertAvailable: async () => { const { HttpError } = await import("../dist/index.js"); throw new HttpError(503, "MUTATION_UNAVAILABLE", "Runtime authority unavailable"); } },
      busyPreflight: { check: async () => ({ busy: false }) },
      managedWorktrees: second.managedWorktrees,
    },
  }).app;
  const listed = await app2.request(`http://localhost/v1/worktrees?cwd=${encodeURIComponent(root)}`, { headers: { host: "localhost" } });
  assert.equal(listed.status, 200);
  const item = (await listed.json()).worktrees.find((w) => w.path === path);
  assert.equal(item?.authorized, true);
  assert.equal(item?.managedByPix, true, "rehydrated managed worktree reports managedByPix");
  const file = join(path, "tracked.txt");
  const fileRes = await app2.request(`http://localhost/v1/files?op=read&path=${encodeURIComponent(file)}`, { headers: { host: "localhost" } });
  assert.equal(fileRes.status, 200);
  const blocked = await app2.request("http://localhost/v1/worktrees", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ cwd: root, branch: "should-not" }),
  });
  // 503 must come from the sessiond-down mutation guard layer (not a ledger
  // lock/fs failure), and no git/ledger side effect may occur before it.
  assert.equal(blocked.status, 503);
  assert.equal((await blocked.json()).code, "MUTATION_UNAVAILABLE");
  assert.throws(() => git(root, ["show-ref", "--verify", "refs/heads/should-not"]), "guard must run before any git side effect");
  assert.equal((await second.managedWorktreesLedger.read()).records.length, 1, "blocked POST must not touch the managed ledger");
  assert.equal(await second.deps.allowedRoots.isAuthorized(path, "directory"), true, "rehydrated authorization survives the blocked POST");
  await second.trustedRootsLedger.close();
});

test("authenticated LAN worktree create/delete persists durably; unauth LAN blocked before Git", async () => {
  const root = temp("pi-lan-repo-");
  initRepo(root);
  const hostDir = temp("pi-lan-host-");
  const lease = await openHostStateDirectoryLease({ hostDir, instanceId: "pi-lan-00000001" });
  const trusted = createTrustedRootsLedgerFromLease(lease, { maxClaims: 16 });
  const managedLedger = createManagedWorktreesLedgerFromLease(lease, { maxRecords: 16 });
  const roots = await createAllowedRootService({ roots: [root], maxRoots: 16 });
  attachTrustedRootsLedger(roots, trusted);
  const managedWorktrees = createManagedWorktreesService({ ledger: managedLedger, allowedRoots: roots });
  const gate = { config: { read: () => ({ status: "enabled", password: "secret", source: "test" }) } };
  const app = createHostApp({
    logger: {},
    gate,
    exposureMode: "lan",
    resources: { allowedRoots: roots, busyPreflight: { check: async () => ({ busy: false }) }, managedWorktrees },
  }).app;
  const headers = { host: "127.0.0.1" };

  // Unauthenticated LAN create → blocked by the gate before any Git/mutation.
  const denied = await app.request("http://127.0.0.1/v1/worktrees", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ cwd: root, branch: "lan-blocked" }),
  });
  assert.equal(denied.status, 401, "enabled LAN gate blocks unauthenticated API with 401");
  assert.equal((await denied.json()).code, "UNAUTHORIZED");
  assert.throws(() => git(root, ["show-ref", "--verify", "refs/heads/lan-blocked"]), "gate must block before any git side effect");
  assert.equal((await managedLedger.read()).records.length, 0, "gate must block before any managed ledger side effect");
  assert.equal((await trusted.read()).claims.length, 0, "gate must block before any trusted ledger side effect");
  assert.equal(existsSync(join(`${realpathSync(root)}-worktrees`, "lan-blocked")), false, "gate must block before any filesystem side effect");

  // Authenticated LAN create → 201 + durable managed record.
  const login = await app.request("http://127.0.0.1/v1/gate/login", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ password: "secret" }),
  });
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const created = await app.request("http://127.0.0.1/v1/worktrees", {
    method: "POST",
    headers: { ...headers, cookie, "content-type": "application/json" },
    body: JSON.stringify({ cwd: root, branch: "lan-persist" }),
  });
  assert.equal(created.status, 201);
  assert.equal((await managedLedger.read()).records.length, 1, "authenticated LAN create persists a managed record durably");
  const delPath = (await created.json()).path;

  // Authenticated LAN delete → managed record removed durably.
  const del = await app.request("http://127.0.0.1/v1/worktrees", {
    method: "DELETE",
    headers: { ...headers, cookie, "content-type": "application/json" },
    body: JSON.stringify({ cwd: root, path: delPath }),
  });
  assert.equal(del.status, 200);
  assert.equal((await managedLedger.read()).records.length, 0, "authenticated LAN delete removes the managed record durably");
  await lease.close();
});

// ---------------------------------------------------------------------------
// Sanitized errors / public surface
// ---------------------------------------------------------------------------

test("InvalidHostDirError: fixed sanitized text, no path/branch/raw JSON leakage", async () => {
  const root = temp("pi-bad-host-");
  // relative PIX_HOST_DIR → fixed HOST_DIR_INVALID code, no path echo.
  await assert.rejects(
    () => createProductionResources({
      allowedRootsEnv: root,
      cwd: root,
      endpoint: "/tmp/x.sock",
      secret: "y".repeat(48),
      hostDirEnv: "relative-SECRET_PATH_MARKER",
    }),
    (e) => e instanceof InvalidHostDirError
      && e.message === "PIX_HOST_DIR rejected (HOST_DIR_INVALID)"
      && !e.message.includes("SECRET_PATH_MARKER"),
  );

  // corrupt ledger → fixed LEDGER_CORRUPT code, no path/raw JSON.
  const hostDir = temp("pi-corrupt-secret-");
  writeFileSync(join(hostDir, LEDGER_FILE_NAME), "{not-json SECRET_PATH_MARKER", { mode: 0o600 });
  await assert.rejects(
    () => createProductionResources({
      allowedRootsEnv: root,
      cwd: root,
      endpoint: "/tmp/x.sock",
      secret: "y".repeat(48),
      hostDirEnv: hostDir,
    }),
    (e) => e instanceof InvalidHostDirError
      && e.message === "PIX_HOST_DIR rejected (LEDGER_CORRUPT)"
      && !e.message.includes(hostDir)
      && !e.message.includes("SECRET_PATH_MARKER")
      && !String(e.stack ?? "").includes("SECRET_PATH_MARKER"),
  );
  // evidence untouched after the failed startup.
  assert.equal(readFileSync(join(hostDir, LEDGER_FILE_NAME), "utf8").includes("SECRET_PATH_MARKER"), true);
});

test("string-only registerTrustedCreatedRoot remains memory-only (no ledger without repo metadata)", async () => {
  const configured = temp("pi-mem-cfg-");
  const created = temp("pi-mem-created-");
  const hostDir = temp("pi-mem-host-");
  const ledger = await openTrustedRootsLedger({ hostDir });
  const service = await createAllowedRootService({ roots: [configured], maxRoots: 8 });
  attachTrustedRootsLedger(service, ledger);
  const receipt = await registerTrustedCreatedRoot(service, created);
  assert.equal(receipt.added, true);
  assert.equal(await service.isAuthorized(created, "directory"), true);
  assert.equal((await ledger.read()).claims.length, 0);
  await ledger.close();
});

// ---------------------------------------------------------------------------
// Static source guards
// ---------------------------------------------------------------------------

test("lease source: fd-based fchmod only; ownership re-verified before publish; lifetime lock no stale reclaim", async () => {
  // D3A extraction moved the low-level primitives (host-dir fchmod, temp/lock
  // fchmod, atomic rename, lifetime lock) into the shared host-state-directory
  // lease; the trusted-roots ledger is now a thin adapter over it.
  const leaseSrc = readFileSync(new URL("../src/resources/host-state-directory.ts", import.meta.url), "utf8");
  const ledgerSrc = readFileSync(new URL("../src/resources/trusted-roots-ledger.ts", import.meta.url), "utf8");
  // No path-based chmod anywhere (dir/temp/lock/ledger); only fd-based `.chmod`.
  assert.equal(/await chmod\(/.test(leaseSrc), false, "must never path-chmod");
  assert.equal((leaseSrc.match(/\.chmod\(/g) ?? []).length, 3, "exactly three fd-based chmod call sites (dir, temp, lock)");
  assert.match(leaseSrc, /dirHandle\.chmod\(0o700\)/);
  assert.match(leaseSrc, /handle\.chmod\(0o600\)/);
  // Ownership re-verification runs before the atomic publish (rename).
  const renameIdx = leaseSrc.indexOf("await rename(temp, targetPath)");
  const verifyIdx = leaseSrc.indexOf("ownership lost before publish");
  assert.ok(verifyIdx !== -1 && renameIdx !== -1 && verifyIdx < renameIdx, "ownership check must precede rename");
  // Lifetime lock: stale lock fails closed (LOCK_STALE), never auto-reclaimed.
  assert.match(leaseSrc, /LOCK_STALE/);
  assert.match(leaseSrc, /LOCK_BUSY/);
  // The trusted-roots adapter delegates to the shared lease (no raw primitives).
  assert.match(ledgerSrc, /openHostStateDirectoryLease/);
  assert.equal(/await chmod\(/.test(ledgerSrc), false, "adapter must never path-chmod");
  assert.equal(ledgerSrc.includes("await rename(temp,"), false, "atomic rename lives in the lease");
});
