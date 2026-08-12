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
import { realpath } from "node:fs/promises";
import { SessiondRpcClient } from "@fffattiger/pix-sessiond/client";
import { HttpError } from "../errors.js";
import { createAllowedRootService } from "../resources/allowed-roots.js";
import { createProcessRunner } from "../resources/process-runner.js";
import type { MutationGuard, ResourceDeps, ResourceLimits, WorktreeBusyPreflight } from "../resources/types.js";
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
 * Resource capabilities offered while sessiond is unavailable (degraded). The
 * resource services (files/git) remain structurally wired; individual writes
 * are still runtime-guarded (503) — these tokens describe the mounted service
 * surface, not per-request write availability. worktree is deliberately absent.
 */
export const RESOURCE_DEGRADED_CAPABILITIES: readonly HostCapability[] = [
  "files",
  "files.write",
  "files.watch",
  "files.upload",
  "git",
];

/**
 * Full capabilities when sessiond is up: agent first, then the read-only
 * sessions history surface, then the resource surface. Order is frozen.
 * `sessions` (read-only history) requires the sessiond-backed catalog and is
 * advertised ONLY while the authority is up — D1A-2 phase 2. worktree is NOT
 * advertised (D3A-1): worktree creation works while the authority is up but is
 * not yet a negotiated capability.
 */
export const PRODUCTION_FULL_CAPABILITIES: readonly HostCapability[] = [
  "agent",
  "sessions",
  "files",
  "files.write",
  "files.watch",
  "files.upload",
  "git",
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

/**
 * Production capability resolver. Holds the fixed sessiond secret captured at
 * Host startup, so a secret rotation (daemon restarted with a new secret) while
 * the Host keeps running is detected as an authentication failure ⇒ degraded.
 *
 * The HTTP projection (SessiondProbe → {@link isAvailable}) and the per-WS
 * handshake projection ({@link resolve}) both delegate to this single object,
 * so health/capabilities/bootstrap and the runtime handshake can never disagree.
 */
export interface ProductionCapabilityResolver {
  /** Fixed-secret ping result. Never throws. Drives the HTTP SessiondProbe. */
  isAvailable(): Promise<boolean>;
  /** Capabilities for this surface: full when up, degraded when down. Never throws. */
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
        return (await ping()) ? [...PRODUCTION_FULL_CAPABILITIES] : [...RESOURCE_DEGRADED_CAPABILITIES];
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
  logger?: HostLogger;
}

export interface ProductionResources {
  deps: ResourceDeps;
  resolver: ProductionCapabilityResolver;
  adapter: SessiondWorktreeSafetyAdapter;
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
export async function createProductionResources(
  options: ProductionResourcesOptions,
): Promise<ProductionResources> {
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
  const adapter = new SessiondWorktreeSafetyAdapter({ endpoint: options.endpoint, secret: options.secret });
  const resolver = createProductionCapabilityResolver({
    endpoint: options.endpoint,
    secret: options.secret,
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const deps: ResourceDeps = {
    allowedRoots,
    processRunner: createProcessRunner(),
    busyPreflight: adapter,
    mutationGuard: adapter,
    limits: { ...PRODUCTION_RESOURCE_LIMITS },
    defaultCwd,
  };
  return { deps, resolver, adapter };
}
