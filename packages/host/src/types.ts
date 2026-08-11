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
export type HostCapability = "agent" | "files" | "files.write" | "git" | "worktree";

export const ALL_HOST_CAPABILITIES: readonly HostCapability[] = [
  "agent",
  "files",
  "files.write",
  "git",
  "worktree",
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

import type { ResourceDeps } from "./resources/types.js";

/** sessiond availability probe for capability downgrade (protocol-independent). */
export interface SessiondProbe {
  isAvailable(): boolean | Promise<boolean>;
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
}

export interface RuntimeWsSeam {
  /**
   * Called once with the hello frame after auth. When the host has no seam
   * injected, the socket is closed with 1002 ("runtime protocol not wired").
   */
  attach(session: WsSession, hello: string): void | Promise<void>;
}
