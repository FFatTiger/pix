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
  const pluginRoot = join(standalone, "node_modules", "pi-claude-subagents");
  const plugin = readJson(join(pluginRoot, "package.json"));
  if (plugin.name !== "pi-claude-subagents") throw new Error("bundled plugin identity mismatch");
  // Pi 1.0.0 publishes a workspace shrinkwrap that makes clean global npm
  // installs drop dependencies. Bundle its unchanged code without that file.
  // Remove this bridge before upgrading away from SDK 1.0.0, once a clean
  // registry install passes without it.
  const sdkRoot = join(standalone, "node_modules", "@earendil-works", "pi-coding-agent");
  const sdk = readJson(join(sdkRoot, "package.json"));
  if (sdk.name !== "@earendil-works/pi-coding-agent" || sdk.version !== "1.0.0") throw new Error("remove the SDK 1.0.0 shrinkwrap bridge before upgrading");
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
  const bundledDependencies = [...runtime.map(({ manifest }) => manifest.name), sdk.name, plugin.name];
  const bundled = new Set(bundledDependencies);
  const dependencies = {};
  const optionalDependencies = {};
  const peerDependencies = {};
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
  function normalize(manifest) {
    const copy = { ...manifest };
    delete copy.devDependencies;
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      const internal = {};
      for (let [name, version] of Object.entries(manifest[section] ?? {})) {
        if (name === plugin.name) {
          if (typeof version !== "string" || (!version.startsWith("file:") && version !== plugin.version)) throw new Error("bundled plugin does not match the runtime dependency");
          version = plugin.version;
        }
        validate(name, version);
        if (bundled.has(name)) {
          internal[name] = version;
          depend(name, version);
        } else if (section === "peerDependencies") {
          if (peerDependencies[name] !== undefined && peerDependencies[name] !== version) throw new Error(`conflicting runtime peer: ${name}`);
          peerDependencies[name] = version;
          const meta = manifest.peerDependenciesMeta?.[name];
          if (!dependencies[name] && !meta?.optional) depend(name, readJson(join(standalone, "node_modules", name, "package.json")).version);
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
  const copies = [...runtime, { root: sdkRoot, manifest: sdk }, { root: pluginRoot, manifest: plugin }].map(({ root, manifest }) => {
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
    if (manifest.name === sdk.name) rmSync(join(target, "npm-shrinkwrap.json"), { force: true });
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
