/**
 * D3A-1 production resource composition.
 *
 * Assembles the production {@link ResourceDeps} from the single `PIX_ALLOWED_ROOTS`
 * configuration and a fixed sessiond endpoint+secret, and provides the shared
 * capability resolver + worktree safety adapter that the CLI Host boot wires
 * into BOTH the HTTP projection (health/capabilities/bootstrap) and the
 * per-connection WS handshake so the four surfaces never disagree.
 *
 * Frozen policy:
 *   - `PIX_ALLOWED_ROOTS` is the only roots configuration. unset ⇒ only cwd;
 *     set ⇒ path.delimiter-separated, every segment a non-empty absolute path
 *     (no trim, no ~ expansion, no relative resolve). Any violation ⇒ a single
 *     safe error the CLI prints before listen and exits 1.
 *   - Canonicalization, dedupe and identity pinning are delegated to the existing
 *     {@link createAllowedRootService}. Local expansion enabled, LAN disabled.
 *   - The sessiond secret is captured exactly once at Host startup and bound to
 *     the resolver, the HTTP probe and the worktree adapter. A secret rotation
 *     while the Host keeps running surfaces as an authentication failure ⇒
 *     degraded capabilities (never silently re-read).
 *
 * This module is the ONE composition place that consumes the sessiond client; it
 * stays free of Pi SDK / runtime-core / the sessiond main entry.
 */
import { delimiter, isAbsolute } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { SessiondRpcClient } from "@fffattiger/pix-sessiond/client";
import { PROTOCOL_VERSION } from "@fffattiger/pix-protocol";
import {
  assertPrivilegedProcessAllowed,
  PrivilegedProcessError,
} from "@fffattiger/pix-local-authority/state";
import { HttpError } from "../errors.js";
import {
  attachTrustedRootsLedger,
  createAllowedRootService,
  rehydrateTrustedCreatedRoots,
} from "../resources/allowed-roots.js";
import { createProcessRunner, runChecked } from "../resources/process-runner.js";
import type { MutationGuard, ResourceDeps, ResourceLimits, WorktreeBusyPreflight } from "../resources/types.js";
import {
  createTrustedRootsLedgerFromLease,
  mapLeaseCode as mapTrustedLeaseCode,
  parseTrustedRootsDocument,
  resolvePixHostDir,
  TrustedRootsLedgerError,
  type TrustedRootsLedger,
} from "../resources/trusted-roots-ledger.js";
import {
  createManagedWorktreesLedgerFromLease,
  mapLeaseCode as mapManagedLeaseCode,
  parseManagedWorktreesDocument,
  ManagedWorktreesLedgerError,
  type ManagedWorktreesLedger,
} from "../resources/managed-worktrees-ledger.js";
import {
  createManagedWorktreesService,
  rehydrateManagedWorktrees,
  type ManagedWorktreesDeps,
  type ManagedWorktreesService,
} from "../resources/managed-worktrees.js";
import {
  openHostStateDirectoryLease,
  TRUSTED_ROOTS_STATE_DOCUMENT,
  MANAGED_WORKTREES_STATE_DOCUMENT,
  HostStateDirectoryError,
  type HostStateDirectoryLease,
} from "../resources/host-state-directory.js";
import type { HostCapability, HostLogger } from "../types.js";

/** Fixed ping / RPC timeout for the resolver and the worktree safety adapter. */
export const PRODUCTION_PING_TIMEOUT_MS = 2_000;

/**
 * Single source of truth for the production upload ceiling. Bound to BOTH the
 * ResourceDeps per-file upload limit and the WS handshake `maxUpload` so the two
 * projections can never drift apart.
 */
export const PRODUCTION_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Frozen production resource limits. */
export const PRODUCTION_RESOURCE_LIMITS: Readonly<ResourceLimits> = Object.freeze({
  maxUploadFileBytes: PRODUCTION_MAX_UPLOAD_BYTES,
  maxUploadTotalBytes: 100 * 1024 * 1024,
  maxTextPreviewBytes: 256 * 1024,
  maxBinaryPreviewBytes: 10 * 1024 * 1024,
  maxIndexFiles: 4_096,
  maxIndexDepth: 16,
  maxWatchers: 32,
  processTimeoutMs: 30_000,
  processOutputBytes: 8 * 1024 * 1024,
});

/**
 * Production bound for each Host state sidecar (claims / managed records).
 * Both ledger adapters share this ceiling over the one lease.
 */
export const PRODUCTION_LEDGER_MAX = 128;

/**
 * Resource + catalog capabilities offered while sessiond is unavailable
 * (degraded). Resource services (files/git/worktree list) remain structurally
 * wired; individual writes are still runtime-guarded (503) — these tokens
 * describe the mounted service surface, not per-request write availability.
 * Catalog tokens (D3B-R1B) are independent of sessiond and stay advertised.
 *
 * `worktree` is the read-only list capability (GET /v1/worktrees). It does not
 * depend on sessiond, so it stays advertised in degraded. `worktree.write` is
 * the honest product capability for worktree create/remove (POST/DELETE
 * /v1/worktrees): those mutations are sessiond-guarded (mutation guard + busy
 * preflight) and require the managed-worktrees ledger, so the write token is
 * advertised ONLY while sessiond is up and excluded from degraded. The token is
 * discovery, never authorization — the route still fail-closes on every
 * authority/ownership check.
 *
 * `themes` (D3B-R6) is the read-only theme catalog token: theme reads (global
 * agent-dir themes + built-ins, plus trusted project themes) never depend on
 * sessiond, so the token stays advertised in degraded too — the degraded host
 * honestly still serves /v1/themes.
 *
 * `project.trust` (D3B trust-mutation slice) is the trust-mutation token: the
 * persisted trust decision is written by the Host catalog itself (real
 * Pi-SDK-backed mutation port over the agent-dir trust.json) and never depends
 * on the per-session Worker, so it is advertised in BOTH states. The token is
 * discovery, never authorization — POST /v1/trust still fail-closes on
 * gate/auth/AllowedRoot checks and its own store authority per request.
 */
export const RESOURCE_DEGRADED_CAPABILITIES: readonly HostCapability[] = [
  "files",
  "files.write",
  "files.watch",
  "files.upload",
  "git",
  "worktree",
  "models",
  "auth.providers",
  "skills",
  "plugins",
  "themes",
  "project.trust",
];

/**
 * Full capabilities when sessiond is up: agent first, then the read-only
 * sessions history surface, then the resource surface (including read-only
 * `worktree` list), then the four catalog tokens (D3B-R1B; independent of
 * sessiond). Order is frozen.
 * `sessions` (read-only history) requires the sessiond-backed catalog and is
 * advertised ONLY while the authority is up — D1A-2 phase 2.
 * `session.delete` is the D4 session-history delete capability: full/sessiond-up
 * only, excluded from degraded — the DELETE route is sessiond-guarded (mutation
 * guard + the sessiond `sessions.delete` authority rejects live sessions) and
 * is mounted only with the mutation seam. The token is discovery, never
 * authorization: the route still fail-closes on every guard/authority check.
 * `session.write` is the D4 session-rename capability: full/sessiond-up only,
 * excluded from degraded — the PATCH route is sessiond-guarded (mutation guard
 * + the sessiond `sessions.rename` authority) and is mounted only with the
 * rename seam. Live rename is supported by sessiond (never a busy failure). The
 * token is discovery, never authorization.
 * `worktree` is the read-only list token (D3A Worktrees UI); GET does not
 * depend on sessiond so the token is also present in degraded. `worktree.write`
 * is the honest product write capability for create/remove: full/sessiond-up
 * only (the mutations are sessiond-guarded and managed-ledger-backed), excluded
 * from degraded. The token is discovery, never authorization.
 * `themes` is the read-only theme catalog token (D3B-R6), present in BOTH
 * states (theme reads never depend on sessiond). `project.trust` is the
 * trust-mutation token (D3B trust-mutation slice), also present in BOTH
 * states: the write is a Host catalog capability over the agent-dir trust.json
 * and never consults sessiond; the route fail-closes on its own authority.
 */
export const PRODUCTION_FULL_CAPABILITIES: readonly HostCapability[] = [
  "agent",
  "sessions",
  "session.delete",
  "session.write",
  "files",
  "files.write",
  "files.watch",
  "files.upload",
  "git",
  "worktree",
  "worktree.write",
  "models",
  "auth.providers",
  "skills",
  "plugins",
  "themes",
  "project.trust",
];

/** Single safe error class for any roots configuration/canonicalization failure. */
export class InvalidAllowedRootsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAllowedRootsError";
  }
}

/**
 * Parse `PIX_ALLOWED_ROOTS` into raw validated segments.
 *
 * - undefined (unset) ⇒ a single root: `cwd`.
 * - otherwise ⇒ path.delimiter-separated; every segment must be a non-empty
 *   absolute path with no NUL byte. No trimming, no `~` expansion, no relative
 *   resolution. An empty raw value, an empty segment, a NUL byte or a
 *   non-absolute segment raises {@link InvalidAllowedRootsError}.
 *
 * Filesystem canonicalization (missing / file / symlink / canonical failure) is
 * delegated to {@link createAllowedRootService} via {@link createProductionResources}.
 */
export function parseAllowedRootsEnv(raw: string | undefined, cwd: string): string[] {
  if (raw === undefined) return [cwd];
  const segments = raw.split(delimiter);
  for (const segment of segments) {
    if (segment === "") {
      throw new InvalidAllowedRootsError(
        raw === "" ? "PIX_ALLOWED_ROOTS is empty" : "PIX_ALLOWED_ROOTS contains an empty segment",
      );
    }
    if (segment.includes("\0")) {
      throw new InvalidAllowedRootsError("PIX_ALLOWED_ROOTS contains a NUL byte");
    }
    if (!isAbsolute(segment)) {
      throw new InvalidAllowedRootsError(
        `PIX_ALLOWED_ROOTS segment is not an absolute path: ${JSON.stringify(segment)}`,
      );
    }
  }
  return segments;
}

/** Map a createAllowedRootService failure into a single sanitized reason. */
function sanitizeRootError(error: unknown): string {
  if (error instanceof HttpError) {
    return `PIX_ALLOWED_ROOTS root rejected (${error.code}): ${error.message}`;
  }
  return `PIX_ALLOWED_ROOTS root rejected: ${error instanceof Error ? error.message : String(error)}`;
}

/** Single safe error for Host data directory / ledger open failures. */
export class InvalidHostDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidHostDirError";
  }
}

function sanitizeHostDirError(error: unknown): string {
  // Ledger-specific failures (both sidecars) keep their own fixed code.
  if (error instanceof TrustedRootsLedgerError || error instanceof ManagedWorktreesLedgerError) {
    return `PIX_HOST_DIR rejected (${error.code})`;
  }
  // Shared lease lock/host-dir failures map to the trusted facade codes (the
  // E2E single-Host contract uses LEDGER_LOCK_BUSY / LEDGER_LOCK_STALE).
  if (error instanceof HostStateDirectoryError) {
    return `PIX_HOST_DIR rejected (${mapTrustedLeaseCode(error.code)})`;
  }
  // Unknown errors must never echo raw message/path (permission, ENOENT, etc.).
  return "PIX_HOST_DIR rejected (HOST_DIR_UNSAFE)";
}

/**
 * Parse porcelain `git worktree list` for rehydrate corroboration.
 * Only non-prunable, real non-symlink directories are returned. Paths are
 * realpath-canonicalized. Never invents authorization.
 */
async function listWorktreesForRehydrate(
  runner: ReturnType<typeof createProcessRunner>,
  repoRoot: string,
  maxOutputBytes: number,
): Promise<readonly { path: string; isMain: boolean }[]> {
  let out: string;
  try {
    out = await runChecked(runner, {
      command: "git",
      args: ["-C", repoRoot, "worktree", "list", "--porcelain", "-z"],
      maxOutputBytes,
    });
  } catch {
    return [];
  }
  const result: { path: string; isMain: boolean }[] = [];
  let current: { path?: string; prunable?: boolean } = {};
  const flush = () => {
    if (current.path && !current.prunable) {
      result.push({ path: current.path, isMain: result.length === 0 });
    }
    current = {};
  };
  for (const record of out.split("\0").filter(Boolean)) {
    for (const line of record.split("\n")) {
      if (line.startsWith("worktree ")) {
        flush();
        current.path = line.slice(9);
      } else if (line.startsWith("prunable")) {
        current.prunable = true;
      }
    }
  }
  flush();
  const existing: { path: string; isMain: boolean }[] = [];
  for (const item of result) {
    try {
      const info = await lstat(item.path);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        existing.push({ path: await realpath(item.path), isMain: item.isMain });
      }
    } catch {
      /* stale */
    }
  }
  return existing;
}

/**
 * Production capability SOURCE. Holds the fixed sessiond secret captured at
 * Host startup, so a secret rotation (daemon restarted with a new secret) while
 * the Host keeps running is detected as an authentication failure ⇒ degraded.
 *
 * This is the RAW source (ping + the frozen full/degraded lists), NOT the
 * client-facing authority. Production composition must consume it ONLY through
 * the seam-normalized {@link CapabilityResolver} (built by
 * `createCapabilityResolver` from the same deps), which is what BOTH the HTTP
 * projection (health/capabilities/bootstrap) and the per-WS handshake consume
 * — so no raw production capability list can bypass mounted-seam normalization.
 */
export interface ProductionCapabilityResolver {
  /** Fixed-secret ping result. Never throws. Drives the HTTP SessiondProbe. */
  isAvailable(): Promise<boolean>;
  /**
   * Raw capabilities for this surface: full when up, degraded when down. Never
   * throws. This is the un-normalized source list; client-facing surfaces must
   * consume it via the seam-normalized {@link CapabilityResolver} instead.
   */
  resolve(): Promise<readonly HostCapability[]>;
}

export interface ProductionCapabilityResolverOptions {
  endpoint: string;
  secret: string;
  logger?: HostLogger;
}

/**
 * Build the shared production capability resolver. The ping uses a fixed 2s
 * timeout and the captured secret; a failure (auth, timeout, unreachable)
 * resolves to degraded without throwing. {@link resolve} additionally defends in
 * depth: any unexpected throw still yields degraded with a single sanitized
 * warning (no endpoint/secret in the message).
 */
export function createProductionCapabilityResolver(
  options: ProductionCapabilityResolverOptions,
): ProductionCapabilityResolver {
  const client = new SessiondRpcClient({
    endpoint: options.endpoint,
    secret: options.secret,
    timeoutMs: PRODUCTION_PING_TIMEOUT_MS,
  });
  const logger = options.logger ?? {};
  // Raw ping: resolves to the daemon's pong flag, and REJECTS on any RPC error
  // (auth, timeout, unreachable). Callers decide how to degrade: {@link isAvailable}
  // swallows the error (HTTP probe stays boolean, never throws); {@link resolve}
  // catches it to advertise degraded capabilities AND emit a single sanitized log.
  async function ping(): Promise<boolean> {
    const result = await client.call("system.ping", {});
    return result.pong === true;
  }
  // Protocol v2 stale-daemon safety: an authenticated `system.hello` returns the
  // daemon's negotiated protocol version. A v1 (or any mismatched) daemon is
  // INCOMPATIBLE — the Host must NOT silently reuse it. This projects degraded
  // capabilities (retracting `agent`/`sessions`/`worktree.write`) so the HTTP
  // and WS surfaces both fail closed against the wrong daemon. The raw version
  // is never logged/echoed; only a fixed sanitized warning is emitted.
  async function compatible(): Promise<boolean> {
    const result = await client.call("system.hello", {});
    return result.protocolVersion === PROTOCOL_VERSION;
  }
  return {
    async isAvailable(): Promise<boolean> {
      try {
        return await ping();
      } catch {
        return false;
      }
    },
    async resolve(): Promise<readonly HostCapability[]> {
      try {
        if (!(await ping())) return [...RESOURCE_DEGRADED_CAPABILITIES];
        if (!(await compatible())) {
          logger.warn?.("sessiond is running an incompatible protocol version; advertising degraded capabilities");
          return [...RESOURCE_DEGRADED_CAPABILITIES];
        }
        return [...PRODUCTION_FULL_CAPABILITIES];
      } catch {
        logger.warn?.("production capability resolver failed; advertising degraded capabilities");
        return [...RESOURCE_DEGRADED_CAPABILITIES];
      }
    },
  };
}

/**
 * Sessiond-backed worktree safety adapter. Implements BOTH the busy preflight
 * (`runtime.hasBusyCwd`) and the mutation availability guard (`system.ping`)
 * against a fixed sessiond endpoint+secret captured at Host startup. Every error
 * maps to a fixed 503 with a sanitized message — session IDs, the endpoint path
 * and the secret are never surfaced to the caller.
 */
export class SessiondWorktreeSafetyAdapter implements WorktreeBusyPreflight, MutationGuard {
  private readonly client: SessiondRpcClient;

  constructor(options: { endpoint: string; secret: string }) {
    this.client = new SessiondRpcClient({
      endpoint: options.endpoint,
      secret: options.secret,
      timeoutMs: PRODUCTION_PING_TIMEOUT_MS,
    });
  }

  /** Mutation availability: a fixed-secret `system.ping`. Throws 503 on failure. */
  async assertAvailable(): Promise<void> {
    try {
      const result = await this.client.call("system.ping", {});
      if (result.pong !== true) {
        throw new HttpError(503, "MUTATION_UNAVAILABLE", "Runtime authority unavailable");
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, "MUTATION_UNAVAILABLE", "Runtime authority unavailable");
    }
  }

  /**
   * Busy preflight: `runtime.hasBusyCwd`. Returns a sanitized busy/reason; the
   * underlying sessionIds are never forwarded. A ping/RPC failure throws 503 so
   * removal fails closed while the authority is down.
   */
  async check(path: string): Promise<{ busy: boolean; reason?: string }> {
    try {
      const result = await this.client.call("runtime.hasBusyCwd", { cwd: path });
      return result.busy
        ? { busy: true, reason: "Worktree has an active Agent session" }
        : { busy: false };
    } catch {
      throw new HttpError(503, "BUSY_PREFLIGHT_UNAVAILABLE", "Cannot determine worktree busy state");
    }
  }
}

export interface ProductionResourcesOptions {
  /** Raw `PIX_ALLOWED_ROOTS` value (undefined when unset). */
  allowedRootsEnv: string | undefined;
  /** Process cwd; the sole root when the env is unset. */
  cwd: string;
  /** Fixed sessiond RPC endpoint. */
  endpoint: string;
  /** Fixed sessiond secret (captured once at Host startup). */
  secret: string;
  /**
   * Raw `PIX_HOST_DIR` (undefined when unset). Absolute path only; default
   * `~/.pi/pix/host`. Host-owned durable trusted-roots ledger lives here and
   * an exclusive lifetime Host-dir lock is held from open until `close()`.
   */
  hostDirEnv?: string | undefined;
  logger?: HostLogger;
  /** Explicit root override. Production also accepts `PIX_ALLOW_ROOT=1`. */
  allowRoot?: boolean | "1";
  /** Injectable uid for deterministic root-policy tests. */
  processUid?: number;
}

export interface ProductionResources {
  deps: ResourceDeps;
  resolver: ProductionCapabilityResolver;
  adapter: SessiondWorktreeSafetyAdapter;
  /**
   * Host-owned durable trusted-roots ledger over the SHARED host-state lease.
   * `close()` releases the exclusive lifetime Host-dir lock exactly once (the
   * lease owner). Consumed by the Host runner on graceful shutdown / startup
   * failure. Narrow facade; raw ledger internals are not part of the public
   * package surface.
   */
  trustedRootsLedger: TrustedRootsLedger;
  /**
   * Host-owned durable managed-worktrees ledger over the SAME shared lease as
   * the trusted ledger (one lock, one mutation mutex — never a second lock).
   * `close()` is a no-op: the lease owner (trustedRootsLedger) releases it.
   * Missing sidecar stays absent until the first managed record is written.
   */
  managedWorktreesLedger: ManagedWorktreesLedger;
  /** Managed-worktree domain service (ownership evidence + memory authorization). */
  managedWorktrees: ManagedWorktreesService;
}

/**
 * Assemble production {@link ResourceDeps} from `PIX_ALLOWED_ROOTS` and a fixed
 * sessiond endpoint+secret.
 *
 * Roots are canonicalized, deduped and identity-pinned by the existing
 * {@link createAllowedRootService} (local expansion enabled, LAN disabled). The
 * first configured segment's canonical path becomes the default cwd. The
 * returned adapter is wired as BOTH the busy preflight and the mutation guard.
 *
 * Raises {@link InvalidAllowedRootsError} (one sanitized reason) for any parse or
 * canonicalization failure; the CLI prints a single line and exits 1 before
 * listen, leaving any running sessiond untouched.
 */
export class RootPrivilegeDeniedError extends Error {
  readonly code = "PRIVILEGED_PROCESS";
  constructor(message: string) {
    super(message);
    this.name = "RootPrivilegeDeniedError";
  }
}

export async function createProductionResources(
  options: ProductionResourcesOptions,
): Promise<ProductionResources> {
  try {
    const uid = options.processUid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
    const allowRoot = options.allowRoot ?? process.env.PIX_ALLOW_ROOT;
    assertPrivilegedProcessAllowed({
      ...(uid !== undefined ? { uid } : {}),
      ...(allowRoot !== undefined ? { allowRoot } : {}),
    });
  } catch (error) {
    if (error instanceof PrivilegedProcessError) {
      throw new RootPrivilegeDeniedError(error.message);
    }
    throw error;
  }
  const segments = parseAllowedRootsEnv(options.allowedRootsEnv, options.cwd);
  let allowedRoots;
  try {
    allowedRoots = await createAllowedRootService({
      roots: segments,
      allowLocalExpansion: true,
      allowLanExpansion: false,
    });
  } catch (error) {
    throw new InvalidAllowedRootsError(sanitizeRootError(error));
  }
  // defaultCwd = canonical path of the first configured segment (frozen order).
  // The service already canonicalized+validated every segment as a real
  // directory, so this realpath cannot fail absent a TOCTOU race.
  const firstSegment = segments[0];
  if (firstSegment === undefined) {
    throw new InvalidAllowedRootsError("PIX_ALLOWED_ROOTS produced no segments");
  }
  let defaultCwd: string;
  try {
    defaultCwd = await realpath(firstSegment);
  } catch {
    throw new InvalidAllowedRootsError(
      `PIX_ALLOWED_ROOTS first segment cannot be canonicalized: ${JSON.stringify(firstSegment)}`,
    );
  }
  // Host data dir + BOTH durable sidecars over ONE shared lease (D3A-P0 + D3A
  // managed-worktrees). Bad PIX_HOST_DIR, a held/stale Host-dir lock, or a
  // corrupt/unsafe trusted OR managed ledger fails BEFORE listen with a single
  // sanitized reason (never rewriting/truncating evidence; corrupt managed
  // sidecar stays immutable). The shared exclusive lifetime lock is held until
  // the returned trustedRootsLedger is closed on graceful shutdown / startup
  // failure. Both ledger adapters share that one lease, one in-process mutation
  // mutex, and one installation context — there is NO second lock.
  let trustedRootsLedger: TrustedRootsLedger;
  let managedWorktreesLedger: ManagedWorktreesLedger;
  let lease: HostStateDirectoryLease;
  try {
    const hostDir = resolvePixHostDir(options.hostDirEnv);
    lease = await openHostStateDirectoryLease({
      hostDir,
      validateBeforeLock: async ({ readDocument }) => {
        // Validate BOTH sidecars before the lifetime lock is created, so a
        // corrupt/unsafe document fails startup with no lock file and immutable
        // evidence. Missing sidecars stay absent (empty) until first write.
        try {
          const trustedResult = await readDocument(TRUSTED_ROOTS_STATE_DOCUMENT);
          if (!("missing" in trustedResult)) {
            const parsed = parseTrustedRootsDocument(trustedResult.content, PRODUCTION_LEDGER_MAX);
            if (parsed.warning) {
              throw new TrustedRootsLedgerError(parsed.warning, "Trusted-roots ledger failed validation");
            }
          }
        } catch (error) {
          if (error instanceof TrustedRootsLedgerError) throw error;
          if (error instanceof HostStateDirectoryError) {
            throw new TrustedRootsLedgerError(mapTrustedLeaseCode(error.code), "Trusted-roots ledger failed validation");
          }
          throw new TrustedRootsLedgerError("LEDGER_CORRUPT", "Trusted-roots ledger failed validation");
        }
        try {
          const managedResult = await readDocument(MANAGED_WORKTREES_STATE_DOCUMENT);
          if (!("missing" in managedResult)) {
            const parsed = parseManagedWorktreesDocument(managedResult.content, PRODUCTION_LEDGER_MAX);
            if (parsed.warning) {
              throw new ManagedWorktreesLedgerError(parsed.warning, "Managed-worktrees ledger failed validation");
            }
          }
        } catch (error) {
          if (error instanceof ManagedWorktreesLedgerError) throw error;
          if (error instanceof HostStateDirectoryError) {
            throw new ManagedWorktreesLedgerError(mapManagedLeaseCode(error.code), "Managed-worktrees ledger failed validation");
          }
          throw new ManagedWorktreesLedgerError("MANAGED_CORRUPT", "Managed-worktrees ledger failed validation");
        }
      },
    });
    trustedRootsLedger = createTrustedRootsLedgerFromLease(lease, { maxClaims: PRODUCTION_LEDGER_MAX });
    managedWorktreesLedger = createManagedWorktreesLedgerFromLease(lease, { maxRecords: PRODUCTION_LEDGER_MAX });
  } catch (error) {
    throw new InvalidHostDirError(sanitizeHostDirError(error));
  }
  attachTrustedRootsLedger(allowedRoots, trustedRootsLedger, options.logger);
  const processRunner = createProcessRunner();
  const managedDeps: ManagedWorktreesDeps = {
    ledger: managedWorktreesLedger,
    allowedRoots,
    runner: processRunner,
    maxOutputBytes: PRODUCTION_RESOURCE_LIMITS.processOutputBytes ?? 8 * 1024 * 1024,
  };
  const managedWorktrees = createManagedWorktreesService(managedDeps);
  try {
    const maxOutput = PRODUCTION_RESOURCE_LIMITS.processOutputBytes ?? 8 * 1024 * 1024;
    const ledgerSnapshot = await trustedRootsLedger.read();
    await rehydrateTrustedCreatedRoots(allowedRoots, ledgerSnapshot.claims, {
      listWorktrees: (repoRoot) => listWorktreesForRehydrate(processRunner, repoRoot, maxOutput),
    });
    // Rehydrate managed ownership INDEPENDENTLY: live managed records publish
    // memory authorization; legacy trusted v1 claims stay authorization-only and
    // are never migrated/adopted into managed ownership.
    await rehydrateManagedWorktrees(managedDeps, {
      isRepoManaged: (repoRoot) => allowedRoots.isAuthorized(repoRoot, "directory"),
    });
  } catch (error) {
    // Release the shared lifetime lock so a failed startup does not leave a stale lock.
    await trustedRootsLedger.close().catch(() => {});
    throw new InvalidHostDirError(sanitizeHostDirError(error));
  }

  const adapter = new SessiondWorktreeSafetyAdapter({ endpoint: options.endpoint, secret: options.secret });
  const resolver = createProductionCapabilityResolver({
    endpoint: options.endpoint,
    secret: options.secret,
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const deps: ResourceDeps = {
    allowedRoots,
    processRunner,
    busyPreflight: adapter,
    mutationGuard: adapter,
    managedWorktrees,
    limits: { ...PRODUCTION_RESOURCE_LIMITS },
    defaultCwd,
  };
  return { deps, resolver, adapter, trustedRootsLedger, managedWorktreesLedger, managedWorktrees };
}
