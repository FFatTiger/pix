import { apiErrorBody, isV1Path } from "../errors.js";
import type { ApiErrorBody } from "../errors.js";
import type { GateConfig, HostMode } from "../types.js";
import { isGatePublicPath, sanitizeNextPath } from "./paths.js";

export type GateDecision =
  | { action: "allow"; authStatus: "enabled" | "disabled" }
  | { action: "redirect"; location: string }
  | { action: "json"; status: 401 | 403 | 503; body: ApiErrorBody };

/**
 * True when the client must present the gate screen for this configuration.
 *
 * - `enabled`: a key exists, so using the host needs a valid session.
 * - `disabled`: the operator explicitly turned the gate off — the host is
 *   open on every bind, so there is nothing to sign in to.
 * - `unconfigured` / `error`: the host refuses every non-public request, so
 *   the client must show the setup (or error) screen instead of the app.
 *
 * The mode does not enter this decision: the gate blocks exactly the
 * configurations listed above, on a local bind and on a LAN bind alike.
 */
export function isGateRequired(config: Pick<GateConfig, "status">): boolean {
  return config.status !== "disabled";
}

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

  // A LAN-bound host without a usable credential must fail closed. An
  // EXPLICITLY disabled gate is the operator's own choice (auth.disabled in
  // pix.json / PIX_AUTH_DISABLED) and stays open on a LAN bind as well; only
  // `unconfigured` (no access key yet — the web setup flow) and `error` (an
  // unreadable config) fail closed here. Public bootstrap assets remain
  // reachable so the UI can explain the state.
  if (lanForced && config.status !== "enabled" && config.status !== "disabled") {
    if (isPublic) {
      return { action: "allow", authStatus: "enabled" };
    }
    const code =
      config.status === "unconfigured"
        ? "AUTH_NOT_CONFIGURED"
        : "AUTH_CONFIG_ERROR";
    const message =
      config.status === "unconfigured"
        ? "Authentication is not configured"
        : "Authentication configuration error";
    if (isApi) return { action: "json", status: 503, body: apiErrorBody(code, message) };
    return { action: "redirect", location: "/login" };
  }

  // Explicitly disabled: the operator turned the gate off — open host, on a
  // local bind and on a LAN bind alike.
  if (config.status === "disabled") {
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
