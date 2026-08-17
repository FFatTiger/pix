import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostApp, createNodeServer } from "../dist/index.js";

// Reproducible client-shaped fixture: index.html referencing hashed Vite assets,
// plus the PWA files the real Vite client emits (manifest, sw.js, offline page,
// icons). This proves the host can serve a real client dist; the shape mirrors
// packages/client/dist exactly. Using a fixture keeps the host test independent
// of client build order and fully deterministic.
let distDir;
let baseUrl;
let handle;

before(async () => {
  distDir = mkdtempSync(join(tmpdir(), "pix-host-client-integration-"));
  const write = (rel, content) => {
    const full = join(distDir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  };
  write(
    "index.html",
    '<!doctype html><html><head><link rel="stylesheet" href="/assets/index-deadbeef.css">' +
      '<link rel="manifest" href="/manifest.webmanifest"></head>' +
      '<body><div id="root"></div>' +
      '<script type="module" src="/assets/index-deadbeef.js"></script></body></html>',
  );
  write("assets/index-deadbeef.js", 'console.log("pix client boot");');
  write("assets/index-deadbeef.css", "body{font-family:sans-serif}");
  write("sw.js", "self.addEventListener('install',()=>{});");
  write("manifest.webmanifest", '{"name":"pix","start_url":"/"}');
  write("offline.html", "<html><body>offline</body></html>");
  write("icons/icon-192.png", "PNGDATA");

  const host = createHostApp({
    logger: {},
    exposureMode: "local",
    clientDist: distDir,
    // M1 boot composition: gate disabled, no sessiond, no resources → honest
    // empty capability.
    gate: { config: { read: () => ({ status: "disabled", source: "integration" }) } },
  });
  handle = await createNodeServer(host, { port: 0, hostname: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${handle.port}`;
});

after(async () => {
  await handle.close();
  rmSync(distDir, { recursive: true, force: true });
});

test("index.html is served with correct content-type and no-cache", async () => {
  const res = await fetch(`${baseUrl}/`, { headers: { accept: "text/html" } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(res.headers.get("cache-control"), "no-cache");
  const html = await res.text();
  assert.match(html, /id="root"/);
  assert.match(html, /\/assets\/index-deadbeef\.js/);
});

test("hashed Vite asset is served with immutable cache", async () => {
  const res = await fetch(`${baseUrl}/assets/index-deadbeef.js`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.match(await res.text(), /pix client boot/);
});

test("service worker / manifest / offline are served with no-cache", async () => {
  for (const path of ["/sw.js", "/manifest.webmanifest", "/offline.html"]) {
    const res = await fetch(`${baseUrl}${path}`);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("cache-control"), "no-cache", path);
  }
});

test("/v1/health is available over HTTP", async () => {
  const res = await fetch(`${baseUrl}/v1/health`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, "pix-host");
  assert.deepEqual(body.capabilities, []);
});

test("/v1/capabilities is available over HTTP", async () => {
  const res = await fetch(`${baseUrl}/v1/capabilities`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.capabilities, []);
});

test("/v1/bootstrap is available over HTTP and aggregates the boot surface", async () => {
  const res = await fetch(`${baseUrl}/v1/bootstrap`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, "pix-host");
  const { HOST_BOOTSTRAP_SCHEMA_VERSION } = await import("@fffattiger/pix-protocol/host-bootstrap");
  assert.equal(body.protocolVersion, HOST_BOOTSTRAP_SCHEMA_VERSION);
  assert.equal(body.protocolVersion, 1);
  assert.equal(body.sessiond, "unknown");
  assert.deepEqual(body.capabilities, []);
  assert.equal(body.mode, "local");
  assert.deepEqual(body.gate, { required: false, status: "disabled" });
});

test("SPA deep link falls back to index.html", async () => {
  const res = await fetch(`${baseUrl}/workstation/session/abc`, {
    headers: { accept: "text/html" },
  });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /id="root"/);
});

test("unimplemented /v1/sessions returns JSON 404, never index.html", async () => {
  const res = await fetch(`${baseUrl}/v1/sessions`, { headers: { accept: "text/html" } });
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const body = await res.json();
  assert.equal(body.code, "NOT_FOUND");
});
