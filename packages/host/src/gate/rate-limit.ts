import type { LoginRateLimiter } from "../types.js";

export interface InMemoryRateLimiterOptions {
  now?: () => number;
  /** Maximum imposed delay in seconds (default 30, mirrors legacy cap). */
  maxDelaySeconds?: number;
  /** Per-key record TTL in ms (default 15 minutes). */
  ttlMs?: number;
  /** Maximum retained caller keys (default 10,000). */
  maxEntries?: number;
}

/**
 * In-memory exponential backoff rate limiter, mirroring the legacy
 * `lib/web-auth-rate-limit.ts` semantics: delay doubles per failure
 * (1s, 2s, 4s, ...) up to a cap; records expire after a TTL.
 */
export function createInMemoryRateLimiter(
  options: InMemoryRateLimiterOptions = {},
): LoginRateLimiter {
  const now = options.now ?? Date.now;
  const maxDelaySeconds = options.maxDelaySeconds ?? 30;
  const ttlMs = options.ttlMs ?? 15 * 60 * 1000;
  const maxEntries = Math.max(1, options.maxEntries ?? 10_000);
  const attempts = new Map<string, { failures: number; retryAt: number; expiresAt: number }>();

  function delaySeconds(failures: number): number {
    return Math.min(maxDelaySeconds, 2 ** (failures - 1));
  }

  function purge(nowMs: number): void {
    for (const [key, record] of attempts) {
      if (record.expiresAt <= nowMs) attempts.delete(key);
    }
  }

  function bound(): void {
    while (attempts.size > maxEntries) {
      const oldest = attempts.keys().next().value as string | undefined;
      if (!oldest) break;
      attempts.delete(oldest);
    }
  }

  return {
    retryAfterSeconds(key) {
      const t = now();
      purge(t);
      const record = attempts.get(key);
      if (!record || record.retryAt <= t) return 0;
      return Math.min(maxDelaySeconds, Math.ceil((record.retryAt - t) / 1000));
    },
    recordFailure(key) {
      const t = now();
      purge(t);
      const previous = attempts.get(key);
      const failures = (previous?.failures ?? 0) + 1;
      const delay = delaySeconds(failures);
      attempts.delete(key);
      attempts.set(key, {
        failures,
        retryAt: t + delay * 1000,
        expiresAt: t + ttlMs,
      });
      bound();
      return delay;
    },
    clear(key) {
      purge(now());
      attempts.delete(key);
    },
  };
}
