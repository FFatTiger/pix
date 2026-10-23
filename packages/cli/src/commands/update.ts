import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { npmExecutable, resolveNpmRegistryLatestUrl, UPDATE_PACKAGE_NAME as PACKAGE } from "@fffattiger/pix-host";
import { parseFlags } from "../args.js";
import { inspectSessiond } from "../supervise.js";
import { readHostRecord } from "../host-daemon.js";
import { stopServices } from "./stop.js";
import { resolveCliVersion } from "../index.js";
import { pixErr, pixLog } from "../log.js";

const REGISTRY_TIMEOUT_MS = 10_000;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * npm prefix of a global install of this package, or null when the package
 * does not live in a global node_modules (a workspace checkout or a project
 * dependency). POSIX globals sit in `<prefix>/lib/node_modules`, Windows
 * globals in `<prefix>/node_modules`.
 */
export function npmGlobalPrefix(packageRoot: string, platform: NodeJS.Platform = process.platform): string | null {
  const scopeDir = dirname(packageRoot);
  const modulesDir = dirname(scopeDir);
  if (basename(packageRoot) !== "pix-cli" || basename(scopeDir) !== "@fffattiger" || basename(modulesDir) !== "node_modules") {
    return null;
  }
  const parent = dirname(modulesDir);
  if (platform === "win32") return parent;
  return basename(parent) === "lib" ? dirname(parent) : null;
}

/** True when `candidate` is a later x.y.z than `current` (prerelease tags ignored). */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (value: string) => value.split("-")[0]!.split(".").map((part) => Number(part));
  const a = parse(candidate);
  const b = parse(current);
  for (let index = 0; index < 3; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (Number.isNaN(left) || Number.isNaN(right)) return false;
    if (left !== right) return left > right;
  }
  return false;
}

/**
 * Latest published version as reported by the registry npm would use for this
 * package (user mirror / scoped registry / npm default), so a configured
 * registry serves the check exactly like it serves `npm install -g`.
 */
async function fetchLatestVersion(): Promise<string | null> {
  try {
    const url = await resolveNpmRegistryLatestUrl();
    const response = await fetch(url, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
    if (!response.ok) return null;
    const body = await response.json() as { version?: unknown };
    return typeof body.version === "string" && VERSION_PATTERN.test(body.version) ? body.version : null;
  } catch {
    return null;
  }
}

/**
 * `pix update [version] [--check] [--restart]` — install the latest (or the
 * given) pix release from npm into the same global prefix this CLI runs from.
 * Running services keep the old code until restarted; `--restart` stops the
 * background host and sessiond and relaunches the host on the new version
 * (a foreground `pix start` must be restarted by whoever runs it).
 */
export async function updateCommand(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseFlags(argv);
  } catch (error) {
    pixErr((error as Error).message);
    return 2;
  }
  const requested = parsed.positional[0];
  if (parsed.positional.length > 1 || (requested !== undefined && !VERSION_PATTERN.test(requested))) {
    pixErr("usage: pix update [version] [--check] [--restart]");
    return 2;
  }
  const current = resolveCliVersion();
  let target = requested;
  if (target === undefined) {
    const latest = await fetchLatestVersion();
    if (latest === null) {
      pixErr("could not reach the npm registry to look up the latest version");
      return 1;
    }
    if (!isNewerVersion(latest, current)) {
      pixLog(`pix ${current} is up to date`);
      return 0;
    }
    target = latest;
  }
  if (target === current) {
    pixLog(`pix ${current} is already installed`);
    return 0;
  }
  pixLog(`pix ${current} → ${target}`);
  if (parsed.boolFlags.has("--check")) return 0;

  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const prefix = npmGlobalPrefix(packageRoot);
  if (prefix === null) {
    pixErr("this pix is not a global npm install, so it cannot update itself");
    pixErr(`install it with: npm install -g ${PACKAGE}@${target}`);
    return 1;
  }
  const npm = npmExecutable();
  const installed = spawnSync(npm, ["install", "-g", "--prefix", prefix, `${PACKAGE}@${target}`], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (installed.error !== undefined || installed.status !== 0) {
    pixErr(`npm install failed${installed.error ? `: ${installed.error.message}` : ` (exit ${installed.status ?? "signal"})`}`);
    return 1;
  }
  pixLog(`installed pix ${target}`);

  const status = await inspectSessiond();
  const previousHost = readHostRecord();
  if (!status.alive && previousHost.kind !== "ok") return 0;
  if (!parsed.boolFlags.has("--restart")) {
    pixLog(`the running pix is still ${current}; restarting interrupts running sessions`);
    pixLog(previousHost.kind === "ok"
      ? "to switch: run `pix restart --all`"
      : "to switch: stop `pix start` (or its service), run `pix down --all`, then `pix start`");
    return 0;
  }
  const stopped = await stopServices(true);
  if (stopped !== 0) return stopped;
  if (previousHost.kind !== "ok") {
    pixLog(`sessiond stopped; restart \`pix start\` (or its service) to run ${target}`);
    return 0;
  }
  // The background host is relaunched from a FRESH process so it loads the
  // newly installed code (this process still runs the old one).
  const relaunched = spawnSync(process.execPath, [
    join(packageRoot, "bin", "pix.mjs"),
    "start",
    "--detach",
    "--hostname",
    previousHost.record.hostname,
    "--port",
    String(previousHost.record.port),
  ], { stdio: "inherit" });
  if (relaunched.error !== undefined || relaunched.status !== 0) {
    pixErr(`could not restart the host on ${target}; run \`pix start --detach\``);
    return 1;
  }
  return 0;
}
