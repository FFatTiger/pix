import { randomBytes as nodeRandomBytes } from "node:crypto";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import type { Context, Hono } from "hono";
import type { HostEnv } from "../env.js";
import { effectiveRequestProtocol } from "../middleware/security.js";
import type { GateDeps, HostLogger } from "../types.js";
import { sanitizeNextPath } from "./paths.js";
import { createInMemoryRateLimiter } from "./rate-limit.js";
import { createInMemoryRevocationStore } from "./revocation.js";
import {
  DEFAULT_GATE_COOKIE_NAME,
  DEFAULT_SESSION_TTL_MS,
  createSessionToken,
  passwordsMatch,
  readSessionToken,
} from "./token.js";

export interface GateStatusResponse {
  required: boolean;
  authenticated: boolean;
  mode: "local" | "lan";
  status: "enabled" | "disabled" | "unconfigured" | "error";
}

function clientIp(c: Context<HostEnv>): string {
  return c.get("clientAddress") || c.get("peerAddress") || "unknown";
}

interface LoginFailureBody {
  ok: false;
  error: string;
  message: string;
  code?: string;
  status?: "unconfigured" | "error";
  retryAfterSeconds?: number;
}

function loginFailure(
  message: string,
  extra: Partial<LoginFailureBody> = {},
): LoginFailureBody {
  return { ok: false, error: message, message, ...extra };
}

function cookieBaseOptions(c: Context<HostEnv>) {
  return {
    httpOnly: true,
    sameSite: "Lax" as const,
    secure: effectiveRequestProtocol(c.req.raw, c.get("forwardedProtocol")) === "https:",
    path: "/",
  };
}

/**
 * Gate HTTP surface:
 *  - GET  /v1/gate/status — { required, authenticated, mode }
 *  - POST /v1/gate/login  — { password, next? } → cookie + { ok, next }
 *  - POST /v1/gate/logout — clears the session cookie
 */
export function registerGateRoutes(app: Hono<HostEnv>, deps: GateDeps, logger: HostLogger): void {
  const cookieName = deps.cookieName ?? DEFAULT_GATE_COOKIE_NAME;
  const sessionTtlMs = deps.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const now = deps.now ?? Date.now;
  const randomBytes = deps.randomBytes ?? nodeRandomBytes;
  const requireForLan = deps.requireForLan ?? true;
  const limiter = deps.rateLimiter ?? createInMemoryRateLimiter({ now });
  const revocations = deps.revocations ?? createInMemoryRevocationStore({ now });
  const loginBodyLimitBytes = deps.loginBodyLimitBytes ?? 4 * 1024;

  function validClaims(c: Context<HostEnv>, password: string) {
    const claims = readSessionToken(getCookie(c, cookieName), password, now());
    if (!claims || revocations.isRevoked(claims.tokenId, now())) return null;
    return claims;
  }

  app.get("/v1/gate/status", (c) => {
    c.header("Cache-Control", "no-store");
    const config = deps.config.read();
    const mode = c.get("hostMode");
    const required = config.status === "enabled" || (mode === "lan" && requireForLan);
    const authenticated =
      config.status === "enabled" ? validClaims(c, config.password) !== null : false;
    const body: GateStatusResponse = {
      required,
      authenticated,
      mode,
      status: config.status,
    };
    return c.json(body);
  });

  app.post(
    "/v1/gate/login",
    bodyLimit({
      maxSize: loginBodyLimitBytes,
      onError: (c) => c.json(loginFailure("Request body too large", { code: "BODY_TOO_LARGE" }), 413),
    }),
    async (c) => {
    c.header("Cache-Control", "no-store");
    const contentType = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      return c.json(loginFailure("Content-Type must be application/json", { code: "UNSUPPORTED_MEDIA_TYPE" }), 415);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(loginFailure("Invalid request body"), 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json(loginFailure("Invalid request body"), 400);
    }
    const { password, next } = body as { password?: unknown; next?: unknown };
    if (password !== undefined && typeof password !== "string") {
      return c.json(loginFailure("Invalid request body"), 400);
    }

    const config = deps.config.read();
    const mode = c.get("hostMode");
    const key = clientIp(c);
    const nextPath = sanitizeNextPath(typeof next === "string" ? next : undefined);

    if (config.status === "disabled") {
      if (mode === "lan" && requireForLan) {
        return c.json(
          loginFailure("Authentication is required for LAN access", {
            code: "AUTH_REQUIRED_FOR_LAN",
          }),
          403,
        );
      }
      limiter.clear(key);
      return c.json({ ok: true, next: nextPath });
    }

    if (config.status === "unconfigured") {
      return c.json(
        loginFailure("Authentication is not configured", {
          code: "AUTH_NOT_CONFIGURED",
          status: "unconfigured",
        }),
        503,
      );
    }
    if (config.status === "error") {
      logger.error?.(config.logMessage ?? "Gate configuration error");
      return c.json(
        loginFailure("Authentication configuration error", {
          code: "AUTH_CONFIG_ERROR",
          status: "error",
        }),
        503,
      );
    }

    if (config.status !== "enabled") {
      // Defensive exhaustiveness guard for future GateConfig variants.
      return c.json(
        loginFailure("Authentication configuration error", {
          code: "AUTH_CONFIG_ERROR",
          status: "error",
        }),
        503,
      );
    }
    const enabledConfig = config;
    const retryAfter = limiter.retryAfterSeconds(key);
    if (retryAfter > 0) {
      c.header("Retry-After", String(retryAfter));
      return c.json(
        loginFailure("Too many login attempts, please retry later", {
          code: "RATE_LIMITED",
          retryAfterSeconds: retryAfter,
        }),
        429,
      );
    }

    if (typeof password !== "string" || !passwordsMatch(password, enabledConfig.password)) {
      limiter.recordFailure(key);
      return c.json(loginFailure("Incorrect password"), 401);
    }

    limiter.clear(key);
    const token = createSessionToken(enabledConfig.password, {
      now: now(),
      ttlMs: sessionTtlMs,
      randomBytes,
    });
    setCookie(c, cookieName, token, {
      ...cookieBaseOptions(c),
      maxAge: Math.floor(sessionTtlMs / 1000),
    });
    return c.json({ ok: true, next: nextPath });
    },
  );

  app.post("/v1/gate/logout", (c) => {
    c.header("Cache-Control", "no-store");
    const config = deps.config.read();
    if (config.status === "enabled") {
      const claims = readSessionToken(getCookie(c, cookieName), config.password, now());
      if (claims) revocations.revoke(claims.tokenId, claims.expiresAt);
    }
    deleteCookie(c, cookieName, cookieBaseOptions(c));
    return c.json({ ok: true, revoked: true });
  });
}
