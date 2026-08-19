// D3B trust-mutation slice (POST /v1/trust) adversarial tests.
//
// Covers the full Host contract: seam-gated mount, gate-first auth, strict
// bounded body, no query surface, AllowedRoot canonicalization (escape /
// symlink / missing / file), fixed sanitized errors with no raw leak,
// sessiond independence, read-after-write strict state, immutable failures
// and honest `project.trust` capability advertisement.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import {
  createHostApp,
  createAllowedRootService,
  resolveCapabilities,
  CATALOG_CAPABILITIES,
} from "../dist/index.js";

const DISABLED_GATE = { read: () => ({ status: "disabled", source: "test" }) };
const ENABLED_GATE = { read: () => ({ status: "enabled", password: "pw", source: "test" }) };

const temporary = [];
function temp(prefix) {
  const value = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(value);
  return value;
}
test.afterEach(() => {
  while (temporary.length) rmSync(temporary.pop(), { recursive: true, force: true });
});

const call = (app, path, init) =>
  app.request(`http://localhost${path}`, { headers: { host: "localhost" }, ...init });

async function rootsFor(...dirs) {
  return createAllowedRootService({
    roots: dirs,
    allowLocalExpansion: false,
    allowLanExpansion: false,
  });
}

function post(app, path, body, extraHeaders = {}) {
  return call(app, path, {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json", ...extraHeaders },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Read seam + mutation seam test doubles with call recording. */
function fakeTrustSeams(impl = {}) {
  const calls = [];
  const state = { level: impl.initialLevel ?? "unknown" };
  const readSeam = {
    getProjectTrustState: async (cwd) => {
      calls.push(["getProjectTrustState", cwd]);
      return impl.getProjectTrustState ? impl.getProjectTrustState(cwd) : state.level;
    },
    isTrusted: async (cwd) => {
      calls.push(["isTrusted", cwd]);
      return impl.isTrusted ? impl.isTrusted(cwd) : state.level === "trusted";
    },
    canReloadResources: async (cwd) => {
      calls.push(["canReloadResources", cwd]);
      return impl.canReloadResources
        ? impl.canReloadResources(cwd)
        : { allowed: state.level === "trusted", level: state.level };
    },
  };
  const mutationSeam = {
    setTrusted: async (cwd) => {
      calls.push(["setTrusted", cwd]);
      if (impl.setTrusted) return impl.setTrusted(cwd);
      state.level = "trusted";
      return { cwd, level: "trusted" };
    },
  };
  return { readSeam, mutationSeam, calls, state };
}

function appWith(catalogs, extra = {}) {
  return createHostApp({
    logger: {},
    gate: { config: DISABLED_GATE },
    catalogs,
    ...extra,
  }).app;
}

// ---------------------------------------------------------------------------
// mount + happy path
// ---------------------------------------------------------------------------

test("POST /v1/trust records trusted and returns the strict post-write state", async () => {
  const root = temp("pix-trust-mut-");
  const alias = join(root, "alias");
  const real = join(root, "real");
  mkdirSync(real);
  symlinkSync(real, alias);
  const roots = await rootsFor(root);
  const { readSeam, mutationSeam, calls } = fakeTrustSeams();
  const app = appWith({ roots, trust: readSeam, trustMutation: mutationSeam });
  const res = await post(app, "/v1/trust", { cwd: alias, level: "trusted" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  const canonical = await realpath(alias);
  assert.deepEqual(body, {
    cwd: canonical,
    level: "trusted",
    trusted: true,
    canReloadResources: { allowed: true, level: "trusted" },
  });
  // Canonical cwd only; the read seam is consulted AFTER the mutation.
  assert.deepEqual(calls[0], ["setTrusted", canonical]);
  assert.ok(calls.slice(1).some(([method, cwd]) => method === "getProjectTrustState" && cwd === canonical));
});

test("POST /v1/trust is NOT mounted without the mutation seam", async () => {
  const root = temp("pix-trust-noseam-");
  const roots = await rootsFor(root);
  const { readSeam } = fakeTrustSeams();
  const app = appWith({ roots, trust: readSeam });
  const res = await post(app, "/v1/trust", { cwd: root, level: "trusted" });
  assert.equal(res.status, 404);
});

test("POST /v1/trust is NOT mounted without the trust read seam", async () => {
  const root = temp("pix-trust-noread-");
  const roots = await rootsFor(root);
  const { mutationSeam } = fakeTrustSeams();
  const app = appWith({ roots, trustMutation: mutationSeam });
  const res = await post(app, "/v1/trust", { cwd: root, level: "trusted" });
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// capability honesty
// ---------------------------------------------------------------------------

test("project.trust advertised only while the mutation seam is mounted (up and degraded)", async () => {
  const root = temp("pix-trust-cap-");
  const roots = await rootsFor(root);
  const { readSeam, mutationSeam } = fakeTrustSeams();

  const mounted = { roots, trust: readSeam, trustMutation: mutationSeam };
  for (const isAvailable of [async () => true, async () => false]) {
    const { capabilities } = await resolveCapabilities({
      catalogs: mounted,
      sessiond: { isAvailable },
    });
    assert.ok(capabilities.includes("project.trust"));
    assert.ok(CATALOG_CAPABILITIES.includes("project.trust"));
  }

  // Without the seam the token is never invented — even when an explicit
  // override tries to list it (normalizeCatalogCapabilities strips it).
  const unmounted = { roots, trust: readSeam };
  for (const isAvailable of [async () => true, async () => false]) {
    const { capabilities } = await resolveCapabilities({
      catalogs: unmounted,
      capabilities: { full: ["files", "project.trust"], readonly: ["files", "project.trust"] },
      sessiond: { isAvailable },
    });
    assert.ok(!capabilities.includes("project.trust"));
  }
});

// ---------------------------------------------------------------------------
// gate first (auth/LAN)
// ---------------------------------------------------------------------------

test("gate runs first: an unauthenticated POST never reaches the seam", async () => {
  const root = temp("pix-trust-gate-");
  const roots = await rootsFor(root);
  const { readSeam, mutationSeam, calls } = fakeTrustSeams();
  const app = appWith(
    { roots, trust: readSeam, trustMutation: mutationSeam },
    { gate: { config: ENABLED_GATE } },
  );
  const res = await post(app, "/v1/trust", { cwd: root, level: "trusted" });
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0, "seam must not be called before the gate authenticates");
});

test("LAN exposure is always gated even with auth disabled", async () => {
  const root = temp("pix-trust-lan-");
  const roots = await rootsFor(root);
  const { readSeam, mutationSeam, calls } = fakeTrustSeams();
  const app = appWith(
    { roots, trust: readSeam, trustMutation: mutationSeam },
    { exposureMode: "lan", gate: { config: DISABLED_GATE } },
  );
  const res = await post(app, "/v1/trust", { cwd: root, level: "trusted" });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "AUTH_REQUIRED_FOR_LAN");
  assert.equal(calls.length, 0, "unauthenticated LAN request must be rejected before the seam");
});

// ---------------------------------------------------------------------------
// sessiond independence
// ---------------------------------------------------------------------------

test("trust mutation works while sessiond is down (Host catalog capability)", async () => {
  const root = temp("pix-trust-sd-");
  const roots = await rootsFor(root);
  const { readSeam, mutationSeam } = fakeTrustSeams();
  const app = appWith(
    { roots, trust: readSeam, trustMutation: mutationSeam },
    { sessiond: { isAvailable: async () => false } },
  );
  const res = await post(app, "/v1/trust", { cwd: root, level: "trusted" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.trusted, true);
});

// ---------------------------------------------------------------------------
// strict body / query
// ---------------------------------------------------------------------------

test("POST /v1/trust rejects any query string with a fixed 400", async () => {
  const root = temp("pix-trust-query-");
  const roots = await rootsFor(root);
  const { readSeam, mutationSeam, calls } = fakeTrustSeams();
  const app = appWith({ roots, trust: readSeam, trustMutation: mutationSeam });
  const res = await post(app, `/v1/trust?cwd=${encodeURIComponent(root)}`, {
    cwd: root,
    level: "trusted",
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "INVALID_QUERY");
  assert.equal(calls.length, 0);
});

test("POST /v1/trust body is strict: extra/missing fields, levels, types", async () => {
  const root = temp("pix-trust-body-");
  const roots = await rootsFor(root);
  const { readSeam, mutationSeam, calls } = fakeTrustSeams();
  const app = appWith({ roots, trust: readSeam, trustMutation: mutationSeam });

  const cases = [
    [{}, "INVALID_TRUST_BODY"],
    [{ cwd: root }, "INVALID_TRUST_BODY"],
    [{ level: "trusted" }, "INVALID_TRUST_BODY"],
    [{ cwd: root, level: "trusted", extra: 1 }, "INVALID_TRUST_BODY"],
    [{ cwd: root, level: "denied" }, "UNSUPPORTED_TRUST_LEVEL"],
    [{ cwd: root, level: "unknown" }, "UNSUPPORTED_TRUST_LEVEL"],
    [{ cwd: root, level: true }, "UNSUPPORTED_TRUST_LEVEL"],
    [{ cwd: root, level: "TRUSTED" }, "UNSUPPORTED_TRUST_LEVEL"],
    [{ cwd: "", level: "trusted" }, "CWD_REQUIRED"],
    [{ cwd: 42, level: "trusted" }, "CWD_REQUIRED"],
    [{ cwd: null, level: "trusted" }, "CWD_REQUIRED"],
  ];
  for (const [body, code] of cases) {
    const res = await post(app, "/v1/trust", body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).code, code, JSON.stringify(body));
  }
  assert.equal(calls.length, 0, "no seam call for any rejected body");
});

test("POST /v1/trust requires application/json and bounded valid JSON", async () => {
  const root = temp("pix-trust-ct-");
  const roots = await rootsFor(root);
  const { readSeam, mutationSeam } = fakeTrustSeams();
  const app = appWith({ roots, trust: readSeam, trustMutation: mutationSeam });

  const wrongType = await call(app, "/v1/trust", {
    method: "POST",
    headers: { host: "localhost", "content-type": "text/plain" },
    body: JSON.stringify({ cwd: root, level: "trusted" }),
  });
  assert.equal(wrongType.status, 415);

  const malformed = await post(app, "/v1/trust", "{not json");
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).code, "INVALID_JSON");

  const array = await post(app, "/v1/trust", "[1]");
  assert.equal(array.status, 400);
  assert.equal((await array.json()).code, "INVALID_JSON");

  const oversized = await post(app, "/v1/trust", {
    cwd: root,
    level: "trusted",
    pad: "x".repeat(5 * 1024),
  });
  assert.equal(oversized.status, 413);

  const bounded = await call(app, "/v1/trust", {
    method: "POST",
    headers: {
      host: "localhost",
      "content-type": "application/json",
      "content-length": String(8 * 1024),
    },
    body: JSON.stringify({ cwd: root, level: "trusted" }),
  });
  assert.equal(bounded.status, 413);
});

// ---------------------------------------------------------------------------
// cwd authorization (AllowedRoot canonical)
// ---------------------------------------------------------------------------

test("POST /v1/trust rejects unauthorized cwd shapes before the seam", async () => {
  const root = temp("pix-trust-cwd-");
  const outside = temp("pix-trust-out-");
  const escape = join(root, "escape");
  symlinkSync(outside, escape);
  const fileTarget = join(root, "file.txt");
  writeFileSync(fileTarget, "x");
  const roots = await rootsFor(root);
  const { readSeam, mutationSeam, calls } = fakeTrustSeams();
  const app = appWith({ roots, trust: readSeam, trustMutation: mutationSeam });

  const cases = [
    [`/v1/trust`, { cwd: outside, level: "trusted" }, [403, 404]],
    [`/v1/trust`, { cwd: escape, level: "trusted" }, [403, 404]],
    [`/v1/trust`, { cwd: join(root, "missing"), level: "trusted" }, [404]],
    [`/v1/trust`, { cwd: fileTarget, level: "trusted" }, [400, 403, 404]],
    [`/v1/trust`, { cwd: "relative/path", level: "trusted" }, [400, 403, 404]],
    [`/v1/trust`, { cwd: `${root}/../${join("", "etc")}`, level: "trusted" }, [400, 403, 404]],
  ];
  for (const [path, body, allowedStatuses] of cases) {
    const res = await post(app, path, body);
    assert.ok(
      allowedStatuses.includes(res.status),
      `expected ${allowedStatuses} for ${body.cwd}, got ${res.status}`,
    );
  }
  assert.equal(calls.length, 0, "no seam call for any unauthorized cwd");
});

// ---------------------------------------------------------------------------
// sanitized failures + immutability + no raw leak
// ---------------------------------------------------------------------------

test("seam failures map to fixed sanitized errors and never leak raw text", async () => {
  const root = temp("pix-trust-fail-");
  const roots = await rootsFor(root);
  const rawLeak = new Error(`ENOENT: /secret/agent-dir/trust.json raw ${root}`);
  const cases = [
    [{ code: "TRUST_WRITE_FAILED", message: "Trust write failed" }, 500, "TRUST_MUTATION_FAILED"],
    [{ code: "TRUST_WRITE_UNVERIFIED", message: "Trust write could not be verified" }, 500, "TRUST_MUTATION_FAILED"],
    [{ code: "TRUST_INPUT_INVALID", message: "Trust mutation input is invalid" }, 400, "INVALID_TRUST_BODY"],
    [rawLeak, 500, "TRUST_MUTATION_FAILED"],
  ];
  for (const [error, status, code] of cases) {
    const { readSeam } = fakeTrustSeams();
    const mutationSeam = {
      setTrusted: async () => {
        throw error;
      },
    };
    const app = appWith({ roots, trust: readSeam, trustMutation: mutationSeam });
    const res = await post(app, "/v1/trust", { cwd: root, level: "trusted" });
    assert.equal(res.status, status, String(error));
    const body = await res.json();
    assert.equal(body.code, code);
    assert.equal(typeof body.message, "string");
    // No raw path / SDK text / cwd anywhere in the failure body.
    assert.ok(!JSON.stringify(body).includes(root), "cwd/path must not leak");
    assert.ok(!JSON.stringify(body).includes("ENOENT"), "raw fs text must not leak");
  }
});

test("a write the read surface cannot confirm is never a false success", async () => {
  const root = temp("pix-trust-stale-");
  const roots = await rootsFor(root);
  const { mutationSeam } = fakeTrustSeams();
  const readSeam = {
    getProjectTrustState: async () => "unknown",
    isTrusted: async () => false,
    canReloadResources: async () => ({ allowed: false, level: "unknown" }),
  };
  const app = appWith({ roots, trust: readSeam, trustMutation: mutationSeam });
  const res = await post(app, "/v1/trust", { cwd: root, level: "trusted" });
  assert.equal(res.status, 500);
  assert.equal((await res.json()).code, "TRUST_MUTATION_FAILED");
});
