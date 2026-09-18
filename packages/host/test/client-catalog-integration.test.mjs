// D3B Client Catalog UI — HTTP integration against the real Host catalog routes.
//
// Pins the Host-side contract the Client Catalog dock depends on, end to end
// through the real Hono app + allowed-roots authority + catalog projectors:
//
//   1. capability honesty: catalog tokens only when seams are mounted;
//   2. exact Host shapes for models/providers/status/skills/plugins/commands/trust;
//   3. cwd required for project endpoints; providers global;
//   4. no mutation routes for D3B domains.
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
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

function fakeModels() {
  return {
    listModels: async () => [
      { id: "gpt", provider: "openai", displayName: "GPT", thinking: true, contextWindow: 128000 },
    ],
    getDefaultModel: async () => ({ id: "gpt", provider: "openai" }),
  };
}

function fakeCredentials() {
  return {
    listProviders: async () => [{ id: "openai", name: "OpenAI", methods: ["apiKey", "oauth"] }],
    getProviderStatus: async (id) => ({ providerId: id, authorized: true, accountName: "u@example.com" }),
    isConfigured: async () => true,
  };
}

function fakeResources() {
  return {
    forCwd() {
      return {
        listSkills: async () => [{ name: "ship", enabled: true, version: "1.0.0", updateAvailable: true }],
        listPlugins: async () => [{ name: "demo", enabled: false, version: "0.1" }],
        listCommands: async () => [{ name: "ship", source: "skill", description: "Ship it" }],
      };
    },
  };
}

function fakeTrust() {
  return {
    getProjectTrustState: async () => "trusted",
    isTrusted: async () => true,
    canReloadResources: async () => ({ allowed: true, level: "trusted" }),
  };
}

async function fixture(withCatalogs = true) {
  const root = temp("pix-client-cat-");
  mkdirSync(join(root, "src"), { recursive: true });
  const allowedRoots = await createAllowedRootService({ roots: [root] });
  const catalogs = withCatalogs
    ? {
        roots: allowedRoots,
        models: fakeModels(),
        credentials: fakeCredentials(),
        resources: fakeResources(),
        trust: fakeTrust(),
      }
    : { roots: allowedRoots };
  const host = createHostApp({
    logger: {},
    gate,
    exposureMode: "local",
    resources: { allowedRoots },
    sessiond: { isAvailable: async () => false },
    capabilities: { full: PRODUCTION_FULL_CAPABILITIES, readonly: RESOURCE_DEGRADED_CAPABILITIES },
    catalogs,
  });
  return { root, app: host.app };
}

test("capability projection advertises catalog tokens only when catalogs mounted", async () => {
  const withCat = await fixture(true);
  const res = await withCat.app.request("http://localhost/v1/capabilities", { headers: headers() });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.sessiond, "down");
  for (const token of ["models", "auth.providers", "skills", "plugins"]) {
    assert.ok(body.capabilities.includes(token), `expected ${token}`);
  }
  assert.ok(!body.capabilities.includes("agent"));

  const without = await fixture(false);
  const res2 = await without.app.request("http://localhost/v1/capabilities", { headers: headers() });
  const body2 = await res2.json();
  for (const token of ["models", "auth.providers", "skills", "plugins"]) {
    assert.ok(!body2.capabilities.includes(token), `unexpected ${token}`);
  }
});

test("Host catalog shapes match Client strict schemas", async () => {
  const { root, app } = await fixture(true);
  const cwd = encodeURIComponent(root);

  const models = await app.request("http://localhost/v1/models", { headers: headers() });
  assert.equal(models.status, 200);
  assert.equal(models.headers.get("cache-control"), "no-store");
  const modelsBody = await models.json();
  assert.deepEqual(Object.keys(modelsBody).sort(), ["defaultModel", "models"]);
  assert.equal(Array.isArray(modelsBody.models), true);
  assert.deepEqual(modelsBody.defaultModel, { id: "gpt", provider: "openai" });
  assert.equal(modelsBody.models[0].displayName, "GPT");
  // No legacy Next fields.
  assert.equal(modelsBody.modelList, undefined);
  assert.equal(modelsBody.thinkingLevels, undefined);

  const providers = await app.request("http://localhost/v1/auth/providers", { headers: headers() });
  assert.equal(providers.status, 200);
  const providersBody = await providers.json();
  assert.deepEqual(Object.keys(providersBody), ["providers"]);
  assert.equal(providersBody.providers[0].id, "openai");

  const status = await app.request("http://localhost/v1/auth/providers/openai/status", { headers: headers() });
  assert.equal(status.status, 200);
  const statusBody = await status.json();
  assert.deepEqual(Object.keys(statusBody).sort(), ["configured", "status"]);
  assert.equal(statusBody.configured, true);
  assert.equal(statusBody.status.providerId, "openai");
  assert.equal(statusBody.status.authorized, true);

  const skills = await app.request(`http://localhost/v1/skills?cwd=${cwd}`, { headers: headers() });
  assert.equal(skills.status, 200);
  const skillsBody = await skills.json();
  assert.deepEqual(Object.keys(skillsBody), ["skills"]);
  assert.equal(skillsBody.skills[0].name, "ship");

  const plugins = await app.request(`http://localhost/v1/plugins?cwd=${cwd}`, { headers: headers() });
  assert.equal(plugins.status, 200);
  const pluginsBody = await plugins.json();
  assert.deepEqual(Object.keys(pluginsBody), ["plugins"]);

  const commands = await app.request(`http://localhost/v1/commands?cwd=${cwd}`, { headers: headers() });
  assert.equal(commands.status, 200);
  const commandsBody = await commands.json();
  assert.deepEqual(Object.keys(commandsBody), ["commands"]);
  assert.equal(commandsBody.commands[0].source, "skill");

  const trust = await app.request(`http://localhost/v1/trust?cwd=${cwd}`, { headers: headers() });
  assert.equal(trust.status, 200);
  const trustBody = await trust.json();
  assert.deepEqual(Object.keys(trustBody).sort(), ["canReloadResources", "cwd", "level", "trusted"]);
  assert.equal(trustBody.level, "trusted");
  assert.equal(trustBody.trusted, true);
  assert.equal(trustBody.canReloadResources.allowed, true);
});

test("project catalog endpoints require cwd; models and providers are global", async () => {
  const { app } = await fixture(true);
  for (const path of ["/v1/skills", "/v1/plugins", "/v1/commands", "/v1/trust"]) {
    const res = await app.request(`http://localhost${path}`, { headers: headers() });
    assert.equal(res.status, 400, path);
    const body = await res.json();
    assert.equal(body.code, "CWD_REQUIRED");
  }
  const models = await app.request("http://localhost/v1/models", { headers: headers() });
  assert.equal(models.status, 200);
  const legacyModels = await app.request("http://localhost/v1/models?cwd=%2Flegacy", { headers: headers() });
  assert.equal(legacyModels.status, 400);
  assert.equal((await legacyModels.json()).code, "INVALID_QUERY");
  const providers = await app.request("http://localhost/v1/auth/providers", { headers: headers() });
  assert.equal(providers.status, 200);
});

test("D3B catalog mutation paths are not mounted", async () => {
  const { root, app } = await fixture(true);
  const attempts = [
    ["POST", "/v1/models-config"],
    ["PUT", "/v1/models-config"],
    ["POST", "/v1/models-config/discover"],
    ["POST", "/v1/models-config/test"],
    ["POST", "/v1/skills/install"],
    ["POST", "/v1/skills/update"],
    ["PATCH", "/v1/skills"],
    ["POST", "/v1/plugins"],
    ["GET", "/v1/auth/all-providers"],
    ["POST", `/v1/auth/api-key/openai`],
    ["POST", `/v1/auth/login/openai`],
    ["POST", `/v1/auth/logout/openai`],
  ];
  for (const [method, path] of attempts) {
    const res = await app.request(`http://localhost${path}`, {
      method,
      headers: headers({ "content-type": "application/json" }),
      body: method === "GET" ? undefined : "{}",
    });
    assert.ok(res.status === 404 || res.status === 405, `${method} ${path} => ${res.status}`);
  }
  // Sanity: read path still works.
  const ok = await app.request("http://localhost/v1/models", { headers: headers() });
  assert.equal(ok.status, 200);
});
