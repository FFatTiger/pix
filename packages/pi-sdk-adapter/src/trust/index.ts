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
// level enum, no read methods). It persists through the REAL Pi SDK public
// trust API (the SDK store's public set(cwd, true)) under the same agent-dir trust.json the
// query/resource catalogs read, so a write is immediately visible to every
// read. Errors are fixed-code and sanitized: raw SDK messages, paths, file
// content and stacks never propagate.
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
 * implementation persists through the real Pi SDK public trust API with
 * serialization, permission hardening (0600), path safety (no symlinked
 * trust.json) and read-after-write verification. Fixed sanitized error codes —
 * no raw SDK message/path/content/stack ever propagates.
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
 * Create the narrow trust-mutation port (set trusted only) backed by the real
 * Pi SDK public trust API (the SDK store's public set(cwd, true) under the agent-dir
 * trust.json). The write is serialized per agent dir (in-process mutex over
 * the SDK's own inter-process lock), permission-hardened (0600 file, 0700 new
 * dirs via a restrictive umask around the synchronous SDK write),
 * path-safe (an existing trust.json must be a real regular file — a planted
 * symlink is rejected fail-closed) and verified read-after-write against the
 * same store the read catalogs use, so persistence and every read surface are
 * immediately consistent. Failures throw fixed-code sanitized errors and leave
 * the persisted state immutable (the SDK writes nothing when its own
 * read/lock/validation fails). No network, no Worker/Agent, no raw
 * config/secret/path in any error.
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
