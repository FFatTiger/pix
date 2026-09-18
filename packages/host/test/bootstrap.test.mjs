import assert from "node:assert/strict";
import test from "node:test";
import { createHostApp, HOST_PROTOCOL_VERSION } from "../dist/index.js";

const DISABLED_GATE = { read: () => ({ status: "disabled", source: "test" }) };
const ENABLED_GATE = {
  read: () => ({ status: "enabled", password: "secret", source: "test" }),
};

function appWith(extra = {}) {
  return createHostApp({
    logger: {},
    gate: { config: DISABLED_GATE },
    ...extra,
  }).app;
}

test("bootstrap is served with no-store and aggregates the boot surface", async () => {
  const app = appWith({});
  const res = await app.request("http://localhost/v1/bootstrap", { headers: { host: "localhost" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, "pix-host");
  assert.equal(body.protocolVersion, HOST_PROTOCOL_VERSION);
  assert.equal(body.protocolVersion, 1);
  assert.equal(body.sessiond, "unknown");
  // Nothing wired → honest empty capability (no false agent/files claim).
  assert.deepEqual(body.capabilities, []);
  assert.equal(body.mode, "local");
  assert.deepEqual(body.gate, { required: false, status: "disabled" });
});

test("bootstrap reflects sessiond up with honest empty capabilities when nothing is mounted", async () => {
  // Generic default is honest: sessiond up alone never invents agent/files/etc.
  const app = appWith({ sessiond: { isAvailable: async () => true } });
  const res = await app.request("http://localhost/v1/bootstrap", { headers: { host: "localhost" } });
  const body = await res.json();
  assert.equal(body.sessiond, "up");
  assert.deepEqual(body.capabilities, []);
});

test("bootstrap reports gate required when enabled", async () => {
  const app = createHostApp({
    logger: {},
    exposureMode: "local",
    gate: { config: ENABLED_GATE },
  }).app;
  const res = await app.request("http://localhost/v1/bootstrap", { headers: { host: "localhost" } });
  const body = await res.json();
  assert.deepEqual(body.gate, { required: true, status: "enabled" });
});

test("bootstrap reports mode lan and required gate for LAN exposure", async () => {
  const app = createHostApp({
    logger: {},
    exposureMode: "lan",
    gate: { config: DISABLED_GATE },
  }).app;
  const res = await app.request("http://localhost/v1/bootstrap", { headers: { host: "localhost" } });
  const body = await res.json();
  assert.equal(body.mode, "lan");
  // LAN always requires a gate even when auth is explicitly disabled (D-020).
  assert.deepEqual(body.gate, { required: true, status: "disabled" });
});

test("bootstrap advertises read-only files when resources are mounted but sessiond is down", async () => {
  const app = appWith({
    sessiond: { isAvailable: async () => false },
    capabilities: { readonly: ["files"] },
  });
  const res = await app.request("http://localhost/v1/bootstrap", { headers: { host: "localhost" } });
  const body = await res.json();
  assert.equal(body.sessiond, "down");
  assert.deepEqual(body.capabilities, ["files"]);
});
