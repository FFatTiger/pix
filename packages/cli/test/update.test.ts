import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNewerVersion, npmGlobalPrefix } from "../src/commands/update.js";

test("finds the npm prefix of a global install only", () => {
  assert.equal(npmGlobalPrefix("/opt/homebrew/lib/node_modules/@fffattiger/pix-cli", "darwin"), "/opt/homebrew");
  assert.equal(npmGlobalPrefix("/home/me/project/node_modules/@fffattiger/pix-cli", "linux"), null);
  assert.equal(npmGlobalPrefix("/src/pix/packages/cli", "darwin"), null);
  assert.equal(npmGlobalPrefix("C:/Users/me/AppData/Roaming/npm/node_modules/@fffattiger/pix-cli", "win32"), "C:/Users/me/AppData/Roaming/npm");
});

test("compares release versions numerically", () => {
  assert.equal(isNewerVersion("0.3.10", "0.3.9"), true);
  assert.equal(isNewerVersion("0.3.5", "0.3.5"), false);
  assert.equal(isNewerVersion("0.3.4", "0.3.5"), false);
  assert.equal(isNewerVersion("1.0.0", "0.9.9"), true);
  assert.equal(isNewerVersion("0.4.0-beta.1", "0.3.9"), true);
});

test("the update check has no hardcoded registry URL (resolves npm's effective one)", () => {
  // dist-test/test/*.test.js → ../../ is the package root.
  const source = readFileSync(new URL("../../src/commands/update.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /registry\.npmjs\.org/, "no hardcoded public registry in the CLI update path");
  assert.match(source, /resolveNpmRegistryLatestUrl/, "the latest lookup goes through the shared npm-registry resolver");
});

test("update --restart relaunches the background host detached", () => {
  // A plain `pix start` runs in the foreground: through spawnSync it would
  // block the update until the new host exits.
  const source = readFileSync(new URL("../../src/commands/update.ts", import.meta.url), "utf8");
  assert.match(source, /"start",\s*"--detach",/);
});
