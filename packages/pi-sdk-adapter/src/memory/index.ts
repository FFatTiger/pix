// Public memory surface of the pix Pi SDK Adapter.
//
// Lore connection management for the Pix settings "记忆" page: saves the
// shared `~/.lore/config.json` connection (0600, unknown keys preserved,
// token write-only) and probes `GET <base>/api/health`. Pix never installs
// or updates the Lore extension/CLI — the extension is bundled (vendor
// tgz) and only the connection settings are managed here. The memory
// PROVIDER itself (`pixMemoryProvider` in settings.json) is owned by the
// settings store (see /settings subpath readMemoryConfig / writeMemoryProvider).
import type { LoreConnectionMutation, LoreConnectionSnapshot, LoreTestOutcome, LoreTestRequest } from "@fffattiger/pix-runtime-core";
import { detectLoreConnection as detectInternal, saveLoreConnection as saveInternal, testLoreConnection as testInternal } from "../internal/lore-config-store.js";

export interface PiSdkLoreConnectionOptions {
  /** Environment override for LORE_HOME / LORE_BASE_URL / LORE_API_TOKEN (tests). */
  env?: NodeJS.ProcessEnv;
  /** Fetch implementation override for the connection probe (tests). */
  fetchImpl?: typeof fetch;
}

export interface PiSdkLoreConnectionConfig {
  /** Effective Lore connection facts (config file first, then env; no secrets). */
  detectLoreConnection(): LoreConnectionSnapshot;
  /** Save the connection into ~/.lore/config.json; returns the new facts. */
  saveLoreConnection(input: LoreConnectionMutation): Promise<LoreConnectionSnapshot>;
  /** Probe the server health endpoint; a failed probe is a normal outcome. */
  testLoreConnection(input: LoreTestRequest): Promise<LoreTestOutcome>;
}

/** Create the Lore connection authority for the settings "记忆" page. */
export function createPiSdkLoreConnectionConfig(
  options: PiSdkLoreConnectionOptions = {},
): PiSdkLoreConnectionConfig {
  return {
    detectLoreConnection: () => detectInternal(options.env ?? process.env),
    saveLoreConnection: (input) => saveInternal(input, { env: options.env ?? process.env }),
    testLoreConnection: (input) => testInternal(input, {
      env: options.env ?? process.env,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    }),
  };
}
