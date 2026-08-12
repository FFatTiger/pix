// D3A-2 Client Files/Git workspace — HTTP integration against the real Host.
//
// The Client (D3A-2) is a strictly read-only Files/Git surface that gates every
// request on the negotiated `files`/`git` capabilities. This test pins the
// Host-side contract the Client depends on, end to end through the real Hono
// app + allowed-roots authority:
//
//   1. the production capability projection (sessiond down) advertises exactly
//      the degraded resource surface — `files` + `git`, never `agent`/`worktree`
//      — so the Client's capability gating is backed by what the Host serves;
//   2. the read-only GET surface the Client calls (files list/read/meta, git
//      status/diff) behaves correctly inside the project root;
//   3. no privilege escalation: every path the Client could conceivably hand
//      the Host from outside the root (absolute escape, `..` traversal) is
//      rejected with 403 by the allowed-roots authority, not by the Client.
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAllowedRootService,
  createHostApp,
  PRODUCTION_FULL_CAPABILITIES,
  RESOURCE_DEGRADED_CAPABILITIES,
} from "../dist/index.js";

const temporary = [];
const gate = { config: { read: () => ({ status: "disabled", source: "test" }) } };
function temp(prefix) {
  // realpathSync resolves the macOS /var → /private/var symlink so the
  // canonical paths the Host returns (it realpaths every request) match what
  // the test asserts against.
  const value = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporary.push(value);
  return value;
}
afterEach(() => {
  while (temporary.length) rmSync(temporary.pop(), { recursive: true, force: true });
});
function headers(extra = {}) {
  return { host: "localhost", ...extra };
}
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
  // Commit the entire initial layout so the working-tree diff below is deterministic.
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "initial"]);
}

async function fixture() {
  const root = temp("pix-client-ws-");
  // Project layout the Client browses: a text file, a nested dir, a binary, and
  // a tracked file — all committed up front so the git diff is deterministic.
  writeFileSync(join(root, "hello.txt"), "hello world\n");
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "nested.txt"), "nested body\n");
  writeFileSync(join(root, "logo.bin"), Buffer.from([0, 1, 2, 3, 0xff]));
  writeFileSync(join(root, "tracked.txt"), "one\n");
  initRepo(root);
  // Working-tree changes the Client's Git panel renders.
  writeFileSync(join(root, "tracked.txt"), "one changed\n");
  writeFileSync(join(root, "untracked.txt"), "fresh\n");

  // A second temp tree entirely outside the allowed root, to prove the read-only
  // surface cannot be aimed at sibling paths on disk.
  const outside = temp("pix-client-outside-");
  writeFileSync(join(outside, "secret.txt"), "SECRET\n");

  const allowedRoots = await createAllowedRootService({ roots: [root] });
  // Production capability projection: sessiond down ⇒ degraded resource surface.
  const host = createHostApp({
    logger: {},
    gate,
    exposureMode: "local",
    resources: { allowedRoots },
    sessiond: { isAvailable: async () => false },
    capabilities: { full: PRODUCTION_FULL_CAPABILITIES, readonly: RESOURCE_DEGRADED_CAPABILITIES },
  });
  return { root, outside, app: host.app };
}

test("capability projection advertises files+git but not agent/worktree while sessiond is down", async () => {
  const { app } = await fixture();
  const res = await app.request("http://localhost/v1/capabilities", { headers: headers() });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.sessiond, "down");
  // Catalog tokens in RESOURCE_DEGRADED_CAPABILITIES are stripped when catalogs
  // are not mounted (normalizeCatalogCapabilities honesty).
  const expected = [...RESOURCE_DEGRADED_CAPABILITIES].filter(
    (t) => !["models", "auth.providers", "skills", "plugins"].includes(t),
  );
  assert.deepEqual([...body.capabilities].sort(), expected.sort());
  assert.ok(body.capabilities.includes("files"), "files capability advertised");
  assert.ok(body.capabilities.includes("git"), "git capability advertised");
  assert.ok(!body.capabilities.includes("agent"), "agent not advertised while sessiond is down");
  assert.ok(!body.capabilities.includes("worktree"), "worktree is never advertised (D3A-1)");
  assert.ok(!body.capabilities.includes("models"), "catalog tokens not advertised without catalogs");
});

test("Files read-only surface lists, reads and meta-inspects within the root", async () => {
  const { root, app } = await fixture();
  const q = (p) => `http://localhost/v1/files?${new URLSearchParams(p).toString()}`;

  const list = await app.request(q({ path: root, op: "list" }), { headers: headers() });
  assert.equal(list.status, 200);
  const listed = await list.json();
  assert.equal(listed.path, root);
  const names = listed.entries.map((e) => e.name);
  assert.ok(names.includes("hello.txt"));
  assert.ok(names.includes("sub"));
  assert.ok(names.includes("logo.bin"));
  // Ignored build noise never leaks into the Client browser.
  assert.ok(!names.includes("node_modules"));

  const read = await app.request(q({ path: join(root, "hello.txt"), op: "read" }), { headers: headers() });
  assert.equal(read.status, 200);
  const text = await read.json();
  assert.equal(text.content, "hello world\n");
  assert.equal(text.language, "text");

  const meta = await app.request(q({ path: join(root, "logo.bin"), op: "meta" }), { headers: headers() });
  assert.equal(meta.status, 200);
  const metaBody = await meta.json();
  assert.equal(metaBody.isDirectory, false);
  assert.equal(metaBody.mime, "application/octet-stream");

  // The Client walks into a sub-directory via joinChild(parent, name).
  const sub = await app.request(q({ path: join(root, "sub"), op: "list" }), { headers: headers() });
  assert.equal(sub.status, 200);
  const subBody = await sub.json();
  assert.deepEqual(subBody.entries.map((e) => e.name), ["nested.txt"]);

  // Binary content is not handed back as text preview.
  const binary = await app.request(q({ path: join(root, "logo.bin"), op: "read" }), { headers: headers() });
  assert.equal(binary.status, 415);
});

test("Git status/diff surface reflects working-tree changes for the Client panel", async () => {
  const { root, app } = await fixture();
  const status = await app.request(`http://localhost/v1/git/status?cwd=${encodeURIComponent(root)}`, { headers: headers() });
  assert.equal(status.status, 200);
  const body = await status.json();
  assert.equal(body.isGitRepository, true);
  assert.equal(body.repositoryRoot, root);
  const byStatus = body.files.map((f) => f.status).sort();
  assert.deepEqual(byStatus, ["modified", "untracked"]);

  const diff = await app.request(
    `http://localhost/v1/git/diff?cwd=${encodeURIComponent(root)}&path=${encodeURIComponent(join(root, "tracked.txt"))}`,
    { headers: headers() },
  );
  assert.equal(diff.status, 200);
  const patch = await diff.json();
  assert.equal(patch.supported, true);
  assert.match(patch.patch, /\+one changed/);
});

test("a non-repository cwd reports not-a-repo instead of erroring", async () => {
  const { app } = await fixture();
  const plain = temp("pix-client-plain-");
  // Allow the plain dir so authorization passes; git status then reports no repo.
  const allowedRoots = await createAllowedRootService({ roots: [plain] });
  const host = createHostApp({ logger: {}, gate, exposureMode: "local", resources: { allowedRoots } });
  const res = await host.app.request(`http://localhost/v1/git/status?cwd=${encodeURIComponent(plain)}`, { headers: headers() });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.isGitRepository, false);
  assert.equal(body.repositoryRoot, null);
});

test("no privilege escalation: paths outside the root are rejected with 403", async () => {
  const { root, outside, app } = await fixture();
  const q = (p) => `http://localhost/v1/files?${new URLSearchParams(p).toString()}`;

  // Absolute sibling path outside the allowed root.
  const escapeRead = await app.request(q({ path: join(outside, "secret.txt"), op: "read" }), { headers: headers() });
  assert.equal(escapeRead.status, 403);

  // `..` traversal that resolves above the root.
  const traversal = await app.request(q({ path: join(root, "..", ".."), op: "list" }), { headers: headers() });
  assert.equal(traversal.status, 403);

  // Git diff cannot be aimed at a path outside the repository/root.
  const gitEscape = await app.request(
    `http://localhost/v1/git/diff?cwd=${encodeURIComponent(root)}&path=${encodeURIComponent(join(outside, "secret.txt"))}`,
    { headers: headers() },
  );
  assert.equal(gitEscape.status, 403);

  // `path` is mandatory — the Client never omits it, but the Host still refuses.
  const missing = await app.request(q({ op: "list" }), { headers: headers() });
  assert.equal(missing.status, 400);
});
