import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
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

  // Models (offline catalog; empty agentDir is fine).
  const modelsRes = await call(app, `/v1/models?cwd=${encodeURIComponent(project)}`);
  assert.equal(modelsRes.status, 200);
  assert.equal(modelsRes.headers.get("cache-control"), "no-store");
  const modelsBody = await modelsRes.json();
  assert.ok(Array.isArray(modelsBody.models));
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
