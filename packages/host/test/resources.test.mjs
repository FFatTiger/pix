import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, renameSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AsyncMutex, KeyedMutex } from "../dist/resources/mutex.js";
import { registerTrustedCreatedRoot } from "../dist/resources/allowed-roots.js";
import {
  createAllowedRootService,
  createFileWatchManager,
  createHostApp,
  createProcessRunner,
  HttpError,
  parseSingleRange,
} from "../dist/index.js";

const temporary = [];
const gate = { config: { read: () => ({ status: "disabled", source: "test" }) } };
function temp(prefix) { const value = mkdtempSync(join(tmpdir(), prefix)); temporary.push(value); return value; }
afterEach(() => { while (temporary.length) rmSync(temporary.pop(), { recursive: true, force: true }); });

async function fixture(options = {}) {
  const root = temp("pi-host-resources-");
  const allowedRoots = await createAllowedRootService({ roots: [root], allowLocalExpansion: true, ...options.policy });
  const host = createHostApp({ logger: {}, gate, exposureMode: options.exposureMode ?? "local", resources: { allowedRoots, ...options.resources } });
  return { root, allowedRoots, host, app: host.app };
}
function deferred() { let resolve; let reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }
function headers(extra = {}) { return { host: "localhost", ...extra }; }
function git(cwd, args) { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C" } }).trim(); }
function initRepo(root) {
  git(root, ["init", "-q"]); git(root, ["config", "user.email", "test@example.com"]); git(root, ["config", "user.name", "Test"]);
  writeFileSync(join(root, "tracked.txt"), "one\n"); git(root, ["add", "tracked.txt"]); git(root, ["commit", "-qm", "initial"]);
}

test("AllowedRootService canonicalizes roots and rejects final/parent symlink escapes", async () => {
  const { root, allowedRoots } = await fixture();
  const outside = temp("pi-host-outside-"); writeFileSync(join(outside, "secret.txt"), "SECRET");
  symlinkSync(join(outside, "secret.txt"), join(root, "secret-link")); symlinkSync(outside, join(root, "dir-link"), "dir");
  await assert.rejects(() => allowedRoots.authorizeExisting(join(root, "secret-link")), (e) => e.code === "PATH_FORBIDDEN");
  await assert.rejects(() => allowedRoots.authorizeExisting(join(root, "dir-link", "secret.txt")), (e) => e.code === "PATH_FORBIDDEN");
  await assert.rejects(() => allowedRoots.authorizeChild(root, "../evil"), (e) => e.code === "INVALID_FILE_NAME");
  await assert.rejects(() => allowedRoots.authorizeChild(root, "a\\b"), (e) => e.code === "INVALID_FILE_NAME");
});

test("AllowedRootService fails closed when an allowed root path is replaced", async () => {
  const { root, allowedRoots } = await fixture(); writeFileSync(join(root, "before.txt"), "ok");
  const moved = `${root}-moved`; temporary.push(moved); renameSync(root, moved); mkdirSync(root); writeFileSync(join(root, "after.txt"), "unsafe");
  await assert.rejects(() => allowedRoots.authorizeExisting(join(root, "after.txt"), "file"), (e) => e.code === "ROOT_REPLACED" || e.code === "PATH_FORBIDDEN");
});

test("AllowedRootService allows ordinary in-root mutations", async () => {
  const { root, allowedRoots } = await fixture(); const file = join(root, "mutable.txt"); writeFileSync(file, "one");
  assert.equal((await allowedRoots.authorizeExisting(file, "file")).root, await import("node:fs/promises").then(({ realpath }) => realpath(root)));
  writeFileSync(file, "two"); assert.equal((await allowedRoots.authorizeExisting(file, "file")).canonicalPath, await import("node:fs/promises").then(({ realpath }) => realpath(file)));
  rmSync(file); writeFileSync(join(root, "replacement.txt"), "three"); assert.equal((await allowedRoots.authorizeExisting(join(root, "replacement.txt"), "file")).root, await import("node:fs/promises").then(({ realpath }) => realpath(root)));
});

test("AllowedRootService fails closed for delete/recreate, symlink swap, and rename replacement", async () => {
  for (const mode of ["delete-recreate", "symlink-swap", "rename-replacement"]) {
    const root = temp(`pi-root-${mode}-`); const roots = await createAllowedRootService({ roots: [root] }); const moved = `${root}-old`; temporary.push(moved);
    if (mode === "delete-recreate") { rmSync(root, { recursive: true }); mkdirSync(root); }
    else if (mode === "symlink-swap") { renameSync(root, moved); symlinkSync(moved, root, "dir"); }
    else { renameSync(root, moved); mkdirSync(root); }
    writeFileSync(join(root, "new.txt"), "unsafe");
    await assert.rejects(() => roots.authorizeExisting(join(root, "new.txt"), "file"), (e) => e.code === "ROOT_REPLACED" || e.code === "PATH_FORBIDDEN");
  }
});

test("AllowedRoot mutation mutex serializes capacity, duplicate, parent-child and trusted ownership races", async () => {
  const configured = temp("pi-roots-concurrent-"); const a = temp("pi-root-a-"); const b = temp("pi-root-b-"); const service = await createAllowedRootService({ roots: [configured], maxRoots: 2, allowLocalExpansion: true });
  const planA = await service.prepareExpansion([a], "local"); const planB = await service.prepareExpansion([b], "local");
  const results = await Promise.allSettled([planA.commit(), planB.commit()]); assert.equal(results.filter((r) => r.status === "fulfilled").length, 1); assert.equal(service.roots().length, 2);

  const duplicate = temp("pi-root-duplicate-"); const duplicateService = await createAllowedRootService({ roots: [configured], maxRoots: 2, allowLocalExpansion: true }); const duplicates = await Promise.all([duplicateService.expandRoots([duplicate], "local"), duplicateService.expandRoots([duplicate], "local")]); assert.equal(duplicates.flatMap((r) => r.added).length, 1); assert.equal(duplicateService.roots().length, 2);

  const parent = temp("pi-root-parent-"); const child = join(parent, "child"); mkdirSync(child); const nestedService = await createAllowedRootService({ roots: [configured], maxRoots: 2, allowLocalExpansion: true }); await Promise.all([nestedService.expandRoots([parent], "local"), nestedService.expandRoots([child], "local")]); assert.equal(nestedService.roots().length, 2); assert.equal(await nestedService.isAuthorized(child, "directory"), true);

  const trusted = temp("pi-root-trusted-"); const trustedService = await createAllowedRootService({ roots: [configured], maxRoots: 2, allowLocalExpansion: true }); const [receipt] = await Promise.all([registerTrustedCreatedRoot(trustedService, trusted), trustedService.expandRoots([trusted], "local")]); await receipt.rollback(); assert.equal(await trustedService.isAuthorized(trusted, "directory"), true, "durable expansion takes ownership from rollback receipt");
});

test("AllowedRoot mutation stress never exceeds capacity and identity swap loses commit", async () => {
  const configured = temp("pi-roots-stress-"); const candidates = Array.from({ length: 20 }, (_, index) => temp(`pi-stress-${index}-`)); const service = await createAllowedRootService({ roots: [configured], maxRoots: 6, allowLocalExpansion: true });
  await Promise.allSettled(Array.from({ length: 100 }, (_, index) => service.expandRoots([candidates[index % candidates.length]], "local"))); assert.ok(service.roots().length <= 6); for (const root of service.roots()) assert.equal(await service.isAuthorized(root, "directory"), true);
  const swap = temp("pi-root-commit-swap-"); const plan = await service.prepareExpansion([swap], "local"); const moved = `${swap}-old`; temporary.push(moved); renameSync(swap, moved); mkdirSync(swap); await assert.rejects(() => plan.commit(), (e) => [409, 429].includes(e.status)); assert.ok(service.roots().length <= 6);
});

test("AllowedRoot child-first and parent-first promotion produce identical minimal coverage", async () => {
  const configured = temp("pi-promotion-configured-"); const parent = temp("pi-promotion-parent-"); const child = join(parent, "child"); mkdirSync(child);
  const childFirst = await createAllowedRootService({ roots: [configured], maxRoots: 2, allowLocalExpansion: true }); await childFirst.expandRoots([child], "local"); await childFirst.expandRoots([parent], "local");
  const parentFirst = await createAllowedRootService({ roots: [configured], maxRoots: 2, allowLocalExpansion: true }); await parentFirst.expandRoots([parent], "local"); await parentFirst.expandRoots([child], "local");
  const expectedParent = await import("node:fs/promises").then(({ realpath }) => realpath(parent)); assert.deepEqual(childFirst.roots(), parentFirst.roots()); assert.deepEqual(childFirst.roots(), [await import("node:fs/promises").then(({ realpath }) => realpath(configured)), expectedParent].sort());
});

test("AllowedRoot promotion migrates deterministic durable/trusted ownership", async () => {
  const configured = temp("pi-owner-configured-"); const parent = temp("pi-owner-parent-"); const childA = join(parent, "a"); const childB = join(parent, "b"); mkdirSync(childA); mkdirSync(childB); const parentCanonical = await import("node:fs/promises").then(({ realpath }) => realpath(parent));
  const trustedChildren = await createAllowedRootService({ roots: [configured], maxRoots: 3, allowLocalExpansion: true }); const receipts = await Promise.all([registerTrustedCreatedRoot(trustedChildren, childA), registerTrustedCreatedRoot(trustedChildren, childB)]); await trustedChildren.expandRoots([parent], "local"); await Promise.all(receipts.map((receipt) => receipt.rollback())); assert.equal(await trustedChildren.isAuthorized(parent, "directory"), true); assert.equal(trustedChildren.roots().includes(parentCanonical), true); assert.equal(trustedChildren.roots().length, 2);

  const durableChild = await createAllowedRootService({ roots: [configured], maxRoots: 3, allowLocalExpansion: true }); await durableChild.expandRoots([childA], "local"); const parentReceipt = await registerTrustedCreatedRoot(durableChild, parent); assert.equal(durableChild.roots().includes(parentCanonical), true, "trusted parent may temporarily cover durable child"); await parentReceipt.rollback(); assert.equal(await durableChild.isAuthorized(childA, "directory"), true); assert.equal(await durableChild.isAuthorized(parent, "directory"), false); assert.equal(durableChild.roots().some((root) => root.endsWith("/a")), true);
});

test("AllowedRoot promotion uses replacement capacity and passes last-slot child-first probe", async () => {
  const configured = temp("pi-last-slot-configured-"); const parent = temp("pi-last-slot-parent-"); const child = join(parent, "child"); mkdirSync(child); const service = await createAllowedRootService({ roots: [configured], maxRoots: 2, allowLocalExpansion: true }); await service.expandRoots([child], "local"); const result = await service.expandRoots([parent], "local"); assert.equal(result.paths.length, 1); assert.equal(service.roots().length, 2); assert.equal(await service.isAuthorized(parent, "directory"), true);
});

test("AllowedRoot randomized promotion stress converges to minimal coverage", async () => {
  const configured = temp("pi-random-configured-"); const parent = temp("pi-random-parent-"); const children = Array.from({ length: 5 }, (_, index) => { const path = join(parent, `c${index}`); mkdirSync(path); return path; }); const parentCanonical = await import("node:fs/promises").then(({ realpath }) => realpath(parent));
  for (let round = 0; round < 100; round += 1) {
    const service = await createAllowedRootService({ roots: [configured], maxRoots: 6, allowLocalExpansion: true }); const ordered = round % 2 === 0 ? [...children, parent] : [parent, ...children]; const tasks = ordered.map((path, index) => index % 3 === 0 ? service.expandRoots([path], "local") : service.prepareExpansion([path], "local").then((plan) => plan.commit())); await Promise.allSettled(tasks); assert.ok(service.roots().length <= 2); assert.equal(service.roots().includes(parentCanonical), true); for (const child of children) assert.equal(await service.isAuthorized(child, "directory"), true);
  }
});

test("file routes list/read/meta and ranges are bounded and correct", async () => {
  const { root, app } = await fixture(); writeFileSync(join(root, "hello.txt"), "hello world"); mkdirSync(join(root, "dir"));
  const list = await app.request(`http://localhost/v1/files?path=${encodeURIComponent(root)}`, { headers: headers() });
  assert.equal(list.status, 200); assert.deepEqual((await list.json()).entries.map((e) => e.name), ["dir", "hello.txt"]);
  const read = await app.request(`http://localhost/v1/files?op=read&path=${encodeURIComponent(join(root, "hello.txt"))}`, { headers: headers() });
  assert.equal(read.status, 200); assert.equal((await read.json()).content, "hello world");
  const range = await app.request(`http://localhost/v1/files?op=raw&path=${encodeURIComponent(join(root, "hello.txt"))}`, { headers: headers({ range: "bytes=6-10" }) });
  assert.equal(range.status, 206); assert.equal(range.headers.get("content-range"), "bytes 6-10/11"); assert.equal(await range.text(), "world");
  const suffix = await app.request(`http://localhost/v1/files?op=raw&path=${encodeURIComponent(join(root, "hello.txt"))}`, { headers: headers({ range: "bytes=-5" }) });
  assert.equal(await suffix.text(), "world");
  const invalid = await app.request(`http://localhost/v1/files?op=raw&path=${encodeURIComponent(join(root, "hello.txt"))}`, { headers: headers({ range: "bytes=99-100" }) });
  assert.equal(invalid.status, 416); assert.equal(invalid.headers.get("content-range"), "bytes */11");
  assert.deepEqual(parseSingleRange("bytes=0-0", 1), { start: 0, end: 0 }); assert.equal(parseSingleRange("bytes=0-1,3-4", 10), "invalid");
});

test("file routes reject traversal, NUL, oversized preview, and symlink content", async () => {
  const { root, app } = await fixture({ resources: { limits: { maxTextPreviewBytes: 4 } } });
  writeFileSync(join(root, "large.txt"), "12345"); const outside = temp("pi-host-secret-"); writeFileSync(join(outside, "secret"), "SECRET"); symlinkSync(join(outside, "secret"), join(root, "link"));
  for (const value of [resolve(root, "..", "outside"), `${root}\0bad`, join(root, "link")]) {
    const res = await app.request(`http://localhost/v1/files?op=read&path=${encodeURIComponent(value)}`, { headers: headers() });
    assert.ok([400, 403, 404].includes(res.status), `${value}: ${res.status}`); assert.ok(!(await res.text()).includes("SECRET"));
  }
  const large = await app.request(`http://localhost/v1/files?op=read&path=${encodeURIComponent(join(root, "large.txt"))}`, { headers: headers() }); assert.equal(large.status, 413);
});

test("uploads enforce names, size, conflicts and never follow symlink targets", async () => {
  const { root, app } = await fixture({ resources: { limits: { maxUploadFileBytes: 5, maxUploadTotalBytes: 8 } } });
  const upload = async (files, conflict = "error") => { const form = new FormData(); for (const [name, value] of files) form.append("files", new File([value], name)); return app.request(`http://localhost/v1/files?path=${encodeURIComponent(root)}&conflict=${conflict}`, { method: "POST", headers: headers(), body: form }); };
  let res = await upload([["a.txt", "abc"]]); assert.equal(res.status, 201); assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "abc");
  res = await upload([["a.txt", "new"]]); assert.equal(res.status, 409); assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "abc");
  res = await upload([["a.txt", "new"]], "skip"); assert.equal(res.status, 201); assert.deepEqual((await res.json()).skipped, ["a.txt"]);
  res = await upload([["a.txt", "new"]], "overwrite"); assert.equal(res.status, 201); assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "new");
  res = await upload([["../evil", "x"]]); assert.equal(res.status, 400);
  res = await upload([["big", "123456"]]); assert.equal(res.status, 413);
  const outside = temp("pi-upload-outside-"); const secret = join(outside, "secret"); writeFileSync(secret, "safe"); symlinkSync(secret, join(root, "linked"));
  res = await upload([["linked", "owned"]], "overwrite"); assert.equal(res.status, 409); assert.equal(readFileSync(secret, "utf8"), "safe");
});

test("cwd expansion is local-policy only and LAN cannot self-authorize", async () => {
  const root = temp("pi-root-"); const extra = temp("pi-extra-");
  const localRoots = await createAllowedRootService({ roots: [root], allowLocalExpansion: true });
  const local = createHostApp({ logger: {}, gate, resources: { allowedRoots: localRoots } }).app;
  let res = await local.request("http://localhost/v1/cwd/validate", { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ cwd: extra }) });
  assert.equal(res.status, 200); assert.ok(localRoots.roots().includes(await import("node:fs/promises").then(({ realpath }) => realpath(extra))));
  const lanRoots = await createAllowedRootService({ roots: [root], allowLocalExpansion: true });
  const lan = createHostApp({ logger: {}, gate, exposureMode: "lan", resources: { allowedRoots: lanRoots } }).app;
  res = await lan.request("http://127.0.0.1/v1/cwd/validate", { method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ cwd: extra }) });
  assert.ok([401, 403].includes(res.status)); // D-020/security policy prevents expansion before the resource service.
});

test("default cwd creation is injected, canonicalized, and fail-closed when unavailable", async () => {
  const root = temp("pi-default-root-"); const project = join(root, "project"); const cwd = join(project, "day", "f"); mkdirSync(cwd, { recursive: true }); const roots = await createAllowedRootService({ roots: [root] });
  let app = createHostApp({ logger: {}, gate, resources: { allowedRoots: roots } }).app;
  let response = await app.request("http://localhost/v1/cwd/default", { method: "POST", headers: headers() }); assert.equal(response.status, 503);
  app = createHostApp({ logger: {}, gate, resources: { allowedRoots: roots, defaultCwdFactory: { create: async () => ({ cwd, projectRoot: project }) } } }).app;
  response = await app.request("http://localhost/v1/cwd/default", { method: "POST", headers: headers() }); assert.equal(response.status, 201); const body = await response.json(); assert.equal(await roots.isAuthorized(body.cwd, "directory"), true); assert.equal(await roots.isAuthorized(body.projectRoot, "directory"), true);
});

test("default cwd atomic expansion leaves roots unchanged on missing, swap, limit, duplicate, preexisting and LAN failure", async () => {
  const base = temp("pi-default-matrix-"); const preexisting = join(base, "preexisting"); mkdirSync(preexisting); const beforeRoots = async (roots) => [...roots.roots()];
  const cases = [
    { name: "missing cwd", build: () => ({ projectRoot: temp("pi-project-"), cwd: join(base, "missing") }) },
    { name: "root limit", policy: { maxRoots: 1, allowLocalExpansion: true }, build: () => ({ projectRoot: temp("pi-project-"), cwd: temp("pi-cwd-") }) },
    { name: "duplicate path", policy: { allowLocalExpansion: true }, expect: 201, build: () => { const path = temp("pi-same-"); return { projectRoot: path, cwd: path }; } },
    { name: "preexisting project", policy: { allowLocalExpansion: true }, expect: 201, build: () => ({ projectRoot: preexisting, cwd: join(preexisting, "cwd") }), prepare: ({ cwd }) => mkdirSync(cwd) },
  ];
  for (const scenario of cases) {
    const roots = await createAllowedRootService({ roots: [base], ...scenario.policy }); const created = scenario.build(); scenario.prepare?.(created); const before = await beforeRoots(roots);
    const app = createHostApp({ logger: {}, gate, resources: { allowedRoots: roots, defaultCwdFactory: { create: async () => created } } }).app;
    const response = await app.request("http://localhost/v1/cwd/default", { method: "POST", headers: headers() }); assert.equal(response.status, scenario.expect ?? (scenario.name === "root limit" ? 429 : 404), scenario.name);
    if (!scenario.expect) assert.deepEqual(roots.roots(), before, scenario.name);
  }
  const outsideProject = temp("pi-lan-project-"); const outsideCwd = join(outsideProject, "cwd"); mkdirSync(outsideCwd); const lanRoots = await createAllowedRootService({ roots: [base], allowLocalExpansion: true }); const lanBefore = [...lanRoots.roots()];
  const lan = createHostApp({ logger: {}, exposureMode: "lan", gate: { config: { read: () => ({ status: "enabled", password: "secret", source: "test" }) } }, resources: { allowedRoots: lanRoots, defaultCwdFactory: { create: async () => ({ projectRoot: outsideProject, cwd: outsideCwd }) } } }).app;
  const login = await lan.request("http://127.0.0.1/v1/gate/login", { method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ password: "secret" }) }); const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const denied = await lan.request("http://127.0.0.1/v1/cwd/default", { method: "POST", headers: { host: "127.0.0.1", cookie } }); assert.equal(denied.status, 403); assert.deepEqual(lanRoots.roots(), lanBefore);

  const swapProject = temp("pi-swap-project-"); const swapCwd = join(swapProject, "cwd"); mkdirSync(swapCwd); const swapRoots = await createAllowedRootService({ roots: [base], allowLocalExpansion: true }); const swapBefore = [...swapRoots.roots()]; const moved = `${swapCwd}-old`; temporary.push(moved);
  const plan = await swapRoots.prepareExpansion([swapProject, swapCwd], "local"); renameSync(swapCwd, moved); mkdirSync(swapCwd);
  await assert.rejects(() => plan.commit(), (e) => e.code === "ROOT_IDENTITY_CHANGED"); assert.deepEqual(swapRoots.roots(), swapBefore);
});

test("default cwd nested project/cwd consumes one root slot", async () => {
  const configured = temp("pi-default-configured-"); const project = temp("pi-default-nested-"); const cwd = join(project, "cwd"); mkdirSync(cwd); const roots = await createAllowedRootService({ roots: [configured], maxRoots: 2, allowLocalExpansion: true });
  const app = createHostApp({ logger: {}, gate, resources: { allowedRoots: roots, defaultCwdFactory: { create: async () => ({ projectRoot: project, cwd }) } } }).app;
  const response = await app.request("http://localhost/v1/cwd/default", { method: "POST", headers: headers() }); assert.equal(response.status, 201); assert.equal(roots.roots().length, 2); assert.equal(await roots.isAuthorized(cwd, "directory"), true);
});

test("file index uses git ignore semantics and fallback walk skips symlinks", async () => {
  const { root, app } = await fixture(); initRepo(root); writeFileSync(join(root, "needle.ts"), "x"); mkdirSync(join(root, "node_modules")); writeFileSync(join(root, "node_modules", "bad.js"), "x");
  const response = await app.request(`http://localhost/v1/file-index?cwd=${encodeURIComponent(root)}&q=needle`, { headers: headers() });
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).matches, [{ path: "needle.ts", isDir: false }]);
});

test("file index fallback observes an already-aborted request and leaves no traversal state", async () => {
  const root = temp("pi-index-abort-"); mkdirSync(join(root, "sub")); writeFileSync(join(root, "sub", "a.txt"), "x"); const roots = await createAllowedRootService({ roots: [root] });
  const controller = new AbortController(); controller.abort();
  const app = createHostApp({ logger: {}, gate, resources: { allowedRoots: roots, processRunner: { run: async () => ({ stdout: "", stderr: "not git", exitCode: 1, truncated: false }) } } }).app;
  const response = await app.request(`http://localhost/v1/file-index?cwd=${encodeURIComponent(root)}`, { headers: headers(), signal: controller.signal });
  assert.equal(response.status, 499); const normal = await app.request(`http://localhost/v1/file-index?cwd=${encodeURIComponent(root)}`, { headers: headers() }); assert.equal(normal.status, 200); assert.deepEqual((await normal.json()).files, ["sub/a.txt"]);
});

test("git status/diff are repo-contained and handle untracked patches", async () => {
  const { root, app } = await fixture(); initRepo(root); writeFileSync(join(root, "tracked.txt"), "one\ntwo\n"); writeFileSync(join(root, "new.txt"), "new\n");
  const status = await app.request(`http://localhost/v1/git/status?cwd=${encodeURIComponent(root)}`, { headers: headers() }); const body = await status.json(); assert.equal(body.isGitRepository, true); assert.deepEqual(body.files.map((f) => f.status).sort(), ["modified", "untracked"]);
  const diff = await app.request(`http://localhost/v1/git/diff?cwd=${encodeURIComponent(root)}&path=${encodeURIComponent(join(root, "new.txt"))}`, { headers: headers() }); const patch = await diff.json(); assert.equal(patch.supported, true); assert.match(patch.patch, /\+new/);
  const denied = await app.request(`http://localhost/v1/git/diff?cwd=${encodeURIComponent(root)}&path=${encodeURIComponent(join(root, "..", "escape"))}`, { headers: headers() }); assert.equal(denied.status, 403);
});

test("GET worktrees is absolutely read-only for local/LAN and external worktrees stay unauthorized", async () => {
  const root = temp("pi-worktree-readonly-"); initRepo(root); const externalBase = temp("pi-worktree-external-"); const external = join(externalBase, "existing"); git(root, ["worktree", "add", "-b", "external-existing", "--", external]); const externalCanonical = await import("node:fs/promises").then(({ realpath }) => realpath(external));
  for (const exposureMode of ["local", "lan"]) {
    const roots = await createAllowedRootService({ roots: [root], maxRoots: 1 }); const before = [...roots.roots()];
    const app = createHostApp({ logger: {}, gate: exposureMode === "lan" ? { config: { read: () => ({ status: "enabled", password: "secret", source: "test" }) } } : gate, exposureMode, resources: { allowedRoots: roots } }).app;
    const requestHeaders = exposureMode === "lan" ? { host: "127.0.0.1" } : headers();
    if (exposureMode === "lan") {
      const login = await app.request("http://127.0.0.1/v1/gate/login", { method: "POST", headers: { ...requestHeaders, "content-type": "application/json" }, body: JSON.stringify({ password: "secret" }) }); requestHeaders.cookie = login.headers.get("set-cookie").split(";", 1)[0];
    }
    const response = await app.request(`http://${exposureMode === "lan" ? "127.0.0.1" : "localhost"}/v1/worktrees?cwd=${encodeURIComponent(root)}`, { headers: requestHeaders }); assert.equal(response.status, 200); const body = await response.json(); const item = body.worktrees.find((worktree) => worktree.path === externalCanonical); assert.equal(item.authorized, false);
    assert.deepEqual(roots.roots(), before); assert.equal(await roots.isAuthorized(external, "directory"), false);
    const file = join(external, "tracked.txt"); const denied = await app.request(`http://${exposureMode === "lan" ? "127.0.0.1" : "localhost"}/v1/files?op=read&path=${encodeURIComponent(file)}`, { headers: requestHeaders }); assert.equal(denied.status, 403); assert.deepEqual(roots.roots(), before);
  }
});

test("keyed mutex serializes same key, permits different keys, cleans up and releases errors", async () => {
  const keyed = new KeyedMutex(); const entered = []; const gateA = deferred(); const firstEntered = deferred();
  const first = keyed.runExclusive("repo-a", async () => { entered.push("a1"); firstEntered.resolve(); await gateA.promise; entered.push("a1-done"); });
  await firstEntered.promise;
  const second = keyed.runExclusive("repo-a", async () => { entered.push("a2"); });
  const other = keyed.runExclusive("repo-b", async () => { entered.push("b1"); });
  await other; assert.deepEqual(entered, ["a1", "b1"]); gateA.resolve(); await Promise.all([first, second]); assert.deepEqual(entered, ["a1", "b1", "a1-done", "a2"]); assert.equal(keyed.keyCount(), 0);
  await assert.rejects(() => keyed.runExclusive("repo-error", async () => { throw new Error("boom"); }), /boom/); assert.equal(keyed.keyCount(), 0);
  const mutex = new AsyncMutex(); const controller = new AbortController(); const hold = deferred(); const held = mutex.runExclusive(() => hold.promise); const waiting = mutex.runExclusive(() => undefined, controller.signal); controller.abort(); await assert.rejects(() => waiting, (e) => e.code === "MUTATION_ABORTED"); hold.resolve(); await held;
});

test("route-level repo locks serialize same repo and permit different repos concurrently", async () => {
  const rootA = temp("pi-repo-lock-a-"); const rootB = temp("pi-repo-lock-b-"); initRepo(rootA); initRepo(rootB); const roots = await createAllowedRootService({ roots: [rootA, rootB] }); const realRunner = createProcessRunner();
  const firstEntered = deferred(); const secondRepoEntered = deferred(); const releaseFirst = deferred(); let addCountA = 0;
  const rootACanonical = await import("node:fs/promises").then(({ realpath }) => realpath(rootA));
  const runner = { async run(request) {
    if (request.args.includes("worktree") && request.args.includes("add")) {
      const repo = request.args[1];
      if (repo === rootACanonical) {
        addCountA += 1;
        if (addCountA === 1) { firstEntered.resolve(); await releaseFirst.promise; }
      } else secondRepoEntered.resolve();
    }
    return realRunner.run(request);
  } };
  const app = createHostApp({ logger: {}, gate, resources: { allowedRoots: roots, processRunner: runner } }).app;
  const create = (cwd, branch) => app.request("http://localhost/v1/worktrees", { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ cwd, branch }) });
  const first = create(rootA, "lock-a1"); await firstEntered.promise;
  const sameRepo = create(rootA, "lock-a2"); const otherRepo = create(rootB, "lock-b1"); await secondRepoEntered.promise;
  assert.equal(addCountA, 1, "same-repo second add cannot enter while first holds lock"); releaseFirst.resolve();
  const responses = await Promise.all([first, sameRepo, otherRepo]); assert.deepEqual(responses.map((response) => response.status), [201, 201, 201]);
});

test("real Promise.all worktree create concurrency preserves ownership and no stale roots", async () => {
  const root = temp("pi-worktree-real-concurrent-"); initRepo(root); const roots = await createAllowedRootService({ roots: [root] }); const app = createHostApp({ logger: {}, gate, resources: { allowedRoots: roots, busyPreflight: { check: async () => ({ busy: false }) } } }).app;
  const create = (branch) => app.request("http://localhost/v1/worktrees", { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ cwd: root, branch }) });
  const same = await Promise.all([create("same-branch"), create("same-branch")]); assert.equal(same.filter((response) => response.status === 201).length, 1); const samePath = (await same.find((response) => response.status === 201).json()).path; assert.equal(statSync(samePath).isDirectory(), true); assert.equal(await roots.isAuthorized(samePath, "directory"), true); assert.equal(roots.roots().filter((entry) => entry.includes("same-branch")).length, 1);
  const different = await Promise.all([create("parallel-a"), create("parallel-b")]); assert.deepEqual(different.map((response) => response.status).sort(), [201, 201]);
  const listed = git(root, ["worktree", "list", "--porcelain"]); assert.match(listed, /same-branch/); assert.match(listed, /parallel-a/); assert.match(listed, /parallel-b/);
});

test("create/delete race is serialized and failed create cannot undo successful create", async () => {
  const root = temp("pi-worktree-create-delete-"); initRepo(root); const roots = await createAllowedRootService({ roots: [root] }); const app = createHostApp({ logger: {}, gate, resources: { allowedRoots: roots, busyPreflight: { check: async () => ({ busy: false }) } } }).app;
  const create = async (branch) => app.request("http://localhost/v1/worktrees", { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ cwd: root, branch }) });
  const created = await create("race-delete"); const target = (await created.json()).path;
  const [duplicate, deletion] = await Promise.all([
    create("race-delete"),
    app.request("http://localhost/v1/worktrees", { method: "DELETE", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ cwd: root, path: target, force: true }) }),
  ]);
  assert.ok([201, 409].includes(duplicate.status)); assert.equal(deletion.status, 200); if (duplicate.status === 201) { const replacement = (await duplicate.json()).path; assert.equal(await roots.isAuthorized(replacement, "directory"), true); assert.match(git(root, ["worktree", "list", "--porcelain"]), /race-delete/); } else { assert.equal(await roots.isAuthorized(target, "directory"), false); assert.ok(!git(root, ["worktree", "list", "--porcelain"]).includes(target)); }

  const successful = await create("successful-owner"); assert.equal(successful.status, 201); const successfulPath = (await successful.json()).path; const failed = await create("successful-owner"); assert.equal(failed.status, 409); assert.equal(statSync(successfulPath).isDirectory(), true); assert.equal(await roots.isAuthorized(successfulPath, "directory"), true);
});

test("worktree deletion fails closed without preflight and force never overrides busy", async () => {
  const root = temp("pi-worktree-repo-"); initRepo(root); const allowedRoots = await createAllowedRootService({ roots: [root] });
  const noPreflight = createHostApp({ logger: {}, gate, resources: { allowedRoots } }).app;
  const create = await noPreflight.request("http://localhost/v1/worktrees", { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ cwd: root, branch: "feature-safe" }) }); assert.equal(create.status, 201); const target = (await create.json()).path;
  let removed = await noPreflight.request("http://localhost/v1/worktrees", { method: "DELETE", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ cwd: root, path: target, force: true }) }); assert.equal(removed.status, 503);
  const busy = createHostApp({ logger: {}, gate, resources: { allowedRoots, busyPreflight: { check: async () => ({ busy: true, reason: "active" }) } } }).app;
  removed = await busy.request("http://localhost/v1/worktrees", { method: "DELETE", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ cwd: root, path: target, force: true }) }); assert.equal(removed.status, 409); assert.equal((await removed.json()).code, "WORKTREE_BUSY");
});

test("worktree dirty check requires force but clean/forced deletion succeeds", async () => {
  const root = temp("pi-worktree-dirty-"); initRepo(root); const allowedRoots = await createAllowedRootService({ roots: [root] }); const preflight = { check: async () => ({ busy: false }) };
  const app = createHostApp({ logger: {}, gate, resources: { allowedRoots, busyPreflight: preflight } }).app;
  let create = await app.request("http://localhost/v1/worktrees", { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ cwd: root, branch: "dirty-branch" }) }); const dirtyPath = (await create.json()).path; writeFileSync(join(dirtyPath, "dirty.txt"), "x");
  let remove = await app.request("http://localhost/v1/worktrees", { method: "DELETE", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ cwd: root, path: dirtyPath }) }); assert.equal(remove.status, 409); assert.equal((await remove.json()).code, "WORKTREE_DIRTY");
  remove = await app.request("http://localhost/v1/worktrees", { method: "DELETE", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ cwd: root, path: dirtyPath, force: true }) }); assert.equal(remove.status, 200);
  create = await app.request("http://localhost/v1/worktrees", { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ cwd: root, branch: "clean-branch" }) }); const cleanPath = (await create.json()).path;
  remove = await app.request("http://localhost/v1/worktrees", { method: "DELETE", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ cwd: root, path: cleanPath }) }); assert.equal(remove.status, 200);
});

test("worktree creation rejects symlink base and rolls back when root registration fails", async () => {
  const root = temp("pi-worktree-rollback-"); initRepo(root); const outside = temp("pi-worktree-outside-"); const base = `${resolve(root)}-worktrees`; symlinkSync(outside, base, "dir");
  let allowedRoots = await createAllowedRootService({ roots: [root] }); let app = createHostApp({ logger: {}, gate, resources: { allowedRoots } }).app;
  let response = await app.request("http://localhost/v1/worktrees", { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ cwd: root, branch: "unsafe-base" }) }); assert.equal(response.status, 409); assert.deepEqual(allowedRoots.roots(), [await import("node:fs/promises").then(({ realpath }) => realpath(root))]);
  rmSync(base); allowedRoots = await createAllowedRootService({ roots: [root], maxRoots: 1 }); app = createHostApp({ logger: {}, gate, resources: { allowedRoots } }).app;
  response = await app.request("http://localhost/v1/worktrees", { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ cwd: root, branch: "registration-fails" }) }); assert.equal(response.status, 429);
  assert.ok(!git(root, ["worktree", "list", "--porcelain"]).includes("registration-fails")); assert.throws(() => git(root, ["show-ref", "--verify", "refs/heads/registration-fails"])); assert.ok(!allowedRoots.roots().some((entry) => entry.includes("registration-fails")));
});

test("ambiguous nonzero add failure does not claim or delete observed resources", async () => {
  const root = temp("pi-worktree-process-fail-"); initRepo(root); const roots = await createAllowedRootService({ roots: [root] }); const realRunner = createProcessRunner();
  const runner = { async run(request) { if (request.args.includes("add")) { const actual = await realRunner.run(request); assert.equal(actual.exitCode, 0); return { stdout: actual.stdout, stderr: "simulated ambiguous failure", exitCode: 7, truncated: false }; } return realRunner.run(request); } };
  const app = createHostApp({ logger: {}, gate, resources: { allowedRoots: roots, processRunner: runner } }).app;
  const response = await app.request("http://localhost/v1/worktrees", { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ cwd: root, branch: "partial-failure" }) }); assert.equal(response.status, 400);
  assert.doesNotThrow(() => git(root, ["show-ref", "--verify", "refs/heads/partial-failure"])); assert.match(git(root, ["worktree", "list", "--porcelain"]), /partial-failure/); assert.equal(roots.roots().length, 1, "ambiguous resource is not authorized or transaction-owned");
});

test("worktree create transaction rolls back timeout/output failures and concurrent target conflict", async () => {
  for (const failure of ["PROCESS_TIMEOUT", "PROCESS_OUTPUT_LIMIT"]) {
    const root = temp(`pi-worktree-${failure}-`); initRepo(root); const roots = await createAllowedRootService({ roots: [root] }); const realRunner = createProcessRunner();
    const runner = { async run(request) { if (request.args.includes("add")) throw new HttpError(failure === "PROCESS_TIMEOUT" ? 504 : 413, failure, failure); return realRunner.run(request); } };
    const app = createHostApp({ logger: {}, gate, resources: { allowedRoots: roots, processRunner: runner } }).app;
    const response = await app.request("http://localhost/v1/worktrees", { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ cwd: root, branch: failure.toLowerCase() }) }); assert.equal(response.status, failure === "PROCESS_TIMEOUT" ? 504 : 413);
    assert.throws(() => git(root, ["show-ref", "--verify", `refs/heads/${failure.toLowerCase()}`])); assert.equal(statSync(`${resolve(root)}-worktrees`, { throwIfNoEntry: false }), undefined);
  }
  const root = temp("pi-worktree-conflict-"); initRepo(root); const base = `${resolve(root)}-worktrees`; const target = join(base, "race-branch"); const roots = await createAllowedRootService({ roots: [root] }); const realRunner = createProcessRunner();
  const runner = { async run(request) { if (request.args.includes("worktree") && request.args.includes("add")) { mkdirSync(target, { recursive: true }); writeFileSync(join(target, "concurrent-owner.txt"), "keep"); } return realRunner.run(request); } };
  const app = createHostApp({ logger: {}, gate, resources: { allowedRoots: roots, processRunner: runner } }).app;
  const response = await app.request("http://localhost/v1/worktrees", { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ cwd: root, branch: "race-branch" }) }); assert.equal(response.status, 400); assert.equal(readFileSync(join(target, "concurrent-owner.txt"), "utf8"), "keep"); assert.doesNotThrow(() => git(root, ["show-ref", "--verify", "refs/heads/race-branch"])); assert.equal(await roots.isAuthorized(target, "directory"), false);
});

test("worktree rollback preserves pre-existing branch and base", async () => {
  const root = temp("pi-worktree-preserve-"); initRepo(root); git(root, ["branch", "existing-branch"]); const base = `${resolve(root)}-worktrees`; mkdirSync(base); writeFileSync(join(base, "keep.txt"), "keep");
  const roots = await createAllowedRootService({ roots: [root], maxRoots: 1 }); const app = createHostApp({ logger: {}, gate, resources: { allowedRoots: roots } }).app;
  const response = await app.request("http://localhost/v1/worktrees", { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ cwd: root, branch: "existing-branch" }) }); assert.equal(response.status, 429);
  assert.doesNotThrow(() => git(root, ["show-ref", "--verify", "refs/heads/existing-branch"])); assert.equal(readFileSync(join(base, "keep.txt"), "utf8"), "keep"); assert.ok(!git(root, ["worktree", "list", "--porcelain"]).includes(join(base, "existing-branch")));
});

test("malicious worktree branches are rejected before git argv execution", async () => {
  const { root, app } = await fixture(); initRepo(root);
  for (const branch of ["-c", "../evil", "bad name", "x\nmain", "refs@{1}", "a..b"]) {
    const res = await app.request("http://localhost/v1/worktrees", { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ cwd: root, branch }) }); assert.equal(res.status, 400, branch);
  }
});

test("bounded process runner does not spawn pre-aborted work and distinguishes timeout/abort/exit/output", async () => {
  const runner = createProcessRunner({ allowedCommands: [process.execPath] });
  const marker = join(temp("pi-process-marker-"), "spawned");
  const preAborted = new AbortController(); preAborted.abort();
  await assert.rejects(() => runner.run({ command: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'x')`], signal: preAborted.signal }), (e) => e.code === "PROCESS_ABORTED");
  assert.throws(() => readFileSync(marker), (e) => e.code === "ENOENT");
  await assert.rejects(() => runner.run({ command: process.execPath, args: ["-e", "setTimeout(()=>{},1000)"], timeoutMs: 20 }), (e) => e.code === "PROCESS_TIMEOUT");
  await assert.rejects(() => runner.run({ command: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(10000))"], maxOutputBytes: 100 }), (e) => e.code === "PROCESS_OUTPUT_LIMIT");
  const exit = await runner.run({ command: process.execPath, args: ["-e", "process.exit(7)"] }); assert.equal(exit.exitCode, 7);
  const controller = new AbortController(); const pending = runner.run({ command: process.execPath, args: ["-e", "setTimeout(()=>{},1000)"], signal: controller.signal }); controller.abort(); await assert.rejects(() => pending, (e) => e.code === "PROCESS_ABORTED");
});

test("file watch manager reserves atomically and releases on creation failure, abort, cancel, and closeAll", async () => {
  const root = temp("pi-watch-"); const file = join(root, "a.txt"); writeFileSync(file, "a"); const manager = createFileWatchManager(1);
  const first = manager.open(file); assert.equal(manager.reservedCount(), 1);
  assert.throws(() => manager.open(file), (e) => e.code === "WATCH_LIMIT");
  const reader = first.body.getReader(); await reader.read(); assert.equal(manager.reservedCount(), 0); assert.equal(manager.activeCount(), 1);
  await reader.cancel(); await new Promise((resolve) => setImmediate(resolve)); assert.equal(manager.activeCount(), 0);

  const missing = manager.open(join(root, "missing")); await assert.rejects(() => missing.body.getReader().read()); await new Promise((resolve) => setImmediate(resolve)); assert.equal(manager.reservedCount(), 0);
  const controller = new AbortController(); const aborted = manager.open(file, controller.signal); controller.abort(); const abortedReader = aborted.body.getReader(); assert.equal((await abortedReader.read()).done, true); assert.equal(manager.reservedCount(), 0); assert.equal(manager.activeCount(), 0);
  const closing = manager.open(file); await closing.body.getReader().read(); manager.closeAll(); assert.equal(manager.activeCount(), 0); assert.equal(manager.reservedCount(), 0);
});

test("watch closeAll terminates active and reserved SSE exactly once under races", async () => {
  const root = temp("pi-watch-shutdown-"); const file = join(root, "a.txt"); writeFileSync(file, "a"); const manager = createFileWatchManager(2);
  const activeResponse = manager.open(file); const activeReader = activeResponse.body.getReader(); await activeReader.read();
  const reservedResponse = manager.open(file); const reservedReader = reservedResponse.body.getReader(); assert.equal(manager.reservedCount(), 1);
  manager.closeAll(); manager.closeAll(); writeFileSync(file, "event-after-close");
  assert.equal((await activeReader.read()).done, true); assert.equal((await reservedReader.read()).done, true); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.activeCount(), 0); assert.equal(manager.reservedCount(), 0);
});

test("resource APIs remain protected by gate and unknown APIs stay JSON 404", async () => {
  const root = temp("pi-gated-"); const allowedRoots = await createAllowedRootService({ roots: [root] }); const app = createHostApp({ logger: {}, gate: { config: { read: () => ({ status: "enabled", password: "secret", source: "test" }) } }, resources: { allowedRoots } }).app;
  const denied = await app.request(`http://localhost/v1/files?path=${encodeURIComponent(root)}`, { headers: headers() }); assert.equal(denied.status, 401);
  const missing = await app.request("http://localhost/v1/resource-nope", { headers: headers({ cookie: "bad" }) }); assert.equal(missing.status, 401); assert.match(missing.headers.get("content-type") ?? "", /json/);
});
