/**
 * Production about-facts composition (GET /v1/about / POST /v1/about/check-update).
 *
 * The one composition place that reads the actually installed manifests: the
 * host's own package.json for the Pix version, and the adapter's about
 * projection (pi-coding-agent + curated bundled plugins) for everything the
 * Host must never resolve itself. Nothing is compiled in; a release bump is
 * picked up from the installed packages.
 */
import { readFileSync } from "node:fs";
import { readPiSdkAboutFacts } from "@fffattiger/pix-pi-sdk-adapter/about";
import type { AboutFacts } from "../routes/about.js";

let cached: AboutFacts | undefined;

/** Read once per process; versions are immutable while the host runs. */
export function createProductionAboutFacts(): AboutFacts {
  cached ??= (() => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    const pixVersion = manifest !== null && typeof manifest === "object" && !Array.isArray(manifest)
      ? (manifest as { version?: unknown }).version
      : undefined;
    if (typeof pixVersion !== "string" || pixVersion.length === 0) {
      throw new Error("host package.json has no version");
    }
    const sdk = readPiSdkAboutFacts();
    return {
      pixVersion,
      piCodingAgentVersion: sdk.piCodingAgentVersion,
      plugins: sdk.plugins.map((plugin) => ({ ...plugin })),
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    };
  })();
  return cached;
}
