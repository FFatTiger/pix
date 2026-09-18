import assert from "node:assert/strict";
import test from "node:test";
import { createHostApp } from "../dist/index.js";

const ENABLED = { read: () => ({ status: "enabled", password: "secret", source: "test" }) };
const DISABLED = { read: () => ({ status: "disabled", source: "test" }) };
const UNCONFIGURED = { read: () => ({ status: "unconfigured", source: "test" }) };
const ERROR_CONFIG = {
  read: () => ({ status: "error", source: "test", logMessage: "broken" }),
};

function enabledApp(extra = {}) {
  return createHostApp({
    logger: {},
    gate: { config: ENABLED, ...extra },
  });
}

test("gate status reports required/authenticated/mode", async () => {
  const { app } = enabledApp();
  const res = await app.request("http://localhost/v1/gate/status", {
    headers: { host: "localhost" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), {
    required: true,
    authenticated: false,
    mode: "local",
    status: "enabled",
  });
});

test("malformed injected gate configs fail closed across status, API and login", async () => {
  const malformed = [
    { status: "enabled", source: "missing" },
    { status: "enabled", password: "", source: "empty" },
    { status: "enabled", password: 123, source: "wrong-type" },
    { status: "bogus", password: "secret", source: "bad-status" },
    { status: "disabled", password: "secret", source: "disabled-password" },
    { status: "unconfigured", password: "secret", source: "unconfigured-password" },
    { status: "error", password: "secret", source: "error-password" },
  ];
  for (const injected of malformed) {
    const { app } = createHostApp({
      logger: {},
      gate: { config: { read: () => injected } },
    });
    const status = await app.request("http://localhost/v1/gate/status", {
      headers: { host: "localhost" },
    });
    assert.equal(status.status, 200, injected.source);
    assert.deepEqual(await status.json(), {
      required: false,
      authenticated: false,
      mode: "local",
      status: "error",
    });

    const api = await app.request("http://localhost/v1/capabilities", {
      headers: { host: "localhost" },
    });
    assert.equal(api.status, 503, injected.source);
    assert.equal((await api.json()).code, "AUTH_CONFIG_ERROR");

    const login = await app.request("http://localhost/v1/gate/login", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ password: "" }),
    });
    assert.equal(login.status, 503, injected.source);
    assert.equal(login.headers.get("set-cookie"), null, injected.source);
    assert.equal((await login.json()).code, "AUTH_CONFIG_ERROR");
  }
});

test("malformed gate config also fails closed on LAN status", async () => {
  const { app } = createHostApp({
    logger: {},
    exposureMode: "lan",
    gate: { config: { read: () => ({ status: "enabled", password: "", source: "lan-empty" }) } },
  });
  const status = await app.request("http://localhost/v1/gate/status", {
    headers: { host: "localhost" },
  });
  assert.deepEqual(await status.json(), {
    required: true,
    authenticated: false,
    mode: "lan",
    status: "error",
  });
  const login = await app.request("http://localhost/v1/gate/login", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ password: "" }),
  });
  assert.equal(login.status, 503);
  assert.equal(login.headers.get("set-cookie"), null);
});

test("significant whitespace passwords are not trimmed or reinterpreted", async () => {
  const limiter = { retryAfterSeconds: () => 0, recordFailure: () => 0, clear() {} };
  const { app } = createHostApp({
    logger: {},
    gate: {
      config: { read: () => ({ status: "enabled", password: " secret ", source: "spaces" }) },
      rateLimiter: limiter,
    },
  });
  const wrong = await app.request("http://localhost/v1/gate/login", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ password: "secret" }),
  });
  assert.equal(wrong.status, 401);
  const exact = await app.request("http://localhost/v1/gate/login", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ password: " secret " }),
  });
  assert.equal(exact.status, 200);
  assert.match(exact.headers.get("set-cookie") ?? "", /pix_session=/);
});

test("public PWA assets are exact-match allowlisted", async () => {
  const { app } = enabledApp();
  const allowed = [
    "/sw.js",
    "/manifest.webmanifest",
    "/offline.html",
    "/favicon.ico",
    "/icons/icon-192.png",
    "/assets/index-abc.js",
  ];
  for (const path of allowed) {
    const res = await app.request(`http://localhost${path}`, { headers: { host: "localhost" } });
    // Passes the gate; body resolution depends on static assets, gate result is what matters.
    assert.notEqual(res.status, 302, `${path} must not redirect to login`);
    assert.notEqual(res.status, 401, `${path} must not be unauthorized`);
  }
});

test("lookalike public paths are NOT public (redirect to login)", async () => {
  const { app } = enabledApp();
  for (const path of [
    "/sw.js.evil",
    "/sw.js/",
    "/manifest.webmanifest.json",
    "/icons.evil",
    "/iconsx/icon.png",
    "/offline.html.evil",
    "/assets.evil/index.js",
    "/assetsx/index.js",
  ]) {
    const res = await app.request(`http://localhost${path}`, { headers: { host: "localhost" } });
    assert.equal(res.status, 302, `${path} should redirect to login`);
    const location = res.headers.get("location") ?? "";
    assert.ok(location.startsWith("/login"), `${path} should redirect to /login, got ${location}`);
  }
});

test("API without session gets JSON 401, pages redirect to /login", async () => {
  const { app } = enabledApp();
  const api = await app.request("http://localhost/v1/capabilities", { headers: { host: "localhost" } });
  assert.equal(api.status, 401);
  assert.deepEqual(await api.json(), {
    error: "Unauthorized",
    code: "UNAUTHORIZED",
    message: "Unauthorized",
  });

  const page = await app.request("http://localhost/some/deep/route?x=1", {
    headers: { host: "localhost", accept: "text/html" },
  });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get("location"), "/login?next=%2Fsome%2Fdeep%2Froute%3Fx%3D1");
});

test("login flow sets an httpOnly SameSite=Lax cookie and grants access", async () => {
  const { app } = enabledApp();
  const login = await app.request("http://localhost/v1/gate/login", {
    method: "POST",
    headers: {
      host: "localhost",
      "content-type": "application/json",
      "x-forwarded-for": "127.0.0.1",
    },
    body: JSON.stringify({ password: "secret", next: "/workstation?tab=1" }),
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /pix_session=[^;]+/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  const cookie = setCookie.split(";")[0];

  const withCookie = await app.request("http://localhost/v1/capabilities", {
    headers: { host: "localhost", cookie },
  });
  assert.equal(withCookie.status, 200);
});

test("login with wrong password returns 401 and no cookie", async () => {
  const { app } = enabledApp();
  const res = await app.request("http://localhost/v1/gate/login", {
    method: "POST",
    headers: {
      host: "localhost",
      "content-type": "application/json",
      "x-forwarded-for": "127.0.0.1",
    },
    body: JSON.stringify({ password: "wrong" }),
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("set-cookie"), null);
});

test("logout clears the session cookie", async () => {
  const { app } = enabledApp();
  const login = await app.request("http://localhost/v1/gate/login", {
    method: "POST",
    headers: {
      host: "localhost",
      "content-type": "application/json",
      "x-forwarded-for": "127.0.0.1",
    },
    body: JSON.stringify({ password: "secret" }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  const logout = await app.request("http://localhost/v1/gate/logout", {
    method: "POST",
    headers: { host: "localhost", cookie },
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie") ?? "", /pix_session=;/);
  assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);

  const replay = await app.request("http://localhost/v1/capabilities", {
    headers: { host: "localhost", cookie },
  });
  assert.equal(replay.status, 401, "logout must revoke the captured token in this host process");
});

test("login rate limit: repeated failures impose exponential backoff", async () => {
  let clock = 1_000_000;
  const { app } = enabledApp({ now: () => clock });
  const attempt = async (password) =>
    app.request("http://localhost/v1/gate/login", {
      method: "POST",
      headers: {
        host: "localhost",
        "content-type": "application/json",
        "x-forwarded-for": "10.0.0.7",
      },
      body: JSON.stringify({ password }),
    });

  assert.equal((await attempt("nope")).status, 401); // failure 1 → 1s delay
  clock += 1_500;
  assert.equal((await attempt("nope")).status, 401); // failure 2 → 2s delay
  clock += 2_500;
  assert.equal((await attempt("nope")).status, 401); // failure 3 → 4s delay

  // The correct password is still blocked while the backoff is active.
  const blocked = await attempt("secret");
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers.get("retry-after"));
  const body = await blocked.json();
  assert.equal(body.code, "RATE_LIMITED");
  assert.ok(body.retryAfterSeconds > 0);

  // After the window passes, the correct password succeeds.
  clock += 5_000;
  const success = await attempt("secret");
  assert.equal(success.status, 200);
});

test("direct clients cannot bypass rate limiting by rotating forwarding headers", async () => {
  let clock = 2_000_000;
  const { app } = enabledApp({ now: () => clock });
  const attempt = (xff) =>
    app.request("http://localhost/v1/gate/login", {
      method: "POST",
      headers: {
        host: "localhost",
        "content-type": "application/json",
        "x-forwarded-for": xff,
      },
      body: JSON.stringify({ password: "wrong" }),
    });
  assert.equal((await attempt("1.1.1.1")).status, 401);
  assert.equal((await attempt("2.2.2.2")).status, 429);
});

test("login requires JSON and rejects oversized bodies before parsing", async () => {
  const { app } = enabledApp({ loginBodyLimitBytes: 32 });
  const wrongType = await app.request("http://localhost/v1/gate/login", {
    method: "POST",
    headers: { host: "localhost", "content-type": "text/plain" },
    body: '{"password":"secret"}',
  });
  assert.equal(wrongType.status, 415);
  assert.equal((await wrongType.json()).code, "UNSUPPORTED_MEDIA_TYPE");

  const oversized = await app.request("http://localhost/v1/gate/login", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ password: "x".repeat(100) }),
  });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).code, "BODY_TOO_LARGE");
});

test("session cookie expires (token invalid after TTL)", async () => {
  let clock = 1_000_000;
  const { app } = enabledApp({ now: () => clock });
  const login = await app.request("http://localhost/v1/gate/login", {
    method: "POST",
    headers: {
      host: "localhost",
      "content-type": "application/json",
      "x-forwarded-for": "127.0.0.1",
    },
    body: JSON.stringify({ password: "secret" }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  clock += 31 * 24 * 60 * 60 * 1000;
  const res = await app.request("http://localhost/v1/capabilities", {
    headers: { host: "localhost", cookie },
  });
  assert.equal(res.status, 401);
});

test("disabled gate still requires auth for LAN (D-020)", async () => {
  const { app } = createHostApp({
    logger: {},
    gate: { config: DISABLED },
  });
  const lanApi = await app.request("http://192.168.1.50/v1/capabilities", {
    headers: { host: "192.168.1.50" },
  });
  assert.equal(lanApi.status, 403);
  const body = await lanApi.json();
  assert.equal(body.code, "AUTH_REQUIRED_FOR_LAN");

  const lanPage = await app.request("http://192.168.1.50/", {
    headers: { host: "192.168.1.50", accept: "text/html" },
  });
  assert.equal(lanPage.status, 302);
  assert.ok((lanPage.headers.get("location") ?? "").startsWith("/login"));

  // Local host with disabled gate stays open.
  const local = await app.request("http://localhost/v1/capabilities", {
    headers: { host: "localhost" },
  });
  assert.equal(local.status, 200);
});

test("LAN exposure cannot be downgraded with a spoofed loopback Host", async () => {
  const { app } = createHostApp({
    logger: {},
    exposureMode: "lan",
    gate: { config: DISABLED },
  });
  for (const host of ["localhost", "127.0.0.1"]) {
    const api = await app.request("http://localhost/v1/capabilities", {
      headers: { host },
    });
    assert.equal(api.status, 403, host);
    assert.equal((await api.json()).code, "AUTH_REQUIRED_FOR_LAN");
  }
});

test("gate status is consistent for disabled, unconfigured, and error states", async () => {
  const cases = [
    { config: DISABLED, exposureMode: "local", status: "disabled", required: false },
    { config: DISABLED, exposureMode: "lan", status: "disabled", required: true },
    { config: UNCONFIGURED, exposureMode: "local", status: "unconfigured", required: false },
    { config: UNCONFIGURED, exposureMode: "lan", status: "unconfigured", required: true },
    { config: ERROR_CONFIG, exposureMode: "local", status: "error", required: false },
    { config: ERROR_CONFIG, exposureMode: "lan", status: "error", required: true },
  ];
  for (const item of cases) {
    const { app } = createHostApp({
      logger: {},
      exposureMode: item.exposureMode,
      gate: { config: item.config },
    });
    const res = await app.request("http://localhost/v1/gate/status", {
      headers: { host: "localhost" },
    });
    const body = await res.json();
    assert.equal(body.status, item.status);
    assert.equal(body.required, item.required);
    assert.equal(body.authenticated, false);
  }
});

test("unconfigured gate blocks APIs with 503 and redirects pages", async () => {
  const { app } = createHostApp({
    logger: {},
    gate: { config: UNCONFIGURED },
  });
  const api = await app.request("http://localhost/v1/capabilities", { headers: { host: "localhost" } });
  assert.equal(api.status, 503);
  assert.equal((await api.json()).code, "AUTH_NOT_CONFIGURED");

  const page = await app.request("http://localhost/x", {
    headers: { host: "localhost", accept: "text/html" },
  });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get("location"), "/login");
});

test("authenticated users on /login are redirected to sanitized next", async () => {
  const { app } = enabledApp();
  const login = await app.request("http://localhost/v1/gate/login", {
    method: "POST",
    headers: {
      host: "localhost",
      "content-type": "application/json",
      "x-forwarded-for": "127.0.0.1",
    },
    body: JSON.stringify({ password: "secret", next: "/safe/path" }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  const res = await app.request("http://localhost/login?next=/safe/path", {
    headers: { host: "localhost", cookie, accept: "text/html" },
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/safe/path");
});

test("unsafe next paths are sanitized to /", async () => {
  const { app } = enabledApp();
  for (const next of ["//evil.com", "/\\evil", "/%2f%2fevil.com", "/login", "https://evil.com"]) {
    const res = await app.request("http://localhost/v1/gate/login", {
      method: "POST",
      headers: {
        host: "localhost",
        "content-type": "application/json",
        "x-forwarded-for": "127.0.0.1",
      },
      body: JSON.stringify({ password: "secret", next }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).next, "/", `next ${JSON.stringify(next)} must sanitize to /`);
  }
});

test("tampered session cookie is rejected (signature check)", async () => {
  const { app } = enabledApp();
  const login = await app.request("http://localhost/v1/gate/login", {
    method: "POST",
    headers: {
      host: "localhost",
      "content-type": "application/json",
      "x-forwarded-for": "127.0.0.1",
    },
    body: JSON.stringify({ password: "secret" }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const tampered = cookie.replace(/[\w-]{8}$/, "AAAAAAAA");

  const res = await app.request("http://localhost/v1/capabilities", {
    headers: { host: "localhost", cookie: tampered },
  });
  assert.equal(res.status, 401);
});

// ── PUT /v1/gate/password (access key change) ───────────────────────────────

function passwordApp({ status = "enabled", password = "secret", written = [], envManaged = false, storeError = null } = {}) {
  const mutable = { status, password };
  const config = {
    read: () => (mutable.status === "enabled"
      ? { status: "enabled", password: mutable.password, source: "test" }
      : { status: mutable.status, source: "test" }),
  };
  return createHostApp({
    logger: {},
    gate: {
      config,
      envPasswordManaged: () => envManaged,
      rateLimiter: { retryAfterSeconds: () => 0, recordFailure() {}, clear() {} },
      passwordStore: {
        write(newPassword) {
          if (storeError) throw storeError;
          written.push(newPassword);
          mutable.password = newPassword;
          mutable.status = "enabled";
        },
      },
    },
  }).app;
}

async function loginCookie(app, password) {
  const login = await app.request("http://localhost/v1/gate/login", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json", "x-forwarded-for": "127.0.0.1" },
    body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200);
  return (login.headers.get("set-cookie") ?? "").split(";")[0];
}

test("change access key: verifies current key, persists, re-issues cookie, kills old sessions", async () => {
  const written = [];
  const app = passwordApp({ written });
  const oldCookie = await loginCookie(app, "secret");

  const res = await app.request("http://localhost/v1/gate/password", {
    method: "PUT",
    headers: { host: "localhost", "content-type": "application/json", cookie: oldCookie, "x-forwarded-for": "127.0.0.1" },
    body: JSON.stringify({ currentPassword: "secret", newPassword: "new-key-1" }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(written, ["new-key-1"]);
  assert.match(res.headers.get("set-cookie") ?? "", /pix_session=/);
  const newCookie = (res.headers.get("set-cookie") ?? "").split(";")[0];

  // The old cookie is dead (its token is derived from the old key)…
  const oldSession = await app.request("http://localhost/v1/capabilities", {
    headers: { host: "localhost", cookie: oldCookie },
  });
  assert.equal(oldSession.status, 401);
  // …while the re-issued cookie keeps this browser authenticated.
  const newSession = await app.request("http://localhost/v1/capabilities", {
    headers: { host: "localhost", cookie: newCookie },
  });
  assert.equal(newSession.status, 200);
  // Login now requires the NEW key.
  const wrongLogin = await app.request("http://localhost/v1/gate/login", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json", "x-forwarded-for": "127.0.0.1" },
    body: JSON.stringify({ password: "secret" }),
  });
  assert.equal(wrongLogin.status, 401);
  const rightLogin = await app.request("http://localhost/v1/gate/login", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json", "x-forwarded-for": "127.0.0.1" },
    body: JSON.stringify({ password: "new-key-1" }),
  });
  assert.equal(rightLogin.status, 200);
});

test("change access key rejects a wrong current password and never writes", async () => {
  const written = [];
  const app = passwordApp({ written });
  const cookie = await loginCookie(app, "secret");
  const res = await app.request("http://localhost/v1/gate/password", {
    method: "PUT",
    headers: { host: "localhost", "content-type": "application/json", cookie, "x-forwarded-for": "127.0.0.1" },
    body: JSON.stringify({ currentPassword: "wrong", newPassword: "new-key-2" }),
  });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, "INVALID_PASSWORD");
  assert.deepEqual(written, []);
});

test("change access key requires an authenticated session once a key exists", async () => {
  const written = [];
  const app = passwordApp({ written });
  const res = await app.request("http://localhost/v1/gate/password", {
    method: "PUT",
    headers: { host: "localhost", "content-type": "application/json", "x-forwarded-for": "127.0.0.1" },
    body: JSON.stringify({ currentPassword: "secret", newPassword: "new-key-3" }),
  });
  assert.equal(res.status, 401);
  assert.deepEqual(written, []);
});

test("change access key fails closed when the key is env-managed, disabled, or the store errors", async () => {
  const envManaged = passwordApp({ envManaged: true });
  const envCookie = await loginCookie(envManaged, "secret");
  const envRes = await envManaged.request("http://localhost/v1/gate/password", {
    method: "PUT",
    headers: { host: "localhost", "content-type": "application/json", cookie: envCookie, "x-forwarded-for": "127.0.0.1" },
    body: JSON.stringify({ currentPassword: "secret", newPassword: "n" }),
  });
  assert.equal(envRes.status, 409);
  assert.equal((await envRes.json()).code, "PASSWORD_ENV_MANAGED");

  const disabled = passwordApp({ status: "disabled" });
  const disRes = await disabled.request("http://localhost/v1/gate/password", {
    method: "PUT",
    headers: { host: "localhost", "content-type": "application/json", "x-forwarded-for": "127.0.0.1" },
    body: JSON.stringify({ newPassword: "n" }),
  });
  assert.equal(disRes.status, 409);
  assert.equal((await disRes.json()).code, "AUTH_DISABLED");

  const failing = passwordApp({ storeError: new Error("disk full") });
  const failCookie = await loginCookie(failing, "secret");
  const failRes = await failing.request("http://localhost/v1/gate/password", {
    method: "PUT",
    headers: { host: "localhost", "content-type": "application/json", cookie: failCookie, "x-forwarded-for": "127.0.0.1" },
    body: JSON.stringify({ currentPassword: "secret", newPassword: "new-key-4" }),
  });
  assert.equal(failRes.status, 500);
  assert.equal((await failRes.json()).code, "PASSWORD_WRITE_FAILED");
});

test("an unconfigured host fails closed: the initial key must come from pix.json/env", async () => {
  const written = [];
  const app = passwordApp({ status: "unconfigured", written });
  const res = await app.request("http://localhost/v1/gate/password", {
    method: "PUT",
    headers: { host: "localhost", "content-type": "application/json", "x-forwarded-for": "127.0.0.1" },
    body: JSON.stringify({ newPassword: "first-key" }),
  });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, "AUTH_NOT_CONFIGURED");
  assert.deepEqual(written, []);
});

test("change access key validates the request body", async () => {
  const app = passwordApp({});
  const cookie = await loginCookie(app, "secret");
  for (const body of [{ currentPassword: "secret" }, { currentPassword: "secret", newPassword: "" }, { currentPassword: "secret", newPassword: 42 }, { currentPassword: 7, newPassword: "x".repeat(10) }, { currentPassword: "secret", newPassword: "x".repeat(129) }]) {
    const res = await app.request("http://localhost/v1/gate/password", {
      method: "PUT",
      headers: { host: "localhost", "content-type": "application/json", cookie, "x-forwarded-for": "127.0.0.1" },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  const notJson = await app.request("http://localhost/v1/gate/password", {
    method: "PUT",
    headers: { host: "localhost", "content-type": "text/plain", cookie },
    body: "{}",
  });
  assert.equal(notJson.status, 415);
});

test("writeGatePassword persists into pix.json preserving other fields; readGateConfig picks it up", async () => {
  const { mkdtempSync, writeFileSync, readFileSync, symlinkSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { writeGatePassword, readGateConfig, GatePasswordWriteError } = await import("../dist/gate/config.js");
  const dir = mkdtempSync(join(tmpdir(), "pix-gate-pw-"));
  const configPath = join(dir, "pix.json");
  try {
    writeFileSync(configPath, JSON.stringify({ models: { defaultModel: "x" }, auth: { password: "old", note: 1 }, other: true }, null, 2));
    writeGatePassword({ password: "brand-new", configPath, env: {} });
    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(saved.auth.password, "brand-new");
    assert.equal(saved.auth.note, 1);
    assert.equal(saved.models.defaultModel, "x");
    assert.equal(saved.other, true);
    const config = readGateConfig({ configPath, env: {} });
    assert.equal(config.status, "enabled");
    assert.equal(config.password, "brand-new");

    // Missing file: a fresh document is created with just auth.password.
    const freshPath = join(dir, "fresh.json");
    writeGatePassword({ password: "solo", configPath: freshPath, env: {} });
    assert.equal(readGateConfig({ configPath: freshPath, env: {} }).password, "solo");

    // Invalid password payloads are rejected before any write.
    assert.throws(() => writeGatePassword({ password: "", configPath, env: {} }), GatePasswordWriteError);
    assert.throws(() => writeGatePassword({ password: "x".repeat(129), configPath, env: {} }), GatePasswordWriteError);

    // A symlinked config path is refused.
    const target = join(dir, "real.json");
    writeFileSync(target, "{}");
    const link = join(dir, "link.json");
    symlinkSync(target, link);
    assert.throws(() => writeGatePassword({ password: "z", configPath: link, env: {} }), (error) => error instanceof GatePasswordWriteError && error.code === "UNSAFE_CONFIG_PATH");

    // A corrupted document fails closed without being overwritten.
    const corrupt = join(dir, "corrupt.json");
    writeFileSync(corrupt, "{not json");
    assert.throws(() => writeGatePassword({ password: "z", configPath: corrupt, env: {} }), GatePasswordWriteError);
    assert.equal(readFileSync(corrupt, "utf8"), "{not json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
