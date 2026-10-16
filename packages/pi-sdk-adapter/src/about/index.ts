// Public Pix about-facts surface of the pix Pi SDK Adapter.
//
// Read-only version projection backing GET /v1/about: the installed
// pi-coding-agent version and the curated bundled-plugin manifest versions.
// The resolution itself lives in src/internal (beside the curated-plugin
// resolver); the Host consumes this projection and never reads Pi SDK or
// plugin files itself. Types are declared here so public declarations never
// leak internal modules (structurally identical to the internal result).
import { readPiSdkAboutFacts as readInternalAboutFacts } from "../internal/about-facts.js";

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

/** Version facts for the process lifetime; resolved once from installed manifests. */
export function readPiSdkAboutFacts(): PiSdkAboutFacts {
  return readInternalAboutFacts();
}
