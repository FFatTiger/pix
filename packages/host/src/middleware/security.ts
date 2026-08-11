import { isIP } from "node:net";
import { createMiddleware } from "hono/factory";
import type { MiddlewareHandler } from "hono";
import type { HostEnv } from "../env.js";
import type { HostMode } from "../types.js";
import { apiErrorBody, isV1Path } from "../errors.js";

export interface SecurityOptions {
  /**
   * Extra trusted hostnames (beyond loopback names and IP literals).
   * Defaults to PI_WEB_HOSTNAME + PI_WEB_ALLOWED_HOSTS from the environment.
   */
  allowedHosts?: readonly string[];
  /** Trusted server exposure; LAN mode cannot be downgraded by Host spoofing. */
  exposureMode?: HostMode;
  /** Socket peers allowed to supply Forwarded/X-Forwarded-* headers. */
  trustedProxyAddresses?: readonly string[];
  /** Maximum accepted forwarding hops. */
  trustedProxyMaxHops?: number;
  /** Maximum bytes per forwarding header. */
  trustedProxyMaxHeaderBytes?: number;
}

export interface HostCheckResult {
  trusted: boolean;
  hostname: string | null;
  mode: HostMode;
}

export interface ForwardedRequestInfo {
  clientAddress: string;
  protocol: "http:" | "https:" | null;
  valid: boolean;
}

const DEFAULT_PROXY_MAX_HOPS = 16;
const DEFAULT_PROXY_MAX_HEADER_BYTES = 2 * 1024;

function normalizeIpAddress(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  const unmapped = trimmed.startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
  if (!isIP(unmapped)) return null;
  if (isIP(unmapped) === 4) return unmapped.split(".").map(Number).join(".");
  try {
    return new URL(`http://[${unmapped}]`).hostname.slice(1, -1).toLowerCase();
  } catch {
    return null;
  }
}

function parseHeaderTokens(
  value: string | null,
  maxHops: number,
  maxHeaderBytes: number,
): string[] | null {
  if (value === null || Buffer.byteLength(value, "utf8") > maxHeaderBytes) return null;
  const tokens = value.split(",").map((token) => token.trim());
  if (tokens.length === 0 || tokens.length > maxHops || tokens.some((token) => token.length === 0)) {
    return null;
  }
  return tokens;
}

/**
 * Resolve XFF/XFP from the trusted transport peer, peeling trusted proxy hops
 * from right to left. Invalid or ambiguous chains fail closed to transport.
 */
export function resolveForwardedRequest(
  peerAddress: string,
  xForwardedFor: string | null,
  xForwardedProto: string | null,
  trustedProxyAddresses: readonly string[],
  maxHops = DEFAULT_PROXY_MAX_HOPS,
  maxHeaderBytes = DEFAULT_PROXY_MAX_HEADER_BYTES,
): ForwardedRequestInfo {
  const peer = normalizeIpAddress(peerAddress);
  const trusted = new Set(
    trustedProxyAddresses.map(normalizeIpAddress).filter((ip): ip is string => ip !== null),
  );
  const transport: ForwardedRequestInfo = {
    clientAddress: peer ?? "unknown",
    protocol: null,
    valid: false,
  };
  if (!peer || !trusted.has(peer)) return transport;

  const addresses = parseHeaderTokens(xForwardedFor, maxHops, maxHeaderBytes);
  const protos = parseHeaderTokens(xForwardedProto, maxHops, maxHeaderBytes);
  if (!addresses || !protos || addresses.length !== protos.length) return transport;

  const normalizedAddresses = addresses.map(normalizeIpAddress);
  if (normalizedAddresses.some((ip) => ip === null)) return transport;
  const normalizedProtos = protos.map((value) => value.toLowerCase());
  if (normalizedProtos.some((value) => value !== "http" && value !== "https")) return transport;

  // Every hop to the right of the chosen client must be explicitly trusted.
  // If the immediate address supplied by the transport proxy is untrusted,
  // any values to its left are attacker-controlled and the chain is ambiguous.
  const immediate = normalizedAddresses[normalizedAddresses.length - 1];
  if (!immediate || (!trusted.has(immediate) && normalizedAddresses.length > 1)) {
    if (normalizedAddresses.length !== 1) return transport;
  }
  let index = normalizedAddresses.length - 1;
  while (index >= 0 && trusted.has(normalizedAddresses[index]!)) index -= 1;
  if (index < 0) return transport;
  const protocol = normalizedProtos[index] === "https" ? "https:" : "http:";
  return {
    clientAddress: normalizedAddresses[index]!,
    protocol,
    valid: true,
  };
}

// ---------------------------------------------------------------------------
// Host header parsing / DNS-rebinding protection
// ---------------------------------------------------------------------------

function normalizeHostname(value: string): string {
  const unbracketed =
    value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return unbracketed.toLowerCase().replace(/\.$/, "");
}

/** Extract a clean hostname from a Host authority, or null when malformed. */
export function hostnameFromAuthority(value: string | null | undefined): string | null {
  if (!value || /[\s/@\\]/.test(value)) return null;
  try {
    const parsed = new URL(`http://${value}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return normalizeHostname(parsed.hostname);
  } catch {
    return null;
  }
}

function explicitPortFromAuthority(value: string | null | undefined): string | null {
  if (!value || /[\s/@\\]/.test(value)) return null;
  try {
    const parsed = new URL(`http://${value}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.port || null;
  } catch {
    return null;
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

function isLoopbackAddress(ip: string): boolean {
  if (ip === "::1") return true;
  if (ip.startsWith("::ffff:")) return isLoopbackAddress(ip.slice(7));
  const parts = ip.split(".").map(Number);
  return parts.length === 4 && parts[0] === 127;
}

function configuredHostnamesFromEnvironment(): string[] {
  return [
    process.env.PI_WEB_HOSTNAME,
    ...(process.env.PI_WEB_ALLOWED_HOSTS?.split(",") ?? []),
  ].filter((value): value is string => Boolean(value?.trim()));
}

function normalizeConfiguredHostname(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const actualIp = isIP(trimmed);
  if (actualIp) return normalizeHostname(trimmed);
  if (/^\[[^\]]+\](?::\d+)?$/.test(trimmed) || /^[^:]+:\d+$/.test(trimmed)) {
    return hostnameFromAuthority(trimmed);
  }
  if (/^[^\s/@\\:]+$/.test(trimmed)) {
    return normalizeHostname(trimmed);
  }
  return null;
}

/**
 * Trust only local names, IP literals (which cannot be DNS-rebound), or the
 * hostnames explicitly selected by the operator.
 */
export function isHostTrusted(
  hostHeader: string | null | undefined,
  configuredHostnames: readonly string[] = configuredHostnamesFromEnvironment(),
): boolean {
  const hostname = hostnameFromAuthority(hostHeader);
  if (!hostname) return false;
  if (isLoopbackHostname(hostname) || isIP(hostname)) return true;
  return configuredHostnames.some(
    (configured) => normalizeConfiguredHostname(configured) === hostname,
  );
}

/**
 * A request is "local" only when it arrives via loopback names/addresses.
 * Anything else (private/public IP literals, operator hostnames) is "lan" and
 * therefore subject to the gate (D-020).
 */
export function resolveHostMode(hostname: string): HostMode {
  if (isLoopbackHostname(hostname)) return "local";
  if (isIP(hostname) && isLoopbackAddress(hostname)) return "local";
  return "lan";
}

// ---------------------------------------------------------------------------
// Origin checks for API/WS requests
// ---------------------------------------------------------------------------

function canonicalOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function defaultPortForProtocol(protocol: string): string {
  return protocol === "https:" ? "443" : "80";
}

function requestProtocol(request: Request, forwardedProtocol: "http:" | "https:" | null): string {
  if (forwardedProtocol) return forwardedProtocol;
  try {
    return new URL(request.url).protocol;
  } catch {
    return "http:";
  }
}

/**
 * Match Origin host+port against the Host header, ignoring scheme differences
 * caused by upstream TLS termination. Non-default ports must still agree.
 */
function isOriginMatchingRequestHost(origin: string, hostHeader: string): boolean {
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  if (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") return false;

  const requestHostname = hostnameFromAuthority(hostHeader);
  if (!requestHostname) return false;
  if (normalizeHostname(originUrl.hostname) !== requestHostname) return false;

  const originPort = originUrl.port || defaultPortForProtocol(originUrl.protocol);
  const hostPort = explicitPortFromAuthority(hostHeader);
  if (hostPort !== null) return originPort === hostPort;
  return originPort === "80" || originPort === "443";
}

/** Reject browser cross-site API requests while preserving non-browser clients. */
export function isOriginAllowed(
  request: Request,
  forwardedProtocol: "http:" | "https:" | null = null,
): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;
  if (!origin) return true;

  const requestOrigin = getRequestOrigin(request, forwardedProtocol);
  if (requestOrigin !== null && canonicalOrigin(origin) === requestOrigin) return true;

  const host = request.headers.get("host");
  return host !== null && isOriginMatchingRequestHost(origin, host);
}

function getRequestOrigin(
  request: Request,
  forwardedProtocol: "http:" | "https:" | null,
): string | null {
  const host = request.headers.get("host");
  return host ? canonicalOrigin(`${requestProtocol(request, forwardedProtocol)}//${host}`) : null;
}

/** Effective request scheme using a previously validated forwarding chain. */
export function effectiveRequestProtocol(
  request: Request,
  forwardedProtocol: "http:" | "https:" | null = null,
): string {
  return requestProtocol(request, forwardedProtocol);
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export function securityMiddleware(options: SecurityOptions = {}): MiddlewareHandler<HostEnv> {
  const configuredHosts =
    options.allowedHosts !== undefined ? [...options.allowedHosts] : undefined;
  const exposureMode = options.exposureMode ?? "local";
  const trustedProxyAddresses = options.trustedProxyAddresses ?? [];
  const trustedProxyMaxHops = options.trustedProxyMaxHops ?? DEFAULT_PROXY_MAX_HOPS;
  const trustedProxyMaxHeaderBytes =
    options.trustedProxyMaxHeaderBytes ?? DEFAULT_PROXY_MAX_HEADER_BYTES;
  return createMiddleware(async (c, next) => {
    const hostHeader = c.req.header("host");
    const trusted = isHostTrusted(hostHeader, configuredHosts);
    const hostname = hostnameFromAuthority(hostHeader) ?? "";
    if (!trusted) {
      if (isV1Path(c.req.path)) {
        return c.json(apiErrorBody("UNTRUSTED_HOST", "Untrusted API request"), 403);
      }
      return c.text("Untrusted request", 403);
    }
    const peerAddress = c.env?.incoming?.socket?.remoteAddress ?? "unknown";
    const forwarded = resolveForwardedRequest(
      peerAddress,
      c.req.header("x-forwarded-for") ?? null,
      c.req.header("x-forwarded-proto") ?? null,
      trustedProxyAddresses,
      trustedProxyMaxHops,
      trustedProxyMaxHeaderBytes,
    );
    c.set("hostname", hostname);
    c.set("peerAddress", peerAddress);
    c.set("trustedProxy", forwarded.valid);
    c.set("clientAddress", forwarded.clientAddress);
    c.set("forwardedProtocol", forwarded.protocol);
    // Server exposure is authoritative. Host can only upgrade local → LAN,
    // never downgrade a LAN-bound server by claiming localhost.
    c.set("hostMode", exposureMode === "lan" ? "lan" : resolveHostMode(hostname));
    if (isV1Path(c.req.path) && !isOriginAllowed(c.req.raw, forwarded.protocol)) {
      return c.json(apiErrorBody("UNTRUSTED_ORIGIN", "Untrusted API request"), 403);
    }
    await next();
  });
}
