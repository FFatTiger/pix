import assert from "node:assert/strict";
import test from "node:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import {
  createHostApp,
  createAllowedRootService,
  createProductionCatalogs,
  validateCatalogAgentDir,
  InvalidCatalogAgentDirError,
  CATALOG_CAPABILITY_TOKENS,
  PRODUCTION_FULL_CAPABILITIES,
  RESOURCE_DEGRADED_CAPABILITIES,
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

/** Network guard: throws if any outbound fetch happens during the probe. */
function installNetworkGuard() {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    called = true;
    throw new Error("network access is forbidden by the read-only catalog composition");
  });
  return () => {
    globalThis.fetch = original;
    return called;
  };
}

function listFilesRecursive(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listFilesRecursive(full, acc);
    else acc.push(full);
  }
  return acc;
}

// ---------------------------------------------------------------------------
// validateCatalogAgentDir
// ---------------------------------------------------------------------------

test("validateCatalogAgentDir: empty/relative/NUL rejected with safe error", () => {
  assert.throws(() => validateCatalogAgentDir(""), InvalidCatalogAgentDirError);
  assert.throws(() => validateCatalogAgentDir("relative/agent"), InvalidCatalogAgentDirError);
  assert.throws(() => validateCatalogAgentDir("/abs\0x"), InvalidCatalogAgentDirError);
  assert.equal(validateCatalogAgentDir("/abs/agent"), "/abs/agent");
});

// ---------------------------------------------------------------------------
// production composition with real adapter
// ---------------------------------------------------------------------------

async function productionFixture() {
  const root = temp("pix-prod-cat-");
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const outside = join(root, "outside");
  const markerPath = join(root, "pwned.marker");

  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  chmodSync(agentDir, 0o700);
  mkdirSync(join(agentDir, "skills", "global-skill"), { recursive: true });
  writeFileSync(
    join(agentDir, "skills", "global-skill", "SKILL.md"),
    "---\nname: global-skill\ndescription: A global skill\n---\n# global-skill\nA global skill",
    "utf8",
  );
  mkdirSync(join(agentDir, "prompts"), { recursive: true });
  writeFileSync(join(agentDir, "prompts", "global-prompt.md"), "# global-prompt\nA prompt", "utf8");

  mkdirSync(join(project, ".pi", "skills", "proj-skill"), { recursive: true });
  writeFileSync(
    join(project, ".pi", "skills", "proj-skill", "SKILL.md"),
    "---\nname: proj-skill\ndescription: A project skill\n---\n# proj-skill\nA project skill",
    "utf8",
  );
  // Malicious extension must never execute.
  mkdirSync(join(project, ".pi", "extensions"), { recursive: true });
  writeFileSync(
    join(project, ".pi", "extensions", "evil.ts"),
    `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(markerPath)}, "executed");\n` +
      `export default function () {}\n`,
    "utf8",
  );

  // Symlink skill escape: project skill pointing outside the project root.
  mkdirSync(join(outside, "escaped-skill"), { recursive: true });
  writeFileSync(
    join(outside, "escaped-skill", "SKILL.md"),
    "---\nname: escaped-skill\ndescription: Must remain outside\n---\n# escaped",
    "utf8",
  );
  try {
    symlinkSync(join(outside, "escaped-skill"), join(project, ".pi", "skills", "escaped-link"));
  } catch {
    // Platforms without symlink support skip the escape assertion later.
  }

  // models.json: one custom provider with a LITERAL key (secret canary). The
  // global model/provider catalog must list exactly this provider and never
  // leak the key; builtin providers (ambient env keys included) stay hidden.
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "pix-e2e-proxy": {
          baseUrl: "https://pix-e2e-proxy.example.com/v1",
          api: "openai-completions",
          apiKey: "sk-live-PIX-E2E-SECRET",
          models: [{ id: "pix-e2e-model", contextWindow: 8192 }],
        },
      },
    }),
    "utf8",
  );

  const roots = await createAllowedRootService({
    roots: [project],
    allowLocalExpansion: false,
    allowLanExpansion: false,
  });
  const catalogs = createProductionCatalogs({ agentDir, roots });
  const app = createHostApp({
    logger: {},
    gate: { config: DISABLED_GATE },
    catalogs,
    capabilities: {
      full: [...PRODUCTION_FULL_CAPABILITIES],
      readonly: [...RESOURCE_DEGRADED_CAPABILITIES],
    },
  }).app;
  return { root, agentDir, project, markerPath, catalogs, app };
}

test("production catalogs: models/auth/resources/trust real adapter, no-store, zero writes", async () => {
  const { root, agentDir, project, markerPath, app } = await productionFixture();
  const before = listFilesRecursive(root).sort();
  const release = installNetworkGuard();
  const SECRET_MARKERS = ["sk-live", "api_key", "Bearer ", agentDir];

  // Models (global catalog; only the fixture's models.json provider surfaces).
  const modelsRes = await call(app, "/v1/models");
  assert.equal(modelsRes.status, 200);
  assert.equal(modelsRes.headers.get("cache-control"), "no-store");
  const modelsBody = await modelsRes.json();
  assert.ok(Array.isArray(modelsBody.models));
  assert.ok(modelsBody.models.length > 0, "models.json provider must surface");
  assert.ok(
    modelsBody.models.every((model) => model.provider === "pix-e2e-proxy"),
    "only models.json-configured providers surface (builtins hidden)",
  );
  assert.ok("defaultModel" in modelsBody);

  // Auth providers (global).
  const providersRes = await call(app, "/v1/auth/providers");
  assert.equal(providersRes.status, 200);
  assert.equal(providersRes.headers.get("cache-control"), "no-store");
  const providersBody = await providersRes.json();
  assert.ok(Array.isArray(providersBody.providers));

  // Trust: no decision recorded ⇒ unknown; project skills withheld.
  const trustRes = await call(app, `/v1/trust?cwd=${encodeURIComponent(project)}`);
  assert.equal(trustRes.status, 200);
  const trustBody = await trustRes.json();
  assert.equal(trustBody.cwd, await realpath(project));
  assert.equal(trustBody.level, "unknown");
  assert.equal(trustBody.trusted, false);
  assert.equal(trustBody.canReloadResources.allowed, false);

  const skillsRes = await call(app, `/v1/skills?cwd=${encodeURIComponent(project)}`);
  assert.equal(skillsRes.status, 200);
  const skillsBody = await skillsRes.json();
  const skillNames = skillsBody.skills.map((s) => s.name);
  assert.ok(skillNames.includes("global-skill"), "global skill always visible");
  assert.ok(!skillNames.includes("proj-skill"), "project skill withheld when untrusted");
  assert.ok(!skillNames.includes("escaped-skill"), "symlink escape skill filtered");

  // Malicious extension never executed.
  assert.equal(existsSync(markerPath), false, "malicious extension was executed");

  const networkCalled = release();
  assert.equal(networkCalled, false, "catalog reads must not hit the network");

  // Zero writes: file set under the fixture root is unchanged.
  const after = listFilesRecursive(root).sort();
  assert.deepEqual(after, before, "catalog reads must create no files");

  // Secret/path markers never appear in any body.
  for (const body of [modelsBody, providersBody, trustBody, skillsBody]) {
    const payload = JSON.stringify(body);
    for (const marker of SECRET_MARKERS) {
      // agentDir path must not leak into response bodies.
      if (marker === agentDir) {
        assert.ok(!payload.includes(agentDir), "agentDir path leaked in body");
      } else {
        assert.ok(!payload.includes(marker), `secret marker ${marker} leaked`);
      }
    }
  }
});

test("production catalogs: trusted project exposes project skill; escape still filtered", async () => {
  const { root, agentDir, project, markerPath, app } = await productionFixture();
  // Seed the real Pi SDK trust.json shape (path → boolean). Verified offline
  // against ProjectTrustStore serialization; host tests never import @earendil.
  const canonicalProject = await realpath(project);
  writeFileSync(
    join(agentDir, "trust.json"),
    JSON.stringify({ [canonicalProject]: true }),
    "utf8",
  );

  const release = installNetworkGuard();
  const trustRes = await call(app, `/v1/trust?cwd=${encodeURIComponent(project)}`);
  assert.equal(trustRes.status, 200);
  const trustBody = await trustRes.json();
  assert.equal(trustBody.level, "trusted");
  assert.equal(trustBody.trusted, true);
  assert.equal(trustBody.canReloadResources.allowed, true);
  assert.equal(trustBody.canReloadResources.level, "trusted");
  assert.equal(trustBody.canReloadResources.reason, undefined);

  const skillsRes = await call(app, `/v1/skills?cwd=${encodeURIComponent(project)}`);
  assert.equal(skillsRes.status, 200);
  const names = (await skillsRes.json()).skills.map((s) => s.name);
  assert.ok(names.includes("global-skill"));
  assert.ok(names.includes("proj-skill"), "project skill visible when trusted");
  assert.ok(!names.includes("escaped-skill"), "symlink escape skill still filtered");
  assert.equal(existsSync(markerPath), false);
  assert.equal(release(), false);
  void root;
});

test("production catalogs: malformed trust fails closed; project skills withheld", async () => {
  const { agentDir, project, app } = await productionFixture();
  writeFileSync(join(agentDir, "trust.json"), "{ this is deliberately invalid json {{{", "utf8");

  const trustRes = await call(app, `/v1/trust?cwd=${encodeURIComponent(project)}`);
  assert.equal(trustRes.status, 200);
  const trustBody = await trustRes.json();
  assert.equal(trustBody.level, "unknown");
  assert.equal(trustBody.trusted, false);
  const payload = JSON.stringify(trustBody);
  assert.ok(!payload.includes("trust.json"));
  assert.ok(!payload.includes("deliberately invalid"));
  assert.ok(!payload.includes(agentDir));

  const skillsRes = await call(app, `/v1/skills?cwd=${encodeURIComponent(project)}`);
  const names = (await skillsRes.json()).skills.map((s) => s.name);
  assert.ok(names.includes("global-skill"));
  assert.ok(!names.includes("proj-skill"), "project skill withheld under corrupt trust");
});

test("production catalogs: GET/PUT /v1/settings/built-ins persist pix-builtins.json and advertise builtins.configure", async () => {
  const { agentDir, project, app } = await productionFixture();
  chmodSync(agentDir, 0o700);
  const get = await call(app, "/v1/settings/built-ins");
  assert.equal(get.status, 200);
  const snapshot = await get.json();
  assert.deepEqual(snapshot.capabilities, [
    { id: "subagents", enabled: true },
    { id: "todo", enabled: true },
    { id: "ask_user_question", enabled: true },
    { id: "side_chat", enabled: true },
  ]);
  const health = await call(app, "/v1/health");
  assert.ok((await health.json()).capabilities.includes("builtins.configure"));

  const mixed = [
    { id: "subagents", enabled: false },
    { id: "todo", enabled: true },
    { id: "ask_user_question", enabled: false },
    { id: "side_chat", enabled: true },
  ];
  const put = await app.request("http://localhost/v1/settings/built-ins", {
    method: "PUT",
    headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: snapshot.revision, capabilities: mixed }),
  });
  assert.equal(put.status, 200);
  const saved = await put.json();
  assert.deepEqual(saved.capabilities, mixed);
  const persisted = JSON.parse(readFileSync(join(agentDir, "pix-builtins.json"), "utf8"));
  assert.deepEqual(persisted, {
    version: 1,
    subagents: false,
    todo: true,
    ask_user_question: false,
    side_chat: true,
  });
  const payload = JSON.stringify(saved);
  assert.ok(!payload.includes(agentDir));
  assert.ok(!payload.includes("pix-builtins.json"));

  const plugins = await call(app, `/v1/plugins?cwd=${encodeURIComponent(project)}`);
  assert.equal(plugins.status, 200);
  assert.ok(Array.isArray((await plugins.json()).plugins));
});

test("production catalogs: catalog tokens advertised independent of sessiond", async () => {
  const { catalogs } = await productionFixture();
  const down = await resolveCapabilities({
    catalogs,
    sessiond: { isAvailable: async () => false },
    capabilities: {
      full: [...PRODUCTION_FULL_CAPABILITIES],
      readonly: [...RESOURCE_DEGRADED_CAPABILITIES],
    },
  });
  assert.equal(down.sessiond, "down");
  for (const token of CATALOG_CAPABILITY_TOKENS) {
    assert.ok(down.capabilities.includes(token), `missing ${token} while down`);
  }
  assert.ok(!down.capabilities.includes("agent"));
  assert.ok(!down.capabilities.includes("sessions"));
});

test("createProductionCatalogs rejects non-absolute agentDir before any adapter call", () => {
  assert.throws(
    () => createProductionCatalogs({ agentDir: "relative", roots: /** @type {any} */ ({}) }),
    InvalidCatalogAgentDirError,
  );
});


test("production global resources reread persisted metadata without roots, trust, runtime, or network", async () => {
  const { root, agentDir, project, markerPath, catalogs } = await productionFixture();
  const packageDir = join(agentDir, "static-plugin");
  mkdirSync(packageDir);
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({
    name: "global-plugin", version: "1.0.0", type: "module", main: "index.js",
    pi: { extensions: ["index.js"] },
  }));
  writeFileSync(join(packageDir, "index.js"),
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(markerPath)}, "executed");`);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["./static-plugin"] }));
  symlinkSync(join(project, ".pi"), join(agentDir, ".pi"), "dir");
  writeFileSync(join(project, ".pi", "settings.json"), "{ malformed project trap");
  writeFileSync(join(agentDir, "trust.json"), "{ malformed trust trap");
  const forbidden = () => { throw new Error("global resource read consulted project/runtime"); };
  const app = createHostApp({
    logger: {}, gate: { config: DISABLED_GATE },
    catalogs: {
      roots: { authorizeExisting: forbidden },
      resources: catalogs.resources,
      trust: { isTrusted: forbidden },
    },
    sessiond: { isAvailable: forbidden },
  }).app;
  const before = listFilesRecursive(root).sort();
  const release = installNetworkGuard();
  try {
    for (const [path, names] of [
      ["skills", ["global-skill"]],
      ["commands", ["skill:global-skill"]],
      ["plugins", ["global-plugin"]],
    ]) {
      const res = await call(app, `/v1/${path}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.deepEqual((await res.json())[path].map((entry) => entry.name), names);
    }
    assert.equal(existsSync(markerPath), false);
    assert.deepEqual(listFilesRecursive(root).sort(), before, "catalog creates no files");
    // Same Host app, new reader per request: skills, settings and manifests all refresh.
    writeFileSync(join(agentDir, "skills", "global-skill", "SKILL.md"),
      "---\nname: revised-skill\ndescription: Revised skill\ndisable-model-invocation: true\n---\n# revised");
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "global-plugin", version: "2.0.0" }));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [
      "./static-plugin", { source: "npm:@fake/not-installed" },
    ] }));
    assert.deepEqual((await (await call(app, "/v1/skills")).json()).skills, [
      { name: "revised-skill", description: "Revised skill", enabled: false },
    ]);
    assert.deepEqual((await (await call(app, "/v1/commands")).json()).commands, [
      { name: "skill:revised-skill", description: "Revised skill", source: "skill" },
    ]);
    assert.deepEqual((await (await call(app, "/v1/plugins")).json()).plugins, [
      { name: "global-plugin", version: "2.0.0", enabled: true },
      { name: "npm:@fake/not-installed", enabled: false },
    ]);
    writeFileSync(join(agentDir, "settings.json"), "{ SECRET malformed global settings");
    for (const path of ["skills", "plugins", "commands"]) {
      const res = await call(app, `/v1/${path}`);
      assert.equal(res.status, 400);
      assert.equal(res.headers.get("cache-control"), "no-store");
      const body = await res.json();
      assert.equal(body.code, "INVALID_INPUT");
      assert.ok(!JSON.stringify(body).includes("SECRET"));
      assert.ok(!JSON.stringify(body).includes(agentDir));
    }
    rmSync(join(agentDir, "settings.json"));
    mkdirSync(join(agentDir, "settings.json"));
    const unavailable = await call(app, "/v1/plugins");
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).code, "CATALOG_UNAVAILABLE");
  } finally {
    assert.equal(release(), false, "no network requests");
  }
});

test("production subagent settings persist native global fields with shared revisions while daemon is down and no runtime or network work", async () => {
  const { root, agentDir, project, markerPath, catalogs } = await productionFixture();
  const settingsPath = join(agentDir, "settings.json");
  const source = JSON.stringify({ extensions: [join(project, ".pi/extensions/evil.ts")], custom: { keep: true }, subagents: {
    defaultModel: "old", fallbackModel: "old-fallback", metadata: "keep",
    agentOverrides: { "Custom Role": { model: "old-role", description: "keep" }, omitted: { model: "keep" } },
  } });
  writeFileSync(settingsPath, source);
  writeFileSync(join(project, ".pi/settings.json"), "malformed project settings trap");
  let runtimeCalls = 0;
  const forbidden = () => { runtimeCalls++; throw new Error("must not activate runtime or consult project"); };
  const app = createHostApp({ logger: {}, gate: { config: DISABLED_GATE },
    catalogs: { ...catalogs, roots: { authorizeExisting: forbidden }, trust: { isTrusted: forbidden } },
    sessiond: { isAvailable: async () => false },
    sessions: { client: { list: forbidden, read: forbidden, context: forbidden, tree: forbidden } },
  }).app;
  const release = installNetworkGuard();
  const beforeFiles = listFilesRecursive(root).sort();
  const put = (path, body) => app.request(`http://localhost/v1/settings/${path}`, {
    method: "PUT", headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    const health = await (await call(app, "/v1/health")).json();
    assert.equal(health.sessiond, "down");
    assert.ok(health.capabilities.includes("settings.configure"));
    const before = await (await call(app, "/v1/settings/subagents")).json();
    assert.equal(readFileSync(settingsPath, "utf8"), source, "read is byte-preserving");
    assert.equal(before.revision, (await (await call(app, "/v1/settings/config")).json()).revision);
    assert.equal(before.revision, (await (await call(app, "/v1/settings/tools")).json()).revision);
    const res = await put("subagents", { expectedRevision: before.revision, settings: {
      defaultModel: "  future/provider-model  ", fallbackModel: null,
      agentOverrides: [{ name: "Custom Role", model: null, fallbackModel: " unknown-fallback ", thinking: "high" }],
    } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const saved = await res.json();
    const native = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.deepEqual(native.subagents, {
      defaultModel: "future/provider-model", metadata: "keep",
      agentOverrides: { "Custom Role": { description: "keep", fallbackModel: "unknown-fallback", thinking: "high" }, omitted: { model: "keep" } },
    });
    assert.deepEqual(native.custom, { keep: true });
    assert.equal(saved.revision, (await (await call(app, "/v1/settings/config")).json()).revision);
    assert.equal(saved.revision, (await (await call(app, "/v1/settings/tools")).json()).revision);
    assert.deepEqual(saved, await (await call(app, "/v1/settings/subagents")).json());
    assert.equal((await put("tools", { expectedRevision: before.revision, toolNames: [] })).status, 409);
    assert.equal((await put("config", { expectedRevision: before.revision, content: "{}" })).status, 409);
    const tools = await put("tools", { expectedRevision: saved.revision, toolNames: [] });
    assert.equal(tools.status, 200);
    assert.deepEqual((await (await call(app, "/v1/settings/subagents")).json()).settings, saved.settings);
    assert.equal(runtimeCalls, 0);
    assert.equal(existsSync(markerPath), false, "extension not executed");
    assert.deepEqual(listFilesRecursive(root).sort(), beforeFiles, "no Worker/session files created");
  } finally { assert.equal(release(), false, "no outbound network"); }
});
