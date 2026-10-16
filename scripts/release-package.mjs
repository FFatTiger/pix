import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { resolveNpmInvocation } from "./tool-invocation.mjs";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** Bundle Pix and its patched plugin; let npm install third-party packages.
 * External requirements live only at the CLI root. Leaving them on bundled
 * packages makes npm treat their missing files as already bundled. */
export function createRegistryPackage(standalone, destination, overrides = {}) {
  const sourcePath = resolve(standalone);
  const targetPath = resolve(destination);
  if (sourcePath === targetPath || sourcePath.startsWith(targetPath + sep) || targetPath.startsWith(sourcePath + sep)) {
    throw new Error("registry stage must be separate from the standalone bundle");
  }
  const cli = readJson(join(standalone, "package.json"));
  const scope = join(standalone, "node_modules", "@fffattiger");
  // Bundled plugins: vendored/pinned trees copied verbatim into the registry
  // package's node_modules and rewritten to their real versions. Every
  // agent-capability plugin Pix ships is vendored as a fixed tgz (see
  // AGENTS.md "bundled agent plugins"); none resolve from the registry.
  const pluginRoots = [
    join(standalone, "node_modules", "pi-claude-subagents"),
    join(standalone, "node_modules", "pi-smart-compact"),
    join(standalone, "node_modules", "pi-memory"),
    join(standalone, "node_modules", "@local", "lore-pi-extension"),
    join(standalone, "node_modules", "@juicesharp", "rpiv-todo"),
    join(standalone, "node_modules", "@juicesharp", "rpiv-ask-user-question"),
  ];
  const pluginNames = [
    "pi-claude-subagents",
    "pi-smart-compact",
    "pi-memory",
    "@local/lore-pi-extension",
    "@juicesharp/rpiv-todo",
    "@juicesharp/rpiv-ask-user-question",
  ];
  const plugins = pluginRoots.map((root) => {
    const manifest = readJson(join(root, "package.json"));
    if (!pluginNames.includes(manifest.name)) {
      throw new Error(`bundled plugin identity mismatch: ${manifest.name}`);
    }
    return { root, manifest };
  });
  const bundledPluginNames = new Set(plugins.map(({ manifest }) => manifest.name));
  const sdkRoot = join(standalone, "node_modules", "@earendil-works", "pi-coding-agent");
  const sdk = readJson(join(sdkRoot, "package.json"));
  if (sdk.name !== "@earendil-works/pi-coding-agent") throw new Error("SDK package identity mismatch");
  const require = createRequire(resolveNpmInvocation().args[0]);
  const { valid, satisfies } = require("semver");
  const runtime = readdirSync(scope).map((directory) => {
    const root = join(scope, directory);
    const manifest = readJson(join(root, "package.json"));
    if (manifest.name !== `@fffattiger/${directory}` || manifest.version !== cli.version) {
      throw new Error(`runtime package identity mismatch: ${directory}`);
    }
    return { root, manifest };
  });
  const bundledDependencies = [...runtime.map(({ manifest }) => manifest.name), sdk.name, ...bundledPluginNames];
  const bundled = new Set(bundledDependencies);
  const dependencies = {};
  const optionalDependencies = {};
  function validate(name, version) {
    if (typeof version !== "string" || /^(?:file:|link:|workspace:)/.test(version)) throw new Error(`unresolved local dependency: ${name}`);
  }
  function depend(name, version) {
    validate(name, version);
    if (dependencies[name] !== undefined && dependencies[name] !== version) {
      if (valid(dependencies[name]) && satisfies(dependencies[name], version)) return;
      if (!valid(version) || !satisfies(version, dependencies[name])) throw new Error(`conflicting runtime dependency: ${name}`);
    }
    dependencies[name] = version;
  }
  /**
   * The SDK pins its own dependencies to exact release versions (since 1.3.0,
   * after ranges once let a clean install mix incompatible pi-* packages and
   * pi-codemode 1.2.0 broke SDK 1.0.0's imports). A range here would let a
   * clean registry install drift away from the verified tree, so fail closed
   * instead of re-deriving pins from the local install (the old bridge).
   */
  function validateSdkDependency(name, version) {
    if (!valid(version)) throw new Error(`SDK dependency is not an exact version: ${name}@${version}`);
  }
  function normalize(manifest) {
    const copy = { ...manifest };
    delete copy.devDependencies;
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      const internal = {};
      for (let [name, version] of Object.entries(manifest[section] ?? {})) {
        if (bundledPluginNames.has(name)) {
          const pluginManifest = plugins.find(({ manifest }) => manifest.name === name)?.manifest;
          if (pluginManifest === undefined) throw new Error(`bundled plugin missing from the stage: ${name}`);
          if (typeof version !== "string" || (!version.startsWith("file:") && version !== pluginManifest.version)) throw new Error("bundled plugin does not match the runtime dependency");
          version = pluginManifest.version;
        }
        if (manifest === sdk && section === "dependencies") {
          validateSdkDependency(name, version);
        }
        validate(name, version);
        if (bundled.has(name)) {
          internal[name] = version;
          depend(name, version);
        } else if (section === "peerDependencies") {
          // Pix supplies one copy of each shared peer, so every bundled
          // plugin's declared range must accept that copy (ranges may differ
          // between plugins; the installed version decides).
          if (manifest.peerDependenciesMeta?.[name]?.optional) continue;
          const installedManifest = join(standalone, "node_modules", name, "package.json");
          const installed = existsSync(installedManifest) ? readJson(installedManifest).version : dependencies[name];
          if (installed === undefined) throw new Error(`missing runtime peer: ${name}`);
          if (valid(installed) && !satisfies(installed, version, { includePrerelease: true })) throw new Error(`conflicting runtime peer: ${name}`);
          if (!dependencies[name]) depend(name, installed);
        } else if (section === "optionalDependencies") {
          if (optionalDependencies[name] !== undefined && optionalDependencies[name] !== version) throw new Error(`conflicting optional dependency: ${name}`);
          optionalDependencies[name] = version;
        } else depend(name, version);
      }
      if (Object.keys(internal).length) copy[section] = internal;
      else delete copy[section];
    }
    if (copy.peerDependenciesMeta) {
      copy.peerDependenciesMeta = Object.fromEntries(Object.entries(copy.peerDependenciesMeta).filter(([name]) => bundled.has(name)));
      if (!Object.keys(copy.peerDependenciesMeta).length) delete copy.peerDependenciesMeta;
    }
    return copy;
  }
  const copies = [...runtime, { root: sdkRoot, manifest: sdk }, ...plugins].map(({ root, manifest }) => {
    depend(manifest.name, manifest.version);
    return { root, manifest: normalize(manifest) };
  });
  for (const name of Object.keys(dependencies)) delete optionalDependencies[name];
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const path of ["bin", "dist", "client", "README.md", "THIRD_PARTY_NOTICES.md", "LICENSE"]) {
    if (existsSync(join(standalone, path))) cpSync(join(standalone, path), join(destination, path), { recursive: true, verbatimSymlinks: true });
  }
  for (const { root, manifest } of copies) {
    const target = join(destination, "node_modules", manifest.name);
    cpSync(root, target, { recursive: true, verbatimSymlinks: true, filter: (path) => path !== join(root, "node_modules") });
    writeFileSync(join(target, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const manifest = { ...cli, dependencies, bundledDependencies, overrides };
  if (Object.keys(optionalDependencies).length) manifest.optionalDependencies = optionalDependencies;
  // Pix is the application, so the bundled plugin's peers are implementation
  // dependencies here, not requirements on the consumer's global packages.
  delete manifest.peerDependencies;
  delete manifest.peerDependenciesMeta;
  delete manifest.private;
  writeFileSync(join(destination, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
