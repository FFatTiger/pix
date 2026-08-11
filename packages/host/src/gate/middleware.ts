import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { MiddlewareHandler } from "hono";
import type { HostEnv } from "../env.js";
import type { GateDeps } from "../types.js";
import { decideGateRequest } from "./decision.js";
import { createInMemoryRevocationStore } from "./revocation.js";
import { DEFAULT_GATE_COOKIE_NAME, readSessionToken } from "./token.js";

/**
 * Gate middleware: applies the public allowlist and blocks unauthenticated
 * requests with JSON errors (APIs) or /login redirects (pages). Runs after
 * the security middleware so Host/Origin protection always wins.
 */
export function gateMiddleware(deps: GateDeps): MiddlewareHandler<HostEnv> {
  const cookieName = deps.cookieName ?? DEFAULT_GATE_COOKIE_NAME;
  const now = deps.now ?? Date.now;
  const requireForLan = deps.requireForLan ?? true;
  const revocations = deps.revocations ?? createInMemoryRevocationStore({ now });

  return createMiddleware(async (c, next) => {
    const config = deps.config.read();
    const claims =
      config.status === "enabled"
        ? readSessionToken(getCookie(c, cookieName), config.password, now())
        : null;
    const sessionValid =
      claims !== null && !revocations.isRevoked(claims.tokenId, now());

    const decision = decideGateRequest({
      config,
      mode: c.get("hostMode"),
      url: c.req.url,
      sessionValid,
      requireForLan,
    });

    if (decision.action === "allow") {
      c.set("authStatus", decision.authStatus);
      return next();
    }
    if (decision.action === "json") {
      return c.json(decision.body, decision.status);
    }
    return c.redirect(decision.location, 302);
  });
}
