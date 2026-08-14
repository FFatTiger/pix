import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { mkdtempSync, mkdirSync, lstatSync, readdirSync, renameSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAllowedRootService, createHostApp } from "../dist/index.js";
import { setUploadFaultHooks } from "../dist/routes/files.js";

const temporary = [];
const gate = { config: { read: () => ({ status: "disabled", source: "test" }) } };
function temp(prefix) { const value = mkdtempSync(join(tmpdir(), prefix)); temporary.push(value); return value; }
afterEach(() => {
  setUploadFaultHooks(null);
  while (temporary.length) rmSync(temporary.pop(), { recursive: true, force: true });
});

async function fixture(options = {}) {
  const root = temp("pi-upload-txn-");
  const allowedRoots = await createAllowedRootService({ roots: [root], ...options.policy });
  const host = createHostApp({ logger: {}, gate, exposureMode: options.exposureMode ?? "local", resources: { allowedRoots, ...options.resources } });
  return { root, allowedRoots, host, app: host.app };
}
function deferred() { let resolve; let reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }
function headers(extra = {}) { return { host: "localhost", ...extra }; }
function upload(app, root, files, conflict = "error", signal) {
  const form = new FormData();
  for (const [name, value] of files) form.append("files", new File([value], name));
  return app.request(`http://localhost/v1/files?path=${encodeURIComponent(root)}&conflict=${conflict}`, { method: "POST", headers: headers(), body: form, ...(signal ? { signal } : {}) });
}
function assertNoUploadArtifacts(dir) {
  const leftovers = readdirSync(dir).filter((entry) => entry.startsWith(".pix-upload-"));
  assert.deepEqual(leftovers, [], `no temp/backup leftovers in ${dir}`);
}

test("transactional upload rolls back a created file when a later commit fails", async () => {
  const { root, app } = await fixture();
  setUploadFaultHooks({ beforeCommit: async (index) => { if (index === 1) throw new Error("simulated commit failure"); } });
  const res = await upload(app, root, [["a.txt", "aaa"], ["b.txt", "bbb"]], "error");
  assert.equal(res.status, 500);
  assert.throws(() => readFileSync(join(root, "a.txt")), (e) => e.code === "ENOENT", "first file removed on rollback");
  assert.throws(() => readFileSync(join(root, "b.txt")), (e) => e.code === "ENOENT", "failing file never committed");
  assertNoUploadArtifacts(root);
});

test("transactional upload restores an overwritten original when a later commit fails", async () => {
  const { root, app } = await fixture();
  const original = Buffer.concat([Buffer.from("héllo—wörld ✓", "utf8"), Buffer.from([0x00, 0xff, 0x80, 0xc3, 0x28, 0x00])]);
  writeFileSync(join(root, "x.bin"), original);
  setUploadFaultHooks({ beforeCommit: async (index) => { if (index === 1) throw new Error("simulated commit failure"); } });
  const res = await upload(app, root, [["x.bin", "new content"], ["y.txt", "yyy"]], "overwrite");
  assert.equal(res.status, 500);
  assert.deepEqual([...readFileSync(join(root, "x.bin"))], [...original], "original restored byte-exactly");
  assert.throws(() => readFileSync(join(root, "y.txt")), (e) => e.code === "ENOENT");
  assertNoUploadArtifacts(root);
});

test("transactional upload rolls back mixed create/overwrite and leaves skip entries untouched", async () => {
  // Overwrite-mode batch on an independent root: existing (overwrite), new
  // (create), then a failure -> overwritten restored, created removed.
  const overRoot = temp("pi-upload-txn-mixover-");
  const overRoots = await createAllowedRootService({ roots: [overRoot] });
  const overApp = createHostApp({ logger: {}, gate, resources: { allowedRoots: overRoots } }).app;
  writeFileSync(join(overRoot, "over.txt"), "orig-over");
  setUploadFaultHooks({ beforeCommit: async (index, name) => { if (name === "fail.txt") throw new Error("simulated commit failure"); } });
  let res = await upload(overApp, overRoot, [["over.txt", "overwritten"], ["new.txt", "new"], ["fail.txt", "fail"]], "overwrite");
  assert.equal(res.status, 500);
  assert.equal(readFileSync(join(overRoot, "over.txt"), "utf8"), "orig-over", "overwritten file restored");
  assert.throws(() => readFileSync(join(overRoot, "new.txt")), (e) => e.code === "ENOENT", "created file removed");
  assert.throws(() => readFileSync(join(overRoot, "fail.txt")), (e) => e.code === "ENOENT");
  assertNoUploadArtifacts(overRoot);

  // Skip-mode batch on an independent root: existing (skip), new (create),
  // then a failure. The skipped entry is untouched and is NOT part of rollback.
  const skipRoot = temp("pi-upload-txn-mixskip-");
  const skipRoots = await createAllowedRootService({ roots: [skipRoot] });
  const skipApp = createHostApp({ logger: {}, gate, resources: { allowedRoots: skipRoots } }).app;
  writeFileSync(join(skipRoot, "skip.txt"), "orig-skip");
  res = await upload(skipApp, skipRoot, [["skip.txt", "skip-me"], ["made.txt", "made"], ["fail.txt", "fail"]], "skip");
  assert.equal(res.status, 500);
  assert.equal(readFileSync(join(skipRoot, "skip.txt"), "utf8"), "orig-skip", "skipped file untouched");
  assert.throws(() => readFileSync(join(skipRoot, "made.txt")), (e) => e.code === "ENOENT", "created file removed on rollback");
  assert.throws(() => readFileSync(join(skipRoot, "fail.txt")), (e) => e.code === "ENOENT");
  assertNoUploadArtifacts(skipRoot);
});

test("staging failure commits nothing and cleans every temp", async () => {
  const { root, app } = await fixture();
  writeFileSync(join(root, "existing.txt"), "orig");
  setUploadFaultHooks({ beforeStage: async (index) => { if (index === 1) throw new Error("simulated staging failure"); } });
  const res = await upload(app, root, [["a.txt", "aaa"], ["b.txt", "bbb"]], "error");
  assert.equal(res.status, 500);
  assert.throws(() => readFileSync(join(root, "a.txt")), (e) => e.code === "ENOENT", "no final mutation on staging failure");
  assert.throws(() => readFileSync(join(root, "b.txt")), (e) => e.code === "ENOENT");
  assert.equal(readFileSync(join(root, "existing.txt"), "utf8"), "orig");
  assertNoUploadArtifacts(root);
});

test("duplicate upload names are rejected during preflight with no writes", async () => {
  const { root, app } = await fixture();
  const res = await upload(app, root, [["a.txt", "aaa"], ["a.txt", "bbb"]], "error");
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "DUPLICATE_FILE");
  assert.throws(() => readFileSync(join(root, "a.txt")), (e) => e.code === "ENOENT");
  assertNoUploadArtifacts(root);
});

test("a target swapped to a symlink between preflight and commit is refused, never followed", async () => {
  const { root, app } = await fixture();
  const outside = temp("pi-upload-txn-outside-");
  writeFileSync(join(outside, "secret"), "SECRET");
  writeFileSync(join(root, "x.txt"), "orig");
  setUploadFaultHooks({ beforeCommit: async (index, name) => {
    if (index === 0 && name === "x.txt") { rmSync(join(root, "x.txt")); symlinkSync(join(outside, "secret"), join(root, "x.txt")); }
  } });
  const res = await upload(app, root, [["x.txt", "new"], ["y.txt", "yyy"]], "overwrite");
  assert.equal(res.status, 409);
  assert.equal(readFileSync(join(outside, "secret"), "utf8"), "SECRET", "never written through the swapped symlink");
  assert.equal(lstatSync(join(root, "x.txt")).isSymbolicLink(), true, "changed target refused, not replaced");
  assert.throws(() => readFileSync(join(root, "y.txt")), (e) => e.code === "ENOENT");
  assertNoUploadArtifacts(root);
});

test("upload refuses root/directory replacement between preflight and commit", async () => {
  // Allowed-root replacement -> existing ROOT_REPLACED semantics.
  const root = temp("pi-upload-txn-root-");
  const movedRoot = `${root}-old`; temporary.push(movedRoot);
  const roots = await createAllowedRootService({ roots: [root] });
  const app = createHostApp({ logger: {}, gate, resources: { allowedRoots: roots } }).app;
  setUploadFaultHooks({ beforeCommit: async () => { renameSync(root, movedRoot); mkdirSync(root); } });
  let res = await upload(app, root, [["a.txt", "aaa"]], "error");
  assert.equal(res.status, 403);
  assert.equal(readdirSync(root).length, 0, "replacement root untouched");
  assertNoUploadArtifacts(root);

  // Non-root directory replacement -> directory-identity re-check.
  const parentRoot = temp("pi-upload-txn-parent-");
  const sub = join(parentRoot, "sub"); mkdirSync(sub);
  const movedSub = `${sub}-old`; temporary.push(movedSub);
  const roots2 = await createAllowedRootService({ roots: [parentRoot] });
  const app2 = createHostApp({ logger: {}, gate, resources: { allowedRoots: roots2 } }).app;
  setUploadFaultHooks({ beforeCommit: async () => { renameSync(sub, movedSub); mkdirSync(sub); } });
  res = await upload(app2, sub, [["a.txt", "aaa"]], "error");
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "DIRECTORY_REPLACED");
  assert.equal(readdirSync(sub).length, 0, "replacement directory untouched");
  assertNoUploadArtifacts(sub);
});

test("concurrent same-directory uploads serialize commits; unrelated directories proceed", async () => {
  const { root, app } = await fixture();
  const other = temp("pi-upload-txn-other-");
  const otherRoots = await createAllowedRootService({ roots: [root, other] });
  const app2 = createHostApp({ logger: {}, gate, resources: { allowedRoots: otherRoots } }).app;
  const entered = deferred(); const release = deferred();
  const blocked = { first: false, second: false, other: false };
  setUploadFaultHooks({ beforeCommit: async (index, name) => {
    if (name === "a.txt") { blocked.first = true; entered.resolve(); await release.promise; }
    else if (name === "c.txt") blocked.second = true;
    else if (name === "u.txt") blocked.other = true;
  } });
  const first = upload(app, root, [["a.txt", "aaa"], ["b.txt", "bbb"]], "error");
  await entered.promise; // first is inside its commit for the root directory
  const second = upload(app, root, [["c.txt", "ccc"], ["d.txt", "ddd"]], "error"); // same dir -> must wait on the lock
  const unrelated = upload(app2, other, [["u.txt", "uuu"]], "error"); // different dir -> must proceed
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(blocked.first, true);
  assert.equal(blocked.second, false, "same-dir second upload must not start committing while the first holds the lock");
  assert.equal(blocked.other, true, "unrelated-directory upload proceeds concurrently");
  release.resolve();
  const responses = await Promise.all([first, second, unrelated]);
  assert.deepEqual(responses.map((response) => response.status), [201, 201, 201]);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "aaa");
  assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "bbb");
  assert.equal(readFileSync(join(root, "c.txt"), "utf8"), "ccc");
  assert.equal(readFileSync(join(root, "d.txt"), "utf8"), "ddd");
  assert.equal(readFileSync(join(other, "u.txt"), "utf8"), "uuu");
  assertNoUploadArtifacts(root);
  assertNoUploadArtifacts(other);
});

test("a conflict appearing between preflight and commit (error mode) rolls back the whole batch", async () => {
  const { root, app } = await fixture();
  const entered = deferred();
  setUploadFaultHooks({ beforeCommit: async (index, name) => {
    if (index === 0 && name === "a.txt") { entered.resolve(); await new Promise((resolve) => setTimeout(resolve, 40)); }
  } });
  const resPromise = upload(app, root, [["a.txt", "aaa"], ["b.txt", "bbb"]], "error");
  await entered.promise; // a.txt is mid-commit; b.txt has already staged
  writeFileSync(join(root, "b.txt"), "external"); // conflict appears at b.txt's target
  const res = await resPromise;
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "FILE_EXISTS");
  assert.throws(() => readFileSync(join(root, "a.txt")), (e) => e.code === "ENOENT", "already-committed create rolled back");
  assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "external", "externally-created conflict preserved");
  assertNoUploadArtifacts(root);
});

test("a file appearing between preflight and commit in skip mode is skipped, not rolled back, with temp cleaned", async () => {
  const { root, app } = await fixture();
  const entered = deferred();
  setUploadFaultHooks({ beforeCommit: async (index, name) => {
    if (index === 0 && name === "a.txt") { entered.resolve(); await new Promise((resolve) => setTimeout(resolve, 40)); }
  } });
  const resPromise = upload(app, root, [["a.txt", "aaa"], ["b.txt", "bbb"]], "skip");
  await entered.promise;
  writeFileSync(join(root, "a.txt"), "external"); // appears after a.txt preflight
  const res = await resPromise;
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.deepEqual(body.uploaded, ["b.txt"]);
  assert.deepEqual(body.skipped, ["a.txt"], "mid-flight appearance is skipped");
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "external", "externally-created file untouched");
  assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "bbb");
  assertNoUploadArtifacts(root);
});

test("successful uploads leave no temp/backup artifacts and responses do not leak them", async () => {
  const { root, app } = await fixture();
  writeFileSync(join(root, "over.txt"), "orig");
  const res = await upload(app, root, [["new.txt", "new"], ["over.txt", "overwritten"]], "overwrite");
  assert.equal(res.status, 201);
  const body = await res.text();
  assert.ok(!body.includes("pix-upload"), "response must not leak temp/backup names");
  assert.ok(!body.includes(".tmp") && !body.includes(".bak"), "response must not leak temp/backup extensions");
  assert.equal(readFileSync(join(root, "over.txt"), "utf8"), "overwritten");
  assert.equal(readFileSync(join(root, "new.txt"), "utf8"), "new");
  assertNoUploadArtifacts(root);
});

test("aborting an upload cleans staged files and rolls back committed entries", async () => {
  const { root, app } = await fixture();
  writeFileSync(join(root, "x.txt"), "orig");
  const controller = new AbortController();
  const entered = deferred();
  setUploadFaultHooks({ beforeCommit: async (index) => {
    if (index === 0) { entered.resolve(); await new Promise((resolve) => setTimeout(resolve, 60)); }
  } });
  const resPromise = upload(app, root, [["x.txt", "new"], ["y.txt", "yyy"]], "overwrite", controller.signal);
  await entered.promise;
  controller.abort();
  const res = await resPromise;
  assert.equal(res.status, 499);
  assert.equal(readFileSync(join(root, "x.txt"), "utf8"), "orig", "committed overwrite rolled back on observed abort");
  assert.throws(() => readFileSync(join(root, "y.txt")), (e) => e.code === "ENOENT");
  assertNoUploadArtifacts(root);
});
