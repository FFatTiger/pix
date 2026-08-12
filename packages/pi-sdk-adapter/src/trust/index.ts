// Public trust surface of the pix Pi SDK Adapter (D3B-R1A).
//
// Read-only ProjectTrustQueryPort backed by the Pi SDK trust primitives. This
// module satisfies runtime-core ProjectTrustQueryPort WITHOUT importing the Pi
// SDK: the SDK-coupled store lives in src/internal/trust-store.ts. It surfaces
// the exact tri-state (unknown/trusted/denied) and the resource-reload gate;
// no write/mutation. No network, no Worker/Agent.
import type {
  ProjectTrustQueryPort,
  ProjectTrustState,
  TrustGateResult,
} from "@fffattiger/pix-runtime-core";
import { createPiSdkTrustStore } from "../internal/trust-store.js";

/**
 * Injectable read-only trust query store contract. The default implementation
 * (created by the internal store factory) reads the Pi SDK trust store offline;
 * tests and composition may supply their own to exercise the query in
 * isolation. Every method is a pure read-only trust-state read; no write.
 */
export interface PiSdkTrustStore {
  getProjectTrustState(cwd: string): Promise<ProjectTrustState>;
  isTrusted(cwd: string): Promise<boolean>;
  canReloadResources(cwd: string): Promise<TrustGateResult>;
}

/** Options for the default SDK-backed store (ignored when a store is injected). */
export interface PiSdkTrustCatalogOptions {
  /** Agent config directory; defaults to the SDK agent dir. */
  readonly agentDir?: string;
}

class PiSdkTrustCatalog implements ProjectTrustQueryPort {
  constructor(private readonly store: PiSdkTrustStore) {}

  getProjectTrustState(cwd: string): Promise<ProjectTrustState> {
    return this.store.getProjectTrustState(cwd);
  }

  isTrusted(cwd: string): Promise<boolean> {
    return this.store.isTrusted(cwd);
  }

  canReloadResources(cwd: string): Promise<TrustGateResult> {
    return this.store.canReloadResources(cwd);
  }
}

function isTrustStore(value: unknown): value is PiSdkTrustStore {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { getProjectTrustState?: unknown }).getProjectTrustState ===
      "function"
  );
}

/**
 * Create a read-only ProjectTrustQueryPort backed by the Pi SDK trust
 * primitives. Pass an explicit {@link PiSdkTrustStore} for tests/composition,
 * or {@link PiSdkTrustCatalogOptions} (agentDir) to build the default SDK-backed
 * store. Queries are trust-state reads only — no write, no network, zero
 * Workers/Agents.
 */
export function createPiSdkTrustCatalog(
  storeOrOptions: PiSdkTrustStore | PiSdkTrustCatalogOptions = {},
): ProjectTrustQueryPort {
  const store = isTrustStore(storeOrOptions)
    ? storeOrOptions
    : createPiSdkTrustStore(
        storeOrOptions.agentDir === undefined
          ? {}
          : { agentDir: storeOrOptions.agentDir },
      );
  return new PiSdkTrustCatalog(store);
}
