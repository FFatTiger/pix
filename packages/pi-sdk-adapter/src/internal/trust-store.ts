// Pi-SDK-backed project-trust stores (read-only query + narrow mutation).
//
// This is the ONLY module in the trust domain that touches the Pi SDK.
//
// Read side: pure trust-state reads — ProjectTrustStore.get(cwd) (the saved
// decision: boolean|null) and hasTrustRequiringProjectResources(cwd) (exact SDK
// trust-requiring-resource detection).
//
// Mutation side (set trusted ONLY): a self-contained ATOMIC writer over the
// agent-dir trust.json — the EXACT file the SDK read surface (ProjectTrustStore
// and the pi CLI) reads. Production NEVER calls the SDK's set(); it holds the
// SAME inter-process lock the SDK uses (proper-lockfile@4.1.2 over the agent
// dir with lockfilePath trust.json.lock, realpath:false) and performs a strict
// bounded read-merge-write with crash-atomic temp+fsync+rename persistence:
//   * input validation (non-empty absolute path, no NUL),
//   * per-agent-dir in-process serialization (over the same proper-lockfile
//     cross-process lock, so concurrent writers never exhaust lock retries or
//     lose an update),
//   * bounded strict RMW: missing → {}; an existing trust.json must be a real
//     O_NOFOLLOW regular file with nlink===1 and owner-only permissions
//     (tightened to 0600 first), ≤1 MiB, strict plain-object JSON whose values
//     are only true/false/null — symlink/hardlink/swap/dir-identity violations
//     fail closed BEFORE any write,
//   * exact SDK serialization (sorted keys, 2-space indent, trailing newline),
//   * crash-atomic persistence: same-dir temp (O_EXCL|O_NOFOLLOW 0600) → write
//     all → fsync → identity check → re-verify directory + target
//     identity/absence → atomic rename → directory fsync → post-verify that
//     trust.json IS the temp inode (regular/nlink1/0600); temp is cleaned up
//     on every failure,
//   * honest failure semantics: any failure before rename leaves the old bytes
//     immutable; a rename-then-dir-fsync failure never reports success (the
//     published file is still valid and readable),
//   * read-after-write verification through a FRESH public ProjectTrustStore
//     (same store the read catalogs use), so persistence and every read
//     surface are immediately consistent and the key matches the SDK's
//     canonicalization.
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
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
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

/**
 * Test-only fault injection for the atomic trust writer (crash-window probes).
 * NEVER wired by production composition — only reachable through the internal
 * store factory below. Each window throws a fixed sanitized error at the named
 * point so the honest crash semantics are exercised deterministically.
 */
export interface PiSdkTrustFaultInjection {
  /** Throw AFTER the temp file is written+fsynced but BEFORE the rename: the old trust.json bytes stay immutable. */
  failAfterTempWrite?: boolean;
  /** Throw AFTER the atomic rename but BEFORE the directory fsync: the published file is valid+readable, but the mutation must NOT report success. */
  failAfterRename?: boolean;
  /**
   * Test hook invoked AFTER the temp file is durable and BEFORE the pre-rename
   * re-verification, so a test can substitute the target (swap/hardlink/symlink)
   * or the agent dir and assert the re-verification fails closed.
   */
  beforeReverify?: (trustPath: string, agentDir: string) => Promise<void>;
}

/** Options for the SDK-backed trust mutation store. */
export interface PiSdkTrustMutationStoreOptions {
  /** Agent config directory; defaults to the SDK agent dir. */
  agentDir?: string;
  /**
   * Inject a pre-built ProjectTrustStore (tests/composition). When injected
   * WITHOUT an explicit agentDir the filesystem path is unknown, so the narrow
   * real-SDK set() seam is used instead of the atomic writer; production always
   * passes agentDir (atomic path). With agentDir set, the injected store is
   * only used as the read-back verification source.
   */
  projectTrustStore?: ProjectTrustStore;
  /** Test-only fault injection (crash-window probes); never used in production. */
  faultInjection?: PiSdkTrustFaultInjection;
}

/** Required mode for the persisted trust.json: owner-only read/write. */
const TRUST_FILE_MODE = 0o600;

/** Hard upper bound on the trust.json size accepted by the bounded RMW. */
const TRUST_MAX_BYTES = 1024 * 1024; // 1 MiB

/**
 * Same inter-process lock contract as the SDK/CLI: proper-lockfile over the
 * agent dir with `realpath:false` and the lockfile at `${trustPath}.lock` —
 * the EXACT directory both ProjectTrustStore.get/set and the pi CLI contend
 * on, so our atomic writer and the SDK/CLI can never interleave on the file.
 */
const TRUST_LOCK_MAX_ATTEMPTS = 10;
const TRUST_LOCK_RETRY_MS = 20;

/** The pre-image identity of the trust.json we read (dev/ino), used to fail
 * closed if the target is swapped/hardlinked/replaced before the rename. */
interface TrustFilePreImage {
  dev: number;
  ino: number;
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
 * Canonicalize a cwd exactly like the SDK trust store key computation
 * (`canonicalizePath(resolvePath(cwd))` = realpath with raw-path fallback),
 * reimplemented with public Node APIs only — no SDK internal import. In
 * production the Host already passes an existing AllowedRoot canonical path,
 * so this is normally a no-op; the fresh ProjectTrustStore read-back after the
 * write is the authoritative proof that the persisted key matches the SDK.
 */
async function canonicalizeCwd(cwd: string): Promise<string> {
  const resolved = resolve(cwd);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Strict bounded trust.json parser — byte-for-byte the SDK's readTrustFile
 * contract: a plain (non-array) object whose values are only true/false/null.
 * Anything else (truncated/invalid JSON, array, scalar, foreign value types)
 * fails closed with a fixed sanitized error and never touches the file.
 */
function parseTrustJson(text: string): Record<string, boolean | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PiSdkTrustMutationError("TRUST_WRITE_FAILED");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PiSdkTrustMutationError("TRUST_WRITE_FAILED");
  }
  const data: Record<string, boolean | null> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value !== true && value !== false && value !== null) {
      throw new PiSdkTrustMutationError("TRUST_WRITE_FAILED");
    }
    data[key] = value;
  }
  return data;
}

/**
 * Exact SDK serialization for the persisted trust.json: keys sorted (default
 * string order), 2-space indent, trailing newline — the byte format the SDK
 * read surface and the pi CLI accept (JSON.parse ignores the formatting, so
 * the canonical key and values round-trip identically).
 */
function serializeTrustData(data: Record<string, boolean | null>): string {
  const sorted: Record<string, boolean | null> = {};
  for (const key of Object.keys(data).sort()) {
    const value = data[key];
    if (value === true || value === false || value === null) {
      sorted[key] = value;
    }
  }
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/**
 * Bounded strict read of the existing trust.json. Missing → `{}` (first
 * write). An existing target must be a REAL regular file: opened O_NOFOLLOW
 * (a planted symlink/non-regular node is rejected fail-closed, never
 * followed), fstat confirms regular + nlink===1 (a hardlink would write
 * through into a shared inode, so it fails closed BEFORE any write), owner-only
 * permissions are tightened to 0600 via the fd (never after a failure), the
 * size is bounded to 1 MiB, and the content is parsed as strict plain-object
 * JSON. Returns the data plus the target's dev/ino pre-image for the
 * pre-rename re-verification.
 */
async function readTrustFileStrict(
  trustPath: string,
): Promise<{ data: Record<string, boolean | null>; preImage: TrustFilePreImage | undefined }> {
  let fh: FileHandle | undefined;
  try {
    fh = await open(
      trustPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return { data: {}, preImage: undefined };
    }
    // ELOOP/EMLINK/EINVAL: the final component is a symlink (or otherwise
    // unopenable non-regular node) — fail closed, never write through it.
    if (
      isErrnoException(error) &&
      (error.code === "ELOOP" || error.code === "EMLINK" || error.code === "EINVAL")
    ) {
      throw new PiSdkTrustMutationError("TRUST_STORE_UNSAFE");
    }
    throw new PiSdkTrustMutationError("TRUST_WRITE_FAILED");
  }
  try {
    const stat = await fh.stat();
    if (!stat.isFile()) {
      throw new PiSdkTrustMutationError("TRUST_STORE_UNSAFE");
    }
    // nlink must be checked BEFORE any chmod so a hardlink victim's shared
    // inode permissions are never mutated.
    if (stat.nlink !== 1) {
      throw new PiSdkTrustMutationError("TRUST_STORE_UNSAFE");
    }
    if ((stat.mode & 0o077) !== 0) {
      try {
        await fh.chmod(TRUST_FILE_MODE);
      } catch {
        throw new PiSdkTrustMutationError("TRUST_STORE_UNSAFE");
      }
    }
    const preImage: TrustFilePreImage = { dev: stat.dev, ino: stat.ino };
    if (stat.size > TRUST_MAX_BYTES) {
      throw new PiSdkTrustMutationError("TRUST_WRITE_FAILED");
    }
    const buffer = Buffer.alloc(TRUST_MAX_BYTES + 1);
    const { bytesRead } = await fh.read(buffer, 0, TRUST_MAX_BYTES + 1, 0);
    if (bytesRead > TRUST_MAX_BYTES) {
      // Grew past the bound between stat and read — fail closed.
      throw new PiSdkTrustMutationError("TRUST_WRITE_FAILED");
    }
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return { data: parseTrustJson(text), preImage };
  } catch (error) {
    if (error instanceof PiSdkTrustMutationError) throw error;
    throw new PiSdkTrustMutationError("TRUST_WRITE_FAILED");
  } finally {
    await fh.close().catch(() => {});
  }
}

/** fsync a directory handle so the rename is durable. */
async function fsyncDir(dirPath: string): Promise<void> {
  let fh: FileHandle | undefined;
  try {
    fh = await open(dirPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    await fh.sync();
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * Acquire the SAME proper-lockfile cross-process lock the SDK/CLI use, with
 * retry semantics at least as strong as the SDK's own lockSync wrapper
 * (up to 10 attempts, 20ms apart, retrying only while the lock is held).
 * The release function releases the lock (and the SDK/CLI observe the same
 * lockfile directory, so they serialize with us exactly as with each other).
 */
async function acquireTrustLock(trustPath: string): Promise<() => Promise<void>> {
  const trustDir = dirname(trustPath);
  for (let attempt = 1; attempt <= TRUST_LOCK_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await lockfile.lock(trustDir, {
        realpath: false,
        lockfilePath: `${trustPath}.lock`,
      });
    } catch (error) {
      const code = isErrnoException(error) ? error.code : undefined;
      if (code !== "ELOCKED" || attempt === TRUST_LOCK_MAX_ATTEMPTS) {
        throw new PiSdkTrustMutationError("TRUST_WRITE_FAILED");
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, TRUST_LOCK_RETRY_MS));
    }
  }
  throw new PiSdkTrustMutationError("TRUST_WRITE_FAILED");
}

/**
 * Crash-atomic same-directory replace of trust.json:
 *
 *   1. agent dir must be a real (non-symlink) directory;
 *   2. temp file in the SAME dir, O_EXCL|O_NOFOLLOW 0600 → write all → fsync →
 *      fstat identity (regular/nlink1/owner-only);
 *   3. BEFORE the rename, re-verify the directory identity and the original
 *      target identity/absence (swap/hardlink/symlink fail closed);
 *   4. atomic rename → directory fsync;
 *   5. AFTER the rename, post-verify trust.json IS the temp inode
 *      (regular/nlink1/owner-only/dev+ino match);
 *   6. the temp file is cleaned up on every failure.
 *
 * Failure before the rename leaves the old bytes immutable; a rename-then-
 * directory-fsync failure throws TRUST_WRITE_UNVERIFIED (never a false
 * success) while the published file is valid and readable.
 */
async function atomicReplaceTrustFile(
  agentDir: string,
  trustPath: string,
  serialized: string,
  preImage: TrustFilePreImage | undefined,
  faultInjection: PiSdkTrustFaultInjection | undefined,
): Promise<void> {
  const dirStat = await lstat(agentDir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new PiSdkTrustMutationError("TRUST_STORE_UNSAFE");
  }
  const tempPath = join(
    agentDir,
    `.trust-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
  );
  let tempFh: FileHandle | undefined;
  try {
    tempFh = await open(
      tempPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      TRUST_FILE_MODE,
    );
    await tempFh.chmod(TRUST_FILE_MODE);
    await tempFh.writeFile(serialized, "utf8");
    await tempFh.sync();
    const tempStat = await tempFh.stat();
    if (!tempStat.isFile() || tempStat.nlink !== 1 || (tempStat.mode & 0o077) !== 0) {
      throw new PiSdkTrustMutationError("TRUST_WRITE_UNVERIFIED");
    }

    // Crash window #1: fail AFTER the temp is durable, BEFORE the rename — the
    // old trust.json bytes must remain immutable.
    if (faultInjection?.failAfterTempWrite === true) {
      throw new PiSdkTrustMutationError("TRUST_WRITE_UNVERIFIED");
    }

    // Test seam: let a probe substitute the target or the agent dir right
    // before the re-verification so swap/hardlink/symlink/dir-identity
    // substitutions are asserted to fail closed.
    await faultInjection?.beforeReverify?.(trustPath, agentDir);

    // Re-verify the directory and the original target identity/absence before
    // the atomic rename: a same-UID swap/hardlink/symlink substitution fails
    // closed here and never reaches the rename.
    const dirNow = await lstat(agentDir);
    if (
      !dirNow.isDirectory() ||
      dirNow.isSymbolicLink() ||
      dirNow.dev !== dirStat.dev ||
      dirNow.ino !== dirStat.ino
    ) {
      throw new PiSdkTrustMutationError("TRUST_STORE_UNSAFE");
    }
    if (preImage === undefined) {
      let present = true;
      try {
        await lstat(trustPath);
      } catch (error) {
        if (isErrnoException(error) && error.code === "ENOENT") present = false;
        else throw new PiSdkTrustMutationError("TRUST_STORE_UNSAFE");
      }
      if (present) {
        // The target appeared during our write window — fail closed.
        throw new PiSdkTrustMutationError("TRUST_STORE_UNSAFE");
      }
    } else {
      const target = await lstat(trustPath);
      if (
        !target.isFile() ||
        target.isSymbolicLink() ||
        target.nlink !== 1 ||
        target.dev !== preImage.dev ||
        target.ino !== preImage.ino ||
        (target.mode & 0o077) !== 0
      ) {
        throw new PiSdkTrustMutationError("TRUST_STORE_UNSAFE");
      }
    }

    // Atomic rename: readers never observe a partial/corrupt file.
    await rename(tempPath, trustPath);

    // Crash window #2: fail AFTER the rename, BEFORE the directory fsync — the
    // published file is valid and readable, but durability is unverified so the
    // mutation must NOT report success.
    if (faultInjection?.failAfterRename === true) {
      throw new PiSdkTrustMutationError("TRUST_WRITE_UNVERIFIED");
    }
    try {
      await fsyncDir(agentDir);
    } catch {
      throw new PiSdkTrustMutationError("TRUST_WRITE_UNVERIFIED");
    }

    // Post-verify: trust.json must BE the temp inode (regular, nlink 1,
    // owner-only, dev/ino identical) — a post-rename swap fails closed.
    let final: Awaited<ReturnType<typeof lstat>>;
    try {
      final = await lstat(trustPath);
    } catch {
      throw new PiSdkTrustMutationError("TRUST_WRITE_UNVERIFIED");
    }
    if (
      !final.isFile() ||
      final.isSymbolicLink() ||
      final.nlink !== 1 ||
      (final.mode & 0o077) !== 0 ||
      final.dev !== tempStat.dev ||
      final.ino !== tempStat.ino
    ) {
      throw new PiSdkTrustMutationError("TRUST_WRITE_UNVERIFIED");
    }
  } catch (error) {
    if (error instanceof PiSdkTrustMutationError) throw error;
    throw new PiSdkTrustMutationError("TRUST_WRITE_FAILED");
  } finally {
    await tempFh?.close().catch(() => {});
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

// Per-agent-dir in-process mutation serialization. Serializes OUR async RMW
// around the shared proper-lockfile lock so concurrent in-process mutations
// never exhaust the cross-process lock retries; the proper-lockfile lock (the
// exact one the SDK/CLI use) additionally serializes against OTHER processes.
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
 * Create the SDK-backed trust mutation store (set trusted only). The write is
 * a self-contained ATOMIC writer over the agent-dir trust.json — the exact
 * file the SDK read surface and the pi CLI read — under the SAME proper-lockfile
 * cross-process lock the SDK/CLI use. Production never calls the SDK's set();
 * the real SDK store is only used (a) for the fresh read-after-write
 * verification and (b) as a narrow test seam when a projectTrustStore is
 * injected WITHOUT an agentDir (unknown path). The serialization, path-safety,
 * permission-hardening, atomicity and verification passes are described at the
 * top of this module. No raw SDK message/path/content/stack ever escapes:
 * every failure is a fixed-code {@link PiSdkTrustMutationError}.
 */
export function createPiSdkTrustMutationStore(
  options: PiSdkTrustMutationStoreOptions = {},
): PiSdkTrustMutationStore {
  const agentDir = options.agentDir ?? getAgentDir();
  // Same trust.json path computation as the SDK constructor (resolve + join).
  const trustPath = join(resolve(agentDir), "trust.json");
  // Non-hardened seam: an injected store without an explicit agentDir means the
  // trust path is unknown, so the REAL SDK public set() is the only writer we
  // can use. Production always passes agentDir (atomic path).
  const nonHardened = options.agentDir === undefined && options.projectTrustStore !== undefined;

  return {
    async setProjectTrusted(cwd: string): Promise<ProjectTrustStatus> {
      assertTrustMutationCwd(cwd);
      if (nonHardened) {
        const store = options.projectTrustStore as ProjectTrustStore;
        return withTrustMutationLock(trustPath, async () => {
          try {
            store.set(cwd, true);
          } catch {
            throw new PiSdkTrustMutationError("TRUST_WRITE_FAILED");
          }
          return { cwd, level: "trusted", source: "saved" };
        });
      }
      const canonicalCwd = await canonicalizeCwd(cwd);
      return withTrustMutationLock(trustPath, async () => {
        await runAtomicSetTrusted(agentDir, trustPath, canonicalCwd, options.faultInjection);
        // Read-after-write verification OUTSIDE the proper-lockfile lock (a
        // fresh public ProjectTrustStore acquires its own lock): the SAME store
        // the read catalogs use must read the just-saved decision back, which
        // also proves the persisted key matches the SDK canonicalization.
        let saved: boolean | null;
        try {
          saved = (options.projectTrustStore ?? new ProjectTrustStore(agentDir)).get(cwd);
        } catch {
          throw new PiSdkTrustMutationError("TRUST_WRITE_UNVERIFIED");
        }
        if (saved !== true) {
          throw new PiSdkTrustMutationError("TRUST_WRITE_UNVERIFIED");
        }
        return { cwd, level: "trusted", source: "saved" };
      });
    },
  };
}

/** Locked atomic set-trusted: mkdir agent dir → proper-lockfile → strict
 * bounded RMW → temp+fsync+rename+dir-fsync → post-verify. */
async function runAtomicSetTrusted(
  agentDir: string,
  trustPath: string,
  canonicalCwd: string,
  faultInjection: PiSdkTrustFaultInjection | undefined,
): Promise<void> {
  // Ensure the agent dir exists (0700 when created, matching the SDK's
  // acquireTrustLockSync mkdir ordering) BEFORE the lock file is placed.
  try {
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
  } catch {
    throw new PiSdkTrustMutationError("TRUST_WRITE_FAILED");
  }
  const release = await acquireTrustLock(trustPath);
  try {
    const { data, preImage } = await readTrustFileStrict(trustPath);
    data[canonicalCwd] = true;
    const serialized = serializeTrustData(data);
    await atomicReplaceTrustFile(agentDir, trustPath, serialized, preImage, faultInjection);
  } finally {
    // Releasing the proper-lockfile lease is best-effort at this boundary.
    // A same-UID actor can replace the lock directory while the mutation is in
    // flight, causing release() to reject with a raw fs error that contains the
    // full lock path. Never let that raw error escape or override the primary
    // fixed-code mutation failure. On an otherwise successful publish, the
    // fresh SDK read-back below acquires the same lock and therefore converts a
    // genuinely retained/broken lock into TRUST_WRITE_UNVERIFIED rather than a
    // false success.
    await release().catch(() => {});
  }
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
