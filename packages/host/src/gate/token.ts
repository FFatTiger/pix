import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const DEFAULT_GATE_COOKIE_NAME = "pi_web_session";
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const TOKEN_VERSION = "v1";
const SESSION_KEY_CONTEXT = "pi-web-session-v1";

function safeEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function deriveKey(password: string): Buffer {
  return createHash("sha256").update(SESSION_KEY_CONTEXT).update("\0").update(password).digest();
}

function sign(payload: string, password: string): string {
  return createHmac("sha256", deriveKey(password)).update(payload).digest("base64url");
}

/** Constant-time password comparison (sha256 both sides, timingSafeEqual). */
export function passwordsMatch(actual: string, expected: string): boolean {
  const left = createHash("sha256").update(actual).digest();
  const right = createHash("sha256").update(expected).digest();
  return safeEqual(left, right);
}

export interface CreateTokenOptions {
  now?: number;
  nonce?: string;
  ttlMs?: number;
  randomBytes?: (size: number) => Uint8Array;
}

/**
 * HMAC-SHA256 signed session token: `v1.<expiresAtMs>.<nonce>.<signature>`.
 * The signature is verified in constant time.
 */
export function createSessionToken(password: string, options: CreateTokenOptions = {}): string {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  const nonce = options.nonce ?? base64Url(options.randomBytes ? options.randomBytes(16) : randomBytes(16));
  const expiresAt = now + ttlMs;
  const payload = `${TOKEN_VERSION}.${expiresAt}.${nonce}`;
  return `${payload}.${sign(payload, password)}`;
}

export interface SessionTokenClaims {
  tokenId: string;
  expiresAt: number;
}

/** Parse and verify a token, returning its bounded revocation identity. */
export function readSessionToken(
  token: string | undefined,
  password: string,
  now: number = Date.now(),
): SessionTokenClaims | null {
  if (typeof token !== "string" || token.length === 0) return null;

  const parts = token.split(".");
  if (parts.length !== 4) return null;

  const [version, expiresAtRaw, nonce, signature] = parts;
  if (version !== TOKEN_VERSION) return null;
  if (!expiresAtRaw || !nonce || !signature) return null;

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;

  const payload = `${version}.${expiresAtRaw}.${nonce}`;
  const expected = sign(payload, password);

  try {
    if (
      !safeEqual(
        Buffer.from(signature, "base64url"),
        Buffer.from(expected, "base64url"),
      )
    ) {
      return null;
    }
    return { tokenId: nonce, expiresAt };
  } catch {
    return null;
  }
}

export function verifySessionToken(
  token: string | undefined,
  password: string,
  now: number = Date.now(),
): boolean {
  return readSessionToken(token, password, now) !== null;
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}
