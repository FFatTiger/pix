import type { Hono } from "hono";
import type { HostEnv } from "../env.js";
import {
  ALL_HOST_CAPABILITIES,
  EMPTY_HOST_CAPABILITIES,
  HOST_PROTOCOL_VERSION,
  READONLY_HOST_CAPABILITIES,
  type GateDeps,
  type GateStatusKind,
  type HostCapability,
  type HostDeps,
  type HostMode,
} from "../types.js";

export type SessiondState = "up" | "down" | "unknown";

export interface ResolvedCapabilities {
  sessiond: SessiondState;
  capabilities: readonly HostCapability[];
}

/**
 * Honest read-only default: read-only file browsing is only available when
 * the resource services (files/git/cwd) are actually mounted. With nothing
 * wired (the M1 boot composition) the host advertises no capabilities.
 */
export function defaultReadonlyCapabilities(
  deps: HostDeps,
): readonly HostCapability[] {
  return deps.resources ? READONLY_HOST_CAPABILITIES : EMPTY_HOST_CAPABILITIES;
}

/**
 * Capability projection: when sessiond is unavailable (or no probe is wired
 * yet) the host offers read-only capabilities only, and only the ones backed
 * by a mounted service. The probe is deliberately protocol-independent —
 * H0B wires the real sessiond client here.
 */
export async function resolveCapabilities(
  deps: HostDeps,
): Promise<ResolvedCapabilities> {
  const full = deps.capabilities?.full ?? ALL_HOST_CAPABILITIES;
  const readonly = deps.capabilities?.readonly ?? defaultReadonlyCapabilities(deps);
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

export function registerHealthRoutes(app: Hono<HostEnv>, deps: HostDeps): void {
  app.get("/v1/health", async (c) => {
    c.header("Cache-Control", "no-store");
    const { sessiond, capabilities } = await resolveCapabilities(deps);
    return c.json({ ok: true, service: "pi-web-host", sessiond, capabilities });
  });

  app.get("/v1/capabilities", async (c) => {
    c.header("Cache-Control", "no-store");
    const { sessiond, capabilities } = await resolveCapabilities(deps);
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
    const { sessiond, capabilities } = await resolveCapabilities(deps);
    return c.json({
      ok: true,
      service: "pi-web-host",
      protocolVersion: HOST_PROTOCOL_VERSION,
      sessiond,
      capabilities,
      mode: deps.exposureMode ?? "local",
      gate: resolveBootstrapGateStatus(deps, gate),
    });
  });
}
