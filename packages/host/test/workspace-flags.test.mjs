/**
 * Round 5 redo: Host workspace-flags routes.
 *
 * GET/PATCH /v1/workspace-flags over the sessiond seam. Strict bodies, guard
 * first (sessiond down ⇒ 503 before parsing), AllowedRoots classification for
 * project keys, fixed error mapping. NOT run in this commit (user-deferred).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHostApp } from "../dist/app.js";
import { HttpError } from "../dist/errors.js";
const DISABLED_GATE = { read: () => ({ status: "disabled", source: "test" }) };

/** Fake seam recording calls. */
function fakeSeam(impl = {}) {
  const calls = [];
  const seam = {
    calls,
    client: {
      async getWorkspaceFlags() {
        calls.push({ op: "get" });
        return impl.get?.() ?? { revision: 1, sessions: {}, projects: {} };
      },
      async setWorkspaceFlags(kind, key, flags) {
        calls.push({ op: "set", kind, key, flags });
        return impl.set?.(kind, key, flags) ?? { kind, key, pinned: false, archived: false, revision: 2 };
      },
    },
    mutationGuard: {
      async assertAvailable() {
        if (impl.down) throw new HttpError(503, "SESSIOND_UNAVAILABLE", "sessiond is down");
      },
    },
    isAllowedPath(path) {
      return !impl.allowedRoots || impl.allowedRoots.some((root) => path === root || path.startsWith(`${root}/`));
    },
  };
  return seam;
}

function appWith(seam) {
  return createHostApp({
    logger: {},
    gate: { config: DISABLED_GATE },
    sessions: { workspaceFlags: seam },
  }).app;
}

const patch = (app, body) => app.request("http://localhost/v1/workspace-flags", {
  method: "PATCH",
  headers: { host: "localhost", "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const get = (app) => app.request("http://localhost/v1/workspace-flags", { headers: { host: "localhost" } });

test("GET /v1/workspace-flags returns the sessiond snapshot; no seam mounted ⇒ 404", async () => {
  const seam = fakeSeam({ get: () => ({ revision: 4, sessions: { s: { pinned: true } }, projects: {} }) });
  const app = appWith(seam);
  const res = await get(app);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { revision: 4, sessions: { s: { pinned: true } }, projects: {} });
  assert.equal(seam.calls.length, 1);

  const bare = createHostApp({ logger: {}, gate: { config: DISABLED_GATE } }).app;
  assert.equal((await get(bare)).status, 404);
  assert.equal((await patch(bare, { kind: "session", key: "s", pinned: true })).status, 404);
});

test("PATCH /v1/workspace-flags: strict body, session or project, calls the seam exactly once", async () => {
  const seam = fakeSeam();
  const app = appWith(seam);
  const ok = await patch(app, { kind: "session", key: "s1", pinned: true });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { success: true });
  assert.deepEqual(seam.calls, [{ op: "set", kind: "session", key: "s1", flags: { pinned: true } }]);

  const project = await patch(app, { kind: "project", key: "/repos/pix", archived: true, pinned: false });
  assert.equal(project.status, 200);
  assert.deepEqual(seam.calls[1], { op: "set", kind: "project", key: "/repos/pix", flags: { archived: true, pinned: false } });
});

test("PATCH rejects malformed bodies before the seam (never mixed/unknown fields)", async () => {
  const seam = fakeSeam();
  const app = appWith(seam);
  for (const bad of [
    { kind: "folder", key: "/x", pinned: true },
    { kind: "session" },
    { kind: "session", key: "s1" },
    { kind: "session", key: "s1", pinned: "yes" },
    { kind: "session", key: "s1", archived: 1 },
    { kind: "session", key: "s1", pinned: true, extra: 1 },
    "not-json",
  ]) {
    const res = await patch(app, bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  assert.equal(seam.calls.length, 0);
});

test("PATCH project keys outside AllowedRoots are 403; relative keys 400", async () => {
  const seam = fakeSeam({ allowedRoots: ["/repos"] });
  const app = appWith(seam);
  assert.equal((await patch(app, { kind: "project", key: "/repos/pix", pinned: true })).status, 200);
  assert.equal((await patch(app, { kind: "project", key: "/etc", pinned: true })).status, 403);
  assert.equal((await patch(app, { kind: "project", key: "repos/rel", pinned: true })).status, 400);
  assert.equal(seam.calls.length, 1);
});

test("sessiond down ⇒ 503 before body parsing; seam errors map to the fixed surface", async () => {
  const down = fakeSeam({ down: true });
  const downApp = appWith(down);
  assert.equal((await patch(downApp, { kind: "session", key: "s1", pinned: true })).status, 503);
  assert.equal((await get(downApp)).status, 503);
  assert.equal(down.calls.length, 0);

  const notFound = appWith(fakeSeam({ set: () => { throw Object.assign(new Error("nf"), { code: "not_found" }); } }));
  assert.equal((await patch(notFound, { kind: "session", key: "gone", pinned: true })).status, 404);
  const conflict = appWith(fakeSeam({ set: () => { throw Object.assign(new Error("c"), { code: "conflict" }); } }));
  assert.equal((await patch(conflict, { kind: "session", key: "s1", pinned: true })).status, 409);
  const invalid = appWith(fakeSeam({ set: () => { throw Object.assign(new Error("i"), { code: "invalid_input" }); } }));
  assert.equal((await patch(invalid, { kind: "session", key: "s1", pinned: true })).status, 400);
});
