import { apiErrorBody, isV1Path } from "../errors.js";
import type { ApiErrorBody } from "../errors.js";
import type { GateConfig, HostMode } from "../types.js";
import { isGatePublicPath, sanitizeNextPath } from "./paths.js";

export type GateDecision =
  | { action: "allow"; authStatus: "enabled" | "disabled" }
  | { action: "redirect"; location: string }
  | { action: "json"; status: 401 | 403 | 503; body: ApiErrorBody };

export interface GateDecisionInput {
  config: GateConfig;
  mode: HostMode;
  url: string;
  sessionValid: boolean;
  requireForLan: boolean;
}

/**
 * Pure gate decision logic (port of the legacy `decideGateRequest` adapted to
 * the new host surface). Public gate endpoints, health, /login and the exact
 * PWA asset allowlist always pass; APIs without a valid session get JSON
 * errors; page requests get a redirect to /login.
 */
export function decideGateRequest(input: GateDecisionInput): GateDecision {
  const { config, mode, url, sessionValid, requireForLan } = input;
  const parsed = new URL(url);
  const pathname = parsed.pathname;
  const isApi = isV1Path(pathname);
  const isPublic = isGatePublicPath(pathname);
  const onLoginPage = pathname === "/login";
  const lanForced = requireForLan && mode === "lan";

  // A LAN-bound host without a usable credential must fail closed. Public
  // bootstrap assets remain reachable so the UI can explain the state.
  if (lanForced && config.status !== "enabled") {
    if (isPublic) {
      return { action: "allow", authStatus: "enabled" };
    }
    const code =
      config.status === "disabled"
        ? "AUTH_REQUIRED_FOR_LAN"
        : config.status === "unconfigured"
          ? "AUTH_NOT_CONFIGURED"
          : "AUTH_CONFIG_ERROR";
    const message =
      config.status === "disabled"
        ? "Authentication is required for LAN access"
        : config.status === "unconfigured"
          ? "Authentication is not configured"
          : "Authentication configuration error";
    if (isApi) return { action: "json", status: config.status === "disabled" ? 403 : 503, body: apiErrorBody(code, message) };
    return { action: "redirect", location: "/login" };
  }

  // Explicitly disabled only on a trusted local bind: open host.
  if (config.status === "disabled" && !lanForced) {
    return { action: "allow", authStatus: "disabled" };
  }

  // Public gate endpoints + PWA assets + health stay reachable pre-auth.
  // /login is intentionally excluded: it is handled by the session/fallback
  // logic below (authenticated users get redirected away, others see the page).
  if (isPublic && !onLoginPage) {
    return {
      action: "allow",
      authStatus: config.status === "enabled" ? "enabled" : "disabled",
    };
  }

  // Unconfigured / error on a local bind: allow /login/bootstrap, block APIs,
  // and redirect pages without ever claiming a valid authenticated session.
  if (config.status === "unconfigured" || config.status === "error") {
    const code = config.status === "unconfigured" ? "AUTH_NOT_CONFIGURED" : "AUTH_CONFIG_ERROR";
    const message =
      config.status === "unconfigured"
        ? "Authentication is not configured"
        : "Authentication configuration error";
    if (onLoginPage) return { action: "allow", authStatus: "enabled" };
    if (isApi) return { action: "json", status: 503, body: apiErrorBody(code, message) };
    return { action: "redirect", location: "/login" };
  }

  // config.status === "enabled":
  if (sessionValid) {
    if (onLoginPage) {
      return {
        action: "redirect",
        location: sanitizeNextPath(parsed.searchParams.get("next")),
      };
    }
    return { action: "allow", authStatus: "enabled" };
  }
  if (onLoginPage) return { action: "allow", authStatus: "enabled" };
  if (isApi) return { action: "json", status: 401, body: apiErrorBody("UNAUTHORIZED", "Unauthorized") };
  const next = sanitizeNextPath(`${pathname}${parsed.search}`);
  return { action: "redirect", location: `/login?next=${encodeURIComponent(next)}` };
}
