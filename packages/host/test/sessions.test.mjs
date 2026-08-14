import assert from "node:assert/strict";
import test from "node:test";
import {
  createHostApp,
  HttpError,
  SESSIONS_MAX_LIMIT,
  SESSIONS_MAX_OFFSET,
} from "../dist/index.js";

const DISABLED_GATE = { read: () => ({ status: "disabled", source: "test" }) };

// --- protocol-shaped fixtures (already schema-valid) -----------------------

function header(over = {}) {
  return {
    sessionId: "s1",
    cwd: "/proj",
    projectRoot: "/proj",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    ...over,
  };
}

const ENTRY = {
  entryId: "e1",
  message: { role: "user", content: "hello" },
};

/** A fake narrow SessionHistoryReadClient implementing the protocol-independent port. */
function fakeClient(impl) {
  return {
    async list(params) {
      return impl.list(params);
    },
    async read(id) {
      return impl.read(id);
    },
    async context(id, leafId) {
      return impl.context(id, leafId);
    },
  };
}

function appWith(client, extra = {}) {
  return createHostApp({
    logger: {},
    gate: { config: DISABLED_GATE },
    sessions: { client },
    ...extra,
  }).app;
}

const call = (app, path) => app.request(`http://localhost${path}`, { headers: { host: "localhost" } });

// ---------------------------------------------------------------------------
// happy path: list / detail / context
// ---------------------------------------------------------------------------

test("GET /v1/sessions returns the session list", async () => {
  const app = appWith(
    fakeClient({
      async list() {
        return { sessions: [header({ sessionId: "a" }), header({ sessionId: "b" })] };
      },
      async read() {
        return { ...header(), entries: [ENTRY] };
      },
      async context() {
        return { sessionId: "s1", leafId: "e1", entries: [ENTRY] };
      },
    }),
  );
  const res = await call(app, "/v1/sessions");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.sessions.map((s) => s.sessionId), ["a", "b"]);
  assert.equal(body.sessions[0].cwd, "/proj");
});

test("GET /v1/sessions forwards cwd/limit/offset params to the client (bounded)", async () => {
  let captured;
  const app = appWith(
    fakeClient({
      async list(params) {
        captured = params;
        return { sessions: [] };
      },
      async read() {
        return { ...header() };
      },
      async context() {
        return { sessionId: "s1", entries: [] };
      },
    }),
  );
  const res = await call(app, "/v1/sessions?cwd=/p&limit=5&offset=10");
  assert.equal(res.status, 200);
  assert.deepEqual(captured, { cwd: "/p", limit: 5, offset: 10 });
});

test("empty cwd is treated as no filter", async () => {
  let captured;
  const app = appWith(
    fakeClient({
      async list(params) {
        captured = params;
        return { sessions: [] };
      },
      async read() {
        return { ...header() };
      },
      async context() {
        return { sessionId: "s1", entries: [] };
      },
    }),
  );
  await call(app, "/v1/sessions?cwd=&limit=&offset=");
  assert.deepEqual(captured, {});
});

test("GET /v1/sessions/:id returns session detail", async () => {
  const app = appWith(
    fakeClient({
      async list() {
        return { sessions: [] };
      },
      async read(id) {
        return { ...header({ sessionId: id }), entries: [ENTRY] };
      },
      async context() {
        return { sessionId: "s1", entries: [] };
      },
    }),
  );
  const res = await call(app, "/v1/sessions/s1");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.session.sessionId, "s1");
  assert.equal(body.session.entries[0].entryId, "e1");
});

test("GET /v1/sessions/:id/context returns context and forwards leafId", async () => {
  let capturedLeaf;
  const app = appWith(
    fakeClient({
      async list() {
        return { sessions: [] };
      },
      async read() {
        return { ...header() };
      },
      async context(id, leafId) {
        capturedLeaf = leafId;
        return { sessionId: id, leafId: leafId ?? "e1", entries: [ENTRY] };
      },
    }),
  );
  const res = await call(app, "/v1/sessions/s1/context?leafId=e9");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.context.sessionId, "s1");
  assert.equal(body.context.leafId, "e9");
  assert.equal(capturedLeaf, "e9");
  assert.equal(body.context.entries[0].entryId, "e1");
});

test("context without leafId omits the leafId query", async () => {
  let capturedLeaf;
  const app = appWith(
    fakeClient({
      async list() {
        return { sessions: [] };
      },
      async read() {
        return { ...header() };
      },
      async context(id, leafId) {
        capturedLeaf = leafId;
        return { sessionId: id, entries: [] };
      },
    }),
  );
  await call(app, "/v1/sessions/s1/context");
  assert.equal(capturedLeaf, undefined);
});

// ---------------------------------------------------------------------------
// error mapping: 404 / 503 / sanitized
// ---------------------------------------------------------------------------

function failingClient(error) {
  return fakeClient({
    async list() {
      throw error;
    },
    async read() {
      throw error;
    },
    async context() {
      throw error;
    },
  });
}

test("not_found maps to 404 SESSION_NOT_FOUND", async () => {
  const app = appWith(failingClient({ code: "not_found", message: "session not found: secret-id", retryable: false }));
  const res = await call(app, "/v1/sessions/missing");
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.code, "SESSION_NOT_FOUND");
  // sanitized: never echoes the underlying id
  assert.ok(!body.message.includes("secret-id"));
});

test("unavailable maps to 503 SESSIONS_UNAVAILABLE", async () => {
  const app = appWith(failingClient({ code: "unavailable", message: "sessiond unreachable", retryable: true }));
  const list = await call(app, "/v1/sessions");
  assert.equal(list.status, 503);
  assert.equal((await list.json()).code, "SESSIONS_UNAVAILABLE");
});

test("timeout maps to 503", async () => {
  const app = appWith(failingClient({ code: "timeout", message: "rpc timed out", retryable: true }));
  const res = await call(app, "/v1/sessions/s1/context");
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, "SESSIONS_UNAVAILABLE");
});

test("connection refused (raw socket error code) maps to 503", async () => {
  const err = new Error("connect ECONNREFUSED");
  err.code = "ECONNREFUSED";
  const app = appWith(failingClient(err));
  const res = await call(app, "/v1/sessions");
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.code, "SESSIONS_UNAVAILABLE");
  assert.ok(!body.message.includes("ECONNREFUSED"));
});

test("unknown error is sanitized to 503 with a fixed message", async () => {
  const app = appWith(failingClient(new Error("boom with stack trace")));
  const res = await call(app, "/v1/sessions/s1");
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.code, "SESSIONS_UNAVAILABLE");
  assert.ok(!body.message.includes("boom"));
  assert.ok(!JSON.stringify(body).includes("stack"));
});

// ---------------------------------------------------------------------------
// strict query bounds
// ---------------------------------------------------------------------------

test("limit out of range → 400", async () => {
  const app = appWith(
    fakeClient({
      async list() {
        return { sessions: [] };
      },
      async read() {
        return { ...header() };
      },
      async context() {
        return { sessionId: "s1", entries: [] };
      },
    }),
  );
  const tooBig = await call(app, `/v1/sessions?limit=${SESSIONS_MAX_LIMIT + 1}`);
  assert.equal(tooBig.status, 400);
  const zero = await call(app, "/v1/sessions?limit=0");
  assert.equal(zero.status, 400);
  const nonInt = await call(app, "/v1/sessions?limit=1.5");
  assert.equal(nonInt.status, 400);
});

test("offset out of range / negative → 400", async () => {
  const app = appWith(
    fakeClient({
      async list() {
        return { sessions: [] };
      },
      async read() {
        return { ...header() };
      },
      async context() {
        return { sessionId: "s1", entries: [] };
      },
    }),
  );
  const neg = await call(app, "/v1/sessions?offset=-1");
  assert.equal(neg.status, 400);
  const tooBig = await call(app, `/v1/sessions?offset=${SESSIONS_MAX_OFFSET + 1}`);
  assert.equal(tooBig.status, 400);
  // max offset is accepted
  const ok = await call(app, `/v1/sessions?offset=${SESSIONS_MAX_OFFSET}`);
  assert.equal(ok.status, 200);
});

test("non-canonical integer forms are rejected (1e3 / 0x10 / sign / decimal / whitespace / leading zero)", async () => {
  let captured;
  const app = appWith(
    fakeClient({
      async list(params) {
        captured = params;
        return { sessions: [] };
      },
      async read() {
        return { ...header() };
      },
      async context() {
        return { sessionId: "s1", entries: [] };
      },
    }),
  );
  // Each of these is rejected as 400 (no coercion to a valid integer).
  for (const value of ["1e3", "0x10", "+5", "-1", "1.5", " 5 ", "5 ", " 5", "007", "01"]) {
    const res = await call(app, `/v1/sessions?limit=${encodeURIComponent(value)}`);
    assert.equal(res.status, 400, `expected 400 for limit=${value}`);
    assert.equal((await res.json()).code, "INVALID_QUERY");
  }
  // Empty string remains "absent" (documented empty-as-absent behavior).
  const empty = await call(app, "/v1/sessions?limit=");
  assert.equal(empty.status, 200);
  assert.deepEqual(captured, {});
  // Canonical unsigned decimal strings are still accepted (incl. single 0 for offset).
  const okLimit = await call(app, "/v1/sessions?limit=10");
  assert.equal(okLimit.status, 200);
  const okOffset = await call(app, "/v1/sessions?offset=0");
  assert.equal(okOffset.status, 200);
});

test("sessions routes are not mounted when deps.sessions is absent", async () => {
  const app = createHostApp({ logger: {}, gate: { config: DISABLED_GATE } }).app;
  const res = await call(app, "/v1/sessions");
  // SPA fallback returns 200 with HTML for a browser, but JSON 404 for an API path.
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, "NOT_FOUND");
});

// ---------------------------------------------------------------------------
// D4 session-history delete: DELETE /v1/sessions/:id
// ---------------------------------------------------------------------------

/** Fake sessiond mutation guard: optional assertAvailable override. */
function fakeGuard(impl) {
  return { async assertAvailable() { return impl?.assertAvailable?.(); } };
}

/** Fake SessionDeleteClient recording calls. */
function fakeDeleteClient(impl) {
  const calls = [];
  return {
    calls,
    client: {
      async delete(id) {
        calls.push(id);
        return impl?.delete?.(id) ?? { sessionId: id, deleted: true };
      },
    },
  };
}

function appWithDelete({ deleteImpl, guardImpl } = {}) {
  const dc = fakeDeleteClient(deleteImpl);
  const app = createHostApp({
    logger: {},
    gate: { config: DISABLED_GATE },
    sessions: {
      client: fakeClient({
        async list() { return { sessions: [] }; },
        async read() { return { ...header() }; },
        async context() { return { sessionId: "s1", entries: [] }; },
      }),
      delete: { client: dc.client, mutationGuard: fakeGuard(guardImpl) },
    },
  }).app;
  return { app, dc };
}

const del = (app, id, init = {}) =>
  app.request(`http://localhost/v1/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { host: "localhost", ...(init.headers ?? {}) },
    ...(init.body === undefined ? {} : { body: init.body }),
  });

test("DELETE /v1/sessions/:id succeeds with strict {success:true} and calls the delete client exactly once", async () => {
  const { app, dc } = appWithDelete();
  const res = await del(app, "s-1");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { success: true });
  assert.deepEqual(dc.calls, ["s-1"]);
});

test("DELETE route is NOT mounted without the mutation seam (no delete → 404)", async () => {
  const app = createHostApp({
    logger: {},
    gate: { config: DISABLED_GATE },
    sessions: { client: fakeClient({ async list() { return { sessions: [] }; }, async read() { return { ...header() }; }, async context() { return { sessionId: "s1", entries: [] }; } }) },
  }).app;
  const res = await del(app, "s-1");
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, "NOT_FOUND");
});

test("DELETE: production mutation guard runs BEFORE the delete RPC", async () => {
  let guardCalled = 0;
  const { app, dc } = appWithDelete({
    guardImpl: { async assertAvailable() { guardCalled += 1; } },
  });
  const res = await del(app, "s-1");
  assert.equal(res.status, 200);
  assert.equal(guardCalled, 1, "mutation guard must run once");
  assert.deepEqual(dc.calls, ["s-1"]);
});

test("DELETE: sessiond down ⇒ 503 from the guard BEFORE the delete RPC (no catalog effect)", async () => {
  const { app, dc } = appWithDelete({
    guardImpl: {
      async assertAvailable() {
        // Mirrors the production SessiondWorktreeSafetyAdapter: a ping failure
        // is a fixed 503 HttpError, never a raw socket error.
        throw new HttpError(503, "MUTATION_UNAVAILABLE", "Runtime authority unavailable");
      },
    },
  });
  const res = await del(app, "s-1");
  assert.equal(res.status, 503);
  assert.deepEqual(dc.calls, [], "delete RPC must never run while the authority is down");
  const body = await res.json();
  assert.ok(!JSON.stringify(body).includes("ECONNREFUSED"), "raw guard failure must not leak");
});

test("DELETE: not_found ⇒ 404 SESSION_NOT_FOUND, sanitized (no id echo)", async () => {
  const { app } = appWithDelete({
    deleteImpl: { async delete(id) { throw { code: "not_found", message: `session not found: ${id}`, retryable: false }; } },
  });
  const res = await del(app, "secret-delete-id");
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.code, "SESSION_NOT_FOUND");
  assert.ok(!JSON.stringify(body).includes("secret-delete-id"));
});

test("DELETE: live/busy ⇒ 409 SESSION_IN_USE for session_busy AND conflict", async () => {
  for (const code of ["session_busy", "conflict"]) {
    const { app } = appWithDelete({
      deleteImpl: { async delete() { throw { code, message: "session is running", retryable: false }; } },
    });
    const res = await del(app, "live-1");
    assert.equal(res.status, 409, `code ${code} must map to 409`);
    const body = await res.json();
    assert.equal(body.code, "SESSION_IN_USE");
    assert.equal(body.message, "Session is currently in use");
  }
});

test("DELETE: unavailable/timeout/unknown ⇒ 503 with a fixed sanitized message (no leak)", async () => {
  for (const code of ["unavailable", "timeout", "worker_unavailable", "internal"]) {
    const { app } = appWithDelete({
      deleteImpl: { async delete() { throw { code, message: "leak: /secret/endpoint and key", retryable: true }; } },
    });
    const res = await del(app, "s-1");
    assert.equal(res.status, 503, `code ${code} must map to 503`);
    const body = await res.json();
    assert.ok(!JSON.stringify(body).includes("leak"), `code ${code}: raw message must not leak`);
    assert.ok(!JSON.stringify(body).includes("secret"), `code ${code}: endpoint must not leak`);
  }
});

test("DELETE: an empty id segment never reaches the route (404, no RPC)", async () => {
  const { app, dc } = appWithDelete();
  const res = await del(app, "");
  assert.equal(res.status, 404, "an empty id segment does not match /v1/sessions/:id");
  assert.deepEqual(dc.calls, [], "no delete RPC for an empty id");
});

test("DELETE: a request body is rejected 400 (no force/body surface)", async () => {
  const { app, dc } = appWithDelete();
  const res = await del(app, "s-1", { body: JSON.stringify({ force: true }), headers: { "content-type": "application/json" } });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "REQUEST_BODY_NOT_ALLOWED");
  assert.deepEqual(dc.calls, [], "no delete RPC when a body is present");
});

test("DELETE rejects ANY query string (force/override/arbitrary/duplicates/encoded/bare) with fixed 400 and zero delete RPC", async () => {
  const { app, dc } = appWithDelete();
  for (const q of ["?force=true", "?override=1", "?foo=bar", "?a=1&a=2", "?%66orce=true", "?x=%2Fetc%2Fpasswd", "?"]) {
    const res = await app.request(`http://localhost/v1/sessions/s-1${q}`, {
      method: "DELETE",
      headers: { host: "localhost" },
    });
    assert.equal(res.status, 400, `query ${q} must be a strict 400`);
    assert.equal((await res.json()).code, "INVALID_QUERY", `query ${q} must report INVALID_QUERY`);
  }
  assert.deepEqual(dc.calls, [], "a query-rejected delete must never reach the delete RPC");
});

test("DELETE: LAN auth gate blocks BEFORE the mutation guard and the RPC", async () => {
  let guardCalled = 0;
  const dc = fakeDeleteClient();
  const app = createHostApp({
    logger: {},
    exposureMode: "lan",
    gate: { config: { read: () => ({ status: "enabled", password: "secret", source: "test" }) } },
    sessions: {
      client: fakeClient({ async list() { return { sessions: [] }; }, async read() { return { ...header() }; }, async context() { return { sessionId: "s1", entries: [] }; } }),
      delete: {
        client: dc.client,
        mutationGuard: fakeGuard({ async assertAvailable() { guardCalled += 1; } }),
      },
    },
  }).app;
  const res = await app.request("http://localhost/v1/sessions/live-1", {
    method: "DELETE",
    headers: { host: "localhost" },
  });
  assert.ok(res.status === 401 || res.status === 403, `LAN unauth delete must be rejected, got ${res.status}`);
  assert.equal(guardCalled, 0, "auth gate must run before the mutation guard");
  assert.deepEqual(dc.calls, [], "auth gate must run before the delete RPC");
});
