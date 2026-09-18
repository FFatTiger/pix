import assert from "node:assert/strict";
import test from "node:test";
import {
  isHostTrusted,
  isOriginAllowed,
  resolveHostMode,
  passwordsMatch,
  createSessionToken,
  verifySessionToken,
  sanitizeNextPath,
  isPublicPwaAssetPath,
  isPublicViteAssetPath,
  resolveClientFile,
  isGatePublicPath,
  createInMemoryRateLimiter,
  decideGateRequest,
  normalizeGateConfig,
  resolveForwardedRequest,
} from "../dist/index.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("normalizeGateConfig fails closed and preserves significant password whitespace", () => {
  assert.deepEqual(normalizeGateConfig({ status: "enabled", password: " secret ", source: "x" }), {
    status: "enabled",
    password: " secret ",
    source: "x",
  });
  for (const malformed of [
    { status: "enabled", source: "x" },
    { status: "enabled", password: "", source: "x" },
    { status: "enabled", password: 123, source: "x" },
    { status: "bogus", password: "secret", source: "x" },
    { status: "disabled", password: "secret", source: "x" },
    { status: "unconfigured", password: "secret", source: "x" },
    { status: "error", password: "secret", source: "x" },
    null,
  ]) {
    const normalized = normalizeGateConfig(malformed);
    assert.equal(normalized.status, "error", JSON.stringify(malformed));
    assert.equal("password" in normalized, false);
  }
});

test("forwarded request peels trusted proxies right-to-left and aligns proto", () => {
  assert.deepEqual(
    resolveForwardedRequest(
      "10.0.0.1",
      "203.0.113.9, 10.0.0.2",
      "https, http",
      ["10.0.0.1", "10.0.0.2"],
    ),
    { clientAddress: "203.0.113.9", protocol: "https:", valid: true },
  );
  assert.deepEqual(
    resolveForwardedRequest(
      "::ffff:10.0.0.1",
      "2001:db8::7, ::ffff:10.0.0.2",
      "https, http",
      ["10.0.0.1", "10.0.0.2"],
    ),
    { clientAddress: "2001:db8::7", protocol: "https:", valid: true },
  );
});

test("invalid or ambiguous forwarding chains fail closed to transport", () => {
  const fallback = { clientAddress: "10.0.0.1", protocol: null, valid: false };
  for (const [xff, xfp, maxHops, maxBytes] of [
    ["", "https", 16, 2048],
    ["203.0.113.1,,10.0.0.2", "https,http,http", 16, 2048],
    ["not-ip", "https", 16, 2048],
    ["203.0.113.1,10.0.0.2", "https", 16, 2048],
    ["203.0.113.1", "https,http", 16, 2048],
    ["203.0.113.1,10.0.0.2", "https,ftp", 16, 2048],
    ["203.0.113.1,198.51.100.2", "https,http", 16, 2048],
    ["1.1.1.1,2.2.2.2,3.3.3.3", "http,http,http", 2, 2048],
    ["203.0.113.1", "https", 16, 4],
  ]) {
    assert.deepEqual(
      resolveForwardedRequest("10.0.0.1", xff, xfp, ["10.0.0.1", "10.0.0.2"], maxHops, maxBytes),
      fallback,
    );
  }
});

test("isHostTrusted accepts loopback and rejects rebinding hosts", () => {
  assert.ok(isHostTrusted("localhost"));
  assert.ok(isHostTrusted("localhost:8080"));
  assert.ok(isHostTrusted("127.0.0.1"));
  assert.ok(isHostTrusted("[::1]"));
  assert.ok(isHostTrusted("192.168.1.5")); // IP literal can't be rebound
  assert.equal(isHostTrusted("rebound.example.com"), false);
  assert.equal(isHostTrusted("localhost.evil.com"), false);
  assert.equal(isHostTrusted("localhost@evil.com"), false);
  assert.equal(isHostTrusted(null), false);
  assert.equal(isHostTrusted(""), false);
});

test("isHostTrusted honors the configured allowlist", () => {
  assert.ok(isHostTrusted("pi.example.com", ["pi.example.com"]));
  assert.ok(isHostTrusted("pi.example.com:443", ["pi.example.com"]));
  assert.ok(isHostTrusted("pi.example.com", ["pi.example.com:443"]));
  assert.equal(isHostTrusted("other.example.com", ["pi.example.com"]), false);
  assert.equal(isHostTrusted("pi.example.com", ["https://pi.example.com"]), false);
});

test("resolveHostMode distinguishes local vs lan", () => {
  assert.equal(resolveHostMode("localhost"), "local");
  assert.equal(resolveHostMode("127.0.0.1"), "local");
  assert.equal(resolveHostMode("::1"), "local");
  assert.equal(resolveHostMode("192.168.1.5"), "lan");
  assert.equal(resolveHostMode("8.8.8.8"), "lan");
  assert.equal(resolveHostMode("pi.example.com"), "lan");
});

test("isOriginAllowed enforces same-origin for API requests", () => {
  const sameSite = new Request("http://localhost:30141/v1/health", {
    headers: { host: "localhost:30141", origin: "http://localhost:30141" },
  });
  assert.ok(isOriginAllowed(sameSite));

  const crossSite = new Request("http://localhost/v1/health", {
    headers: { host: "localhost", origin: "https://evil.example", "sec-fetch-site": "cross-site" },
  });
  assert.equal(isOriginAllowed(crossSite), false);

  const noOrigin = new Request("http://localhost/v1/health", { headers: { host: "localhost" } });
  assert.ok(isOriginAllowed(noOrigin));
});

test("password comparison is constant-time", () => {
  assert.ok(passwordsMatch("secret", "secret"));
  assert.equal(passwordsMatch("Secret", "secret"), false);
  assert.equal(passwordsMatch("", "secret"), false);
  // No length-leak: hashes are compared, not raw strings.
  assert.equal(passwordsMatch("x", "secret"), false);
});

test("session tokens round-trip and reject tampering/expiry", () => {
  const token = createSessionToken("secret", { now: 1000 });
  assert.ok(verifySessionToken(token, "secret", 2000));
  assert.equal(verifySessionToken(token, "wrong", 2000), false);
  assert.equal(verifySessionToken(token, "secret", 1000 + 31 * 24 * 3600 * 1000), false);
  assert.equal(verifySessionToken(`${token}x`, "secret", 2000), false);
  assert.equal(verifySessionToken("garbage", "secret", 2000), false);
  assert.equal(verifySessionToken(undefined, "secret", 2000), false);
});

test("deterministic nonce produces deterministic tokens", () => {
  const t1 = createSessionToken("secret", { now: 1000, nonce: "abcdefghijklmnop" });
  const t2 = createSessionToken("secret", { now: 1000, nonce: "abcdefghijklmnop" });
  assert.equal(t1, t2);
});

test("sanitizeNextPath rejects protocol-relative and control chars", () => {
  assert.equal(sanitizeNextPath("/a/b?c=1#d"), "/a/b?c=1#d");
  assert.equal(sanitizeNextPath("//evil.com"), "/");
  assert.equal(sanitizeNextPath("/%2f%2fevil.com"), "/");
  assert.equal(sanitizeNextPath("/a\\b"), "/");
  assert.equal(sanitizeNextPath("/a\r\nb"), "/");
  assert.equal(sanitizeNextPath("https://evil.com"), "/");
  assert.equal(sanitizeNextPath("/login"), "/");
  assert.equal(sanitizeNextPath(undefined), "/");
});

test("public PWA allowlist is exact-match with icons prefix", () => {
  assert.ok(isPublicPwaAssetPath("/sw.js"));
  assert.ok(isPublicPwaAssetPath("/manifest.webmanifest"));
  assert.ok(isPublicPwaAssetPath("/offline.html"));
  assert.ok(isPublicPwaAssetPath("/icons/icon-192.png"));
  assert.ok(isPublicViteAssetPath("/assets/index-abc.js"));
  assert.equal(isPublicPwaAssetPath("/sw.js.evil"), false);
  assert.equal(isPublicPwaAssetPath("/icons.evil/x"), false);
  assert.equal(isPublicPwaAssetPath("/manifest.webmanifest.json"), false);
  assert.equal(isPublicViteAssetPath("/assets.evil/index.js"), false);
  assert.equal(isPublicViteAssetPath("/assetsx/index.js"), false);
  assert.ok(isGatePublicPath("/v1/gate/status"));
  assert.ok(isGatePublicPath("/login"));
  assert.ok(isGatePublicPath("/v1/health"));
  assert.ok(isGatePublicPath("/v1/bootstrap"));
  assert.equal(isGatePublicPath("/v1/sessions"), false);
  assert.equal(isGatePublicPath("/v1/bootstrap.evil"), false);
});

test("resolveClientFile contains paths within root", () => {
  const root = join(tmpdir(), "pix-host-root");
  assert.equal(resolveClientFile(root, "/index.html"), join(root, "index.html"));
  assert.equal(resolveClientFile(root, "/a/b/c.js"), join(root, "a/b/c.js"));
  assert.equal(resolveClientFile(root, "/../etc/passwd"), null);
  assert.equal(resolveClientFile(root, "/%2e%2e/etc/passwd"), null);
  assert.equal(resolveClientFile(root, "/a\\b"), null);
  assert.equal(resolveClientFile(root, "/bad%zz"), null);
});

test("rate limiter backoff doubles per failure up to the cap", () => {
  let now = 0;
  const limiter = createInMemoryRateLimiter({ now: () => now, maxDelaySeconds: 30 });
  assert.equal(limiter.retryAfterSeconds("k"), 0);
  limiter.recordFailure("k");
  limiter.recordFailure("k");
  assert.equal(limiter.retryAfterSeconds("k"), 2);
  limiter.recordFailure("k");
  assert.equal(limiter.retryAfterSeconds("k"), 4);
  now += 4001;
  assert.equal(limiter.retryAfterSeconds("k"), 0);
  limiter.clear("k");
  assert.equal(limiter.retryAfterSeconds("k"), 0);
});

test("decideGateRequest allows public paths and blocks APIs", () => {
  const config = { status: "enabled", password: "secret", source: "test" };
  const base = { config, mode: "local", sessionValid: false, requireForLan: true };

  assert.equal(decideGateRequest({ ...base, url: "http://h/v1/gate/status" }).action, "allow");
  assert.equal(decideGateRequest({ ...base, url: "http://h/sw.js" }).action, "allow");
  assert.equal(decideGateRequest({ ...base, url: "http://h/assets/index.js" }).action, "allow");
  assert.equal(decideGateRequest({ ...base, url: "http://h/v1/health" }).action, "allow");
  assert.equal(decideGateRequest({ ...base, url: "http://h/v1/sessions" }).action, "json");
  assert.equal(decideGateRequest({ ...base, url: "http://h/login" }).action, "allow");
  assert.equal(decideGateRequest({ ...base, url: "http://h/app" }).action, "redirect");
});
