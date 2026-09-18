import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostApp } from "../dist/index.js";
import { createFileGatePreferencesStore } from "../dist/gate/config.js";

function appWith(pixJson, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pix-prefs-"));
  const configPath = join(dir, "pix.json");
  if (pixJson !== null) writeFileSync(configPath, pixJson);
  const store = createFileGatePreferencesStore({ configPath, env: {} });
  const app = createHostApp({
    logger: {},
    exposureMode: "local",
    gate: { config: { read: () => ({ status: "disabled", source: "test" }) } },
    preferences: { store },
    ...extra,
  }).app;
  return { app, configPath, dir };
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test("GET returns the preferences map and PUT patches per key (null deletes)", async () => {
  const { app, configPath, dir } = appWith(JSON.stringify({ auth: { password: "k" }, preferences: { "pi-process-display-mode": "tabs" } }));
  try {
    const get1 = await app.request("http://localhost/v1/preferences", { headers: { host: "localhost" } });
    assert.equal(get1.status, 200);
    assert.deepEqual(await get1.json(), { preferences: { "pi-process-display-mode": "tabs" } });

    const put = await app.request("http://localhost/v1/preferences", {
      method: "PUT",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ patch: { "pi-sound-enabled": "false", "pi-title-auto": "on", "pi-process-display-mode": null } }),
    });
    assert.equal(put.status, 200);
    const body = await put.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.preferences, { "pi-sound-enabled": "false", "pi-title-auto": "on" });

    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(onDisk.preferences, { "pi-sound-enabled": "false", "pi-title-auto": "on" });
    // Other pix.json fields survive the patch.
    assert.equal(onDisk.auth.password, "k");
  } finally {
    cleanup(dir);
  }
});

test("a missing pix.json is created with only the preferences field", async () => {
  const { app, configPath, dir } = appWith(null);
  try {
    const put = await app.request("http://localhost/v1/preferences", {
      method: "PUT",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ patch: { "pi-locale": "zh-CN" } }),
    });
    assert.equal(put.status, 200);
    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(onDisk, { preferences: { "pi-locale": "zh-CN" } });
  } finally {
    cleanup(dir);
  }
});

test("malformed patches fail closed with fixed codes", async () => {
  const { app, dir } = appWith("{}");
  try {
    const cases = [
      [415, { headers: { host: "localhost", "content-type": "text/plain" }, body: "{}" }],
      [400, { headers: { host: "localhost", "content-type": "application/json" }, body: "{nope" }],
      [400, { headers: { host: "localhost", "content-type": "application/json" }, body: "[]" }],
      [400, { headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ patch: "no" }) }],
      [400, { headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ patch: { ok: 1 } }) }],
      [500, { headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ patch: { "not-pi-key": "x" } }) }],
      [500, { headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ patch: { "pi-x": "y".repeat(17 * 1024) } }) }],
    ];
    for (const [expected, init] of cases) {
      const res = await app.request("http://localhost/v1/preferences", { method: "PUT", ...init });
      assert.equal(res.status, expected, `${init.body}`);
    }
  } finally {
    cleanup(dir);
  }
});

test("preferences APIs sit behind the gate like every /v1 route", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pix-prefs-"));
  try {
    const app = createHostApp({
      logger: {},
      gate: { config: { read: () => ({ status: "enabled", password: "secret", source: "test" }) } },
      preferences: { store: createFileGatePreferencesStore({ configPath: join(dir, "pix.json"), env: {} }) },
    }).app;
    const get = await app.request("http://localhost/v1/preferences", { headers: { host: "localhost" } });
    assert.equal(get.status, 401);
    const put = await app.request("http://localhost/v1/preferences", {
      method: "PUT",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ patch: {} }),
    });
    assert.equal(put.status, 401);
  } finally {
    cleanup(dir);
  }
});

test("concurrent keys cap is enforced on the resulting map", async () => {
  const { app, dir } = appWith("{}");
  try {
    const patch = {};
    for (let i = 0; i < 65; i += 1) patch[`pi-key-${i}`] = "v";
    const res = await app.request("http://localhost/v1/preferences", {
      method: "PUT",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ patch }),
    });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).code, "PREFERENCES_WRITE_FAILED");
  } finally {
    cleanup(dir);
  }
});
