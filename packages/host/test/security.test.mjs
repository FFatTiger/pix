import assert from "node:assert/strict";
import test from "node:test";
import { createHostApp } from "../dist/index.js";

function appWithGateDisabled() {
  return createHostApp({
    logger: {},
    gate: { config: { read: () => ({ status: "disabled", source: "test" }) } },
  });
}

test("untrusted Host header is rejected with 403 for pages", async () => {
  const { app } = appWithGateDisabled();
  const res = await app.request("http://anything.evil/", {
    headers: { host: "anything.evil" },
  });
  assert.equal(res.status, 403);
  assert.equal(await res.text(), "Untrusted request");
  assert.equal(res.headers.get("cache-control"), null);
});

test("untrusted Host header is rejected with JSON 403 for /v1 APIs", async () => {
  const { app } = appWithGateDisabled();
  const res = await app.request("http://anything.evil/v1/health", {
    headers: { host: "anything.evil" },
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.code, "UNTRUSTED_HOST");
});

test("malformed Host headers (userinfo / whitespace) are rejected", async () => {
  const { app } = appWithGateDisabled();
  for (const host of ["evil.com@localhost", "local host", "localhost:abc", "\\"]) {
    const res = await app.request("http://localhost/", { headers: { host } });
    assert.equal(res.status, 403, `host ${JSON.stringify(host)} must be rejected`);
  }
});

test("loopback localhost and IP literals are trusted", async () => {
  const { app } = appWithGateDisabled();
  for (const host of ["localhost", "localhost:30141", "127.0.0.1", "[::1]", "127.0.0.1:8080"]) {
    const res = await app.request("http://localhost/v1/health", { headers: { host } });
    assert.equal(res.status, 200, `host ${host} should be trusted`);
  }
});

test("configured operator hostnames are trusted (DNS-rebinding allowlist)", async () => {
  const { app } = createHostApp({
    logger: {},
    allowedHosts: ["pi.example.com", "192.168.1.99"],
    gate: { config: { read: () => ({ status: "disabled", source: "test" }) } },
  });
  for (const host of ["pi.example.com", "PI.EXAMPLE.COM.", "192.168.1.99:8080"]) {
    const res = await app.request("http://pi.example.com/v1/health", { headers: { host } });
    assert.equal(res.status, 200, `host ${host} should be trusted`);
  }
});

test("forwarded proto is ignored unless the transport peer is trusted", async () => {
  const untrusted = createHostApp({
    logger: {},
    gate: { config: { read: () => ({ status: "enabled", password: "secret", source: "test" }) } },
  }).app;
  const direct = await untrusted.request("http://localhost/v1/gate/login", {
    method: "POST",
    headers: {
      host: "localhost",
      "content-type": "application/json",
      "x-forwarded-proto": "https",
    },
    body: JSON.stringify({ password: "secret" }),
  });
  assert.doesNotMatch(direct.headers.get("set-cookie") ?? "", /Secure/i);

  const trustedHost = createHostApp({
    logger: {},
    trustedProxy: { addresses: ["10.0.0.1"] },
    gate: { config: { read: () => ({ status: "enabled", password: "secret", source: "test" }) } },
  });
  const proxied = await trustedHost.app.request(
    "http://localhost/v1/gate/login",
    {
      method: "POST",
      headers: {
        host: "localhost",
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.7",
        "x-forwarded-proto": "https",
      },
      body: JSON.stringify({ password: "secret" }),
    },
    { incoming: { socket: { remoteAddress: "10.0.0.1" } } },
  );
  assert.match(proxied.headers.get("set-cookie") ?? "", /Secure/i);

  const limiterAttempts = [];
  const limiter = {
    retryAfterSeconds(key) { limiterAttempts.push(key); return 0; },
    recordFailure() { return 1; },
    clear() {},
  };
  const validated = createHostApp({
    logger: {},
    trustedProxy: { addresses: ["10.0.0.1"] },
    gate: {
      config: { read: () => ({ status: "enabled", password: "secret", source: "test" }) },
      rateLimiter: limiter,
    },
  });
  await validated.app.request(
    "http://localhost/v1/gate/login",
    {
      method: "POST",
      headers: {
        host: "localhost",
        "content-type": "application/json",
        "x-forwarded-for": "not-an-ip",
        "x-forwarded-proto": "https",
      },
      body: JSON.stringify({ password: "wrong" }),
    },
    { incoming: { socket: { remoteAddress: "10.0.0.1" } } },
  );
  assert.deepEqual(limiterAttempts, ["10.0.0.1"]);
});

test("trusted proxy chain pins limiter key against attacker-prepended XFF", async () => {
  const keys = [];
  const limiter = {
    retryAfterSeconds(key) { keys.push(key); return 0; },
    recordFailure() { return 0; },
    clear() {},
  };
  const host = createHostApp({
    logger: {},
    trustedProxy: { addresses: ["10.0.0.1", "10.0.0.2"] },
    gate: {
      config: { read: () => ({ status: "enabled", password: "secret", source: "test" }) },
      rateLimiter: limiter,
    },
  });
  for (const forged of ["1.1.1.1", "2.2.2.2"]) {
    await host.app.request(
      "http://localhost/v1/gate/login",
      {
        method: "POST",
        headers: {
          host: "localhost",
          "content-type": "application/json",
          "x-forwarded-for": `${forged}, 203.0.113.9, 10.0.0.2`,
          "x-forwarded-proto": "http, https, http",
        },
        body: JSON.stringify({ password: "wrong" }),
      },
      { incoming: { socket: { remoteAddress: "10.0.0.1" } } },
    );
  }
  assert.deepEqual(keys, ["203.0.113.9", "203.0.113.9"]);
});

test("ambiguous proto/XFF chains fail closed to transport identity and scheme", async () => {
  const keys = [];
  const limiter = {
    retryAfterSeconds(key) { keys.push(key); return 0; },
    recordFailure() { return 0; },
    clear() {},
  };
  const host = createHostApp({
    logger: {},
    trustedProxy: { addresses: ["10.0.0.1"], maxHops: 3, maxHeaderBytes: 64 },
    gate: {
      config: { read: () => ({ status: "enabled", password: "secret", source: "test" }) },
      rateLimiter: limiter,
    },
  });
  for (const headers of [
    { "x-forwarded-for": "1.1.1.1,2.2.2.2", "x-forwarded-proto": "https" },
    { "x-forwarded-for": "1.1.1.1,,2.2.2.2", "x-forwarded-proto": "https,http,http" },
    { "x-forwarded-for": "1.1.1.1,2.2.2.2,3.3.3.3,4.4.4.4", "x-forwarded-proto": "https,http,http,http" },
  ]) {
    const res = await host.app.request(
      "http://localhost/v1/gate/login",
      {
        method: "POST",
        headers: { host: "localhost", "content-type": "application/json", ...headers },
        body: JSON.stringify({ password: "wrong" }),
      },
      { incoming: { socket: { remoteAddress: "10.0.0.1" } } },
    );
    assert.doesNotMatch(res.headers.get("set-cookie") ?? "", /Secure/i);
  }
  assert.deepEqual(keys, ["10.0.0.1", "10.0.0.1", "10.0.0.1"]);
});

test("cross-site Origin on API is rejected with 403", async () => {
  const { app } = appWithGateDisabled();
  const res = await app.request("http://localhost/v1/health", {
    headers: {
      host: "localhost",
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
    },
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.code, "UNTRUSTED_ORIGIN");
});

test("same-site Origin on API is allowed (host+port match, scheme-insensitive)", async () => {
  const { app } = appWithGateDisabled();
  const res = await app.request("http://localhost:30141/v1/health", {
    headers: {
      host: "localhost:30141",
      origin: "http://localhost:30141",
    },
  });
  assert.equal(res.status, 200);

  // HTTPS origin behind TLS termination still matches the Host header.
  const res2 = await app.request("http://localhost/v1/health", {
    headers: {
      host: "localhost",
      origin: "https://localhost",
    },
  });
  assert.equal(res2.status, 200);
});

test("origin with wrong port is rejected", async () => {
  const { app } = appWithGateDisabled();
  const res = await app.request("http://localhost:30141/v1/health", {
    headers: {
      host: "localhost:30141",
      origin: "http://localhost:9999",
    },
  });
  assert.equal(res.status, 403);
});

test("non-browser API requests without Origin header are allowed", async () => {
  const { app } = appWithGateDisabled();
  const res = await app.request("http://localhost/v1/health", {
    headers: { host: "localhost" },
  });
  assert.equal(res.status, 200);
});

test("untrusted Host rejects even on WS-style request with Upgrade header", async () => {
  const { app } = appWithGateDisabled();
  const res = await app.request("http://evil.example/v1/runtime", {
    headers: {
      host: "evil.example",
      upgrade: "websocket",
      connection: "Upgrade",
    },
  });
  assert.equal(res.status, 403);
});
