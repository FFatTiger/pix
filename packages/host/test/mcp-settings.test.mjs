import { tempDir } from "./canon-tmp.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import { createHostApp, createAllowedRootService, resolveCapabilities } from "../dist/index.js";

const DISABLED_GATE = { read: () => ({ status: "disabled", source: "test" }) };
const temporary = [];
function temp(prefix) {
  const value = tempDir(prefix);
  temporary.push(value);
  return value;
}
test.afterEach(() => {
  while (temporary.length) rmSync(temporary.pop(), { recursive: true, force: true });
});

const SNAPSHOT = {
  servers: [
    {
      name: "github",
      valid: true,
      invalidReason: null,
      kind: "http",
      enabled: true,
      command: null,
      args: null,
      env: null,
      cwd: null,
      url: "https://example.com/mcp",
      headers: { Authorization: { redacted: false, value: "${GITHUB_TOKEN}" }, "X-Api-Key": { redacted: true } },
      timeout: 60,
      description: "GitHub tools",
      status: { state: "connected", tools: [{ name: "search_issues", description: "Search issues" }], error: null, stderrTail: [], probedAt: 1 },
    },
    {
      name: "broken",
      valid: false,
      invalidReason: 'legacy "sse" transport is not supported',
      kind: null,
      enabled: true,
      command: null,
      args: null,
      env: null,
      cwd: null,
      url: null,
      headers: null,
      timeout: null,
      description: null,
      status: { state: "unknown", tools: [], error: null, stderrTail: [], probedAt: null },
    },
  ],
};

const PREVIEW = {
  entries: [
    { name: "docs", valid: true, invalidReason: null, overwrite: false, kind: "http" },
    { name: "bad", valid: false, invalidReason: "sse", overwrite: true, kind: null },
  ],
};

function fakeMcpSeam(impl = {}) {
  const calls = [];
  const seam = {
    readSettings: async () => (impl.readSettings ? impl.readSettings() : SNAPSHOT),
    upsertServer: async (input) => { calls.push(["upsert", input]); return impl.upsertServer ? impl.upsertServer(input) : SNAPSHOT; },
    setEnabled: async (name, input) => { calls.push(["setEnabled", name, input]); return impl.setEnabled ? impl.setEnabled(name, input) : SNAPSHOT; },
    removeServer: async (name) => { calls.push(["remove", name]); return impl.removeServer ? impl.removeServer(name) : SNAPSHOT; },
    importPreview: async (input) => { calls.push(["preview", input]); return impl.importPreview ? impl.importPreview(input) : PREVIEW; },
    importServers: async (input) => { calls.push(["import", input]); return impl.importServers ? impl.importServers(input) : SNAPSHOT; },
    testServer: async (name, input) => { calls.push(["test", name, input]); return impl.testServer ? impl.testServer(name, input) : SNAPSHOT; },
  };
  seam.__calls = calls;
  return seam;
}

async function mcpApp(impl) {
  const root = temp("pix-mcp-routes-");
  const roots = await createAllowedRootService({ roots: [root], allowLocalExpansion: false, allowLanExpansion: false });
  const seam = fakeMcpSeam(impl);
  const app = createHostApp({ logger: {}, gate: { config: DISABLED_GATE }, catalogs: { roots, mcpSettings: seam } }).app;
  return { app, seam };
}

const call = (app, path) => app.request(`http://localhost${path}`, { headers: { host: "localhost" } });
const body = (app, path, method, payload) => app.request(`http://localhost${path}`, {
  method,
  headers: { host: "localhost", "content-type": "application/json" },
  body: JSON.stringify(payload),
});

test("mcp routes do not mount without the seam", async () => {
  const root = temp("pix-mcp-noseam-");
  const roots = await createAllowedRootService({ roots: [root], allowLocalExpansion: false, allowLanExpansion: false });
  const app = createHostApp({ logger: {}, gate: { config: DISABLED_GATE }, catalogs: { roots } }).app;
  assert.equal((await call(app, "/v1/settings/mcp")).status, 404);
  assert.equal((await call(app, "/v1/settings/mcp/servers")).status, 404);
});

test("the mcpSettings seam advertises the mcp.configure token", async () => {
  const root = temp("pix-mcp-cap-");
  const roots = await createAllowedRootService({ roots: [root], allowLocalExpansion: false, allowLanExpansion: false });
  const withSeam = await resolveCapabilities({ catalogs: { roots, mcpSettings: fakeMcpSeam() } });
  assert.ok(withSeam.capabilities.includes("mcp.configure"));
  const withoutSeam = await resolveCapabilities({ catalogs: { roots } });
  assert.ok(!withoutSeam.capabilities.includes("mcp.configure"));
});

test("GET /v1/settings/mcp returns the strict snapshot; query params are rejected", async () => {
  const { app } = await mcpApp();
  const res = await call(app, "/v1/settings/mcp");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.servers.length, 2);
  assert.deepEqual(data.servers[0].headers["X-Api-Key"], { redacted: true });
  assert.equal((await call(app, "/v1/settings/mcp?x=1")).status, 400);
});

test("a malformed seam snapshot fails closed to 503, never raw data", async () => {
  const { app } = await mcpApp({ readSettings: async () => ({ servers: [{ name: "x", leak: true }] }) });
  const res = await call(app, "/v1/settings/mcp");
  assert.equal(res.status, 503);
  const data = await res.json();
  assert.equal(data.code, "MCP_SETTINGS_UNAVAILABLE");
});

test("POST /servers validates the body strictly and forwards the parsed write", async () => {
  const { app, seam } = await mcpApp();
  const ok = await body(app, "/v1/settings/mcp/servers", "POST", {
    name: "filesystem",
    kind: "stdio",
    command: "npx",
    args: ["-y", "server-filesystem"],
    env: { KEY: { mode: "replace", value: "${SOME_VAR}" } },
    timeout: 30,
  });
  assert.equal(ok.status, 200);
  assert.equal(seam.__calls[0][0], "upsert");
  assert.deepEqual(seam.__calls[0][1].env.KEY, { mode: "replace", value: "${SOME_VAR}" });

  for (const bad of [
    { name: "x", kind: "sse" },
    { name: "x", kind: "http", url: "https://a", extra: 1 },
    { name: "x", kind: "stdio", command: "npx", timeout: 0 },
    { name: "x", kind: "stdio", command: "npx", env: { K: { mode: "replace", value: "" } } },
    { kind: "stdio", command: "npx" },
  ]) {
    const res = await body(app, "/v1/settings/mcp/servers", "POST", bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal((await res.json()).code, "INVALID_MCP_INPUT");
  }
});

test("PUT /servers/:name requires the body name to match the path", async () => {
  const { app, seam } = await mcpApp();
  const ok = await body(app, "/v1/settings/mcp/servers/filesystem", "PUT", { name: "filesystem", kind: "stdio", command: "npx" });
  assert.equal(ok.status, 200);
  const mismatch = await body(app, "/v1/settings/mcp/servers/other", "PUT", { name: "filesystem", kind: "stdio", command: "npx" });
  assert.equal(mismatch.status, 400);
  assert.equal(seam.__calls.filter((call_) => call_[0] === "upsert").length, 1);
});

test("server names are validated before any seam call", async () => {
  const { app, seam } = await mcpApp();
  assert.equal((await body(app, "/v1/settings/mcp/servers/bad%2Fname", "PATCH", { enabled: false })).status, 400);
  assert.equal((await body(app, "/v1/settings/mcp/servers/ok", "PATCH", { enabled: "yes" })).status, 400);
  assert.equal((await body(app, "/v1/settings/mcp/servers/ok", "DELETE")).status, 200);
  const names = seam.__calls.map((call_) => call_[1]);
  assert.deepEqual(names, ["ok"]);
});

test("seam errors map honestly: invalid_input 400, not_found 404, else sanitized 503", async () => {
  const invalid = { code: "invalid_input", message: "secret path /Users/x", retryable: false };
  const missing = { code: "not_found", message: "nope", retryable: false };
  const boom = new Error("raw stack with /Users/proxy/secret");
  const { app } = await mcpApp({
    upsertServer: async () => { throw invalid; },
    setEnabled: async () => { throw missing; },
    removeServer: async () => { throw boom; },
  });
  const upsert = await body(app, "/v1/settings/mcp/servers", "POST", { name: "a", kind: "stdio", command: "x" });
  assert.equal(upsert.status, 400);
  assert.equal((await upsert.json()).message, "Invalid MCP configuration");
  const patch = await body(app, "/v1/settings/mcp/servers/a", "PATCH", { enabled: false });
  assert.equal(patch.status, 404);
  const del = await body(app, "/v1/settings/mcp/servers/a", "DELETE");
  assert.equal(del.status, 503);
  const delBody = await del.json();
  assert.equal(delBody.message, "MCP settings are unavailable");
  assert.ok(!JSON.stringify(delBody).includes("/Users/proxy"));
});

test("test endpoint forwards refresh and rate-limits a tight loop", async () => {
  const { app, seam } = await mcpApp();
  const first = await body(app, "/v1/settings/mcp/servers/github/test", "POST", { refresh: true });
  assert.equal(first.status, 200);
  assert.deepEqual(seam.__calls[0], ["test", "github", { refresh: true }]);
  // 60 probes per window: the 61st is rejected without reaching the seam.
  let lastStatus = 200;
  for (let index = 0; index < 59; index++) {
    lastStatus = (await body(app, "/v1/settings/mcp/servers/github/test", "POST", { refresh: false })).status;
  }
  assert.equal(lastStatus, 200);
  const limited = await body(app, "/v1/settings/mcp/servers/github/test", "POST", { refresh: false });
  assert.equal(limited.status, 429);
  assert.equal(seam.__calls.filter((call_) => call_[0] === "test").length, 60);
});

test("import preview and import validate the payload and project strictly", async () => {
  const { app, seam } = await mcpApp();
  const preview = await body(app, "/v1/settings/mcp/import-preview", "POST", { json: '{"mcpServers":{"docs":{"url":"https://x"}}}' });
  assert.equal(preview.status, 200);
  assert.deepEqual(await preview.json(), PREVIEW);
  const imported = await body(app, "/v1/settings/mcp/import", "POST", { json: '{"docs":{"url":"https://x"}}' });
  assert.equal(imported.status, 200);
  assert.equal((await imported.json()).servers.length, 2);

  for (const bad of [{}, { json: "" }, { json: "[]", extra: 1 }]) {
    const res = await body(app, "/v1/settings/mcp/import", "POST", bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  // An invalid_input from the seam (invalid entry) surfaces as the fixed 400.
  const rejected = await mcpApp({ importServers: async () => { throw { code: "invalid_input", message: "bad entry", retryable: false }; } });
  const res = await body(rejected.app, "/v1/settings/mcp/import", "POST", { json: '{"bad":{"type":"sse"}}' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "INVALID_MCP_INPUT");
});
