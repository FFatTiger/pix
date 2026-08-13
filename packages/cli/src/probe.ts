import { SessiondRpcClient } from "@fffattiger/pix-sessiond/client";
import type { SessiondProbe } from "@fffattiger/pix-host";
import type { SessiondPaths } from "@fffattiger/pix-sessiond/control";
import { readLocalSecret } from "./secret.js";

/**
 * Ping a sessiond instance over its local RPC socket. Returns a boolean —
 * never throws — because callers (readiness polling, capability probes, status)
 * only need to know reachability, not the failure reason.
 */
export async function requestSessiondShutdown(
  endpoint: string,
  secret: string,
  instanceId: string,
  timeoutMs = 2_000,
): Promise<boolean> {
  const client = new SessiondRpcClient({ endpoint, secret, timeoutMs });
  try {
    const result = await client.call("system.shutdown", { instanceId });
    return result.accepted === true;
  } catch {
    return false;
  }
}

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
