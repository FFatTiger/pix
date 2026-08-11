import assert from "node:assert/strict";
import test, { beforeEach, afterEach } from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostApp } from "../dist/index.js";

let distDir;
let app;

function writeFixture(file, content) {
  const full = join(distDir, file);
  mkdirSync(join(distDir, file.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  distDir = mkdtempSync(join(tmpdir(), "pi-web-host-static-"));
  writeFixture("index.html", "<html><body>PI WEB SPA</body></html>");
  writeFixture("sw.js", "self.addEventListener('install', () => {});");
  writeFixture("manifest.webmanifest", '{"name":"pi-web"}');
  writeFixture("offline.html", "<html>offline</html>");
  writeFixture("assets/app-abc123.js", "console.log('app');");
  writeFixture("icons/icon-192.png", "PNGDATA");
  app = createHostApp({
    logger: {},
    clientDist: distDir,
    gate: { config: { read: () => ({ status: "disabled", source: "test" }) } },
  }).app;
});

afterEach(() => {
  rmSync(distDir, { recursive: true, force: true });
});

test("login shell and every referenced Vite asset load before authentication", async () => {
  writeFixture(
    "index.html",
    '<html><script type="module" src="/assets/app-abc123.js"></script><link rel="stylesheet" href="/assets/app-abc123.css"></html>',
  );
  writeFixture("assets/app-abc123.css", "body { color: black; }");
  const enabled = createHostApp({
    logger: {},
    clientDist: distDir,
    gate: {
      config: { read: () => ({ status: "enabled", password: "secret", source: "test" }) },
    },
  }).app;
  const login = await enabled.request("http://localhost/login", {
    headers: { host: "localhost", accept: "text/html" },
  });
  assert.equal(login.status, 200);
  const html = await login.text();
  const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(references.sort(), ["/assets/app-abc123.css", "/assets/app-abc123.js"]);
  for (const asset of references) {
    const res = await enabled.request(`http://localhost${asset}`, { headers: { host: "localhost" } });
    assert.equal(res.status, 200, asset);
  }
  for (const lookalike of ["/assets.evil/app.js", "/assetsx/app.js"]) {
    const res = await enabled.request(`http://localhost${lookalike}`, { headers: { host: "localhost" } });
    assert.equal(res.status, 302, lookalike);
  }
});

test("/assets/* files are served with immutable cache", async () => {
  const res = await app.request("http://localhost/assets/app-abc123.js", {
    headers: { host: "localhost" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(await res.text(), "console.log('app');");
});

test("sw.js / manifest / offline.html are served with no-cache", async () => {
  for (const path of ["/sw.js", "/manifest.webmanifest", "/offline.html"]) {
    const res = await app.request(`http://localhost${path}`, {
      headers: { host: "localhost" },
    });
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("cache-control"), "no-cache", path);
  }
});

test("index.html fallback is no-cache", async () => {
  const res = await app.request("http://localhost/", { headers: { host: "localhost" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-cache");
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
});

test("API 404 returns JSON, never index.html", async () => {
  const res = await app.request("http://localhost/v1/does-not-exist", {
    headers: { host: "localhost", accept: "text/html" },
  });
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const text = await res.text();
  const body = JSON.parse(text);
  assert.equal(body.code, "NOT_FOUND");
  assert.equal(body.message, "Not Found");
  assert.ok(!text.includes("PI WEB SPA"));
});

test("SPA fallback serves index.html for HTML-accepting GETs", async () => {
  const res = await app.request("http://localhost/workstation/session/abc", {
    headers: { host: "localhost", accept: "text/html" },
  });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /PI WEB SPA/);
});

test("SPA fallback is restricted to GET and HEAD", async () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const res = await app.request("http://localhost/workstation/session/abc", {
      method,
      headers: { host: "localhost", accept: "text/html" },
    });
    assert.equal(res.status, 404, method);
    assert.ok(!(await res.text()).includes("PI WEB SPA"));
  }
  const head = await app.request("http://localhost/workstation/session/abc", {
    method: "HEAD",
    headers: { host: "localhost", accept: "text/html" },
  });
  assert.equal(head.status, 200);
});

test("non-HTML unknown paths get plain 404 (no SPA fallback)", async () => {
  const res = await app.request("http://localhost/some.file", {
    headers: { host: "localhost", accept: "application/json" },
  });
  assert.equal(res.status, 404);
  assert.equal(await res.text(), "Not Found");
});

test("path traversal attempts are rejected", async () => {
  for (const path of ["/..%2f..%2fetc%2fpasswd", "/%2e%2e/%2e%2e/etc/passwd", "/a/..%2f..%2f..%2fetc/passwd", "/%00"]) {
    const res = await app.request(`http://localhost${path}`, {
      headers: { host: "localhost", accept: "application/json" },
    });
    assert.equal(res.status, 404, `traversal ${path} must 404`);
  }
  // Raw `..` segments are collapsed by URL normalization before reaching the
  // filesystem resolver, so they can never escape the client root.
  const res = await app.request("http://localhost/../../etc/passwd", {
    headers: { host: "localhost", accept: "application/json" },
  });
  assert.equal(res.status, 404);
  assert.ok(!(await res.text()).includes("root:x"));
});

test("static server rejects symlink escapes, broken symlinks, and symlinked index", async () => {
  const outside = mkdtempSync(join(tmpdir(), "pi-web-host-outside-"));
  try {
    writeFileSync(join(outside, "secret.txt"), "DO NOT SERVE");
    symlinkSync(join(outside, "secret.txt"), join(distDir, "assets", "secret.txt"));
    symlinkSync(outside, join(distDir, "linked-dir"), "dir");
    symlinkSync(join(outside, "missing.txt"), join(distDir, "assets", "broken.txt"));
    for (const path of ["/assets/secret.txt", "/linked-dir/secret.txt", "/assets/broken.txt"]) {
      const res = await app.request(`http://localhost${path}`, {
        headers: { host: "localhost", accept: "application/json" },
      });
      assert.equal(res.status, 404, path);
      assert.ok(!(await res.text()).includes("DO NOT SERVE"));
    }

    rmSync(join(distDir, "index.html"));
    symlinkSync(join(outside, "secret.txt"), join(distDir, "index.html"));
    const symlinkedIndexApp = createHostApp({
      logger: {},
      clientDist: distDir,
      gate: { config: { read: () => ({ status: "disabled", source: "test" }) } },
    }).app;
    const fallback = await symlinkedIndexApp.request("http://localhost/deep", {
      headers: { host: "localhost", accept: "text/html" },
    });
    assert.equal(fallback.status, 404);
    assert.ok(!(await fallback.text()).includes("DO NOT SERVE"));
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("unknown static file falls through to SPA/404, never a directory listing", async () => {
  const res = await app.request("http://localhost/nope.js", {
    headers: { host: "localhost", accept: "text/html" },
  });
  assert.equal(res.status, 200); // SPA fallback for HTML accept
  assert.match(await res.text(), /PI WEB SPA/);
});

test("HEAD requests work without a body", async () => {
  const res = await app.request("http://localhost/assets/app-abc123.js", {
    method: "HEAD",
    headers: { host: "localhost" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
});
