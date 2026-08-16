import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { SessiondRpcClient } from "@fffattiger/pix-sessiond/client";
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
 * Resolve the authenticated protocol version of a sessiond via `system.hello`.
 * Returns the daemon's negotiated protocolVersion, or undefined when the call
 * fails (auth / timeout / unreachable / schema violation). Protocol v2
 * stale-daemon safety: callers use this to refuse silently reusing a pingable
 * v1 daemon. The raw version is never echoed into an operator-facing error.
 */
export async function helloProtocolVersion(
  endpoint: string,
  secret: string,
  timeoutMs = 2_000,
): Promise<number | undefined> {
  const client = new SessiondRpcClient({ endpoint, secret, timeoutMs });
  try {
    const result = await client.call("system.hello", {});
    return typeof result.protocolVersion === "number" ? result.protocolVersion : undefined;
  } catch {
    return undefined;
  }
}

/** True when the authenticated daemon speaks the current protocol version. */
export async function isProtocolCurrent(
  endpoint: string,
  secret: string,
  timeoutMs = 2_000,
): Promise<boolean> {
  const version = await helloProtocolVersion(endpoint, secret, timeoutMs);
  return version === PROTOCOL_VERSION;
}

/**
 * Narrow Protocol-v1 control call used ONLY to replace an owned stale daemon
 * during the coordinated v2 rollout. It deliberately does not import or accept
 * old product DTOs: AUTH plus the exact lock instance id remains the authority,
 * and responses are checked only for the correlated fixed control method.
 */
async function legacyV1ControlCall(
  endpoint: string,
  secret: string,
  method: "system.ping" | "system.shutdown",
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<boolean> {
  const id = randomUUID();
  return new Promise<boolean>((resolve) => {
    const socket = createConnection(endpoint);
    let buffered = "";
    let authenticated = false;
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on("connect", () => socket.write(`AUTH ${secret}\n`));
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      if (buffered.length > 64 * 1024) return finish(false);
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (!authenticated) {
          if (line !== "OK") return finish(false);
          authenticated = true;
          socket.write(`${JSON.stringify({ protocolVersion: 1, id, method, params })}\n`);
          continue;
        }
        try {
          const response = JSON.parse(line) as {
            id?: unknown;
            method?: unknown;
            ok?: unknown;
            result?: { pong?: unknown; accepted?: unknown };
          };
          if (response.id !== id || response.method !== method || response.ok !== true) return finish(false);
          return finish(method === "system.ping" ? response.result?.pong === true : response.result?.accepted === true);
        } catch {
          return finish(false);
        }
      }
    });
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
  });
}

/** Authenticated reachability probe for the one supported stale protocol. */
export function pingLegacyV1Sessiond(endpoint: string, secret: string, timeoutMs = 2_000): Promise<boolean> {
  return legacyV1ControlCall(endpoint, secret, "system.ping", {}, timeoutMs);
}

/** Authenticated, instance-fenced shutdown for the one supported stale protocol. */
export function shutdownLegacyV1Sessiond(
  endpoint: string,
  secret: string,
  instanceId: string,
  timeoutMs = 2_000,
): Promise<boolean> {
  return legacyV1ControlCall(endpoint, secret, "system.shutdown", { instanceId }, timeoutMs);
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
