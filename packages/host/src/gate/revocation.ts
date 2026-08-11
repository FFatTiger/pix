import type { SessionRevocationStore } from "../types.js";

export interface InMemoryRevocationOptions {
  now?: () => number;
  /** Maximum retained token IDs (default 10,000). */
  maxEntries?: number;
}

/**
 * Process-local bounded revocation state. Revocations intentionally do not
 * survive a Host restart; deployments requiring durable logout can inject a
 * persistent store through GateDeps.
 */
export function createInMemoryRevocationStore(
  options: InMemoryRevocationOptions = {},
): SessionRevocationStore {
  const now = options.now ?? Date.now;
  const maxEntries = Math.max(1, options.maxEntries ?? 10_000);
  const revoked = new Map<string, number>();

  function purge(nowMs: number): void {
    for (const [tokenId, expiresAt] of revoked) {
      if (expiresAt <= nowMs) revoked.delete(tokenId);
    }
  }

  function bound(): void {
    while (revoked.size > maxEntries) {
      const oldest = revoked.keys().next().value as string | undefined;
      if (!oldest) break;
      revoked.delete(oldest);
    }
  }

  return {
    isRevoked(tokenId, nowMs) {
      purge(nowMs);
      return revoked.has(tokenId);
    },
    revoke(tokenId, expiresAt) {
      purge(now());
      revoked.delete(tokenId);
      revoked.set(tokenId, expiresAt);
      bound();
    },
  };
}
