// Pi-SDK-backed project-trust stores (read-only query + narrow mutation).
//
// This is the ONLY module in the trust domain that touches the Pi SDK.
//
// Read side: pure trust-state reads — ProjectTrustStore.get(cwd) (the saved
// decision: boolean|null) and hasTrustRequiringProjectResources(cwd) (exact SDK
// trust-requiring-resource detection).
//
// Mutation side (set trusted ONLY): the REAL Pi SDK public trust API —
// ProjectTrustStore.set(cwd, true) — wrapped with:
//   * input validation (non-empty absolute path, no NUL),
//   * per-agent-dir in-process serialization (over the SDK's own
//     inter-process proper-lockfile lock, so concurrent writers can never
//     exhaust the SDK lock retries or lose an update),
//   * a restrictive umask around the synchronous SDK write so any newly
//     created trust.json / agent dir is 0600 / 0700,
//   * path safety: an existing trust.json must be a REAL regular file — a
//     planted symlink (or any non-regular node) is rejected fail-closed BEFORE
//     any write, and re-verified after,
//   * permission hardening: group/other bits on an existing trust.json are
//     tightened to 0600 BEFORE the write (never after a failure),
//   * read-after-write verification through the SAME store the read catalogs
//     use, so persistence and every read surface are immediately consistent.
//
// Every failure throws a fixed-code sanitized error: raw SDK messages, paths,
// file content and stacks never propagate. Because the SDK's own writer only
// touches the file after its lock+parse succeeds, a failed mutation leaves the
// persisted bytes immutable.
//
// Tri-state mapping (exact): null → unknown, true → trusted, false → denied.
// Effective trust = no trust-requiring resources OR saved decision is trusted —
// the exact SDK resolveProjectTrust computation, surfaced read-only here.
//
// The canonical cwd is passed per-call (project-scoped); the agent dir is
// captured once for the trust store. No network, no Worker/Agent.
import { chmod, lstat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
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

/** Fixed sanitized error codes for the trust mutation store. */
export type PiSdkTrustMutationErrorCode =
  | "TRUST_INPUT_INVALID"
  | "TRUST_STORE_UNSAFE"
  | "TRUST_WRITE_FAILED"
  | "TRUST_WRITE_UNVERIFIED";

/** Fixed sanitized messages; never interpolated with fs/SDK data. */
const TRUST_MUTATION_MESSAGES: Readonly<Record<PiSdkTrustMutationErrorCode, string>> = Object.freeze({
  TRUST_INPUT_INVALID: "Trust mutation input is invalid",
  TRUST_STORE_UNSAFE: "Trust store is unsafe",
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
   * Inject a pre-built ProjectTrustStore (tests). When injected without an
   * explicit agentDir the filesystem hardening passes are skipped (the trust
   * path is unknown); production always passes agentDir.
   */
  projectTrustStore?: ProjectTrustStore;
}

/** Required mode for the persisted trust.json: owner-only read/write. */
const TRUST_FILE_MODE = 0o600;

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

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error !== null && typeof error === "object" && "code" in error;
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
 * Pre-write safety pass over the trust file target. A missing file is fine
 * (first write); an existing one must be a REAL regular file — a planted
 * symlink (or any non-regular node) is rejected fail-closed so the write can
 * never escape the agent dir. Group/other permission bits are tightened to
 * 0600 BEFORE the write; a failed tightening aborts with no write at all.
 */
async function preflightTrustFile(trustPath: string): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(trustPath);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return;
    throw new PiSdkTrustMutationError("TRUST_STORE_UNSAFE");
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new PiSdkTrustMutationError("TRUST_STORE_UNSAFE");
  }
  if ((info.mode & 0o077) !== 0) {
    try {
      await chmod(trustPath, TRUST_FILE_MODE);
    } catch {
      throw new PiSdkTrustMutationError("TRUST_STORE_UNSAFE");
    }
  }
}

/**
 * Post-write verification: the trust file must still be a real regular file
 * with owner-only permissions, and the SAME store the read catalogs use must
 * read the just-saved trusted decision back (immediate read-after-write
 * consistency). Any mismatch is a fixed sanitized failure — never a silent
 * success and never a raw fs/SDK error.
 */
async function verifyTrustWrite(
  store: ProjectTrustStore,
  trustPath: string | undefined,
  cwd: string,
): Promise<void> {
  if (trustPath !== undefined) {
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(trustPath);
    } catch {
      throw new PiSdkTrustMutationError("TRUST_WRITE_UNVERIFIED");
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new PiSdkTrustMutationError("TRUST_WRITE_UNVERIFIED");
    }
    if ((info.mode & 0o077) !== 0) {
      try {
        await chmod(trustPath, TRUST_FILE_MODE);
        info = await lstat(trustPath);
      } catch {
        throw new PiSdkTrustMutationError("TRUST_WRITE_UNVERIFIED");
      }
      if ((info.mode & 0o077) !== 0) {
        throw new PiSdkTrustMutationError("TRUST_WRITE_UNVERIFIED");
      }
    }
  }
  let saved: boolean | null;
  try {
    saved = store.get(cwd);
  } catch {
    throw new PiSdkTrustMutationError("TRUST_WRITE_UNVERIFIED");
  }
  if (saved !== true) {
    throw new PiSdkTrustMutationError("TRUST_WRITE_UNVERIFIED");
  }
}

// Per-agent-dir in-process mutation serialization. Serializes OUR async
// preflight around the synchronous SDK write so two concurrent mutations can
// never interleave preflight/write and can never exhaust the SDK's inter-process
// lock retries. The SDK's own proper-lockfile lock additionally serializes
// against OTHER processes (the pi CLI).
const mutationLocks = new Map<string, Promise<unknown>>();

function withTrustMutationLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = mutationLocks.get(key) ?? Promise.resolve();
  const next = previous.then(run, run);
  mutationLocks.set(key, next.then(
    () => undefined,
    () => undefined,
  ));
  return next;
}

/**
 * Create the SDK-backed trust mutation store (set trusted only). The write
 * goes through the REAL Pi SDK public trust API (ProjectTrustStore.set) under
 * the agent-dir trust.json — the exact file the read catalogs read — with the
 * serialization, permission, path-safety and verification passes described at
 * the top of this module. No raw SDK message/path/content/stack ever escapes:
 * every failure is a fixed-code {@link PiSdkTrustMutationError}.
 */
export function createPiSdkTrustMutationStore(
  options: PiSdkTrustMutationStoreOptions = {},
): PiSdkTrustMutationStore {
  const agentDir = options.agentDir ?? getAgentDir();
  // Same trust.json path computation as the SDK constructor (resolve + join).
  const trustPath = join(resolve(agentDir), "trust.json");
  let cachedStore: ProjectTrustStore | undefined;

  const resolveStore = (): ProjectTrustStore =>
    options.projectTrustStore ?? (cachedStore ??= new ProjectTrustStore(agentDir));

  return {
    async setProjectTrusted(cwd: string): Promise<ProjectTrustStatus> {
      assertTrustMutationCwd(cwd);
      const store = resolveStore();
      const hardened = options.agentDir !== undefined || options.projectTrustStore === undefined;
      return withTrustMutationLock(trustPath, async () => {
        if (hardened) {
          await preflightTrustFile(trustPath);
        }
        try {
          // Restrictive umask ONLY around the synchronous SDK write: a newly
          // created trust.json / agent dir gets 0600 / 0700. No await can
          // interleave (Node is single-threaded across sync code), so the umask
          // window is exactly the SDK's own synchronous write.
          const previousUmask = process.umask(0o077);
          try {
            store.set(cwd, true);
          } finally {
            process.umask(previousUmask);
          }
        } catch {
          // SDK lock failure, unreadable/unwritable/corrupt trust.json, ENOSPC,
          // EACCES …: the SDK writes nothing when its lock+parse fails, and the
          // raw error (paths, content, stack) is dropped here — fixed code only.
          throw new PiSdkTrustMutationError("TRUST_WRITE_FAILED");
        }
        await verifyTrustWrite(store, hardened ? trustPath : undefined, cwd);
        return { cwd, level: "trusted", source: "saved" };
      });
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
