/**
 * Effective npm registry for the pix update check.
 *
 * `pix update` (packages/cli) and the About page's update check
 * (POST /v1/about/check-update) both need the `latest` document of the
 * distributed CLI package. A user with a private/mirrored npm registry
 * (`npm config set registry https://registry.npmmirror.com`) must have BOTH
 * checks go through that registry — the install step (`npm install -g`) already
 * does. So the registry is never hardcoded: it is read from npm's own resolved
 * configuration, which is the only authority for which registry npm will
 * actually use (user/global/project `.npmrc`, `npm_config_*`, and the
 * `@scope:registry` override).
 *
 * Resolution order, matching npm's own precedence:
 *   1. `@fffattiger:registry` (scoped registry for the pix CLI package);
 *   2. `registry` (the user's configured default registry);
 *   3. npm's public default, used only when npm itself cannot provide a value
 *      (npm not installed / config read failed). There is deliberately NO
 *      mirror→npmjs fallback: a mirror that lags behind on a version is
 *      accepted, and an unreachable registry stays an honest failure.
 *
 * Secrets never flow through this module: only the two registry keys are read
 * (never `npm config list`, whose output can carry auth tokens), and the result
 * is a URL.
 */
import { spawn } from "node:child_process";

/** The distributed pix CLI package the update check compares against. */
export const UPDATE_PACKAGE_NAME = "@fffattiger/pix-cli";

/** npm's public registry, used only when npm cannot report a configured one. */
export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";

/** Bounded `npm config get` read; a hung npm must not hang a startup/route. */
const NPM_CONFIG_TIMEOUT_MS = 10_000;

/** The scoped-registry key that takes precedence for the pix CLI package. */
const SCOPED_REGISTRY_KEY = `@${UPDATE_PACKAGE_NAME.split("/")[0]!.slice(1)}:registry`;

interface NpmRunResult {
  stdout: string;
  exitCode: number;
}

/** Runs `npm <args>` and returns its stdout; injected in tests. */
export type NpmRunner = (args: readonly string[]) => Promise<NpmRunResult>;

/**
 * The npm executable this process should spawn: the `.cmd` shim on win32 (which
 * Node can only reach through a shell), the real executable elsewhere.
 */
export function npmExecutable(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "npm.cmd" : "npm";
}

/**
 * Bounded `npm <args>` invocation. On win32 npm is a `.cmd` shim, which Node
 * can only spawn through a shell (the same reason `pix update` uses
 * `shell: true` there); POSIX spawns the real executable directly.
 * `--no-update-notifier` keeps a config read purely local (npm would otherwise
 * hit its own update-notifier endpoint).
 */
function runNpm(args: readonly string[]): Promise<NpmRunResult> {
  const windows = process.platform === "win32";
  const argv = [...args, "--no-update-notifier"];
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(npmExecutable(), argv, {
      shell: windows,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const stdout: Buffer[] = [];
    let settled = false;
    const finish = (error: Error | null, result?: NpmRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(result!);
    };
    const timer = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
      finish(new Error(`npm did not answer within ${NPM_CONFIG_TIMEOUT_MS}ms`));
    }, NPM_CONFIG_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      finish(null, { stdout: Buffer.concat(stdout).toString("utf8"), exitCode: code ?? 1 });
    });
  });
}

/** `npm config get <key>` → trimmed value, or null when npm has no value. */
async function npmConfigValue(run: NpmRunner, key: string): Promise<string | null> {
  let result: NpmRunResult;
  try {
    result = await run(["config", "get", key]);
  } catch {
    return null;
  }
  if (result.exitCode !== 0) return null;
  const value = result.stdout.trim();
  // npm prints the literal `undefined` for a key that is not set.
  if (value.length === 0 || value === "undefined" || value === "null") return null;
  return value;
}

/**
 * Accept only an http(s) registry base (npm also supports `file:`/`git:` URLs
 * for package specs, which can never serve a registry `latest` document).
 * Returns the base without a trailing slash.
 */
function normalizeRegistry(value: string | null): string | null {
  if (value === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return value.replace(/\/+$/, "");
}

/**
 * Registry base URL npm would use for the pix CLI package: the scoped registry
 * when configured, otherwise the user's default registry, otherwise npm's
 * public default (npm unavailable). Test seam: `run` replaces the npm call.
 */
export async function resolveNpmRegistry(run: NpmRunner = runNpm): Promise<string> {
  const scoped = normalizeRegistry(await npmConfigValue(run, SCOPED_REGISTRY_KEY));
  if (scoped !== null) return scoped;
  const configured = normalizeRegistry(await npmConfigValue(run, "registry"));
  if (configured !== null) return configured;
  return DEFAULT_NPM_REGISTRY;
}

/**
 * Full URL of the npm `latest` document for the pix CLI package, resolved
 * against the effective registry.
 */
export async function resolveNpmRegistryLatestUrl(
  options: { run?: NpmRunner; packageName?: string } = {},
): Promise<string> {
  const registry = await resolveNpmRegistry(options.run);
  const packageName = options.packageName ?? UPDATE_PACKAGE_NAME;
  return `${registry}/${packageName.replace("/", "%2f")}/latest`;
}
