import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
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
