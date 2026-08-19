// Pi-SDK-backed project-trust stores (read-only query + narrow mutation).
//
// This is the ONLY module in the trust domain that touches the Pi SDK.
//
// Read side: pure trust-state reads — ProjectTrustStore.get(cwd) (the saved
// decision: boolean|null) and hasTrustRequiringProjectResources(cwd) (exact SDK
// trust-requiring-resource detection).
//
// Mutation side (set trusted ONLY): delegates persistence to the Pi SDK's
// PUBLIC ProjectTrustStore.set(cwd, true). Per the D-01 product decision we
// INHERIT Pi's per-user profile boundary: the SDK owns the trust.json file
// format, the cross-process proper-lockfile serialization, and the platform
// permission/profile semantics. Pix's adapter does NOT re-implement a forked
// atomic writer over trust.json; instead it:
//   * validates the mutation input (non-empty absolute path, no NUL),
//   * calls the real SDK `set()` (atomicity/locking are the SDK's contract —
//     upstream hardening of crash-atomicity/symlink-safety is requested of
//     Pi, not duplicated here),
//   * maps every SDK failure to a fixed sanitized PiSdkTrustMutationError,
//   * verifies the persisted decision through a FRESH public ProjectTrustStore
//     (the same store the read catalogs use), so persistence and every read
//     surface are immediately consistent and the key matches the SDK's
//     canonicalization; a write that does not read back as `true` fails
//     closed as TRUST_WRITE_UNVERIFIED (never a fake success).
//
// Every failure throws a fixed-code sanitized error: raw SDK messages, paths,
// file content and stacks never propagate.
//
// Tri-state mapping (exact): null → unknown, true → trusted, false → denied.
// Effective trust = no trust-requiring resources OR saved decision is trusted —
// the exact SDK resolveProjectTrust computation, surfaced read-only here.
//
// The canonical cwd is passed per-call (project-scoped, Host-canonicalized via
// the existing AllowedRoot path); the agent dir is captured once for the trust
// store. No network, no Worker/Agent. No SDK internal module is ever imported.
import { isAbsolute } from "node:path";
import {
  getAgentDir,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";
import type {
  ProjectTrustState,
  ProjectTrustStatus,
  TrustGateResult,
} from "@fffattiger/pix-runtime-core";
import type { PiSdkTrustMutationStore, PiSdkTrustStore } from "../trust/index.js";

/** Options for the SDK-backed read-only trust query store. */
export interface PiSdkTrustStoreOptions {
  /** Agent config directory; defaults to the SDK agent dir. */
  agentDir?: string;
  /** Inject a pre-built ProjectTrustStore (tests/composition). */
  projectTrustStore?: ProjectTrustStore;
}

/**
 * Fixed sanitized error codes for the trust mutation store.
 * D-01 dropped the forked writer, so `TRUST_STORE_UNSAFE` is no longer thrown:
 * symlink/hardlink/mode evidence is Pi's persistence contract, not Pix's.
 */
export type PiSdkTrustMutationErrorCode =
  | "TRUST_INPUT_INVALID"
  | "TRUST_WRITE_FAILED"
  | "TRUST_WRITE_UNVERIFIED";

/** Fixed sanitized messages; never interpolated with fs/SDK data. */
const TRUST_MUTATION_MESSAGES: Readonly<Record<PiSdkTrustMutationErrorCode, string>> = Object.freeze({
  TRUST_INPUT_INVALID: "Trust mutation input is invalid",
  TRUST_WRITE_FAILED: "Trust write failed",
  TRUST_WRITE_UNVERIFIED: "Trust write could not be verified",
});

/**
 * Trust-mutation failure with a FIXED sanitized code+message. Raw SDK error
 * messages, filesystem paths, file content and stacks are never carried: the
 * original cause is dropped at the boundary.
 */
export class PiSdkTrustMutationError extends Error {
  readonly code: PiSdkTrustMutationErrorCode;
  constructor(code: PiSdkTrustMutationErrorCode) {
    super(TRUST_MUTATION_MESSAGES[code]);
    this.name = "PiSdkTrustMutationError";
    this.code = code;
  }
}

/** Options for the SDK-backed trust mutation store. */
export interface PiSdkTrustMutationStoreOptions {
  /** Agent config directory; defaults to the SDK agent dir. */
  agentDir?: string;
  /**
   * Inject a pre-built ProjectTrustStore (tests/composition). The injection
   * MUST accompany an explicit agentDir so the read-back verification uses the
   * exact same store instance. Without an explicit agentDir the default SDK
   * agent dir is used and a store is built for read-back.
   */
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
 * Validate the mutation input: a non-empty absolute path with no NUL byte.
 * Anything else fails closed with a fixed sanitized error BEFORE any
 * filesystem or SDK access.
 */
function assertTrustMutationCwd(cwd: string): void {
  if (
    typeof cwd !== "string" ||
    cwd === "" ||
    cwd.includes("\0") ||
    !isAbsolute(cwd)
  ) {
    throw new PiSdkTrustMutationError("TRUST_INPUT_INVALID");
  }
}

/**
 * Create the SDK-backed trust mutation store (set trusted only). Persistence
 * is delegated to the Pi SDK PUBLIC ProjectTrustStore.set(cwd, true) (D-01: we
 * inherit Pi's per-user profile boundary and harden atomic/platform semantics
 * upstream rather than maintaining a forked writer). The adapter validates the
 * input, calls the SDK, maps every failure to a fixed sanitized error, and
 * verifies the persisted decision through a FRESH public ProjectTrustStore (the
 * same store the read catalogs use) so a write that did not actually take
 * effect fails closed as TRUST_WRITE_UNVERIFIED — never a fake success. No raw
 * SDK message/path/content/stack ever escapes.
 */
export function createPiSdkTrustMutationStore(
  options: PiSdkTrustMutationStoreOptions = {},
): PiSdkTrustMutationStore {
  const agentDir = options.agentDir ?? getAgentDir();
  const store = options.projectTrustStore ?? new ProjectTrustStore(agentDir);

  return {
    async setProjectTrusted(cwd: string): Promise<ProjectTrustStatus> {
      assertTrustMutationCwd(cwd);
      // Call the real SDK public API: it owns the proper-lockfile serialization
      // and the trust.json file-format/platform semantics. Any SDK failure is
      // mapped to a fixed sanitized error (raw message/path/stack dropped).
      try {
        store.set(cwd, true);
      } catch {
        throw new PiSdkTrustMutationError("TRUST_WRITE_FAILED");
      }
      // Read-after-write verification through a FRESH public ProjectTrustStore
      // (the same read surface the catalogs use): the decision must read back
      // as `true`, which also proves the persisted key matches the SDK's
      // canonicalization. A write that does not read back fails closed.
      let saved: boolean | null;
      try {
        saved = new ProjectTrustStore(agentDir).get(cwd);
      } catch {
        throw new PiSdkTrustMutationError("TRUST_WRITE_UNVERIFIED");
      }
      if (saved !== true) {
        throw new PiSdkTrustMutationError("TRUST_WRITE_UNVERIFIED");
      }
      return { cwd, level: "trusted", source: "saved" };
    },
  };
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
