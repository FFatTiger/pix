import type { Hono } from "hono";
import type { HostEnv } from "../env.js";
import type { HostLogger } from "../types.js";

/** Bounded npm-registry probe: fail closed to `unreachable` after 5 s. */
const UPDATE_CHECK_TIMEOUT_MS = 5_000;

/** npm registry `latest` document for the distributed pix CLI package. */
const DEFAULT_REGISTRY_LATEST_URL = "https://registry.npmjs.org/@fffattiger%2fpix-cli/latest";

/** The distributed pix CLI package the update check compares against. */
export const UPDATE_PACKAGE_NAME = "@fffattiger/pix-cli";

export interface AboutPluginFact {
  id: string;
  name: string;
  version: string;
}

/**
 * Version facts behind GET /v1/about. Every field is resolved at composition
 * time from the actually installed package manifests / running process —
 * never compiled in. Defaults for node/platform/arch read the live process so
 * a composed `facts` only has to carry the package-derived fields.
 */
export interface AboutFacts {
  pixVersion: string;
  piCodingAgentVersion: string;
  plugins: readonly AboutPluginFact[];
  nodeVersion?: string;
  platform?: string;
  arch?: string;
}

export interface AboutDeps {
  facts: AboutFacts;
  /** Outbound fetch for the npm registry probe; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Registry `latest` URL override (tests inject a local mock). */
  registryLatestUrl?: string;
}

export interface AboutRouteDeps extends AboutDeps {
  logger: HostLogger;
}

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

interface SemverParts {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly string[];
}

function parseSemver(value: string): SemverParts | null {
  const match = SEMVER_PATTERN.exec(value);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  };
}

/**
 * Compare two semver strings: -1 / 0 / 1, or null when either side is not
 * plain semver (the caller then fails closed instead of guessing). Build
 * metadata is ignored per semver; a prerelease sorts below the release.
 */
export function compareSemver(a: string, b: string): number | null {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return null;
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const shared = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < shared; index += 1) {
    const li = left.prerelease[index]!;
    const ri = right.prerelease[index]!;
    const ln = /^\d+$/.test(li);
    const rn = /^\d+$/.test(ri);
    if (ln && rn) {
      if (Number(li) !== Number(ri)) return Number(li) < Number(ri) ? -1 : 1;
    } else if (ln !== rn) {
      return ln ? -1 : 1;
    } else if (li !== ri) {
      return li < ri ? -1 : 1;
    }
  }
  if (left.prerelease.length !== right.prerelease.length) {
    return left.prerelease.length < right.prerelease.length ? -1 : 1;
  }
  return 0;
}

/**
 * About routes (read-only, behind the gate like every /v1 API):
 *  - GET  /v1/about               → version/runtime/plugin facts
 *  - POST /v1/about/check-update  → bounded npm `latest` probe for
 *    `@fffattiger/pix-cli`; registry failures answer `latest: null`
 *    (unreachable), never a fabricated version.
 */
export function registerAboutRoutes(app: Hono<HostEnv>, deps: AboutRouteDeps): void {
  const body = {
    pix: { version: deps.facts.pixVersion },
    pi: { codingAgent: deps.facts.piCodingAgentVersion },
    node: deps.facts.nodeVersion ?? process.versions.node,
    platform: deps.facts.platform ?? process.platform,
    arch: deps.facts.arch ?? process.arch,
    plugins: deps.facts.plugins.map((plugin) => ({ ...plugin })),
  };

  app.get("/v1/about", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(body);
  });

  app.post("/v1/about/check-update", async (c) => {
    c.header("Cache-Control", "no-store");
    const current = deps.facts.pixVersion;
    let latest: string | null = null;
    try {
      const fetchImpl = deps.fetch ?? fetch;
      const response = await fetchImpl(deps.registryLatestUrl ?? DEFAULT_REGISTRY_LATEST_URL, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
      });
      if (response.ok) {
        const parsed: unknown = await response.json();
        const version = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as { version?: unknown }).version
          : undefined;
        if (typeof version === "string" && version.length > 0) latest = version;
      }
    } catch (error) {
      deps.logger.warn?.(`about check-update registry probe failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const comparison = latest === null ? null : compareSemver(latest, current);
    return c.json({ current, latest, updateAvailable: comparison === 1, package: UPDATE_PACKAGE_NAME });
  });
}
