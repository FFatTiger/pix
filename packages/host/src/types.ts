/**
 * Shared types for the pix Hono host foundation.
 *
 * This package is protocol-independent by design: it owns gate, request
 * security, static client hosting and the WebSocket upgrade seam. Runtime
 * protocol wiring (H0B) and resource services (H1x) inject their own ports
 * through {@link HostDeps}; nothing here imports Pi SDK, sessiond or protocol
 * packages.
 */

export type HostMode = "local" | "lan";

export interface TrustedProxyOptions {
  /** Socket peer addresses allowed to supply forwarding headers. Empty by default. */
  addresses: readonly string[];
  /** Maximum X-Forwarded-For hop count (default 16). */
  maxHops?: number;
  /** Maximum bytes accepted for each forwarding header (default 2 KiB). */
  maxHeaderBytes?: number;
}

/** Capability tokens negotiated with the client (mirrors client shell tokens). */
export type HostCapability =
  | "agent"
  | "sessions"
  | "session.delete"
  | "files"
  | "files.write"
  | "files.watch"
  | "files.upload"
  | "git"
  | "worktree"
  | "worktree.write"
  | "models"
  | "auth.providers"
  | "skills"
  | "plugins";

export const ALL_HOST_CAPABILITIES: readonly HostCapability[] = [
  "agent",
  "sessions",
  "session.delete",
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
] as const;

/**
 * Catalog capability tokens (D3B-R1B). Advertised only when the corresponding
 * catalog seam is actually mounted. Independent of sessiond.
 */
export const CATALOG_CAPABILITIES: readonly HostCapability[] = [
  "models",
  "auth.providers",
  "skills",
  "plugins",
] as const;

/** Capabilities that remain usable when sessiond is unavailable (read-only). */
export const READONLY_HOST_CAPABILITIES: readonly HostCapability[] = ["files"] as const;

/**
 * Honest empty default: when neither sessiond nor resource services (files,
 * git, worktree) are wired, the host advertises no capabilities at all. The
 * M1 boot composition wires nothing, so its capability is empty.
 */
export const EMPTY_HOST_CAPABILITIES: readonly HostCapability[] = [] as const;

/** Wire protocol version the host speaks (mirrors the client's PROTOCOL_VERSION). */
export const HOST_PROTOCOL_VERSION = 1;

export interface HostLogger {
  info?(message: string, fields?: Record<string, unknown>): void;
  warn?(message: string, fields?: Record<string, unknown>): void;
  error?(message: string, fields?: Record<string, unknown>): void;
  debug?(message: string, fields?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export type GateStatusKind = "enabled" | "disabled" | "unconfigured" | "error";

interface GateConfigBase {
  /** Human-readable origin of the config (env / file path). */
  source: string;
}

export type GateConfig =
  | (GateConfigBase & {
      status: "enabled";
      /** Exact non-empty password. Whitespace is significant and preserved. */
      password: string;
      logMessage?: never;
    })
  | (GateConfigBase & {
      status: "disabled" | "unconfigured";
      password?: never;
      logMessage?: never;
    })
  | (GateConfigBase & {
      status: "error";
      password?: never;
      logMessage?: string;
    });

export interface GateConfigSource {
  read(): GateConfig;
}

/**
 * Login rate limiting seam. The host ships an in-memory exponential backoff
 * implementation; tests (or a multi-instance deployment) can inject another.
 */
export interface LoginRateLimiter {
  /** Seconds the caller must wait before retrying; 0 means allowed. */
  retryAfterSeconds(key: string): number;
  /** Record a failure; returns the delay (seconds) imposed by this failure. */
  recordFailure(key: string): number;
  clear(key: string): void;
}

/** Bounded, injectable revocation state. The default implementation is process-local. */
export interface SessionRevocationStore {
  isRevoked(tokenId: string, now: number): boolean;
  revoke(tokenId: string, expiresAt: number): void;
}

export interface GateDeps {
  /** Credential source; defaults to env + ~/.pi/pix.json when omitted. */
  config: GateConfigSource;
  /** Session cookie name (default "pix_session"). */
  cookieName?: string;
  /** Session lifetime in ms (default 30 days). */
  sessionTtlMs?: number;
  /**
   * LAN requests are always gated, even when auth is explicitly disabled
   * (architecture decision D-020). Default true.
   */
  requireForLan?: boolean;
  /** Login rate limiter; defaults to bounded in-memory exponential backoff. */
  rateLimiter?: LoginRateLimiter;
  /** Session token revocation store; defaults to a bounded process-local store. */
  revocations?: SessionRevocationStore;
  /** Maximum accepted login JSON body size (default 4 KiB). */
  loginBodyLimitBytes?: number;
  /** Testable clock (default Date.now). */
  now?: () => number;
  /** Testable RNG for token nonces (default crypto.randomBytes). */
  randomBytes?: (size: number) => Uint8Array;
}

// ---------------------------------------------------------------------------
// Host deps
// ---------------------------------------------------------------------------

import type { MutationGuard, ResourceDeps } from "./resources/types.js";
import type { AllowedRootService } from "./resources/allowed-roots.js";

/** sessiond availability probe for capability downgrade (protocol-independent). */
export interface SessiondProbe {
  isAvailable(): boolean | Promise<boolean>;
}

/**
 * Read-only session history port (D1A-2 phase 2). A narrow, protocol-independent
 * seam: composition wires the real sessiond RPC client (which already schema-
 * validates results) and tests inject a fake. Methods return `unknown` so this
 * foundation module stays free of protocol DTO imports; the route narrows.
 */
export interface SessionHistoryReadClient {
  list(params: { cwd?: string; limit?: number; offset?: number }): Promise<unknown>;
  read(sessionId: string): Promise<unknown>;
  context(sessionId: string, leafId?: string): Promise<unknown>;
}

/**
 * D4 session-history delete port. A narrow, protocol-independent mutation seam:
 * composition wires the real sessiond `sessions.delete` RPC and tests inject a
 * fake. Returns `unknown` so this foundation module stays free of protocol DTO
 * imports. Like the read client, this is deliberately NOT the runtime lifecycle
 * (no activate/command/stop) — delete is sessiond-guarded (live ⇒ session_busy).
 */
export interface SessionDeleteClient {
  delete(sessionId: string): Promise<unknown>;
}

/**
 * D4 session-delete mutation seam. The production route is mounted ONLY when
 * both the delete client AND a mutation guard (sessiond `system.ping`) are
 * present; the `session.delete` capability is advertised only then (and only
 * while sessiond is up). A generic composition that wires no delete seam gets
 * no DELETE route and no capability token — no unsafe write is ever mounted.
 */
export interface SessionDeleteSeam {
  client: SessionDeleteClient;
  /** sessiond availability guard (production: `system.ping`). Fails closed 503. */
  mutationGuard: MutationGuard;
}

// ---------------------------------------------------------------------------
// Catalog seams (D3B-R1B) — protocol-independent, return unknown
// ---------------------------------------------------------------------------

/**
 * Project-cwd-aware models catalog. Composition creates one per canonical cwd;
 * foundation routes never import runtime-core/adapter types — results are
 * `unknown` and narrowed at the route boundary.
 */
export interface CatalogModelsSeam {
  forCwd(cwd: string): {
    listModels(): Promise<unknown>;
    getDefaultModel(): Promise<unknown>;
  };
}

/** Global credentials/provider catalog (not project-scoped). */
export interface CatalogCredentialsSeam {
  listProviders(): Promise<unknown>;
  getProviderStatus(providerId: string): Promise<unknown>;
  isConfigured(providerId: string): Promise<boolean>;
}

/**
 * Project-cwd-aware resource catalog (skills/plugins/commands). Composition
 * creates one per canonical cwd after consulting trust; foundation routes pass
 * the trust-gated `trusted` flag so the resource seam never re-reads a stale
 * trust cache itself.
 */
export interface CatalogResourcesSeam {
  forCwd(
    cwd: string,
    trusted: boolean,
  ): {
    listSkills(): Promise<unknown>;
    listPlugins(): Promise<unknown>;
    listCommands(): Promise<unknown>;
  };
}

/** Project-cwd-aware trust query. */
export interface CatalogTrustSeam {
  getProjectTrustState(cwd: string): Promise<unknown>;
  isTrusted(cwd: string): Promise<boolean>;
  canReloadResources(cwd: string): Promise<unknown>;
}

/**
 * Read-only catalog deps (D3B-R1B). Protocol-independent: every catalog method
 * returns `unknown`. Production composition reuses the same
 * {@link AllowedRootService} as resources so project routes share one roots
 * policy. Sub-seams are independent — omit any seam to leave its routes and
 * capability tokens unmounted. No mutation/OAuth/install/reload/trust-set.
 */
export interface CatalogDeps {
  /**
   * Allowed roots for project-scoped routes. Production MUST pass the same
   * service as `resources.allowedRoots`.
   */
  roots: AllowedRootService;
  models?: CatalogModelsSeam;
  credentials?: CatalogCredentialsSeam;
  resources?: CatalogResourcesSeam;
  trust?: CatalogTrustSeam;
}

export interface HostCapabilityDeps {
  /** Capabilities offered while sessiond is available (default all). */
  full?: readonly HostCapability[];
  /**
   * Capabilities offered while sessiond is unavailable. Defaults to
   * ["files"] only when resource services (deps.resources) are wired, and to
   * an empty set otherwise — the host never advertises a capability it has
   * not mounted (architecture rule 14).
   */
  readonly?: readonly HostCapability[];
}

export interface HostDeps {
  gate?: GateDeps;
  sessiond?: SessiondProbe;
  capabilities?: HostCapabilityDeps;
  /**
   * Trusted exposure mode. This is derived from bind configuration by
   * createNodeServer and must never be inferred from the Host header.
   */
  exposureMode?: HostMode;
  /** Forwarding headers are honored only when the socket peer is in this list. */
  trustedProxy?: TrustedProxyOptions;
  /** sessiond availability probe timeout (default 2_000 ms). */
  sessiondProbeTimeoutMs?: number;
  /**
   * Absolute path to the Vite client build output. When omitted the host
   * serves no static content (API-only).
   */
  clientDist?: string;
  /**
   * Extra trusted Host header values (DNS-rebinding allowlist). Defaults to
   * PIX_HOSTNAME + PIX_ALLOWED_HOSTS from the environment.
   */
  allowedHosts?: readonly string[];
  logger?: HostLogger;
  /** H1B local files/git/cwd/worktree services. Omitted means routes are unavailable. */
  resources?: ResourceDeps;
  /**
   * D1A-2 phase 2: read-only session history routes (/v1/sessions*). Omitted
   * means the routes are unavailable. The client is the sessiond-backed catalog;
   * a sessiond outage surfaces as 503 on these routes and retracts the
   * `sessions` capability token (driven by the capability resolver, not here).
   *
   * D4: when `sessions.delete` is present, DELETE /v1/sessions/:id is mounted
   * (production mutation guard first) and the `session.delete` capability is
   * advertised only while sessiond is up. Omitted ⇒ no DELETE route, no token.
   */
  sessions?: { client: SessionHistoryReadClient; delete?: SessionDeleteSeam };
  /**
   * D3B-R1B: read-only catalog routes (models/auth/skills/plugins/commands/trust).
   * Omitted means the catalog routes are unavailable. Each sub-seam is optional;
   * routes and capability tokens are registered only for the seams that are
   * actually mounted.
   */
  catalogs?: CatalogDeps;
  /** H0B seam: injected runtime protocol WS handler. */
  runtimeWs?: RuntimeWsSeam;
  /** Hello-frame timeout in ms for the WS upgrade seam (default 10_000). */
  helloTimeoutMs?: number;
  /** Maximum WebSocket message payload enforced by ws (default 1 MiB). */
  wsMaxPayloadBytes?: number;
  /** Maximum initial hello-frame bytes (default 64 KiB). */
  wsHelloMaxBytes?: number;
}

// ---------------------------------------------------------------------------
// WebSocket seam (H0B)
// ---------------------------------------------------------------------------

/**
 * Minimal session handle handed to the runtime protocol seam after a
 * successful upgrade + auth + hello. Deliberately protocol-independent:
 * H0B wires the real pix Runtime Protocol on top of this.
 */
export interface WsSession {
  readonly url: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** Register a listener for subsequent (non-hello) frames; returns unsubscribe. */
  onMessage(listener: (data: string) => void): () => void;
  /**
   * Register a listener fired exactly once when the underlying socket closes
   * (remote close, local close, or error). Registering after close fires it
   * immediately. Returns an unsubscribe function.
   */
  onClose(listener: () => void): () => void;
  /** Bytes buffered on the raw socket (for bounded-sender backpressure checks). */
  readonly bufferedAmount: number;
}

export interface RuntimeWsSeam {
  /**
   * Called once with the hello frame after auth. When the host has no seam
   * injected, the socket is closed with 1002 ("runtime protocol not wired").
   */
  attach(session: WsSession, hello: string): void | Promise<void>;
}
