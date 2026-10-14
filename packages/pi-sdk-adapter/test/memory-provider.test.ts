import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  effectiveMemoryProvider,
  normalizeMemoryProviderValue,
} from "@fffattiger/pix-runtime-core";
import { readMemoryRuntimeStateSync } from "../src/internal/memory-provider.js";

async function withTempAgentDir<T>(run: (agentDir: string, loreHome: string) => Promise<T> | T): Promise<T> {
  const base = await mkdtemp(join(tmpdir(), "pix-memory-provider-"));
  const agentDir = join(base, "agent");
  const loreHome = join(base, "lore");
  await mkdir(agentDir, { recursive: true });
  await mkdir(loreHome, { recursive: true });
  try {
    return await run(agentDir, loreHome);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

const loreEnv = (loreHome: string) => ({ LORE_HOME: loreHome });

const loreConfiguredEnv = (loreHome: string) => ({
  LORE_HOME: loreHome,
});

describe("memory provider normalization", () => {
  it("accepts the three providers, passes absence through, rejects anything else", () => {
    assert.equal(normalizeMemoryProviderValue("local"), "local");
    assert.equal(normalizeMemoryProviderValue("lore"), "lore");
    assert.equal(normalizeMemoryProviderValue("off"), "off");
    assert.equal(normalizeMemoryProviderValue(undefined), undefined);
    assert.equal(normalizeMemoryProviderValue(null), null);
    assert.equal(normalizeMemoryProviderValue("Lore"), null);
    assert.equal(normalizeMemoryProviderValue(1), null);
  });

  it("explicit wins; absent + lore configured defaults to lore; absent otherwise local", () => {
    assert.equal(effectiveMemoryProvider("off", true), "off");
    assert.equal(effectiveMemoryProvider("local", true), "local");
    assert.equal(effectiveMemoryProvider(undefined, true), "lore");
    assert.equal(effectiveMemoryProvider(undefined, false), "local");
  });
});

describe("readMemoryRuntimeStateSync", () => {
  it("no settings.json and no lore connection → local (default provider)", async () => {
    await withTempAgentDir((agentDir, loreHome) => {
      const state = readMemoryRuntimeStateSync(agentDir, { LORE_HOME: loreHome });
      assert.equal(state.provider, "local");
      assert.equal(state.explicit, undefined);
      assert.equal(state.lore.configured, false);
      assert.equal(state.lore.source, "none");
    });
  });

  it("no settings.json + configured lore → lore (migration default keeps existing Lore users on Lore)", async () => {
    await withTempAgentDir(async (agentDir, loreHome) => {
      await writeFile(
        join(loreHome, "config.json"),
        `${JSON.stringify({ base_url: "https://api.loremem.com", api_token: "lm_t" }, null, 2)}\n`,
      );
      const state = readMemoryRuntimeStateSync(agentDir, loreConfiguredEnv(loreHome));
      assert.equal(state.provider, "lore");
      assert.equal(state.explicit, undefined);
      assert.equal(state.lore.configured, true);
      assert.equal(state.lore.baseUrl, "https://api.loremem.com");
      assert.equal(state.lore.source, "config");
      assert.equal(state.lore.tokenConfigured, true);
    });
  });

  it("env-only lore connection (LORE_BASE_URL + LORE_API_TOKEN) counts as configured", async () => {
    await withTempAgentDir((agentDir, loreHome) => {
      // LORE_HOME must be the empty temp dir: without it detection falls
      // through to the machine's own ~/.lore/config.json.
      const state = readMemoryRuntimeStateSync(agentDir, {
        LORE_HOME: loreHome,
        LORE_BASE_URL: "https://core.example",
        LORE_API_TOKEN: "lm_t",
      });
      assert.equal(state.provider, "lore");
      assert.equal(state.lore.source, "env");
      assert.equal(state.lore.baseUrl, "https://core.example");
    });
  });

  it("an explicit provider in settings.json wins over the migration default", async () => {
    await withTempAgentDir(async (agentDir, loreHome) => {
      await writeFile(
        join(loreHome, "config.json"),
        `${JSON.stringify({ base_url: "https://api.loremem.com", api_token: "lm_t" }, null, 2)}\n`,
      );
      await writeFile(
        join(agentDir, "settings.json"),
        `${JSON.stringify({ pixMemoryProvider: "local", defaultModel: "claude" }, null, 2)}\n`,
      );
      const state = readMemoryRuntimeStateSync(agentDir, loreConfiguredEnv(loreHome));
      assert.equal(state.provider, "local");
      assert.equal(state.explicit, "local");
    });
  });

  it("an invalid persisted provider value fails closed instead of silently re-defaulting", async () => {
    await withTempAgentDir(async (agentDir, loreHome) => {
      await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ pixMemoryProvider: "both" })}\n`);
      assert.throws(() => readMemoryRuntimeStateSync(agentDir, loreEnv(loreHome)), /pixMemoryProvider/);
    });
  });

  it("a malformed settings.json is an explicit error, never a silent fallback", async () => {
    await withTempAgentDir(async (agentDir, loreHome) => {
      await writeFile(join(agentDir, "settings.json"), "{ not json");
      assert.throws(() => readMemoryRuntimeStateSync(agentDir, { LORE_HOME: loreHome }), /settings\.json/);
    });
  });
});
