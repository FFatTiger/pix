import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPiSdkModelCatalog, type PiSdkModelCatalogOptions } from "../src/models/index.js";
import { createPiSdkModelStore } from "../src/internal/model-store.js";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import type { ModelCatalogPort, ModelInfo } from "@fffattiger/pix-runtime-core";

// Compile-time proof: PiSdkModelCatalogOptions.cwd is REQUIRED — an options
// object omitting cwd is NOT assignable to the catalog options type.
type Assignable<A, B> = A extends B ? true : false;
const _noImplicitCwd: Assignable<{ agentDir: string }, PiSdkModelCatalogOptions> = false;

// Seeded secrets that MUST NEVER appear in any catalog output, error, or log.
const SEED_API_KEY = "sk-ant-SECRET-MODEL-CANARY-1234567890";

async function seedAgentDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pix-models-catalog-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "cwd");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(
    join(agentDir, "auth.json"),
    JSON.stringify({
      anthropic: { type: "api_key", key: SEED_API_KEY },
    }),
    "utf8",
  );
  return root;
}

/** Network guard: throws if any outbound fetch happens during the probe. */
function installNetworkGuard(): () => boolean {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    called = true;
    throw new Error("network access is forbidden by the read-only model catalog");
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
    return called;
  };
}

// Provider env-var keys that can make a provider available without auth.json.
// Cleared for default/isolation tests so ambient env cannot flip availability;
// the tests drive availability ONLY through the seeded in-memory store.
const ENV_KEYS = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY",
  "DEEPSEEK_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY", "XAI_API_KEY",
];

function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const key of new Set([...ENV_KEYS, ...Object.keys(overrides)])) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  return fn().finally(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/**
 * Build an isolated offline ModelRuntime with a CONTROLLED in-memory credential
 * store (zero writes, no network, no env dependency). The catalog is the
 * deterministic built-in one; availability is driven ONLY by the seeded
 * credentials, so the enabled-model scope resolves to KNOWN models regardless
 * of the ambient environment. An empty `providers` list yields a runtime with
 * no configured auth (getAvailable() empty in a clean env).
 */
async function seededRuntime(
  agentDir: string,
  providers: readonly string[],
): Promise<ModelRuntime> {
  const creds = new InMemoryCredentialStore();
  for (const providerId of providers) {
    await creds.modify(providerId, async () => ({
      type: "api_key",
      key: `sk-test-${providerId}`,
    }));
  }
  return ModelRuntime.create({
    allowModelNetwork: false,
    credentials: creds,
    modelsStore: new InMemoryModelsStore(),
    // Pin models.json to the (empty) injected agentDir => no global fallback.
    modelsPath: join(agentDir, "models.json"),
  });
}

describe("read-only model catalog (D3B-R1A)", () => {
  it("listModels returns backend-neutral ModelInfo entries offline", async () => {
    const root = await seedAgentDir();
    try {
      await withEnv({}, async () => {
        const release = installNetworkGuard();
        const catalog = createPiSdkModelCatalog({
          cwd: join(root, "cwd"),
          agentDir: join(root, "agent"),
        });
        const models = await catalog.listModels();
        release();
        assert.ok(models.length > 0, "configured providers must surface models offline");
        assert.ok(models.every((model) => model.provider === "anthropic"), "unconfigured builtin providers must stay hidden");
        for (const model of models) {
          assert.ok(typeof model.id === "string" && model.id.length > 0);
          assert.ok(typeof model.provider === "string" && model.provider.length > 0);
          // No SDK Model object leakage: only canonical fields.
          const keys = Object.keys(model) as (keyof ModelInfo)[];
          for (const key of keys) {
            assert.ok(
              ["id", "provider", "displayName", "thinking", "contextWindow"].includes(key),
              `unexpected ModelInfo field: ${key}`,
            );
          }
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolveModel maps a known provider/id and rejects unknown", async () => {
    const root = await seedAgentDir();
    try {
      const catalog = createPiSdkModelCatalog({
        cwd: join(root, "cwd"),
        agentDir: join(root, "agent"),
      });
      const models = await catalog.listModels();
      const first = models[0]!;
      const resolved = await catalog.resolveModel({
        provider: first.provider,
        modelId: first.id,
      });
      assert.equal(resolved.id, first.id);
      assert.equal(resolved.provider, first.provider);
      await assert.rejects(
        () => catalog.resolveModel({ provider: "nope", modelId: "nope" }),
        (error: unknown) => (error as { code?: string }).code === "not_found",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("getDefaultModel returns a ModelRef", async () => {
    const root = await seedAgentDir();
    try {
      const catalog = createPiSdkModelCatalog({
        cwd: join(root, "cwd"),
        agentDir: join(root, "agent"),
      });
      const def = await catalog.getDefaultModel();
      assert.ok(def, "offline catalog must report a default model");
      assert.ok(typeof def.id === "string" && def.id.length > 0);
      assert.ok(typeof def.provider === "string" && def.provider.length > 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("seeded API secret never appears in any catalog output or error", async () => {
    const root = await seedAgentDir();
    try {
      const catalog = createPiSdkModelCatalog({
        cwd: join(root, "cwd"),
        agentDir: join(root, "agent"),
      });
      const models = await catalog.listModels();
      const def = await catalog.getDefaultModel();
      const payloads = [JSON.stringify(models), JSON.stringify(def)];
      for (const payload of payloads) {
        assert.ok(!payload.includes(SEED_API_KEY), "secret leaked into model output");
      }
      let notFoundMessage = "";
      try {
        await catalog.resolveModel({ provider: "nope", modelId: "nope" });
      } catch (error) {
        notFoundMessage = String(error);
      }
      assert.ok(!notFoundMessage.includes(SEED_API_KEY), "secret leaked into error");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("catalog surface exposes no mutation methods", () => {
    const catalog = createPiSdkModelCatalog({
      listModels: () => Promise.resolve([]),
      getDefaultModel: () => Promise.resolve({ id: "x", provider: "p" }),
      resolveModel: () => Promise.reject(new Error("x")),
    });
    // Methods live on the prototype; enumerate them and assert read-only set.
    const proto = Object.getPrototypeOf(catalog);
    const methodNames = Object.getOwnPropertyNames(proto).filter(
      (name) => name !== "constructor",
    );
    assert.deepEqual([...methodNames].sort(), [
      "getDefaultModel",
      "listModels",
      "resolveModel",
    ]);
    assert.equal("refresh" in catalog, false);
    assert.equal("setModel" in catalog, false);
    assert.equal("configure" in catalog, false);
  });

  it("implements the read-only ModelCatalogPort contract", () => {
    const catalog: ModelCatalogPort = createPiSdkModelCatalog({
      listModels: () => Promise.resolve([]),
      getDefaultModel: () => Promise.resolve({ id: "x", provider: "p" }),
      resolveModel: () => Promise.resolve({ id: "x", provider: "p" }),
    });
    assert.equal(typeof catalog.listModels, "function");
    assert.equal(typeof catalog.getDefaultModel, "function");
    assert.equal(typeof catalog.resolveModel, "function");
  });

  it("rejects construction without an explicit canonical cwd (no implicit fallback)", () => {
    // A type-bypassed call with no cwd must throw at runtime; the public factory
    // never reads process.cwd.
    assert.throws(
      () => createPiSdkModelCatalog({ agentDir: "/tmp" } as unknown as PiSdkModelCatalogOptions),
      (error: unknown) => (error as { code?: string }).code === "invalid_input",
    );
    assert.throws(
      () => createPiSdkModelCatalog({} as PiSdkModelCatalogOptions),
      (error: unknown) => (error as { code?: string }).code === "invalid_input",
    );
  });
});

describe("model default validation + enabled scope (D3B-R1A hardening, env-independent)", () => {
  async function tmpRoot(): Promise<{ root: string; agentDir: string; cwd: string }> {
    const root = await mkdtemp(join(tmpdir(), "pix-model-default-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "cwd");
    await mkdir(agentDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    return { root, agentDir, cwd };
  }

  it("valid configured default is returned", async () => {
    const { root, agentDir, cwd } = await tmpRoot();
    try {
      await withEnv({}, async () => {
        const runtime = await seededRuntime(agentDir, ["anthropic"]);
        const anthropicModels = runtime
          .getModels()
          .filter((m) => m.provider === "anthropic");
        assert.ok(anthropicModels.length > 0, "anthropic has catalog models");
        const target = anthropicModels[0]!;
        const settings = SettingsManager.inMemory();
        settings.setDefaultModelAndProvider("anthropic", target.id);
        const store = createPiSdkModelStore({
          cwd,
          settingsManager: settings,
          modelRuntime: runtime,
        });
        const def = await store.getDefaultModel();
        assert.deepEqual(def, { provider: "anthropic", id: target.id });
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("invalid configured default falls back to first enabled model", async () => {
    const { root, agentDir, cwd } = await tmpRoot();
    try {
      await withEnv({}, async () => {
        const runtime = await seededRuntime(agentDir, ["anthropic"]);
        const first = runtime.getAvailableSnapshot()[0]!;
        assert.ok(first, "seeded anthropic auth must make models available");
        const settings = SettingsManager.inMemory();
        settings.setDefaultModelAndProvider("anthropic", "zzz-does-not-exist");
        const store = createPiSdkModelStore({
          cwd,
          settingsManager: settings,
          modelRuntime: runtime,
        });
        const def = await store.getDefaultModel();
        // No enabledModels => all locally configured models enabled.
        assert.deepEqual(def, { provider: first.provider, id: first.id });
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("default disabled by enabledModels falls back to first enabled", async () => {
    const { root, agentDir, cwd } = await tmpRoot();
    try {
      await withEnv({}, async () => {
        const runtime = await seededRuntime(agentDir, ["anthropic", "openai"]);
        const anthropicModels = runtime
          .getModels()
          .filter((m) => m.provider === "anthropic");
        const target = anthropicModels[0]!;
        const settings = SettingsManager.inMemory();
        settings.setDefaultModelAndProvider("anthropic", target.id);
        // Scope excludes anthropic => default disabled, falls back to first openai.
        settings.setEnabledModels(["openai/*"]);
        const store = createPiSdkModelStore({
          cwd,
          settingsManager: settings,
          modelRuntime: runtime,
        });
        const def = await store.getDefaultModel();
        assert.ok(def, "disabled default falls back to first enabled");
        assert.equal(
          def!.provider,
          "openai",
          "fallback is the first enabled (openai) model",
        );
        assert.notDeepEqual(def, { provider: "anthropic", id: target.id });
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enabledModels with no AVAILABLE match => null", async () => {
    const { root, agentDir, cwd } = await tmpRoot();
    try {
      await withEnv({}, async () => {
        const runtime = await seededRuntime(agentDir, ["anthropic"]);
        const settings = SettingsManager.inMemory();
        settings.setEnabledModels(["zzz-no-match-*"]);
        const store = createPiSdkModelStore({
          cwd,
          settingsManager: settings,
          modelRuntime: runtime,
        });
        const def = await store.getDefaultModel();
        assert.equal(def, null, "enabled scope matching nothing available => null");
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("listModels hides unconfigured builtin providers and honors enabledModels", async () => {
    const { root, agentDir, cwd } = await tmpRoot();
    try {
      await withEnv({}, async () => {
        const runtime = await seededRuntime(agentDir, ["anthropic", "openai"]);
        const settings = SettingsManager.inMemory();
        settings.setEnabledModels(["openai/*"]);
        const store = createPiSdkModelStore({
          cwd,
          settingsManager: settings,
          modelRuntime: runtime,
        });
        const listed = await store.listModels();
        assert.ok(listed.length > 0, "enabled configured models must remain visible");
        assert.ok(listed.every((model) => model.provider === "openai"));
        assert.ok(!listed.some((model) => model.provider === "anthropic"));
        const builtinProviders = new Set(runtime.getModels().map((model) => model.provider));
        assert.ok(builtinProviders.size > 2, "builtin catalog still contains unused providers");
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("no enabledModels => deterministic first valid model", async () => {
    const { root, agentDir, cwd } = await tmpRoot();
    try {
      await withEnv({}, async () => {
        const runtime = await seededRuntime(agentDir, ["anthropic"]);
        const first = runtime.getAvailableSnapshot()[0]!;
        assert.ok(first, "seeded anthropic auth must make models available");
        const settings = SettingsManager.inMemory();
        const store = createPiSdkModelStore({
          cwd,
          settingsManager: settings,
          modelRuntime: runtime,
        });
        const def = await store.getDefaultModel();
        assert.deepEqual(def, { provider: first.provider, id: first.id });
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("model catalog creates zero files (D3B-R1A hardening)", () => {
  it("reads on a clean/missing agentDir create no files or directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-model-zerofile-"));
    const agentDir = join(root, "agent"); // intentionally NOT created
    const cwd = join(root, "cwd");
    await mkdir(cwd, { recursive: true });
    try {
      await withEnv({}, async () => {
        const before = await readdir(root);
        const catalog = createPiSdkModelCatalog({ cwd, agentDir });
        await catalog.listModels();
        await catalog.getDefaultModel();
        await catalog
          .resolveModel({ provider: "anthropic", modelId: "sonnet" })
          .catch(() => {});
        const after = await readdir(root);
        assert.deepEqual(after, before, "model catalog reads must create no files/dirs");
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("concurrent reads on a clean agentDir create no files or directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-model-concurrent-"));
    const agentDir = join(root, "agent"); // intentionally NOT created
    const cwd = join(root, "cwd");
    await mkdir(cwd, { recursive: true });
    try {
      await withEnv({}, async () => {
        const before = await readdir(root);
        const catalog = createPiSdkModelCatalog({ cwd, agentDir });
        // Many concurrent first-reads must still produce zero side effects.
        await Promise.all([
          catalog.listModels(),
          catalog.listModels(),
          catalog.getDefaultModel(),
          catalog.getDefaultModel(),
          catalog
            .resolveModel({ provider: "anthropic", modelId: "sonnet" })
            .catch(() => {}),
          catalog
            .resolveModel({ provider: "openai", modelId: "gpt" })
            .catch(() => {}),
        ]);
        const after = await readdir(root);
        assert.deepEqual(
          after,
          before,
          "concurrent model catalog reads must create no files/dirs",
        );
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("agentDir isolation: empty injected agentDir never exposes global config (D3B-R1A)", () => {
  // A built-in provider configured in the GLOBAL models.json with a literal key
  // would, without the modelsPath pin, leak through getAvailable() into the
  // default/enabled-scope resolution. Pinning models.json to
  // join(agentDir, "models.json") ensures an empty injected agentDir exposes
  // NO global provider status.
  it("global-only configured provider does not leak into an empty injected agentDir", async () => {
    const globalRoot = await mkdtemp(join(tmpdir(), "pix-model-global-"));
    const globalAgentDir = join(globalRoot, "agent");
    await mkdir(globalAgentDir, { recursive: true });
    const injectedRoot = await mkdtemp(join(tmpdir(), "pix-model-injected-"));
    const injectedAgentDir = join(injectedRoot, "agent"); // intentionally NOT created
    const cwd = join(injectedRoot, "cwd");
    await mkdir(cwd, { recursive: true });
    try {
      await withEnv({}, async () => {
        // Discover a built-in provider that has catalog models (for the pattern).
        const providerId = (await seededRuntime(globalAgentDir, [])).getModels()[0]!
          .provider;
        // GLOBAL models.json: configure that provider with a literal key (no env).
        await writeFile(
          join(globalAgentDir, "models.json"),
          JSON.stringify({
            providers: {
              [providerId]: {
                baseUrl: "https://global-proxy.example.com/v1",
                auth: { apiKey: true },
                apiKey: "sk-GLOBAL-LITERAL-LEAK",
              },
            },
          }),
          "utf8",
        );

        // CONTROL: pointing the store at the global agentDir DOES surface the
        // provider (configured via models_json_key) => the pattern resolves.
        const ctrlSettings = SettingsManager.inMemory();
        ctrlSettings.setEnabledModels([`${providerId}/*`]);
        const ctrlStore = createPiSdkModelStore({
          cwd,
          agentDir: globalAgentDir,
          settingsManager: ctrlSettings,
        });
        const ctrlDef = await ctrlStore.getDefaultModel();
        assert.equal(
          ctrlDef?.provider,
          providerId,
          "control: global config makes the provider available",
        );

        // ISOLATION: an empty injected agentDir must NOT see the global config.
        const isoSettings = SettingsManager.inMemory();
        isoSettings.setEnabledModels([`${providerId}/*`]);
        const isoStore = createPiSdkModelStore({
          cwd,
          agentDir: injectedAgentDir,
          settingsManager: isoSettings,
        });
        const isoDef = await isoStore.getDefaultModel();
        assert.equal(
          isoDef,
          null,
          "empty injected agentDir must not expose global provider config",
        );

        // And the empty injected agentDir is still absent (zero writes).
        const injectedListing = await readdir(injectedRoot);
        assert.deepEqual(
          injectedListing,
          ["cwd"],
          "injected agentDir must not be created by isolated reads",
        );
      });
    } finally {
      await rm(globalRoot, { recursive: true, force: true });
      await rm(injectedRoot, { recursive: true, force: true });
    }
  });
});
