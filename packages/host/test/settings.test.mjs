import assert from "node:assert/strict";
import test from "node:test";
import { createHostApp, HttpError } from "../dist/index.js";

const DISABLED_GATE = { read: () => ({ status: "disabled", source: "test" }) };

/** A fake narrow SessionSettingsClient implementing the protocol-independent port. */
function fakeSettingsClient(impl) {
  return {
    async getIdleTimeoutMs() {
      return impl.getIdleTimeoutMs();
    },
    async setIdleTimeoutMs(idleTimeoutMs) {
      return impl.setIdleTimeoutMs(idleTimeoutMs);
    },
  };
}

/** A fake MutationGuard (mirrors the production SessiondWorktreeSafetyAdapter). */
function fakeGuard(impl) {
  return { async assertAvailable() { return impl.assertAvailable(); } };
}

const SESSIONS_CLIENT = {
  async list() { return { sessions: [] }; },
  async read() { return { sessionId: "s1", cwd: "/proj", projectRoot: "/proj", entries: [] }; },
  async context() { return { sessionId: "s1", entries: [], pageInfo: { hasMore: false } }; },
};

function appWith(client, guard, extra = {}) {
  return createHostApp({
    logger: {},
    gate: { config: DISABLED_GATE },
    sessions: {
      client: SESSIONS_CLIENT,
      settings: { client, mutationGuard: guard },
    },
    ...extra,
  }).app;
}

const get = (app, path) => app.request(`http://localhost${path}`, { headers: { host: "localhost" } });

const put = (app, path, body, init = {}) =>
  app.request(`http://localhost${path}`, {
    method: "PUT",
    headers: { host: "localhost", "content-type": "application/json", ...(init.headers ?? {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("GET /v1/settings/session-idle-timeout returns the current idle timeout", async () => {
  const calls = [];
  const app = appWith(
    fakeSettingsClient({
      async getIdleTimeoutMs() { calls.push("get"); return { idleTimeoutMs: 86_400_000 }; },
      async setIdleTimeoutMs() { throw new Error("must not be called"); },
    }),
    fakeGuard({ async assertAvailable() {} }),
  );
  const res = await get(app, "/v1/settings/session-idle-timeout");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { idleTimeoutMs: 86_400_000 });
  assert.deepEqual(calls, ["get"]);
});

test("GET route is NOT mounted without the settings seam (404)", async () => {
  const app = createHostApp({
    logger: {},
    gate: { config: DISABLED_GATE },
    sessions: { client: SESSIONS_CLIENT },
  }).app;
  const res = await get(app, "/v1/settings/session-idle-timeout");
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, "NOT_FOUND");
});

test("PUT /v1/settings/session-idle-timeout persists the timeout and returns it", async () => {
  const calls = [];
  const app = appWith(
    fakeSettingsClient({
      async getIdleTimeoutMs() { throw new Error("must not be called"); },
      async setIdleTimeoutMs(ms) { calls.push(ms); return { idleTimeoutMs: ms }; },
    }),
    fakeGuard({ async assertAvailable() {} }),
  );
  const res = await put(app, "/v1/settings/session-idle-timeout", { idleTimeoutMs: 3_600_000 });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { idleTimeoutMs: 3_600_000 });
  assert.deepEqual(calls, [3_600_000]);
});

test("PUT: mutation guard runs BEFORE the settings RPC", async () => {
  let guardCalled = 0;
  let setCalled = 0;
  const app = appWith(
    fakeSettingsClient({
      async getIdleTimeoutMs() { throw new Error("must not be called"); },
      async setIdleTimeoutMs(ms) { setCalled += 1; return { idleTimeoutMs: ms }; },
    }),
    fakeGuard({ async assertAvailable() { guardCalled += 1; } }),
  );
  const res = await put(app, "/v1/settings/session-idle-timeout", { idleTimeoutMs: 0 });
  assert.equal(res.status, 200);
  assert.equal(guardCalled, 1, "mutation guard must run once");
  assert.equal(setCalled, 1, "settings RPC must run once");
});

test("PUT: sessiond down ⇒ 503 from the guard BEFORE the settings RPC (no effect)", async () => {
  let setCalled = 0;
  const app = appWith(
    fakeSettingsClient({
      async getIdleTimeoutMs() { throw new Error("must not be called"); },
      async setIdleTimeoutMs(ms) { setCalled += 1; return { idleTimeoutMs: ms }; },
    }),
    fakeGuard({
      async assertAvailable() {
        throw new HttpError(503, "MUTATION_UNAVAILABLE", "Runtime authority unavailable");
      },
    }),
  );
  const res = await put(app, "/v1/settings/session-idle-timeout", { idleTimeoutMs: 3_600_000 });
  assert.equal(res.status, 503);
  assert.equal(setCalled, 0, "settings RPC must never run while the authority is down");
  const body = await res.json();
  assert.ok(!JSON.stringify(body).includes("ECONNREFUSED"), "raw guard failure must not leak");
});

test("PUT: malformed body ⇒ 400 INVALID_IDLE_TIMEOUT (unknown field / coercion rejected)", async () => {
  const app = appWith(
    fakeSettingsClient({
      async getIdleTimeoutMs() { throw new Error("must not be called"); },
      async setIdleTimeoutMs() { throw new Error("must not be called"); },
    }),
    fakeGuard({ async assertAvailable() {} }),
  );
  for (const body of [
    { idleTimeoutMs: 1.5 },
    { idleTimeoutMs: -1 },
    { idleTimeoutMs: "3600000" },
    { idleTimeoutMs: 3_600_000, extra: true },
    { other: 1 },
    {},
  ]) {
    const res = await put(app, "/v1/settings/session-idle-timeout", body);
    assert.equal(res.status, 400, `body ${JSON.stringify(body)} must be 400`);
    assert.equal((await res.json()).code, "INVALID_IDLE_TIMEOUT");
  }
});

test("PUT: non-JSON body ⇒ 415 (unsupported media type)", async () => {
  const app = appWith(
    fakeSettingsClient({
      async getIdleTimeoutMs() { throw new Error("must not be called"); },
      async setIdleTimeoutMs() { throw new Error("must not be called"); },
    }),
    fakeGuard({ async assertAvailable() {} }),
  );
  const res = await put(app, "/v1/settings/session-idle-timeout", "not-json", {
    headers: { "content-type": "text/plain" },
  });
  assert.equal(res.status, 415);
});

test("GET/PUT: sessiond settings RPC failure ⇒ 503 SETTINGS_UNAVAILABLE, sanitized", async () => {
  const app = appWith(
    fakeSettingsClient({
      async getIdleTimeoutMs() { throw { code: "unavailable", message: "secret-endpoint-down", retryable: true }; },
      async setIdleTimeoutMs() { throw { code: "unavailable", message: "secret-endpoint-down", retryable: true }; },
    }),
    fakeGuard({ async assertAvailable() {} }),
  );
  const resGet = await get(app, "/v1/settings/session-idle-timeout");
  assert.equal(resGet.status, 503);
  assert.equal((await resGet.json()).code, "SETTINGS_UNAVAILABLE");
  const resPut = await put(app, "/v1/settings/session-idle-timeout", { idleTimeoutMs: 3_600_000 });
  assert.equal(resPut.status, 503);
  const putBody = await resPut.json();
  assert.ok(!JSON.stringify(putBody).includes("secret-endpoint-down"), "raw RPC message must not leak");
});
