import assert from "node:assert/strict";
import test from "node:test";
import {
  createHostApp,
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
