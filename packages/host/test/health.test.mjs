import assert from "node:assert/strict";
import test from "node:test";
import {
  createHostApp,
  resolveCapabilities,
  defaultReadonlyCapabilities,
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

test("health reports sessiond up with full capabilities", async () => {
  const app = appWith({ sessiond: { isAvailable: async () => true } });
  const res = await app.request("http://localhost/v1/health", { headers: { host: "localhost" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, "pix-host");
  assert.equal(body.sessiond, "up");
  assert.deepEqual(body.capabilities, ["agent", "files", "files.write", "files.watch", "files.upload", "git", "worktree"]);
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
