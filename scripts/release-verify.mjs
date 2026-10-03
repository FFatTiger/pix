#!/usr/bin/env node
/**
 * REL1 release verification (§64.5) — fully offline, zero global state.
 *
 * Deterministic orchestration:
 *   build → assemble self-contained CLI bundle → tar.gz → install into a
 *   temp npm prefix (temp cache, offline) → smoke (`pix --version`, bundled
 *   daemon start, real RPC session round-trip, authenticated `pix down --all`)
 *   → upgrade simulation (vPrev install → persisted state → vNext overlay
 *   install → state readable by the upgraded daemon) → uninstall residue
 *   check.
 *
 * Every path (HOME, npm cache, prefix, bundle staging, daemon/agent/host
 * state) lives under a single temp sandbox removed on exit. No registry
 * access, no publish, no writes outside the sandbox.
 *
 * `--publishable` also creates a small `-npm.tgz` distribution that bundles Pix
 * and its patched plugin while declaring third-party npm dependencies. The
 * standalone archive remains the input for the offline checks below. The npm
 * archive needs a separate fresh registry install check before publication.
 * This script never publishes.
 *
 * Usage: node scripts/release-verify.mjs [--keep] [--skip-build] [--publishable]
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { patchPiClaudeSubagents } from "./patch-pi-claude-subagents.mjs";
import { createRegistryPackage } from "./release-package.mjs";
import { resolveNpmInvocation } from "./run-workspaces.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const KEEP = process.argv.includes("--keep");
const SKIP_BUILD = process.argv.includes("--skip-build");
const PUBLISHABLE = process.argv.includes("--publishable");

/** Workspace packages shipped inside the bundle's node_modules (the CLI
 * runtime closure). `client` is not here: its built Vite dist ships as static
 * files at `<bundle>/client` (served by the host, never imported). */
const CLOSURE_PACKAGES = [
  "protocol",
  "runtime-core",
  "local-authority",
  "pi-sdk-adapter",
  "agent-worker",
  "sessiond",
  "host",
];

const log = (msg) => console.log(`[release-verify] ${msg}`);
const fail = (msg) => {
  console.error(`[release-verify] FAIL: ${msg}`);
  killChildren();
  process.exit(1);
};

/** True when `child` is `parent` itself or strictly beneath it. */
function isWithin(parent, child) {
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child === parent || child.startsWith(prefix);
}

let npmInvocation;
/** npm as a JS CLI through the current Node (no PATH shim, no shell). */
function runNpm(args, opts = {}) {
  npmInvocation ??= resolveNpmInvocation();
  const result = spawnSync(npmInvocation.command, [...npmInvocation.args, ...args], { stdio: "inherit", ...opts });
  if (result.status !== 0) fail(`npm failed (${result.status}): npm ${args.join(" ")}`);
  return result;
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (result.status !== 0) fail(`command failed (${result.status}): ${cmd} ${args.join(" ")}`);
  return result;
}

function capture(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (result.status !== 0) {
    fail(`command failed (${result.status}): ${cmd} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

/** Assemble the self-contained bundle layout at `<stage>/package/`. */
function assembleBundle(stage, bundleVersion, { publishable = false } = {}) {
  const pkg = join(stage, "package");
  rmSync(pkg, { recursive: true, force: true });
  mkdirSync(pkg, { recursive: true });

  // CLI: manifest (deps stripped — the closure is inlined), bin, dist.
  const cliManifest = JSON.parse(readFileSync(join(ROOT, "packages/cli/package.json"), "utf8"));
  const bundleManifest = {
    name: cliManifest.name,
    version: bundleVersion,
    // Publishable tarballs must not carry `private: true` (npm publish would
    // reject with EPRIVATE); the default verify flow keeps it.
    ...(publishable ? {} : { private: true }),
    type: "module",
    description: cliManifest.description,
    ...(cliManifest.repository === undefined ? {} : { repository: cliManifest.repository }),
    ...(cliManifest.homepage === undefined ? {} : { homepage: cliManifest.homepage }),
    ...(cliManifest.bugs === undefined ? {} : { bugs: cliManifest.bugs }),
    ...(cliManifest.license === undefined ? {} : { license: cliManifest.license }),
    ...(cliManifest.engines === undefined ? {} : { engines: cliManifest.engines }),
    ...(publishable ? { publishConfig: { access: "public" } } : {}),
    main: cliManifest.main,
    types: cliManifest.types,
    exports: cliManifest.exports,
    bin: cliManifest.bin,
  };
  writeFileSync(join(pkg, "package.json"), `${JSON.stringify(bundleManifest, null, 2)}\n`);
  cpSync(join(ROOT, "packages/cli/bin"), join(pkg, "bin"), { recursive: true });
  cpSync(join(ROOT, "packages/cli/dist"), join(pkg, "dist"), { recursive: true });

  // Client dist → <bundle>/client (resolveClientDist bundle fallback).
  cpSync(join(ROOT, "packages/client/dist"), join(pkg, "client"), { recursive: true });

  if (publishable) {
    for (const doc of ["README.md", "THIRD_PARTY_NOTICES.md", "LICENSE"]) {
      const src = join(ROOT, doc);
      if (existsSync(src)) cpSync(src, join(pkg, doc));
    }
  }

  // External closure: the workspace root node_modules minus the @fffattiger
  // workspace symlinks (replaced by real package dirs below). No pruning —
  // correctness over size (frozen §64.1 decision). Symlinks are copied
  // verbatim (never dereferenced) so no absolute source path can leak into
  // the archive; `.bin` shim dirs are dropped (the installing npm recreates
  // bins from the manifest) and every surviving symlink is audited below.
  const nm = join(pkg, "node_modules");
  cpSync(join(ROOT, "node_modules"), nm, { recursive: true, verbatimSymlinks: true });
  rmSync(join(nm, "@fffattiger"), { recursive: true, force: true });
  mkdirSync(join(nm, "@fffattiger"), { recursive: true });
  for (const name of CLOSURE_PACKAGES) {
    const src = join(ROOT, "packages", name);
    const dest = join(nm, "@fffattiger", `pix-${name}`);
    mkdirSync(dest, { recursive: true });
    cpSync(join(src, "package.json"), join(dest, "package.json"));
    cpSync(join(src, "dist"), join(dest, "dist"), { recursive: true });
  }

  // Pin the vendored patched plugin: the bundled copy must ALREADY be the
  // patched build (prebuild ran). A pristine copy here means the assembly
  // captured an unpatched tree — fail closed instead of shipping drift.
  try {
    if (patchPiClaudeSubagents(join(nm, "pi-claude-subagents"))) {
      fail("bundled pi-claude-subagents was pristine (prebuild patch had not run)");
    }
  } catch (error) {
    fail(`bundled pi-claude-subagents pin failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  normalizeAndAuditArchive(pkg);
  return pkg;
}

/** npm-normalized archive permissions + fail-closed symlink-escape audit.
 *
 * Walks the assembled package: directories 0755, regular files 0644 except the
 * bin shims (0755). Any `.bin` directory under node_modules is removed (raw
 * shim symlinks are recreated by the installing npm). Every surviving symlink
 * must resolve strictly inside the package — an absolute or escaping target
 * would tie the artifact to this source tree. */
function normalizeAndAuditArchive(pkg) {
  const binScripts = new Set(Object.values(JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).bin ?? {}));
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".bin" && isWithin(join(pkg, "node_modules"), dir)) {
          rmSync(path, { recursive: true, force: true });
          continue;
        }
        chmodSync(path, 0o755);
        walk(path);
      } else if (entry.isSymbolicLink()) {
        const link = readlinkSync(path);
        const target = resolve(dir, link);
        if (isAbsolute(link) || !isWithin(pkg, target)) {
          fail(`archive symlink escapes the bundle: ${path} -> ${target}`);
        }
      } else if (entry.isFile()) {
        const relativePath = relative(pkg, path).split(sep).join("/");
        const executable = (statSync(path).mode & 0o111) !== 0
          || binScripts.has(relativePath) || binScripts.has(`./${relativePath}`);
        chmodSync(path, executable ? 0o755 : 0o644);
      }
    }
  };
  chmodSync(pkg, 0o755);
  walk(pkg);
}

/** Pack `<stage>/package` into a tarball (npm layout: top-level `package/`). */
function packBundle(stage, tarball) {
  run("tar", ["-czf", tarball, "-C", stage, "package"]);
}

/** Wait until `predicate` is true, bounded by `timeoutMs`. */
async function waitFor(label, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  fail(`timeout waiting for ${label}`);
}

/** Promise resolved with the child's exit code, settled exactly once. Attach
 * immediately at spawn time so a fast exit (e.g. RPC shutdown completing
 * before the caller awaits) can never be missed. */
function exitCodePromise(child) {
  return new Promise((resolveExit) => {
    child.once("exit", (code) => resolveExit(code));
  });
}

/** Await `promise` bounded by `timeoutMs`; fail (never hang) on timeout. */
async function withTimeout(promise, label, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Write a probe script that drives the bundled sessiond RPC client. */
function writeRpcProbe(sandbox, file, sessiondPkg, body) {
  const probe = join(sandbox, file);
  writeFileSync(
    probe,
    `import { createRequire } from "node:module";
const require = createRequire(${JSON.stringify(join(sessiondPkg, "package.json"))});
const { SessiondRpcClient } = await import(${JSON.stringify(join(sessiondPkg, "dist", "client.js"))});
const client = new SessiondRpcClient({ endpoint: process.argv[2], secret: process.argv[3] });
try {
${body}
} catch (error) {
  console.error("probe failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}
`,
    { flag: "w" },
  );
  return probe;
}

async function runAll(sandbox) {
  if (!SKIP_BUILD) {
    log(`step 1/8: workspace build${PUBLISHABLE ? " (publishable mode)" : ""}`);
    runNpm(["run", "build"], { cwd: ROOT });
  } else {
    log(`step 1/8: build skipped (--skip-build)${PUBLISHABLE ? " (publishable mode)" : ""}`);
  }

  log("step 2/8: version consistency");
  run("node", [join(ROOT, "scripts/sync-version.mjs"), "check"], { cwd: ROOT });

  const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const [major, minor, patch] = version.split(".").map((p) => Number(p));
  const nextVersion = `${major}.${minor}.${patch + 1}`;

  log(`step 3/8: assemble + pack bundles v${version} / v${nextVersion} (upgrade sim)`);
  const stage = join(sandbox, "stage");
  mkdirSync(stage, { recursive: true });
  assembleBundle(stage, version, { publishable: PUBLISHABLE });
  const tarball = join(sandbox, `pix-cli-${version}.tgz`);
  packBundle(stage, tarball);
  const stageNext = join(sandbox, "stage-next");
  mkdirSync(stageNext, { recursive: true });
  assembleBundle(stageNext, nextVersion, { publishable: PUBLISHABLE });
  const tarballNext = join(sandbox, `pix-cli-${nextVersion}.tgz`);
  packBundle(stageNext, tarballNext);

  if (PUBLISHABLE) {
    // Publishability gates, offline: private must be absent/true-rejected,
    // registry metadata present, integrity recorded for the handoff.
    const publishableManifest = JSON.parse(readFileSync(join(stage, "package", "package.json"), "utf8"));
    if (publishableManifest.private === true) fail("publishable manifest still declares private: true (npm publish would EPRIVATE)");
    for (const field of ["name", "version", "description", "bin", "engines", "repository"]) {
      if (publishableManifest[field] === undefined) fail(`publishable manifest is missing registry field: ${field}`);
    }
    const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    const bytes = statSync(tarball).size;
    writeFileSync(join(sandbox, `pix-cli-${version}.tgz.sha256`), `${digest}  pix-cli-${version}.tgz\n`);
    log(`  standalone artifact: ${tarball}`);
    log(`  sha256 ${digest} (${(bytes / 1_048_576).toFixed(1)} MiB)`);
    const registryStage = join(sandbox, "registry-stage");
    const rootManifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    createRegistryPackage(join(stage, "package"), join(registryStage, "package"), rootManifest.overrides ?? {});
    const registryTarball = join(sandbox, `pix-cli-${version}-npm.tgz`);
    packBundle(registryStage, registryTarball);
    rmSync(registryStage, { recursive: true, force: true });
    log(`  npm artifact (registry dependencies): ${registryTarball}`);
    log("  verify the npm artifact with a fresh npm install before publishing");
  }

  // Installation uses the tarballs; drop duplicate staging trees before npm
  // creates its cache and upgrade directories.
  rmSync(stage, { recursive: true, force: true });
  rmSync(stageNext, { recursive: true, force: true });

  const prefix = join(sandbox, "prefix");
  const npmCache = join(sandbox, "npm-cache");
  mkdirSync(prefix, { recursive: true });
  mkdirSync(npmCache, { recursive: true });
  const npmInstall = (tgz) =>
    runNpm(
      ["install", "--global", "--prefix", prefix, "--cache", npmCache, "--offline", "--no-audit", "--no-fund", "--no-update-notifier", tgz],
      { cwd: sandbox },
    );

  log(`step 4/8: offline install v${version} into temp prefix (fresh empty cache)`);
  npmInstall(tarball);

  const pixBin = join(prefix, "bin", "pix");
  const sessiondBinPath = join(prefix, "bin", "pix-sessiond");
  if (!existsSync(pixBin) || !existsSync(sessiondBinPath)) fail("bundled bins not linked after install");
  // The installed CLI must be a real extracted directory, never a link back
  // into a source workspace.
  const installedPkgStat = lstatSync(join(prefix, "lib", "node_modules", "@fffattiger", "pix-cli"));
  if (!installedPkgStat.isDirectory()) fail("installed CLI package is not a real directory (workspace/symlink leak)");
  const versionOut = capture(pixBin, ["--version"]).trim().replace(/^\[pix\]\s*/, "");
  if (versionOut !== `pix ${version}`) fail(`--version mismatch: "${versionOut}"`);
  log(`  pix --version -> "${versionOut}"`);

  // State sandbox (§64.4: all persisted state keyed by absolute env paths,
  // never by package version — the upgrade simulation relies on this).
  const state = join(sandbox, "state");
  const workspace = join(sandbox, "workspace");
  const sandboxEnv = () => ({
    ...process.env,
    PIX_SESSIOND_DIR: join(state, "sessiond"),
    PI_CODING_AGENT_DIR: join(state, "agent"),
    PIX_HOST_DIR: join(state, "host"),
    HOME: join(sandbox, "home"),
  });
  mkdirSync(join(sandbox, "home"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const sessiondDir = join(state, "sessiond");
  const sessiondPkg = join(
    prefix, "lib", "node_modules", "@fffattiger", "pix-cli", "node_modules", "@fffattiger", "pix-sessiond",
  );
  if (!existsSync(sessiondPkg)) fail(`bundled sessiond package missing at ${sessiondPkg}`);

  log("step 5/8: bundled daemon + real RPC session round-trip");
  const daemon = spawnChild(sessiondBinPath, [], { env: sandboxEnv(), stdio: ["ignore", "ignore", "pipe"] });
  const daemonExit = exitCodePromise(daemon);
  let daemonErr = "";
  daemon.stderr.on("data", (c) => { daemonErr += c; });
  await waitFor("daemon socket", () => existsSync(join(sessiondDir, "sessiond.sock")));
  const secret = readFileSync(join(sessiondDir, "sessiond.secret"), "utf8").trim();

  const roundTripProbe = writeRpcProbe(sandbox, "rpc-roundtrip.mjs", sessiondPkg, `
  const hello = await client.call("system.hello", {});
  if (hello.build.product !== ${JSON.stringify(version)}) throw new Error("bundled product build version does not match the release");
  const created = await client.call("runtime.create", {
    createRequestId: "rel1-verify-create",
    cwd: ${JSON.stringify(workspace)},
    projectRoot: ${JSON.stringify(workspace)},
  });
  const sessionId = created.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("create returned no session id");
  const snap = await client.call("runtime.getSnapshot", { sessionId });
  if (snap?.state?.sessionId !== sessionId) throw new Error("snapshot identity mismatch");
  await client.call("runtime.stop", { sessionId });
  console.log(JSON.stringify({ sessionId }));
`);
  const roundTrip = JSON.parse(
    capture("node", [roundTripProbe, join(sessiondDir, "sessiond.sock"), secret], { env: sandboxEnv() }).trim(),
  );
  log(`  RPC round-trip OK (session ${roundTrip.sessionId.slice(0, 12)}… created → snapshot → stopped)`);

  log("step 6/8: authenticated `pix down --all` (RPC shutdown, no signals)");
  const down = spawnSync(pixBin, ["down", "--all"], { env: sandboxEnv(), encoding: "utf8" });
  if (down.status !== 0) fail(`pix down --all exited ${down.status}: ${down.stdout} ${down.stderr}`);
  const exitCode = await withTimeout(daemonExit, "daemon exit after shutdown", 20_000);
  if (exitCode !== 0) fail(`daemon exit ${exitCode} after shutdown (stderr tail: ${daemonErr.slice(-300)})`);
  if (existsSync(join(sessiondDir, "sessiond.sock"))) fail("socket not removed after shutdown");
  log("  daemon exited 0 via authenticated RPC; socket removed");

  log("step 7/8: upgrade simulation (state must survive)");
  // Persisted state from the vPrev era: a REAL session JSONL written offline
  // via the bundled Pi SDK (SessionManager defers file writes until an
  // assistant message exists — a create→stop empty session never persists,
  // §57 semantics) + a host ledger file. All path-keyed, version-independent.
  mkdirSync(join(state, "agent", "agent", "sessions"), { recursive: true });
  mkdirSync(join(state, "host"), { recursive: true });
  const sdkPkg = join(
    prefix, "lib", "node_modules", "@fffattiger", "pix-cli", "node_modules",
    "@earendil-works", "pi-coding-agent",
  );
  if (!existsSync(sdkPkg)) fail(`bundled Pi SDK missing at ${sdkPkg}`);
  const persistProbe = join(sandbox, "persist-session.mjs");
  writeFileSync(
    persistProbe,
    `import { createRequire } from "node:module";
const require = createRequire(${JSON.stringify(join(sdkPkg, "package.json"))});
const mod = await import(${JSON.stringify(join(sdkPkg, "dist", "index.js"))});
const { SessionManager } = mod;
const manager = SessionManager.create(process.argv[2]);
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
manager.appendMessage({ role: "user", content: "rel1 upgrade sim", timestamp: Date.now() });
manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "persisted by vPrev" }], provider: "rel1", model: "rel1", usage, stopReason: "stop", timestamp: Date.now() });
console.log(JSON.stringify({ sessionId: manager.getSessionId(), file: manager.getSessionFile() }));
`,
    { flag: "w" },
  );
  const persisted = JSON.parse(
    capture("node", [persistProbe, workspace], { env: sandboxEnv() }).trim(),
  );
  if (typeof persisted.file !== "string" || !existsSync(persisted.file)) {
    fail("vPrev session JSONL was not persisted");
  }
  log(`  vPrev persisted session ${persisted.sessionId.slice(0, 12)}… (${persisted.file.split("/").pop()})`);
  writeFileSync(
    join(state, "host", "trusted-roots.json"),
    `${JSON.stringify({ kind: "pix.trusted-roots", version: 1, instanceId: "rel1-upgrade-sim", roots: [] }, null, 2)}\n`,
  );
  npmInstall(tarballNext);
  const versionNext = capture(pixBin, ["--version"], { env: sandboxEnv() }).trim().replace(/^\[pix\]\s*/, "");
  if (versionNext !== `pix ${nextVersion}`) fail(`post-upgrade --version mismatch: "${versionNext}"`);
  log(`  overlay install OK: ${versionNext}`);

  const daemon2 = spawnChild(sessiondBinPath, [], { env: sandboxEnv(), stdio: ["ignore", "ignore", "pipe"] });
  const daemon2Exit = exitCodePromise(daemon2);
  let daemon2Err = "";
  daemon2.stderr.on("data", (c) => { daemon2Err += c; });
  await waitFor("vNext daemon socket", () => existsSync(join(sessiondDir, "sessiond.sock")));
  const secret2 = readFileSync(join(sessiondDir, "sessiond.secret"), "utf8").trim();

  const listProbe = writeRpcProbe(sandbox, "rpc-list.mjs", sessiondPkg, `
  const list = await client.call("sessions.list", { page: 1, pageSize: 20 });
  if (!Array.isArray(list.sessions)) throw new Error("sessions.list returned no array");
  if (!list.sessions.some((session) => session.id === ${JSON.stringify(persisted.sessionId)})) throw new Error("vNext daemon cannot find the exact vPrev session");
  const context = await client.call("sessions.context", { sessionId: ${JSON.stringify(persisted.sessionId)} });
  const text = JSON.stringify(context);
  if (!text.includes("rel1 upgrade sim") || !text.includes("persisted by vPrev")) throw new Error("upgraded context lost persisted messages");
  const running = await client.call("runtime.listRunning", {});
  if (running.sessions.length !== 0) throw new Error("reading upgraded history started a Worker");
  console.log(JSON.stringify({ count: list.sessions.length, total: list.total }));
`);
  const listOut = JSON.parse(
    capture("node", [listProbe, join(sessiondDir, "sessiond.sock"), secret2], { env: sandboxEnv() }).trim(),
  );
  log(`  vNext daemon serves vPrev-era catalog (sessions under workspace: ${listOut.count}, total ${listOut.total})`);

  const down2 = spawnSync(pixBin, ["down", "--all"], { env: sandboxEnv(), encoding: "utf8" });
  if (down2.status !== 0) fail(`vNext pix down failed: ${down2.stderr}`);
  const exit2 = await withTimeout(daemon2Exit, "vNext daemon exit after shutdown", 20_000);
  if (exit2 !== 0) fail(`vNext daemon exit ${exit2} (stderr tail: ${daemon2Err.slice(-300)})`);
  log("  vNext daemon shut down cleanly");

  log("step 8/8: uninstall residue check");
  runNpm(["uninstall", "--global", "--prefix", prefix, "--cache", npmCache, "--offline", "--no-audit", "--no-fund", "--no-update-notifier", "@fffattiger/pix-cli"], { cwd: sandbox });
  if (existsSync(pixBin) || existsSync(sessiondBinPath)) fail("CLI bins remain after uninstall");
  if (!existsSync(persisted.file)) fail("uninstall removed persisted session data");
  if (existsSync(join(sessiondDir, "sessiond.sock"))) fail("socket residue after uninstall");
  log(`  CLI uninstalled; declared state dirs retained by design (${state})`);

  log("RELEASE VERIFY: ALL PASS");
}

const children = new Set();
function spawnChild(cmd, args, opts) {
  const child = spawn(cmd, args, opts);
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}
function killChildren() {
  for (const child of children) {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
}

async function main() {
  const sandbox = mkdtempSync(join(tmpdir(), "pix-rel1-"));
  try {
    await runAll(sandbox);
    if (KEEP) log(`--keep: sandbox retained at ${sandbox}`);
    else rmSync(sandbox, { recursive: true, force: true });
  } catch (error) {
    killChildren();
    if (KEEP) log(`--keep: sandbox retained at ${sandbox}`);
    else {
      // Give daemons a moment to release sockets before removing the sandbox.
      setTimeout(() => rmSync(sandbox, { recursive: true, force: true }), 300);
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(`[release-verify] FAIL: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
