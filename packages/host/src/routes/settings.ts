import type { Hono } from "hono";
import type { HostEnv } from "../env.js";
import { HttpError } from "../errors.js";
import { readJsonObject } from "../resources/request-body.js";
import type { SessionSettingsClient } from "../types.js";
import type { MutationGuard } from "../resources/types.js";

/**
 * Session lifecycle settings routes (idle-reclamation timeout).
 *
 * Two endpoints proxy the sessiond-backed settings through a narrow
 * {@link SessionSettingsClient}: GET /v1/settings/session-idle-timeout reads the
 * current timeout, PUT /v1/settings/session-idle-timeout sets and persists it.
 *
 * The PUT runs the production mutation guard (sessiond `system.ping`) FIRST and
 * only then validates the body and issues the narrow settings RPC. The route is
 * deliberately protocol-independent: the narrow settings client (wired in
 * composition) returns the already schema-parsed sessiond result as `unknown`.
 * A sessiond outage surfaces as 503 on both routes and retracts the
 * `session.settings` capability token (driven by the capability resolver).
 */

/** Frozen PUT body ceiling (bounded body max 4 KiB). */
const SETTINGS_BODY_LIMIT = 4 * 1024;

interface SessionSettingsRouteDeps {
  client: SessionSettingsClient;
  /** sessiond availability guard; runs before any body parsing on PUT. */
  mutationGuard: MutationGuard;
}

/**
 * Map a sessiond settings RPC failure onto an honest HTTP error.
 *
 *   invalid_input → 400 INVALID_IDLE_TIMEOUT (fixed)
 *   timeout / unavailable / auth / unknown → 503 SETTINGS_UNAVAILABLE (sanitized)
 *
 * The message is always a fixed, sanitized string: session ids, the endpoint
 * path, the secret and any stack are never forwarded to the caller.
 */
export function mapSessionSettingsError(error: unknown): HttpError {
  if (
    error !== null &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "invalid_input"
  ) {
    return new HttpError(400, "INVALID_IDLE_TIMEOUT", "Idle timeout is invalid");
  }
  return new HttpError(503, "SETTINGS_UNAVAILABLE", "Session settings are unavailable");
}

/**
 * Parse a PUT settings body into the single `idleTimeoutMs` field. The body
 * must be a strict object with EXACTLY ONE own enumerable field named
 * `idleTimeoutMs`, whose value is a non-negative safe integer (0 disables idle
 * reclamation). Unknown fields, coercion and out-of-range values are rejected
 * with a fixed 400 that never echoes the raw body.
 */
function parseIdleTimeoutBody(body: Record<string, unknown>): number {
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "idleTimeoutMs") {
    throw new HttpError(400, "INVALID_IDLE_TIMEOUT", "Idle timeout is invalid");
  }
  const value = body.idleTimeoutMs;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new HttpError(400, "INVALID_IDLE_TIMEOUT", "Idle timeout is invalid");
  }
  return value;
}

/** Narrow an unknown GET result to the strict `{ idleTimeoutMs }` shape. */
function narrowIdleTimeoutResult(result: unknown): { idleTimeoutMs: number } {
  if (
    result !== null &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    typeof (result as { idleTimeoutMs?: unknown }).idleTimeoutMs === "number" &&
    Number.isSafeInteger((result as { idleTimeoutMs: number }).idleTimeoutMs) &&
    (result as { idleTimeoutMs: number }).idleTimeoutMs >= 0
  ) {
    return { idleTimeoutMs: (result as { idleTimeoutMs: number }).idleTimeoutMs };
  }
  throw new HttpError(503, "SETTINGS_UNAVAILABLE", "Session settings are unavailable");
}

export function registerSessionSettingsRoutes(
  app: Hono<HostEnv>,
  deps: SessionSettingsRouteDeps,
): void {
  app.get("/v1/settings/session-idle-timeout", async (c) => {
    let result: unknown;
    try {
      result = await deps.client.getIdleTimeoutMs();
    } catch (error) {
      throw mapSessionSettingsError(error);
    }
    return c.json(narrowIdleTimeoutResult(result));
  });

  app.put("/v1/settings/session-idle-timeout", async (c) => {
    // Authority first: the mutation guard runs BEFORE any query/body parsing so
    // a down sessiond can never be reached with a half-parsed request.
    try {
      await deps.mutationGuard.assertAvailable();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, "SETTINGS_UNAVAILABLE", "Session settings are unavailable");
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(c, SETTINGS_BODY_LIMIT);
    } catch (error) {
      // readJsonObject already maps malformed JSON / non-JSON bodies to fixed
      // 4xx; anything else here fails closed to the fixed invalid-input 400.
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "INVALID_IDLE_TIMEOUT", "Idle timeout is invalid");
    }
    const idleTimeoutMs = parseIdleTimeoutBody(body);
    let result: unknown;
    try {
      result = await deps.client.setIdleTimeoutMs(idleTimeoutMs);
    } catch (error) {
      throw mapSessionSettingsError(error);
    }
    return c.json(narrowIdleTimeoutResult(result));
  });
}
