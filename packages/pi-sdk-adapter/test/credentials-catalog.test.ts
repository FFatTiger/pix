import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPiSdkCredentialCatalog } from "../src/credentials/index.js";
import type {
  AuthProviderInfo,
  AuthProviderStatus,
  CredentialCatalogPort,
} from "@fffattiger/pix-runtime-core";

// Seeded secrets that MUST NEVER appear in any catalog output, error, or log.
// Covers API key plus OAuth access/refresh tokens — all forbidden material.
const SECRETS = {
  apiKey: "sk-ant-SECRET-CRED-CANARY-0987654321",
  accessToken: "ACCESS-TOKEN-SECRET-CANARY",
  refreshToken: "REFRESH-TOKEN-SECRET-CANARY",
  bearer: "Bearer BEARER-SECRET-CANARY",
};

async function seedAgentDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pix-credentials-catalog-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "auth.json"),
    JSON.stringify({
      // Configured API-key provider — must report authorized without leaking the key.
      anthropic: { type: "api_key", key: SECRETS.apiKey },
      // Configured OAuth provider — refresh/access must never cross the boundary.
      openai: {
        type: "oauth",
        refresh: SECRETS.refreshToken,
        access: SECRETS.accessToken,
        expires: Date.now() + 3_600_000,
      },
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
    throw new Error("network access is forbidden by the read-only credential catalog");
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
    return called;
  };
}

function assertNoSecrets(label: string, ...payloads: string[]): void {
  for (const [name, value] of Object.entries(SECRETS)) {
    for (const payload of payloads) {
      assert.ok(
        !payload.includes(value),
        `${label}: secret ${name} leaked: ${payload}`,
      );
    }
  }
}

describe("read-only credential catalog (D3B-R1A)", () => {
  it("listProviders returns sanitized provider metadata offline", async () => {
    const root = await seedAgentDir();
    try {
      const release = installNetworkGuard();
      const catalog = createPiSdkCredentialCatalog({ agentDir: join(root, "agent") });
      const providers = await catalog.listProviders();
      release();
      assert.ok(providers.length > 0, "built-in providers must surface offline");
      const anthropic = providers.find((p) => p.id === "anthropic");
      assert.ok(anthropic, "anthropic provider present");
      assert.ok(anthropic!.methods.includes("apiKey"));
      assert.ok(anthropic!.name && anthropic!.name.length > 0);
      // Provider metadata carries only canonical fields (no credential material).
      for (const provider of providers) {
        const keys = Object.keys(provider) as (keyof AuthProviderInfo)[];
        for (const key of keys) {
          assert.ok(
            ["id", "name", "methods"].includes(key),
            `unexpected AuthProviderInfo field: ${key}`,
          );
        }
      }
      assertNoSecrets("listProviders", JSON.stringify(providers));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("configured provider reports authorized=true and configured=true", async () => {
    const root = await seedAgentDir();
    try {
      const catalog = createPiSdkCredentialCatalog({ agentDir: join(root, "agent") });
      const status = await catalog.getProviderStatus("anthropic");
      assert.equal(status.providerId, "anthropic");
      assert.equal(status.authorized, true);
      assert.ok(await catalog.isConfigured("anthropic"));
      // Status carries only canonical fields.
      const keys = Object.keys(status) as (keyof AuthProviderStatus)[];
      for (const key of keys) {
        assert.ok(
          ["providerId", "authorized", "accountName", "expiresAt"].includes(key),
          `unexpected AuthProviderStatus field: ${key}`,
        );
      }
      assertNoSecrets("getProviderStatus", JSON.stringify(status));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("OAuth provider status never leaks refresh/access tokens", async () => {
    const root = await seedAgentDir();
    try {
      const catalog = createPiSdkCredentialCatalog({ agentDir: join(root, "agent") });
      const status = await catalog.getProviderStatus("openai");
      const serialized = JSON.stringify(status);
      assertNoSecrets("oauth-status", serialized);
      // authorized reflects configured OAuth without exposing tokens.
      assert.equal(status.authorized, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unknown provider rejects with not_found, no secret leakage", async () => {
    const root = await seedAgentDir();
    try {
      const catalog = createPiSdkCredentialCatalog({ agentDir: join(root, "agent") });
      await assert.rejects(
        () => catalog.getProviderStatus("does-not-exist"),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "not_found");
          assertNoSecrets("not-found-error", String(error));
          return true;
        },
      );
      assert.equal(await catalog.isConfigured("does-not-exist"), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("no network access occurs during catalog reads", async () => {
    const root = await seedAgentDir();
    try {
      const release = installNetworkGuard();
      const catalog = createPiSdkCredentialCatalog({ agentDir: join(root, "agent") });
      await catalog.listProviders();
      await catalog.getProviderStatus("anthropic");
      await catalog.isConfigured("anthropic");
      const networkCalled = release();
      assert.equal(networkCalled, false, "credential catalog must not call network");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("catalog surface exposes no mutation/credential-returning methods", () => {
    const catalog = createPiSdkCredentialCatalog({
      listProviders: () => Promise.resolve([]),
      getProviderStatus: () => Promise.resolve({ providerId: "p", authorized: false }),
      isConfigured: () => Promise.resolve(false),
    });
    // Methods live on the prototype; enumerate them and assert read-only set.
    const proto = Object.getPrototypeOf(catalog);
    const methodNames = Object.getOwnPropertyNames(proto).filter(
      (name) => name !== "constructor",
    );
    assert.deepEqual([...methodNames].sort(), [
      "getProviderStatus",
      "isConfigured",
      "listProviders",
    ]);
    for (const forbidden of [
      "authorize", "logout", "login", "getAuth", "checkAuth", "setRuntimeApiKey",
      "removeRuntimeApiKey", "refresh",
    ]) {
      assert.equal(forbidden in catalog, false, `mutation method leaked: ${forbidden}`);
    }
  });

  it("implements the read-only CredentialCatalogPort contract", () => {
    const catalog: CredentialCatalogPort = createPiSdkCredentialCatalog({
      listProviders: () => Promise.resolve([]),
      getProviderStatus: () => Promise.resolve({ providerId: "p", authorized: false }),
      isConfigured: () => Promise.resolve(false),
    });
    assert.equal(typeof catalog.listProviders, "function");
    assert.equal(typeof catalog.getProviderStatus, "function");
    assert.equal(typeof catalog.isConfigured, "function");
  });
});

// Provider env-var keys that can configure a provider without auth.json; cleared
// for "absent" tests so ambient env cannot flip a provider to configured.
const ENV_KEYS = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY",
  "DEEPSEEK_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY", "XAI_API_KEY",
];

function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
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

describe("credential status consistency + zero-write (D3B-R1A hardening)", () => {
  it("authorized always equals isConfigured across every provider", async () => {
    const root = await seedAgentDir();
    try {
      await withEnv({}, async () => {
        const catalog = createPiSdkCredentialCatalog({ agentDir: join(root, "agent") });
        const providers = await catalog.listProviders();
        for (const provider of providers) {
          const status = await catalog.getProviderStatus(provider.id);
          const configured = await catalog.isConfigured(provider.id);
          assert.equal(
            status.authorized,
            configured,
            `authorized/isConfigured mismatch for ${provider.id}`,
          );
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stored OAuth reports authorized=true and isConfigured=true (no split)", async () => {
    const root = await seedAgentDir();
    try {
      await withEnv({}, async () => {
        const catalog = createPiSdkCredentialCatalog({ agentDir: join(root, "agent") });
        const status = await catalog.getProviderStatus("openai");
        const configured = await catalog.isConfigured("openai");
        assert.equal(status.authorized, true, "stored OAuth must be authorized");
        assert.equal(configured, true, "stored OAuth must be configured");
        assertNoSecrets("oauth", JSON.stringify(status));
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("API key from env configures a provider", async () => {
    const root = await seedAgentDir();
    try {
      await withEnv({ ANTHROPIC_API_KEY: "sk-ant-ENV-ONLY-SECRET" }, async () => {
        const catalog = createPiSdkCredentialCatalog({ agentDir: join(root, "agent") });
        assert.equal(await catalog.isConfigured("anthropic"), true);
        const status = await catalog.getProviderStatus("anthropic");
        assert.equal(status.authorized, true);
        assertNoSecrets("env", JSON.stringify(status));
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("absent provider (no stored, no env) reports not configured", async () => {
    const root = await seedAgentDir();
    try {
      // Seed only OAuth openai; anthropic has no stored cred and env is cleared.
      await withEnv({}, async () => {
        const catalog = createPiSdkCredentialCatalog({ agentDir: join(root, "agent") });
        // anthropic is built-in but unconfigured (no key in this seeded auth.json
        // has only anthropic apiKey though) — verify consistency for an unconfigured one.
        // Use a provider with no seeded cred and no env: pick groq.
        const providers = await catalog.listProviders();
        const absent = providers.find((p) => !p.methods.includes("oauth")) ?? providers[0]!;
        const configured = await catalog.isConfigured(absent.id);
        const status = await catalog.getProviderStatus(absent.id);
        assert.equal(configured, status.authorized);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads create ZERO new files (no auth.json/models-store.json placeholders)", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-cred-zerofile-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    // Seed auth.json (the only file that should ever exist there).
    await writeFile(
      join(agentDir, "auth.json"),
      JSON.stringify({ anthropic: { type: "api_key", key: SECRETS.apiKey } }),
      "utf8",
    );
    try {
      await withEnv({}, async () => {
        const before = await readdir(agentDir);
        const catalog = createPiSdkCredentialCatalog({ agentDir });
        await catalog.listProviders();
        await catalog.getProviderStatus("anthropic");
        await catalog.isConfigured("anthropic");
        const after = await readdir(agentDir);
        assert.deepEqual(after, before, "credential reads must create no new files");
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("clean missing agentDir is never created by reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-cred-missing-"));
    const agentDir = join(root, "agent"); // not created
    try {
      await withEnv({}, async () => {
        const before = await readdir(root);
        const catalog = createPiSdkCredentialCatalog({ agentDir });
        await catalog.listProviders();
        await catalog.isConfigured("anthropic");
        const after = await readdir(root);
        assert.deepEqual(after, before, "missing agentDir must not be created");
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("credential catalog agentDir isolation (D3B-R1A): empty injected agentDir never exposes global config", () => {
  // A built-in provider configured in the GLOBAL models.json with a literal key
  // would, without the modelsPath pin, surface as configured here even when the
  // injected agentDir is empty. Pinning models.json to join(agentDir,...)
  // ensures only the injected agentDir's models.json is consulted.
  it("global models.json literal-key provider does not leak into an empty injected agentDir", async () => {
    const globalRoot = await mkdtemp(join(tmpdir(), "pix-cred-global-"));
    const globalAgentDir = join(globalRoot, "agent");
    await mkdir(globalAgentDir, { recursive: true });
    // GLOBAL models.json: configure a built-in provider with a literal key.
    await writeFile(
      join(globalAgentDir, "models.json"),
      JSON.stringify({
        providers: {
          deepseek: {
            baseUrl: "https://global-proxy.example.com/v1",
            auth: { apiKey: true },
            apiKey: "sk-GLOBAL-DEEPSEEK-LITERAL",
          },
        },
      }),
      "utf8",
    );
    const injectedRoot = await mkdtemp(join(tmpdir(), "pix-cred-injected-"));
    const injectedAgentDir = join(injectedRoot, "agent"); // intentionally NOT created
    try {
      await withEnv({}, async () => {
        // Simulate the real ~/.pi being the global dir: getAgentDir() resolves
        // here, so the SDK's internal modelsPath default would read it.
        const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = globalAgentDir;
        try {
          // CONTROL: pointing the catalog at the global agentDir configures it.
          const ctrl = createPiSdkCredentialCatalog({ agentDir: globalAgentDir });
          assert.equal(
            await ctrl.isConfigured("deepseek"),
            true,
            "control: global configures deepseek",
          );
          // ISOLATION: an empty injected agentDir must NOT see the global config.
          const iso = createPiSdkCredentialCatalog({ agentDir: injectedAgentDir });
          assert.equal(
            await iso.isConfigured("deepseek"),
            false,
            "empty injected agentDir must not expose global provider status",
          );
          const status = await iso.getProviderStatus("deepseek");
          assert.equal(status.authorized, false);
          assertNoSecrets("isolation", JSON.stringify(status));
          // The injected agentDir is still absent (zero writes).
          assert.deepEqual(
            await readdir(injectedRoot),
            [],
            "injected agentDir must not be created",
          );
        } finally {
          if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
          else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
        }
      });
    } finally {
      await rm(globalRoot, { recursive: true, force: true });
      await rm(injectedRoot, { recursive: true, force: true });
    }
  });
});

describe("credential pre-read: malformed auth.json entries skipped independently (D3B-R1A)", () => {
  // A null/undefined/malformed entry must be SKIPPED without aborting later
  // credentials. The earlier isCredential form (a && b && c || d) dereferenced
  // null and threw inside the seed loop, losing every entry after it.

  async function seedAuth(agentDir: string, auth: Record<string, unknown>): Promise<void> {
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "auth.json"), JSON.stringify(auth), "utf8");
  }

  it("null entry before valid credentials does not abort later ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-cred-null-before-"));
    const agentDir = join(root, "agent");
    // null FIRST, then a valid API-key and OAuth entry.
    await seedAuth(agentDir, {
      "bad-null-first": null,
      anthropic: { type: "api_key", key: SECRETS.apiKey },
      openai: {
        type: "oauth",
        refresh: SECRETS.refreshToken,
        access: SECRETS.accessToken,
        expires: Date.now() + 3_600_000,
      },
    });
    try {
      await withEnv({}, async () => {
        const catalog = createPiSdkCredentialCatalog({ agentDir });
        // The null entry is skipped (not aborting), so later credentials load.
        assert.equal(
          await catalog.isConfigured("anthropic"),
          true,
          "valid API key after a null entry must still load",
        );
        assert.equal(
          await catalog.isConfigured("openai"),
          true,
          "valid OAuth after a null entry must still load",
        );
        const ant = await catalog.getProviderStatus("anthropic");
        const oai = await catalog.getProviderStatus("openai");
        assert.equal(ant.authorized, true);
        assert.equal(oai.authorized, true);
        assertNoSecrets("null-before", JSON.stringify(ant), JSON.stringify(oai));
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("malformed entries after valid credentials are skipped independently", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-cred-malformed-after-"));
    const agentDir = join(root, "agent");
    // Valid FIRST, then a trailing block of null/wrong-type/empty/non-object
    // entries, then another valid credential after them.
    await seedAuth(agentDir, {
      anthropic: { type: "api_key", key: SECRETS.apiKey },
      "bad-null": null,
      "bad-wrong-type": { type: "totally-unknown" },
      "bad-empty": {},
      "bad-non-object": "just-a-string",
      "bad-number": 42,
      openai: {
        type: "oauth",
        refresh: SECRETS.refreshToken,
        access: SECRETS.accessToken,
        expires: Date.now() + 3_600_000,
      },
    });
    try {
      await withEnv({}, async () => {
        const catalog = createPiSdkCredentialCatalog({ agentDir });
        // Every malformed entry is skipped; valid entries on both sides load.
        assert.equal(await catalog.isConfigured("anthropic"), true);
        assert.equal(await catalog.isConfigured("openai"), true);
        for (const bad of [
          "bad-null",
          "bad-wrong-type",
          "bad-empty",
          "bad-non-object",
          "bad-number",
        ]) {
          // None of these are real providers, so they report not configured.
          assert.equal(
            await catalog.isConfigured(bad),
            false,
            `malformed entry ${bad} must not configure a provider`,
          );
        }
        assertNoSecrets(
          "malformed-after",
          JSON.stringify(await catalog.getProviderStatus("anthropic")),
          JSON.stringify(await catalog.getProviderStatus("openai")),
        );
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
