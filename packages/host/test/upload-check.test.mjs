import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAllowedRootService, createHostApp } from "../dist/index.js";
import { setUploadFaultHooks } from "../dist/routes/files.js";

// H1 (POST /v1/files?op=upload-check) + H2 (batch conflict lists / per-file
// non-replaceable errors) targeted coverage. Transaction semantics (staging,
// commit, rollback journal, concurrency) stay covered by
// uploads-transaction.test.mjs; these tests assert they are not weakened by
// the new preflight classification.

const temporary = [];
const gate = { config: { read: () => ({ status: "disabled", source: "test" }) } };
function temp(prefix) { const value = mkdtempSync(join(tmpdir(), prefix)); temporary.push(value); return value; }
afterEach(() => {
  setUploadFaultHooks(null);
  while (temporary.length) rmSync(temporary.pop(), { recursive: true, force: true });
});

async function fixture() {
  const root = temp("pi-upload-check-");
  const allowedRoots = await createAllowedRootService({ roots: [root] });
  const host = createHostApp({ logger: {}, gate, resources: { allowedRoots } });
  return { root, allowedRoots, app: host.app };
}

function headers(extra = {}) { return { host: "localhost", ...extra }; }

function check(app, root, fileNames) {
  return app.request(`http://localhost/v1/files?path=${encodeURIComponent(root)}&op=upload-check`, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ fileNames }),
  });
}

function upload(app, root, files, conflict = "error") {
  const form = new FormData();
  for (const [name, value] of files) form.append("files", new File([value], name));
  return app.request(`http://localhost/v1/files?path=${encodeURIComponent(root)}&conflict=${conflict}`, { method: "POST", headers: headers(), body: form });
}

function assertNoUploadArtifacts(dir) {
  assert.deepEqual(readdirSync(dir).filter((entry) => entry.startsWith(".pix-upload-")), [], `no temp/backup leftovers in ${dir}`);
}

/** Regular file, directory, symlink (inside batch order), absent target. */
async function seededFixture() {
  const { root, app } = await fixture();
  const outside = temp("pi-upload-check-out-");
  const secret = join(outside, "secret");
  writeFileSync(secret, "SECRET");
  writeFileSync(join(root, "exists.txt"), "orig");
  mkdirSync(join(root, "subdir"));
  symlinkSync(secret, join(root, "link"));
  return { root, app, outside, secret };
}

test("upload-check classifies regular files, directories, symlinks and absent targets (strict shape)", async () => {
  const { root, app, secret } = await seededFixture();
  const res = await check(app, root, ["absent.txt", "exists.txt", "subdir", "link", "absent2.txt"]);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ["conflicts", "nonReplaceable"], "strict response shape");
  assert.deepEqual(body.conflicts, ["exists.txt", "subdir", "link"], "existing entries in stable input order");
  assert.deepEqual(body.nonReplaceable, ["subdir", "link"], "directory and symlink are non-replaceable");
  assert.equal(readFileSync(secret, "utf8"), "SECRET", "symlink never followed");
  assert.equal(lstatSync(join(root, "link")).isSymbolicLink(), true, "symlink never replaced");
  assertNoUploadArtifacts(root);
});

test("upload-check classifies non-regular entries (FIFO) as non-replaceable", async () => {
  const { root, app } = await fixture();
  execFileSync("mkfifo", [join(root, "pipe")]);
  const body = await (await check(app, root, ["pipe"])).json();
  assert.deepEqual(body.conflicts, ["pipe"]);
  assert.deepEqual(body.nonReplaceable, ["pipe"]);
});

test("upload-check deduplicates names and keeps first-occurrence input order", async () => {
  const { root, app } = await seededFixture();
  const body = await (await check(app, root, ["exists.txt", "absent.txt", "exists.txt", "subdir", "link", "link"])).json();
  assert.deepEqual(body.conflicts, ["exists.txt", "subdir", "link"]);
  assert.deepEqual(body.nonReplaceable, ["subdir", "link"]);
});

test("upload-check rejects illegal basenames with the shared defense and writes nothing", async () => {
  const { root, app } = await fixture();
  for (const name of ["../evil", "a/b", "a\\b", ".", "..", "", "nul\0byte"]) {
    const res = await check(app, root, [name]);
    assert.equal(res.status, 400, `${JSON.stringify(name)} must be rejected`);
    assert.equal((await res.json()).code, "INVALID_FILE_NAME");
  }
  assert.deepEqual(readdirSync(root), []);
  assertNoUploadArtifacts(root);
});

test("upload-check fails closed outside the allowed roots and on replaced roots (no path echo)", async () => {
  const { root, app } = await fixture();
  const outside = temp("pi-upload-check-forbidden-");
  let res = await check(app, root, [join(outside, "child")]);
  assert.equal(res.status, 400, "child names with separators are rejected before authorization");
  res = await app.request(`http://localhost/v1/files?path=${encodeURIComponent(outside)}&op=upload-check`, {
    method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ fileNames: ["a.txt"] }),
  });
  assert.equal(res.status, 403);
  const forbidden = await res.json();
  assert.equal(forbidden.code, "PATH_FORBIDDEN");
  assert.ok(!JSON.stringify(forbidden).includes(outside), "no path echo in error body");

  // Root replaced after authorization: identity re-check fails closed.
  const moved = `${root}-old`; temporary.push(moved);
  renameSync(root, moved); mkdirSync(root);
  res = await check(app, root, ["a.txt"]);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "ROOT_REPLACED");
  assert.deepEqual(readdirSync(root), []);
});

test("upload-check requires an existing authorized directory", async () => {
  const { root, app } = await fixture();
  writeFileSync(join(root, "plain.txt"), "x");
  let res = await check(app, root, ["a.txt"]);
  assert.equal(res.status, 200);
  res = await app.request(`http://localhost/v1/files?path=${encodeURIComponent(join(root, "plain.txt"))}&op=upload-check`, {
    method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ fileNames: ["a.txt"] }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "NOT_DIRECTORY");
  res = await app.request(`http://localhost/v1/files?path=${encodeURIComponent(join(root, "missing"))}&op=upload-check`, {
    method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ fileNames: ["a.txt"] }),
  });
  assert.equal(res.status, 404);
});

test("upload-check enforces a strict bounded JSON body", async () => {
  const { root, app } = await fixture();
  const post = (body, contentType = "application/json") => app.request(
    `http://localhost/v1/files?path=${encodeURIComponent(root)}&op=upload-check`,
    { method: "POST", headers: headers(contentType ? { "content-type": contentType } : {}), body },
  );
  let res = await post(JSON.stringify({ fileNames: ["a.txt"] }), "text/plain");
  assert.equal(res.status, 415);
  assert.equal((await res.json()).code, "UNSUPPORTED_MEDIA_TYPE");
  res = await post("{oops");
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "INVALID_JSON");
  for (const fileNames of [undefined, "a.txt", [], [1], ["a.txt", null]]) {
    res = await post(JSON.stringify(fileNames === undefined ? {} : { fileNames }));
    assert.equal(res.status, 400, `${JSON.stringify(fileNames)} must be rejected`);
    assert.equal((await res.json()).code, "FILE_NAMES_REQUIRED");
  }
  res = await post(JSON.stringify({ fileNames: Array.from({ length: 257 }, () => "f") }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "TOO_MANY_FILE_NAMES");
  res = await post(JSON.stringify({ fileNames: ["x".repeat(256)] }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "FILE_NAME_TOO_LONG");
  // Bounded body: 256 names within the count cap but over the byte cap.
  res = await post(JSON.stringify({ fileNames: Array.from({ length: 256 }, () => "y".repeat(600)) }));
  assert.equal(res.status, 413);
  assert.equal((await res.json()).code, "BODY_TOO_LARGE");
  assert.deepEqual(readdirSync(root), []);
});

test("conflict=error preflight reports every conflict, not a single name, and writes nothing", async () => {
  const { root, app } = await seededFixture();
  const res = await upload(app, root, [["new.txt", "nnn"], ["exists.txt", "ee"], ["subdir", "dd"], ["link", "ll"]], "error");
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, "FILE_EXISTS");
  assert.deepEqual(body.conflicts, ["exists.txt", "subdir", "link"], "all conflicts in batch order");
  assert.deepEqual(body.nonReplaceable, ["subdir", "link"]);
  assert.equal(body.message, "One or more files already exist", "fixed message");
  assert.equal(body.error, "One or more files already exist", "legacy error alias stays the message");
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes(root) && !serialized.includes("/tmp"), "no absolute paths in error body");
  assert.ok(!serialized.includes("pix-upload"), "no temp/backup names in error body");
  assert.equal(readFileSync(join(root, "exists.txt"), "utf8"), "orig", "nothing overwritten");
  assert.throws(() => readFileSync(join(root, "new.txt")), (e) => e.code === "ENOENT", "nothing created");
  assertNoUploadArtifacts(root);
});

test("conflict=overwrite uploads replaceable targets and reports non-replaceable ones per file (207)", async () => {
  const { root, app, secret } = await seededFixture();
  const res = await upload(app, root, [["exists.txt", "replaced"], ["subdir", "dd"], ["new.txt", "nnn"], ["link", "ll"]], "overwrite");
  assert.equal(res.status, 207);
  const body = await res.json();
  assert.deepEqual(body.uploaded, ["exists.txt", "new.txt"]);
  assert.deepEqual(body.skipped, []);
  assert.deepEqual(body.errors, [
    { name: "subdir", error: "Cannot replace a directory or symbolic link" },
    { name: "link", error: "Cannot replace a directory or symbolic link" },
  ], "per-file fixed errors in batch order");
  assert.equal(readFileSync(join(root, "exists.txt"), "utf8"), "replaced");
  assert.equal(readFileSync(join(root, "new.txt"), "utf8"), "nnn");
  assert.equal(lstatSync(join(root, "subdir")).isDirectory(), true, "directory never replaced");
  assert.equal(lstatSync(join(root, "link")).isSymbolicLink(), true, "symlink never replaced");
  assert.equal(readFileSync(secret, "utf8"), "SECRET", "never written through the symlink");
  assertNoUploadArtifacts(root);
});

test("conflict=skip leaves every existing entry (including non-replaceable) untouched; errors stays an array", async () => {
  const { root, app, secret } = await seededFixture();
  const res = await upload(app, root, [["exists.txt", "ee"], ["subdir", "dd"], ["link", "ll"], ["new.txt", "nnn"]], "skip");
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.deepEqual(body.uploaded, ["new.txt"]);
  assert.deepEqual(body.skipped, ["exists.txt", "subdir", "link"]);
  assert.deepEqual(body.errors, [], "errors is always an array for old-schema clients");
  assert.equal(readFileSync(join(root, "exists.txt"), "utf8"), "orig");
  assert.equal(readFileSync(secret, "utf8"), "SECRET");
  assertNoUploadArtifacts(root);
});

test("a staging failure still fails the whole batch with a fixed error even with per-file conflicts pending", async () => {
  const { root, app } = await seededFixture();
  setUploadFaultHooks({ beforeStage: async () => { throw new Error("simulated staging failure"); } });
  const res = await upload(app, root, [["exists.txt", "replaced"], ["subdir", "dd"], ["new.txt", "nnn"]], "overwrite");
  assert.equal(res.status, 500, "staging failure is never a 207 partial success");
  const body = await res.json();
  assert.equal(body.code, "INTERNAL");
  assert.equal(body.error, "Internal server error", "fixed sanitized error");
  assert.equal(readFileSync(join(root, "exists.txt"), "utf8"), "orig", "existing file untouched");
  assert.throws(() => readFileSync(join(root, "new.txt")), (e) => e.code === "ENOENT");
  assertNoUploadArtifacts(root);
});

test("a commit failure rolls back replaceable commits and never touches non-replaceable targets", async () => {
  const { root, app } = await seededFixture();
  setUploadFaultHooks({ beforeCommit: async (index, name) => { if (name === "new.txt") throw new Error("simulated commit failure"); } });
  const res = await upload(app, root, [["exists.txt", "replaced"], ["new.txt", "nnn"], ["subdir", "dd"]], "overwrite");
  assert.equal(res.status, 500);
  assert.equal((await res.json()).code, "INTERNAL");
  assert.equal(readFileSync(join(root, "exists.txt"), "utf8"), "orig", "overwritten file restored");
  assert.throws(() => readFileSync(join(root, "new.txt")), (e) => e.code === "ENOENT");
  assert.equal(lstatSync(join(root, "subdir")).isDirectory(), true, "non-replaceable target untouched");
  assertNoUploadArtifacts(root);
});

test("upload-check and multipart preflight classify the same targets (consistency)", async () => {
  const { root, app } = await seededFixture();
  const names = ["exists.txt", "subdir", "link", "absent.txt"];
  const inspection = await (await check(app, root, names)).json();
  const res = await upload(app, root, names.map((name) => [name, "x"]), "error");
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.deepEqual(body.conflicts, inspection.conflicts);
  assert.deepEqual(body.nonReplaceable, inspection.nonReplaceable);
});
