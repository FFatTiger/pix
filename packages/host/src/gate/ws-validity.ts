/**
 * Live WS gate-validity closure. Reuses the same GateConfig source,
 * revocation store, decideGateRequest, and readSessionToken as HTTP gate
 * middleware. Captures the upgrade cookie token; never logs it.
 */
import { decideGateRequest } from "./decision.js";
import { readSessionToken } from "./token.js";
import type { GateConfigSource, HostMode, SessionRevocationStore, WsGateValidity } from "../types.js";

export interface LiveGateVerifierOptions {
  readonly config: GateConfigSource;
  readonly revocations: SessionRevocationStore;
  /** Cookie value captured at WS upgrade; never re-read from the socket. */
  readonly cookieToken: string | undefined;
  readonly url: string;
  readonly mode: HostMode;
  readonly requireForLan?: boolean;
  readonly now?: () => number;
}

/** Host-owned live gate recheck for an already-upgraded runtime WS. */
export function createLiveGateVerifier(options: LiveGateVerifierOptions): () => WsGateValidity {
  const requireForLan = options.requireForLan ?? true;
  const now = options.now ?? Date.now;
  return (): WsGateValidity => {
    const config = options.config.read();
    const nowMs = now();
    let sessionValid = false;
    if (config.status === "enabled") {
      const claims = readSessionToken(options.cookieToken, config.password, nowMs);
      sessionValid = claims !== null && !options.revocations.isRevoked(claims.tokenId, nowMs);
    }
    const decision = decideGateRequest({
      config,
      mode: options.mode,
      url: options.url,
      sessionValid,
      requireForLan,
    });
    if (decision.action === "allow") return { ok: true };
    return {
      ok: false,
      error: {
        code: decision.action === "json" && decision.status === 503 ? "unavailable" : "unauthorized",
        message: "session is no longer authorized",
        retryable: false,
      },
    };
  };
}
