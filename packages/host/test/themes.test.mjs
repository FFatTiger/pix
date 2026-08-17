// Read-only theme catalog route tests (D3B-R6): strict query/name/mode
// validation, AllowedRoots cwd authorization, trust gating of project themes,
// fixed sanitized 400/404/503 errors (no path/raw content leaks), capability
// advertisement (mounted-only, degraded-safe) and gate/LAN auth ordering.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHostApp,
  createAllowedRootService,
  resolveCapabilities,
  CATALOG_CAPABILITIES,
  THEME_NAME_PATTERN,
  THEME_CSS_VAR_KEYS,
  isSafeThemeCssValue,
} from "../dist/index.js";
// Protocol is the host's real peer (a declared dependency) and is the wire
// projection the host must match; the runtime-contract-tests seam pins the
// protocol projection to the canonical runtime-core vocabulary.
import {
  THEME_CSS_VAR_KEYS as PROTOCOL_THEME_CSS_VAR_KEYS,
  ThemeCssValueSchema,
} from "@fffattiger/pix-protocol";

const DISABLED_GATE = { read: () => ({ status: "disabled", source: "test" }) };
const temporary = [];
function temp(prefix) {
  // macOS keeps /var as a symlink to /private/var; AllowedRoots canonicalizes
  // to the realpath, so expectations use the canonical form from the start.
  const value = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporary.push(value);
  return value;
}
test.afterEach(() => {
  while (temporary.length) rmSync(temporary.pop(), { recursive: true, force: true });
});

const call = (app, path, init) =>
  app.request(`http://localhost${path}`, {
    ...init,
    headers: { host: "localhost", ...(init?.headers ?? {}) },
  });

async function rootsFor(...dirs) {
  return createAllowedRootService({
    roots: dirs,
    allowLocalExpansion: false,
    allowLanExpansion: false,
  });
}

/**
 * Built-in-shaped resolved theme: every whitelisted key from the HOST's own
 * projection (the exported THEME_CSS_VAR_KEYS) with safe values — no inline
 * hardcoded key list, so this fixture cannot drift from the sanitizer.
 */
const SAMPLE_THEME = {
  name: "gruvbox",
  isDark: true,
  cssVars: Object.fromEntries(
    [...THEME_CSS_VAR_KEYS].map((key) => [key, key === "--bg" ? "#282828" : "#3c3836"]),
  ),
};

function fakeThemes(impl = {}) {
  const seen = [];
  return {
    seen,
    forCwd(cwd, trusted) {
      seen.push({ cwd, trusted });
      return {
        listThemeSets: async () =>
          impl.listSets ? impl.listSets(cwd, trusted) : [{ name: "gruvbox", displayName: "Gruvbox", hasDark: true, hasLight: true, builtin: true }],
        resolveTheme: async (name, mode) => {
          if (impl.resolveTheme) return impl.resolveTheme(name, mode, cwd, trusted);
          if (name === "gruvbox") return { ...SAMPLE_THEME, name };
          const error = new Error(`ENOENT: ${cwd}/nope/${name}-${mode}.json`);
          error.code = "not_found";
          throw error;
        },
      };
    },
  };
}

function fakeTrust(trusted) {
  return {
    getProjectTrustState: async () => (trusted ? "trusted" : "unknown"),
    isTrusted: async () => trusted,
    canReloadResources: async () => ({ allowed: trusted, level: trusted ? "trusted" : "unknown" }),
  };
}

function themeHost({ themes, trust, roots, gate = DISABLED_GATE } = {}) {
  return createHostApp({
    logger: {},
    gate: { config: gate },
    catalogs: { roots, ...(themes ? { themes } : {}), ...(trust ? { trust } : {}) },
  }).app;
}

test("GET /v1/themes lists projected sets with the authorized canonical cwd", async () => {
  const project = temp("pix-themes-host-");
  const roots = await rootsFor(project);
  const themes = fakeThemes();
  const app = themeHost({ themes, trust: fakeTrust(true), roots });
  const res = await call(app, `/v1/themes?cwd=${encodeURIComponent(project)}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.deepEqual(body, {
    themeSets: [
      { name: "gruvbox", displayName: "Gruvbox", hasDark: true, hasLight: true, builtin: true },
    ],
  });
  assert.deepEqual(themes.seen, [{ cwd: project, trusted: true }]);
});

test("cwd is required and must be an authorized root (400/404 family, no fallback)", async () => {
  const project = temp("pix-themes-host-");
  const outside = temp("pix-themes-outside-");
  const roots = await rootsFor(project);
  const app = themeHost({ themes: fakeThemes(), trust: fakeTrust(true), roots });

  const missing = await call(app, "/v1/themes");
  assert.equal(missing.status, 400);
  const missingBody = await missing.json();
  assert.equal(missingBody.code, "CWD_REQUIRED");
  assert.equal(missingBody.message, "cwd query parameter is required");

  const relative = await call(app, "/v1/themes?cwd=relative/path");
  assert.equal(relative.status, 400);

  const external = await call(app, `/v1/themes?cwd=${encodeURIComponent(outside)}`);
  assert.notEqual(external.status, 200);
  assert.notEqual(external.status, 500);
  const errorBody = await external.json();
  assert.ok(!JSON.stringify(errorBody).includes(outside), "error must not echo the path");
});

test("mode is strictly light|dark with dark default; name is strictly validated", async () => {
  const project = temp("pix-themes-host-");
  const roots = await rootsFor(project);
  const themes = fakeThemes();
  const app = themeHost({ themes, trust: fakeTrust(true), roots });
  const cwd = `cwd=${encodeURIComponent(project)}`;

  // default mode = dark (source default) is forwarded to the seam.
  await call(app, `/v1/themes/gruvbox?${cwd}`);
  await call(app, `/v1/themes/gruvbox?mode=dark&${cwd}`);
  await call(app, `/v1/themes/gruvbox?mode=light&${cwd}`);
  assert.deepEqual(
    themes.seen.slice(-3).map((s) => s.trusted),
    [true, true, true],
  );

  for (const mode of ["Dark", "auto", "dark%20", "system", "dark;ls"]) {
    const res = await call(app, `/v1/themes/gruvbox?mode=${encodeURIComponent(mode)}&${cwd}`);
    assert.equal(res.status, 400, mode);
    const body = await res.json();
    assert.equal(body.code, "INVALID_THEME_MODE");
    assert.equal(body.message, "mode must be light or dark");
  }

  const seamCallsBefore = themes.seen.length;
  for (const name of ["..", "../evil", "a%2Fb", ".hidden", "-lead", "a%20b", "x".repeat(65)]) {
    const res = await call(app, `/v1/themes/${name}?${cwd}`);
    // Path-shaped names (.., ../evil, a/b) are normalized away by URL routing
    // and never reach the handler (404); single-segment unsafe names reach the
    // validator (400). Both fail closed; nothing must ever resolve (200).
    assert.ok(res.status === 400 || res.status === 404, `${name}: got ${res.status}`);
    if (res.status === 400) {
      const body = await res.json();
      assert.equal(body.code, "INVALID_THEME_NAME");
      assert.equal(body.message, "Invalid theme name");
    }
    assert.equal(themes.seen.length, seamCallsBefore, `${name}: the seam must never be called`);
  }
  // A maximal safe name is accepted (boundary of the slug pattern).
  const longest = "a" + "b".repeat(63);
  assert.equal(THEME_NAME_PATTERN.test(longest), true);
});

test("resolve returns the projected theme; unknown names map to fixed 404", async () => {
  const project = temp("pix-themes-host-");
  const roots = await rootsFor(project);
  const app = themeHost({ themes: fakeThemes(), trust: fakeTrust(true), roots });
  const cwd = `cwd=${encodeURIComponent(project)}`;

  const ok = await call(app, `/v1/themes/gruvbox?mode=dark&${cwd}`);
  assert.equal(ok.status, 200);
  const theme = await ok.json();
  assert.equal(theme.name, "gruvbox");
  assert.equal(theme.isDark, true);
  // Semantic parity with the host's own whitelist projection (not a magic
  // count): the emitted cssVars cover exactly the whitelisted keys, and every
  // value passes the host's safe-value predicate.
  assert.deepEqual(
    Object.keys(theme.cssVars).sort(),
    [...THEME_CSS_VAR_KEYS].sort(),
  );
  for (const value of Object.values(theme.cssVars)) {
    assert.match(value, /^#[0-9a-f]{6}$/);
    assert.equal(isSafeThemeCssValue(value), true);
  }
  // No extra top-level fields reach the wire.
  assert.deepEqual(Object.keys(theme).sort(), ["cssVars", "isDark", "name"]);

  // Sparse coverage over the whitelisted keys passes through untouched
  // (D3B-R6 sparse-overrides semantics; present keys must still be safe).
  const sparseApp = themeHost({
    themes: fakeThemes({
      resolveTheme: () => ({ name: "gruvbox", isDark: true, cssVars: { "--bg": "#282828", "--accent": "#fb4934" } }),
    }),
    trust: fakeTrust(true),
    roots,
  });
  const sparse = await call(sparseApp, `/v1/themes/gruvbox?mode=dark&${cwd}`);
  assert.equal(sparse.status, 200);
  assert.deepEqual(await sparse.json(), {
    name: "gruvbox",
    isDark: true,
    cssVars: { "--bg": "#282828", "--accent": "#fb4934" },
  });

  const missing = await call(app, `/v1/themes/nope?mode=dark&${cwd}`);
  assert.equal(missing.status, 404);
  const missingBody = await missing.json();
  assert.equal(missingBody.code, "THEME_NOT_FOUND");
  assert.equal(missingBody.message, "Theme not found");
});

test("project themes are trust-gated at the route (untrusted ⇒ seam receives false)", async () => {
  const project = temp("pix-themes-host-");
  const roots = await rootsFor(project);
  const themes = fakeThemes();
  const app = themeHost({ themes, trust: fakeTrust(false), roots });
  await call(app, `/v1/themes?cwd=${encodeURIComponent(project)}`);
  assert.deepEqual(themes.seen, [{ cwd: project, trusted: false }]);
  // No trust seam at all ⇒ fail closed to untrusted.
  const themes2 = fakeThemes();
  const app2 = themeHost({ themes: themes2, roots });
  await call(app2, `/v1/themes?cwd=${encodeURIComponent(project)}`);
  assert.deepEqual(themes2.seen, [{ cwd: project, trusted: false }]);
});

test("seam failures map to fixed sanitized 503 (never paths, raw JSON or stacks)", async () => {
  const project = temp("pix-themes-host-");
  const roots = await rootsFor(project);
  const cwd = `cwd=${encodeURIComponent(project)}`;
  const secretPath = join(project, "secret", "path.json");

  const throwing = fakeThemes({
    listSets: () => {
      throw new Error(`EACCES: permission denied, open '${secretPath}'`);
    },
    resolveTheme: () => {
      const error = new Error(`boom ${secretPath}`);
      error.code = "internal";
      throw error;
    },
  });
  const app = themeHost({ themes: throwing, trust: fakeTrust(true), roots });

  for (const path of [`/v1/themes?${cwd}`, `/v1/themes/gruvbox?${cwd}`]) {
    const res = await call(app, path);
    assert.equal(res.status, 503, path);
    const body = await res.json();
    assert.equal(body.code, "CATALOG_UNAVAILABLE");
    assert.equal(body.message, "Catalog is unavailable");
    assert.ok(!JSON.stringify(body).includes(secretPath));
  }

  // Malformed shapes fail closed as 503, never partially emitted; extra
  // UNKNOWN set fields are dropped by the projector (never read/forwarded —
  // the same convention as skills/plugins `sourceInfo`).
  {
    const badApp = themeHost({
      themes: fakeThemes({ listSets: () => [{ name: "", displayName: "x", hasDark: true, hasLight: false, builtin: false }] }),
      trust: fakeTrust(true),
      roots,
    });
    const res = await call(badApp, `/v1/themes?${cwd}`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.code, "CATALOG_UNAVAILABLE");
    assert.equal(body.message, "Catalog is unavailable");
  }
  {
    const badApp = themeHost({
      themes: fakeThemes({ listSets: () => [{ name: "x", displayName: "x", hasDark: 1, hasLight: false, builtin: false }] }),
      trust: fakeTrust(true),
      roots,
    });
    const res = await call(badApp, `/v1/themes?${cwd}`);
    assert.equal(res.status, 503);
  }
  {
    const leakApp = themeHost({
      themes: fakeThemes({
        listSets: () => [{ name: "x", displayName: "x", hasDark: true, hasLight: false, builtin: false, path: "/leak" }],
      }),
      trust: fakeTrust(true),
      roots,
    });
    const res = await call(leakApp, `/v1/themes?${cwd}`);
    assert.equal(res.status, 200);
    const text = JSON.stringify(await res.json());
    assert.ok(!text.includes("/leak"), "extra fields are never forwarded");
    assert.ok(!text.includes("path"));
  }

  for (const cssVars of [
    { ...SAMPLE_THEME.cssVars, "--evil": "#282828" },
    { ...SAMPLE_THEME.cssVars, background: "#282828" },
    { ...SAMPLE_THEME.cssVars, "--accent": "url(javascript:alert(1))" },
    { ...SAMPLE_THEME.cssVars, "--accent": "expression(alert(1))" },
    { ...SAMPLE_THEME.cssVars, "--accent": "#282828; } body { x: y" },
    { ...SAMPLE_THEME.cssVars, "--accent": "red" },
  ]) {
    const badApp = themeHost({
      themes: fakeThemes({ resolveTheme: () => ({ ...SAMPLE_THEME, cssVars }) }),
      trust: fakeTrust(true),
      roots,
    });
    const res = await call(badApp, `/v1/themes/gruvbox?${cwd}`);
    assert.equal(res.status, 503, JSON.stringify(cssVars).slice(0, 60));
    const body = await res.json();
    assert.equal(body.code, "CATALOG_UNAVAILABLE");
    assert.equal(body.message, "Catalog is unavailable");
  }
});

test("themes capability: advertised only when the seam is mounted; honest in degraded", async () => {
  const project = temp("pix-themes-host-");
  const roots = await rootsFor(project);

  const withThemes = {
    logger: {},
    gate: { config: DISABLED_GATE },
    catalogs: { roots, themes: fakeThemes() },
    sessiond: { isAvailable: async () => false },
  };
  const up = await resolveCapabilities({ ...withThemes, sessiond: { isAvailable: async () => true } });
  const down = await resolveCapabilities(withThemes);
  assert.ok(up.capabilities.includes("themes"), "up ⇒ themes advertised");
  assert.ok(down.capabilities.includes("themes"), "down (degraded) ⇒ themes stays advertised (sessiond-independent)");
  assert.ok(!down.capabilities.includes("agent"));

  const appWith = createHostApp(withThemes).app;
  const health = await call(appWith, "/v1/health");
  assert.ok((await health.json()).capabilities.includes("themes"));
  const bootstrap = await call(appWith, "/v1/bootstrap");
  assert.ok((await bootstrap.json()).capabilities.includes("themes"));
  assert.ok(CATALOG_CAPABILITIES.includes("themes"));

  // Unmounted seam ⇒ no route, no token (honest defaults).
  const without = {
    logger: {},
    gate: { config: DISABLED_GATE },
    catalogs: { roots },
    sessiond: { isAvailable: async () => false },
  };
  const appWithout = createHostApp(without).app;
  const missing = await call(appWithout, `/v1/themes?cwd=${encodeURIComponent(project)}`);
  assert.equal(missing.status, 404);
  const capsNone = await resolveCapabilities(without);
  assert.ok(!capsNone.capabilities.includes("themes"));
});

test("gate runs before theme routes: enabled gate ⇒ 401 for API calls until login", async () => {
  const project = temp("pix-themes-host-");
  const roots = await rootsFor(project);
  const app = createHostApp({
    logger: {},
    gate: { config: { read: () => ({ status: "enabled", password: "pw", source: "test" }) } },
    catalogs: { roots, themes: fakeThemes(), trust: fakeTrust(true) },
  }).app;

  const blockedList = await call(app, `/v1/themes?cwd=${encodeURIComponent(project)}`);
  assert.equal(blockedList.status, 401);
  const blockedResolve = await call(app, `/v1/themes/gruvbox?cwd=${encodeURIComponent(project)}`);
  assert.equal(blockedResolve.status, 401);

  const login = await call(app, "/v1/gate/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "pw" }),
  });
  assert.equal(login.status, 200);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  assert.match(cookie, /^pix_session=/);

  const allowed = await call(app, `/v1/themes?cwd=${encodeURIComponent(project)}`, { headers: { cookie } });
  assert.equal(allowed.status, 200);
});

test("host theme sanitization is a semantic projection of the protocol wire vocabulary", () => {
  // Key whitelist parity: the host's exported projection is the same set as
  // the protocol wire projection (the runtime-contract-tests seam pins the
  // protocol projection to the canonical runtime-core vocabulary).
  assert.deepEqual(
    [...THEME_CSS_VAR_KEYS].sort(),
    [...PROTOCOL_THEME_CSS_VAR_KEYS].sort(),
    "host cssVars whitelist must match the protocol projection",
  );
  // Value grammar parity: the host's fail-closed safe-value predicate must
  // accept exactly what the protocol DTO accepts, and reject exactly what it
  // rejects — no independent regex set drifting from the wire contract.
  const probes = [
    "#282828",
    "#fb4934",
    "#abc",
    "rgba(255,255,255,0.035)",
    "rgba(0,0,0,0)",
    "rgba(13,148,136,0.12)",
    "rgba(100,193,182,1)",
    "url(javascript:alert(1))",
    "url(https://evil.example/x.png)",
    "expression(alert(1))",
    "var(--bg)",
    "red",
    "rgb(255, 255, 255)",
    "hsl(0, 100%, 50%)",
    "#282828; } body { display: none",
    "#282828 url(x.png)",
    "javascript:alert(1)",
    "<script>alert(1)</script>",
    "inherit",
    "",
    "#28282",
    "#2828288",
    "#GGGGGG",
    "#282828 ",
    "RGBA(255,255,255,0.1)",
    "rgba(256,0,0,0.5)",
    "rgba(1,2,3)",
    "rgba(1,2,3,2)",
    "rgba(1,2,3,-0.5)",
  ];
  for (const value of probes) {
    const hostSafe = isSafeThemeCssValue(value);
    const protocolSafe = ThemeCssValueSchema.safeParse(value).success;
    assert.equal(
      hostSafe,
      protocolSafe,
      `value ${JSON.stringify(value)}: host=${hostSafe} protocol=${protocolSafe}`,
    );
  }
});

test("LAN exposure keeps themes behind the gate even with auth unconfigured/disabled", async () => {
  const project = temp("pix-themes-host-");
  const roots = await rootsFor(project);
  const make = (status) =>
    createHostApp({
      logger: {},
      exposureMode: "lan",
      gate: { config: { read: () => ({ status, source: "test" }) } },
      catalogs: { roots, themes: fakeThemes(), trust: fakeTrust(true) },
    }).app;

  // Unconfigured on LAN fails closed 503 AUTH_NOT_CONFIGURED (never open).
  const unconfigured = await call(make("unconfigured"), `/v1/themes?cwd=${encodeURIComponent(project)}`);
  assert.equal(unconfigured.status, 503);
  assert.equal((await unconfigured.json()).code, "AUTH_NOT_CONFIGURED");

  // Explicitly disabled on LAN is still gated: 403 AUTH_REQUIRED_FOR_LAN (D-020).
  const disabled = await call(make("disabled"), `/v1/themes?cwd=${encodeURIComponent(project)}`);
  assert.equal(disabled.status, 403);
  assert.equal((await disabled.json()).code, "AUTH_REQUIRED_FOR_LAN");
});
