import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundledPluginRoots } from "./curated-plugins.js";

export interface PiSdkAboutPlugin {
  /** Curated plugin id (adapter `CURATED_PLUGIN_IDS` vocabulary). */
  id: string;
  /** Installed npm package name. */
  name: string;
  /** Version from the installed manifest. */
  version: string;
}

export interface PiSdkAboutFacts {
  piCodingAgentVersion: string;
  plugins: readonly PiSdkAboutPlugin[];
}

const PI_CODING_AGENT = "@earendil-works/pi-coding-agent";
const requireFromHere = createRequire(import.meta.url);

/**
 * Resolve the installed pi-coding-agent manifest. `require.resolve` fails for
 * `package.json` when the package restricts its `exports` (pi-coding-agent
 * does), so fall back to the same upward node_modules walk the curated-plugin
 * resolver uses.
 */
function findPiCodingAgentManifest(): string {
  try {
    return requireFromHere.resolve(`${PI_CODING_AGENT}/package.json`);
  } catch {
    let dir = fileURLToPath(new URL(".", import.meta.url));
    while (true) {
      const candidate = join(dir, "node_modules", ...PI_CODING_AGENT.split("/"), "package.json");
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw new Error(`pi-coding-agent is not installed: ${PI_CODING_AGENT}`);
  }
}

function readPiCodingAgentVersion(): string {
  const raw: unknown = JSON.parse(readFileSync(findPiCodingAgentManifest(), "utf8"));
  const version = raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as { version?: unknown }).version
    : undefined;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("pi-coding-agent manifest has no version");
  }
  return version;
}

let cached: PiSdkAboutFacts | undefined;

/** Version facts for the process lifetime; resolved once from installed manifests. */
export function readPiSdkAboutFacts(): PiSdkAboutFacts {
  cached ??= {
    piCodingAgentVersion: readPiCodingAgentVersion(),
    plugins: bundledPluginRoots().map((root) => ({ id: root.id, name: root.packageName, version: root.version })),
  };
  return cached;
}
