import assert from "node:assert/strict";
import test from "node:test";
import {
  createHostApp,
  HttpError,
  resolveCapabilities,
  defaultReadonlyCapabilities,
  normalizeSessionMutationCapabilities,
  PRODUCTION_FULL_CAPABILITIES,
  RESOURCE_DEGRADED_CAPABILITIES,
  READONLY_HOST_CAPABILITIES,
} from "../dist/index.js";

const DISABLED_GATE = { read: () => ({ status: "disabled", source: "test" }) };

function appWith(extra = {}) {
  return createHostApp({
    logger: {},
    gate: { config: DISABLED_GATE },
    ...extra,
  }).app;
}

test("health reports sessiond up with honest empty capabilities when nothing is mounted", async () => {
  // Generic default is honest: sessiond up alone never invents agent/files/etc.
  // Production composition passes explicit full/readonly capability sets.
  const app = appWith({ sessiond: { isAvailable: async () => true } });
  const res = await app.request("http://localhost/v1/health", { headers: { host: "localhost" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, "pix-host");
  assert.equal(body.sessiond, "up");
  assert.deepEqual(body.capabilities, []);
});

test("health reports sessiond down with empty capabilities when nothing is wired (honest M1 default)", async () => {
  const app = appWith({ sessiond: { isAvailable: async () => false } });
  const res = await app.request("http://localhost/v1/health", { headers: { host: "localhost" } });
  const body = await res.json();
  assert.equal(body.sessiond, "down");
  assert.deepEqual(body.capabilities, []);
});

test("no sessiond probe wired → unknown + empty capabilities (honest default, no false agent/files)", async () => {
  const app = appWith({});
  const res = await app.request("http://localhost/v1/health", { headers: { host: "localhost" } });
  const body = await res.json();
  assert.equal(body.sessiond, "unknown");
  assert.deepEqual(body.capabilities, []);
});

test("capabilities endpoint mirrors health projection", async () => {
  const app = appWith({ sessiond: { isAvailable: async () => false } });
  const res = await app.request("http://localhost/v1/capabilities", { headers: { host: "localhost" } });
  const body = await res.json();
  assert.deepEqual(body, {
    ok: true,
    sessiond: "down",
    capabilities: [],
  });
});

test("custom capability sets are respected", async () => {
  const app = appWith({
    sessiond: { isAvailable: async () => true },
    capabilities: { full: ["agent", "git"], readonly: ["files"] },
  });
  const res = await app.request("http://localhost/v1/health", { headers: { host: "localhost" } });
  const body = await res.json();
  assert.deepEqual(body.capabilities, ["agent", "git"]);
});

test("defaultReadonlyCapabilities is empty without resources, files only with resources wired", async () => {
  assert.deepEqual(defaultReadonlyCapabilities({}), []);
  // A truthy resources mount advertises read-only file browsing only.
  assert.deepEqual(
    defaultReadonlyCapabilities({ resources: { allowedRoots: {} } }),
    READONLY_HOST_CAPABILITIES,
  );
});

test("resolveCapabilities advertises read-only files when resources are wired but sessiond is down", async () => {
  const { sessiond, capabilities } = await resolveCapabilities({
    resources: { allowedRoots: {} },
    sessiond: { isAvailable: async () => false },
  });
  assert.equal(sessiond, "down");
  assert.deepEqual(capabilities, ["files"]);
});

test("probe errors degrade to empty (read-only) capabilities", async () => {
  const app = appWith({
    sessiond: { isAvailable: async () => { throw new Error("boom"); } },
  });
  const res = await app.request("http://localhost/v1/health", { headers: { host: "localhost" } });
  const body = await res.json();
  assert.equal(body.sessiond, "down");
  assert.deepEqual(body.capabilities, []);
});

test("probe timeout degrades to empty (read-only) capabilities", async () => {
  const app = appWith({
    sessiondProbeTimeoutMs: 20,
    sessiond: { isAvailable: () => new Promise(() => {}) },
  });
  const started = Date.now();
  const res = await app.request("http://localhost/v1/health", { headers: { host: "localhost" } });
  const body = await res.json();
  assert.equal(body.sessiond, "down");
  assert.deepEqual(body.capabilities, []);
  assert.ok(Date.now() - started < 500, "probe timeout must bound request latency");
});

test("request id header is echoed on responses", async () => {
  const app = appWith({ sessiond: { isAvailable: async () => true } });
  const res = await app.request("http://localhost/v1/health", { headers: { host: "localhost" } });
  const requestId = res.headers.get("x-request-id");
  assert.ok(requestId && requestId.length >= 16, "x-request-id must be present");
});

test("a wired capabilityResolver is authoritative: routes consume its seam-normalized output over raw deps", async () => {
  // The routes must use the single resolver even when deps.capabilities names
  // unmounted-seam tokens: the resolver output is authoritative.
  let resolves = 0;
  const resolver = {
    async resolve() {
      resolves += 1;
      return { sessiond: "up", capabilities: ["agent", "files"] };
    },
  };
  const app = appWith({
    // Would advertise the mutation token if consulted directly:
    capabilities: { full: ["agent", "session.delete", "files"], readonly: ["files"] },
    sessiond: { isAvailable: async () => true },
    capabilityResolver: resolver,
  });
  const res = await app.request("http://localhost/v1/health", { headers: { host: "localhost" } });
  const body = await res.json();
  assert.deepEqual(body, { ok: true, service: "pix-host", sessiond: "up", capabilities: ["agent", "files"] });
  const boot = await (await app.request("http://localhost/v1/bootstrap", { headers: { host: "localhost" } })).json();
  assert.deepEqual(boot.capabilities, ["agent", "files"], "bootstrap consumes the same resolver");
  assert.equal(resolves, 2, "one resolve per HTTP surface");
});

test("createCapabilityResolver wraps resolveCapabilities: same output as the raw function", async () => {
  const { createCapabilityResolver } = await import("../dist/index.js");
  const deps = {
    sessiond: { isAvailable: async () => true },
    capabilities: { full: ["agent", "git"], readonly: ["files"] },
  };
  const resolver = createCapabilityResolver(deps);
  const fromResolver = await resolver.resolve();
  const direct = await resolveCapabilities(deps);
  assert.deepEqual(fromResolver, direct);
});

// ---------------------------------------------------------------------------
// D4 seam-honest capability filtering (verifier F1): a session mutation token
// is advertised ONLY when the corresponding seam is actually mounted AND
// sessiond is up. The route mount is the same source of truth.
// ---------------------------------------------------------------------------

function fakeSessionClient() {
  return {
    async list() { return { sessions: [] }; },
    async read() { return {}; },
    async context() { return { sessionId: "s", entries: [] }; },
  };
}

/** Fake mutation guard: fails closed 503 whenever the authority is down. */
function fakeGuard(down) {
  return {
    async assertAvailable() {
      if (down) throw new HttpError(503, "MUTATION_UNAVAILABLE", "Runtime authority unavailable");
    },
  };
}

function fakeDeleteSeam(down) {
  const calls = [];
  return {
    calls,
    seam: {
      client: { async delete(id) { calls.push(id); return { sessionId: id, deleted: true }; } },
      mutationGuard: fakeGuard(down),
    },
  };
}

function fakeRenameSeam(down) {
  const calls = [];
  return {
    calls,
    seam: {
      client: { async rename(id, name) { calls.push({ id, name }); return { sessionId: id, name }; } },
      mutationGuard: fakeGuard(down),
    },
  };
}

function appWithSeams({ sessiondUp, deleteSeam, renameSeam, full, readonly }) {
  const sessions = { client: fakeSessionClient() };
  if (deleteSeam) sessions.delete = deleteSeam.seam;
  if (renameSeam) sessions.rename = renameSeam.seam;
  return createHostApp({
    logger: {},
    gate: { config: DISABLED_GATE },
    sessiond: { isAvailable: async () => sessiondUp },
    capabilities: { full, readonly },
    sessions,
  }).app;
}

const caps = async (app) => (await app.request("http://localhost/v1/capabilities", { headers: { host: "localhost" } })).json();
const patch = (app, id) => app.request(`http://localhost/v1/sessions/${id}`, {
  method: "PATCH",
  headers: { host: "localhost", "content-type": "application/json" },
  body: JSON.stringify({ name: "x" }),
});
const del = (app, id) => app.request(`http://localhost/v1/sessions/${id}`, { method: "DELETE", headers: { host: "localhost" } });

const FULL = ["agent", "sessions", "session.delete", "session.write", "files"];
const READONLY = ["files"];

// Verifier F1 matrix: real createHostApp /v1/capabilities with every seam combo.
test("capabilities: up + neither seam ⇒ both mutation tokens removed; PATCH and DELETE are 404", async () => {
  const app = appWithSeams({ sessiondUp: true, full: FULL, readonly: READONLY });
  const body = await caps(app);
  assert.equal(body.sessiond, "up");
  assert.deepEqual(body.capabilities, ["agent", "sessions", "files"], "no mutation token without its seam");
  assert.equal((await patch(app, "s-1")).status, 404, "PATCH must not be mounted without the rename seam");
  assert.equal((await del(app, "s-1")).status, 404, "DELETE must not be mounted without the delete seam");
});

test("capabilities: up + rename only ⇒ session.write kept, session.delete removed; PATCH mounted, DELETE 404", async () => {
  const rename = fakeRenameSeam(false);
  const app = appWithSeams({ sessiondUp: true, renameSeam: rename, full: FULL, readonly: READONLY });
  const body = await caps(app);
  assert.deepEqual(body.capabilities, ["agent", "sessions", "session.write", "files"], "session.write advertised; session.delete removed");
  const p = await patch(app, "s-1");
  assert.equal(p.status, 200, "PATCH mounted when rename seam exists");
  assert.deepEqual(await p.json(), { success: true });
  assert.deepEqual(rename.calls, [{ id: "s-1", name: "x" }], "rename seam called once");
  assert.equal((await del(app, "s-1")).status, 404, "DELETE not mounted without the delete seam");
});

test("capabilities: up + delete only ⇒ session.delete kept, session.write removed; DELETE mounted, PATCH 404", async () => {
  const delSeam = fakeDeleteSeam(false);
  const app = appWithSeams({ sessiondUp: true, deleteSeam: delSeam, full: FULL, readonly: READONLY });
  const body = await caps(app);
  assert.deepEqual(body.capabilities, ["agent", "sessions", "session.delete", "files"], "session.delete advertised; session.write removed");
  const d = await del(app, "s-1");
  assert.equal(d.status, 200, "DELETE mounted when delete seam exists");
  assert.deepEqual(await d.json(), { success: true });
  assert.deepEqual(delSeam.calls, ["s-1"], "delete seam called once");
  assert.equal((await patch(app, "s-1")).status, 404, "PATCH not mounted without the rename seam");
});

test("capabilities: up + both seams ⇒ both tokens advertised; both routes mounted and functional", async () => {
  const delSeam = fakeDeleteSeam(false);
  const rename = fakeRenameSeam(false);
  const app = appWithSeams({ sessiondUp: true, deleteSeam: delSeam, renameSeam: rename, full: FULL, readonly: READONLY });
  const body = await caps(app);
  assert.deepEqual(body.capabilities, ["agent", "sessions", "session.delete", "session.write", "files"]);
  assert.equal((await patch(app, "s-1")).status, 200);
  assert.equal((await del(app, "s-1")).status, 200);
  assert.deepEqual(rename.calls, [{ id: "s-1", name: "x" }]);
  assert.deepEqual(delSeam.calls, ["s-1"]);
});

test("capabilities: down + both seams ⇒ both tokens excluded regardless of seams; routes fail closed 503", async () => {
  const delSeam = fakeDeleteSeam(true);
  const rename = fakeRenameSeam(true);
  const app = appWithSeams({ sessiondUp: false, deleteSeam: delSeam, renameSeam: rename, full: FULL, readonly: READONLY });
  const body = await caps(app);
  assert.equal(body.sessiond, "down");
  assert.deepEqual(body.capabilities, ["files"], "degraded/down never advertises mutation tokens");
  assert.equal((await patch(app, "s-1")).status, 503, "PATCH guard fails closed when down");
  assert.equal((await del(app, "s-1")).status, 503, "DELETE guard fails closed when down");
  assert.deepEqual(rename.calls, [], "no rename RPC while down");
  assert.deepEqual(delSeam.calls, [], "no delete RPC while down");
});

test("capabilities: down + both seams with a custom readonly list still strips both tokens", async () => {
  // Even an explicit readonly override that names the mutation tokens cannot
  // advertise them while sessiond is down.
  const app = appWithSeams({
    sessiondUp: false,
    deleteSeam: fakeDeleteSeam(true),
    renameSeam: fakeRenameSeam(true),
    full: FULL,
    readonly: [...READONLY, "session.delete", "session.write"],
  });
  const body = await caps(app);
  assert.equal(body.sessiond, "down");
  assert.deepEqual(body.capabilities, ["files"], "down projection strips mutation tokens from a custom readonly list");
});

test("capabilities: production FULL default with both seams still advertises both (unchanged production default)", async () => {
  const delSeam = fakeDeleteSeam(false);
  const rename = fakeRenameSeam(false);
  const app = appWithSeams({
    sessiondUp: true,
    deleteSeam: delSeam,
    renameSeam: rename,
    full: [...PRODUCTION_FULL_CAPABILITIES],
    readonly: [...RESOURCE_DEGRADED_CAPABILITIES],
  });
  const body = await caps(app);
  assert.ok(body.capabilities.includes("session.write"), "production full keeps session.write with the rename seam");
  assert.ok(body.capabilities.includes("session.delete"), "production full keeps session.delete with the delete seam");
});

test("normalizeSessionMutationCapabilities: only removes impossible tokens, never adds", async () => {
  const withBothSeams = { sessions: { client: fakeSessionClient(), delete: fakeDeleteSeam(false).seam, rename: fakeRenameSeam(false).seam } };
  const noSeams = { sessions: { client: fakeSessionClient() } };
  // A token absent from the input is never invented even when the seam exists.
  assert.deepEqual(normalizeSessionMutationCapabilities(["agent", "sessions"], withBothSeams), ["agent", "sessions"]);
  // Present tokens are kept when the matching seam is mounted.
  assert.deepEqual(normalizeSessionMutationCapabilities(["agent", "session.write", "files"], withBothSeams), ["agent", "session.write", "files"]);
  assert.deepEqual(normalizeSessionMutationCapabilities(["agent", "session.delete", "files"], withBothSeams), ["agent", "session.delete", "files"]);
  // Impossible tokens (seam absent) are removed; other caps untouched.
  assert.deepEqual(normalizeSessionMutationCapabilities(FULL, noSeams), ["agent", "sessions", "files"]);
  assert.deepEqual(normalizeSessionMutationCapabilities(["session.write", "session.delete", "git"], noSeams), ["git"]);
  // Read `sessions` and unrelated tokens always pass through.
  assert.deepEqual(normalizeSessionMutationCapabilities(["sessions", "files", "git", "agent"], noSeams), ["sessions", "files", "git", "agent"]);
});
