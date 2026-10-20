import { randomBytes as nodeRandomBytes } from "node:crypto";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import type { Context, Hono } from "hono";
import type { HostEnv } from "../env.js";
import { effectiveRequestProtocol } from "../middleware/security.js";
import type { GateDeps, HostLogger } from "../types.js";
import { sanitizeNextPath } from "./paths.js";
import { isGateRequired } from "./decision.js";
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
 *  - POST /v1/gate/setup  — { password, next? } → writes the first access key
 *                             (only while `unconfigured`) + cookie + { ok, next }
 *  - POST /v1/gate/logout — clears the session cookie
 */
export function registerGateRoutes(app: Hono<HostEnv>, deps: GateDeps, logger: HostLogger): void {
  const cookieName = deps.cookieName ?? DEFAULT_GATE_COOKIE_NAME;
  const sessionTtlMs = deps.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const now = deps.now ?? Date.now;
  const randomBytes = deps.randomBytes ?? nodeRandomBytes;
  const limiter = deps.rateLimiter ?? createInMemoryRateLimiter({ now });
  const revocations = deps.revocations ?? createInMemoryRevocationStore({ now });
  const loginBodyLimitBytes = deps.loginBodyLimitBytes ?? 4 * 1024;

  // First-visit setup is a ONE-SHOT: the first writer wins. Setup requests
  // are serialized so a second (concurrent) request re-reads the config AFTER
  // the first write and is refused instead of overwriting the access key.
  let setupChain: Promise<unknown> = Promise.resolve();
  function runSetupExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = setupChain.then(task, task);
    setupChain = run.then(() => undefined, () => undefined);
    return run;
  }

  function validClaims(c: Context<HostEnv>, password: string) {
    const claims = readSessionToken(getCookie(c, cookieName), password, now());
    if (!claims || revocations.isRevoked(claims.tokenId, now())) return null;
    return claims;
  }

  app.get("/v1/gate/status", (c) => {
    c.header("Cache-Control", "no-store");
    const config = deps.config.read();
    const mode = c.get("hostMode");
    const required = isGateRequired(config);
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
    const key = clientIp(c);
    const nextPath = sanitizeNextPath(typeof next === "string" ? next : undefined);

    if (config.status === "disabled") {
      // The operator turned the gate off: the host is open (local and LAN
      // binds alike), so signing in is a no-op that still returns the target.
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

  /**
   * POST /v1/gate/setup — set the FIRST access key from the web.
   *
   * Only while the gate is `unconfigured` (no key yet): the key is written
   * into the pix.json auth config (atomic write, every other field in the
   * document preserved) and takes effect on the next request — no restart.
   * This browser is signed in right away (the session token is derived from
   * the new key), so the operator never has to type the key twice.
   *
   * One-shot: a key that already exists, an env-managed key (PIX_PASSWORD)
   * or an explicitly disabled gate are refused — the page then asks for a
   * normal sign-in instead.
   */
  app.post(
    "/v1/gate/setup",
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
    if (typeof password !== "string" || password.length === 0 || password.length > 128) {
      return c.json(
        loginFailure("The access key must be a non-empty string of at most 128 characters", {
          code: "INVALID_INPUT",
        }),
        400,
      );
    }
    const nextPath = sanitizeNextPath(typeof next === "string" ? next : undefined);

    return runSetupExclusive(async () => {
      if ((deps.envPasswordManaged ?? (() => process.env.PIX_PASSWORD !== undefined))()) {
        return c.json(
          loginFailure("The access key is managed by the PIX_PASSWORD environment variable and cannot be set here", {
            code: "PASSWORD_ENV_MANAGED",
          }),
          409,
        );
      }
      const config = deps.config.read();
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
      if (config.status === "disabled") {
        return c.json(
          loginFailure("Authentication is disabled in the configuration; remove auth.disabled to use an access key", {
            code: "AUTH_DISABLED",
          }),
          409,
        );
      }
      if (config.status === "enabled") {
        return c.json(
          loginFailure("An access key is already configured", { code: "AUTH_ALREADY_CONFIGURED" }),
          409,
        );
      }
      if (config.status !== "unconfigured") {
        // Defensive exhaustiveness guard for future GateConfig variants.
        return c.json(
          loginFailure("Authentication configuration error", {
            code: "AUTH_CONFIG_ERROR",
            status: "error",
          }),
          503,
        );
      }

      const passwordStore = deps.passwordStore;
      if (!passwordStore) {
        return c.json(loginFailure("Access key storage is unavailable", { code: "PASSWORD_WRITE_FAILED" }), 500);
      }
      try {
        passwordStore.write(password);
      } catch (error) {
        logger.error?.(`Failed to persist the access key: ${error instanceof Error ? error.message : String(error)}`);
        return c.json(loginFailure("Failed to persist the access key", { code: "PASSWORD_WRITE_FAILED" }), 500);
      }

      // The key is live from the next request on (the gate re-reads the
      // config); this browser is signed in immediately.
      const token = createSessionToken(password, {
        now: now(),
        ttlMs: sessionTtlMs,
        randomBytes,
      });
      setCookie(c, cookieName, token, {
        ...cookieBaseOptions(c),
        maxAge: Math.floor(sessionTtlMs / 1000),
      });
      return c.json({ ok: true, next: nextPath });
    });
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

  /**
   * PUT /v1/gate/password — change the pix access key.
   *
   * Behind the gate: once a key is configured a valid session is required,
   * and when a key exists `currentPassword` must match (rate-limited like
   * login). An unconfigured or disabled host fails closed here exactly like
   * every other API — the initial key must still come from pix.json / env.
   * On success the new key is persisted and a fresh session cookie is issued
   * so the current browser stays authenticated — every OTHER session's cookie
   * dies with the old key (the session token is derived from the password).
   */
  app.put(
    "/v1/gate/password",
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
      const { currentPassword, newPassword } = body as { currentPassword?: unknown; newPassword?: unknown };
      if (currentPassword !== undefined && typeof currentPassword !== "string") {
        return c.json(loginFailure("Invalid request body"), 400);
      }
      if (typeof newPassword !== "string" || newPassword.length === 0 || newPassword.length > 128) {
        return c.json(loginFailure("New password must be a non-empty string of at most 128 characters", { code: "INVALID_INPUT" }), 400);
      }

      if ((deps.envPasswordManaged ?? (() => process.env.PIX_PASSWORD !== undefined))()) {
        return c.json(
          loginFailure("The access key is managed by the PIX_PASSWORD environment variable and cannot be changed here", {
            code: "PASSWORD_ENV_MANAGED",
          }),
          409,
        );
      }

      const config = deps.config.read();
      if (config.status === "error") {
        logger.error?.(config.logMessage ?? "Gate configuration error");
        return c.json(loginFailure("Authentication configuration error", { code: "AUTH_CONFIG_ERROR", status: "error" }), 503);
      }
      if (config.status === "disabled") {
        return c.json(
          loginFailure("Authentication is disabled; enable it in pix.json to set an access key", {
            code: "AUTH_DISABLED",
          }),
          409,
        );
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

      if (config.status === "enabled") {
        const key = clientIp(c);
        const retryAfter = limiter.retryAfterSeconds(key);
        if (retryAfter > 0) {
          c.header("Retry-After", String(retryAfter));
          return c.json(
            loginFailure("Too many attempts, please retry later", {
              code: "RATE_LIMITED",
              retryAfterSeconds: retryAfter,
            }),
            429,
          );
        }
        if (typeof currentPassword !== "string" || !passwordsMatch(currentPassword, config.password)) {
          limiter.recordFailure(key);
          return c.json(loginFailure("Incorrect current password", { code: "INVALID_PASSWORD" }), 401);
        }
        limiter.clear(key);
      }

      const passwordStore = deps.passwordStore;
      if (!passwordStore) {
        return c.json(loginFailure("Access key storage is unavailable", { code: "PASSWORD_WRITE_FAILED" }), 500);
      }
      try {
        passwordStore.write(newPassword);
      } catch (error) {
        logger.error?.(`Failed to persist access key: ${error instanceof Error ? error.message : String(error)}`);
        return c.json(loginFailure("Failed to persist the new access key", { code: "PASSWORD_WRITE_FAILED" }), 500);
      }

      // Keep the current browser authenticated under the NEW key.
      const token = createSessionToken(newPassword, {
        now: now(),
        ttlMs: sessionTtlMs,
        randomBytes,
      });
      setCookie(c, cookieName, token, {
        ...cookieBaseOptions(c),
        maxAge: Math.floor(sessionTtlMs / 1000),
      });
      return c.json({ ok: true });
    },
  );
}
