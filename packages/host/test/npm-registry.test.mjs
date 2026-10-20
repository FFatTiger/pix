import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  DEFAULT_NPM_REGISTRY,
  resolveNpmRegistry,
  resolveNpmRegistryLatestUrl,
} from "../dist/resources/npm-registry.js";

/** Fake `npm config get` reading `values`; records the keys asked for. */
function fakeNpm(values, calls = []) {
  return async (args) => {
    const key = args[args.length - 1];
    calls.push([...args]);
    if (!(key in values)) return { stdout: "undefined\n", exitCode: 0 };
    const value = values[key];
    if (value instanceof Error) throw value;
    return { stdout: `${value}\n`, exitCode: 0 };
  };
}

test("npm registry: a user-configured mirror serves the lookup (no hardcoded npmjs)", async () => {
  const calls = [];
  const run = fakeNpm({ registry: "https://registry.npmmirror.com/" }, calls);
  assert.equal(await resolveNpmRegistry(run), "https://registry.npmmirror.com");
  assert.equal(
    await resolveNpmRegistryLatestUrl({ run }),
    "https://registry.npmmirror.com/@fffattiger%2fpix-cli/latest",
  );
  assert.deepEqual(calls[0], ["config", "get", "@fffattiger:registry"], "scoped registry is asked first");
  assert.deepEqual(calls[1], ["config", "get", "registry"]);
});

test("npm registry: a scoped @fffattiger registry wins over the default registry", async () => {
  const calls = [];
  const run = fakeNpm(
    { "@fffattiger:registry": "https://npm.corp.example/scoped/", registry: "https://registry.npmmirror.com/" },
    calls,
  );
  assert.equal(await resolveNpmRegistry(run), "https://npm.corp.example/scoped");
  assert.deepEqual(calls, [["config", "get", "@fffattiger:registry"]], "the default registry is not consulted");
});

test("npm registry: npm's own public default is used only when npm cannot report a value", async () => {
  // npm prints `undefined` for an unset key.
  assert.equal(await resolveNpmRegistry(fakeNpm({})), DEFAULT_NPM_REGISTRY);
  // npm not installed / config read failed.
  assert.equal(await resolveNpmRegistry(async () => { throw new Error("ENOENT"); }), DEFAULT_NPM_REGISTRY);
  // npm answered with a non-zero exit.
  assert.equal(await resolveNpmRegistry(async () => ({ stdout: "", exitCode: 1 })), DEFAULT_NPM_REGISTRY);
  // A non-http(s) registry value cannot serve a `latest` document.
  assert.equal(await resolveNpmRegistry(fakeNpm({ registry: "git+ssh://example.invalid/x" })), DEFAULT_NPM_REGISTRY);
});

test("npm registry: no mirror->npmjs fallback once a mirror is configured", () => {
  // Static guard: the module must not contain a hardcoded fallback URL string
  // used after a configured registry is known.
  const source = readFileSync(new URL("../src/resources/npm-registry.ts", import.meta.url), "utf8");
  assert.equal(
    (source.match(/registry\.npmjs\.org/g) ?? []).length,
    1,
    "exactly one npmjs URL: the npm-default constant",
  );
  assert.match(source, /export const DEFAULT_NPM_REGISTRY = "https:\/\/registry\.npmjs\.org";/);
});
