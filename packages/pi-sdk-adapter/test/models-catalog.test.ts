import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPiSdkModelCatalog } from "../src/models/index.js";
import type { ModelCatalogPort, ModelInfo } from "@fffattiger/pix-runtime-core";

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

describe("read-only model catalog (D3B-R1A)", () => {
  it("listModels returns backend-neutral ModelInfo entries offline", async () => {
    const root = await seedAgentDir();
    try {
      const release = installNetworkGuard();
      const catalog = createPiSdkModelCatalog({
        cwd: join(root, "cwd"),
        agentDir: join(root, "agent"),
      });
      const models = await catalog.listModels();
      release();
      assert.ok(models.length > 0, "built-in catalog must surface models offline");
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
});
