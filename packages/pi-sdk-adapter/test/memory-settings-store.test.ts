import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPiSdkSettingsConfigStore } from "../src/internal/settings-config-store.js";

let base: string;
let agentDir: string;
let loreHome: string;

function store(env: NodeJS.ProcessEnv = { LORE_HOME: loreHome }) {
  return createPiSdkSettingsConfigStore({ agentDir, env });
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "pix-memory-store-"));
  agentDir = join(base, "agent");
  loreHome = join(base, "lore");
  await mkdir(agentDir, { recursive: true });
  await mkdir(loreHome, { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function revisionOfStore(): Promise<string> {
  const snapshot = await store().readConfig();
  return snapshot.revision;
}

describe("settings store memory slice", () => {
  it("reads the migration default: lore when a connection exists, local otherwise", async () => {
    // No settings.json, no lore connection → local.
    const localSnapshot = await store({ LORE_HOME: loreHome }).readMemoryConfig();
    assert.equal(localSnapshot.provider, "local");
    assert.equal(localSnapshot.providerExplicit, false);
    assert.equal(localSnapshot.lore.configured, false);

    // No settings.json + lore config file → lore (existing Lore users are
    // never switched to local memory by the upgrade).
    await writeFile(
      join(loreHome, "config.json"),
      `${JSON.stringify({ base_url: "https://api.loremem.com", api_token: "lm_t" }, null, 2)}\n`,
    );
    const loreSnapshot = await store({ LORE_HOME: loreHome }).readMemoryConfig();
    assert.equal(loreSnapshot.provider, "lore");
    assert.equal(loreSnapshot.providerExplicit, false);
    assert.equal(loreSnapshot.lore.configured, true);
  });

  it("writes pixMemoryProvider via CAS, touching only that key", async () => {
    await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ defaultProvider: "acme", pixDefaultTools: null }, null, 2)}\n`);
    const before = await revisionOfStore();
    const result = await store().writeMemoryProvider({ expectedRevision: before, provider: "off" });
    assert.equal(result.provider, "off");
    assert.equal(result.providerExplicit, true);
    const raw = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
    assert.equal(raw.pixMemoryProvider, "off");
    assert.equal(raw.defaultProvider, "acme", "unknown keys round-trip untouched");
    assert.equal(raw.pixDefaultTools, null, "sibling pix keys round-trip untouched");

    // Stale revision → conflict, file unchanged.
    await assert.rejects(
      store().writeMemoryProvider({ expectedRevision: before, provider: "local" }),
      (error: Error & { code?: string }) => error.code === "conflict",
    );
    const after = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
    assert.equal(after.pixMemoryProvider, "off");
  });

  it("selecting lore without a configured connection fails closed (no fake enable)", async () => {
    const revision = await revisionOfStore();
    await assert.rejects(
      store().writeMemoryProvider({ expectedRevision: revision, provider: "lore" }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "invalid_input");
        assert.match(error.message, /not configured/i);
        return true;
      },
    );
    // With a connection the same write succeeds.
    await writeFile(
      join(loreHome, "config.json"),
      `${JSON.stringify({ base_url: "https://api.loremem.com", api_token: "lm_t" }, null, 2)}\n`,
    );
    const result = await store().writeMemoryProvider({ expectedRevision: revision, provider: "lore" });
    assert.equal(result.provider, "lore");
  });

  it("an invalid persisted provider value fails the read instead of silently re-defaulting", async () => {
    await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ pixMemoryProvider: 7 })}\n`);
    await assert.rejects(
      store().readMemoryConfig(),
      (error: Error & { code?: string }) => error.code === "invalid_input",
    );
    // The raw editor also refuses to WRITE a wrong-typed value.
    const current = await store().readConfig();
    await assert.rejects(
      store().writeConfig({
        expectedRevision: current.revision,
        content: `${JSON.stringify({ pixMemoryProvider: "both" })}\n`,
      }),
      (error: Error & { code?: string }) => error.code === "invalid_input",
    );
  });

  it("rejects malformed mutation input before touching the file", async () => {
    const revision = await revisionOfStore();
    for (const bad of [
      { expectedRevision: "nope", provider: "local" },
      { expectedRevision: revision, provider: "both" },
      { expectedRevision: revision },
    ]) {
      await assert.rejects(
        store().writeMemoryProvider(bad as never),
        (error: Error & { code?: string }) => error.code === "invalid_input",
      );
    }
    assert.equal(await revisionOfStore(), revision, "settings.json was never created by a rejected write");
  });

  it("an env-only lore connection (LORE_BASE_URL + LORE_API_TOKEN) also satisfies the lore gate", async () => {
    const revision = await revisionOfStore();
    const envOnly = await store({ LORE_HOME: loreHome, LORE_BASE_URL: "https://core.example", LORE_API_TOKEN: "lm_env" }).readMemoryConfig();
    assert.equal(envOnly.lore.configured, true);
    assert.equal(envOnly.lore.source, "env");
    assert.equal(envOnly.provider, "lore");
    const written = await store({ LORE_HOME: loreHome, LORE_BASE_URL: "https://core.example", LORE_API_TOKEN: "lm_env" })
      .writeMemoryProvider({ expectedRevision: revision, provider: "lore" });
    assert.equal(written.provider, "lore");
  });
});
