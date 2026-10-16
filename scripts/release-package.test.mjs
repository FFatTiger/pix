import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createRegistryPackage } from "./release-package.mjs";

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "pix-registry-package-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const source = join(base, "standalone");
  const destination = join(base, "registry");
  const put = (path, value) => {
    const target = join(source, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value));
  };
  put("package.json", { name: "@fffattiger/pix-cli", version: "0.2.0", private: true, bin: { pix: "bin/pix.mjs" }, engines: { node: ">=22.19.0" } });
  put("bin/pix.mjs", "// CLI\n");
  put("client/index.html", "<html>client</html>\n");
  put("THIRD_PARTY_NOTICES.md", "notices\n");
  put("node_modules/@fffattiger/pix-host/package.json", { name: "@fffattiger/pix-host", version: "0.2.0", dependencies: { "@fffattiger/pix-pi-sdk-adapter": "0.2.0", hono: "^4.9.0" } });
  put("node_modules/@fffattiger/pix-pi-sdk-adapter/package.json", { name: "@fffattiger/pix-pi-sdk-adapter", version: "0.2.0", dependencies: { "pi-claude-subagents": "file:../../vendor/pinned.tgz", "pi-smart-compact": "file:../../vendor/smart.tgz", "@earendil-works/pi-tui": "1.3.0" } });
  put("node_modules/@fffattiger/pix-pi-sdk-adapter/dist/index.js", "// runtime\n");
  put("node_modules/pi-claude-subagents/package.json", { name: "pi-claude-subagents", version: "0.3.9", peerDependencies: { "@earendil-works/pi-tui": ">=1.0.0 <2", typebox: "*" }, devDependencies: { typescript: "5.9.3" } });
  put("node_modules/typebox/package.json", { name: "typebox", version: "1.1.38" });
  put("node_modules/@earendil-works/pi-coding-agent/package.json", { name: "@earendil-works/pi-coding-agent", version: "1.3.0", dependencies: { "@earendil-works/pi-tui": "1.3.0", chalk: "6.0.0", typebox: "1.1.38" } });
  put("node_modules/@earendil-works/pi-coding-agent/dist/index.js", "// SDK runtime\n");
  put("node_modules/@earendil-works/pi-coding-agent/node_modules/unneeded/index.js", "must not copy\n");
  put("node_modules/pi-claude-subagents/src/runtime.ts", "// patched plugin\n");
  put("node_modules/pi-smart-compact/package.json", { name: "pi-smart-compact", version: "10.3.0", peerDependencies: { "@earendil-works/pi-coding-agent": ">=0.87.1", "@oh-my-pi/pi-mnemopi": "18.3.1", typebox: "*" }, peerDependenciesMeta: { "@oh-my-pi/pi-mnemopi": { optional: true } } });
  put("node_modules/pi-smart-compact/dist/index.js", "// smart compact\n");
  put("node_modules/pi-memory/package.json", { name: "pi-memory", version: "0.4.2" });
  put("node_modules/@local/lore-pi-extension/package.json", { name: "@local/lore-pi-extension", version: "1.5.0" });
  put("node_modules/@juicesharp/rpiv-todo/package.json", { name: "@juicesharp/rpiv-todo", version: "2.11.0" });
  put("node_modules/@juicesharp/rpiv-ask-user-question/package.json", { name: "@juicesharp/rpiv-ask-user-question", version: "2.11.0" });
  put("node_modules/dev-only/index.js", "must not ship\n");
  return { source, destination, put };
}

test("registry package bundles Pix and patched plugin while declaring external dependencies", (t) => {
  const { source, destination } = fixture(t);
  const manifest = createRegistryPackage(source, destination, { "@earendil-works/pi-tui": "1.3.0" });
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.dependencies.hono, "^4.9.0");
  assert.equal(manifest.dependencies["pi-claude-subagents"], "0.3.9");
  assert.equal(manifest.dependencies["pi-smart-compact"], "10.3.0");
  assert.deepEqual(manifest.bundledDependencies, ["@fffattiger/pix-host", "@fffattiger/pix-pi-sdk-adapter", "@earendil-works/pi-coding-agent", "pi-claude-subagents", "pi-smart-compact", "pi-memory", "@local/lore-pi-extension", "@juicesharp/rpiv-todo", "@juicesharp/rpiv-ask-user-question"]);
  assert.equal(existsSync(join(destination, "node_modules/@earendil-works/pi-coding-agent/node_modules")), false);
  assert.equal(readFileSync(join(destination, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"), "utf8"), "// SDK runtime\n");
  assert.equal(manifest.dependencies.chalk, "6.0.0");
  assert.deepEqual(manifest.overrides, { "@earendil-works/pi-tui": "1.3.0" });
  assert.equal(existsSync(join(destination, "node_modules/dev-only")), false);
  assert.equal(readFileSync(join(destination, "node_modules/pi-claude-subagents/src/runtime.ts"), "utf8"), "// patched plugin\n");
  assert.equal(readFileSync(join(destination, "node_modules/pi-smart-compact/dist/index.js"), "utf8"), "// smart compact\n");
  const smartPlugin = JSON.parse(readFileSync(join(destination, "node_modules/pi-smart-compact/package.json"), "utf8"));
  // Bundled peers stay internal on the copy; the external optional peer
  // (@oh-my-pi/pi-mnemopi) and its meta are stripped (never a consumer
  // requirement — Pix is the application).
  assert.deepEqual(smartPlugin.peerDependencies, { "@earendil-works/pi-coding-agent": ">=0.87.1" });
  assert.equal(smartPlugin.peerDependenciesMeta, undefined);
  assert.equal(manifest.peerDependencies, undefined);
  assert.equal(manifest.dependencies["pi-smart-compact"], "10.3.0");
  assert.equal(readFileSync(join(destination, "client/index.html"), "utf8"), "<html>client</html>\n");
  const adapter = JSON.parse(readFileSync(join(destination, "node_modules/@fffattiger/pix-pi-sdk-adapter/package.json"), "utf8"));
  assert.equal(adapter.dependencies["pi-claude-subagents"], "0.3.9");
  assert.equal(adapter.dependencies["pi-smart-compact"], "10.3.0");
  assert.equal(adapter.dependencies["@earendil-works/pi-tui"], undefined);
  const plugin = JSON.parse(readFileSync(join(destination, "node_modules/pi-claude-subagents/package.json"), "utf8"));
  assert.equal(plugin.peerDependencies, undefined);
  assert.equal(plugin.devDependencies, undefined);
  assert.equal(manifest.peerDependencies, undefined);
  assert.equal(manifest.dependencies["@earendil-works/pi-tui"], "1.3.0");
  assert.equal(manifest.dependencies.typebox, "1.1.38");
  assert.equal(JSON.parse(readFileSync(join(source, "node_modules/@fffattiger/pix-pi-sdk-adapter/package.json"), "utf8")).dependencies["pi-claude-subagents"], "file:../../vendor/pinned.tgz");
});

test("SDK dependencies must be exact versions, never ranges", (t) => {
  const { source, destination, put } = fixture(t);
  put("node_modules/@earendil-works/pi-coding-agent/package.json", { name: "@earendil-works/pi-coding-agent", version: "1.3.0", dependencies: { "@earendil-works/pi-codemode": "^1.3.0", chalk: "6.0.0", typebox: "1.1.38" } });
  put("node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-codemode/package.json", { name: "@earendil-works/pi-codemode", version: "1.3.0" });
  assert.throws(() => createRegistryPackage(source, destination, {}), /SDK dependency is not an exact version: @earendil-works\/pi-codemode/);
  assert.equal(existsSync(destination), false);
});

test("bundled plugins may declare different ranges for one shared peer the installed copy satisfies", (t) => {
  const { source, destination, put } = fixture(t);
  put("node_modules/@earendil-works/pi-tui/package.json", { name: "@earendil-works/pi-tui", version: "1.3.0" });
  put("node_modules/pi-memory/package.json", { name: "pi-memory", version: "0.4.2", peerDependencies: { "@earendil-works/pi-tui": ">=0.81.1" } });
  assert.equal(createRegistryPackage(source, destination, {}).dependencies["@earendil-works/pi-tui"], "1.3.0");
  put("node_modules/pi-memory/package.json", { name: "pi-memory", version: "0.4.2", peerDependencies: { "@earendil-works/pi-tui": ">=2" } });
  assert.throws(() => createRegistryPackage(source, destination, {}), /conflicting runtime peer: @earendil-works\/pi-tui/);
});

test("invalid versions and dependency conflicts fail before creating a registry stage", (t) => {
  const { source, destination, put } = fixture(t);
  put("node_modules/@fffattiger/pix-host/package.json", { name: "@fffattiger/pix-host", version: "0.1.0" });
  assert.throws(() => createRegistryPackage(source, destination), /identity mismatch/);
  assert.equal(existsSync(destination), false);
  put("node_modules/@fffattiger/pix-host/package.json", { name: "@fffattiger/pix-host", version: "0.2.0", dependencies: { "@earendil-works/pi-tui": "0.87.1" } });
  assert.throws(() => createRegistryPackage(source, destination), /conflicting runtime dependency/);
  assert.equal(existsSync(destination), false);
});

test("unhandled local dependencies and overlapping stage paths fail closed", (t) => {
  const { source, destination, put } = fixture(t);
  assert.throws(() => createRegistryPackage(source, source), /separate/);
  assert.throws(() => createRegistryPackage(source, dirname(source)), /separate/);
  put("node_modules/@fffattiger/pix-host/package.json", { name: "@fffattiger/pix-host", version: "0.2.0", dependencies: { unrelated: "file:../private" } });
  assert.throws(() => createRegistryPackage(source, destination), /unresolved local dependency/);
  assert.equal(existsSync(destination), false);
});
