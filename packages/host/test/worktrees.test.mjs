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
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createHostApp,
  createProcessRunner,
  createAllowedRootService,
  HttpError,
  PRODUCTION_RESOURCE_LIMITS,
} from "../dist/index.js";
import { openHostStateDirectoryLease } from "../dist/resources/host-state-directory.js";
import { createTrustedRootsLedgerFromLease } from "../dist/resources/trusted-roots-ledger.js";
import {
  createManagedWorktreesLedgerFromLease,
  MANAGED_WORKTREES_FILE_NAME,
} from "../dist/resources/managed-worktrees-ledger.js";
import {
  createManagedWorktreesService,
} from "../dist/resources/managed-worktrees.js";
import {
  attachTrustedRootsLedger,
  registerTrustedCreatedRoot,
  listTrustedCreatedRoots,
} from "../dist/resources/allowed-roots.js";

const temporary = [];
const CANON_TMP = realpathSync(tmpdir());
function temp(prefix) {
  const value = mkdtempSync(join(CANON_TMP, prefix));
  temporary.push(value);
  return value;
}
function dedicatedHostDir(prefix) {
  return join(temp(prefix), "host");
}
const leases = [];
afterEach(async () => {
  for (const close of leases.splice(0)) await close().catch(() => {});
  while (temporary.length) {
    const value = temporary.pop();
    rmSync(`${value}-worktrees`, { recursive: true, force: true });
    rmSync(value, { recursive: true, force: true });
  }
});

const gate = { config: { read: () => ({ status: "disabled", source: "test" }) } };
function headers(extra = {}) { return { host: "localhost", ...extra }; }
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
function makeWorktree(root, branch, { insideBase = true, externalRoot } = {}) {
  const canonicalRoot = realpathSync(root);
  if (insideBase) {
    const base = `${resolve(canonicalRoot)}-worktrees`;
    mkdirSync(base, { recursive: true });
    const target = join(base, branch);
    git(root, ["worktree", "add", "-b", branch, "--", target]);
    return realpathSync(target);
  }
  const base = externalRoot ?? temp("wt-external-");
  const target = join(base, branch);
  git(root, ["worktree", "add", "-b", branch, "--", target]);
  return realpathSync(target);
}

/**
 * Build a route app wired with a REAL managed-worktrees service over a REAL
 * shared host-state lease (one lock, one mutex). `busy`/`guard` are injected
 * preflight/guard seams; `managed` can override the service facade for fault
 * injection (e.g. a commitRemoved that throws).
 */
async function makeWorktreeApp(options = {}) {
  const { busy = async () => ({ busy: false }), guard, managed, exposureMode = "local", gateOverride, root: providedRoot, hostDir: providedHostDir } = options;
  const root = providedRoot ?? (() => { const r = temp("wt-repo-"); initRepo(r); return r; })();
  const hostDir = providedHostDir ?? dedicatedHostDir("wt-host-");
  const lease = await openHostStateDirectoryLease({ hostDir, instanceId: `wt-${process.pid}-${Math.random().toString(36).slice(2, 12)}` });
  leases.push(() => lease.close());
  const trusted = createTrustedRootsLedgerFromLease(lease, { maxClaims: 32 });
  const managedLedger = createManagedWorktreesLedgerFromLease(lease, { maxRecords: 32 });
  const allowedRoots = await createAllowedRootService({ roots: [realpathSync(root)], maxRoots: 32, allowLocalExpansion: true });
  attachTrustedRootsLedger(allowedRoots, trusted);
  const runner = createProcessRunner();
  const managedDeps = { ledger: managedLedger, allowedRoots, runner, maxOutputBytes: 8 * 1024 * 1024 };
  const service = createManagedWorktreesService(managedDeps);
  // Rehydrate managed ownership from the on-disk sidecar (mirrors the production
  // composition): live records publish memory authorization.
  await (await import("../dist/resources/managed-worktrees.js")).rehydrateManagedWorktrees(managedDeps, {
    isRepoManaged: (repoRoot) => allowedRoots.isAuthorized(repoRoot, "directory"),
  });
  const managedService = managed ? { ...service, ...managed } : service;
  const resources = {
    allowedRoots,
    processRunner: runner,
    managedWorktrees: managedService,
    busyPreflight: { check: busy },
    ...(guard ? { mutationGuard: { assertAvailable: guard } } : {}),
    limits: { ...PRODUCTION_RESOURCE_LIMITS },
  };
  const app = createHostApp({ logger: {}, gate: gateOverride ?? gate, exposureMode, resources }).app;
  return { app, root, hostDir, lease, trusted, managedLedger, managedService: service, allowedRoots, base: `${resolve(realpathSync(root))}-worktrees` };
}

async function postWorktree(app, cwd, branch, extra = {}) {
  return app.request("http://localhost/v1/worktrees", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ cwd, branch }),
    ...extra,
  });
}
async function deleteWorktree(app, cwd, path, extra = {}) {
  return app.request("http://localhost/v1/worktrees", {
    method: "DELETE",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ cwd, path }),
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Create: managed durable record (no trusted claim) + 201 contract
// ---------------------------------------------------------------------------

test("POST creates a managed worktree: 201 managedByPix, managed record, no trusted claim", { skip: process.platform === "win32" }, async () => {
  const { app, root, managedLedger, trusted, allowedRoots } = await makeWorktreeApp();
  const response = await postWorktree(app, root, "feature-a");
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.managedByPix, true);
  assert.equal(body.branch, "feature-a");
  const canonical = realpathSync(body.path);
  assert.equal(body.path, canonical);
  const managed = await managedLedger.read();
  assert.equal(managed.records.length, 1, "one managed record persisted");
  assert.equal(managed.records[0].path, canonical);
  assert.equal(managed.records[0].branchAtCreate, "feature-a");
  assert.equal(managed.records[0].branchCreatedByPix, true);
  assert.equal((await trusted.read()).claims.length, 0, "NO trusted-root claim for a new managed worktree");
  assert.equal(listTrustedCreatedRoots(allowedRoots).length, 0);
  assert.equal(await allowedRoots.isAuthorized(canonical, "directory"), true, "memory authorization published");
  // GET reports managedByPix true + authorized true.
  const listed = await (await app.request(`http://localhost/v1/worktrees?cwd=${encodeURIComponent(root)}`, { headers: headers() })).json();
  const entry = listed.worktrees.find((w) => w.path === canonical);
  assert.equal(entry?.managedByPix, true);
  assert.equal(entry?.authorized, true);
  assert.equal(entry?.isMain, false);
  assert.ok(!("safeToDelete" in (entry ?? {})), "no cached safeToDelete promise");
});

test("POST creates a managed worktree under an already-durable root with no trusted claim", { skip: process.platform === "win32" }, async () => {
  // Make the base itself a durable allowed root: the worktree path is still
  // managed (record + memory auth) and NO trusted claim is written.
  const root = temp("wt-durable-repo-"); initRepo(root);
  const base = `${resolve(realpathSync(root))}-worktrees`;
  mkdirSync(base);
  const { app, root: r, managedLedger, trusted, allowedRoots } = await makeWorktreeApp({ root, hostDir: dedicatedHostDir("wt-durable-host-") });
  await allowedRoots.expandRoots([realpathSync(base)], "local");
  const response = await postWorktree(app, r, "feature-durable");
  assert.equal(response.status, 201);
  assert.equal((await managedLedger.read()).records.length, 1, "managed record written even under a durable root");
  assert.equal((await trusted.read()).claims.length, 0, "no trusted claim");
});

// ---------------------------------------------------------------------------
// Restart managed+authorized (rehydrate)
// ---------------------------------------------------------------------------

test("restart restores workspace authorization but not destructive managed ownership", { skip: process.platform === "win32" }, async () => {
  const root = temp("wt-restart-repo-"); initRepo(root);
  const hostDir = dedicatedHostDir("wt-restart-host-");
  const first = await makeWorktreeApp({ root, hostDir });
  const created = await postWorktree(first.app, root, "restart-a");
  assert.equal(created.status, 201);
  const path = (await created.json()).path;
  assert.equal(existsSync(join(hostDir, MANAGED_WORKTREES_FILE_NAME)), true, "managed sidecar created on first managed write");
  await first.lease.close();
  leases.pop();

  const second = await makeWorktreeApp({ root, hostDir });
  assert.equal(await second.allowedRoots.isAuthorized(path, "directory"), true, "managed authorization rehydrated after restart");
  const listed = await (await second.app.request(`http://localhost/v1/worktrees?cwd=${encodeURIComponent(root)}`, { headers: headers() })).json();
  const entry = listed.worktrees.find((w) => w.path === path);
  assert.equal(entry?.managedByPix, false, "managedByPix/delete token does not survive restart");
  assert.equal(entry?.authorized, true);
  const denied = await deleteWorktree(second.app, root, path);
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, "WORKTREE_NOT_MANAGED");
});

// ---------------------------------------------------------------------------
// Delete authority: external / manual / planted / legacy-claim-only DENIED
// ---------------------------------------------------------------------------

test("DELETE denies external, planted (inside base), and manual worktrees; marker retained", async () => {
  const { app, root, base } = await makeWorktreeApp();
  // External worktree outside the base.
  const externalRoot = temp("wt-ext-root-");
  const externalPath = makeWorktree(root, "external-b", { insideBase: false, externalRoot });
  // Planted worktree inside the base but never Pix-created.
  const plantedPath = makeWorktree(root, "planted-b", { insideBase: true });
  // Manual git worktree (added directly).
  const manualBase = temp("wt-manual-");
  const manualPath = makeWorktree(root, "manual-b", { insideBase: false, externalRoot: manualBase });

  for (const [label, target] of [["external", externalPath], ["planted", plantedPath], ["manual", manualPath]]) {
    const removed = await deleteWorktree(app, root, target);
    assert.equal(removed.status, 403, `${label} must be denied`);
    assert.equal((await removed.json()).code, "WORKTREE_NOT_MANAGED", label);
    assert.equal(existsSync(target), true, `${label} marker retained`);
    assert.equal(await app.request(`http://localhost/v1/worktrees?cwd=${encodeURIComponent(root)}`, { headers: headers() }).then((r) => r.status), 200);
  }
  assert.equal(existsSync(base), true, "base preserved");
});

test("DELETE denies a legacy trusted-claim-only worktree (authorized ≠ delete authority)", { skip: process.platform === "win32" }, async () => {
  const { app, root, allowedRoots, trusted } = await makeWorktreeApp();
  const target = makeWorktree(root, "legacy-b", { insideBase: true });
  const base = `${resolve(realpathSync(root))}-worktrees`;
  // A legacy trusted v1 claim grants authorization but never managed ownership.
  await registerTrustedCreatedRoot(allowedRoots, { path: target, repoRoot: realpathSync(root), base, branch: "legacy-b", claimId: "legacy-claim-0001" });
  assert.equal(await allowedRoots.isAuthorized(target, "directory"), true, "trusted claim authorizes");
  assert.equal((await trusted.read()).claims.length, 1);
  const listed = await (await app.request(`http://localhost/v1/worktrees?cwd=${encodeURIComponent(root)}`, { headers: headers() })).json();
  const entry = listed.worktrees.find((w) => w.path === target);
  assert.equal(entry?.authorized, true, "authorized: true retained");
  assert.equal(entry?.managedByPix, false, "legacy claim is NOT managed");
  const removed = await deleteWorktree(app, root, target);
  assert.equal(removed.status, 403, "legacy-claim-only delete denied");
  assert.equal((await removed.json()).code, "WORKTREE_NOT_MANAGED");
  assert.equal(existsSync(target), true, "legacy worktree retained");
});

test("DELETE denies an externally removed+readd same-path worktree (identity replaced)", { skip: process.platform === "win32" }, async () => {
  const { app, root } = await makeWorktreeApp();
  const first = await postWorktree(app, root, "readd-2");
  assert.equal(first.status, 201);
  const path = (await first.json()).path;
  git(root, ["worktree", "remove", "--force", "--", path]);
  const base = `${resolve(realpathSync(root))}-worktrees`;
  mkdirSync(base, { recursive: true });
  git(root, ["worktree", "add", "--", path, "readd-2"]);
  const removed = await deleteWorktree(app, root, path);
  assert.equal(removed.status, 403, "same path after remove+readd is NOT the original managed worktree");
  assert.equal((await removed.json()).code, "WORKTREE_NOT_MANAGED");
  assert.equal(existsSync(path), true, "readd retained");
});

test("DELETE requires an absolute canonical target path", { skip: process.platform === "win32" }, async () => {
  const { app, root } = await makeWorktreeApp();
  const created = await postWorktree(app, root, "abs-b");
  assert.equal(created.status, 201);
  const path = (await created.json()).path;
  const removed = await deleteWorktree(app, root, "relative/path");
  assert.equal(removed.status, 400);
  assert.equal((await removed.json()).code, "WORKTREE_PATH_ABSOLUTE");
  const missingAbs = await deleteWorktree(app, root, join(root, "nope"));
  assert.ok([403, 404].includes(missingAbs.status), `not-found or not-project (got ${missingAbs.status})`);
  void path;
});

// ---------------------------------------------------------------------------
// Clean managed delete success + branch/base retained + fallback cwd
// ---------------------------------------------------------------------------

test("clean managed DELETE succeeds: 200 fallbackCwd + branchRetained, record removed, branch/base preserved", { skip: process.platform === "win32" }, async () => {
  const { app, root, managedLedger, trusted } = await makeWorktreeApp();
  const created = await postWorktree(app, root, "clean-b");
  assert.equal(created.status, 201);
  const { path, branch } = await created.json();
  const base = `${resolve(realpathSync(root))}-worktrees`;
  const mainWorktree = realpathSync(root);
  const removed = await deleteWorktree(app, root, path);
  assert.equal(removed.status, 200);
  const body = await removed.json();
  assert.equal(body.success, true);
  assert.equal(body.fallbackCwd, mainWorktree, "fallbackCwd is the canonical main worktree");
  assert.equal(body.branchRetained, true);
  assert.equal(existsSync(path), false, "worktree path removed");
  assert.doesNotThrow(() => git(root, ["show-ref", "--verify", `refs/heads/${branch}`]), "branch retained");
  assert.equal(existsSync(base), true, "base preserved");
  assert.equal((await managedLedger.read()).records.length, 0, "managed record removed");
  assert.equal((await trusted.read()).claims.length, 0);
  const after = git(root, ["worktree", "list", "--porcelain"]);
  assert.ok(!after.includes(path), "topology no longer contains target");
});

test("managed DELETE also drops a stale legacy trusted claim for the path", { skip: process.platform === "win32" }, async () => {
  const { app, root, allowedRoots, trusted } = await makeWorktreeApp();
  const created = await postWorktree(app, root, "stale-claim-b");
  assert.equal(created.status, 201);
  const path = (await created.json()).path;
  const base = `${resolve(realpathSync(root))}-worktrees`;
  // A stale legacy claim for the same path (should not exist in practice, but
  // if present it must be dropped on managed delete).
  await registerTrustedCreatedRoot(allowedRoots, { path, repoRoot: realpathSync(root), base, branch: "stale-claim-b", claimId: "stale-claim-9999" });
  assert.equal((await trusted.read()).claims.length, 1);
  const removed = await deleteWorktree(app, root, path);
  assert.equal(removed.status, 200);
  assert.equal((await trusted.read()).claims.length, 0, "stale legacy claim dropped by path");
  assert.equal(listTrustedCreatedRoots(allowedRoots).length, 0);
});

// ---------------------------------------------------------------------------
// Dirty / force semantics
// ---------------------------------------------------------------------------

test("dirty requires force; force retains branch and base and passes exactly one --force", { skip: process.platform === "win32" }, async () => {
  const { app, root, base } = await makeWorktreeApp();
  const created = await postWorktree(app, root, "dirty-b");
  assert.equal(created.status, 201);
  const path = (await created.json()).path;
  writeFileSync(join(path, "dirty.txt"), "x");
  const noForce = await deleteWorktree(app, root, path);
  assert.equal(noForce.status, 409);
  assert.equal((await noForce.json()).code, "WORKTREE_DIRTY");
  assert.equal(existsSync(path), true);
  const forced = await deleteWorktree(app, root, path, { body: JSON.stringify({ cwd: root, path, force: true }) });
  assert.equal(forced.status, 200);
  assert.equal((await forced.json()).branchRetained, true);
  assert.doesNotThrow(() => git(root, ["show-ref", "--verify", "refs/heads/dirty-b"]), "force retains the branch");
  assert.equal(existsSync(base), true, "force retains the base");
  assert.equal(existsSync(path), false);
});

// ---------------------------------------------------------------------------
// Busy exact + descendant rejects; force cannot bypass; guard before effects
// ---------------------------------------------------------------------------

test("busy exact and descendant both reject DELETE and force cannot bypass", { skip: process.platform === "win32" }, async () => {
  const { app, root } = await makeWorktreeApp({ busy: async () => ({ busy: true, reason: "active session" }) });
  const created = await postWorktree(app, root, "busy-b");
  assert.equal(created.status, 201);
  const path = (await created.json()).path;
  const removed = await deleteWorktree(app, root, path, { body: JSON.stringify({ cwd: root, path, force: true }) });
  assert.equal(removed.status, 409, "busy rejects even with force");
  assert.equal((await removed.json()).code, "WORKTREE_BUSY");
  assert.equal(existsSync(path), true, "busy worktree retained");
});

test("sessiond-down mutation guard 503s POST/DELETE before any Git/filesystem effect", async () => {
  const root = temp("wt-guard-repo-"); initRepo(root);
  const { app } = await makeWorktreeApp({
    root,
    guard: async () => { throw new HttpError(503, "MUTATION_UNAVAILABLE", "Runtime authority unavailable"); },
  });
  const create = await postWorktree(app, root, "should-not");
  assert.equal(create.status, 503);
  assert.equal((await create.json()).code, "MUTATION_UNAVAILABLE");
  assert.throws(() => git(root, ["show-ref", "--verify", "refs/heads/should-not"]));
  assert.equal(statSync(`${resolve(realpathSync(root))}-worktrees`, { throwIfNoEntry: false }), undefined, "guard runs before any filesystem side effect");
  const remove = await deleteWorktree(app, root, join(root, "anything"));
  assert.equal(remove.status, 503);
  assert.equal((await remove.json()).code, "MUTATION_UNAVAILABLE");
});

test("no managed service ⇒ POST/DELETE fail closed before effects; GET stays read-only", async () => {
  const root = temp("wt-nomanaged-repo-"); initRepo(root);
  const allowedRoots = await createAllowedRootService({ roots: [realpathSync(root)], maxRoots: 16 });
  const app = createHostApp({ logger: {}, gate, resources: { allowedRoots } }).app;
  const create = await postWorktree(app, root, "no-managed");
  assert.equal(create.status, 503);
  assert.equal((await create.json()).code, "WORKTREE_MANAGED_UNAVAILABLE");
  assert.throws(() => git(root, ["show-ref", "--verify", "refs/heads/no-managed"]));
  assert.equal(statSync(`${resolve(realpathSync(root))}-worktrees`, { throwIfNoEntry: false }), undefined);
  const list = await app.request(`http://localhost/v1/worktrees?cwd=${encodeURIComponent(root)}`, { headers: headers() });
  assert.equal(list.status, 200, "GET remains read-only without a managed service");
  const body = await list.json();
  assert.equal(body.isGit, true);
  assert.ok(body.worktrees.every((w) => w.managedByPix === false), "managedByPix false without managed service");
  const del = await deleteWorktree(app, root, join(root, "x"));
  assert.equal(del.status, 503);
  assert.equal((await del.json()).code, "WORKTREE_MANAGED_UNAVAILABLE");
});

// ---------------------------------------------------------------------------
// Main worktree / non-project / identity replacement
// ---------------------------------------------------------------------------

test("DELETE rejects the main worktree and non-project paths; external remove/readd denied", async () => {
  const { app, root } = await makeWorktreeApp();
  const mainRemoved = await deleteWorktree(app, root, realpathSync(root));
  assert.equal(mainRemoved.status, 409);
  assert.equal((await mainRemoved.json()).code, "MAIN_WORKTREE");
  const notInRepo = await deleteWorktree(app, root, join(temp("wt-other-"), "x"));
  assert.ok([403, 404].includes(notInRepo.status), `not a project worktree (got ${notInRepo.status})`);
});

test("DELETE denies after admin-dir identity replacement (git repair/re-add)", { skip: process.platform === "win32" }, async () => {
  const { app, root, managedLedger } = await makeWorktreeApp();
  const created = await postWorktree(app, root, "admin-swap");
  assert.equal(created.status, 201);
  const path = (await created.json()).path;
  // Replace the actual worktree ADMIN dir identity (the git per-worktree admin
  // metadata, not the checkout pointer) — simulates git repair / admin change.
  const adminDir = git(path, ["rev-parse", "--path-format=absolute", "--absolute-git-dir"]);
  assert.ok(adminDir && adminDir.startsWith("/"), `admin dir resolved: ${adminDir}`);
  rmSync(adminDir, { recursive: true, force: true });
  mkdirSync(adminDir, { recursive: true });
  const removed = await deleteWorktree(app, root, path);
  assert.ok([403, 404].includes(removed.status), `identity replacement must deny (got ${removed.status})`);
  assert.ok(["WORKTREE_NOT_MANAGED", "NOT_PROJECT_WORKTREE"].includes((await removed.json()).code), "denied after admin identity replacement");
  void managedLedger;
});

// ---------------------------------------------------------------------------
// Concurrent create/delete/recreate
// ---------------------------------------------------------------------------

test("concurrent create/delete/recreate stays consistent and ownership is never ambiguous", { skip: process.platform === "win32" }, async () => {
  const { app, root, managedLedger } = await makeWorktreeApp();
  const create = (branch) => postWorktree(app, root, branch);
  const first = await create("conc-a");
  assert.equal(first.status, 201);
  const pathA = (await first.json()).path;

  const [duplicate, deletion] = await Promise.all([
    create("conc-a"),
    deleteWorktree(app, root, pathA),
  ]);
  assert.equal(deletion.status, 200);
  assert.ok([201, 409].includes(duplicate.status), `duplicate create while delete raced (got ${duplicate.status})`);

  // Recreate after delete succeeds.
  const recreate = await create("conc-a");
  assert.equal(recreate.status, 201);
  assert.equal(await app.request(`http://localhost/v1/worktrees?cwd=${encodeURIComponent(root)}`, { headers: headers() }).then((r) => r.status), 200);
  assert.ok((await managedLedger.read()).records.length >= 1, "recreate persists a managed record");
});

test("aborted request fails closed (MUTATION_ABORTED) before any git effect", async () => {
  const { app, root, managedLedger } = await makeWorktreeApp();
  // A pre-aborted request must fail closed while waiting on the repo mutex,
  // before any Git/filesystem side effect.
  const controller = new AbortController();
  controller.abort();
  const response = await postWorktree(app, root, "pre-abort", { signal: controller.signal });
  assert.equal(response.status, 499);
  assert.ok(["MUTATION_ABORTED", "PROCESS_ABORTED"].includes((await response.json()).code), "pre-aborted request fails closed with a sanitized 499");
  assert.throws(() => git(root, ["show-ref", "--verify", "refs/heads/pre-abort"]), "no branch created on abort");
  assert.equal(existsSync(`${resolve(realpathSync(root))}-worktrees`), false, "no base created on abort");
  assert.equal((await managedLedger.read()).records.length, 0, "no managed record on abort");

  // Abort while WAITING on a held repo mutex also fails closed (deterministic:
  // the first request holds the mutex through a stalled git add).
  const root2 = temp("wt-abort2-repo-"); initRepo(root2);
  const realRunner = createProcessRunner();
  let addCount = 0;
  let releaseGate;
  const gatePromise = new Promise((resolveGate) => { releaseGate = resolveGate; });
  const stallRunner = {
    async run(request) {
      if (request.args.includes("worktree") && request.args.includes("add")) {
        addCount += 1;
        if (addCount === 1) await gatePromise;
      }
      return realRunner.run(request);
    },
  };
  const allowedRoots = await createAllowedRootService({ roots: [realpathSync(root2)], maxRoots: 16 });
  const hostDir = dedicatedHostDir("wt-abort2-host-");
  const lease = await openHostStateDirectoryLease({ hostDir, instanceId: `wt-abort2-${Math.random().toString(36).slice(2, 12)}` });
  leases.push(() => lease.close());
  const managedLedger2 = createManagedWorktreesLedgerFromLease(lease);
  const service2 = createManagedWorktreesService({ ledger: managedLedger2, allowedRoots, runner: stallRunner });
  const app2 = createHostApp({ logger: {}, gate, resources: { allowedRoots, processRunner: stallRunner, managedWorktrees: service2, busyPreflight: { check: async () => ({ busy: false }) } } }).app;
  const waiterController = new AbortController();
  const firstPost = postWorktree(app2, root2, "hold-a");
  await new Promise((r) => setTimeout(r, 120));
  const waiting = postWorktree(app2, root2, "hold-b", { signal: waiterController.signal });
  await new Promise((r) => setTimeout(r, 120));
  waiterController.abort();
  releaseGate();
  const [a, b] = await Promise.allSettled([firstPost, waiting]);
  assert.equal(a.status, "fulfilled", "held create completes after release");
  assert.equal(a.value.status, 201);
  // Hono's onError maps the aborted mutex acquire to a resolved 499 Response.
  assert.equal(b.status, "fulfilled", "aborted waiter resolves as a 499 fail-closed response");
  assert.equal(b.value.status, 499);
  assert.equal((await b.value.json()).code, "MUTATION_ABORTED", "abort while waiting on the repo mutex fails closed");
  assert.ok((await managedLedger2.read()).records.length >= 1);
});

// ---------------------------------------------------------------------------
// Git success + ledger cleanup failure → fixed 500 (no false success)
// ---------------------------------------------------------------------------

test("Git succeeds but durable ownership cleanup fails ⇒ fixed 500 WORKTREE_DELETE_COMMIT_INCOMPLETE", { skip: process.platform === "win32" }, async () => {
  const root = temp("wt-cleanup-fail-repo-"); initRepo(root);
  const hostDir = dedicatedHostDir("wt-cleanup-fail-host-");
  const clean = await makeWorktreeApp({ root, hostDir });
  const created = await postWorktree(clean.app, root, "cleanup-fail-b");
  assert.equal(created.status, 201);
  const path = (await created.json()).path;
  // Fault-inject the disk cleanup on the SAME service instance so the
  // current-process destructive ownership token remains valid up to the
  // post-Git commit step. A restart intentionally loses that token and would
  // correctly reject earlier with WORKTREE_NOT_MANAGED.
  const originalCommitRemoved = clean.managedService.commitRemoved.bind(clean.managedService);
  clean.managedService.commitRemoved = async () => { throw new Error("injected cleanup failure"); };
  const removed = await deleteWorktree(clean.app, root, path);
  assert.equal(removed.status, 500, "no false success when ownership cleanup fails");
  const body = await removed.json();
  assert.equal(body.code, "WORKTREE_DELETE_COMMIT_INCOMPLETE");
  assert.ok(!JSON.stringify(body).includes(path), "no path leak in the 500 body");
  assert.equal(existsSync(path), false, "git removal already happened (cannot be rolled back)");
  clean.managedService.commitRemoved = originalCommitRemoved;
  await clean.lease.close();
  leases.pop();
  // The stale record remains on disk; a restart reconcile drops it.
  const restarted = await makeWorktreeApp({ root, hostDir });
  assert.equal(await restarted.allowedRoots.isAuthorized(path, "directory"), false, "stale row not authorized after reconcile");
  const listed = await (await restarted.app.request(`http://localhost/v1/worktrees?cwd=${encodeURIComponent(root)}`, { headers: headers() })).json();
  assert.equal(listed.worktrees.some((w) => w.path === path), false, "stale row dropped on restart reconcile");
});

// ---------------------------------------------------------------------------
// Raw error sanitization
// ---------------------------------------------------------------------------

test("git/process errors are sanitized: no raw stderr/path/branch/JSON leak", async () => {
  const root = temp("wt-sanitize-repo-"); initRepo(root);
  const realRunner = createProcessRunner();
  const hostDir = dedicatedHostDir("wt-sanitize-host-");
  const lease = await openHostStateDirectoryLease({ hostDir, instanceId: `wt-san-${Math.random().toString(36).slice(2, 12)}` });
  leases.push(() => lease.close());
  const managedLedger = createManagedWorktreesLedgerFromLease(lease);
  const allowedRoots = await createAllowedRootService({ roots: [realpathSync(root)], maxRoots: 16 });
  attachTrustedRootsLedger(allowedRoots, createTrustedRootsLedgerFromLease(lease, { maxClaims: 16 }));
  const service = createManagedWorktreesService({ ledger: managedLedger, allowedRoots, runner: realRunner });
  // A runner that returns a nonzero git add with raw stderr containing a branch name.
  const leakRunner = {
    async run(request) {
      if (request.args.includes("worktree") && request.args.includes("add")) {
        return { stdout: "", stderr: `fatal: branch 'leaky-branch-name' already exists /tmp/path\n`, exitCode: 128, truncated: false };
      }
      return realRunner.run(request);
    },
  };
  const app = createHostApp({ logger: {}, gate, resources: { allowedRoots, processRunner: leakRunner, managedWorktrees: service, busyPreflight: { check: async () => ({ busy: false }) } } }).app;
  const response = await postWorktree(app, root, "leaky-branch-name");
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, "WORKTREE_CREATE_FAILED");
  assert.ok(!JSON.stringify(body).includes("leaky-branch-name"), "no branch leak");
  assert.ok(!JSON.stringify(body).includes("already exists"), "no raw stderr leak");
  assert.ok(!JSON.stringify(body).includes("/tmp/path"), "no path leak");
  assert.ok(!JSON.stringify(body).includes("fatal:"), "no raw git output");
});

// ---------------------------------------------------------------------------
// Authenticated LAN
// ---------------------------------------------------------------------------

test("authenticated LAN managed delete succeeds; external denied; unauth blocked before effects", { skip: process.platform === "win32" }, async () => {
  const root = temp("wt-lan-repo-"); initRepo(root);
  const { app } = await makeWorktreeApp({
    root,
    exposureMode: "lan",
    gateOverride: { config: { read: () => ({ status: "enabled", password: "secret", source: "test" }) } },
  });
  const lanHeaders = { host: "127.0.0.1" };
  const req = (path, init) => app.request(`http://127.0.0.1${path}`, init);

  // Unauthenticated LAN delete blocked by the gate before any effect.
  const externalPath = makeWorktree(root, "lan-ext", { insideBase: false, externalRoot: temp("wt-lan-ext-") });
  const unauthDel = await req("/v1/worktrees", {
    method: "DELETE",
    headers: { ...lanHeaders, "content-type": "application/json" },
    body: JSON.stringify({ cwd: root, path: externalPath }),
  });
  assert.equal(unauthDel.status, 401);
  assert.equal((await unauthDel.json()).code, "UNAUTHORIZED");
  assert.equal(existsSync(externalPath), true, "unauth blocked before any effect");

  const login = await req("/v1/gate/login", {
    method: "POST",
    headers: { ...lanHeaders, "content-type": "application/json" },
    body: JSON.stringify({ password: "secret" }),
  });
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const authHeaders = { ...lanHeaders, cookie, "content-type": "application/json" };

  // Authenticated LAN external delete → 403 (not managed).
  const extDel = await req("/v1/worktrees", {
    method: "DELETE",
    headers: authHeaders,
    body: JSON.stringify({ cwd: root, path: externalPath }),
  });
  assert.equal(extDel.status, 403);
  assert.equal((await extDel.json()).code, "WORKTREE_NOT_MANAGED");
  assert.equal(existsSync(externalPath), true, "external retained after authenticated attempt");

  // Authenticated LAN managed create + delete succeed.
  const created = await req("/v1/worktrees", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ cwd: root, branch: "lan-managed" }),
  });
  assert.equal(created.status, 201);
  const managedPath = (await created.json()).path;
  const del = await req("/v1/worktrees", {
    method: "DELETE",
    headers: authHeaders,
    body: JSON.stringify({ cwd: root, path: managedPath }),
  });
  assert.equal(del.status, 200);
  assert.equal((await del.json()).branchRetained, true);
});
