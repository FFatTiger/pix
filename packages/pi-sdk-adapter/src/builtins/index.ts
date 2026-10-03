// Public Pix built-in desired-enablement surface of the pix Pi SDK Adapter.
//
// Durable owner of `$PI_CODING_AGENT_DIR/pix-builtins.json`. Canonical feature
// booleans only — Pi package-name mapping is not part of this store.
import type { BuiltInCapabilityConfigStorePort } from "@fffattiger/pix-runtime-core";
import { createPiSdkBuiltInCapabilityConfigStore as createInternalStore } from "../internal/built-in-capability-store.js";

export interface PiSdkBuiltInCapabilityConfigOptions {
  /** Agent config directory; defaults to the SDK agent dir. */
  agentDir?: string;
}

/** Create the Pix built-in desired-enablement authority. */
export function createPiSdkBuiltInCapabilityConfig(
  options: PiSdkBuiltInCapabilityConfigOptions = {},
): BuiltInCapabilityConfigStorePort {
  return createInternalStore({
    ...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
  });
}
