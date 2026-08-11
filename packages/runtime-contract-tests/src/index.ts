/**
 * @fffattiger/pi-web-runtime-contract-tests
 *
 * Reusable adapter contract suite + reference fake for the pi-web agent
 * runtime ports. Production packages never ship this; adapters (Pi SDK today,
 * Pi RPC later) run the same suite to prove canonical behavior.
 */

export { createRuntimeAdapterSuite } from "./suite.js";
export type {
  AdapterContractHarness,
  AdapterPortBundle,
  HarnessFactoryOptions,
} from "./harness.js";
export { createReferenceHarness } from "./reference.js";
export {
  ReferenceRuntimeFactory,
  ReferenceAgentRuntime,
  ReferenceSessionStore,
  ReferenceSessionCatalog,
  ReferenceSessionLocator,
  ReferenceModelCatalog,
  ReferenceCredentialStore,
  ReferenceResourceCatalog,
  ReferenceProjectTrust,
  KNOWN_TOOLS,
  THINKING_LEVELS,
} from "./reference.js";
