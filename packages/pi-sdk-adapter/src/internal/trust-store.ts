// Read-only project-trust query store backed by the Pi SDK trust primitives.
//
// This is the ONLY module in the trust domain that touches the Pi SDK. It
// performs pure trust-state reads only — ProjectTrustStore.get(cwd) (the saved
// decision: boolean|null) and hasTrustRequiringProjectResources(cwd) (exact SDK
// trust-requiring-resource detection). No write/mutation (no setTrust).
//
// Tri-state mapping (exact): null → unknown, true → trusted, false → denied.
// Effective trust = no trust-requiring resources OR saved decision is trusted —
// the exact SDK resolveProjectTrust computation, surfaced read-only here.
//
// The canonical cwd is passed per-call (project-scoped); the agent dir is
// captured once for the trust store. No network, no Worker/Agent.
import {
  getAgentDir,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";
import type {
  ProjectTrustState,
  TrustGateResult,
} from "@fffattiger/pix-runtime-core";
import type { PiSdkTrustStore } from "../trust/index.js";

/** Options for the SDK-backed read-only trust query store. */
export interface PiSdkTrustStoreOptions {
  /** Agent config directory; defaults to the SDK agent dir. */
  agentDir?: string;
  /** Inject a pre-built ProjectTrustStore (tests/composition). */
  projectTrustStore?: ProjectTrustStore;
}

/** Map the saved SDK decision onto the canonical tri-state. */
function toState(decision: boolean | null): ProjectTrustState {
  return decision === null ? "unknown" : decision ? "trusted" : "denied";
}

/**
 * Read a saved trust decision, failing closed (null) when trust.json is
 * malformed/unreadable so a raw SDK Error, path, file content, or stack can
 * never propagate. Shared corruption-safe logic for both the trust and
 * resource catalogs.
 */
function safeTrustDecision(store: ProjectTrustStore, cwd: string): boolean | null {
  try {
    return store.get(cwd);
  } catch {
    // Malformed/unreadable trust.json: fail closed to "no decision".
    return null;
  }
}

/**
 * Read the saved trust decision for a cwd directly from the agent-dir trust
 * store, failing closed (null) on corruption. Shared with the resource catalog
 * so the default trusted computation applies the identical corruption-safe
 * logic as the trust catalog — never throwing, never leaking a raw path,
 * content, or stack.
 */
export function readTrustDecision(agentDir: string, cwd: string): boolean | null {
  return safeTrustDecision(new ProjectTrustStore(agentDir), cwd);
}

/**
 * Create a read-only trust query store backed by the Pi SDK trust primitives.
 * The trust store is built lazily (on first read); no network, no writes.
 *
 * Corruption safety: a malformed/unreadable trust.json is treated as NO
 * decision (fail closed) — state `unknown`, isTrusted false, resources withheld
 * — never propagating a raw SDK Error, path, file content, or stack.
 */
export function createPiSdkTrustStore(
  options: PiSdkTrustStoreOptions = {},
): PiSdkTrustStore {
  const agentDir = options.agentDir ?? getAgentDir();
  let cachedStore: ProjectTrustStore | undefined;

  const resolveStore = (): ProjectTrustStore =>
    options.projectTrustStore ?? (cachedStore ??= new ProjectTrustStore(agentDir));
  // Shared corruption-safe decision reader: malformed trust.json => null
  // (never throws, never leaks a raw path/content/stack).
  const decision = (cwd: string): boolean | null =>
    safeTrustDecision(resolveStore(), cwd);

  return {
    async getProjectTrustState(cwd: string): Promise<ProjectTrustState> {
      return toState(decision(cwd));
    },
    async isTrusted(cwd: string): Promise<boolean> {
      // Exact SDK effective-trust computation, fail-closed on corruption.
      return !hasTrustRequiringProjectResources(cwd) || decision(cwd) === true;
    },
    async canReloadResources(cwd: string): Promise<TrustGateResult> {
      const current = decision(cwd);
      const allowed =
        !hasTrustRequiringProjectResources(cwd) || current === true;
      return {
        allowed,
        level: toState(current),
        ...(allowed ? {} : { reason: "project is not trusted" }),
      };
    },
  };
}
