// Read-only ProjectTrustQueryPort + narrow ProjectTrustMutationPort backed by
// the Pi SDK trust primitives.
//
// The query surface (createPiSdkTrustCatalog) satisfies runtime-core
// ProjectTrustQueryPort WITHOUT importing the Pi SDK: the SDK-coupled store
// lives in src/internal/trust-store.ts. It surfaces the exact tri-state
// (unknown/trusted/denied) and the resource-reload gate; no write/mutation.
// No network, no Worker/Agent.
//
// The mutation surface (createPiSdkTrustMutation) satisfies the separate,
// narrow ProjectTrustMutationPort (set trusted ONLY — no denied write, no
// level enum, no read methods). It DELEGATES persistence to the Pi SDK PUBLIC
// ProjectTrustStore.set(cwd, true) (D-01: specialise the per-user profile
// boundary and harden atomic/platform semantics upstream rather than fork a
// writer). The adapter validates the input, maps every SDK failure to a fixed
// sanitized error, and verifies the persisted decision through a FRESH public
// ProjectTrustStore (the same store the read catalogs use) — a write that does
// not read back as trusted fails closed, never a fake success. The Pi SDK owns
// the file format, the cross-process proper-lockfile serialization, and the
// platform permission semantics.
import type {
  ProjectTrustMutationPort,
  ProjectTrustQueryPort,
  ProjectTrustState,
  ProjectTrustStatus,
  TrustGateResult,
} from "@fffattiger/pix-runtime-core";
import { createPiSdkTrustStore, createPiSdkTrustMutationStore } from "../internal/trust-store.js";

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

/**
 * Injectable trust-mutation store contract (set trusted only). The default
 * implementation delegates persistence to the Pi SDK PUBLIC
 * ProjectTrustStore.set(cwd, true) (D-01: inherit Pi's per-user profile
 * boundary and harden atomic/platform semantics upstream), then verifies the
 * decision through a fresh read-back using the exact public SDK store the read
 * catalogs use, failing closed on any miss. Failure semantics: a write that
 * does not take effect reads back as not-trusted and is mapped to a fixed
 * sanitized error — never a fake success. No raw SDK message/path/content/
 * stack ever propagates.
 */
export interface PiSdkTrustMutationStore {
  setProjectTrusted(cwd: string): Promise<ProjectTrustStatus>;
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

class PiSdkTrustMutation implements ProjectTrustMutationPort {
  constructor(private readonly store: PiSdkTrustMutationStore) {}

  setProjectTrusted(cwd: string): Promise<ProjectTrustStatus> {
    return this.store.setProjectTrusted(cwd);
  }
}

function isTrustMutationStore(value: unknown): value is PiSdkTrustMutationStore {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { setProjectTrusted?: unknown }).setProjectTrusted ===
      "function"
  );
}

/** Options for the default SDK-backed mutation store (ignored when injected). */
export interface PiSdkTrustMutationOptions {
  /** Agent config directory; defaults to the SDK agent dir. */
  readonly agentDir?: string;
}

/**
 * Create the narrow trust-mutation port (set trusted only) backed by the Pi
 * SDK PUBLIC ProjectTrustStore.set(cwd, true). Per D-01 the adapter inherits
 * Pi's per-user profile boundary and lets the SDK own the trust.json file
 * format, the cross-process proper-lockfile serialization, and the platform
 * permission semantics. The adapter validates the input, maps every SDK
 * failure to a fixed-code sanitized error, and verifies the persisted decision
 * through a fresh read-back using the exact public SDK store the read catalogs
 * use (a write that does not read back as trusted fails closed). No network,
 * no Worker/Agent, no raw config/secret/path in any error.
 */
export function createPiSdkTrustMutation(
  storeOrOptions: PiSdkTrustMutationStore | PiSdkTrustMutationOptions = {},
): ProjectTrustMutationPort {
  const store = isTrustMutationStore(storeOrOptions)
    ? storeOrOptions
    : createPiSdkTrustMutationStore(
        storeOrOptions.agentDir === undefined
          ? {}
          : { agentDir: storeOrOptions.agentDir },
      );
  return new PiSdkTrustMutation(store);
}
