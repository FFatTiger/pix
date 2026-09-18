import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import {
  createHostApp,
  createAllowedRootService,
  mapCatalogError,
  CATALOG_UNAVAILABLE_MESSAGE,
  CATALOG_CAPABILITIES,
  resolveCapabilities,
} from "../dist/index.js";

const DISABLED_GATE = { read: () => ({ status: "disabled", source: "test" }) };
const temporary = [];
function temp(prefix) {
  const value = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(value);
  return value;
}
test.afterEach(() => {
  while (temporary.length) rmSync(temporary.pop(), { recursive: true, force: true });
});

const call = (app, path) =>
  app.request(`http://localhost${path}`, { headers: { host: "localhost" } });

async function rootsFor(...dirs) {
  return createAllowedRootService({
    roots: dirs,
    allowLocalExpansion: false,
    allowLanExpansion: false,
  });
}

function fakeModels(impl = {}) {
  return {
    listModels: async () =>
      impl.listModels ? impl.listModels() : [{ id: "m1", provider: "p" }],
    getDefaultModel: async () =>
      impl.getDefaultModel ? impl.getDefaultModel() : { id: "m1", provider: "p" },
  };
}

function fakeModelsMutation(impl = {}) {
  const snapshot = {
    revision: "0".repeat(64),
    providers: [],
    availableProviders: [],
  };
  return {
    readConfig: async () => impl.readConfig ? impl.readConfig() : snapshot,
    writeConfig: async (input) => impl.writeConfig ? impl.writeConfig(input) : snapshot,
    discoverModels: async (input) => impl.discoverModels ? impl.discoverModels(input) : [{ id: "m1" }],
  };
}

function fakeSettingsMutation(impl = {}) {
  const snapshot = { revision: "5".repeat(64), content: '{\n  "defaultProvider": "acme-gpt",\n}\n' };
  return {
    readConfig: async () => impl.readConfig ? impl.readConfig() : snapshot,
    writeConfig: async (input) => impl.writeConfig ? impl.writeConfig(input) : { revision: "6".repeat(64), content: input.content },
  };
}

function fakeCredentials(impl = {}) {
  return {
    listProviders: async () =>
      impl.listProviders ? impl.listProviders() : [{ id: "anthropic", methods: ["apiKey"] }],
    getProviderStatus: async (id) =>
      impl.getProviderStatus
        ? impl.getProviderStatus(id)
        : { providerId: id, authorized: false },
    isConfigured: async (id) =>
      impl.isConfigured ? impl.isConfigured(id) : false,
  };
}

function fakeThemes(impl = {}) {
  return {
    forCwd(cwd, trusted) {
      return {
        listThemeSets: async () =>
          impl.listSets
            ? impl.listSets(cwd, trusted)
            : [{ name: "gruvbox", displayName: "Gruvbox", hasDark: true, hasLight: true, builtin: true }],
        resolveTheme: async () => {
          if (impl.resolveTheme) return impl.resolveTheme();
          const error = new Error("not found");
          error.code = "not_found";
          throw error;
        },
      };
    },
  };
}

function fakeResources(impl = {}) {
  const seen = [];
  return {
    seen,
    forCwd(cwd, trusted) {
      seen.push({ cwd, trusted });
      return {
        listSkills: async () =>
          impl.listSkills ? impl.listSkills(cwd, trusted) : [{ name: "s", enabled: true }],
        listPlugins: async () =>
          impl.listPlugins ? impl.listPlugins(cwd, trusted) : [{ name: "pl", enabled: true }],
        listCommands: async () =>
          impl.listCommands
            ? impl.listCommands(cwd, trusted)
            : [{ name: "c", source: "prompt" }],
      };
    },
  };
}

function fakeTrust(impl = {}) {
  return {
    getProjectTrustState: async (cwd) =>
      impl.getProjectTrustState ? impl.getProjectTrustState(cwd) : "unknown",
    isTrusted: async (cwd) => (impl.isTrusted ? impl.isTrusted(cwd) : false),
    canReloadResources: async (cwd) =>
      impl.canReloadResources
        ? impl.canReloadResources(cwd)
        : { allowed: false, level: "unknown", reason: "project is not trusted" },
  };
}

function appWithCatalogs(catalogs, extra = {}) {
  return createHostApp({
    logger: {},
    gate: { config: DISABLED_GATE },
    catalogs,
    ...extra,
  }).app;
}

// ---------------------------------------------------------------------------
// happy path + no-store + canonical cwd
// ---------------------------------------------------------------------------

test("GET /v1/models is global (no cwd), returns models + defaultModel, no-store", async () => {
  const root = temp("pix-cat-models-");
  const roots = await rootsFor(root);
  const models = fakeModels();
  const app = appWithCatalogs({ roots, models });
  const res = await call(app, "/v1/models");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.deepEqual(body.models, [{ id: "m1", provider: "p" }]);
  assert.deepEqual(body.defaultModel, { id: "m1", provider: "p" });

  const legacy = await call(app, `/v1/models?cwd=${encodeURIComponent(root)}`);
  assert.equal(legacy.status, 400);
  assert.equal((await legacy.json()).code, "INVALID_QUERY");
});

test("GET/PUT /v1/models/config are global, strict, credential-blind, and capability-gated", async () => {
  const root = temp("pix-cat-model-config-");
  const roots = await rootsFor(root);
  const seen = [];
  const revision = "a".repeat(64);
  const snapshot = {
    revision,
    providers: [{
      sourceId: "custom",
      id: "custom",
      baseUrl: "http://127.0.0.1:9000/v1",
      api: "openai-completions",
      apiKeyConfigured: true,
      modelsDefined: true,
      models: [{ sourceIndex: 0, id: "m1", reasoning: true }],
      apiKey: "sk-MUST-NOT-LEAK",
    }],
    availableProviders: [{ id: "anthropic", name: "Anthropic", methods: ["oauth", "apiKey"], modelCount: 4 }],
    secret: "sk-MUST-NOT-LEAK",
  };
  const app = appWithCatalogs({
    roots,
    modelsMutation: fakeModelsMutation({
      readConfig: async () => snapshot,
      writeConfig: async (input) => { seen.push(input); return snapshot; },
    }),
  });
  const get = await call(app, "/v1/models/config");
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("cache-control"), "no-store");
  const getBody = await get.json();
  assert.equal(JSON.stringify(getBody).includes("MUST-NOT-LEAK"), false);
  assert.equal(getBody.providers[0].apiKeyConfigured, true);

  const discoverInput = {
    expectedRevision: revision,
    sourceId: "custom",
    providerId: "custom",
    baseUrl: "http://127.0.0.1:9000/v1",
    api: "openai-completions",
    apiKey: "sk-one-way-input",
  };
  const discovered = await app.request("http://localhost/v1/models/discover", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify(discoverInput),
  });
  assert.equal(discovered.status, 200);
  assert.deepEqual(await discovered.json(), { models: [{ id: "m1" }] });

  const input = {
    expectedRevision: revision,
    providers: [{
      sourceId: "custom",
      id: "renamed",
      baseUrl: "http://127.0.0.1:9000/v1",
      api: "openai-completions",
      apiKey: { mode: "preserve" },
      modelsDefined: true,
      models: [{ sourceIndex: 0, id: "m1", reasoning: true }],
    }],
  };
  const put = await app.request("http://localhost/v1/models/config", {
    method: "PUT",
    headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  assert.equal(put.status, 200);
  assert.deepEqual(seen, [input]);
  assert.equal(JSON.stringify(await put.json()).includes("MUST-NOT-LEAK"), false);

  const query = await call(app, "/v1/models/config?");
  assert.equal(query.status, 400);
  assert.equal((await query.json()).code, "INVALID_QUERY");
  const extra = await app.request("http://localhost/v1/models/config", {
    method: "PUT",
    headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ ...input, extra: true }),
  });
  assert.equal(extra.status, 400);
  assert.equal((await extra.json()).code, "INVALID_MODELS_CONFIG");

  const health = await call(app, "/v1/health");
  assert.ok((await health.json()).capabilities.includes("models.configure"));
});

test("PUT /v1/models/config maps stale revisions to a fixed conflict", async () => {
  const root = temp("pix-cat-model-conflict-");
  const roots = await rootsFor(root);
  const conflict = new Error("secret stale path /tmp/private");
  conflict.code = "conflict";
  const app = appWithCatalogs({
    roots,
    modelsMutation: fakeModelsMutation({ writeConfig: async () => { throw conflict; } }),
  });
  const res = await app.request("http://localhost/v1/models/config", {
    method: "PUT",
    headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: "0".repeat(64), providers: [] }),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, "CONFLICT");
  assert.equal(JSON.stringify(body).includes("private"), false);
});

test("GET/PUT /v1/settings/config round-trip raw text with strict body rules and capability token", async () => {
  const root = temp("pix-cat-settings-config-");
  const roots = await rootsFor(root);
  let written;
  const app = appWithCatalogs({
    roots,
    settingsMutation: fakeSettingsMutation({ writeConfig: async (input) => { written = input; return { revision: "6".repeat(64), content: input.content }; } }),
  });

  const get = await call(app, "/v1/settings/config");
  assert.equal(get.status, 200);
  const body = await get.json();
  assert.equal(body.revision, "5".repeat(64));
  assert.ok(body.content.includes("defaultProvider"));
  assert.equal(get.headers.get("cache-control"), "no-store");

  const put = await app.request("http://localhost/v1/settings/config", {
    method: "PUT",
    headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: body.revision, content: '{\n  // comment preserved\n  "defaultProvider": "acme-grok",\n}\n' }),
  });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).revision, "6".repeat(64));
  assert.ok(written.content.includes("// comment preserved"));

  for (const bad of [
    { expectedRevision: body.revision, content: "" },
    { expectedRevision: "nothex", content: "{}" },
    { expectedRevision: body.revision, content: "{}", extra: 1 },
  ]) {
    const res = await app.request("http://localhost/v1/settings/config", {
      method: "PUT",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify(bad),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "INVALID_SETTINGS_CONFIG");
  }

  const query = await call(app, "/v1/settings/config?x=1");
  assert.equal(query.status, 400);
  assert.equal((await query.json()).code, "INVALID_QUERY");

  const health = await call(app, "/v1/health");
  assert.ok((await health.json()).capabilities.includes("settings.configure"));

  const bare = appWithCatalogs({ roots });
  const missing = await call(bare, "/v1/settings/config");
  assert.equal(missing.status, 404);
  const bareHealth = await call(bare, "/v1/health");
  assert.equal((await bareHealth.json()).capabilities.includes("settings.configure"), false);
});

test("PUT /v1/settings/config maps stale revisions to a fixed conflict", async () => {
  const root = temp("pix-cat-settings-conflict-");
  const roots = await rootsFor(root);
  const conflict = new Error("secret stale path /tmp/private");
  conflict.code = "conflict";
  const app = appWithCatalogs({
    roots,
    settingsMutation: fakeSettingsMutation({ writeConfig: async () => { throw conflict; } }),
  });
  const res = await app.request("http://localhost/v1/settings/config", {
    method: "PUT",
    headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: "0".repeat(64), content: "{}" }),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, "CONFLICT");
  assert.equal(JSON.stringify(body).includes("private"), false);
});

test("GET /v1/auth/providers and status are global (no cwd) and no-store", async () => {
  const root = temp("pix-cat-auth-");
  const roots = await rootsFor(root);
  const credentials = fakeCredentials({
    async isConfigured(id) {
      return id === "anthropic";
    },
  });
  const app = appWithCatalogs({ roots, credentials });
  const list = await call(app, "/v1/auth/providers");
  assert.equal(list.status, 200);
  assert.equal(list.headers.get("cache-control"), "no-store");
  assert.deepEqual(await list.json(), {
    providers: [{ id: "anthropic", methods: ["apiKey"] }],
  });
  const status = await call(app, "/v1/auth/providers/anthropic/status");
  assert.equal(status.status, 200);
  assert.equal(status.headers.get("cache-control"), "no-store");
  assert.deepEqual(await status.json(), {
    status: { providerId: "anthropic", authorized: false },
    configured: true,
  });
});

test("GET /v1/skills|plugins|commands pass trusted from trust seam", async () => {
  const root = temp("pix-cat-res-");
  const roots = await rootsFor(root);
  const resources = fakeResources();
  const trust = fakeTrust({ isTrusted: async () => true });
  const app = appWithCatalogs({ roots, resources, trust });
  const canonical = await realpath(root);
  for (const path of ["/v1/skills", "/v1/plugins", "/v1/commands"]) {
    const res = await call(app, `${path}?cwd=${encodeURIComponent(root)}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
  }
  assert.equal(resources.seen.length, 3);
  for (const entry of resources.seen) {
    assert.equal(entry.cwd, canonical);
    assert.equal(entry.trusted, true);
  }
});

test("GET /v1/trust returns canonical cwd, level, trusted, canReloadResources", async () => {
  const root = temp("pix-cat-trust-");
  const roots = await rootsFor(root);
  const trust = fakeTrust({
    getProjectTrustState: async () => "trusted",
    isTrusted: async () => true,
    canReloadResources: async () => ({ allowed: true, level: "trusted" }),
  });
  const app = appWithCatalogs({ roots, trust });
  const res = await call(app, `/v1/trust?cwd=${encodeURIComponent(root)}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.equal(body.cwd, await realpath(root));
  assert.equal(body.level, "trusted");
  assert.equal(body.trusted, true);
  assert.deepEqual(body.canReloadResources, { allowed: true, level: "trusted" });
});

// ---------------------------------------------------------------------------
// cwd authorization: missing / relative / out-of-root / nonexistent
// ---------------------------------------------------------------------------

test("missing cwd → 400 CWD_REQUIRED on project routes", async () => {
  const root = temp("pix-cat-cwd-");
  const roots = await rootsFor(root);
  const app = appWithCatalogs({
    roots,
    models: fakeModels(),
    resources: fakeResources(),
    trust: fakeTrust(),
  });
  for (const path of ["/v1/skills", "/v1/plugins", "/v1/commands", "/v1/trust"]) {
    const res = await call(app, path);
    assert.equal(res.status, 400, path);
    const body = await res.json();
    assert.equal(body.code, "CWD_REQUIRED");
  }
  // Models are a GLOBAL catalog (agent-dir config): no cwd contract at all.
  const models = await call(app, "/v1/models");
  assert.equal(models.status, 200);
});

test("relative cwd → 400 INVALID_PATH", async () => {
  const root = temp("pix-cat-rel-");
  const roots = await rootsFor(root);
  const app = appWithCatalogs({ roots, resources: fakeResources(), trust: fakeTrust() });
  const res = await call(app, "/v1/skills?cwd=relative/path");
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, "INVALID_PATH");
});

test("out-of-root cwd → 403", async () => {
  const root = temp("pix-cat-out-");
  const other = temp("pix-cat-out2-");
  const roots = await rootsFor(root);
  const app = appWithCatalogs({ roots, resources: fakeResources(), trust: fakeTrust() });
  const res = await call(app, `/v1/skills?cwd=${encodeURIComponent(other)}`);
  assert.equal(res.status, 403);
});

test("nonexistent cwd → 404 PATH_NOT_FOUND", async () => {
  const root = temp("pix-cat-miss-");
  const roots = await rootsFor(root);
  const app = appWithCatalogs({ roots, resources: fakeResources(), trust: fakeTrust() });
  const missing = join(root, "no-such-dir");
  const res = await call(app, `/v1/skills?cwd=${encodeURIComponent(missing)}`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.code, "PATH_NOT_FOUND");
});

// ---------------------------------------------------------------------------
// error mapping + secret/path sanitization
// ---------------------------------------------------------------------------

test("mapCatalogError ports RuntimeError codes", () => {
  const notFound = mapCatalogError({ code: "not_found", message: "x", retryable: false }, "provider");
  assert.equal(notFound.status, 404);
  assert.equal(notFound.code, "PROVIDER_NOT_FOUND");
  assert.equal(notFound.message, "Provider not found");

  const invalid = mapCatalogError({ code: "invalid_input", message: "x", retryable: false }, "model");
  assert.equal(invalid.status, 400);
  assert.equal(invalid.code, "INVALID_INPUT");

  const unavailable = mapCatalogError({ code: "external", message: "x", retryable: false }, "skill");
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.code, "CATALOG_UNAVAILABLE");
  assert.equal(unavailable.message, CATALOG_UNAVAILABLE_MESSAGE);

  const unknown = mapCatalogError(new Error("boom /secret/path sk-abc"), "model");
  assert.equal(unknown.status, 503);
  assert.equal(unknown.message, CATALOG_UNAVAILABLE_MESSAGE);
  assert.ok(!unknown.message.includes("secret"));
  assert.ok(!unknown.message.includes("sk-"));
});

test("route surfaces sanitized 404/400/503; never leaks secret/path markers", async () => {
  const root = temp("pix-cat-err-");
  const roots = await rootsFor(root);
  const SECRET = "sk-live-SUPERSECRET-marker";
  const PATH_MARKER = "/Users/secret/agent-dir/leak";

  const models = fakeModels({
    listModels: async () => {
      throw { code: "not_found", message: `missing at ${PATH_MARKER} key=${SECRET}`, retryable: false };
    },
  });
  const credentials = fakeCredentials({
    getProviderStatus: async () => {
      throw { code: "invalid_input", message: `bad ${SECRET} at ${PATH_MARKER}`, retryable: false };
    },
  });
  const resources = fakeResources({
    listSkills: async () => {
      throw new Error(`external boom ${SECRET} path=${PATH_MARKER}`);
    },
  });
  const app = appWithCatalogs({ roots, models, credentials, resources, trust: fakeTrust() });

  const m = await call(app, "/v1/models");
  assert.equal(m.status, 404);
  const mBody = await m.json();
  assert.equal(mBody.code, "MODEL_NOT_FOUND");
  assert.ok(!JSON.stringify(mBody).includes(SECRET));
  assert.ok(!JSON.stringify(mBody).includes(PATH_MARKER));

  const p = await call(app, "/v1/auth/providers/x/status");
  assert.equal(p.status, 400);
  const pBody = await p.json();
  assert.equal(pBody.code, "INVALID_INPUT");
  assert.ok(!JSON.stringify(pBody).includes(SECRET));

  const s = await call(app, `/v1/skills?cwd=${encodeURIComponent(root)}`);
  assert.equal(s.status, 503);
  const sBody = await s.json();
  assert.equal(sBody.code, "CATALOG_UNAVAILABLE");
  assert.equal(sBody.message, CATALOG_UNAVAILABLE_MESSAGE);
  assert.ok(!JSON.stringify(sBody).includes(SECRET));
  assert.ok(!JSON.stringify(sBody).includes(PATH_MARKER));
});

// ---------------------------------------------------------------------------
// conditional registration + capability honesty
// ---------------------------------------------------------------------------

test("missing models seam: no /v1/models route and no models token", async () => {
  const root = temp("pix-cat-cond-");
  const roots = await rootsFor(root);
  const app = appWithCatalogs({
    roots,
    credentials: fakeCredentials(),
  });
  const res = await call(app, "/v1/models");
  // SPA/JSON 404 — route not registered
  assert.equal(res.status, 404);
  const health = await call(app, "/v1/health");
  const body = await health.json();
  assert.ok(!body.capabilities.includes("models"));
  assert.ok(body.capabilities.includes("auth.providers"));
});

test("missing resources seam: no skills/plugins/commands routes", async () => {
  const root = temp("pix-cat-nores-");
  const roots = await rootsFor(root);
  const app = appWithCatalogs({
    roots,
    models: fakeModels(),
    trust: fakeTrust(),
  });
  for (const path of ["/v1/skills", "/v1/plugins", "/v1/commands"]) {
    const res = await call(app, `${path}?cwd=${encodeURIComponent(root)}`);
    assert.equal(res.status, 404, path);
  }
  // trust is independent and still mounts
  const trust = await call(app, `/v1/trust?cwd=${encodeURIComponent(root)}`);
  assert.equal(trust.status, 200);
  const health = await call(app, "/v1/health");
  const body = await health.json();
  assert.ok(body.capabilities.includes("models"));
  assert.ok(!body.capabilities.includes("skills"));
  assert.ok(!body.capabilities.includes("plugins"));
});

test("catalog caps stay advertised when sessiond is down", async () => {
  const root = temp("pix-cat-down-");
  const roots = await rootsFor(root);
  const catalogs = {
    roots,
    models: fakeModels(),
    modelsMutation: fakeModelsMutation(),
    credentials: fakeCredentials(),
    resources: fakeResources(),
    themes: fakeThemes(),
    trust: fakeTrust(),
    trustMutation: { setTrusted: async () => ({ cwd: "x", level: "trusted" }) },
    settingsMutation: fakeSettingsMutation(),
  };
  const { sessiond, capabilities } = await resolveCapabilities({
    catalogs,
    sessiond: { isAvailable: async () => false },
  });
  assert.equal(sessiond, "down");
  for (const token of CATALOG_CAPABILITIES) {
    assert.ok(capabilities.includes(token), `missing ${token}`);
  }
  assert.ok(!capabilities.includes("agent"));
  assert.ok(!capabilities.includes("sessions"));
});

test("generic M1 no deps still empty capabilities", async () => {
  const { sessiond, capabilities } = await resolveCapabilities({});
  assert.equal(sessiond, "unknown");
  assert.deepEqual(capabilities, []);
});

test("catalog-only deps never invent agent/files tokens", async () => {
  const root = temp("pix-cat-only-");
  const roots = await rootsFor(root);
  const { capabilities } = await resolveCapabilities({
    catalogs: {
      roots,
      models: fakeModels(),
      credentials: fakeCredentials(),
      resources: fakeResources(),
    },
    sessiond: { isAvailable: async () => true },
  });
  assert.deepEqual([...capabilities].sort(), ["auth.providers", "models", "plugins", "skills"].sort());
});

test("resources without trust defaults trusted=false for skill listing", async () => {
  const root = temp("pix-cat-notrust-");
  const roots = await rootsFor(root);
  const resources = fakeResources();
  const app = appWithCatalogs({ roots, resources });
  await call(app, `/v1/skills?cwd=${encodeURIComponent(root)}`);
  assert.equal(resources.seen[0].trusted, false);
});

// ---------------------------------------------------------------------------
// Strict projectors: strip extras / reject malicious success payloads
// ---------------------------------------------------------------------------

const SECRET = "sk-live-SUPERSECRET-marker";
const PATH_MARKER = "/Users/secret/agent-dir/leak";
const STACK_MARKER = "at Object.catalog (/secret/stack.js:1:1)";

function assertNoMarkers(body) {
  const payload = JSON.stringify(body);
  assert.ok(!payload.includes(SECRET), "secret marker leaked");
  assert.ok(!payload.includes(PATH_MARKER), "path marker leaked");
  assert.ok(!payload.includes(STACK_MARKER), "stack marker leaked");
  assert.ok(!payload.includes("apiKey"), "apiKey field leaked");
  assert.ok(!payload.includes("Bearer "), "Bearer token leaked");
  assert.ok(!payload.includes("sourceInfo"), "sourceInfo leaked");
}

test("projectors keep only allowed model fields and drop extras", async () => {
  const root = temp("pix-cat-proj-model-");
  const roots = await rootsFor(root);
  const models = fakeModels({
    listModels: async () => [
      {
        id: "m1",
        provider: "p",
        displayName: "M",
        thinking: true,
        contextWindow: 128,
        apiKey: SECRET,
        path: PATH_MARKER,
        nested: { token: SECRET },
      },
    ],
    getDefaultModel: async () => ({
      id: "m1",
      provider: "p",
      apiKey: SECRET,
      toJSON() {
        return { id: "m1", provider: "p", secret: SECRET };
      },
    }),
  });
  const app = appWithCatalogs({ roots, models });
  const res = await call(app, "/v1/models");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.models, [
    { id: "m1", provider: "p", displayName: "M", thinking: true, contextWindow: 128 },
  ]);
  assert.deepEqual(body.defaultModel, { id: "m1", provider: "p" });
  assertNoMarkers(body);
});

test("projectors drop sourceInfo and reject invalid command source", async () => {
  const root = temp("pix-cat-proj-cmd-");
  const roots = await rootsFor(root);
  const resources = fakeResources({
    listCommands: async () => [
      {
        name: "ok",
        source: "prompt",
        description: "d",
        sourceInfo: { path: PATH_MARKER, token: SECRET, stack: STACK_MARKER },
      },
    ],
  });
  const app = appWithCatalogs({ roots, resources });
  const res = await call(app, `/v1/commands?cwd=${encodeURIComponent(root)}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.commands, [{ name: "ok", source: "prompt", description: "d" }]);
  assertNoMarkers(body);

  const bad = appWithCatalogs({
    roots,
    resources: fakeResources({
      listCommands: async () => [{ name: "x", source: "evil", sourceInfo: { path: PATH_MARKER } }],
    }),
  });
  const badRes = await call(bad, `/v1/commands?cwd=${encodeURIComponent(root)}`);
  assert.equal(badRes.status, 503);
  assertNoMarkers(await badRes.json());
});

test("malicious success shapes (proxy/getter/cyclic/nested) map to fixed 503", async () => {
  const root = temp("pix-cat-mal-");
  const roots = await rootsFor(root);
  const logs = [];
  const logger = {
    error(message) {
      logs.push(String(message));
    },
    warn(message) {
      logs.push(String(message));
    },
  };

  const cyclic = { id: "m", provider: "p" };
  cyclic.self = cyclic;

  const getterModel = {};
  Object.defineProperty(getterModel, "id", {
    enumerable: true,
    get() {
      throw new Error(`boom ${SECRET} ${PATH_MARKER}\n${STACK_MARKER}`);
    },
  });
  Object.defineProperty(getterModel, "provider", { enumerable: true, value: "p" });

  const proxyModel = new Proxy(
    { id: "m", provider: "p" },
    {
      get(target, prop) {
        if (prop === "apiKey") return SECRET;
        if (prop === "id" || prop === "provider") return target[prop];
        throw new Error(`proxy leak ${PATH_MARKER}`);
      },
      ownKeys() {
        return ["id", "provider", "apiKey"];
      },
      getOwnPropertyDescriptor(target, prop) {
        if (prop === "apiKey") return { configurable: true, enumerable: true, value: SECRET };
        return Object.getOwnPropertyDescriptor(target, prop);
      },
    },
  );

  // Extras / cyclic / nested secrets: projector keeps only allowed fields (200, clean).
  for (const [label, payload] of [
    ["cyclic", [cyclic]],
    ["nested-secret", [{ id: "m", provider: "p", headers: { Authorization: `Bearer ${SECRET}` }, path: PATH_MARKER }]],
  ]) {
    const app = createHostApp({
      logger,
      gate: { config: DISABLED_GATE },
      catalogs: {
        roots,
        models: fakeModels({ listModels: async () => payload, getDefaultModel: async () => null }),
      },
    }).app;
    const res = await call(app, "/v1/models");
    assert.equal(res.status, 200, label);
    const body = await res.json();
    assert.deepEqual(body.models, [{ id: "m", provider: "p" }], label);
    assertNoMarkers(body);
  }

  // Getter throw / proxy throw on optional probe / invalid type / toJSON-only → fixed 503.
  for (const [label, payload] of [
    ["getter", [getterModel]],
    ["proxy", [proxyModel]],
    ["invalid-context", [{ id: "m", provider: "p", contextWindow: -1 }]],
    ["toJSON-only-junk", [{ toJSON: () => ({ id: "m", provider: "p", apiKey: SECRET }) }]],
  ]) {
    const app = createHostApp({
      logger,
      gate: { config: DISABLED_GATE },
      catalogs: {
        roots,
        models: fakeModels({ listModels: async () => payload, getDefaultModel: async () => null }),
      },
    }).app;
    const res = await call(app, "/v1/models");
    assert.equal(res.status, 503, label);
    const body = await res.json();
    assert.equal(body.code, "CATALOG_UNAVAILABLE");
    assertNoMarkers(body);
  }

  const joined = logs.join("\n");
  assert.ok(!joined.includes(SECRET), "logger saw secret");
  assert.ok(!joined.includes(PATH_MARKER), "logger saw path");
  assert.ok(!joined.includes(STACK_MARKER), "logger saw stack");
});

test("sparse catalog arrays fail closed instead of encoding holes as null", async () => {
  const root = temp("pix-cat-sparse-");
  const roots = await rootsFor(root);

  const sparseModels = [];
  sparseModels[1] = { id: "m", provider: "p" };
  const modelsApp = appWithCatalogs({
    roots,
    models: fakeModels({
      listModels: async () => sparseModels,
      getDefaultModel: async () => null,
    }),
  });
  const modelsRes = await call(
    modelsApp,
    "/v1/models",
  );
  assert.equal(modelsRes.status, 503);
  assert.equal((await modelsRes.json()).code, "CATALOG_UNAVAILABLE");

  const sparseProviders = new Array(2);
  const credentialsApp = appWithCatalogs({
    roots,
    credentials: fakeCredentials({ listProviders: async () => sparseProviders }),
  });
  const providersRes = await call(credentialsApp, "/v1/auth/providers");
  assert.equal(providersRes.status, 503);
  assert.equal((await providersRes.json()).code, "CATALOG_UNAVAILABLE");

  const sparseSkills = [];
  sparseSkills.length = 1;
  const resourcesApp = appWithCatalogs({
    roots,
    resources: fakeResources({ listSkills: async () => sparseSkills }),
  });
  const skillsRes = await call(
    resourcesApp,
    `/v1/skills?cwd=${encodeURIComponent(root)}`,
  );
  assert.equal(skillsRes.status, 503);
  const skillsBody = await skillsRes.json();
  assert.equal(skillsBody.code, "CATALOG_UNAVAILABLE");
  assert.ok(!JSON.stringify(skillsBody).includes("null"));
});

test("provider status drops extra secret fields; configured must be boolean", async () => {
  const root = temp("pix-cat-status-");
  const roots = await rootsFor(root);
  const credentials = fakeCredentials({
    getProviderStatus: async (id) => ({
      providerId: id,
      authorized: true,
      accountName: "a",
      expiresAt: 1,
      apiKey: SECRET,
      token: SECRET,
      headers: { Authorization: `Bearer ${SECRET}` },
      path: PATH_MARKER,
    }),
    isConfigured: async () => true,
  });
  const app = appWithCatalogs({ roots, credentials });
  const res = await call(app, "/v1/auth/providers/anthropic/status");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, {
    status: { providerId: "anthropic", authorized: true, accountName: "a", expiresAt: 1 },
    configured: true,
  });
  assertNoMarkers(body);
});

test("trust reason is fixed; free-form backend reason never forwarded", async () => {
  const root = temp("pix-cat-trust-reason-");
  const roots = await rootsFor(root);
  const trust = fakeTrust({
    getProjectTrustState: async () => "denied",
    isTrusted: async () => false,
    canReloadResources: async () => ({
      allowed: false,
      level: "denied",
      reason: `raw ${SECRET} at ${PATH_MARKER}`,
    }),
  });
  const app = appWithCatalogs({ roots, trust });
  const res = await call(app, `/v1/trust?cwd=${encodeURIComponent(root)}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.level, "denied");
  assert.equal(body.canReloadResources.allowed, false);
  assert.equal(body.canReloadResources.reason, "Project resources are not trusted");
  assertNoMarkers(body);
});

test("trust.isTrusted throw on skills/plugins/commands → 503; logger has no raw", async () => {
  const root = temp("pix-cat-trust-throw-");
  const roots = await rootsFor(root);
  const logs = [];
  const logger = {
    error(message) {
      logs.push(String(message));
    },
  };
  const trust = fakeTrust({
    isTrusted: async () => {
      throw new Error(`trust fail ${SECRET} ${PATH_MARKER}\n${STACK_MARKER}`);
    },
  });
  const resources = fakeResources();
  const app = createHostApp({
    logger,
    gate: { config: DISABLED_GATE },
    catalogs: { roots, resources, trust },
  }).app;
  for (const path of ["/v1/skills", "/v1/plugins", "/v1/commands"]) {
    const res = await call(app, `${path}?cwd=${encodeURIComponent(root)}`);
    assert.equal(res.status, 503, path);
    const body = await res.json();
    assert.equal(body.code, "CATALOG_UNAVAILABLE");
    assertNoMarkers(body);
  }
  const joined = logs.join("\n");
  assert.ok(!joined.includes(SECRET));
  assert.ok(!joined.includes(PATH_MARKER));
  assert.ok(!joined.includes(STACK_MARKER));
});

// ---------------------------------------------------------------------------
// Capability honesty: explicit overrides cannot lie about catalog seams
// ---------------------------------------------------------------------------

test("explicit full override advertising catalog tokens without seams is stripped", async () => {
  const { capabilities } = await resolveCapabilities({
    sessiond: { isAvailable: async () => true },
    capabilities: {
      full: ["agent", "models", "auth.providers", "skills", "plugins"],
      readonly: [],
    },
    // no catalogs mounted
  });
  assert.deepEqual([...capabilities], ["agent"]);
  assert.ok(!capabilities.includes("models"));
  assert.ok(!capabilities.includes("skills"));
});

test("explicit override omitting catalog tokens still advertises mounted seams", async () => {
  const root = temp("pix-cat-override-");
  const roots = await rootsFor(root);
  const { capabilities } = await resolveCapabilities({
    catalogs: {
      roots,
      models: fakeModels(),
      credentials: fakeCredentials(),
      resources: fakeResources(),
    },
    sessiond: { isAvailable: async () => true },
    capabilities: {
      full: ["agent", "files"], // deliberately omits catalog tokens
      readonly: ["files"],
    },
  });
  assert.deepEqual(
    [...capabilities],
    ["agent", "files", "models", "auth.providers", "skills", "plugins"],
  );
});
