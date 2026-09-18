import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WORKSPACE_ACCESS_REASONS as PROTOCOL_WORKSPACE_ACCESS_REASONS,
  WORKSPACE_ACCESS_STATES as PROTOCOL_WORKSPACE_ACCESS_STATES,
} from "@fffattiger/pix-protocol/workspace-access";
import {
  classifyWorkspaceAccess,
  createAllowedRootService,
  createHostApp,
  WORKSPACE_ACCESS_REASONS,
  WORKSPACE_ACCESS_STATES,
} from "../dist/index.js";

const DISABLED_GATE = { read: () => ({ status: "disabled", source: "test" }) };
const temporary = [];
function temp(prefix) {
  const value = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(value);
  return realpathSync(value);
}
afterEach(() => {
  while (temporary.length) rmSync(temporary.pop(), { recursive: true, force: true });
});

function header(over = {}) {
  return {
    sessionId: "s1",
    cwd: "/proj",
    projectRoot: "/proj",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    ...over,
  };
}

function fakeClient(impl) {
  return {
    async list(params) {
      const result = await impl.list(params);
      if (result && Array.isArray(result.sessions) && result.page === undefined) {
        return { ...result, page: params.page, pageSize: params.pageSize, total: result.sessions.length, totalPages: result.sessions.length === 0 ? 0 : 1, catalogRevision: 0 };
      }
      return result;
    },
    async projects(params) {
      if (impl.projects) return impl.projects(params);
      return { projects: [], page: params.page, pageSize: params.pageSize, total: 0, totalPages: 0, catalogRevision: 0 };
    },
    async read(id) { return impl.read(id); },
    async context(id, options) { return impl.context(id, options); },
    async tree(id) { return impl.tree(id); },
  };
}

function stubCatalog(sessions) {
  return fakeClient({
    async list() { return { sessions }; },
    async read(id) {
      const found = sessions.find((item) => item.sessionId === id);
      if (!found) {
        throw Object.assign(new Error("missing"), { code: "not_found" });
      }
      return { ...found, entries: [] };
    },
    async context() { return { sessionId: "s1", entries: [], pageInfo: { hasMore: false } }; },
    async tree() { return { sessionId: "s1", roots: [], entryCount: 0 }; },
  });
}

function appWith(client, extra = {}) {
  return createHostApp({
    logger: {},
    gate: { config: DISABLED_GATE },
    sessions: { client, ...extra.sessions },
    ...extra,
  }).app;
}

const call = (app, path, init = {}) =>
  app.request(`http://localhost${path}`, { headers: { host: "localhost", ...init.headers }, ...init });

test("Host workspace-access vocabulary is the Protocol wire projection, not a third owner", () => {
  assert.equal(WORKSPACE_ACCESS_STATES, PROTOCOL_WORKSPACE_ACCESS_STATES);
  assert.equal(WORKSPACE_ACCESS_REASONS, PROTOCOL_WORKSPACE_ACCESS_REASONS);
  assert.deepEqual([...WORKSPACE_ACCESS_STATES], ["authorized", "history_only", "unavailable"]);
  assert.deepEqual([...WORKSPACE_ACCESS_REASONS], [
    "allowed_root",
    "outside_allowed_roots",
    "symlink_escape",
    "missing",
    "deleted",
    "unreadable",
    "unresolvable",
    "malformed",
  ]);
});

test("Host classifier source does not redeclare the workspace-access vocabulary", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "../src/resources/workspace-access.ts"), "utf8");
  assert.match(source, /from ["']@fffattiger\/pix-protocol\/workspace-access["']/);
  assert.equal(source.includes("export const WORKSPACE_ACCESS_STATES = ["), false);
  assert.equal(source.includes("export const WORKSPACE_ACCESS_REASONS = ["), false);
  assert.equal(/export interface WorkspaceAccess\b/.test(source), false);
  assert.equal(/export type WorkspaceAccessState\s*=/.test(source), false);
  assert.equal(/export type WorkspaceAccessReason\s*=/.test(source), false);
});

test("authorized: exact cwd and projectRoot inside a live AllowedRoot", async () => {
  const root = temp("pi-ws-auth-");
  const nested = join(root, "nested");
  mkdirSync(nested);
  const roots = await createAllowedRootService({ roots: [root] });
  const access = await classifyWorkspaceAccess(roots, { cwd: nested, projectRoot: root });
  assert.deepEqual(access, { state: "authorized", reason: "allowed_root" });
  const app = appWith(stubCatalog([header({ cwd: nested, projectRoot: root })]), {
    resources: { allowedRoots: roots },
  });
  const list = await call(app, "/v1/sessions");
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.deepEqual(body.sessions[0].workspaceAccess, { state: "authorized", reason: "allowed_root" });
  const detail = await (await call(app, "/v1/sessions/s1")).json();
  assert.deepEqual(detail.session.workspaceAccess, { state: "authorized", reason: "allowed_root" });
  assert.equal(detail.session.projectRoot, root);
});

test("history_only: readable directory outside AllowedRoots is not a live workspace", async () => {
  const root = temp("pi-ws-in-");
  const outside = temp("pi-ws-out-");
  const roots = await createAllowedRootService({ roots: [root] });
  const before = [...roots.roots()];
  let expanded = 0;
  const originalExpand = roots.expandRoots.bind(roots);
  roots.expandRoots = async (...args) => {
    expanded += 1;
    return originalExpand(...args);
  };
  const access = await classifyWorkspaceAccess(roots, { cwd: outside, projectRoot: outside });
  assert.deepEqual(access, { state: "history_only", reason: "outside_allowed_roots" });
  assert.equal(expanded, 0, "classification must never call expandRoots");
  assert.deepEqual(roots.roots(), before, "classification must never expand roots");
  const app = appWith(stubCatalog([header({ cwd: outside, projectRoot: outside })]), {
    resources: { allowedRoots: roots },
  });
  const body = await (await call(app, "/v1/sessions")).json();
  assert.deepEqual(body.sessions[0].workspaceAccess, {
    state: "history_only",
    reason: "outside_allowed_roots",
  });
  assert.deepEqual(roots.roots(), before);
});

test("history_only: leaf symlink escape is not authorized even when the lexical path is inside a root", async () => {
  const root = temp("pi-ws-sym-");
  const outside = temp("pi-ws-sym-out-");
  const link = join(root, "escape");
  symlinkSync(outside, link, "dir");
  const roots = await createAllowedRootService({ roots: [root] });
  assert.ok(roots.roots().includes(root));
  assert.notEqual(link, root, "leaf symlink must not be the registered root path");
  const access = await classifyWorkspaceAccess(roots, { cwd: link, projectRoot: link });
  assert.deepEqual(access, { state: "history_only", reason: "symlink_escape" });
  const app = appWith(stubCatalog([header({ cwd: link, projectRoot: root })]), {
    resources: { allowedRoots: roots },
  });
  const body = await (await call(app, "/v1/sessions")).json();
  assert.equal(body.sessions[0].workspaceAccess.state, "history_only");
  assert.equal(body.sessions[0].workspaceAccess.reason, "symlink_escape");
});

test("unavailable: exact registered root replaced by a symlink is identity replacement, not history_only", async () => {
  const root = temp("pi-ws-root-sym-");
  const roots = await createAllowedRootService({ roots: [root] });
  assert.deepEqual(roots.roots(), [root]);
  const parked = `${root}-parked`;
  temporary.push(parked);
  renameSync(root, parked);
  symlinkSync(parked, root, "dir");
  const access = await classifyWorkspaceAccess(roots, { cwd: root, projectRoot: root });
  assert.deepEqual(access, { state: "unavailable", reason: "deleted" });
  const app = appWith(stubCatalog([header({ cwd: root, projectRoot: root })]), {
    resources: { allowedRoots: roots },
  });
  const body = await (await call(app, "/v1/sessions")).json();
  assert.deepEqual(body.sessions[0].workspaceAccess, { state: "unavailable", reason: "deleted" });
});

test("unavailable: missing, deleted, file-not-directory, and malformed paths", async () => {
  const root = temp("pi-ws-miss-");
  const missing = join(root, "gone");
  const file = join(root, "file.txt");
  writeFileSync(file, "x");
  const roots = await createAllowedRootService({ roots: [root] });
  assert.deepEqual(
    await classifyWorkspaceAccess(roots, { cwd: missing, projectRoot: missing }),
    { state: "unavailable", reason: "missing" },
  );
  assert.deepEqual(
    await classifyWorkspaceAccess(roots, { cwd: file, projectRoot: file }),
    { state: "unavailable", reason: "unresolvable" },
  );
  assert.deepEqual(
    await classifyWorkspaceAccess(roots, { cwd: "relative", projectRoot: root }),
    { state: "unavailable", reason: "malformed" },
  );
  assert.deepEqual(
    await classifyWorkspaceAccess(roots, { cwd: "", projectRoot: root }),
    { state: "unavailable", reason: "malformed" },
  );
  assert.deepEqual(
    await classifyWorkspaceAccess(roots, { cwd: "/ok\0x", projectRoot: root }),
    { state: "unavailable", reason: "malformed" },
  );

  const doomed = temp("pi-ws-del-");
  const doomedRoots = await createAllowedRootService({ roots: [doomed] });
  rmSync(doomed, { recursive: true, force: true });
  const deleted = await classifyWorkspaceAccess(doomedRoots, { cwd: doomed, projectRoot: doomed });
  assert.equal(deleted.state, "unavailable");
  assert.ok(deleted.reason === "missing" || deleted.reason === "deleted");
});

test("unavailable: unreadable path fail-closes", async () => {
  const root = temp("pi-ws-unr-");
  const hidden = join(root, "hidden");
  const target = join(hidden, "proj");
  mkdirSync(target, { recursive: true });
  const roots = await createAllowedRootService({ roots: [root] });
  chmodSync(hidden, 0);
  try {
    let blocked = false;
    try {
      realpathSync(target);
    } catch {
      blocked = true;
    }
    const access = await classifyWorkspaceAccess(roots, { cwd: target, projectRoot: target });
    if (blocked) {
      assert.equal(access.state, "unavailable");
      assert.ok(access.reason === "unreadable" || access.reason === "unresolvable");
    }
  } finally {
    chmodSync(hidden, 0o700);
  }
});

test("mixed list projects each row independently and never grants visibility", async () => {
  const root = temp("pi-ws-mix-");
  const outside = temp("pi-ws-mix-out-");
  const missing = join(root, "nope");
  const roots = await createAllowedRootService({ roots: [root] });
  const before = [...roots.roots()];
  const app = appWith(stubCatalog([
    header({ sessionId: "live", cwd: root, projectRoot: root }),
    header({ sessionId: "hist", cwd: outside, projectRoot: outside }),
    header({ sessionId: "gone", cwd: missing, projectRoot: missing }),
  ]), { resources: { allowedRoots: roots } });
  const body = await (await call(app, "/v1/sessions")).json();
  assert.deepEqual(body.sessions.map((row) => [row.sessionId, row.workspaceAccess.state]), [
    ["live", "authorized"],
    ["hist", "history_only"],
    ["gone", "unavailable"],
  ]);
  assert.deepEqual(roots.roots(), before);
});

test("Host overwrites adapter-supplied authorized and never parses JSONL", async () => {
  const root = temp("pi-ws-over-");
  const outside = temp("pi-ws-over-out-");
  const roots = await createAllowedRootService({ roots: [root] });
  const app = appWith(stubCatalog([
    header({
      cwd: outside,
      projectRoot: outside,
      workspaceAccess: { state: "authorized", reason: "allowed_root" },
    }),
  ]), { resources: { allowedRoots: roots } });
  const body = await (await call(app, "/v1/sessions")).json();
  assert.deepEqual(body.sessions[0].workspaceAccess, {
    state: "history_only",
    reason: "outside_allowed_roots",
  });
});

test("malformed catalog payloads and adapter errors stay honest (no empty/authorized fallback)", async () => {
  const root = temp("pi-ws-err-");
  const roots = await createAllowedRootService({ roots: [root] });
  const throwing = fakeClient({
    async list() { throw Object.assign(new Error("socket secret"), { code: "unavailable" }); },
    async read() { throw Object.assign(new Error("socket secret"), { code: "unavailable" }); },
    async context() { throw new Error("nope"); },
    async tree() { throw new Error("nope"); },
  });
  const app = appWith(throwing, { resources: { allowedRoots: roots } });
  const list = await call(app, "/v1/sessions");
  assert.equal(list.status, 503);
  const listBody = await list.json();
  assert.equal(listBody.code, "SESSIONS_UNAVAILABLE");
  assert.equal(listBody.sessions, undefined);
  assert.ok(!JSON.stringify(listBody).includes("secret"));

  const malformed = fakeClient({
    async list() { return { sessions: "nope" }; },
    async read() { return "nope"; },
    async context() { return { sessionId: "s1", entries: [], pageInfo: { hasMore: false } }; },
    async tree() { return { sessionId: "s1", roots: [], entryCount: 0 }; },
  });
  const broken = appWith(malformed, { resources: { allowedRoots: roots } });
  const badList = await call(broken, "/v1/sessions");
  assert.equal(badList.status, 503);
  const badDetail = await call(broken, "/v1/sessions/s1");
  assert.equal(badDetail.status, 503);
});

test("LAN gate blocks classification; authenticated LAN still does not expand roots", async () => {
  const root = temp("pi-ws-lan-");
  const outside = temp("pi-ws-lan-out-");
  const roots = await createAllowedRootService({ roots: [root], allowLanExpansion: false });
  const before = [...roots.roots()];
  let authorizeCalls = 0;
  const original = roots.authorizeExisting.bind(roots);
  roots.authorizeExisting = async (...args) => {
    authorizeCalls += 1;
    return original(...args);
  };
  const app = createHostApp({
    logger: {},
    exposureMode: "lan",
    gate: { config: { read: () => ({ status: "enabled", password: "secret", source: "test" }) } },
    sessions: { client: stubCatalog([header({ cwd: outside, projectRoot: outside })]), roots },
    resources: { allowedRoots: roots },
  }).app;
  const denied = await app.request("http://127.0.0.1/v1/sessions", {
    headers: { host: "127.0.0.1" },
  });
  assert.ok(denied.status === 401 || denied.status === 403);
  assert.equal(authorizeCalls, 0, "LAN auth gate must run before classification");
  assert.deepEqual(roots.roots(), before);

  const login = await app.request("http://127.0.0.1/v1/gate/login", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ password: "secret" }),
  });
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const allowed = await app.request("http://127.0.0.1/v1/sessions", {
    headers: { host: "127.0.0.1", cookie },
  });
  assert.equal(allowed.status, 200);
  const body = await allowed.json();
  assert.deepEqual(body.sessions[0].workspaceAccess, {
    state: "history_only",
    reason: "outside_allowed_roots",
  });
  assert.deepEqual(roots.roots(), before, "LAN must never grant a root via session list");
});

test("race: replaced AllowedRoot fail-closes to unavailable, never authorized", async () => {
  const root = temp("pi-ws-race-");
  const roots = await createAllowedRootService({ roots: [root] });
  const moved = `${root}-moved`;
  temporary.push(moved);
  renameSync(root, moved);
  mkdirSync(root);
  const access = await classifyWorkspaceAccess(roots, { cwd: root, projectRoot: root });
  assert.equal(access.state, "unavailable");
  assert.ok(access.reason === "deleted" || access.reason === "unresolvable" || access.reason === "missing");

  const linked = temp("pi-ws-race-link-");
  const linkedRoots = await createAllowedRootService({ roots: [linked] });
  const parked = `${linked}-parked`;
  temporary.push(parked);
  renameSync(linked, parked);
  symlinkSync(parked, linked, "dir");
  const swapped = await classifyWorkspaceAccess(linkedRoots, { cwd: linked, projectRoot: linked });
  assert.deepEqual(swapped, { state: "unavailable", reason: "deleted" });
});

test("no AllowedRoots seam never guesses authorized", async () => {
  const live = temp("pi-ws-noroot-");
  const access = await classifyWorkspaceAccess(undefined, { cwd: live, projectRoot: live });
  assert.deepEqual(access, { state: "history_only", reason: "outside_allowed_roots" });
  const app = appWith(stubCatalog([header({ cwd: live, projectRoot: live })]));
  const body = await (await call(app, "/v1/sessions")).json();
  assert.deepEqual(body.sessions[0].workspaceAccess, {
    state: "history_only",
    reason: "outside_allowed_roots",
  });
});

test("context/tree/models/files/skills routes are unchanged by list classification", async () => {
  const root = temp("pi-ws-other-");
  const roots = await createAllowedRootService({ roots: [root] });
  const app = appWith(stubCatalog([header({ cwd: root, projectRoot: root })]), {
    resources: { allowedRoots: roots },
  });
  const context = await call(app, "/v1/sessions/s1/context");
  assert.equal(context.status, 200);
  const contextBody = await context.json();
  assert.equal(contextBody.context.workspaceAccess, undefined);
  const tree = await call(app, "/v1/sessions/s1/tree");
  assert.equal(tree.status, 200);
  assert.equal(lstatSync(root).isDirectory(), true);
});
