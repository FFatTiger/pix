import { SessiondRpcClient } from "@fffattiger/pix-sessiond/client";
import type { SessionDeleteClient, SessionHistoryReadClient } from "../types.js";

/**
 * Narrow read-only session history client backed by the fixed sessiond RPC
 * endpoint+secret (D1A-2 phase 2).
 *
 * The real {@link SessiondRpcClient} satisfies the protocol-independent
 * {@link SessionHistoryReadClient} seam: it wraps exactly the three read-only
 * catalog RPCs (`sessions.list` / `sessions.read` / `sessions.context`) and
 * never the runtime lifecycle (no activate/command/stop). The sessiond secret is
 * captured once at Host startup and bound here — a rotation while the Host keeps
 * running surfaces as an authentication failure ⇒ 503 on these routes.
 *
 * None of these RPCs can activate a Worker: the sessiond catalog handler reads
 * read-only JSONL with zero runtime involvement.
 */
export interface SessiondSessionsClientOptions {
  /** Fixed sessiond RPC endpoint. */
  endpoint: string;
  /** Fixed sessiond secret (captured once at Host startup). */
  secret: string;
  /** Per-RPC timeout (default 10_000 ms). */
  timeoutMs?: number;
}

export function createSessiondSessionsClient(
  options: SessiondSessionsClientOptions,
): SessionHistoryReadClient {
  const client = new SessiondRpcClient({
    endpoint: options.endpoint,
    secret: options.secret,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return {
    async list(params) {
      return client.call("sessions.list", params);
    },
    async read(sessionId) {
      return client.call("sessions.read", { sessionId });
    },
    async context(sessionId, leafId) {
      return client.call("sessions.context", {
        sessionId,
        ...(leafId === undefined ? {} : { leafId }),
      });
    },
  };
}

/**
 * D4 narrow session-history delete client backed by the fixed sessiond RPC
 * endpoint+secret. It wraps exactly the `sessions.delete` RPC and never the
 * runtime lifecycle (no activate/command/stop). The sessiond service is the
 * authority: a live session fails closed with `session_busy` and is never
 * stopped-then-deleted. The sessiond secret is captured once at Host startup
 * and bound here; a rotation while the Host keeps running surfaces as an
 * authentication failure ⇒ 503 on the delete route.
 */
export function createSessiondSessionDeleteClient(
  options: SessiondSessionsClientOptions,
): SessionDeleteClient {
  const client = new SessiondRpcClient({
    endpoint: options.endpoint,
    secret: options.secret,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return {
    async delete(sessionId) {
      return client.call("sessions.delete", { sessionId });
    },
  };
}
