// Public settings surface of the pix Pi SDK Adapter.
//
// Raw-text editor for the GLOBAL `<agentDir>/settings.json` (the file shared
// with the pi CLI). The store never interprets or rewrites the user's bytes:
// reads return the exact source text (comments preserved), writes validate the
// candidate offline (Pi loader tolerance + consumed-field type checks), fence
// on a SHA-256 revision, and persist via an owner-only atomic document write.
import type { SettingsConfigStorePort } from "@fffattiger/pix-runtime-core";
import { createPiSdkSettingsConfigStore as createInternalStore } from "../internal/settings-config-store.js";

export interface PiSdkSettingsConfigOptions {
  /** Agent config directory; defaults to the SDK agent dir. */
  agentDir?: string;
}

/** Create the global settings.json raw-text editor authority. */
export function createPiSdkSettingsConfig(
  options: PiSdkSettingsConfigOptions = {},
): SettingsConfigStorePort {
  return createInternalStore({
    ...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
  });
}
