// Read-only credential/provider catalog store backed by the Pi SDK
// ModelRuntime.
//
// This is the ONLY module in the credentials domain that touches the Pi SDK.
// It performs pure provider-metadata and sanitized-status reads only —
// ModelRuntime.getProviders / getProviderAuthStatus.
//
// HARD security boundary (read-only, never credential-returning, zero-write):
//  - NEVER calls getAuth()/checkAuth()/login()/logout()/refresh() or any
//    credential-returning or token-refresh API.
//  - ModelRuntime is created with allowModelNetwork:false AND an in-memory
//    credential store (pre-populated, read-only, from auth.json if present)
//    plus an in-memory models store, so create()/reads create ZERO files/dirs.
//    The adapter reads auth.json ONCE into memory to surface stored-credential
//    status; it never writes auth.json and never exposes raw secrets.
//  - Status semantics (single consistent source): `authorized` and
//    `isConfigured` BOTH derive from getProviderAuthStatus().configured — a
//    non-secret, non-refresh, presence-based flag (stored credential, runtime
//    key, environment key, or models.json config). They are always equal, so
//    there is never an `authorized:true/configured:false` split for stored OAuth.
//  - Provider listing (settings-cleanup product decision): ONLY providers
//    explicitly configured in `<agentDir>/models.json` surface. Built-in
//    providers — even with stored credentials or environment keys — are not
//    catalog rows; the operator's config file is the source of truth.
//  - No OAuth/login/logout/write; no key/token/header/raw store or log.
//  - Returns canonical runtime-core AuthProviderInfo / AuthProviderStatus only.
import { join } from "node:path";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai";
import type {
  AuthProviderInfo,
  AuthProviderKind,
  AuthProviderStatus,
} from "@fffattiger/pix-runtime-core";
import { makeRuntimeError } from "@fffattiger/pix-runtime-core";
import { loadInMemoryCredentials } from "./in-memory-credentials.js";
import { readConfiguredProviderIds } from "./models-json.js";
import type { PiSdkCredentialStore } from "../credentials/index.js";

/** Options for the SDK-backed read-only credential/provider store. */
export interface PiSdkCredentialStoreOptions {
  /** Agent config directory; defaults to the SDK agent dir. */
  agentDir?: string;
  /** Inject a pre-built offline ModelRuntime (tests/composition). */
  modelRuntime?: ModelRuntime;
}

/** Project provider auth methods onto the canonical AuthProviderKind set. */
function toMethods(provider: Provider): readonly AuthProviderKind[] {
  const methods: AuthProviderKind[] = [];
  // The SDK expresses auth as apiKey and/or oauth; device-code flows ride on
  // oauth, so the catalog advertises only the two material auth methods.
  if (provider.auth.apiKey) methods.push("apiKey");
  if (provider.auth.oauth) methods.push("oauth");
  return methods;
}

function toProviderInfo(provider: Provider): AuthProviderInfo {
  return {
    id: provider.id,
    ...(provider.name ? { name: provider.name } : {}),
    methods: toMethods(provider),
  };
}

/**
 * Create a read-only credential/provider store backed by an offline Pi SDK
 * ModelRuntime. The runtime is created lazily (on first read) with an in-memory
 * credential store (pre-read from auth.json) and in-memory models store, so
 * ZERO files are written. Provider metadata and sanitized configured/authorized
 * status are read with no credential material ever crossing the boundary.
 */
export function createPiSdkCredentialStore(
  options: PiSdkCredentialStoreOptions = {},
): PiSdkCredentialStore {
  const agentDir = options.agentDir ?? getAgentDir();
  let cachedRuntime: ModelRuntime | undefined;
  let cachedAllowed: Promise<ReadonlySet<string>> | undefined;

  const allowedProviders = (): Promise<ReadonlySet<string>> => {
    // Config-file filter always read from the agent dir on disk; injected
    // runtimes do not bypass it.
    cachedAllowed ??= readConfiguredProviderIds(agentDir);
    return cachedAllowed;
  };

  const runtime = async (): Promise<ModelRuntime> => {
    const instance = options.modelRuntime ?? cachedRuntime ?? await ModelRuntime.create({
      allowModelNetwork: false,
      // In-memory + pre-read auth.json: zero file writes; real stored-credential
      // status is surfaced; environment/runtime/model-config auth still resolves.
      credentials: await loadInMemoryCredentials(join(agentDir, "auth.json")),
      modelsStore: new InMemoryModelsStore(),
      // Pin models.json resolution to the (possibly injected) agentDir so the
      // SDK never falls back to the real ~/.pi/agent/models.json. A literal-key
      // provider in the real user config would otherwise surface as
      // configured here even with an empty injected agentDir.
      modelsPath: join(agentDir, "models.json"),
    });
    // Never project builtin fallback metadata over an invalid models.json.
    // ModelRuntime preserves the raw config error internally; expose only a
    // fixed structured classification with no file path/config/secret text.
    if (instance.getError()) {
      throw makeRuntimeError("invalid_input", "model configuration is invalid");
    }
    cachedRuntime ??= instance;
    return instance;
  };

  return {
    async listProviders(): Promise<readonly AuthProviderInfo[]> {
      const allowed = await allowedProviders();
      if (allowed.size === 0) return [];
      return (await runtime()).getProviders()
        .filter((provider) => allowed.has(provider.id))
        .map(toProviderInfo);
    },
    async getProviderStatus(providerId: string): Promise<AuthProviderStatus> {
      const instance = await runtime();
      if (!instance.getProvider(providerId)) {
        throw makeRuntimeError("not_found", `unknown provider: ${providerId}`);
      }
      // Single consistent non-secret source: getProviderAuthStatus().configured.
      // Deliberately NOT getAuth()/checkAuth() (credential-returning/refresh).
      const status = instance.getProviderAuthStatus(providerId);
      return {
        providerId,
        authorized: Boolean(status?.configured),
      };
    },
    async isConfigured(providerId: string): Promise<boolean> {
      const instance = await runtime();
      if (!instance.getProvider(providerId)) return false;
      // Must match getProviderStatus.authorized exactly (same source).
      return Boolean(instance.getProviderAuthStatus(providerId)?.configured);
    },
  };
}
