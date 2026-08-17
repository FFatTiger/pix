import type { Hono } from "hono";
import type { HostEnv } from "../env.js";
import {
  CATALOG_CAPABILITIES,
  EMPTY_HOST_CAPABILITIES,
  HOST_PROTOCOL_VERSION,
  READONLY_HOST_CAPABILITIES,
  type CapabilityResolver,
  type CatalogDeps,
  type GateDeps,
  type GateStatusKind,
  type HostCapability,
  type HostDeps,
  type HostMode,
  type ResolvedCapabilities,
} from "../types.js";

export type { SessiondState, ResolvedCapabilities, CapabilityResolver } from "../types.js";

/**
 * Catalog capability tokens for the seams that are actually mounted. Only the
 * negotiated catalog tokens are advertised here; trust reads have no
 * independent capability token (the GET route still mounts when the seam
 * exists). `themes` mounts with the themes seam and is sessiond-independent, so
 * it stays advertised in the degraded projection too. `project.trust` is the
 * trust-mutation token: advertised ONLY when the trust-mutation seam is really
 * mounted (production wires the real Pi-SDK-backed mutation port) — the same
 * source of truth as the POST /v1/trust route mount. Like every catalog token
 * it is discovery, never authorization.
 */
export function catalogCapabilitiesFromDeps(
  catalogs: CatalogDeps | undefined,
): readonly HostCapability[] {
  if (!catalogs) return EMPTY_HOST_CAPABILITIES;
  const tokens: HostCapability[] = [];
  if (catalogs.models) tokens.push("models");
  if (catalogs.credentials) tokens.push("auth.providers");
  if (catalogs.resources) {
    // skills + plugins share the resources seam; both tokens advertise together.
    tokens.push("skills", "plugins");
  }
  if (catalogs.themes) tokens.push("themes");
  if (hasTrustMutationSeam(catalogs)) tokens.push("project.trust");
  // Defensive: only emit known catalog tokens (order matches CATALOG_CAPABILITIES).
  return CATALOG_CAPABILITIES.filter((token) => tokens.includes(token));
}

/**
 * The trust-mutation surface is mounted only when BOTH the mutation seam and
 * the trust read seam exist (the route needs the read seam for its strict
 * post-write state projection). Single source of truth for the route mount
 * and the `project.trust` capability token, so the two can never disagree.
 */
export function hasTrustMutationSeam(catalogs: CatalogDeps): boolean {
  return catalogs.trust !== undefined && catalogs.trustMutation !== undefined;
}

/**
 * Honest capability default derived from mounted services only. Never invents
 * agent/files/sessions just because a probe is present — those require explicit
 * composition wiring (or an explicit capabilities override).
 *
 * - resources mounted → files (read-only)
 * - catalog seams mounted → their catalog tokens (independent of sessiond)
 * - nothing mounted → empty (M1 boot)
 */
export function defaultMountedCapabilities(
  deps: HostDeps,
): readonly HostCapability[] {
  const tokens: HostCapability[] = [];
  if (deps.resources) tokens.push(...READONLY_HOST_CAPABILITIES);
  tokens.push(...catalogCapabilitiesFromDeps(deps.catalogs));
  return tokens;
}

/**
 * Honest read-only default: read-only file browsing is only available when
 * the resource services (files/git/cwd) are actually mounted, plus any catalog
 * tokens for mounted catalog seams. With nothing wired (the M1 boot
 * composition) the host advertises no capabilities.
 */
export function defaultReadonlyCapabilities(
  deps: HostDeps,
): readonly HostCapability[] {
  return defaultMountedCapabilities(deps);
}

/**
 * Capability projection: when sessiond is unavailable (or no probe is wired
 * yet) the host offers read-only / mounted capabilities only, and only the ones
 * backed by a mounted service. Catalog tokens are independent of sessiond and
 * remain advertised while their seams are mounted. The probe is deliberately
 * protocol-independent — H0B wires the real sessiond client here.
 *
 * Generic default is honest: without an explicit `capabilities` override the
 * host never advertises agent/files/sessions just because sessiond is up. Pass
 * explicit full/readonly sets from production composition.
 */
/**
 * Normalize an explicit capability list so catalog tokens always match mounted
 * seams: strip every catalog token, then append the ones for seams that are
 * actually present (canonical CATALOG_CAPABILITIES order). Non-catalog tokens
 * keep their original relative order. Unmounted seams cannot be advertised;
 * mounted seams cannot be omitted by a stale override.
 */
export function normalizeCatalogCapabilities(
  listed: readonly HostCapability[],
  catalogs: CatalogDeps | undefined,
): readonly HostCapability[] {
  const catalogSet = new Set<string>(CATALOG_CAPABILITIES);
  const nonCatalog = listed.filter((token) => !catalogSet.has(token));
  return [...nonCatalog, ...catalogCapabilitiesFromDeps(catalogs)];
}

/**
 * Honest session-mutation token filter (D4 rename + delete). A `session.write`
 * token is only advertisable when the `sessions.rename` seam is actually
 * mounted, and a `session.delete` token only when the `sessions.delete` seam is
 * mounted — the SAME source of truth as the PATCH/DELETE route mounts in
 * {@link registerSessionRoutes}. Tokens are only ever removed (never added): a
 * token absent from the input list is never invented, and impossible tokens
 * (seam not mounted ⇒ route not mounted) are dropped. The read-only `sessions`
 * token and every other capability are untouched. The seam object is typed to
 * require both `client` and `mutationGuard`, so a truthy seam means the route
 * is actually mountable.
 */
export function normalizeSessionMutationCapabilities(
  listed: readonly HostCapability[],
  deps: HostDeps,
): readonly HostCapability[] {
  const hasRename = deps.sessions?.rename !== undefined;
  const hasDelete = deps.sessions?.delete !== undefined;
  return listed.filter((token) => {
    if (token === "session.write") return hasRename;
    if (token === "session.delete") return hasDelete;
    return true;
  });
}

/**
 * Strip both session-mutation tokens from a list. Applied to the readonly/
 * degraded projection: `session.write` / `session.delete` are only advertisable
 * while sessiond is up, so the down/unknown projection never includes them
 * regardless of mounted seams.
 */
function withoutSessionMutationTokens(
  listed: readonly HostCapability[],
): readonly HostCapability[] {
  return listed.filter(
    (token) => token !== "session.write" && token !== "session.delete",
  );
}

export async function resolveCapabilities(
  deps: HostDeps,
): Promise<ResolvedCapabilities> {
  const mounted = defaultMountedCapabilities(deps);
  // Explicit overrides still have catalog tokens rewritten from mounted seams.
  // Session mutation tokens are seam-honest: only the mutation tokens whose
  // seams are actually mounted survive in the full projection.
  const full = normalizeSessionMutationCapabilities(
    normalizeCatalogCapabilities(
      deps.capabilities?.full ?? mounted,
      deps.catalogs,
    ),
    deps,
  );
  // The readonly projection is only ever returned while sessiond is down (or
  // unknown), so both session-mutation tokens are always stripped there.
  const readonly = withoutSessionMutationTokens(
    normalizeCatalogCapabilities(
      deps.capabilities?.readonly ?? mounted,
      deps.catalogs,
    ),
  );
  if (!deps.sessiond) return { sessiond: "unknown", capabilities: readonly };
  const timeoutMs = deps.sessiondProbeTimeoutMs ?? 2_000;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let available: boolean;
  try {
    available = await Promise.race([
      Promise.resolve(deps.sessiond.isAvailable()),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } catch {
    available = false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  return {
    sessiond: available ? "up" : "down",
    capabilities: available ? full : readonly,
  };
}

/**
 * Build the single seam-normalized capability authority for a composition.
 * The returned resolver runs the exact {@link resolveCapabilities} projection
 * (catalog + session-mutation seam normalization, sessiond probe) against the
 * same `deps` object that mounts the routes, so HTTP health/capabilities/
 * bootstrap and the WS runtime handshake consume identical output. Never
 * throws: probe failures degrade honestly to read-only capabilities.
 */
export function createCapabilityResolver(deps: HostDeps): CapabilityResolver {
  return {
    async resolve(): Promise<ResolvedCapabilities> {
      return resolveCapabilities(deps);
    },
  };
}

export function registerHealthRoutes(app: Hono<HostEnv>, deps: HostDeps): void {
  app.get("/v1/health", async (c) => {
    c.header("Cache-Control", "no-store");
    const { sessiond, capabilities } = deps.capabilityResolver
      ? await deps.capabilityResolver.resolve()
      : await resolveCapabilities(deps);
    return c.json({ ok: true, service: "pix-host", sessiond, capabilities });
  });

  app.get("/v1/capabilities", async (c) => {
    c.header("Cache-Control", "no-store");
    const { sessiond, capabilities } = deps.capabilityResolver
      ? await deps.capabilityResolver.resolve()
      : await resolveCapabilities(deps);
    return c.json({ ok: true, sessiond, capabilities });
  });
}

// ---------------------------------------------------------------------------
// /v1/bootstrap
// ---------------------------------------------------------------------------

/** Gate configuration projection included in the bootstrap payload. */
export interface BootstrapGateStatus {
  /** True when a gate credential is required to use this host. */
  required: boolean;
  status: GateStatusKind;
}

/**
 * Gate status projection for bootstrap. This is config-level (whether a
 * credential is required), not per-request authentication state — the client
 * still calls /v1/gate/status for the authenticated flag.
 */
export function resolveBootstrapGateStatus(
  deps: HostDeps,
  gate?: GateDeps,
): BootstrapGateStatus {
  const config = gate?.config.read() ?? {
    status: "unconfigured" as GateStatusKind,
    source: "bootstrap-default",
  };
  const mode: HostMode = deps.exposureMode ?? "local";
  const requireForLan = gate?.requireForLan ?? true;
  const required = config.status === "enabled" || (mode === "lan" && requireForLan);
  return { required, status: config.status };
}

/**
 * Single boot-time endpoint. Aggregates the service identity, wire protocol
 * version, sessiond availability, the honest capability projection and the
 * gate configuration so the client can render a correct shell without a demo
 * fallback and without probing endpoints that are not implemented (M1 has no
 * /v1/sessions). Always served with Cache-Control: no-store.
 */
export function registerBootstrapRoutes(
  app: Hono<HostEnv>,
  deps: HostDeps,
  gate?: GateDeps,
): void {
  app.get("/v1/bootstrap", async (c) => {
    c.header("Cache-Control", "no-store");
    const { sessiond, capabilities } = deps.capabilityResolver
      ? await deps.capabilityResolver.resolve()
      : await resolveCapabilities(deps);
    return c.json({
      ok: true,
      service: "pix-host",
      protocolVersion: HOST_PROTOCOL_VERSION,
      sessiond,
      capabilities,
      mode: deps.exposureMode ?? "local",
      gate: resolveBootstrapGateStatus(deps, gate),
    });
  });
}
