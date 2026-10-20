import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHostApp } from "../dist/index.js";
import { compareSemver } from "../dist/routes/about.js";
import { createProductionAboutFacts } from "../dist/composition/production-about.js";

const FACTS = {
  pixVersion: "0.3.1",
  piCodingAgentVersion: "1.0.0",
  nodeVersion: "25.0.0",
  platform: "darwin",
  arch: "arm64",
  plugins: [
    { id: "subagents", name: "pi-claude-subagents", version: "0.3.9" },
    { id: "lore", name: "@local/lore-pi-extension", version: "1.5.1" },
  ],
};

function appWith(about = {}, gateStatus = "disabled") {
  return createHostApp({
    logger: {},
    exposureMode: "local",
    gate: { config: { read: () => ({ status: gateStatus, ...(gateStatus === "enabled" ? { password: "secret" } : {}), source: "test" }) } },
    about: {
      facts: FACTS,
      registryLatestUrl: "https://registry.test/pix-cli/latest",
      ...about,
    },
  }).app;
}

function registryFetch(version, calls = []) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    if (version === null) throw new Error("network down");
    return new Response(JSON.stringify({ version }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

test("GET /v1/about returns the strict facts body from the composed seam", async () => {
  const app = appWith();
  const res = await app.request("http://localhost/v1/about", { headers: { host: "localhost" } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    pix: { version: "0.3.1" },
    pi: { codingAgent: "1.0.0" },
    node: "25.0.0",
    platform: "darwin",
    arch: "arm64",
    plugins: [
      { id: "subagents", name: "pi-claude-subagents", version: "0.3.9" },
      { id: "lore", name: "@local/lore-pi-extension", version: "1.5.1" },
    ],
  });
});

test("about routes sit behind the gate like every /v1 route", async () => {
  const app = appWith({}, "enabled");
  const get = await app.request("http://localhost/v1/about", { headers: { host: "localhost" } });
  assert.equal(get.status, 401);
  const check = await app.request("http://localhost/v1/about/check-update", {
    method: "POST",
    headers: { host: "localhost" },
  });
  assert.equal(check.status, 401);
});

test("check-update compares semver against the registry latest (update available)", async () => {
  const calls = [];
  const app = appWith({ fetch: registryFetch("0.4.0", calls) });
  const res = await app.request("http://localhost/v1/about/check-update", {
    method: "POST",
    headers: { host: "localhost" },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { current: "0.3.1", latest: "0.4.0", updateAvailable: true, package: "@fffattiger/pix-cli" });
  // Outbound probe: exact registry URL, no redirects followed, bounded by a timeout signal.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://registry.test/pix-cli/latest");
  assert.equal(calls[0].init.redirect, "error");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("check-update reports up-to-date for equal and older latest versions", async () => {
  for (const latest of ["0.3.1", "0.2.9", "0.3.0"]) {
    const app = appWith({ fetch: registryFetch(latest) });
    const res = await app.request("http://localhost/v1/about/check-update", {
      method: "POST",
      headers: { host: "localhost" },
    });
    assert.deepEqual(await res.json(), { current: "0.3.1", latest, updateAvailable: false, package: "@fffattiger/pix-cli" });
  }
});

test("check-update resolves the registry from the user's effective npm config", async () => {
  const calls = [];
  const npmCalls = [];
  const app = appWith({
    // No registryLatestUrl override: the route must ask npm itself.
    registryLatestUrl: undefined,
    fetch: registryFetch("0.4.0", calls),
    npmRunner: async (args) => {
      npmCalls.push([...args]);
      return args[2] === "@fffattiger:registry"
        ? { stdout: "undefined\n", exitCode: 0 }
        : { stdout: "https://registry.npmmirror.com/\n", exitCode: 0 };
    },
  });
  const res = await app.request("http://localhost/v1/about/check-update", {
    method: "POST",
    headers: { host: "localhost" },
  });
  assert.deepEqual(await res.json(), { current: "0.3.1", latest: "0.4.0", updateAvailable: true, package: "@fffattiger/pix-cli" });
  assert.deepEqual(npmCalls, [["config", "get", "@fffattiger:registry"], ["config", "get", "registry"]]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://registry.npmmirror.com/@fffattiger%2fpix-cli/latest", "the mirror serves the latest lookup");
});

test("check-update prefers a scoped @fffattiger registry when one is configured", async () => {
  const calls = [];
  const app = appWith({
    registryLatestUrl: undefined,
    fetch: registryFetch("0.4.0", calls),
    npmRunner: async (args) => args[2] === "@fffattiger:registry"
      ? { stdout: "https://npm.corp.example/scoped\n", exitCode: 0 }
      : { stdout: "https://registry.npmjs.org/\n", exitCode: 0 },
  });
  await app.request("http://localhost/v1/about/check-update", { method: "POST", headers: { host: "localhost" } });
  assert.equal(calls[0].url, "https://npm.corp.example/scoped/@fffattiger%2fpix-cli/latest");
});

test("check-update falls back to npm's public registry only when npm has no configured value", async () => {
  const calls = [];
  const app = appWith({
    registryLatestUrl: undefined,
    fetch: registryFetch("0.4.0", calls),
    npmRunner: async () => { throw new Error("npm is not installed"); },
  });
  const res = await app.request("http://localhost/v1/about/check-update", { method: "POST", headers: { host: "localhost" } });
  assert.deepEqual(await res.json(), { current: "0.3.1", latest: "0.4.0", updateAvailable: true, package: "@fffattiger/pix-cli" });
  assert.equal(calls[0].url, "https://registry.npmjs.org/@fffattiger%2fpix-cli/latest");
});

test("check-update fails closed to unreachable (latest null) on network, HTTP, and body failures", async () => {
  const cases = [
    registryFetch(null),
    async () => new Response("nope", { status: 500 }),
    async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
    async () => new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
  ];
  for (const fetchImpl of cases) {
    const app = appWith({ fetch: fetchImpl });
    const res = await app.request("http://localhost/v1/about/check-update", {
      method: "POST",
      headers: { host: "localhost" },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { current: "0.3.1", latest: null, updateAvailable: false, package: "@fffattiger/pix-cli" });
  }
});

test("compareSemver orders releases and prereleases, and fails closed on non-semver", () => {
  assert.equal(compareSemver("0.4.0", "0.3.1"), 1);
  assert.equal(compareSemver("0.3.1", "0.3.1"), 0);
  assert.equal(compareSemver("0.2.9", "0.3.1"), -1);
  assert.equal(compareSemver("1.0.0", "0.99.99"), 1);
  assert.equal(compareSemver("0.3.1-beta.1", "0.3.1"), -1);
  assert.equal(compareSemver("0.3.1-beta.2", "0.3.1-beta.1"), 1);
  assert.equal(compareSemver("0.3.1-beta.1", "0.3.1-alpha.9"), 1);
  assert.equal(compareSemver("0.3.1+build.7", "0.3.1"), 0);
  assert.equal(compareSemver("latest", "0.3.1"), null);
  assert.equal(compareSemver("0.3.1", "x"), null);
});

test("production facts resolve versions from the actually installed packages", () => {
  const facts = createProductionAboutFacts();
  // Pix version comes from the host's own installed package.json.
  const hostManifest = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  );
  assert.equal(facts.pixVersion, hostManifest.version);
  assert.match(facts.pixVersion, /^\d+\.\d+\.\d+/);
  // pi-coding-agent version resolves from the installed SDK manifest.
  assert.match(facts.piCodingAgentVersion, /^\d+\.\d+\.\d+/);
  // Bundled plugins come from the curated list with real manifest versions.
  const ids = facts.plugins.map((plugin) => plugin.id).sort();
  assert.deepEqual(ids, [
    "ask_user_question",
    "lore",
    "pi_memory",
    "smart_compact",
    "subagents",
    "todo",
  ]);
  for (const plugin of facts.plugins) {
    assert.ok(plugin.name.length > 0);
    assert.match(plugin.version, /^\d+\.\d+\.\d+/);
  }
  assert.equal(facts.platform, process.platform);
  assert.equal(facts.arch, process.arch);
  assert.equal(facts.nodeVersion, process.versions.node);
});
