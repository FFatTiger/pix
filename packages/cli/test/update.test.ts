import assert from "node:assert/strict";
import { test } from "node:test";
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
