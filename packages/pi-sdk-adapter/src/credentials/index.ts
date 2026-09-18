// Public credentials surface of the pix Pi SDK Adapter (D3B-R1A).
//
// Read-only CredentialCatalogPort backed by an offline Pi SDK model runtime.
// This module satisfies runtime-core CredentialCatalogPort WITHOUT importing
// the Pi SDK: the SDK-coupled store lives in src/internal/credential-store.ts.
// It exposes provider metadata and sanitized configured/authorized status only;
// it NEVER returns raw API keys, tokens, headers or any credential material,
// and never calls a credential-returning/refresh API. No OAuth/login/logout/
// write, no Worker/Agent, no network.
import type {
  AuthProviderInfo,
  AuthProviderStatus,
  CredentialCatalogPort,
} from "@fffattiger/pix-runtime-core";
import { createPiSdkCredentialStore } from "../internal/credential-store.js";

/**
 * Injectable read-only credential/provider store contract. The default
 * implementation (created by the internal store factory) reads provider
 * metadata and sanitized status from the Pi SDK model runtime offline; tests
 * and composition may supply their own to exercise the catalog in isolation.
 * Every method is a pure read-only provider/status read; no credential
 * material.
 */
export interface PiSdkCredentialStore {
  listProviders(): Promise<readonly AuthProviderInfo[]>;
  getProviderStatus(providerId: string): Promise<AuthProviderStatus>;
  isConfigured(providerId: string): Promise<boolean>;
}

/** Options for the default SDK-backed store (ignored when a store is injected). */
export interface PiSdkCredentialCatalogOptions {
  /** Agent config directory; defaults to the SDK agent dir. */
  readonly agentDir?: string;
}

class PiSdkCredentialCatalog implements CredentialCatalogPort {
  constructor(private readonly store: PiSdkCredentialStore) {}

  listProviders(): Promise<readonly AuthProviderInfo[]> {
    return this.store.listProviders();
  }

  getProviderStatus(providerId: string): Promise<AuthProviderStatus> {
    return this.store.getProviderStatus(providerId);
  }

  isConfigured(providerId: string): Promise<boolean> {
    return this.store.isConfigured(providerId);
  }
}

function isCredentialStore(value: unknown): value is PiSdkCredentialStore {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { listProviders?: unknown }).listProviders === "function"
  );
}

/**
 * Create a read-only CredentialCatalogPort backed by the offline Pi SDK model
 * runtime. Pass an explicit {@link PiSdkCredentialStore} for tests/composition,
 * or {@link PiSdkCredentialCatalogOptions} (agentDir) to build the default
 * SDK-backed store. Reads are provider-metadata/status access only — no
 * credential material, no network, zero Workers/Agents.
 */
export function createPiSdkCredentialCatalog(
  storeOrOptions: PiSdkCredentialStore | PiSdkCredentialCatalogOptions = {},
): CredentialCatalogPort {
  const store = isCredentialStore(storeOrOptions)
    ? storeOrOptions
    : createPiSdkCredentialStore(
        storeOrOptions.agentDir === undefined
          ? {}
          : { agentDir: storeOrOptions.agentDir },
      );
  return new PiSdkCredentialCatalog(store);
}
