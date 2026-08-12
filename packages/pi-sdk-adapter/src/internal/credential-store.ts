// Read-only credential/provider catalog store backed by the Pi SDK
// ModelRuntime.
//
// This is the ONLY module in the credentials domain that touches the Pi SDK.
// It performs pure provider-metadata and sanitized-status reads only —
// ModelRuntime.getProviders / getProviderAuthStatus / hasConfiguredAuth.
//
// HARD security boundary (read-only, never credential-returning):
//  - NEVER calls getAuth()/checkAuth()/login()/logout()/refresh() or any
//    credential-returning or token-refresh API. getProviderAuthStatus() and
//    hasConfiguredAuth() report configured/authorized state with NO key, token,
//    header or raw credential material.
//  - No OAuth/login/logout/write; no key/token/header/raw store or log.
//  - Returns canonical runtime-core AuthProviderInfo / AuthProviderStatus only.
//  - ModelRuntime is created with allowModelNetwork:false (offline); no
//    network at construction or during reads.
import { join } from "node:path";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import type {
  AuthProviderInfo,
  AuthProviderKind,
  AuthProviderStatus,
} from "@fffattiger/pix-runtime-core";
import { makeRuntimeError } from "@fffattiger/pix-runtime-core";
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
 * ModelRuntime. The runtime is created lazily (on first read) with
 * allowModelNetwork:false; provider metadata and sanitized configured/authorized
 * status are read with no credential material ever crossing the boundary.
 */
export function createPiSdkCredentialStore(
  options: PiSdkCredentialStoreOptions = {},
): PiSdkCredentialStore {
  const agentDir = options.agentDir ?? getAgentDir();
  let cachedRuntime: ModelRuntime | undefined;

  const runtime = async (): Promise<ModelRuntime> => {
    if (options.modelRuntime) return options.modelRuntime;
    cachedRuntime ??= await ModelRuntime.create({
      allowModelNetwork: false,
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    return cachedRuntime;
  };

  return {
    async listProviders(): Promise<readonly AuthProviderInfo[]> {
      return (await runtime()).getProviders().map(toProviderInfo);
    },
    async getProviderStatus(providerId: string): Promise<AuthProviderStatus> {
      const instance = await runtime();
      const provider = instance.getProvider(providerId);
      if (!provider) {
        throw makeRuntimeError("not_found", `unknown provider: ${providerId}`);
      }
      // getProviderAuthStatus reports configured/authorized state only — no
      // credential material. Deliberately NOT getAuth()/checkAuth().
      const status = instance.getProviderAuthStatus(providerId);
      return {
        providerId,
        authorized: Boolean(status?.configured),
      };
    },
    async isConfigured(providerId: string): Promise<boolean> {
      const instance = await runtime();
      if (!instance.getProvider(providerId)) return false;
      return instance.hasConfiguredAuth(providerId);
    },
  };
}
