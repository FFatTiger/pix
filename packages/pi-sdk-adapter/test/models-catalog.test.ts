import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPiSdkModelCatalog, type PiSdkModelCatalogOptions } from "../src/models/index.js";
import { createPiSdkModelStore } from "../src/internal/model-store.js";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ModelCatalogPort, ModelInfo } from "@fffattiger/pix-runtime-core";

// Seeded secrets that MUST NEVER appear in any catalog output, error, or log.
const SEED_API_KEY = "sk-ant-SECRET-MODEL-CANARY-1234567890";
const LITERAL_KEY = "sk-literal-SECRET-MODEL-CANARY-9876543210";

/** models.json fixture: ONE custom provider with a literal key (canary). */
const CUSTOM_PROVIDER_ID = "pix-custom";
const CUSTOM_MODELS = [
  { id: "custom-mini", name: "Custom Mini", contextWindow: 8192 },
  { id: "custom-max", name: "Custom Max", contextWindow: 131072, reasoning: true },
];

async function seedAgentDir(): Promise<{ root: string; agentDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "pix-models-catalog-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        [CUSTOM_PROVIDER_ID]: {
          baseUrl: "https://pix-custom.example.com/v1",
          api: "openai-completions",
          apiKey: LITERAL_KEY,
          models: CUSTOM_MODELS,
        },
      },
    }),
    "utf8",
  );
  // Stored built-in credential: MUST NOT add catalog rows (config-file-only
  // provider scope) and MUST NOT leak.
  await writeFile(
    join(agentDir, "auth.json"),
    JSON.stringify({
      anthropic: { type: "api_key", key: SEED_API_KEY },
    }),
    "utf8",
  );
  return { root, agentDir };
}

/** Network guard: throws if any outbound fetch happens during the probe. */
function installNetworkGuard(): () => boolean {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    called = true;
    throw new Error("network access is forbidden by the read-only model catalog");
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
    return called;
  };
}

// Provider env-var keys that can make a builtin provider available without
// models.json. Cleared so ambient env cannot flip the catalog; the tests drive
// scope ONLY through the seeded config files.
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

describe("read-only model catalog (global, models.json-scoped)", () => {
  it("listModels returns ONLY models.json-configured providers offline", async () => {
    const { root, agentDir } = await seedAgentDir();
    try {
      await withEnv({}, async () => {
        const release = installNetworkGuard();
        const catalog = createPiSdkModelCatalog({ agentDir });
        const models = await catalog.listModels();
        release();
        assert.ok(models.length > 0, "models.json provider must surface offline");
        assert.ok(
          models.every((model) => model.provider === CUSTOM_PROVIDER_ID),
          "stored-credential builtin providers must stay hidden",
        );
        assert.ok(
          models.some((model) => model.id === "custom-mini"),
          "configured model ids surface",
        );
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
        assert.ok(!JSON.stringify(models).includes(LITERAL_KEY), "literal key leaked");
        assert.ok(!JSON.stringify(models).includes(SEED_API_KEY), "stored key leaked");
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolveModel maps a known provider/id and rejects unknown", async () => {
    const { root, agentDir } = await seedAgentDir();
    try {
      const catalog = createPiSdkModelCatalog({ agentDir });
      const resolved = await catalog.resolveModel({
        provider: CUSTOM_PROVIDER_ID,
        modelId: "custom-mini",
      });
      assert.equal(resolved.id, "custom-mini");
      assert.equal(resolved.provider, CUSTOM_PROVIDER_ID);
      await assert.rejects(
        () => catalog.resolveModel({ provider: "nope", modelId: "nope" }),
        (error: unknown) => (error as { code?: string }).code === "not_found",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("getDefaultModel returns a ModelRef from the configured set", async () => {
    const { root, agentDir } = await seedAgentDir();
    try {
      const catalog = createPiSdkModelCatalog({ agentDir });
      const def = await catalog.getDefaultModel();
      assert.ok(def, "offline catalog must report a default model");
      assert.equal(def.provider, CUSTOM_PROVIDER_ID);
      assert.ok(CUSTOM_MODELS.some((model) => model.id === def.id));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("seeded secrets never appear in any catalog output or error", async () => {
    const { root, agentDir } = await seedAgentDir();
    try {
      const catalog = createPiSdkModelCatalog({ agentDir });
      const models = await catalog.listModels();
      const def = await catalog.getDefaultModel();
      const payloads = [JSON.stringify(models), JSON.stringify(def)];
      for (const payload of payloads) {
        assert.ok(!payload.includes(SEED_API_KEY), "stored secret leaked into model output");
        assert.ok(!payload.includes(LITERAL_KEY), "literal secret leaked into model output");
      }
      let notFoundMessage = "";
      try {
        await catalog.resolveModel({ provider: "nope", modelId: "nope" });
      } catch (error) {
        notFoundMessage = String(error);
      }
      assert.ok(!notFoundMessage.includes(SEED_API_KEY), "stored secret leaked into error");
      assert.ok(!notFoundMessage.includes(LITERAL_KEY), "literal secret leaked into error");
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
});

describe("model default validation + enabled scope (global settings)", () => {
  async function tmpRoot(): Promise<{ root: string; agentDir: string }> {
    const root = await mkdtemp(join(tmpdir(), "pix-model-default-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          [CUSTOM_PROVIDER_ID]: {
            baseUrl: "https://pix-custom.example.com/v1",
            api: "openai-completions",
            apiKey: LITERAL_KEY,
            models: CUSTOM_MODELS,
          },
          "pix-other": {
            baseUrl: "https://pix-other.example.com/v1",
            api: "openai-completions",
            apiKey: LITERAL_KEY,
            models: [{ id: "other-solo", contextWindow: 4096 }],
          },
        },
      }),
      "utf8",
    );
    return { root, agentDir };
  }

  it("reads global settings.json and ignores any agentDir/.pi project slot", async () => {
    const { root, agentDir } = await tmpRoot();
    try {
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({
          defaultProvider: "pix-other",
          defaultModel: "other-solo",
          enabledModels: ["pix-other/*"],
        }),
        "utf8",
      );
      // Adversarial fake project settings under the agent dir: a cwd-pinned
      // SettingsManager would merge this and select pix-custom. The global
      // catalog must withhold project scope entirely.
      await mkdir(join(agentDir, ".pi"), { recursive: true });
      await writeFile(
        join(agentDir, ".pi", "settings.json"),
        JSON.stringify({ enabledModels: [`${CUSTOM_PROVIDER_ID}/*`] }),
        "utf8",
      );
      const store = createPiSdkModelStore({ agentDir });
      const listed = await store.listModels();
      assert.ok(listed.length > 0);
      assert.ok(listed.every((model) => model.provider === "pix-other"));
      assert.deepEqual(
        await store.getDefaultModel(),
        { provider: "pix-other", id: "other-solo" },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("wrong-type global model settings fail closed instead of arbitrary success", async () => {
    const invalidSettings: readonly Record<string, unknown>[] = [
      { enabledModels: `${CUSTOM_PROVIDER_ID}/*` },
      { enabledModels: { provider: CUSTOM_PROVIDER_ID } },
      { enabledModels: 42 },
      { enabledModels: [`${CUSTOM_PROVIDER_ID}/*`, 42] },
      { defaultProvider: 42, defaultModel: "custom-mini" },
      { defaultProvider: CUSTOM_PROVIDER_ID, defaultModel: { id: "custom-mini" } },
    ];
    for (const payload of invalidSettings) {
      const { root, agentDir } = await tmpRoot();
      try {
        await writeFile(join(agentDir, "settings.json"), JSON.stringify(payload), "utf8");
        const store = createPiSdkModelStore({ agentDir });
        await assert.rejects(
          () => store.listModels(),
          (error: unknown) => (error as { code?: string }).code === "invalid_input",
        );
        await assert.rejects(
          () => store.getDefaultModel(),
          (error: unknown) => (error as { code?: string }).code === "invalid_input",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("valid configured default is returned", async () => {
    const { root, agentDir } = await tmpRoot();
    try {
      const settings = SettingsManager.inMemory();
      settings.setDefaultModelAndProvider(CUSTOM_PROVIDER_ID, "custom-max");
      const store = createPiSdkModelStore({ agentDir, settingsManager: settings });
      const def = await store.getDefaultModel();
      assert.deepEqual(def, { provider: CUSTOM_PROVIDER_ID, id: "custom-max" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("invalid configured default falls back to first enabled model", async () => {
    const { root, agentDir } = await tmpRoot();
    try {
      const settings = SettingsManager.inMemory();
      settings.setDefaultModelAndProvider(CUSTOM_PROVIDER_ID, "zzz-does-not-exist");
      const store = createPiSdkModelStore({ agentDir, settingsManager: settings });
      const def = await store.getDefaultModel();
      assert.ok(def, "fallback default must exist");
      assert.equal(def.provider, CUSTOM_PROVIDER_ID);
      assert.notEqual(def.id, "zzz-does-not-exist");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("default disabled by enabledModels falls back to another configured provider", async () => {
    const { root, agentDir } = await tmpRoot();
    try {
      const settings = SettingsManager.inMemory();
      settings.setDefaultModelAndProvider(CUSTOM_PROVIDER_ID, "custom-max");
      settings.setEnabledModels(["pix-other/*"]);
      const store = createPiSdkModelStore({ agentDir, settingsManager: settings });
      const def = await store.getDefaultModel();
      assert.ok(def, "disabled default falls back");
      assert.equal(def.provider, "pix-other");
      assert.equal(def.id, "other-solo");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enabledModels with no configured match => null default and empty list", async () => {
    const { root, agentDir } = await tmpRoot();
    try {
      const settings = SettingsManager.inMemory();
      settings.setEnabledModels(["zzz-no-match-*"]);
      const store = createPiSdkModelStore({ agentDir, settingsManager: settings });
      const def = await store.getDefaultModel();
      assert.equal(def, null, "enabled scope matching nothing configured => null");
      assert.deepEqual(await store.listModels(), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("listModels honors enabledModels within the configured set", async () => {
    const { root, agentDir } = await tmpRoot();
    try {
      const settings = SettingsManager.inMemory();
      settings.setEnabledModels(["pix-other/*"]);
      const store = createPiSdkModelStore({ agentDir, settingsManager: settings });
      const listed = await store.listModels();
      assert.ok(listed.length > 0, "enabled configured models must remain visible");
      assert.ok(listed.every((model) => model.provider === "pix-other"));
      assert.ok(!listed.some((model) => model.provider === CUSTOM_PROVIDER_ID));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("models.json absence / malformation fails honestly", () => {
  it("no models.json => honest empty catalog (no builtin fallback)", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-model-nofile-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    try {
      await withEnv({}, async () => {
        const catalog = createPiSdkModelCatalog({ agentDir });
        assert.deepEqual(await catalog.listModels(), []);
        assert.equal(await catalog.getDefaultModel(), null);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("missing providers or blank provider identity rejects (not fake empty)", async () => {
    const invalidFiles = [
      {},
      { providers: { "": {} } },
      { providers: { "   ": { models: [{ id: "m" }] } } },
    ];
    for (const payload of invalidFiles) {
      const root = await mkdtemp(join(tmpdir(), "pix-model-invalid-provider-id-"));
      const agentDir = join(root, "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "models.json"), JSON.stringify(payload), "utf8");
      try {
        const catalog = createPiSdkModelCatalog({ agentDir });
        await assert.rejects(
          () => catalog.listModels(),
          (error: unknown) => (error as { code?: string }).code === "invalid_input",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("malformed models.json rejects with invalid_input (never silent empty)", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-model-badjson-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "models.json"), "{ not json at all", "utf8");
    try {
      const catalog = createPiSdkModelCatalog({ agentDir });
      await assert.rejects(
        () => catalog.listModels(),
        (error: unknown) => (error as { code?: string }).code === "invalid_input",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("schema-invalid but valid JSON rejects with invalid_input (no builtin fallback)", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-model-badschema-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          [CUSTOM_PROVIDER_ID]: {
            apiKey: LITERAL_KEY,
            models: [{ id: 123 }],
          },
        },
      }),
      "utf8",
    );
    try {
      const catalog = createPiSdkModelCatalog({ agentDir });
      await assert.rejects(
        () => catalog.listModels(),
        (error: unknown) => (error as { code?: string }).code === "invalid_input",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("models.json with // comments and trailing commas still parses (Pi CLI tolerance)", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-model-comments-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "models.json"),
      `{
  // one custom provider
  "providers": {
    "${CUSTOM_PROVIDER_ID}": {
      "baseUrl": "https://pix-custom.example.com/v1",
      "api": "openai-completions",
      "apiKey": "${LITERAL_KEY}",
      "models": [{ "id": "custom-mini", "contextWindow": 8192 },],
    },
  },
}`,
      "utf8",
    );
    try {
      const catalog = createPiSdkModelCatalog({ agentDir });
      const models = await catalog.listModels();
      assert.ok(models.some((model) => model.id === "custom-mini"));
      assert.ok(!JSON.stringify(models).includes(LITERAL_KEY));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("model catalog creates zero files (D3B-R1A hardening)", () => {
  it("reads on a clean/missing agentDir create no files or directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-model-zerofile-"));
    const agentDir = join(root, "agent"); // intentionally NOT created
    try {
      await withEnv({}, async () => {
        const before = await readdir(root);
        const catalog = createPiSdkModelCatalog({ agentDir });
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
    try {
      await withEnv({}, async () => {
        const before = await readdir(root);
        const catalog = createPiSdkModelCatalog({ agentDir });
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
  it("global-only configured provider does not leak into an empty injected agentDir", async () => {
    const globalRoot = await mkdtemp(join(tmpdir(), "pix-model-global-"));
    const globalAgentDir = join(globalRoot, "agent");
    await mkdir(globalAgentDir, { recursive: true });
    const injectedRoot = await mkdtemp(join(tmpdir(), "pix-model-injected-"));
    const injectedAgentDir = join(injectedRoot, "agent"); // intentionally NOT created
    try {
      await withEnv({}, async () => {
        // GLOBAL models.json: a custom provider with a literal key.
        await writeFile(
          join(globalAgentDir, "models.json"),
          JSON.stringify({
            providers: {
              "global-proxy": {
                baseUrl: "https://global-proxy.example.com/v1",
                api: "openai-completions",
                apiKey: "sk-GLOBAL-LITERAL-LEAK",
                models: [{ id: "global-model", contextWindow: 4096 }],
              },
            },
          }),
          "utf8",
        );

        // CONTROL: pointing the store at the global agentDir DOES surface the
        // provider (configured via models.json) => the catalog resolves.
        const ctrlStore = createPiSdkModelStore({ agentDir: globalAgentDir });
        const ctrlModels = await ctrlStore.listModels();
        assert.ok(
          ctrlModels.some((model) => model.provider === "global-proxy"),
          "control: global config makes the provider visible",
        );

        // ISOLATION: an empty injected agentDir must NOT see the global config.
        const isoStore = createPiSdkModelStore({ agentDir: injectedAgentDir });
        assert.deepEqual(
          await isoStore.listModels(),
          [],
          "empty injected agentDir must not expose global provider config",
        );
        assert.equal(await isoStore.getDefaultModel(), null);

        // And the empty injected agentDir is still absent (zero writes).
        const injectedListing = await readdir(injectedRoot);
        assert.deepEqual(
          injectedListing,
          [],
          "injected agentDir must not be created by isolated reads",
        );
      });
    } finally {
      await rm(globalRoot, { recursive: true, force: true });
      await rm(injectedRoot, { recursive: true, force: true });
    }
  });
});

// Compile-time proof: the catalog options no longer carry a cwd — an options
// object WITH cwd is still assignable (extra property) but the factory is
// documented global-only; absence of cwd is the supported shape.
type Assignable<A, B> = A extends B ? true : false;
const _globalOnlyOptions: Assignable<{ agentDir: string }, PiSdkModelCatalogOptions> = true;
void _globalOnlyOptions;
