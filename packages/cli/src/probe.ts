import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { SessiondRpcClient } from "@fffattiger/pix-sessiond/client";
import { SessiondError } from "@fffattiger/pix-sessiond";
import { PROTOCOL_VERSION } from "@fffattiger/pix-protocol";
import type { SessiondProbe } from "@fffattiger/pix-host";
import type { SessiondPaths } from "@fffattiger/pix-sessiond/control";
import { readLocalSecret } from "./secret.js";

/**
 * Ping a sessiond instance over its local RPC socket. Returns a boolean —
 * never throws — because callers (readiness polling, capability probes, status)
 * only need to know reachability, not the failure reason.
 */
export async function pingSessiond(
  endpoint: string,
  secret: string,
  timeoutMs = 2_000,
): Promise<boolean> {
  const client = new SessiondRpcClient({ endpoint, secret, timeoutMs });
  try {
    const result = await client.call("system.ping", {});
    return result.pong === true;
  } catch {
    return false;
  }
}

/**
 * Why a daemon's protocol version could not be positively verified. `timeout`
 * and `unreachable` are transient (retryable); `auth` and `malformed` are fixed
 * problems an operator must resolve. In EVERY state the running daemon must be
 * preserved — an unverified daemon is never shut down or replaced.
 */
export type UnverifiableReason = "timeout" | "auth" | "malformed" | "unreachable" | "unknown";

/**
 * Explicit sessiond compatibility state (Protocol v2 stale-daemon safety).
 *
 * - `current`: a POSITIVELY authenticated `system.hello` returned the current
 *   protocol version ⇒ the daemon may be reused as-is.
 * - `knownLegacy`: a POSITIVELY authenticated `system.hello` (over the narrow
 *   legacy envelope, since the current client cannot parse a v1 response)
 *   returned a known older protocol version ⇒ the daemon is stale and MAY be
 *   shut down/replaced — but only through the authenticated, instance-fenced
 *   shutdown path, never via a PID signal.
 * - `unverifiable`: neither surface returned a positively authenticated version
 *   (transient hello timeout, auth failure, malformed/unparseable response, or
 *   unreachable). The daemon MUST be preserved; callers return a retryable or
 *   fixed operator error instead of touching authority.
 */
export type SessiondCompatibility =
  | { state: "current" }
  | { state: "knownLegacy"; version: number }
  | { state: "unverifiable"; reason: UnverifiableReason };

/** Map a current-client hello failure onto the operator-facing reason. */
function classifyUnverifiableReason(error: unknown): UnverifiableReason {
  if (error instanceof SessiondError) {
    switch (error.code) {
      case "timeout": return "timeout";
      case "unauthorized": return "auth";
      case "invalid_request": return "malformed";
      case "unavailable": return "unreachable";
      default: return "unknown";
    }
  }
  return "unknown";
}

/**
 * Resolve the explicit sessiond compatibility state via authenticated
 * `system.hello`. Protocol v2 stale-daemon safety: this is the ONE place the
 * CLI decides whether a running daemon is current, known-legacy, or
 * unverifiable, so `ensureSessiond` can reuse, replace, or preserve authority
 * without ever guessing. Never throws.
 */
export async function probeSessiondCompatibility(
  endpoint: string,
  secret: string,
  timeoutMs = 2_000,
): Promise<SessiondCompatibility> {
  // 1. Try the current client first. A schema-valid response can only carry the
  //    current protocol version, so success is a positively authenticated
  //    current daemon. A v1 daemon (or any transient failure) surfaces here as
  //    an RPC error — never a bogus "current" answer.
  let currentError: unknown;
  try {
    const result = await new SessiondRpcClient({ endpoint, secret, timeoutMs }).call("system.hello", {});
    if (result.protocolVersion === PROTOCOL_VERSION) return { state: "current" };
    currentError = new Error("unexpected system.hello protocol version");
  } catch (error) {
    currentError = error;
  }
  // 2. The current client cannot schema-parse a legacy (v1) response envelope.
  //    Retry the SAME authenticated hello over the narrow legacy envelope. A
  //    correlated numeric version is a positively authenticated knownLegacy.
  const legacyVersion = await legacyHelloProtocolVersion(endpoint, secret, timeoutMs);
  if (legacyVersion !== undefined) {
    if (legacyVersion === PROTOCOL_VERSION) return { state: "current" };
    return { state: "knownLegacy", version: legacyVersion };
  }
  // 3. Neither surface could positively verify the daemon. Preserve it; the
  //    caller turns this into a retryable (timeout/unreachable) or fixed
  //    (auth/malformed) operator error — never a shutdown.
  return { state: "unverifiable", reason: classifyUnverifiableReason(currentError) };
}

/**
 * Resolve the authenticated protocol version of a sessiond via `system.hello`.
 * Returns the daemon's negotiated protocolVersion, or undefined when it cannot
 * be positively verified (auth / timeout / unreachable / malformed). Protocol
 * v2 stale-daemon safety: callers use this to refuse silently reusing a
 * pingable v1 daemon. The raw version is never echoed into an operator-facing
 * error.
 */
export async function helloProtocolVersion(
  endpoint: string,
  secret: string,
  timeoutMs = 2_000,
): Promise<number | undefined> {
  const compat = await probeSessiondCompatibility(endpoint, secret, timeoutMs);
  if (compat.state === "current") return PROTOCOL_VERSION;
  if (compat.state === "knownLegacy") return compat.version;
  return undefined;
}

/** True only when the authenticated daemon is POSITIVELY current. */
export async function isProtocolCurrent(
  endpoint: string,
  secret: string,
  timeoutMs = 2_000,
): Promise<boolean> {
  const compat = await probeSessiondCompatibility(endpoint, secret, timeoutMs);
  return compat.state === "current";
}

type LegacyControlMethod = "system.ping" | "system.hello" | "system.shutdown";

/** Outcome of a narrow legacy control call (never throws). */
type LegacyControlOutcome =
  | { ok: true; result: { pong?: unknown; protocolVersion?: unknown; accepted?: unknown } }
  | { ok: false; reason: "timeout" | "auth" | "malformed" | "unreachable" };

/**
 * Narrow Protocol-v1 control call used ONLY to identify and replace an owned
 * stale daemon during the coordinated v2 rollout. It deliberately does not
 * import or accept old product DTOs: AUTH plus the exact lock instance id
 * remains the authority, and responses are checked only for the correlated
 * fixed control method. A failed call never throws; it reports the reason.
 */
async function legacyV1ControlCall(
  endpoint: string,
  secret: string,
  method: LegacyControlMethod,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<LegacyControlOutcome> {
  const id = randomUUID();
  return new Promise<LegacyControlOutcome>((resolve) => {
    const socket = createConnection(endpoint);
    let buffered = "";
    let authenticated = false;
    let settled = false;
    const finish = (outcome: LegacyControlOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), timeoutMs);
    socket.on("connect", () => socket.write(`AUTH ${secret}\n`));
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      if (buffered.length > 64 * 1024) return finish({ ok: false, reason: "malformed" });
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (!authenticated) {
          if (line !== "OK") return finish({ ok: false, reason: "auth" });
          authenticated = true;
          socket.write(`${JSON.stringify({ protocolVersion: 1, id, method, params })}\n`);
          continue;
        }
        try {
          const response = JSON.parse(line) as {
            id?: unknown;
            method?: unknown;
            ok?: unknown;
            result?: { pong?: unknown; protocolVersion?: unknown; accepted?: unknown };
          };
          if (response.id !== id || response.method !== method || response.ok !== true) {
            return finish({ ok: false, reason: "malformed" });
          }
          return finish({ ok: true, result: response.result ?? {} });
        } catch {
          return finish({ ok: false, reason: "malformed" });
        }
      }
    });
    socket.on("error", () => finish({ ok: false, reason: "unreachable" }));
    socket.on("close", () => finish({ ok: false, reason: "unreachable" }));
  });
}

/** Authenticated reachability probe for the one supported stale protocol. */
export async function pingLegacyV1Sessiond(endpoint: string, secret: string, timeoutMs = 2_000): Promise<boolean> {
  const outcome = await legacyV1ControlCall(endpoint, secret, "system.ping", {}, timeoutMs);
  return outcome.ok && outcome.result.pong === true;
}

/** Authenticated, instance-fenced shutdown for the one supported stale protocol. */
export async function shutdownLegacyV1Sessiond(
  endpoint: string,
  secret: string,
  instanceId: string,
  timeoutMs = 2_000,
): Promise<boolean> {
  const outcome = await legacyV1ControlCall(endpoint, secret, "system.shutdown", { instanceId }, timeoutMs);
  return outcome.ok && outcome.result.accepted === true;
}

/** Authenticated legacy `system.hello` → the reported protocolVersion (undefined on failure). */
async function legacyHelloProtocolVersion(
  endpoint: string,
  secret: string,
  timeoutMs: number,
): Promise<number | undefined> {
  const outcome = await legacyV1ControlCall(endpoint, secret, "system.hello", {}, timeoutMs);
  return outcome.ok && typeof outcome.result.protocolVersion === "number"
    ? outcome.result.protocolVersion
    : undefined;
}

/**
 * Build a host {@link SessiondProbe} backed by a real RPC ping against the
 * resolved sessiond socket. The probe reads the secret read-only; when no
 * secret exists yet it reports unavailable rather than throwing, so /v1/health
 * stays honest while a daemon is mid-bootstrap.
 */
export function createSessiondProbe(paths: SessiondPaths): SessiondProbe {
  return {
    async isAvailable(): Promise<boolean> {
      const secret = await readLocalSecret(paths.secretFile);
      if (secret === undefined) return false;
      return pingSessiond(paths.endpoint, secret);
    },
  };
}
